// Mention someone with @ (ADR 0055). Pure functions only: app.js owns the page. Typing @ in the
// message suggests the board's people; a pick puts @name in the text and, if the To field is
// empty, fills it. Later picks add their names to To while it holds only picked names (ADR 0067);
// a To typed by hand is left alone.

import { addressees, namesText, parseNames, sameName, withName } from "./address.js";

/** How many suggestions the list shows at most. `@channel` uses one of them (ADR 0086). */
export const MAX_SUGGESTIONS = 6;

const CHANNEL = "channel";
const OPENS = /[\s([{"'“‘*_~]/;
const WORD = /[\p{L}\p{N}_-]/u;

/** Shown when a send is refused for @channel. The server text is the one readers see. */
export function channelMentionNotice(error) {
  if (error?.code !== "channel_mention_limited" && error?.code !== "channel_mention_capped") return null;
  return (
    error.message ||
    (error.code === "channel_mention_limited"
      ? "@channel was used in the last minute. Only the owner can use it again that soon. Address someone by name, or wait."
      : "@channel can notify at most 32 people besides you. Address people by name.")
  );
}

/** The reserved @channel token, in any case. Not a person. */
export function isChannelMention(name) {
  return typeof name === "string" && name.trim().toLowerCase() === CHANNEL;
}
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
  if (start > 0 && !OPENS.test(before[start - 1])) return null;
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
    if (typeof name !== "string" || !name.trim() || name === me || seen.has(name) || isChannelMention(name))
      return;
    seen.add(name);
    out.push({ name, listening });
  };
  for (const persona of personas) if (persona?.listening) add(persona.displayName, true);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    add(messages[i]?.username);
    for (const name of addressees(messages[i])) add(name);
  }
  for (const persona of personas) add(persona?.displayName, Boolean(persona?.listening));
  // Last, so a bare @ lists people before the whole board. Typing "ch" still ranks it first (ADR 0086).
  return [...out, { name: CHANNEL, listening: false, everyone: true }];
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
  // @channel is expanded by the server. It must not land in To, which rejects that name.
  if (isChannelMention(name)) return { to, mentionTo };
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

/**
 * Splits `text` into runs, marking each whole @channel (any case). Matches the server's token
 * edges, including code spans and indented fences, so a highlight never shifts off the original
 * spelling. Callers that already skipped code nodes stay correct.
 */
export function splitChannelMentions(text) {
  const parts = [];
  if (typeof text !== "string" || !text) return [{ text: text ?? "", channel: false }];
  let index = 0;
  let last = 0;
  const push = (end, channel) => {
    if (end > last) parts.push({ text: text.slice(last, end), channel });
    last = end;
  };
  while (index < text.length) {
    if (index === 0 || text[index - 1] === "\n") {
      const fence = skipFence(text, index);
      if (fence !== null && fence > index) {
        index = fence;
        continue;
      }
    }
    if (text[index] === "`") {
      const span = skipCodeSpan(text, index);
      if (span !== null) {
        index = span;
        continue;
      }
    }
    if (text[index] === "@" && tokenAt(text, index)) {
      push(index, false);
      const end = index + 1 + CHANNEL.length;
      push(end, true);
      index = end;
      continue;
    }
    index += 1;
  }
  if (last < text.length) parts.push({ text: text.slice(last), channel: false });
  return parts.length ? parts : [{ text, channel: false }];
}

function skipFence(text, lineStart) {
  let index = lineStart;
  let indent = 0;
  while (text[index] === " " && indent < 4) {
    indent += 1;
    index += 1;
  }
  if (indent > 3) return null;
  const mark = text[index];
  if (mark !== "`" && mark !== "~") return null;
  let width = 0;
  while (text[index + width] === mark) width += 1;
  if (width < 3) return null;
  const infoEnd = text.indexOf("\n", index + width);
  const info = text.slice(index + width, infoEnd < 0 ? text.length : infoEnd);
  if (mark === "`" && info.includes("`")) return null;
  if (infoEnd < 0) return text.length;
  let line = infoEnd + 1;
  while (line < text.length) {
    let cursor = line;
    let closeIndent = 0;
    while (text[cursor] === " " && closeIndent < 4) {
      closeIndent += 1;
      cursor += 1;
    }
    if (closeIndent <= 3 && text[cursor] === mark) {
      let closeWidth = 0;
      while (text[cursor + closeWidth] === mark) closeWidth += 1;
      if (closeWidth >= width) {
        let rest = cursor + closeWidth;
        while (text[rest] === " " || text[rest] === "\t") rest += 1;
        if (text[rest] === "\n" || rest >= text.length) return text[rest] === "\n" ? rest + 1 : text.length;
      }
    }
    const next = text.indexOf("\n", line);
    if (next < 0) return text.length;
    line = next + 1;
  }
  return text.length;
}

function skipCodeSpan(text, index) {
  let width = 0;
  while (text[index + width] === "`") width += 1;
  if (!width) return null;
  let cursor = index + width;
  while (cursor < text.length) {
    if (text[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let run = 0;
    while (text[cursor + run] === "`") run += 1;
    if (run === width) return cursor + run;
    cursor += run;
  }
  return null;
}

function tokenEnds(text, end) {
  const mark = text[end];
  if (mark === undefined || !WORD.test(mark)) return true;
  if (mark !== "_" && mark !== "*" && mark !== "~") return false;
  const after = text[end + 1];
  return after === undefined || !WORD.test(after) || after === mark;
}

function tokenAt(text, index) {
  if (text.slice(index + 1, index + 1 + CHANNEL.length).toLowerCase() !== CHANNEL) return false;
  if (index > 0 && !OPENS.test(text[index - 1] ?? "")) return false;
  return tokenEnds(text, index + 1 + CHANNEL.length);
}

/** Wraps @channel in the rendered message. Skips code. No-op without a DOM. */
export function paintChannelMentions(root) {
  const doc = root?.ownerDocument;
  if (!doc?.createTreeWalker) return root;
  const showText = typeof NodeFilter === "undefined" ? 4 : NodeFilter.SHOW_TEXT;
  const walker = doc.createTreeWalker(root, showText);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest("code, pre, .md-code, .md-codeblock")) continue;
    if (splitChannelMentions(node.nodeValue ?? "").some((part) => part.channel)) nodes.push(node);
  }
  for (const node of nodes) {
    const frag = doc.createDocumentFragment();
    for (const part of splitChannelMentions(node.nodeValue ?? "")) {
      if (!part.channel) frag.append(doc.createTextNode(part.text));
      else {
        const span = doc.createElement("span");
        span.className = "at-channel";
        span.textContent = part.text;
        frag.append(span);
      }
    }
    node.parentNode.replaceChild(frag, node);
  }
  return root;
}
