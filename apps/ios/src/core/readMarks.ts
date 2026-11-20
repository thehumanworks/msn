import type { SecretStore } from "./sessionStorage.ts";
import { Store } from "./store.ts";

/**
 * Where this reader stopped on each board, kept on this device only (ADR 0045), and the unread
 * counts the channel list shows from it. The server never learns the marks: the counts request
 * sends them and the server keeps nothing.
 *
 * Storage: the keychain is the app's only persistent store, so the marks live there as one small
 * item per identity, `msn.read.v1.<hash>`, holding `[[channel, id], …]` oldest-moved first. Only
 * the most recently read boards that fit in STORED_BYTES are written, below expo-secure-store's
 * documented 2048-byte value limit; memory keeps up to MAX_MARKS for this session. The item is
 * written only once the profile is saved, and forgetting the profile removes it.
 */
export const MAX_MARKS = 100;
/** The keychain item's size bound in bytes (expo-secure-store documents 2048 per value). */
export const STORED_BYTES = 1800;
/** Boards per counts request, matching the server's limit. */
export const UNREAD_BOARDS = 100;
/** Writes are coalesced: at most one keychain write per this interval. */
export const SAVE_DELAY_MS = 2000;

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type MarkIdentity = { origin: string; tenant: string; username: string; channel?: string };

/** Two stable FNV-1a 32 hashes, as 16 hex digits: keychain keys allow letters, digits, `.-_`. */
function stableHash(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const fnv = (seed: number) => {
    let hash = seed >>> 0;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    return hash.toString(16).padStart(8, "0");
  };
  return fnv(0x811c9dc5) + fnv(0x050c5d1f);
}

export function readMarksKey(identity: MarkIdentity): string {
  const id = JSON.stringify([identity.origin, identity.tenant, identity.username, identity.channel ?? null]);
  return `msn.read.v1.${stableHash(id)}`;
}

export type MarkList = ReadonlyArray<readonly [string, number]>;

/** Parse a stored list; anything malformed reads as empty, bad entries are skipped. */
export function parseMarks(raw: string | null): MarkList {
  try {
    const data: unknown = JSON.parse(raw ?? "null");
    if (!Array.isArray(data)) return [];
    let marks: MarkList = [];
    for (const entry of data) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [channel, id] = entry as unknown[];
      if (typeof channel === "string" && SLUG.test(channel) && Number.isSafeInteger(id) && (id as number) >= 0)
        marks = advanceMarks(marks, channel, id as number) ?? marks;
    }
    return marks;
  } catch {
    return [];
  }
}

/** Move a mark forward only; the moved mark goes last so the oldest is dropped. Null if unchanged. */
export function advanceMarks(marks: MarkList, channel: string, id: number): MarkList | null {
  if (!Number.isSafeInteger(id) || id < 0) return null;
  const current = marks.find(([name]) => name === channel)?.[1];
  if (current !== undefined && current >= id) return null;
  const next = [...marks.filter(([name]) => name !== channel), [channel, id] as const];
  return next.slice(Math.max(0, next.length - MAX_MARKS));
}

/** The marks for listed boards, most recently read last, at most UNREAD_BOARDS. */
export function marksForListed(marks: MarkList, listed: readonly string[]): MarkList {
  const names = new Set(listed);
  const pairs = marks.filter(([name]) => names.has(name));
  return pairs.slice(Math.max(0, pairs.length - UNREAD_BOARDS));
}

/**
 * The mark for what is on screen: the newest visible message, held just below the oldest reply
 * still folded away (unseen replies are not read). Null when nothing is visible.
 */
export function seenMark(visible: Iterable<number>, unseen: Iterable<number>): number | null {
  let seen = -1;
  for (const id of visible) if (Number.isSafeInteger(id)) seen = Math.max(seen, id);
  for (const id of unseen) seen = Math.min(seen, id - 1);
  return seen > 0 ? seen : null;
}

/** The JSON for the keychain: the newest marks whose encoding fits in `limit` bytes. */
export function storedMarks(marks: MarkList, limit = STORED_BYTES): string {
  let kept = [...marks];
  let text = JSON.stringify(kept);
  while (kept.length && new TextEncoder().encode(text).length > limit) {
    // Drop the oldest quarter at a time; a 64-character board name is about 90 bytes.
    kept = kept.slice(Math.max(1, Math.floor(kept.length / 4)));
    text = JSON.stringify(kept);
  }
  return text;
}

export type Unread = { channel: string; after: number; count: number; toYou: number; capped: boolean };

/**
 * Decode `GET …/unread`, keeping only answers for boards that were asked about at the mark sent.
 * Throws on a malformed body.
 */
export function decodeUnread(raw: unknown, asked: MarkList): Map<string, Unread> {
  const rows = (raw as { unread?: unknown } | null)?.unread;
  if (!Array.isArray(rows)) throw new Error("The server sent invalid unread counts.");
  const result = new Map<string, Unread>();
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    const { channel, after, count, toYou } = r;
    if (
      typeof channel !== "string" ||
      !Number.isSafeInteger(after) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(toYou)
    )
      throw new Error("The server sent invalid unread counts.");
    if (!asked.some(([name, id]) => name === channel && id === after)) continue;
    result.set(channel, {
      channel,
      after: after as number,
      count: Math.max(0, count as number),
      toYou: Math.max(0, Math.min(toYou as number, count as number)),
      capped: r.capped === true,
    });
  }
  return result;
}

/** Badge text and the spoken label; null when nothing is unread. */
export function unreadBadge(entry: Unread | undefined): { count: string; toYou: string | null; label: string } | null {
  if (!entry || entry.count <= 0) return null;
  const count = `${entry.count}${entry.capped ? "+" : ""}`;
  const noun = entry.count === 1 && !entry.capped ? "unread message" : "unread messages";
  return {
    count,
    toYou: entry.toYou > 0 ? `@${entry.toYou}` : null,
    label: entry.toYou > 0 ? `${count} ${noun}, ${entry.toYou} to you` : `${count} ${noun}`,
  };
}

/** The count to show for a board: none once its mark has moved past what was counted. */
export function currentUnread(
  counts: ReadonlyMap<string, Unread>,
  marks: MarkList,
  channel: string,
): Unread | undefined {
  const entry = counts.get(channel);
  const mark = marks.find(([name]) => name === channel)?.[1];
  return entry && entry.count > 0 && mark === entry.after ? entry : undefined;
}

/**
 * One identity's marks: loaded once from the keychain, advanced by the channel screen, read by
 * the channel list. A failed keychain read or write only costs counts after a restart.
 */
export class ReadMarks {
  readonly state = new Store<MarkList>([]);
  readonly ready: Promise<void>;
  private readonly store: SecretStore;
  private readonly key: string;
  private readonly saveDelayMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;
  private disposed = false;

  private persist: boolean;

  /**
   * `persist: false` keeps the marks in memory only, until `startPersisting` (called once the
   * profile is saved): a session that is not saved on the device leaves no board names behind.
   */
  constructor(
    store: SecretStore,
    identity: MarkIdentity,
    { saveDelayMs = SAVE_DELAY_MS, persist = true }: { saveDelayMs?: number; persist?: boolean } = {},
  ) {
    this.store = store;
    this.key = readMarksKey(identity);
    this.saveDelayMs = saveDelayMs;
    this.persist = persist;
    this.ready = persist ? this.mergeStored() : Promise.resolve();
    if (!persist) this.loaded = true;
  }

  /** The profile is now saved: read any older marks for it and keep these on the device too. */
  async startPersisting(): Promise<void> {
    if (this.persist || this.disposed) return;
    this.persist = true;
    await this.mergeStored();
    this.scheduleSave();
  }

  /** The profile is being forgotten: drop any pending write and never write again. */
  discard(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.persist = false;
    this.disposed = true;
  }

  private mergeStored(): Promise<void> {
    return this.store
      .get(this.key)
      .then((raw) => {
        // Marks advanced before the load finished are newer than what was stored.
        let merged = parseMarks(raw);
        for (const [channel, id] of this.state.get()) merged = advanceMarks(merged, channel, id) ?? merged;
        this.state.set(merged);
      })
      .catch(() => undefined)
      .finally(() => {
        this.loaded = true;
      });
  }

  get(channel: string): number | undefined {
    return this.state.get().find(([name]) => name === channel)?.[1];
  }

  /** Returns whether the mark moved. */
  advance(channel: string, id: number): boolean {
    if (this.disposed) return false;
    const next = advanceMarks(this.state.get(), channel, id);
    if (!next) return false;
    this.state.set(next);
    this.scheduleSave();
    return true;
  }

  /** Writes now if a save is pending (the app is going to the background). */
  async flush(): Promise<void> {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    await this.save();
  }

  dispose(): void {
    if (this.disposed) return;
    void this.flush();
    this.disposed = true;
  }

  private scheduleSave(): void {
    if (this.timer || !this.persist) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, this.saveDelayMs);
  }

  private async save(): Promise<void> {
    if (!this.loaded) await this.ready;
    if (!this.persist) return;
    await this.store.set(this.key, storedMarks(this.state.get())).catch(() => undefined);
  }
}
