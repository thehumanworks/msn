/** One mark for an addressed message's delivery rows (ADR 0082). */

export type DeliveryRow = {
  name: string;
  deliveredAt: string | null;
  readAt: string | null;
};

export type Tick = "none" | "pending" | "partial" | "delivered" | "read";

export function tickOf(rows: DeliveryRow[] | null | undefined): Tick {
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

export function tickGlyph(tick: Tick): string {
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
export function bubbleTick(own: boolean, rows: DeliveryRow[] | null | undefined): Tick {
  if (!own) return "none";
  return tickOf(rows);
}

/** How many thin checks to draw. Pending and none draw nothing. */
export function tickMarks(tick: Tick): 0 | 1 | 2 {
  if (tick === "read") return 2;
  if (tick === "delivered" || tick === "partial") return 1;
  return 0;
}

/** Read is blue. Delivered and partial stay muted. */
export function tickTone(tick: Tick): "read" | "muted" {
  return tick === "read" ? "read" : "muted";
}

/** What one bubble paints: nothing unless this viewer sent the message. */
export function tickLayout(own: boolean, rows: DeliveryRow[] | null | undefined): {
  tick: Tick;
  marks: 0 | 1 | 2;
  tone: "read" | "muted";
  offsets: number[];
} {
  const tick = bubbleTick(own, rows);
  const marks = tickMarks(tick);
  return {
    tick,
    marks,
    tone: tickTone(tick),
    offsets: Array.from({ length: marks }, (_, index) => index * TICK_OFFSET_PX),
  };
}

export function tickLabel(rows: DeliveryRow[] | null | undefined): string {
  if (!rows?.length) return "";
  return rows
    .map((row) => {
      if (row.readAt) return `${row.name} read`;
      if (row.deliveredAt) return `${row.name} delivered`;
      return `${row.name} not yet delivered`;
    })
    .join(", ");
}
