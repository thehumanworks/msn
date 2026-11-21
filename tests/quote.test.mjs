import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_QUOTE_BYTES, quoteOf, quotePreview } from "../public/quote.js";

// Quote a message in a reply (ADR 0059): what the web composer sends as `quote`.

const bytes = (text) => new TextEncoder().encode(text).length;

test("a selection is tidied at its edges and keeps its inner lines", () => {
  assert.equal(quoteOf("  Ship it.  \r\n\r\n\r\nThen tag.\n\n"), "  Ship it.\n\nThen tag.");
  assert.equal(quoteOf("\n\nfirst\nsecond"), "first\nsecond");
  assert.equal(quoteOf("one"), "one");
});

test("nothing to quote gives null", () => {
  for (const blank of ["", " ", "\n\n", " \t\n ", null, undefined, 7]) assert.equal(quoteOf(blank), null);
});

test("a long message is cut to the server's limit at a character boundary, with an ellipsis", () => {
  const ascii = quoteOf("x".repeat(5000));
  assert.ok(ascii.endsWith("…"));
  assert.ok(bytes(ascii) <= MAX_QUOTE_BYTES);
  assert.ok(bytes(ascii) > MAX_QUOTE_BYTES - 4);
  // Four-byte characters are never split.
  const emoji = quoteOf("🙂".repeat(1000));
  assert.ok(bytes(emoji) <= MAX_QUOTE_BYTES);
  assert.equal(
    [...emoji.slice(0, -1)].every((char) => char === "🙂"),
    true,
  );
  // Exactly at the limit is kept whole.
  assert.equal(quoteOf("y".repeat(MAX_QUOTE_BYTES)), "y".repeat(MAX_QUOTE_BYTES));
});

test("the composer preview is one short line", () => {
  assert.equal(quotePreview("a\n\n  b"), "a b");
  const long = quotePreview("word ".repeat(40), 20);
  assert.equal([...long].length, 20);
  assert.ok(long.endsWith("…"));
});
