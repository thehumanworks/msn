import { ApiClient, provisionWorkspace, redeemInvite } from "./apiClient.ts";
import { ApiError, InsecureOriginError, isAbortError } from "./errors.ts";
import { validateOrigin, type FetchLike } from "./httpClient.ts";
import type { Session } from "./session.ts";
import { SessionController, type SessionControllerOptions } from "./sessionController.ts";
import {
  listProfiles,
  migrateLegacySession,
  planProfileName,
  readActive,
  readProfile,
  removeProfile,
  writeActive,
  writeProfile,
  type ProfileSummary,
} from "./profileStorage.ts";
import { ReadMarks, readMarksKey } from "./readMarks.ts";
import type { SecretStore } from "./sessionStorage.ts";
import { Store } from "./store.ts";

export type AppPhase =
  | { kind: "hydrating" }
  | { kind: "signedOut"; notice: string | null; profiles: ProfileSummary[] }
  | { kind: "connected"; controller: SessionController; warning: string | null };

export type ConnectInput = {
  origin: string;
  tenant: string;
  username: string;
  /** Save this connection as a profile on this device (ADR 0021). */
  remember: boolean;
};

/** A profile belongs to one user in one workspace on one server (and one channel, if scoped). */
function identityKey(of: { origin: string; tenant: string; username: string; channel?: string }): string {
  return JSON.stringify([of.origin, of.tenant, of.username, of.channel ?? null]);
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

/**
 * Owns the signed-in/out lifecycle. Every operation captures `generation` first and re-checks it
 * after every await, so a slow secure-store hydration, a superseded sign-in or a late response for
 * an old account can never replace the session the user is looking at (no cross-account leak).
 *
 * Secure-storage writes are serialised through one queue and always apply the *newest intent*
 * when they run, never the state that was current when they were requested. Intents are kept per
 * identity (`intents`: a session to save, or null to forget) plus one for the profile to reopen on
 * launch (`wantedActive`). A slow save that started before "sign out and forget" therefore cannot
 * land after the delete, and rapid account swaps end with the last account active. Profile names
 * are chosen inside the queue against what is actually stored, so a save can never overwrite a
 * different user's profile. After every write the saved-profile list is re-read and published.
 */
export class AppModel {
  readonly state = new Store<AppPhase>({ kind: "hydrating" });
  private readonly store: SecretStore;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly controllerOptions: SessionControllerOptions;
  private generation = 0;
  private readonly intents = new Map<string, Session | null>();
  private wantedActive: string | null = null;
  private profiles: ProfileSummary[] = [];
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
      session = await this.enqueue(async () => {
        await migrateLegacySession(this.store);
        const active = await readActive(this.store);
        const restored = active ? await readProfile(this.store, active) : null;
        this.profiles = await listProfiles(this.store);
        return restored;
      });
    } catch {
      notice = "Secure storage could not be read. Sign in again.";
    }
    if (generation !== this.generation) return;
    if (session) {
      this.wantedActive = identityKey(session);
      this.adopt(session);
    } else {
      this.state.set({ kind: "signedOut", notice, profiles: this.profiles });
    }
  }

  /** Reconnect with a saved profile. Returns an error message, or null on success. */
  async connectProfile(name: string): Promise<string | null> {
    const generation = ++this.generation;
    let session: Session | null;
    try {
      session = await this.enqueue(() => readProfile(this.store, name));
    } catch {
      return generation === this.generation ? "Secure storage could not be read." : null;
    }
    if (generation !== this.generation) return null;
    if (!session) {
      void this.sync(); // republish the list without the profile that healed itself away
      return "That saved profile is no longer available.";
    }
    this.disposeCurrent();
    this.wantedActive = identityKey(session);
    this.adopt(session);
    void this.sync().then((result) => this.reportSync(result, generation, true));
    return null;
  }

  /** Delete a saved profile from this device. Returns an error message, or null on success. */
  async forgetProfile(name: string): Promise<string | null> {
    const profile = this.profiles.find((candidate) => candidate.name === name);
    if (!profile) return null;
    const key = identityKey(profile);
    this.intents.set(key, null);
    if (this.wantedActive === key) this.wantedActive = null;
    const result = await this.sync();
    return result.ok ? null : "The saved key could not be removed from secure storage.";
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

  /**
   * Stop everything. The saved profile is kept so the user can switch back to it; `forget` also
   * deletes it from this device.
   */
  async signOut(notice: string | null = null, options: { forget?: boolean } = {}): Promise<void> {
    const generation = ++this.generation;
    const current = this.state.get();
    if (options.forget && current.kind === "connected") {
      this.intents.set(identityKey(current.controller.session), null);
    }
    this.disposeCurrent();
    this.wantedActive = null;
    this.state.set({ kind: "signedOut", notice, profiles: this.profiles });
    const result = await this.sync();
    if (generation === this.generation && !result.ok) {
      this.state.set({
        kind: "signedOut",
        notice: options.forget
          ? "Signed out, but the saved key could not be removed from secure storage."
          : "Signed out, but secure storage could not be updated; this device may reopen the session.",
        profiles: this.profiles,
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
      // Unticking Remember for a user who is already saved removes that profile; other users'
      // profiles are never touched.
      this.intents.set(identityKey(session), input.remember ? session : null);
      this.wantedActive = input.remember ? identityKey(session) : null;
      this.adopt(session, input.remember);
      void this.sync().then((result) => this.reportSync(result, generation, input.remember));
      return null;
    } catch (error) {
      if (generation !== this.generation) return null;
      return describe(error);
    }
  }

  /** `remember`: the session is saved on this device, so its read marks may be too. */
  private adopt(session: Session, remember = true): void {
    const controller: SessionController = new SessionController(session, {
      ...this.controllerOptions,
      readMarks: new ReadMarks(this.store, session, remember ? undefined : { persist: false }),
      fetchImpl: this.fetchImpl,
      onAuthExpired: () => this.expire(controller),
    });
    this.state.set({ kind: "connected", controller, warning: null });
    void controller.start();
  }

  private reportSync(result: { ok: boolean; full: boolean }, generation: number, remember: boolean): void {
    const current = this.state.get();
    if (result.ok || generation !== this.generation || current.kind !== "connected") return;
    this.state.set({
      ...current,
      warning: result.full
        ? "This device already holds the maximum number of saved profiles; forget one to save this connection."
        : remember
          ? "Could not save the key to secure storage; you will need to sign in again next time."
          : "Could not clear an older saved key from secure storage.",
    });
  }

  /** The server rejected this controller's key. Only acts if it is still the visible session. */
  private expire(controller: SessionController): void {
    const current = this.state.get();
    if (current.kind !== "connected" || current.controller !== controller) return;
    controller.dispose();
    // A revoked key is useless: its profile is deleted, never left behind as a dead entry.
    const key = identityKey(controller.session);
    this.intents.set(key, null);
    if (this.wantedActive === key) this.wantedActive = null;
    this.profiles = this.profiles.filter((profile) => identityKey(profile) !== key);
    this.state.set({
      kind: "signedOut",
      notice: "Your access key was revoked or reset. Sign in again.",
      profiles: this.profiles,
    });
    void this.sync().then((result) => {
      const now = this.state.get();
      if (!result.ok && now.kind === "signedOut") {
        this.state.set({
          kind: "signedOut",
          notice: "Your access key was revoked, but the saved copy could not be removed from secure storage.",
          profiles: this.profiles,
        });
      }
    });
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Applies every pending intent, then the active pointer, then republishes the profile list. */
  private sync(): Promise<{ ok: boolean; full: boolean }> {
    return this.enqueue(async () => {
      let ok = true;
      let full = false;
      for (const [key, intent] of [...this.intents]) {
        if (this.intents.get(key) !== intent) continue; // superseded while this op was waiting
        this.intents.delete(key);
        try {
          const stored = await listProfiles(this.store);
          if (intent === null) {
            const existing = stored.find((profile) => identityKey(profile) === key);
            if (existing) {
              await removeProfile(this.store, existing.name);
              // Board names read on this device go with the profile (ADR 0045).
              await this.store.remove(readMarksKey(existing)).catch(() => undefined);
            }
          } else {
            const name = planProfileName(stored, intent);
            if (name === null) {
              full = true;
              ok = false;
            } else {
              await writeProfile(this.store, name, intent);
            }
          }
        } catch {
          ok = false;
        }
      }
      try {
        const stored = await listProfiles(this.store);
        const want = this.wantedActive;
        const active = want ? stored.find((profile) => identityKey(profile) === want) : undefined;
        await writeActive(this.store, active?.name ?? null);
        this.publish(stored);
      } catch {
        ok = false;
      }
      return { ok, full };
    });
  }

  private publish(profiles: ProfileSummary[]): void {
    this.profiles = profiles;
    const current = this.state.get();
    if (current.kind === "signedOut") this.state.set({ ...current, profiles });
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
