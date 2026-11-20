/**
 * Reply threads (ADR 0041). Display only: the channel's messages, cursors and outbox are not
 * changed. A reply whose parent is loaded folds under the parent; a reply to a reply joins the
 * same thread, so threads are one level deep. A reply whose parent is not loaded stays in the log
 * at its own place, and the person can load that parent with an ordinary point read.
 */
import type { ApiClient } from "./apiClient.ts";
import { ApiError } from "./errors.ts";
import { Store } from "./store.ts";
import type { Message } from "./types.ts";

export type ThreadRow =
  /** A message in the log; `replies` counts every loaded reply folded under it. */
  | { kind: "message"; message: Message; replies: number; open: boolean }
  /** A reply shown under its open thread root. */
  | { kind: "reply"; message: Message; root: number };

/** Rows oldest first. `messages` must be in id order, as the channel controller keeps them. */
export function threadRows(messages: readonly Message[], expanded: ReadonlySet<number>): ThreadRow[] {
  const rootOf = new Map<number, number>();
  const replies = new Map<number, Message[]>();
  const top: Message[] = [];
  for (const message of messages) {
    const root = message.replyTo === undefined ? undefined : rootOf.get(message.replyTo);
    if (root === undefined) {
      rootOf.set(message.id, message.id);
      top.push(message);
    } else {
      rootOf.set(message.id, root);
      const thread = replies.get(root);
      if (thread) thread.push(message);
      else replies.set(root, [message]);
    }
  }
  const rows: ThreadRow[] = [];
  for (const message of top) {
    const thread = replies.get(message.id) ?? [];
    const open = thread.length > 0 && expanded.has(message.id);
    rows.push({ kind: "message", message, replies: thread.length, open });
    if (open) for (const reply of thread) rows.push({ kind: "reply", message: reply, root: message.id });
  }
  return rows;
}

export function threadLabel(replies: number, open: boolean): string {
  return `${open ? "Hide" : "Show"} ${replies} repl${replies === 1 ? "y" : "ies"}`;
}

/** A fetched parent, `null` when it no longer exists, or loading / failed. */
export type ParentState = { status: "loading" } | { status: "loaded"; message: Message | null } | { status: "error"; error: string };

type Reader = Pick<ApiClient, "getMessage">;

/** Fetches parents of replies whose parent is not loaded, once each, for one channel. */
export class ParentLoader {
  readonly state = new Store<ReadonlyMap<number, ParentState>>(new Map());
  private readonly abort = new AbortController();
  private readonly api: Reader;
  private readonly channel: string;

  constructor(api: Reader, channel: string) {
    this.api = api;
    this.channel = channel;
  }

  async load(id: number): Promise<void> {
    const current = this.state.get().get(id);
    if (current && current.status !== "error") return;
    this.put(id, { status: "loading" });
    try {
      const { message } = await this.api.getMessage(this.channel, id, this.abort.signal);
      this.put(id, { status: "loaded", message });
    } catch (error) {
      if (this.abort.signal.aborted) return;
      if (error instanceof ApiError && error.status === 404) this.put(id, { status: "loaded", message: null });
      else this.put(id, { status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Stops requests in flight; call when the channel view goes away. */
  cancel(): void {
    this.abort.abort();
  }

  private put(id: number, value: ParentState): void {
    const next = new Map(this.state.get());
    next.set(id, value);
    this.state.set(next);
  }
}
