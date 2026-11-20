import { ApiClient } from "./apiClient.ts";
import { backoffDelayMs, type BackoffOptions } from "./backoff.ts";
import { ApiError, InsecureOriginError, ProtocolError, isAbortError } from "./errors.ts";
import { bootstrapEventCursor, EventStreamManager, type EventStreamOptions } from "./eventStream.ts";
import type { FetchLike } from "./httpClient.ts";
import type { Session } from "./session.ts";
import type { ReadMarks } from "./readMarks.ts";
import { Store } from "./store.ts";
import type { CoordinationEvent } from "./types.ts";

export type ConnectionState = {
  kind: "connecting" | "live" | "reconnecting" | "paused" | "expired" | "failed";
  /** True once the event cursor has been established; canonical reads are only valid after it. */
  ready: boolean;
  message: string | null;
  /** False for failures a retry cannot fix (invalid feed, insecure origin). */
  retryable: boolean;
};

export type EventListener = (event: CoordinationEvent) => void | Promise<void>;
export type LifecycleListener = (phase: "paused" | "resumed") => void;

export type SessionControllerOptions = {
  fetchImpl?: FetchLike;
  stream?: Pick<EventStreamOptions, "setTimeout" | "clearTimeout" | "waitSeconds" | "limit" | "backoff">;
  connectBackoff?: BackoffOptions;
  /** Called once when the server rejects the key (401). The controller has stopped itself. */
  onAuthExpired?: () => void;
  /** This identity's read marks (ADR 0045); without them the list shows no unread counts. */
  readMarks?: ReadMarks;
};

/**
 * One connected session: an ApiClient, exactly one event subscription and the lifecycle around
 * them. Order of operations on connect is deliberate: the event cursor is drained to the journal
 * tip FIRST, and only then may screens perform canonical reads. Every event after that cursor is
 * replayed and dispatched, so anything a canonical read did not yet reflect arrives as an event
 * (and anything it did reflect is an idempotent refresh) — no gap between the two.
 *
 * `pause()` (app inactive/background) aborts every request bound to `signal` and stops polling;
 * `resume()` continues from the stored cursor, so events that happened meanwhile are replayed and
 * dispatched, never dropped.
 */
export class SessionController {
  readonly api: ApiClient;
  readonly session: Session;
  /** Where this reader stopped on each board, on this device only (ADR 0045). */
  readonly marks: ReadMarks | null;
  /** Set once the key is verified: the workspace owner's key may mute boards (ADR 0044). */
  owner = false;
  readonly state = new Store<ConnectionState>({
    kind: "connecting",
    ready: false,
    message: null,
    retryable: true,
  });

  private readonly options: SessionControllerOptions;
  private readonly stream: EventStreamManager;
  private readonly eventListeners = new Set<EventListener>();
  private readonly lifecycleListeners = new Set<LifecycleListener>();
  private epoch = new AbortController();
  private generation = 0;
  private disposed = false;
  private terminal = false;
  private sleepWake: (() => void) | null = null;

  constructor(session: Session, options: SessionControllerOptions = {}) {
    this.session = session;
    this.options = options;
    this.marks = options.readMarks ?? null;
    this.api = new ApiClient(session.origin, session.tenant, session.token, options.fetchImpl, session.channel);
    this.stream = new EventStreamManager(
      (after, limit, wait, channel, signal) => this.api.getEvents({ after, limit, wait, channel }, signal),
      {
        onEvents: (events) => this.dispatch(events),
        onAuthError: () => this.expire(),
        onFatalError: (error) => this.fail(error),
        onTransientError: (error) =>
          this.state.update({
            kind: "reconnecting",
            message: error instanceof Error ? error.message : "Connection lost.",
          }),
        onRecovered: () => this.state.update({ kind: "live", message: null }),
      },
      { ...options.stream, waitSeconds: options.stream?.waitSeconds ?? 25, limit: options.stream?.limit ?? 100 },
    );
  }

  /** Aborted while paused or disposed; every canonical read must be bound to it. */
  get signal(): AbortSignal {
    return this.epoch.signal;
  }

  get isTerminal(): boolean {
    return this.terminal || this.disposed;
  }

  get cursor(): number {
    return this.stream.currentCursor;
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onLifecycle(listener: LifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  /** Verify the key, establish the event cursor, then start the subscription. */
  async start(): Promise<void> {
    if (this.isTerminal) return;
    const generation = ++this.generation;
    const signal = this.epoch.signal;
    this.state.update({ kind: "connecting", ready: false, message: null, retryable: true });
    for (let attempt = 0; ; attempt += 1) {
      try {
        const identity = await this.api.getIdentity(signal);
        if (generation !== this.generation) return;
        if ((identity.channel ?? undefined) !== this.session.channel) {
          throw new ProtocolError("This key's channel access changed. Reconnect to continue.");
        }
        this.owner = identity.owner === true;
        const cursor = await bootstrapEventCursor(
          (after, limit, wait, channel, s) => this.api.getEvents({ after, limit, wait, channel }, s),
          { signal },
        );
        if (generation !== this.generation) return;
        this.state.update({ kind: "live", ready: true, message: null });
        this.stream.start(cursor);
        return;
      } catch (error) {
        if (generation !== this.generation || this.isTerminal) return;
        if (isAbortError(error) || signal.aborted) return; // paused: resume() restarts start()
        if (error instanceof ApiError && error.isAuthExpired) return this.expire();
        if (error instanceof ProtocolError || error instanceof InsecureOriginError) return this.fail(error);
        if (error instanceof ApiError && !error.isRetryable) return this.fail(error);
        this.state.update({
          kind: "reconnecting",
          message: error instanceof Error ? error.message : "Connection failed.",
        });
        await this.sleep(backoffDelayMs(attempt, this.options.connectBackoff));
        if (generation !== this.generation || this.isTerminal) return;
      }
    }
  }

  /** App went inactive/background: cancel everything in flight and stop polling. */
  pause(): void {
    if (this.isTerminal || this.state.get().kind === "paused") return;
    this.generation += 1;
    this.stream.stop();
    this.epoch.abort();
    this.wakeSleep();
    this.state.update({ kind: "paused", message: null });
    void this.marks?.flush();
    for (const listener of [...this.lifecycleListeners]) listener("paused");
  }

  /** App is active again: replay from the stored cursor (or finish connecting if never ready). */
  resume(): void {
    if (this.isTerminal || this.state.get().kind !== "paused") return;
    this.epoch = new AbortController();
    if (this.state.get().ready) {
      this.state.update({ kind: "live", message: null });
      this.stream.start(this.stream.currentCursor);
    } else {
      void this.start();
    }
    for (const listener of [...this.lifecycleListeners]) listener("resumed");
  }

  /** Manual retry after a failure. */
  retry(): void {
    if (this.disposed || this.state.get().kind !== "failed" || !this.state.get().retryable) return;
    this.terminal = false;
    if (this.state.get().ready) {
      this.state.update({ kind: "live", message: null });
      this.stream.start(this.stream.currentCursor);
    } else {
      void this.start();
    }
  }

  /** A canonical request received 401: the key was revoked or reset. */
  reportAuthFailure(): void {
    this.expire();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.marks?.dispose();
    this.generation += 1;
    this.stream.stop();
    this.epoch.abort();
    this.wakeSleep();
    this.eventListeners.clear();
    this.lifecycleListeners.clear();
  }

  private async dispatch(events: CoordinationEvent[]): Promise<void> {
    for (const event of events) {
      for (const listener of [...this.eventListeners]) {
        try {
          await listener(event);
        } catch {
          // A listener owns its own retry state; it must never wedge the shared subscription.
        }
      }
    }
  }

  private expire(): void {
    if (this.terminal || this.disposed) return;
    this.terminal = true;
    this.generation += 1;
    this.stream.stop();
    this.epoch.abort();
    this.wakeSleep();
    this.state.update({ kind: "expired", message: "Your access key was revoked or reset." });
    this.options.onAuthExpired?.();
  }

  private fail(error: Error): void {
    if (this.disposed) return;
    this.generation += 1;
    this.stream.stop();
    this.wakeSleep();
    const retryable = !(error instanceof InsecureOriginError);
    if (!retryable) this.terminal = true;
    this.state.update({ kind: "failed", message: error.message, retryable });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.sleepWake = null;
        resolve();
      }, ms);
      this.sleepWake = () => {
        clearTimeout(timer);
        this.sleepWake = null;
        resolve();
      };
    });
  }

  private wakeSleep(): void {
    this.sleepWake?.();
  }
}
