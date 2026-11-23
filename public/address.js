// Addressing a message to one or several names (ADR 0067). Pure functions only, shared by the
// web app, the since summary (also run by the Worker) and tests. A message has `to` (the first
// name) and, when it names more than one, `recipients` (every name, in order).

/** The most names one message can be addressed to; the server refuses more. */
export const MAX_RECIPIENTS = 8;

/** The longest To field text: MAX_RECIPIENTS names of 128 bytes, joined with ", ". */
export const MAX_TO_TEXT_BYTES = MAX_RECIPIENTS * 128 + (MAX_RECIPIENTS - 1) * 2;

/** Every name a message is addressed to: `recipients` when present, else `to` alone, else none. */
export function addressees(message) {
  const list = message?.recipients;
  if (Array.isArray(list) && list.length && list.every((name) => typeof name === "string")) return list;
  return typeof message?.to === "string" ? [message.to] : [];
}

/** The same name for addressing: trimmed and ignoring case, as unread counts and webhooks match. */
export function sameName(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return a === b || a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The sender, exactly. The server allows `/` in a username (`text()` only bounds the length),
 * so `me/worker` is a different person, not this viewer's worker (ADR 0085). A bound key
 * sends as its bound name, which is this same comparison.
 */
export function exactSender(username, me) {
  return typeof username === "string" && typeof me === "string" && me !== "" && username === me;
}

/** Ticks only. Not the check for edit, replace, claim, delete, or ack. */
export function sentByViewer(username, me) {
  return exactSender(username, me);
}

/** Whether `me` is one of the message's addressees, exactly or trimmed and ignoring case. */
export function isAddressedTo(me, message) {
  return addressees(message).some((name) => sameName(me, name));
}

/**
 * The names typed in a To field: split on commas, trimmed, blanks and repeats dropped (a repeat
 * is the same name trimmed and ignoring case; the first spelling stays).
 */
export function parseNames(value) {
  const names = [];
  for (const part of String(value ?? "").split(",")) {
    const name = part.trim();
    if (name && !names.some((kept) => sameName(kept, name))) names.push(name);
  }
  return names;
}

/**
 * Why the To field's names cannot be sent, or null when they can: at most MAX_RECIPIENTS names,
 * each at most 128 UTF-8 bytes, as the server checks.
 */
export function namesProblem(names) {
  if (names.length > MAX_RECIPIENTS)
    return `A message can go to at most ${MAX_RECIPIENTS} names; this one has ${names.length}.`;
  const long = names.find((name) => new TextEncoder().encode(name).length > 128);
  return long === undefined ? null : `Each name in To must be at most 128 UTF-8 bytes.`;
}

/** The `to` field of a send body: nothing, one name as text, or several as a list. */
export function toField(names) {
  if (!names.length) return undefined;
  return names.length === 1 ? names[0] : names;
}

/** A To field's text for a list of names. */
export function namesText(names) {
  return names.join(", ");
}

/** The names with `name` added at the end, unless it is already there. */
export function withName(names, name) {
  return names.some((kept) => sameName(kept, name)) ? names : [...names, name];
}
