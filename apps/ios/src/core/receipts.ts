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
  "Processed means the reader explicitly committed past this message (msn commit --resumable). Not yet means no such commit covers it; it does not mean the reader has not seen it. Local-only commits are not shown.";

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

/** "Processed by lead · not yet: worker", or null when the channel has no readers to name. */
export function receiptLine(receipts: readonly Receipt[], id: number): string | null {
  if (!receipts.length) return null;
  const done = receipts.filter((r) => processed(r, id)).map((r) => r.name);
  const waiting = receipts.filter((r) => !processed(r, id)).map((r) => r.name);
  if (!waiting.length) return `Processed by ${done.join(", ")}`;
  if (!done.length) return `Not yet processed by ${waiting.join(", ")}`;
  return `Processed by ${done.join(", ")} · not yet: ${waiting.join(", ")}`;
}

export async function loadReceipts(api: ApiClient, channel: string, signal?: AbortSignal): Promise<Receipt[]> {
  return decodeReceipts(await api.channelReceipts(channel, signal), channel);
}
