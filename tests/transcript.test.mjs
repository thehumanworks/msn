// Markdown transcript (ADR 0048). The fixture file is shared with cli/src/transcript.rs, which
// must produce exactly the same text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fence, inline, renderTranscript, size, utc } from "../public/transcript.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/transcript-cases.json", import.meta.url), "utf8"));

for (const { name, meta, messages, expected } of cases) {
  test(`fixture: ${name}`, () => assert.equal(renderTranscript(meta, messages), expected));
}

test("a fence is longer than every backtick run in the text", () => {
  assert.equal(fence("a", "text"), "```text\na\n```");
  assert.equal(fence("x ``` y\n````", "text"), "`````text\nx ``` y\n````\n`````");
  assert.equal(fence("", "text"), "```text\n```");
  assert.equal(fence("a\r\nb\rc", "text"), "```text\na\nb\nc\n```");
});

test("sizes round in integers, like the CLI", () => {
  assert.equal(size(0), "0 B");
  assert.equal(size(1023), "1023 B");
  assert.equal(size(1024), "1.0 KiB");
  assert.equal(size(1280), "1.3 KiB");
  assert.equal(size(1024 * 1024), "1.0 MiB");
});

test("utc accepts only ISO instants", () => {
  assert.equal(utc("2026-11-20T17:04:05.123Z"), "2026-11-20 17:04:05 UTC");
  assert.equal(utc("2026-11-20T17:04:05Z"), "2026-11-20 17:04:05 UTC");
  assert.equal(utc("not <a> date"), "not \\<a\\> date");
  assert.equal(utc("2026-11-20T17:04:05.Z"), "2026-11-20T17:04:05.Z");
});

test("inline text never holds a line break or bidi control", () => {
  assert.equal(inline("a\nb c‮d"), "a�b�c�d");
});

/** Every line that a CommonMark renderer could read as a fence for the given message. */
function fenceLines(markdown) {
  return markdown.split("\n").filter((line) => /^ {0,3}(`{3,}|~{3,})/.test(line));
}

test("hostile message text stays inside exactly one code block", () => {
  const hostile = ["```", "````\n```", "`".repeat(40), "~~~\n# x", "a\n```\n<!--", "\r```\r"];
  for (const text of hostile) {
    const doc = renderTranscript(
      { origin: "https://x", tenant: "t", channel: "c", exportedAt: "2026-01-01T00:00:00Z" },
      [{ id: 1, username: "u", text, contentType: "text/plain", createdAt: "2026-01-01T00:00:00Z" }],
    );
    const body = doc.slice(doc.indexOf("### #1"));
    const lines = fenceLines(body);
    const open = lines[0];
    const marks = /^`+/.exec(open)[0];
    // The only line that can close the block is the one the renderer wrote after the text.
    const closers = body
      .split("\n")
      .filter((line) => line.trim() === marks || (line.startsWith(marks) && /^`+\s*$/.test(line)));
    assert.equal(closers.length, 1, JSON.stringify(text));
    assert.ok(body.trimEnd().endsWith(marks), JSON.stringify(text));
  }
});
