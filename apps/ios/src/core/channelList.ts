import { backoffDelayMs, type BackoffOptions } from "./backoff.ts";
import { ApiError, isAbortError } from "./errors.ts";
import type { SessionController } from "./sessionController.ts";
import { type MarkList, marksForListed, type Unread } from "./readMarks.ts";
import { Store } from "./store.ts";
import type { ChannelSummary } from "./types.ts";

export type ChannelListState = {
  phase: "loading" | "ready" | "error";
  channels: ChannelSummary[];
  error: string | null;
  /** Unread counts above this device's read marks (ADR 0045), each for the mark it was asked about. */
  unread: ReadonlyMap<string, Unread>;
};

const MAX_PAGES = 10;
const NO_MARKS = new Store<MarkList>([]);
/** At most one unread-count request per this interval while the list stays open (ADR 0045). */
export const UNREAD_EVERY_MS = 30_000;
const PAGE_SIZE = 100;

/**
 * The channel list. Reloads are event-driven (any coordination event marks it stale) and
 * coalesced: a burst of events causes one reload after `debounceMs`, never a fixed-interval poll.
 */
export class ChannelListController {
  readonly state = new Store<ChannelListState>({
    phase: "loading",
    channels: [],
    error: null,
    unread: new Map(),
  });
  private readonly ctl: SessionController;
  private readonly debounceMs: number;
  private readonly unsubscribe: Array<() => void> = [];
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stale = false;
  private disposed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private readonly backoff: BackoffOptions;
  private readonly unreadEveryMs: number;
  private unreadAt = 0;
  private unreadTimer: ReturnType<typeof setTimeout> | null = null;
  private unreadChannels: ChannelSummary[] = [];

  /** This identity's read marks, or an empty store when the session keeps none. */
  get marks(): Store<MarkList> {
    return this.ctl.marks?.state ?? NO_MARKS;
  }

  constructor(
    ctl: SessionController,
    debounceMs = 750,
    backoff: BackoffOptions = {},
    unreadEveryMs = UNREAD_EVERY_MS,
  ) {
    this.ctl = ctl;
    this.unreadEveryMs = unreadEveryMs;
    this.backoff = backoff;
    this.debounceMs = debounceMs;
    this.unsubscribe.push(
      ctl.onEvent(() => this.scheduleReload()),
      ctl.onLifecycle((phase) => {
        if (phase === "resumed" && this.stale) void this.load();
      }),
    );
  }

  async load(): Promise<void> {
    if (this.disposed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const generation = ++this.generation;
    this.stale = false;
    const hasData = this.state.get().channels.length > 0;
    this.state.update({ phase: hasData ? "ready" : "loading", error: null });
    try {
      const channels: ChannelSummary[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        // Archived boards come too (ADR 0046); the screen hides them unless Show archived is on.
        const result = await this.ctl.api.listChannels(after, PAGE_SIZE, this.ctl.signal, true);
        if (generation !== this.generation) return;
        channels.push(...result.channels);
        if (!result.hasMore) break;
        after = result.nextCursor;
      }
      this.retryAttempt = 0;
      this.state.update({ phase: "ready", channels, error: null });
      this.requestUnread(channels);
    } catch (error) {
      if (generation !== this.generation) return;
      if (isAbortError(error)) {
        this.stale = true;
        return;
      }
      if (error instanceof ApiError && error.isAuthExpired) return this.ctl.reportAuthFailure();
      this.stale = true;
      this.state.update({
        phase: this.state.get().channels.length ? "ready" : "error",
        error: error instanceof Error ? error.message : "Could not load channels.",
      });
      if (error instanceof ApiError && !error.isRetryable) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.load();
      }, backoffDelayMs(this.retryAttempt++, this.backoff));
    }
  }

  /**
   * Counts follow list reloads, which are event-driven, but at most once per `unreadEveryMs`: a
   * reload inside that window schedules one trailing request, so the last change is not lost.
   * The list is rebuilt each time the person comes back to it, so the first load always asks.
   */
  private requestUnread(channels: ChannelSummary[]): void {
    this.unreadChannels = channels;
    if (!this.ctl.marks || this.unreadTimer) return;
    const wait = this.unreadAt + this.unreadEveryMs - Date.now();
    if (wait <= 0) return void this.loadUnread(this.generation, channels);
    this.unreadTimer = setTimeout(() => {
      this.unreadTimer = null;
      void this.loadUnread(this.generation, this.unreadChannels);
    }, wait);
  }

  /** A failure keeps the last counts: they are a hint. */
  private async loadUnread(generation: number, channels: ChannelSummary[]): Promise<void> {
    const marks = this.ctl.marks;
    if (!marks || this.disposed) return;
    this.unreadAt = Date.now();
    await marks.ready;
    if (generation !== this.generation || this.disposed) return;
    const asked = marksForListed(
      marks.state.get(),
      channels.map((channel) => channel.name),
    );
    if (!asked.length) return this.state.update({ unread: new Map() });
    try {
      const unread = await this.ctl.api.unreadCounts(this.ctl.session.username, asked, this.ctl.signal);
      if (generation !== this.generation || this.disposed) return;
      this.state.update({ unread });
    } catch (error) {
      if (error instanceof ApiError && error.isAuthExpired) this.ctl.reportAuthFailure();
    }
  }

  async create(name: string): Promise<string | null> {
    try {
      await this.ctl.api.createChannel(name, this.ctl.signal);
      await this.load();
      return null;
    } catch (error) {
      if (error instanceof ApiError && error.isAuthExpired) {
        this.ctl.reportAuthFailure();
        return "Your access key was revoked or reset.";
      }
      if (isAbortError(error)) return "Cancelled because the app became inactive. Try again.";
      return error instanceof Error ? error.message : "Could not create the channel.";
    }
  }

  /** Archive or unarchive a board; returns an error to show, or null when it worked. */
  async setArchived(name: string, archived: boolean): Promise<string | null> {
    try {
      await this.ctl.api.setArchived(name, archived, this.ctl.signal);
      this.state.update({
        channels: this.state
          .get()
          .channels.map((c) =>
            c.name === name ? { ...c, archivedAt: archived ? (c.archivedAt ?? new Date().toISOString()) : null } : c,
          ),
      });
      void this.load();
      return null;
    } catch (error) {
      if (error instanceof ApiError && error.isAuthExpired) {
        this.ctl.reportAuthFailure();
        return "Your access key was revoked or reset.";
      }
      if (error instanceof ApiError && error.status === 403)
        return "Only the board owner can archive or unarchive a board.";
      if (isAbortError(error)) return "Cancelled because the app became inactive. Try again.";
      return error instanceof Error ? error.message : "Could not change the board.";
    }
  }

  isArchived(name: string): boolean {
    return this.state.get().channels.some((c) => c.name === name && c.archivedAt !== null);
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    if (this.unreadTimer) clearTimeout(this.unreadTimer);
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const off of this.unsubscribe) off();
  }

  private scheduleReload(): void {
    this.stale = true;
    if (this.disposed || this.timer || this.retryTimer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.load();
    }, this.debounceMs);
  }
}
