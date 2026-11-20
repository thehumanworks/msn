import type { ApiClient } from "./apiClient.ts";
import { ProtocolError } from "./errors.ts";

/**
 * Board mutes (ADR 0044). A mute holds back one board's push notifications for the workspace
 * owner on every device they turned notifications on. Messages keep arriving on the board, and
 * messages addressed to the owner still notify unless `everything` is set. The server decides
 * expiry when it sends; this client only shows the time it was given.
 */
export type Mute = { channel: string; until: string | null; everything: boolean };
export type MuteSpan = "1h" | "1d" | "forever";

export const MUTE_SPANS = [
  { value: "1h", label: "1 hour" },
  { value: "1d", label: "1 day" },
  { value: "forever", label: "Until I turn it back on" },
] as const;

export function decodeMute(raw: unknown): Mute {
  const m = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (
    typeof m.channel !== "string" ||
    !(m.until === null || (typeof m.until === "string" && !Number.isNaN(Date.parse(m.until)))) ||
    typeof m.everything !== "boolean"
  )
    throw new ProtocolError("The server sent an invalid mute.");
  return { channel: m.channel, until: m.until as string | null, everything: m.everything };
}

export function decodeMutes(raw: unknown): Mute[] {
  const list = (raw as { mutes?: unknown } | null)?.mutes;
  if (!Array.isArray(list)) throw new ProtocolError("The server sent invalid mutes.");
  return list.map(decodeMute);
}

/** The board's mute, unless it has already run out. */
export function activeMute(mutes: readonly Mute[], channel: string, now = Date.now()): Mute | null {
  const mute = mutes.find((m) => m.channel === channel);
  if (!mute) return null;
  return mute.until !== null && Date.parse(mute.until) <= now ? null : mute;
}

/** "Mute", "Muted" or "Muted until 16:42" (a weekday is added when it ends on another day). */
export function muteLabel(mute: Mute | null, now = Date.now(), locale?: string): string {
  if (!mute) return "Mute";
  if (mute.until === null) return "Muted";
  const until = new Date(mute.until);
  const time = until.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const sameDay = until.toDateString() === new Date(now).toDateString();
  return `Muted until ${sameDay ? time : `${until.toLocaleDateString(locale, { weekday: "short" })} ${time}`}`;
}

/** Sets a mute and returns the owner's mutes as they now stand. */
export async function saveMute(
  api: Pick<ApiClient, "setMute" | "listMutes">,
  channel: string,
  span: MuteSpan,
  everything: boolean,
): Promise<Mute[]> {
  await api.setMute(channel, span === "forever" ? null : span, everything);
  return api.listMutes();
}

export async function removeMute(
  api: Pick<ApiClient, "clearMute" | "listMutes">,
  channel: string,
): Promise<Mute[]> {
  await api.clearMute(channel);
  return api.listMutes();
}
