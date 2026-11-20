// Unread counts on the board list (ADR 0045). Pure functions only. The read marks are the ones
// "since you last looked" (ADR 0033) already keeps on this device; the server only counts what
// is above each mark and keeps no read state.

import { markId } from "./since.js";

/** Boards per request, matching the server's limit. */
export const UNREAD_BOARDS = 100;
/** Refresh the counts at most this often while a board is polling and the page is visible. */
export const UNREAD_REFRESH_MS = 60_000;

/**
 * The query for the boards in `names` that have a read mark for `username`. Boards without a mark
 * were never read on this device and get no count. When there are more than UNREAD_BOARDS, the
 * most recently read boards win (marks are kept in the order they last moved).
 */
export function unreadQuery(marks, username, names) {
  const listed = new Set(names);
  const pairs = [];
  for (const [key, id] of Object.entries(marks ?? {})) {
    const split = key.indexOf("\n");
    if (split < 0 || key.slice(0, split) !== username) continue;
    const name = key.slice(split + 1);
    if (listed.has(name) && Number.isSafeInteger(id) && id >= 0) pairs.push([name, id]);
  }
  const chosen = pairs.slice(-UNREAD_BOARDS);
  if (!chosen.length) return null;
  const params = new URLSearchParams({ me: username });
  for (const [name, id] of chosen) params.append("mark", `${name}:${id}`);
  return params.toString();
}

/**
 * The counts to show, keyed by board. An answer is dropped when the mark has moved since the
 * request went out: the reader has seen more than it counted.
 */
export function unreadByBoard(response, marks, username) {
  const result = new Map();
  for (const entry of response?.unread ?? []) {
    if (marks?.[markId(username, entry.channel)] !== entry.after) continue;
    if (!entry.count) continue;
    result.set(entry.channel, {
      after: entry.after,
      count: entry.count,
      toYou: entry.toYou ?? 0,
      capped: entry.capped === true,
    });
  }
  return result;
}

/** The count for one board, or null once its mark has moved past what was counted. */
export function currentEntry(counts, marks, username, name) {
  const entry = counts?.get(name);
  return entry && marks?.[markId(username, name)] === entry.after ? entry : null;
}

/** Badge text and an accessible label, or null for nothing unread. */
export function badge(entry) {
  if (!entry?.count) return null;
  const count = `${entry.count}${entry.capped ? "+" : ""}`;
  const noun = entry.count === 1 && !entry.capped ? "unread message" : "unread messages";
  const label = entry.toYou ? `${count} ${noun}, ${entry.toYou} to you` : `${count} ${noun}`;
  return { count, toYou: entry.toYou ? String(entry.toYou) : null, label };
}
