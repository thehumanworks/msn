import { BRIEF_CONFLICT, BRIEF_MAX_BYTES, type Brief, briefCount, briefNoticeVersion } from "./brief.ts";
import { isAddressed, outgoingAddress, sameName } from "./address.ts";
import type { SendMessageInput } from "./apiClient.ts";
import { backoffDelayMs, type BackoffOptions } from "./backoff.ts";
import { createPendingSend, generateIdempotencyKey } from "./composer.ts";
import { answeredBy } from "./questions.ts";
import { withClaim } from "./claims.ts";
import type { ScheduledMessage } from "./scheduled.ts";
import { ApiError, isAbortError } from "./errors.ts";
import { channelMentionNotice } from "./mention.ts";
import type { SessionController } from "./sessionController.ts";
import { Store } from "./store.ts";
import type {
  AgentStatus,
  CoordinationEvent,
  Message,
  PinnedMessage,
  ReactionKind,
  Reactions,
  Snapshot,
} from "./types.ts";

export const MAX_MESSAGES = 500;
export const MAX_OUTBOX = 20;
const PAGE = 100;
const JUMP_WINDOW = 2000;
const MAX_PAGES = 40;
const MAX_TEXT_BYTES = 16384;
/** Pins send no message or event, so a sync re-reads them at most this often (ADR 0038). */
export const PIN_REFRESH_MS = 30_000;

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
  /** The board owner's pinned messages, shown above the conversation. */
  pinned: PinnedMessage[];
  /** What each name says it is doing (ADR 0064), newest first. */
  statuses: AgentStatus[];
  /** The board's brief (ADR 0074), null when it has none; a write builds on `briefVersion`. */
  brief: Brief | null;
  briefVersion: number;
  olderNotLoaded: boolean;
  snapshot: Snapshot | null;
  snapshotVersion: number;
  historyRevision: number;
  snapshotDue: boolean;
  snapshotDueReasons: string[];
  outbox: OutboxItem[];
  /** The board's scheduled messages (ADR 0060), soonest first; empty until read. */
  scheduled: ScheduledMessage[];
};

/** `replaces` is your earlier message this one replaces (ADR 0068). */
export type Draft = Pick<Message, "text" | "to" | "recipients" | "replyTo" | "replaces">;

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
    pinned: [],
    statuses: [],
    brief: null,
    briefVersion: 0,
    olderNotLoaded: false,
    snapshot: null,
    snapshotVersion: 0,
    historyRevision: 0,
    snapshotDue: false,
    snapshotDueReasons: [],
    outbox: [],
    scheduled: [],
  });

  readonly channel: string;
  private readonly ctl: SessionController;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly byId = new Map<number, Message>();
  private syncCursor = 0;
  private pinsAt = 0;
  /** The newest brief announcement seen on the board (ADR 0074); a newer one rereads the brief. */
  private briefNotice = 0;
  private savingBrief = false;
  private reactionsAt = 0;
  private editsAt = 0;
  private scheduledAt = 0;
  /** Edit cursor (ADR 0052); 0 reads every edit once, so none made while loading is missed. */
  private editCursor = 0;
  /** Tick cursor (ADR 0082). A long poll asks for changes after this. */
  private ackCursor = 0;
  private readonly acked = new Set<number>();
  private deliveryAbort: AbortController | null = null;
  private needReload = true;
  private needSync = false;
  /** A status.changed event (ADR 0064) for this board, or a reload, asks to reread statuses. */
  private needStatuses = true;
  private pendingSnapshot: number | null = null;
  private running = false;
  private outboxRunning = false;
  private disposed = false;
  private readonly answering = new Set<number>();
  private outboxSeq = 0;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** After a failure, events must not bypass the backoff; only the timer, refresh() or resume lifts it. */
  private holdOff = false;
  private readonly backoff: BackoffOptions;

  private readonly pinRefreshMs: number;

  constructor(
    ctl: SessionController,
    channel: string,
    backoff: BackoffOptions = {},
    pinRefreshMs = PIN_REFRESH_MS,
  ) {
    this.pinRefreshMs = pinRefreshMs;
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
    void this.watchDelivery();
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
    this.deliveryAbort?.abort();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const off of this.unsubscribe) off();
  }

  /**
   * Messages on screen that name this viewer are read (ADR 0082). Idempotent per id.
   * A watch-only session may still ack: seeing the message is the point of the link.
   */
  noteSeen(ids: readonly number[]): void {
    const me = this.ctl.session.username;
    // A backgrounded app is not reading. Viewability can still report rows that were on screen.
    if (!me || this.disposed || this.ctl.state.get().kind === "paused") return;
    for (const id of ids) {
      if (this.acked.has(id)) continue;
      const message = this.byId.get(id);
      if (!message || !isAddressed(me, message)) continue;
      const mine = message.delivery?.find((row) => sameName(row.name, me));
      if (mine?.readAt) {
        this.acked.add(id);
        continue;
      }
      this.acked.add(id);
      void this.ctl.api
        .ack(this.channel, id, me, this.ctl.signal)
        .then((updated) => {
          const known = this.byId.get(id);
          if (!known || this.disposed) return;
          known.delivery = updated.delivery;
          this.publishMessages();
        })
        .catch(() => {
          this.acked.delete(id);
        });
    }
  }

  /** Long-poll tick changes without moving the history cursor (ADR 0082). */
  private async watchDelivery(): Promise<void> {
    const controller = new AbortController();
    this.deliveryAbort = controller;
    const parent = this.ctl.signal;
    const stop = () => controller.abort();
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", stop, { once: true });
    try {
      while (!this.disposed && !controller.signal.aborted) {
        if (this.state.get().phase === "loading") {
          await this.sleep(50, controller.signal);
          continue;
        }
        const started = Date.now();
        try {
          const me = this.ctl.session.username;
          const page = await this.ctl.api.listMessages(this.channel, this.syncCursor, 1, 25, controller.signal, {
            acksAfter: this.ackCursor,
            ...(me ? { participant: me } : {}),
          });
          if (this.disposed) return;
          if (typeof page.ackCursor === "number") this.ackCursor = page.ackCursor;
          let changed = false;
          for (const message of page.acks ?? []) {
            const known = this.byId.get(message.id);
            if (!known) continue;
            known.delivery = message.delivery;
            changed = true;
          }
          if (changed) this.publishMessages();
          if (page.messages.length) {
            this.needSync = true;
            void this.pump();
          }
          if (page.acksHasMore) continue;
        } catch (error) {
          if (this.disposed || isAbortError(error)) return;
        }
        // A server that answers at once must not spin. A real long poll already waited.
        const elapsed = Date.now() - started;
        if (elapsed < 1000) await this.sleep(1000 - elapsed, controller.signal);
      }
    } finally {
      parent.removeEventListener("abort", stop);
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      if (signal.aborted) finish();
      else signal.addEventListener("abort", finish, { once: true });
    });
  }

  // ---- canonical reads ---------------------------------------------------------------------

  private onEvent(event: CoordinationEvent): void {
    if (this.disposed || event.channel !== this.channel) return;
    switch (event.type) {
      case "message.created":
        this.needSync = true;
        break;
      case "message.deleted":
        if (event.resourceId !== null) {
          const next = this.byId.get(event.resourceId)?.replacedBy;
          const removed = this.byId.delete(event.resourceId);
          // Deleting an answer reopens its question (ADR 0065).
          const reopened = this.reopenQuestions(event.resourceId);
          // Deleting a replacement makes the message it replaced current again (ADR 0068), or
          // links it to the deleted message's own replacement in a chain.
          const current = this.unreplace(event.resourceId, next);
          if (removed || reopened || current) this.publishMessages();
        }
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
      case "status.changed":
        this.needStatuses = true;
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
          // Statuses send no message (ADR 0064): a reload reads them again after the history.
          this.needStatuses = true;
          op = () => this.reload();
          redo = () => (this.needReload = true);
        } else if (this.needSync) {
          this.needSync = false;
          op = () => this.syncForward();
          redo = () => (this.needSync = true);
        } else if (this.needStatuses) {
          this.needStatuses = false;
          op = () => this.refreshStatuses();
          redo = () => (this.needStatuses = true);
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
          if (
            !this.disposed &&
            !this.needReload &&
            !this.needSync &&
            !this.needStatuses &&
            this.pendingSnapshot === null
          ) {
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
    if (first.pinned && !first.pinnedOmitted) this.pinsAt = Date.now();
    this.state.update({
      phase: "ready",
      ...(first.pinned && !first.pinnedOmitted ? { pinned: first.pinned } : {}),
      snapshot: first.snapshot,
      snapshotVersion: first.snapshotVersion,
      historyRevision: first.historyRevision,
      snapshotDue: first.snapshotDue,
      snapshotDueReasons: first.snapshotDueReasons,
      olderNotLoaded,
    });
    // A reload reads the brief once, whatever announcements the history holds (ADR 0074).
    this.briefNotice = this.latestBriefNotice();
    this.publishMessages();
    void this.refreshBrief();
  }

  /** The id of the newest loaded board message that announces a brief change, or 0. */
  private latestBriefNotice(): number {
    let notice = this.briefNotice;
    for (const message of this.byId.values()) {
      if (message.id > notice && briefNoticeVersion(message) !== null) notice = message.id;
    }
    return notice;
  }

  private async syncForward(): Promise<void> {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const next = await this.ctl.api.listMessages(this.channel, this.syncCursor, PAGE, 0, this.ctl.signal);
      if (this.disposed) return;
      for (const message of next.messages) this.byId.set(message.id, message);
      this.syncCursor = next.nextCursor;
      this.publishMessages();
      if (!next.hasMore) {
        await this.refreshReactions();
        await this.refreshEdits();
        await this.refreshScheduled();
        return this.refreshPins();
      }
    }
    this.needSync = true;
  }

  /**
   * Reactions send no message or event (ADR 0047), so a sync re-reads them for the loaded messages
   * as often as pins. Best effort: a failed read keeps what is shown.
   */
  private async refreshReactions(): Promise<void> {
    if (!this.byId.size || Date.now() - this.reactionsAt < this.pinRefreshMs) return;
    this.reactionsAt = Date.now();
    const after = Math.min(...this.byId.keys()) - 1;
    try {
      const { reactions: found, claims } = await this.ctl.api.listReactions(this.channel, after, this.ctl.signal);
      if (this.disposed) return;
      let changed = false;
      for (const [id, loaded] of this.byId) {
        if (id <= after) continue;
        let message = loaded;
        const next = found.get(id);
        if (JSON.stringify(next ?? null) !== JSON.stringify(message.reactions ?? null))
          message = withReactions(message, next);
        // Claims (ADR 0075) ride on the same read; without a list, keep what is shown.
        const claim = claims?.get(id);
        if (claims && JSON.stringify(claim ?? null) !== JSON.stringify(message.claim ?? null))
          message = withClaim(message, claim);
        if (message === loaded) continue;
        this.byId.set(id, message);
        changed = true;
      }
      if (changed) this.publishMessages();
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
  }

  /**
   * Edits send no new message (ADR 0052), so a sync re-reads them after the edit cursor as often
   * as reactions. Best effort: a failed read keeps what is shown.
   */
  private async refreshEdits(): Promise<void> {
    if (!this.byId.size || Date.now() - this.editsAt < this.pinRefreshMs) return;
    this.editsAt = Date.now();
    try {
      const { edits, editCursor } = await this.ctl.api.listEdits(this.channel, this.editCursor, this.ctl.signal);
      if (this.disposed) return;
      this.editCursor = Math.max(this.editCursor, editCursor);
      let changed = false;
      for (const edited of edits) changed = this.applyEdit(edited) || changed;
      if (changed) this.publishMessages();
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
  }

  /**
   * Scheduled messages (ADR 0060) post on the server, so a sync re-reads the list as often as
   * reactions, and at once when one of them should have posted. Best effort.
   */
  private async refreshScheduled(force = false): Promise<void> {
    const due = this.state.get().scheduled.some((s) => s.status === "pending" && Date.parse(s.sendAt) <= Date.now());
    if (!force && !due && Date.now() - this.scheduledAt < this.pinRefreshMs) return;
    this.scheduledAt = Date.now();
    try {
      const scheduled = await this.ctl.api.listScheduled(this.channel, this.ctl.signal);
      if (this.disposed) return;
      this.state.update({ scheduled });
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
  }

  /** Runs one scheduled-message change, then re-reads the list. Resolves to an error message or null. */
  private async scheduledChange(run: () => Promise<void>, fallback: string): Promise<string | null> {
    try {
      await run();
      if (this.disposed) return null;
      await this.refreshScheduled(true);
      return null;
    } catch (error) {
      if (isAbortError(error)) return null;
      if (error instanceof ApiError && error.isAuthExpired) this.ctl.reportAuthFailure();
      return error instanceof Error ? error.message : fallback;
    }
  }

  /** Schedules a message to post at `sendAt` (ADR 0060). Resolves to an error message, or null. */
  async schedule(draft: Draft, sendAt: string): Promise<string | null> {
    if (!draft.text.trim()) return "Write the message first, then choose when to send it.";
    if (draft.replaces !== undefined) return "A replacement cannot be scheduled. Send it now, or cancel the replace.";
    if (byteLength(draft.text) > MAX_TEXT_BYTES) return "Messages are limited to 16 KiB.";
    const address = outgoingAddress(draft);
    if ("error" in address) return address.error;
    const input = {
      username: this.ctl.session.username,
      text: draft.text,
      ...address,
      ...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
      sendAt,
    };
    const key = createPendingSend(input).key;
    return this.scheduledChange(
      () => this.ctl.api.scheduleMessage(this.channel, input, key, this.ctl.signal),
      "Could not schedule the message.",
    );
  }

  /** Changes the text and/or time of one of your scheduled messages (ADR 0060). */
  async changeScheduled(id: number, change: { text?: string; sendAt?: string }): Promise<string | null> {
    if (change.text === undefined && change.sendAt === undefined) return "Give new text or a new time.";
    if (change.text !== undefined && !change.text.trim()) return "A message cannot be empty.";
    const username = this.ctl.session.username;
    return this.scheduledChange(
      () => this.ctl.api.changeScheduled(this.channel, id, { username, ...change }, this.ctl.signal),
      "Could not change the scheduled message.",
    );
  }

  /** Cancels a scheduled message (ADR 0060); the owner may cancel anyone's. */
  async cancelScheduled(id: number): Promise<string | null> {
    return this.scheduledChange(
      () => this.ctl.api.cancelScheduled(this.channel, id, this.ctl.session.username, this.ctl.signal),
      "Could not cancel the scheduled message.",
    );
  }

  /** Takes an edit's text and editedAt into the loaded copy; reactions and the rest stay. */
  private applyEdit(edited: Message): boolean {
    const current = this.byId.get(edited.id);
    if (!current || (current.text === edited.text && current.editedAt === edited.editedAt)) return false;
    this.byId.set(edited.id, {
      ...current,
      text: edited.text,
      ...(edited.editedAt ? { editedAt: edited.editedAt } : {}),
    });
    return true;
  }

  /**
   * Replaces the text of one of your loaded messages (ADR 0052). Resolves to an error message, or
   * null once the board shows the new text.
   */
  async editMessage(id: number, text: string): Promise<string | null> {
    const message = this.byId.get(id);
    if (!message) return "That message is no longer loaded.";
    const username = this.ctl.session.username;
    if (message.username !== username || username === "github") return "Only the sender can edit a message.";
    if (!text.trim()) return "A message cannot be empty.";
    if (text === message.text) return null;
    try {
      const updated = await this.ctl.api.editMessage(this.channel, id, { username, text }, this.ctl.signal);
      if (this.disposed) return null;
      if (this.applyEdit(updated)) this.publishMessages();
      return null;
    } catch (error) {
      if (isAbortError(error)) return null;
      if (error instanceof ApiError && error.isAuthExpired) this.ctl.reportAuthFailure();
      return error instanceof Error ? error.message : "Could not edit the message.";
    }
  }

  /**
   * Takes a loaded message as you, or releases it (ADR 0075). Resolves to an error message, or
   * null once the board shows the change. When someone else got there first, the server's text
   * names the holder and the row shows them.
   */
  async claim(id: number, release: boolean): Promise<string | null> {
    if (!this.byId.has(id)) return "That message is no longer loaded.";
    const username = this.ctl.session.username;
    const show = (updated: Message) => {
      const current = this.byId.get(id);
      if (this.disposed || !current) return;
      this.byId.set(id, withClaim(current, updated.claim));
      this.publishMessages();
    };
    try {
      show(await this.ctl.api.claim(this.channel, id, { username, release }, this.ctl.signal));
      return null;
    } catch (error) {
      if (isAbortError(error)) return null;
      if (error instanceof ApiError && error.isAuthExpired) this.ctl.reportAuthFailure();
      // 409: taken or replaced meanwhile. Read the message so the row says who has it.
      if (error instanceof ApiError && error.status === 409) {
        try {
          show((await this.ctl.api.getMessage(this.channel, id, this.ctl.signal)).message);
        } catch {
          // The refusal below already says what happened.
        }
      }
      return error instanceof Error ? error.message : "Could not change who is handling this.";
    }
  }

  /**
   * Toggles your reaction of one kind on a loaded message (ADR 0047): adds it, or removes it when
   * you already reacted. Resolves to an error message, or null once the board shows the change.
   */
  async react(id: number, kind: ReactionKind): Promise<string | null> {
    const message = this.byId.get(id);
    if (!message) return "That message is no longer loaded.";
    const username = this.ctl.session.username;
    const remove = message.reactions?.[kind]?.includes(username) ?? false;
    try {
      const updated = await this.ctl.api.react(this.channel, id, { username, kind, remove }, this.ctl.signal);
      if (this.disposed) return null;
      const current = this.byId.get(id);
      if (current) {
        this.byId.set(id, withReactions(current, updated.reactions));
        this.publishMessages();
      }
      return null;
    } catch (error) {
      if (isAbortError(error)) return null;
      if (error instanceof ApiError && error.isAuthExpired) this.ctl.reportAuthFailure();
      return error instanceof Error ? error.message : "Could not change the reaction.";
    }
  }

  /**
   * Answers a loaded question with one of its choices (ADR 0065). Resolves to an error message,
   * or null once the board shows the answer. When someone answered first, shows theirs.
   */
  async answer(id: number, choice: string): Promise<string | null> {
    const question = this.byId.get(id);
    if (!question?.choices) return "That question is no longer loaded.";
    // One answer at a time per question: a second tap while the first is in flight sends nothing.
    if (this.answering.has(id)) return null;
    this.answering.add(id);
    try {
      return await this.sendAnswer(id, choice);
    } finally {
      this.answering.delete(id);
    }
  }

  private async sendAnswer(id: number, choice: string): Promise<string | null> {
    const username = this.ctl.session.username;
    try {
      const result = await this.ctl.api.answer(
        this.channel,
        id,
        { username, choice },
        generateIdempotencyKey(),
        this.ctl.signal,
      );
      if (this.disposed) return null;
      this.byId.set(result.message.id, result.message);
      this.publishMessages();
      return null;
    } catch (error) {
      if (isAbortError(error)) return null;
      if (error instanceof ApiError && error.isAuthExpired) this.ctl.reportAuthFailure();
      if (error instanceof ApiError && error.code === "already_answered") {
        try {
          const { message } = await this.ctl.api.getMessage(this.channel, id, this.ctl.signal);
          if (!this.disposed && message.answered) {
            this.byId.set(id, message);
            this.publishMessages();
          }
        } catch {}
      }
      return error instanceof Error ? error.message : "Could not send the answer.";
    }
  }

  /** Best effort, like pins: a failed or unsupported read keeps what is shown (ADR 0064). */
  private async refreshStatuses(): Promise<void> {
    try {
      const statuses = await this.ctl.api.listStatuses(this.channel, this.ctl.signal);
      if (!this.disposed) this.state.update({ statuses });
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof ApiError && error.isAuthExpired) throw error;
    }
  }

  /**
   * Reads the board's brief (ADR 0074). Best effort, outside the sync loop: a failed or
   * unsupported read keeps what is shown. An answer older than the version shown is dropped.
   */
  private async refreshBrief(): Promise<void> {
    try {
      const next = await this.ctl.api.getBrief(this.channel, this.ctl.signal);
      if (this.disposed) return;
      if (next.currentVersion >= this.state.get().briefVersion)
        this.state.update({ brief: next.brief, briefVersion: next.currentVersion });
    } catch (error) {
      if (error instanceof ApiError && error.isAuthExpired) this.ctl.reportAuthFailure();
    }
  }

  /**
   * Writes the board's brief (ADR 0074); blank text removes it. Owner only: the server refuses
   * everyone else. Resolves to an error message to show, or null once the header shows the result.
   * When another device wrote first, the newer brief is read so the next save builds on it.
   */
  /**
   * `baseVersion` is the version the editor showed when it opened. A change that arrives while
   * the owner types is then a conflict, not a silent overwrite. Left out, the save builds on
   * the newest version, which is what a second press after a conflict means.
   */
  async saveBrief(text: string, baseVersion?: number): Promise<string | null> {
    if (this.savingBrief) return null;
    const { over } = briefCount(text);
    if (over) return `A brief holds at most ${BRIEF_MAX_BYTES.toLocaleString("en-US")} bytes.`;
    this.savingBrief = true;
    try {
      const saved = await this.ctl.api.putBrief(
        this.channel,
        text,
        baseVersion ?? this.state.get().briefVersion,
        this.ctl.signal,
      );
      if (!this.disposed && saved.currentVersion >= this.state.get().briefVersion)
        this.state.update({ brief: saved.brief, briefVersion: saved.currentVersion });
      return null;
    } catch (error) {
      if (isAbortError(error)) return null;
      if (error instanceof ApiError && error.isAuthExpired) this.ctl.reportAuthFailure();
      if (error instanceof ApiError && error.code === "brief_conflict") {
        await this.refreshBrief();
        return `${BRIEF_CONFLICT} Your text is kept; save again to replace the newer version.`;
      }
      if (error instanceof ApiError && error.status === 403) return "Only the board owner can change the brief.";
      return error instanceof Error ? error.message : "Could not save the brief.";
    } finally {
      this.savingBrief = false;
    }
  }

  /** Best effort: a failed or unsupported pins read keeps what is shown. */
  private async refreshPins(): Promise<void> {
    if (Date.now() - this.pinsAt < this.pinRefreshMs) return;
    this.pinsAt = Date.now();
    try {
      const pinned = await this.ctl.api.listPins(this.channel, this.ctl.signal);
      if (!this.disposed) this.state.update({ pinned });
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
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

  /** Clears `answered` from loaded questions whose answer was `id`. True when any changed. */
  private reopenQuestions(id: number): boolean {
    let changed = false;
    for (const message of this.byId.values()) {
      if (message.answered?.id !== id) continue;
      const { answered: _gone, ...open } = message;
      this.byId.set(message.id, open);
      changed = true;
    }
    return changed;
  }

  /**
   * Points loaded messages that deleted `id` replaced at `next`, the deleted message's own
   * replacement, or clears `replacedBy` when it had none. True when any changed.
   */
  private unreplace(id: number, next: number | undefined): boolean {
    let changed = false;
    for (const message of this.byId.values()) {
      if (message.replacedBy !== id) continue;
      const { replacedBy: _gone, ...current } = message;
      this.byId.set(message.id, next === undefined ? current : { ...current, replacedBy: next });
      changed = true;
    }
    return changed;
  }

  private publishMessages(): void {
    // A brief change is announced by a board message (ADR 0074): read the new brief once.
    const notice = this.latestBriefNotice();
    if (notice > this.briefNotice) {
      this.briefNotice = notice;
      void this.refreshBrief();
    }
    // A replacement marks the loaded message it replaces (ADR 0068); one read later carries it.
    for (const message of this.byId.values()) {
      const old = message.replaces !== undefined ? this.byId.get(message.replaces) : undefined;
      if (old && old.replacedBy === undefined) this.byId.set(old.id, { ...old, replacedBy: message.id });
    }
    // An answer locks its loaded question (ADR 0065); a question read later carries `answered`.
    for (const message of this.byId.values()) {
      const answered = answeredBy(message);
      const question = answered && message.replyTo !== undefined ? this.byId.get(message.replyTo) : undefined;
      if (answered && question?.choices && !question.answered) this.byId.set(question.id, { ...question, answered });
    }
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
    const address = outgoingAddress(draft);
    if ("error" in address) return { ok: false, error: address.error };
    if (this.state.get().outbox.length >= MAX_OUTBOX) {
      return { ok: false, error: "Too many unsent messages. Retry or discard some first." };
    }
    const input: SendMessageInput = {
      username: this.ctl.session.username,
      text: draft.text,
      ...address,
      ...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
      ...(draft.replaces ? { replaces: draft.replaces } : {}),
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
    const { text, to, replyTo, replaces } = item.input;
    const address = Array.isArray(to) ? { to: to[0], recipients: [...to] } : { to };
    return { text, ...address, replyTo, ...(replaces !== undefined ? { replaces } : {}) };
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
    // @channel refusals store nothing. 429 would otherwise look like an uncertain delivery.
    const mention = error instanceof ApiError ? channelMentionNotice(error) : null;
    if (mention) {
      this.patchItem(id, { status: "rejected", error: mention });
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

/** A copy of the message carrying these reactions; none leaves the field out, as the server does. */
function withReactions(message: Message, reactions: Reactions | undefined): Message {
  const { reactions: _old, ...rest } = message;
  return reactions && Object.keys(reactions).length ? { ...rest, reactions } : rest;
}
