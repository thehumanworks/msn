/**
 * Long messages fold (ADR 0050). A body taller than FOLD_LINES rendered lines shows its first
 * FOLDED_LINES lines, clipped, with Show more under it. Display only: the text, search, links,
 * exports and what agents read are unchanged. The rendered height decides, so Markdown is never
 * cut in its source: a code block or table is clipped, not broken.
 */
export const FOLD_LINES = 15;
export const FOLDED_LINES = 10;

export type FoldState = {
  /** The body is long enough to have a Show more / Show less control. */
  long: boolean;
  /** The clip height while folded, or null when the body shows whole. */
  maxHeight: number | null;
};

/**
 * `height` is the body's measured natural height (undefined before its first layout), `line`
 * the body's line height, and `open` whether the reader opened it or jumped to it.
 */
export function foldState(height: number | undefined, line: number, open: boolean): FoldState {
  const long = height !== undefined && line > 0 && height > FOLD_LINES * line;
  return { long, maxHeight: long && !open ? FOLDED_LINES * line : null };
}

/** The set with `id` added, or removed when it is there. A new set, for React state. */
export function toggled(set: ReadonlySet<number>, id: number): ReadonlySet<number> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}
