// Quote a message in a reply (ADR 0059). Pure functions only: app.js owns the page, the
// selection and the composer. A quote is plain text; the server keeps it with the reply.

/** The server's quote limit, in UTF-8 bytes. */
export const MAX_QUOTE_BYTES = 2048;

const bytes = (text) => new TextEncoder().encode(text).length;

/**
 * The quote to send for `text` (a selection or a whole message): trailing spaces and blank lines
 * at either end go, and runs of blank lines become one. Text over the limit is cut at a character
 * boundary and ends with "…". Returns null when nothing is left to quote.
 */
export function quoteOf(text) {
  if (typeof text !== "string") return null;
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  const kept = [];
  for (const line of lines) if (line || (kept.length && kept[kept.length - 1])) kept.push(line);
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  let quote = kept.join("\n");
  if (!quote.trim()) return null;
  if (bytes(quote) <= MAX_QUOTE_BYTES) return quote;
  const chars = [...quote];
  let size = bytes("…");
  let end = 0;
  while (end < chars.length && size + bytes(chars[end]) <= MAX_QUOTE_BYTES) size += bytes(chars[end++]);
  quote = `${chars.slice(0, end).join("").trimEnd()}…`;
  return quote;
}

/** One short line for the composer's "Quoting" note. */
export function quotePreview(quote, max = 80) {
  const line = String(quote ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : line;
}
