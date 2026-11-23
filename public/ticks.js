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
