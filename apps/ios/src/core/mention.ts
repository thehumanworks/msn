// Mention someone with @ (ADR 0055). Pure rules, matching public/mention.js on the web and
// apps/desktop/src/mention.rs: which @ is being typed, who it suggests, and how a pick fills
// the To field. The first mention picked addresses the message; later picks only add @name.
import { addressees } from "./address.ts";
import type { Message } from "./types.ts";

/** How many suggestions the list shows at most. */
export const MAX_SUGGESTIONS = 6;

export type Person = { name: string; listening: boolean; everyone?: boolean };

const CHANNEL = "channel";

/** The reserved @channel token, in any case. Not a person (ADR 0086). */
export function isChannelMention(name: string): boolean {
  return name.trim().toLowerCase() === CHANNEL;
}
export type Persona = { displayName: string; listening: boolean };

const OPENS = /[\s([{"'“‘]/;

/**
 * The @ being typed at `caret`, or null. An @ counts at the start or after a space or an
 * opening bracket, so "a@b.c" never opens the list; a space in the query ends the mention.
 */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  if (!Number.isInteger(caret) || caret < 1 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0) return null;
  const query = before.slice(start + 1);
  if (/\s|@/.test(query) || query.length > 128) return null;
  if (start > 0 && !OPENS.test(before[start - 1] ?? "")) return null;
  return { start, query };
}

/** The board's personas from GET …/personas; anything malformed is skipped. */
export function decodePersonas(value: unknown): Persona[] {
  const list = (value as { personas?: unknown } | null)?.personas;
  if (!Array.isArray(list)) return [];
  const out: Persona[] = [];
  for (const item of list) {
    const name = (item as { displayName?: unknown } | null)?.displayName;
    if (typeof name === "string") out.push({ displayName: name, listening: (item as { listening?: unknown }).listening === true });
  }
  return out;
}

/**
 * Everyone who can be mentioned, best first and each name once: personas listening now, then
 * senders and recipients of loaded messages (newest first), then the other personas. `me` is
 * left out. `messages` are in board order (oldest first).
 */
export function people(personas: Persona[], messages: readonly Message[], me: string): Person[] {
  const seen = new Set<string>();
  const out: Person[] = [];
  const add = (name: string | undefined, listening = false) => {
    if (!name?.trim() || name === me || seen.has(name) || isChannelMention(name)) return;
    seen.add(name);
    out.push({ name, listening });
  };
  for (const persona of personas) if (persona.listening) add(persona.displayName, true);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    add(messages[i]?.username);
    const message = messages[i];
    if (message) for (const name of addressees(message)) add(name);
  }
  for (const persona of personas) add(persona.displayName, persona.listening);
  return [{ name: CHANNEL, listening: false, everyone: true }, ...out];
}

const WORD = /[\p{L}\p{N}_-]/u;

/** Splits `text` into runs, marking each whole @channel (any case). Code is split out by Markdown. */
export function splitChannelMentions(text: string): { text: string; channel: boolean }[] {
  const parts: { text: string; channel: boolean }[] = [];
  if (!text) return [{ text, channel: false }];
  const lower = text.toLowerCase();
  let from = 0;
  let last = 0;
  for (;;) {
    const at = lower.indexOf("@channel", from);
    if (at < 0) break;
    const end = text[at + CHANNEL.length + 1];
    const startOk = at === 0 || OPENS.test(text[at - 1] ?? "");
    const endOk = end === undefined || !WORD.test(end);
    if (startOk && endOk) {
      if (at > last) parts.push({ text: text.slice(last, at), channel: false });
      parts.push({ text: text.slice(at, at + CHANNEL.length + 1), channel: true });
      last = at + CHANNEL.length + 1;
    }
    from = at + 1;
  }
  if (last < text.length) parts.push({ text: text.slice(last), channel: false });
  return parts.length ? parts : [{ text, channel: false }];
}

/** Names that start with `query` first, then names that contain it, ignoring case. */
export function suggest(everyone: readonly Person[], query: string, limit = MAX_SUGGESTIONS): Person[] {
  const q = query.toLowerCase();
  const starts: Person[] = [];
  const contains: Person[] = [];
  for (const person of everyone) {
    const name = person.name.toLowerCase();
    if (name.startsWith(q)) starts.push(person);
    else if (q && name.includes(q)) contains.push(person);
  }
  return [...starts, ...contains].slice(0, limit);
}

/** Replaces the typed `@query` (from `start` to `caret`) with `@name` and one space. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const after = text.slice(caret).replace(/^ /, "");
  const mention = `@${name} `;
  return { text: text.slice(0, start) + mention + after, caret: start + mention.length };
}

/** Keep only picked names that still have a whole mention. One @ cannot address both "Jo" and "Jo Lee". */
export function keptMentions(text: string, picked: readonly string[]): string[] {
  if (!picked.length) return [];
  const longestFirst = picked.filter(Boolean).sort((a, b) => b.length - a.length);
  const found = new Set<string>();
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    if (at > 0 && !OPENS.test(text[at - 1] ?? "")) continue;
    for (const name of longestFirst) {
      if (!text.startsWith(name, at + 1)) continue;
      const next = text.codePointAt(at + 1 + name.length);
      if (next !== undefined && /[\p{L}\p{N}_-]/u.test(String.fromCodePoint(next))) continue;
      found.add(name);
      at += name.length;
      break;
    }
  }
  return picked.filter((name) => found.has(name));
}

export function hasMention(text: string, name: string): boolean {
  return keptMentions(text, [name]).length > 0;
}

/**
 * The @ the reader closed, after the caret moved: once no @ is being typed it is forgotten, so
 * typing @ again (even in the same place) opens the list again. -1 means none.
 */
export function nextDismissed(at: { start: number } | null, dismissed: number): number {
  return at === null ? -1 : dismissed;
}

export type Address = { to: string; mentionTo: string | null };

/** To after a pick: the picked name when To is empty; otherwise To stays. */
export function addressAfterPick(to: string, mentionTo: string | null, name: string): Address {
  if (isChannelMention(name)) return { to, mentionTo };
  return to.trim() ? { to, mentionTo } : { to: name, mentionTo: name };
}

/** To after the text changed: a picked name clears once its @name is gone; a typed To stays. */
export function addressAfterEdit(to: string, mentionTo: string | null, text: string): Address {
  if (!mentionTo || to !== mentionTo) return { to, mentionTo: null };
  return hasMention(text, mentionTo) ? { to, mentionTo } : { to: "", mentionTo: null };
}
