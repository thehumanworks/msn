import { ProtocolError } from "./errors.ts";
import type { Message } from "./types.ts";

/**
 * The board brief (ADR 0074): the owner's standing instructions for a board, up to 4 KiB of
 * Markdown. Agents receive it first when they start; this app shows it as the board's header, and
 * the owner edits it here. Each write is a new version; the server keeps the old ones.
 */
export type Brief = { version: number; text: string; updatedAt: string; updatedBy: string | null };
/** `brief` is null when the board has none or it was removed; a write names `currentVersion`. */
export type BriefState = { brief: Brief | null; currentVersion: number };

/** The longest brief in UTF-8 bytes; the server checks again. */
export const BRIEF_MAX_BYTES = 4096;

const version = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function decodeBrief(raw: unknown): BriefState {
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (!version(body.currentVersion)) throw new ProtocolError("The server sent an invalid brief.");
  const currentVersion = body.currentVersion as number;
  if (body.brief === null || body.brief === undefined) return { brief: null, currentVersion };
  const b = body.brief as Record<string, unknown>;
  if (
    typeof b !== "object" ||
    !version(b.version) ||
    (b.version as number) < 1 ||
    (b.version as number) > currentVersion ||
    typeof b.text !== "string" ||
    !b.text ||
    typeof b.updatedAt !== "string" ||
    !(b.updatedBy === undefined || typeof b.updatedBy === "string")
  )
    throw new ProtocolError("The server sent an invalid brief.");
  return {
    brief: {
      version: b.version as number,
      text: b.text,
      updatedAt: b.updatedAt,
      updatedBy: (b.updatedBy as string | undefined) ?? null,
    },
    currentVersion,
  };
}

/** UTF-8 length without TextEncoder, which not every JavaScript engine on a phone has. */
export function briefBytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** "173 of 4,096 bytes", and whether the text is too long to save. */
export function briefCount(text: string): { bytes: number; over: boolean; label: string } {
  const bytes = briefBytes(text);
  const over = bytes > BRIEF_MAX_BYTES;
  const count = `${bytes.toLocaleString("en-US")} of ${BRIEF_MAX_BYTES.toLocaleString("en-US")} bytes`;
  return { bytes, over, label: over ? `${count}: too long to save` : count };
}

/** "Brief · version 3 · human". */
export function briefTitle(brief: Brief): string {
  return ["Brief", `version ${brief.version}`, brief.updatedBy].filter(Boolean).join(" · ");
}

/** The version a board message announces (`msn.brief.v1`), or null for every other message. */
export function briefNoticeVersion(message: Pick<Message, "username" | "contentType" | "text">): number | null {
  if (message.username !== "board" || message.contentType !== "application/json") return null;
  try {
    const data = JSON.parse(message.text) as { schema?: unknown; version?: unknown };
    return data.schema === "msn.brief.v1" && version(data.version) && (data.version as number) >= 1
      ? (data.version as number)
      : null;
  } catch {
    return null;
  }
}
