import { backoffDelayMs, type BackoffOptions } from "./backoff.ts";
import { ApiError, CapacityError, InsecureOriginError, ProtocolError, isAbortError } from "./errors.ts";
import type { CoordinationEvent, EventPage } from "./types.ts";

export type FetchEventsPage = (
  after: number,
  limit: number,
  waitSeconds: number,
  channel: string | undefined,
  signal: AbortSignal,
) => Promise<EventPage>;

/**
 * Drains GET /events from `fromCursor` (default 0, i.e. the start of the post-migration journal)
 * up to the current tip, with `wait=0` so it never blocks. This is the "initial canonical reads +
 * event replay without gaps" bootstrap: canonical resource state comes from catchup/messages/etc,
 * and this only establishes *where to resume the live subscription* so no event in between is
 * missed. Bounded by `maxPages` — an unusually large backlog fails loudly (CapacityError) instead
 * of silently giving up partway or scanning forever, mirroring the server's own no-silent-pruning
 * contract and the bounded `msn task list` scan in ADR 0010.
 */
export async function bootstrapEventCursor(
  fetchPage: FetchEventsPage,
  options: {
    fromCursor?: number;
    limit?: number;
    channel?: string;
    maxPages?: number;
    signal?: AbortSignal;
  } = {},
): Promise<number> {
  let cursor = options.fromCursor ?? 0;
  const maxPages = options.maxPages ?? 1000;
  const signal = options.signal ?? new AbortController().signal;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(cursor, options.limit ?? 100, 0, options.channel, signal);
    cursor = result.nextCursor;
    if (!result.hasMore) return cursor;
  }
  throw new CapacityError(
    `The event journal did not reach its tip within ${maxPages} pages; resync from a canonical read instead of guessing a cursor.`,
  );
}

export type EventStreamCallbacks = {
  /** Cursor advances only after this resolves, so a crash mid-processing replays the same page. */
  onEvents: (events: CoordinationEvent[]) => void | Promise<void>;
  /** The stream has already stopped itself by the time this fires; auth expiry is terminal. */
  onAuthError: (error: ApiError) => void;
  /** Non-retryable failure (invalid feed, insecure origin). The stream has already stopped. */
  onFatalError?: (error: Error) => void;
  /** The first successful response after one or more transient failures. */
  onRecovered?: () => void;
  onTransientError?: (error: unknown, attempt: number, delayMs: number) => void;
};

export type EventStreamOptions = {
  limit?: number;
  waitSeconds?: number;
  channel?: string;
  backoff?: BackoffOptions;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

/**
 * The single, cancellable, long-polling subscription to GET /events. `start()`/`stop()` each bump
 * an internal generation counter; any fetch or timer left over from a previous generation is
 * ignored when it settles, which is what protects against stale responses after a session swap,
 * a channel scope change, or background/foreground cycling.
 */
export class EventStreamManager {
  private generation = 0;
  private cursor = 0;
  private stopped = true;
  private controller: AbortController | null = null;
  private timer: unknown = null;
  private wakeSleep: (() => void) | null = null;
  private attempt = 0;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutImpl: (handle: unknown) => void;
  private readonly fetchPage: FetchEventsPage;
  private readonly callbacks: EventStreamCallbacks;
  private readonly options: EventStreamOptions;

  constructor(
    fetchPage: FetchEventsPage,
    callbacks: EventStreamCallbacks,
    options: EventStreamOptions = {},
  ) {
    this.fetchPage = fetchPage;
    this.callbacks = callbacks;
    this.options = options;
    this.setTimeoutImpl = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutImpl =
      options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get currentCursor(): number {
    return this.cursor;
  }

  get isRunning(): boolean {
    return !this.stopped;
  }

  /** (Re)starts the long poll from `fromCursor`. Safe to call while already running. */
  start(fromCursor: number): void {
    this.stop();
    this.cursor = fromCursor;
    this.stopped = false;
    this.attempt = 0;
    this.generation += 1;
    void this.loop(this.generation);
  }

  /** Cancels any in-flight request and pending retry timer. Idempotent; safe if never started. */
  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    if (this.timer !== null) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
    // Resolve (not just clear) a pending backoff sleep so its loop unwinds instead of leaking.
    const wake = this.wakeSleep;
    this.wakeSleep = null;
    wake?.();
  }

  private async loop(generation: number): Promise<void> {
    while (!this.stopped && generation === this.generation) {
      const controller = new AbortController();
      this.controller = controller;
      const startedAt = Date.now();
      try {
        const page = await this.fetchPage(
          this.cursor,
          this.options.limit ?? 100,
          this.options.waitSeconds ?? 25,
          this.options.channel,
          controller.signal,
        );
        if (generation !== this.generation) return;
        if (this.attempt > 0) this.callbacks.onRecovered?.();
        this.attempt = 0;
        if (page.events.length) {
          await this.callbacks.onEvents(page.events);
          if (generation !== this.generation) return;
        }
        this.cursor = page.nextCursor;
        if (page.hasMore) continue;
        // A long poll that returns empty almost immediately is not holding the connection; never
        // let a misbehaving server turn this loop into tight polling.
        const waitMs = (this.options.waitSeconds ?? 25) * 1000;
        if (!page.events.length && waitMs > 0 && Date.now() - startedAt < Math.min(500, waitMs)) {
          await this.sleep(1000);
          if (generation !== this.generation) return;
        }
      } catch (error) {
        if (generation !== this.generation) return;
        if (isAbortError(error)) return;
        if (error instanceof ApiError && error.isAuthExpired) {
          this.stopped = true;
          this.callbacks.onAuthError(error);
          return;
        }
        if (error instanceof ProtocolError || error instanceof InsecureOriginError) {
          this.stopped = true;
          this.callbacks.onFatalError?.(error);
          return;
        }
        const delay = backoffDelayMs(this.attempt, this.options.backoff);
        this.attempt += 1;
        this.callbacks.onTransientError?.(error, this.attempt, delay);
        await this.sleep(delay);
        if (generation !== this.generation) return;
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wakeSleep = resolve;
      this.timer = this.setTimeoutImpl(() => {
        this.timer = null;
        this.wakeSleep = null;
        resolve();
      }, ms);
    });
  }
}
