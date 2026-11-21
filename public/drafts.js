// Unsent drafts kept on this device (ADR 0057). Pure functions only; app.js reads and writes
// localStorage. Nothing here goes to the server, and nothing here ever holds an access key.
//
// One stored value per workspace: `{ [markId(username, board)]: entry }`, least recently changed
// first, so the oldest drafts are dropped first. An entry is
// `{ content, recipient, replyTo, quote, files, retry, at }`:
// - `quote` is the part of the replyTo message the reply quotes (ADR 0059), or null.
// - `files` is only how many attachments the draft had. Files themselves are never stored.
// - `retry` is the uncertain send's `{ payload, key }`. Keeping it means a send retried after a
//   reload reuses the same Idempotency-Key when the payload is identical, so the server replays
//   it instead of posting it twice.

import { MAX_TO_TEXT_BYTES, parseNames, toField } from "./address.js";

/** Drafts kept per workspace on this device; the least recently changed go first. */
export const MAX_DRAFTS = 50;
/** The server's message limit. A longer draft cannot be sent, so it is kept in memory only. */
export const MAX_DRAFT_BYTES = 16384;
/** The To field's limit: up to 8 names, separated by commas (ADR 0067). */
export const MAX_RECIPIENT_BYTES = MAX_TO_TEXT_BYTES;
/** The server's quote limit (ADR 0059). */
export const MAX_QUOTE_BYTES = 2048;
/** A retry payload holds the text plus a few fields and at most 10 attachment references. */
const MAX_PAYLOAD_BYTES = 32768;
const KEY = /^[A-Za-z0-9_-]{1,128}$/;

const bytes = (text) => new TextEncoder().encode(text).length;

/** A draft worth keeping: it has text, an address, a reply target, files or a pending retry. */
export function hasContent(state) {
  return Boolean(
    state && (state.content || state.recipient || state.replyTo !== null || state.files > 0 || state.retry),
  );
}

function validEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { content, recipient, replyTo, files, retry, at } = value;
  // Drafts kept before ADR 0059 have no quote; a quote without a reply target means nothing.
  const quote = value.quote ?? null;
  if (quote !== null && (typeof quote !== "string" || !quote.trim() || bytes(quote) > MAX_QUOTE_BYTES))
    return null;
  if (typeof content !== "string" || bytes(content) > MAX_DRAFT_BYTES) return null;
  if (typeof recipient !== "string" || bytes(recipient) > MAX_RECIPIENT_BYTES) return null;
  if (replyTo !== null && !(Number.isSafeInteger(replyTo) && replyTo >= 1)) return null;
  if (!Number.isSafeInteger(files) || files < 0 || files > 10) return null;
  let keptRetry = null;
  if (retry !== null) {
    if (
      !retry ||
      typeof retry.payload !== "string" ||
      bytes(retry.payload) > MAX_PAYLOAD_BYTES ||
      typeof retry.key !== "string" ||
      !KEY.test(retry.key)
    )
      return null;
    keptRetry = { payload: retry.payload, key: retry.key };
  }
  const entry = {
    content,
    recipient,
    replyTo,
    quote: replyTo === null ? null : quote,
    files,
    retry: keptRetry,
    at: Number.isSafeInteger(at) ? at : 0,
  };
  return hasContent(entry) ? entry : null;
}

/** Parse a stored value; anything malformed is dropped, entry by entry. */
export function parseDrafts(text) {
  let data;
  try {
    data = JSON.parse(text ?? "null");
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const kept = {};
  for (const [key, value] of Object.entries(data)) {
    const entry = validEntry(value);
    if (entry) kept[key] = entry;
  }
  return trim(kept);
}

function trim(drafts) {
  const keys = Object.keys(drafts);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_DRAFTS))) delete drafts[old];
  return drafts;
}

/**
 * The stored value after one board's draft changed. `state` is the in-memory draft
 * (`files` is its array of File objects). An empty draft, or one too long to send, is removed.
 */
export function putDraft(drafts, key, state, now = Date.now()) {
  const next = { ...drafts };
  delete next[key];
  const entry = validEntry({
    content: state.content,
    recipient: state.recipient,
    replyTo: state.replyTo,
    quote: state.quote ?? null,
    files: Math.max(state.files?.length ?? 0, state.missingFiles ?? 0),
    retry: state.retry,
    at: now,
  });
  if (entry) next[key] = entry;
  return trim(next);
}

/** The in-memory draft fields for a stored entry. Files must be attached again. */
export function restoreDraft(entry) {
  return {
    content: entry.content,
    recipient: entry.recipient,
    replyTo: entry.replyTo,
    quote: entry.quote,
    files: [],
    missingFiles: entry.files,
    retry: entry.retry,
    sending: false,
  };
}

/** The stored entries that belong to `username`, as `[board, entry]` pairs. */
export function draftsFor(drafts, username) {
  const prefix = `${username}\n`;
  return Object.entries(drafts)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, entry]) => [key.slice(prefix.length), entry]);
}

/**
 * The attachments of a kept uncertain send, when the composer still holds the same message:
 * same name, text, To, reply target and quote. Files are not kept across a reload, but the uploads are
 * on the server already (keyed by content), so the send can be retried with its exact payload and
 * key instead of a new one without the files. Anything else returns null.
 */
export function unchangedRetryFiles(retry, { username, content, recipient, replyTo, quote = null }) {
  if (!retry) return null;
  let sent;
  try {
    sent = JSON.parse(retry.payload);
  } catch {
    return null;
  }
  if (!sent || !Array.isArray(sent.attachments) || !sent.attachments.length) return null;
  // The To field as the send wrote it (ADR 0067): one name as text, several as a list.
  const to = toField(parseNames(recipient));
  const same =
    sent.username === username &&
    sent.text === content &&
    JSON.stringify(sent.to) === JSON.stringify(to) &&
    (sent.replyTo ?? null) === replyTo &&
    (sent.quote ?? null) === quote;
  return same ? sent.attachments : null;
}
