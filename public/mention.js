// Mention someone with @ (ADR 0055). Pure functions only: app.js owns the page. Typing @ in the
// message suggests the board's people; a pick puts @name in the text and, if the To field is
// empty, fills it. Later picks add their names to To while it holds only picked names (ADR 0067);
// a To typed by hand is left alone.

import { addressees, namesText, parseNames, sameName, withName } from "./address.js";

/** How many suggestions the list shows at most. */
export const MAX_SUGGESTIONS = 6;
/** Picks add names to To up to the server's limit (ADR 0067). */
const MAX_PICKED = 8;

/**
 * The @ being typed at `caret`, or null. An @ counts at the start of the text or after a space
 * or an opening bracket, so "a@b.c" never opens the list. The query runs from the @ to the caret
 * and holds no white space: a space (or a new line) ends the mention and closes the list.
 * Returns `{ start, query }`, where `start` is the index of the @.
 */
export function mentionAt(text, caret) {
  if (typeof text !== "string" || !Number.isInteger(caret) || caret < 1 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0) return null;
  const query = before.slice(start + 1);
  if (/\s|@/.test(query) || query.length > 128) return null;
  if (start > 0 && !/[\s([{"'“‘]/.test(before[start - 1])) return null;
  return { start, query };
}

/**
 * Everyone who can be mentioned, best first and each name once: personas listening now, then
 * people and agents who sent or were sent recent messages (newest first), then the board's other
 * personas. `me` is left out. `messages` are in board order (oldest first).
 * Returns `[{ name, listening }]`.
 */
export function people({ personas = [], messages = [], me = "" } = {}) {
  const seen = new Set();
  const out = [];
  const add = (name, listening = false) => {
    if (typeof name !== "string" || !name.trim() || name === me || seen.has(name)) return;
    seen.add(name);
    out.push({ name, listening });
  };
  for (const persona of personas) if (persona?.listening) add(persona.displayName, true);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    add(messages[i]?.username);
    for (const name of addressees(messages[i])) add(name);
  }
  for (const persona of personas) add(persona?.displayName, Boolean(persona?.listening));
  return out;
}

/**
 * The suggestions for `query`: names that start with it first, then names that contain it,
 * ignoring case; each group keeps the order of `everyone`. At most `limit`.
 */
export function suggest(everyone, query, limit = MAX_SUGGESTIONS) {
  const q = String(query ?? "").toLowerCase();
  const starts = [];
  const contains = [];
  for (const person of everyone) {
    const name = person.name.toLowerCase();
    if (name.startsWith(q)) starts.push(person);
    else if (q && name.includes(q)) contains.push(person);
  }
  return [...starts, ...contains].slice(0, limit);
}

/**
 * Replaces the typed `@query` (from `start` to `caret`) with `@name` and one space.
 * Returns `{ text, caret }` with the caret after the space.
 */
export function insertMention(text, start, caret, name) {
  const after = text.slice(caret);
  const mention = `@${name}${after.startsWith(" ") ? "" : " "}`;
  const next = text.slice(0, start) + mention + after;
  return { text: next, caret: start + mention.length + (after.startsWith(" ") ? 1 : 0) };
}

/** True when `text` still holds `@name` as a whole mention. */
export function hasMention(text, name) {
  if (!name) return false;
  const token = `@${name}`;
  let from = 0;
  for (;;) {
    const at = text.indexOf(token, from);
    if (at < 0) return false;
    const end = text[at + token.length];
    const startOk = at === 0 || /[\s([{"'“‘]/.test(text[at - 1]);
    const endOk = end === undefined || !/[\p{L}\p{N}_-]/u.test(end);
    if (startOk && endOk) return true;
    from = at + 1;
  }
}

/**
 * The To field after a pick (ADR 0055, ADR 0067). An empty To becomes the picked name. A To that
 * holds only names earlier picks put there gains the picked name too (up to 8), so "@lead @worker"
 * goes to both. A To typed by hand is never touched.
 * Returns `{ to, mentionTo }`: `mentionTo` is the To text picks made (or the old one).
 */
export function addressAfterPick(to, mentionTo, name) {
  if (!to.trim()) return { to: name, mentionTo: name };
  if (!mentionTo || to !== mentionTo) return { to, mentionTo };
  const names = parseNames(to);
  if (names.length >= MAX_PICKED && !names.some((kept) => sameName(kept, name))) return { to, mentionTo };
  const next = namesText(withName(names, name));
  return { to: next, mentionTo: next };
}

/**
 * The To field after the text changed: a name a pick put in To is taken out again once its @name
 * is gone from the text. A name typed into To by hand is never touched.
 */
export function addressAfterEdit(to, mentionTo, text) {
  if (!mentionTo || to !== mentionTo) return { to, mentionTo: null };
  const kept = parseNames(to).filter((name) => hasMention(text, name));
  const next = namesText(kept);
  return { to: next, mentionTo: next || null };
}
