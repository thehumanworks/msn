// @channel (ADR 0086). Pure rules: where the token is, who it expands to, and when a non-owner
// may send another one. The Durable Object applies them inside the send transaction.

/**
 * How many people besides the sender one @channel may name. Past this the send is refused.
 * Stays at or under `MAX_PENDING_NOTICES` (src/webhook.ts) so one mention can queue a notice
 * for every expanded persona. The test `fan-out` asserts that bound.
 */
export const CHANNEL_MENTION_CAP = 32;
/** A non-owner may not send @channel while a flagged mention from this window is still stored. */
export const CHANNEL_MENTION_WINDOW_MS = 60_000;

const TOKEN = "channel";
/** Whitespace, opening brackets and quotes, and emphasis markers. Same set the clients use. */
const OPENS = /[\s([{"'“‘*_~]/;
const WORD = /[\p{L}\p{N}_-]/u;

export const CHANNEL_MENTION_LIMITED =
  "@channel was used in the last minute. Only the owner can use it again that soon, and a person's mention counts too, so replies do not wake the whole board. Address someone by name, or wait.";

export function channelMentionCapped(count: number): string {
  return `@channel can notify at most ${CHANNEL_MENTION_CAP} people besides you. This board has ${count}. Address people by name.`;
}

export function foldName(name: string): string {
  return name.trim().toLowerCase();
}

/** The reserved display name, in any case. Not a person. */
export function isChannelName(name: string): boolean {
  return foldName(name) === TOKEN;
}

/**
 * Index just after a fenced code block that opens at the start of the line `lineStart`, or null.
 * CommonMark: 0–3 spaces of indent, a fence of three or more backticks or tildes, a closing fence
 * at least that long with the same indent rule. A backtick fence whose info string contains a
 * backtick is not a fence. An unclosed fence runs to the end of the text.
 */
function skipFence(text: string, lineStart: number): number | null {
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

/** Index just after a CommonMark code span opened at `index`, or null when the run is unclosed. */
function skipCodeSpan(text: string, index: number): number | null {
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

/** The name ends at the token, or at an emphasis mark that does not continue into a word (`_@channel_`). */
function tokenEnds(text: string, end: number): boolean {
  const mark = text[end];
  if (mark === undefined || !WORD.test(mark)) return true;
  if (mark !== "_" && mark !== "*" && mark !== "~") return false;
  const after = text[end + 1];
  return after === undefined || !WORD.test(after) || after === mark;
}

function tokenAt(text: string, index: number): boolean {
  if (text.slice(index + 1, index + 1 + TOKEN.length).toLowerCase() !== TOKEN) return false;
  if (index > 0 && !OPENS.test(text[index - 1] ?? "")) return false;
  return tokenEnds(text, index + 1 + TOKEN.length);
}

/**
 * True when `text` has @channel outside fenced or inline code. Case does not matter.
 * The @ must start a token (start of text, or after whitespace, an opening bracket, a quote,
 * or an emphasis marker `*_~`), and the name must end there. `@channeling` and `a@channel` are not it.
 */
export function mentionsChannel(text: string): boolean {
  if (typeof text !== "string" || !/@channel/i.test(text)) return false;
  let index = 0;
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
    if (text[index] === "@" && tokenAt(text, index)) return true;
    index += 1;
  }
  return false;
}

/**
 * Member names, then any explicit names, each once, sender left out, the token itself left out.
 * Order is the order given. The caller caps the length.
 */
export function expandChannelRecipients(
  members: readonly string[],
  sender: string,
  explicit: readonly string[] = [],
): string[] {
  const senderKey = foldName(sender);
  const seen = new Set<string>();
  const names: string[] = [];
  const add = (name: string) => {
    const trimmed = name.trim();
    const key = foldName(trimmed);
    if (!key || key === TOKEN || key === senderKey || seen.has(key)) return;
    seen.add(key);
    names.push(trimmed);
  };
  for (const name of members) add(name);
  for (const name of explicit) add(name);
  return names;
}

/** A non-owner is limited while any flagged mention in the window is still stored. The owner is not. */
export function channelMentionLimited(owner: boolean, recent: boolean): boolean {
  return !owner && recent;
}
