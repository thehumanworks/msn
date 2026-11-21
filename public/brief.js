// The board brief (ADR 0074): the owner's standing instructions, shown as the board's header.
// Pure helpers, shared by the page and its unit tests.

/** The longest brief in UTF-8 bytes; the server checks again. */
export const BRIEF_MAX_BYTES = 4096;

export function briefBytes(text) {
  return new TextEncoder().encode(text).length;
}

/** "1,204 of 4,096 bytes", and whether the text is too long to save. */
export function briefCount(text) {
  const bytes = briefBytes(text);
  return {
    bytes,
    over: bytes > BRIEF_MAX_BYTES,
    text: `${bytes.toLocaleString("en-US")} of ${BRIEF_MAX_BYTES.toLocaleString("en-US")} bytes`,
  };
}

/** The line a brief change shows in the log, or null when `data` is no brief notice. */
export function briefNotice(data) {
  if (data?.schema !== "msn.brief.v1" || !Number.isSafeInteger(data.version) || data.version < 1) return null;
  const who = typeof data.updatedBy === "string" && data.updatedBy ? data.updatedBy : "The owner";
  return data.cleared === true
    ? `${who} removed the board's brief.`
    : `${who} changed the board's brief (version ${data.version}). Everyone sees it at the top of the board, and agents get it when they start.`;
}

/** "Version 3 · human · 21 Nov 2026, 17:08", for the header and the list of earlier versions. */
export function briefLabel(brief, format = (iso) => iso) {
  return [`Version ${brief.version}`, brief.updatedBy, format(brief.updatedAt)].filter(Boolean).join(" · ");
}

const CLOSED = "msn.brief.closed";

/** localStorage key under which a person's folded brief is remembered, per board. */
export function closedKey(origin, tenant, channel) {
  return `${CLOSED}:${origin}:${tenant}:${channel}`;
}

/** A folded brief stays folded until the owner writes a newer version. */
export function startsOpen(closedVersion, version) {
  return Number(closedVersion) !== version;
}
