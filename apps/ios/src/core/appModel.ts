import { ApiClient, provisionWorkspace, redeemInvite } from "./apiClient.ts";
import { ApiError, InsecureOriginError, isAbortError } from "./errors.ts";
import { validateOrigin, type FetchLike } from "./httpClient.ts";
import type { Session } from "./session.ts";
import { SessionController, type SessionControllerOptions } from "./sessionController.ts";
import { forgetSession, loadSession, saveSession, type SecretStore } from "./sessionStorage.ts";
import { Store } from "./store.ts";

export type AppPhase =
  | { kind: "hydrating" }
  | { kind: "signedOut"; notice: string | null }
  | { kind: "connected"; controller: SessionController; warning: string | null };

export type ConnectInput = {
  origin: string;
  tenant: string;
  username: string;
  remember: boolean;
};

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

/**
 * Owns the signed-in/out lifecycle. Every operation captures `generation` first and re-checks it
 * after every await, so a slow secure-store hydration, a superseded sign-in or a late response for
 * an old account can never replace the session the user is looking at (no cross-account leak).
 *
 * Secure-storage writes are serialised through one queue and always apply the *newest intended*
 * state (`wanted`) when they run, never the state that was current when they were requested. A
 * slow save that started before a sign-out therefore cannot land after the delete, and two rapid
 * account swaps end with exactly the last account (or nothing) stored.
 */
export class AppModel {
  readonly state = new Store<AppPhase>({ kind: "hydrating" });
  private readonly store: SecretStore;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly controllerOptions: SessionControllerOptions;
  private generation = 0;
  private wanted: Session | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: SecretStore, options: { fetchImpl?: FetchLike; controller?: SessionControllerOptions } = {}) {
    this.store = store;
    this.fetchImpl = options.fetchImpl;
    this.controllerOptions = options.controller ?? {};
  }

  async hydrate(): Promise<void> {
    const generation = this.generation;
    let session: Session | null = null;
    let notice: string | null = null;
    try {
      session = await this.enqueue(() => loadSession(this.store));
    } catch {
      notice = "Secure storage could not be read. Sign in again.";
    }
    if (generation !== this.generation) return;
    if (session) {
      this.wanted = session;
      this.adopt(session);
    } else {
      this.state.set({ kind: "signedOut", notice });
    }
  }

  /** Connect with an existing access key. Returns an error message, or null on success. */
  async signInWithKey(input: ConnectInput & { token: string }): Promise<string | null> {
    const token = input.token.trim();
    if (!TOKEN.test(token)) return "Access keys are 32–256 letters, digits, hyphens or underscores.";
    return this.attempt(input, async (origin, tenant) => {
      const identity = await new ApiClient(origin, tenant, token, this.fetchImpl).getIdentity();
      return { identity, token };
    });
  }

  async createWorkspace(input: ConnectInput & { channel?: string }): Promise<string | null> {
    return this.attempt(input, async (origin, tenant, username) => {
      const channel = input.channel?.trim() || undefined;
      const identity = await provisionWorkspace(origin, tenant, username, channel, this.fetchImpl);
      return { identity, token: identity.token };
    });
  }

  async redeemInvitation(input: ConnectInput & { code: string }): Promise<string | null> {
    return this.attempt(input, async (origin, tenant, username) => {
      const identity = await redeemInvite(origin, tenant, input.code.trim(), username, this.fetchImpl);
      return { identity, token: identity.token };
    });
  }

  /** Stop everything and remove the remembered key. */
  async signOut(notice: string | null = null): Promise<void> {
    const generation = ++this.generation;
    this.disposeCurrent();
    this.wanted = null;
    this.state.set({ kind: "signedOut", notice });
    const result = await this.sync();
    if (generation === this.generation && !result.ok) {
      this.state.set({
        kind: "signedOut",
        notice: "Signed out, but the saved key could not be removed from secure storage.",
      });
    }
  }

  /** Resolves when every queued secure-storage mutation has finished (for tests and shutdown). */
  async settled(): Promise<void> {
    await this.queue;
  }

  private async attempt(
    input: ConnectInput,
    obtain: (
      origin: string,
      tenant: string,
      username: string,
    ) => Promise<{ identity: Awaited<ReturnType<ApiClient["getIdentity"]>>; token: string }>,
  ): Promise<string | null> {
    const generation = ++this.generation;
    try {
      const origin = validateOrigin(input.origin.trim()).origin;
      const tenant = input.tenant.trim();
      if (!SLUG.test(tenant)) return "Workspace names use 1–64 lowercase letters, digits, hyphens or underscores.";
      const username = input.username.trim();
      const { identity, token } = await obtain(origin, tenant, username);
      if (generation !== this.generation) return null;
      const name = identity.username ?? username;
      if (!name) return "Enter the name you want to appear as.";
      if (identity.username === null && identity.usernamePrefix && !name.startsWith(identity.usernamePrefix)) {
        return `This key only allows names starting with "${identity.usernamePrefix}".`;
      }
      const session: Session = {
        origin,
        tenant,
        token,
        username: name,
        usernamePrefix: identity.usernamePrefix,
        ...(identity.channel ? { channel: identity.channel } : {}),
      };
      this.disposeCurrent();
      this.wanted = input.remember ? session : null;
      this.adopt(session);
      void this.sync().then((result) => this.reportSync(result, generation, input.remember));
      return null;
    } catch (error) {
      if (generation !== this.generation) return null;
      return describe(error);
    }
  }

  private adopt(session: Session): void {
    const controller: SessionController = new SessionController(session, {
      ...this.controllerOptions,
      fetchImpl: this.fetchImpl,
      onAuthExpired: () => this.expire(controller),
    });
    this.state.set({ kind: "connected", controller, warning: null });
    void controller.start();
  }

  private reportSync(result: { ok: boolean }, generation: number, remember: boolean): void {
    const current = this.state.get();
    if (result.ok || generation !== this.generation || current.kind !== "connected") return;
    this.state.set({
      ...current,
      warning: remember
        ? "Could not save the key to secure storage; you will need to sign in again next time."
        : "Could not clear an older saved key from secure storage.",
    });
  }

  /** The server rejected this controller's key. Only acts if it is still the visible session. */
  private expire(controller: SessionController): void {
    const current = this.state.get();
    if (current.kind !== "connected" || current.controller !== controller) return;
    controller.dispose();
    this.wanted = null;
    this.state.set({ kind: "signedOut", notice: "Your access key was revoked or reset. Sign in again." });
    void this.sync().then((result) => {
      const now = this.state.get();
      if (!result.ok && now.kind === "signedOut") {
        this.state.set({
          kind: "signedOut",
          notice: "Your access key was revoked, but the saved copy could not be removed from secure storage.",
        });
      }
    });
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private sync(): Promise<{ ok: boolean }> {
    return this.enqueue(async () => {
      const want = this.wanted;
      try {
        if (want) {
          await saveSession(this.store, want);
          return { ok: true };
        }
        return { ok: await forgetSession(this.store) };
      } catch {
        return { ok: false };
      }
    });
  }

  private disposeCurrent(): void {
    const current = this.state.get();
    if (current.kind === "connected") current.controller.dispose();
  }
}

function describe(error: unknown): string {
  if (error instanceof InsecureOriginError) return error.message;
  if (error instanceof ApiError) {
    if (error.status === 401) return "That workspace or access key was not accepted.";
    return error.message;
  }
  if (isAbortError(error)) return "Cancelled.";
  return error instanceof Error ? error.message : "Could not connect.";
}
