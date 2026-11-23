/** Muted on the blue outgoing bubble, so a sent check stays distinct from the read blue. */
export const SENT_TICK = "#E4EAF1";
/** WhatsApp's read blue (ADR 0084). */
export const READ_TICK = "#53bdeb";

export function tickColor(tone: "read" | "muted"): string {
  return tone === "read" ? READ_TICK : SENT_TICK;
}
