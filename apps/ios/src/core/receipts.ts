import type { ApiClient } from "./apiClient.ts";
import { ProtocolError } from "./errors.ts";

/**
 * Processed-by receipts (ADR 0040). The server reads them only from explicit resumable commits
 * (ADR 0034), so a receipt proves that the reader committed past a message, and nothing else.
 */
export type Receipt = {
  name: string;
  reader: string | null;
  personaId: string | null;
  /** null: a board persona that has never committed a resumable cursor on this channel. */
  committedThrough: number | null;
  updatedAt: string | null;
};

export const RECEIPTS_MEANING =
  "From explicit resumable commits (msn commit --resumable) only. Processed: the reader committed past this message. Not yet: the reader has committed, but not this far; it may still have seen it. Agents that never commit to the server are not listed. A shared board key can commit under any persona's name.";

/** Names listed per side before the rest fold into "+N more". */
export const RECEIPTS_MAX_NAMES = 10;

/** How often an open channel reloads receipts; a commit is not a channel event. */
export const RECEIPTS_EVERY_MS = 15_000;

const text = (value: unknown) => typeof value === "string";
const nullable = (value: unknown, check: (v: unknown) => boolean) => value === null || check(value);
const cursor = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function decodeReceipts(raw: unknown, channel: string): Receipt[] {
  const bad = (): never => {
    throw new ProtocolError("The server sent invalid receipts.");
  };
  if (typeof raw !== "object" || raw === null) return bad();
  const body = raw as { channel?: unknown; receipts?: unknown };
  if (body.channel !== channel || !Array.isArray(body.receipts)) return bad();
  return body.receipts.map((item: unknown) => {
    const r = (typeof item === "object" && item !== null ? item : bad()) as Record<string, unknown>;
    if (
      !text(r.name) ||
      !nullable(r.reader, text) ||
      !nullable(r.personaId, text) ||
      !nullable(r.committedThrough, cursor) ||
      !nullable(r.updatedAt, text)
    )
      bad();
    return {
      name: r.name as string,
      reader: r.reader as string | null,
      personaId: r.personaId as string | null,
      committedThrough: r.committedThrough as number | null,
      updatedAt: r.updatedAt as string | null,
    };
  });
}

export function processed(receipt: Receipt, id: number): boolean {
  return receipt.committedThrough !== null && receipt.committedThrough >= id;
}

/** The message's own sender, by persona id or by name (with any `/worker` suffix). */
export function fromSender(receipt: Receipt, username: string, personaId?: string | null): boolean {
  return (
    (personaId != null && receipt.personaId === personaId) ||
    receipt.name === username ||
    receipt.name.startsWith(`${username}/`)
  );
}

function names(list: string[]): string {
  const shown = list.slice(0, RECEIPTS_MAX_NAMES).join(", ");
  return list.length > RECEIPTS_MAX_NAMES ? `${shown} +${list.length - RECEIPTS_MAX_NAMES} more` : shown;
}

/**
 * "Processed by lead · not yet: worker", naming only readers with a server cursor and never the
 * sender; null when there is nobody to name. A persona that never committed is not listed: its
 * progress is unknown, not behind.
 */
export function receiptLine(
  receipts: readonly Receipt[],
  message: { id: number; username: string; personaId?: string | null },
): string | null {
  const relevant = receipts.filter(
    (r) => r.committedThrough !== null && !fromSender(r, message.username, message.personaId),
  );
  const done = relevant.filter((r) => processed(r, message.id)).map((r) => r.name);
  const waiting = relevant.filter((r) => !processed(r, message.id)).map((r) => r.name);
  if (!done.length && !waiting.length) return null;
  if (!waiting.length) return `Processed by ${names(done)}`;
  if (!done.length) return `Not yet processed by ${names(waiting)}`;
  return `Processed by ${names(done)} · not yet: ${names(waiting)}`;
}

export async function loadReceipts(api: ApiClient, channel: string, signal?: AbortSignal): Promise<Receipt[]> {
  return decodeReceipts(await api.channelReceipts(channel, signal), channel);
}
