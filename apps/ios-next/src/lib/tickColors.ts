/** Muted on the blue outgoing bubble. Delivered and partial stay this one grey check. */
export const SENT_TICK = "#E4EAF1";
/**
 * Light cyan on the system-blue outgoing bubble (ADR 0085). Clears 3:1 on system blue
 * in light (`#007AFF`) and dark (`#0A84FF`). `#53bdeb` does not.
 */
export const READ_TICK = "#E8F7FF";

export function tickColor(tone: "read" | "muted"): string {
  return tone === "read" ? READ_TICK : SENT_TICK;
}
