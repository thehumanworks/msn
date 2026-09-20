import type { SendMessageInput } from "./apiClient.ts";
import { backoffDelayMs, type BackoffOptions } from "./backoff.ts";
import { createPendingSend } from "./composer.ts";
import { ApiError, isAbortError } from "./errors.ts";
import type { SessionController } from "./sessionController.ts";
import { Store } from "./store.ts";
import type { CoordinationEvent, Message, Snapshot } from "./types.ts";

export const MAX_MESSAGES = 500;
export const MAX_OUTBOX = 20;
const PAGE = 100;
const JUMP_WINDOW = 2000;
const MAX_PAGES = 40;
const MAX_TEXT_BYTES = 16384;
const MAX_TO_BYTES = 128;

export type OutboxStatus = "queued" | "sending" | "uncertain" | "rejected";

/** An unsent or unconfirmed message. `key` and `input` never change once created. */
export type OutboxItem = {
  id: number;
  key: string;
  input: SendMessageInput;
  status: OutboxStatus;
  error: string | null;
};

export type ChannelState = {
  phase: "loading" | "ready" | "error";
  error: string | null;
  /** Canonical data may be behind; a refresh is pending or failed. */
  stale: boolean;
  messages: Message[];
  olderNotLoaded: boolean;
  snapshot: Snapshot | null;
  snapshotVersion: number;
  historyRevision: number;
  snapshotDue: boolean;
  snapshotDueReasons: string[];
  outbox: OutboxItem[];
};

export type Draft = { text: string; to?: string; replyTo?: number };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Live state for one channel: canonical catchup + forward sync, event-driven refresh, and a
 * durable-in-memory outbox with stable idempotency keys. Every await is followed by a `disposed`
 * check, so a controller for a channel the user left (or a session that ended) can never write
 * state after the fact. Work is serialised through `pump`, and every failure leaves an explicit
 * dirty flag instead of dropping an event.
 */
export class ChannelController {
  readonly state = new Store<ChannelState>({
    phase: "loading",
    error: null,
    stale: false,
    messages: [],
    olderNotLoaded: false,
    snapshot: null,
    snapshotVersion: 0,
    historyRevision: 0,
    snapshotDue: false,
    snapshotDueReasons: [],
    outbox: [],
  });

  readonly channel: string;
  private readonly ctl: SessionController;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly byId = new Map<number, Message>();
  private syncCursor = 0;
  private needReload = true;
  private needSync = false;
  private pendingSnapshot: number | null = null;
  private running = false;
  private outboxRunning = false;
  private disposed = false;
  private outboxSeq = 0;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** After a failure, events must not bypass the backoff; only the timer, refresh() or resume lifts it. */
  private holdOff = false;
  private readonly backoff: BackoffOptions;

  constructor(ctl: SessionController, channel: string, backoff: BackoffOptions = {}) {
    this.backoff = backoff;
    this.ctl = ctl;
    this.channel = channel;
    this.unsubscribe.push(
      ctl.onEvent((event) => this.onEvent(event)),
      ctl.onLifecycle((phase) => {
        if (phase !== "resumed") return;
        this.liftHoldOff();
        for (const item of this.state.get().outbox) {
          if (item.status === "uncertain") this.patchItem(item.id, { status: "queued" });
        }
        void this.pumpOutbox();
        void this.pump();
      }),
    );
  }

  start(): void {
    void this.pump();
  }

  refresh(): void {
    this.liftHoldOff();
    this.needReload = true;
    void this.pump();
  }

  private liftHoldOff(): void {
    this.holdOff = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const off of this.unsubscribe) off();
  }

  // ---- canonical reads ---------------------------------------------------------------------

  private onEvent(event: CoordinationEvent): void {
    if (this.disposed || event.channel !== this.channel) return;
    switch (event.type) {
      case "message.created":
        this.needSync = true;
        break;
      case "message.deleted":
        if (event.resourceId !== null && this.byId.delete(event.resourceId)) this.publishMessages();
        this.needReload = true; // a redaction also invalidates snapshots
        break;
      case "snapshot.published":
        if (event.resourceId !== null) {
          this.pendingSnapshot = Math.max(this.pendingSnapshot ?? 0, event.resourceId);
        }
        break;
      case "channel.created":
        this.needReload = true;
        break;
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed || this.holdOff) return;
    this.running = true;
    try {
      while (!this.disposed) {
        let op: () => Promise<void>;
        let redo: () => void;
        if (this.needReload) {
          this.needReload = this.needSync = false;
          this.pendingSnapshot = null;
          op = () => this.reload();
          redo = () => (this.needReload = true);
        } else if (this.needSync) {
          this.needSync = false;
          op = () => this.syncForward();
          redo = () => (this.needSync = true);
        } else if (this.pendingSnapshot !== null) {
          const version = this.pendingSnapshot;
          this.pendingSnapshot = null;
          op = () => this.fetchSnapshot(version);
          redo = () => (this.pendingSnapshot = Math.max(this.pendingSnapshot ?? 0, version));
        } else {
          break;
        }
        try {
          await op();
          this.retryAttempt = 0;
          if (!this.disposed && !this.needReload && !this.needSync && this.pendingSnapshot === null) {
            this.state.update({ stale: false, error: null });
          }
        } catch (error) {
          redo();
          this.failed(error);
          break;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private failed(error: unknown): void {
    if (this.disposed) return;
    if (isAbortError(error)) {
      // Paused (or disposed): the dirty flag stays set and the resume hook pumps again.
      this.state.update({ stale: true });
      return;
    }
    if (error instanceof ApiError && error.isAuthExpired) return this.ctl.reportAuthFailure();
    const message = error instanceof Error ? error.message : "Could not refresh this channel.";
    const hasData = this.state.get().phase === "ready";
    this.state.update({ phase: hasData ? "ready" : "error", error: message, stale: true });
    this.holdOff = true;
    if (error instanceof ApiError && !error.isRetryable) return; // stays held until refresh()/resume
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.holdOff = false;
      void this.pump();
    }, backoffDelayMs(this.retryAttempt++, this.backoff));
  }

  private async reload(): Promise<void> {
    const signal = this.ctl.signal;
    const api = this.ctl.api;
    const first = await api.catchup(this.channel, { limit: PAGE, maxBytes: 262144 }, signal);
    if (this.disposed) return;
    let batch = first.messages;
    let cursor = first.nextCursor;
    let hasMore = first.hasMore;
    let olderNotLoaded = false;
    if (first.pendingMessages > JUMP_WINDOW && first.headCursor - JUMP_WINDOW > cursor) {
      // Explicitly bounded window: start near the head instead of paging a huge backlog.
      const jump = await api.catchup(
        this.channel,
        { after: first.headCursor - JUMP_WINDOW, limit: PAGE, maxBytes: 262144 },
        signal,
      );
      if (this.disposed) return;
      batch = jump.messages;
      cursor = jump.nextCursor;
      hasMore = jump.hasMore;
      olderNotLoaded = true;
    }
    const all = [...batch];
    for (let page = 0; hasMore && page < MAX_PAGES; page += 1) {
      const next = await api.listMessages(this.channel, cursor, PAGE, 0, signal);
      if (this.disposed) return;
      all.push(...next.messages);
      cursor = next.nextCursor;
      hasMore = next.hasMore;
    }
    if (hasMore) this.needSync = true;
    this.byId.clear();
    for (const message of all) this.byId.set(message.id, message);
    this.syncCursor = cursor;
    this.state.update({
      phase: "ready",
      snapshot: first.snapshot,
      snapshotVersion: first.snapshotVersion,
      historyRevision: first.historyRevision,
      snapshotDue: first.snapshotDue,
      snapshotDueReasons: first.snapshotDueReasons,
      olderNotLoaded,
    });
    this.publishMessages();
  }

  private async syncForward(): Promise<void> {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const next = await this.ctl.api.listMessages(this.channel, this.syncCursor, PAGE, 0, this.ctl.signal);
      if (this.disposed) return;
      for (const message of next.messages) this.byId.set(message.id, message);
      this.syncCursor = next.nextCursor;
      this.publishMessages();
      if (!next.hasMore) return;
    }
    this.needSync = true;
  }

  private async fetchSnapshot(version: number): Promise<void> {
    if (version <= this.state.get().snapshotVersion) return;
    try {
      const result = await this.ctl.api.getSnapshot(this.channel, version, this.ctl.signal);
      if (this.disposed) return;
      if (result.snapshot.version > this.state.get().snapshotVersion) {
        this.state.update({
          snapshot: result.snapshot,
          snapshotVersion: result.snapshot.version,
          historyRevision: result.historyRevision,
        });
      }
    } catch (error) {
      // Invalidated (410) or gone (404): the canonical catchup is the source of truth.
      if (error instanceof ApiError && (error.status === 410 || error.status === 404)) {
        this.needReload = true;
        return;
      }
      throw error;
    }
  }

  private publishMessages(): void {
    let olderNotLoaded = this.state.get().olderNotLoaded;
    if (this.byId.size > MAX_MESSAGES) {
      const ids = [...this.byId.keys()].sort((a, b) => a - b);
      for (const id of ids.slice(0, ids.length - MAX_MESSAGES)) this.byId.delete(id);
      olderNotLoaded = true;
    }
    const messages = [...this.byId.values()].sort((a, b) => a.id - b.id);
    this.state.update({ messages, olderNotLoaded });
  }

  // ---- sending -----------------------------------------------------------------------------

  /** Validates and queues a message. The outbox item's key and body are immutable from here on. */
  send(draft: Draft): { ok: true } | { ok: false; error: string } {
    if (!draft.text.trim()) return { ok: false, error: "Write a message first." };
    if (byteLength(draft.text) > MAX_TEXT_BYTES) return { ok: false, error: "Messages are limited to 16 KiB." };
    const to = draft.to?.trim() || undefined;
    if (to && byteLength(to) > MAX_TO_BYTES) return { ok: false, error: "The recipient name is too long." };
    if (this.state.get().outbox.length >= MAX_OUTBOX) {
      return { ok: false, error: "Too many unsent messages. Retry or discard some first." };
    }
    const input: SendMessageInput = {
      username: this.ctl.session.username,
      text: draft.text,
      ...(to ? { to } : {}),
      ...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
    };
    const pending = createPendingSend(input);
    const item: OutboxItem = { id: ++this.outboxSeq, key: pending.key, input, status: "queued", error: null };
    this.state.update({ outbox: [...this.state.get().outbox, item] });
    void this.pumpOutbox();
    return { ok: true };
  }

  /** Retry an uncertain send with exactly the same key and body. */
  retrySend(id: number): void {
    const item = this.state.get().outbox.find((i) => i.id === id);
    if (!item || item.status !== "uncertain") return;
    this.patchItem(id, { status: "queued", error: null });
    void this.pumpOutbox();
  }

  /** Drop an item. For an uncertain one this gives up the ability to confirm it was delivered. */
  discardSend(id: number): void {
    this.state.update({ outbox: this.state.get().outbox.filter((i) => i.id !== id) });
    void this.pumpOutbox();
  }

  /** A definitively rejected message returns to the composer; it can never have been stored. */
  takeRejected(id: number): Draft | null {
    const item = this.state.get().outbox.find((i) => i.id === id);
    if (!item || item.status !== "rejected") return null;
    this.discardSend(id);
    return { text: item.input.text, to: item.input.to, replyTo: item.input.replyTo };
  }

  private patchItem(id: number, patch: Partial<OutboxItem>): void {
    this.state.update({
      outbox: this.state.get().outbox.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    });
  }

  private async pumpOutbox(): Promise<void> {
    if (this.outboxRunning || this.disposed) return;
    this.outboxRunning = true;
    try {
      while (!this.disposed) {
        const head = this.state.get().outbox.find((i) => i.status !== "rejected");
        // An uncertain head blocks later sends so ordering is preserved until the user decides.
        if (!head || head.status !== "queued") break;
        this.patchItem(head.id, { status: "sending" });
        try {
          const result = await this.ctl.api.sendMessage(this.channel, head.input, head.key, this.ctl.signal);
          if (this.disposed) return;
          this.byId.set(result.message.id, result.message);
          this.publishMessages();
          this.state.update({ outbox: this.state.get().outbox.filter((i) => i.id !== head.id) });
        } catch (error) {
          if (this.disposed) return;
          this.classifySendFailure(head.id, error);
        }
      }
    } finally {
      this.outboxRunning = false;
    }
  }

  private classifySendFailure(id: number, error: unknown): void {
    if (error instanceof ApiError && error.isAuthExpired) {
      this.patchItem(id, { status: "rejected", error: "Your access key was revoked or reset." });
      this.ctl.reportAuthFailure();
      return;
    }
    // A definitive 4xx (other than timeout/rate limit) proves nothing was stored.
    if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
      this.patchItem(id, { status: "rejected", error: error.message });
      return;
    }
    const reason = isAbortError(error)
      ? "Interrupted before the server answered."
      : error instanceof Error
        ? error.message
        : "No answer from the server.";
    this.patchItem(id, { status: "uncertain", error: `${reason} It may or may not have been delivered.` });
  }
}
