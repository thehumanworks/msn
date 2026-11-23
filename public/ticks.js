import { sentBy } from "./address.js";

/**
 * One mark for an addressed message's per-recipient delivery (ADR 0082).
 * `rows` is the message's `delivery` array, or missing when the message has none.
 * Read counts as delivered. Two ticks only when every recipient has read.
 */

/** @typedef {{ name: string, deliveredAt: string | null, readAt: string | null }} DeliveryRow */

/** @param {DeliveryRow[] | null | undefined} rows */
export function tickOf(rows) {
  if (!rows?.length) return "none";
  let delivered = 0;
  let read = 0;
  for (const row of rows) {
    if (row.readAt) {
      read += 1;
      delivered += 1;
    } else if (row.deliveredAt) delivered += 1;
  }
  if (read === rows.length) return "read";
  if (delivered === rows.length) return "delivered";
  if (delivered > 0) return "partial";
  return "pending";
}

/** @param {ReturnType<typeof tickOf>} tick */
export function tickGlyph(tick) {
  if (tick === "read") return "✓✓";
  if (tick === "delivered" || tick === "partial") return "✓";
  return "";
}

/**
 * How far the second check sits to the right of the first, in px.
 * A few pixels: the strokes overlap instead of sitting side by side (ADR 0083).
 */
export const TICK_OFFSET_PX = 4;

/** Ticks belong on the sender's bubble. Another participant's message stays unmarked. */
export function bubbleTick(own, rows) {
  if (!own) return "none";
  return tickOf(rows);
}

/** How many thin checks to draw. Pending and none draw nothing. @param {ReturnType<typeof tickOf>} tick */
export function tickMarks(tick) {
  if (tick === "read") return 2;
  if (tick === "delivered" || tick === "partial") return 1;
  return 0;
}

/** Read is blue. Delivered and partial stay muted. @param {ReturnType<typeof tickOf>} tick */
export function tickTone(tick) {
  return tick === "read" ? "read" : "muted";
}

/**
 * This viewer sent the bubble: their bound name or a `/worker` suffix of it, and not an agent
 * posting under that name (ADR 0084).
 */
export function ownBubble(message, me) {
  return Boolean(message) && !message.agentUserId && sentBy(message.username, me);
}

/**
 * What the web painter puts on the ticks node, or null when the bubble stays unmarked.
 * `offset` is the shared px constant the stylesheet's `--tick-offset` is set from.
 */
export function tickAttrs(message, me) {
  const shown = tickLayout(ownBubble(message, me), message?.delivery);
  if (!shown.marks) return null;
  return {
    role: "img",
    label: tickLabel(message.delivery),
    className: shown.tone === "read" ? "ticks read" : "ticks",
    offsets: shown.offsets,
    offset: TICK_OFFSET_PX,
  };
}

/** What one bubble paints: nothing unless this viewer sent the message. */
export function tickLayout(own, rows) {
  const tick = bubbleTick(own, rows);
  const marks = tickMarks(tick);
  return {
    tick,
    marks,
    tone: tickTone(tick),
    offsets: Array.from({ length: marks }, (_, index) => index * TICK_OFFSET_PX),
  };
}

/** @param {DeliveryRow[] | null | undefined} rows */
export function tickLabel(rows) {
  if (!rows?.length) return "";
  return rows
    .map((row) => {
      if (row.readAt) return `${row.name} read`;
      if (row.deliveredAt) return `${row.name} delivered`;
      return `${row.name} not yet delivered`;
    })
    .join(", ");
}
