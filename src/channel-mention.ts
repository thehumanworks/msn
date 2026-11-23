// @channel (ADR 0086). Pure rules: where the token is, who it expands to, and when an agent
// may send another one. The Durable Object applies them inside the send transaction.

/** How many people besides the sender one @channel may name. Past this the send is refused. */
export const CHANNEL_MENTION_CAP = 32;
/** An agent may not send @channel when any @channel was stored in this window. */
export const CHANNEL_MENTION_WINDOW_MS = 60_000;
/** Recent messages inspected for that window. A busier minute can hide an older mention. */
export const CHANNEL_MENTION_LOOKBACK = 200;

const TOKEN = "channel";
const OPENS = /[\s([{"'“‘]/;
const WORD = /[\p{L}\p{N}_-]/u;

export function foldName(name: string): string {
  return name.trim().toLowerCase();
}

/** The reserved display name, in any case. Not a person. */
export function isChannelName(name: string): boolean {
  return foldName(name) === TOKEN;
}

function atLineStart(text: string, index: number): boolean {
  return index === 0 || text[index - 1] === "\n";
}

/** Index just after a fenced code block that opens at `index`, or null when this is not one. */
function skipFence(text: string, index: number): number | null {
  if (!atLineStart(text, index)) return null;
  const mark = text[index];
  if (mark !== "`" && mark !== "~") return null;
  let width = 0;
  while (text[index + width] === mark) width += 1;
  if (width < 3) return null;
  const opener = text.indexOf("\n", index + width);
  if (opener < 0) return text.length;
  const close = mark.repeat(width);
  let line = opener + 1;
  while (line < text.length) {
    if (text.startsWith(close, line)) {
      const end = text.indexOf("\n", line + width);
      return end < 0 ? text.length : end + 1;
    }
    const next = text.indexOf("\n", line);
    if (next < 0) return text.length;
    line = next + 1;
  }
  return text.length;
}

/**
 * True when `text` has @channel outside fenced or inline code. Case does not matter.
 * The @ must start a token (start of text, or after whitespace or an opening bracket), and
 * the name must end there: @channeling and a@channel are not it. Same edges as ADR 0055.
 */
export function mentionsChannel(text: string): boolean {
  if (typeof text !== "string" || !text.toLowerCase().includes("@channel")) return false;
  let index = 0;
  while (index < text.length) {
    if (text[index] === "`" || text[index] === "~") {
      const fence = skipFence(text, index);
      if (fence !== null) {
        index = fence;
        continue;
      }
    }
    if (text[index] === "`") {
      const close = text.indexOf("`", index + 1);
      index = close < 0 ? index + 1 : close + 1;
      continue;
    }
    if (text[index] === "@" && tokenAt(text, index)) return true;
    index += 1;
  }
  return false;
}

function tokenAt(text: string, index: number): boolean {
  if (text.slice(index + 1, index + 1 + TOKEN.length).toLowerCase() !== TOKEN) return false;
  if (index > 0 && !OPENS.test(text[index - 1] ?? "")) return false;
  const end = text[index + 1 + TOKEN.length];
  return end === undefined || !WORD.test(end);
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

/** A persona, a hosted agent, or GitHub. People are not limited. */
export function automatedSender(sender: {
  username: string;
  personaId?: string | null;
  agentUserId?: string | null;
}): boolean {
  return Boolean(sender.personaId) || Boolean(sender.agentUserId) || sender.username === "github";
}

/**
 * Agents (and GitHub) may not post @channel while any @channel from this window is still in
 * `recent`. A person is never limited. `now` and `createdAt` are milliseconds and ISO time.
 */
export function channelMentionLimited(
  automated: boolean,
  recent: readonly { text: string; createdAt: string }[],
  now: number,
): boolean {
  if (!automated) return false;
  return recent.some((row) => {
    const at = Date.parse(row.createdAt);
    return Number.isFinite(at) && now - at < CHANNEL_MENTION_WINDOW_MS && mentionsChannel(row.text);
  });
}
