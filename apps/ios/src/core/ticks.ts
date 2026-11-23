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
