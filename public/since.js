// "Since you last looked": a short list of what happened on a board while you were away.
// Pure functions only. Built from the board's own messages (task events, board updates, messages
// to you); no model calls and no server state. The last-read position stays on this device.

import { addressees } from "./address.js";

/** At most this many pages of 100 messages are read when a board opens. */
export const SINCE_PAGES = 3;
/** Rows shown before "and N more". */
export const SINCE_ITEMS = 8;
/** Boards remembered per workspace on this device; the oldest marks are dropped first. */
export const MAX_MARKS = 200;

const STATUSES = ["active", "paused", "complete", "blocked"];
const TASK_VERBS = {
  open: "opened",
  claim: "claimed",
  ready: "marked ready",
  close: "closed",
  cancel: "cancelled",
  block: "blocked",
};

function excerpt(value, limit = 120) {
  const flat = String(value).replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Recipient names are matched the way people type them: spaces trimmed, case ignored. */
function normalize(name) {
  return String(name).trim().toLowerCase();
}

function json(message) {
  if (message.contentType !== "application/json") return null;
  try {
    const data = JSON.parse(message.text);
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/** The local key for one reader's position on one board. */
export function markId(username, channel) {
  return `${username}\n${channel}`;
}

/** Parse a stored mark map; anything malformed reads as empty. */
export function parseMarks(text) {
  try {
    const data = JSON.parse(text ?? "null");
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data).filter(([, id]) => Number.isSafeInteger(id) && id >= 0));
  } catch {
    return {};
  }
}

/** Move a mark forward only; the most recently moved mark is kept last so the oldest is dropped. */
export function advance(marks, key, id) {
  if (!Number.isSafeInteger(id) || (marks[key] ?? -1) >= id) return null;
  const next = { ...marks };
  delete next[key];
  next[key] = id;
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_MARKS))) delete next[old];
  return next;
}

/**
 * Summarise messages newer than `after` for the reader `me`.
 * Message text is untrusted: the result is plain text for textContent, never markup.
 * Your own messages are left out: by name, trimmed with case ignored, or by your persona id.
 *
 * @param {Array<Record<string, any>>} messages
 * @param {{after: number, me: string, personaId?: string | null, truncated?: boolean}} options
 */
export function summarize(messages, { after, me, personaId = null, truncated = false }) {
  const self = normalize(me);
  const isMe = (name) => typeof name === "string" && normalize(name) === self;
  const fresh = messages.filter((m) => Number.isSafeInteger(m.id) && m.id > after);
  // Your own messages: by name (trimmed, any case, as recipients are matched) or by your persona.
  const others = fresh.filter((m) => !isMe(m.username) && !(personaId && m.personaId === personaId));
  const titles = new Map();
  for (const message of fresh) {
    const data = json(message);
    if (data?.schema === "msn.task.v1" && data.action === "open" && typeof data.task === "string")
      if (typeof data.title === "string" && data.title.trim()) titles.set(data.task, excerpt(data.title, 64));
  }
  const task = (slug) => titles.get(slug) ?? excerpt(slug, 64);
  const items = [];
  for (const message of others) {
    const who = excerpt(message.username, 40);
    const data = json(message);
    const add = (kind, text, attention = false) => items.push({ id: message.id, kind, text, attention });
    if (data?.schema === "msn.task.v1" && typeof data.task === "string") {
      const reason =
        typeof data.reason === "string" && data.reason.trim() ? `: ${excerpt(data.reason, 80)}` : "";
      if (data.action === "assign" && typeof data.owner === "string")
        add(
          "task",
          isMe(data.owner)
            ? `${who} assigned you ${task(data.task)}`
            : `${who} assigned ${task(data.task)} to ${excerpt(data.owner, 40)}`,
          isMe(data.owner),
        );
      else if (TASK_VERBS[data.action])
        add(
          "task",
          `${who} ${TASK_VERBS[data.action]} ${task(data.task)}${data.action === "block" ? reason : ""}`,
          data.action === "block",
        );
      continue;
    }
    if (data?.schema === "msn.board.v1" && STATUSES.includes(data.status)) {
      add("board", `${who} set the board to ${data.status}`, data.status === "blocked");
      continue;
    }
    if (data?.schema === "msn.host.status.v1" && data.status === "failed") {
      const reason =
        typeof data.reason === "string" && data.reason.trim() ? `: ${excerpt(data.reason, 80)}` : "";
      add("failed", `A job failed for ${who}${reason}`, true);
      continue;
    }
    if (addressees(message).some(isMe)) add("question", `${who} to you: “${excerpt(message.text)}”`, true);
  }
  // What needs you first, then everything else in board order.
  const ordered = [...items.filter((i) => i.attention), ...items.filter((i) => !i.attention)];
  const authors = [...new Set(others.map((m) => m.username))];
  return {
    count: others.length,
    truncated,
    authors,
    firstId: fresh[0]?.id ?? null,
    items: ordered.slice(0, SINCE_ITEMS),
    hidden: Math.max(0, ordered.length - SINCE_ITEMS),
  };
}

/** One line for the panel heading. */
export function headline(summary) {
  const count = `${summary.count}${summary.truncated ? "+" : ""}`;
  const noun = summary.count === 1 && !summary.truncated ? "new message" : "new messages";
  const names = summary.authors.map((name) => excerpt(name, 40));
  const from =
    names.length === 0
      ? ""
      : names.length <= 2
        ? ` from ${names.join(" and ")}`
        : ` from ${names.slice(0, 2).join(", ")} and ${names.length - 2} other${names.length === 3 ? "" : "s"}`;
  return `Since you last looked: ${count} ${noun}${from}`;
}
