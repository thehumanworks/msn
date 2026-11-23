import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ownBubble, TICK_OFFSET_PX, tickAttrs, tickLabel, tickLayout, tickOf } from "../public/ticks.js";

// Delivery ticks on the bubble (ADR 0083).
// I1 another participant's message, even fully read, draws no ticks.
// I2 the sender's delivered or partial message draws one muted check.
// I3 the sender's read message draws two checks, the second a few px over, in the read tone.
// I4 the sender's pending or unaddressed message draws nothing.
// The web painter passes myMessage into that layout.

const cases = JSON.parse(readFileSync(new URL("./fixtures/tick-cases.json", import.meta.url), "utf8"));

test("given the shared delivery rows, when folded, then the mark matches", () => {
  for (const item of cases) {
    const tick = tickOf(item.rows);
    assert.equal(tick, item.tick);
    assert.equal(tickLabel(item.rows), item.label);
  }
});

const read = [{ name: "dev", deliveredAt: "2026-11-23T14:02:00.000Z", readAt: "2026-11-23T14:03:00.000Z" }];
const delivered = [{ name: "dev", deliveredAt: "2026-11-23T14:02:00.000Z", readAt: null }];
const pending = [{ name: "dev", deliveredAt: null, readAt: null }];
const partial = [
  { name: "dev", deliveredAt: "2026-11-23T14:02:00.000Z", readAt: null },
  { name: "ada", deliveredAt: null, readAt: null },
];

test("given someone else's read message, when the bubble is marked, then it draws no ticks", () => {
  const shown = tickLayout(false, read);
  assert.equal(shown.marks, 0);
  assert.deepEqual(shown.offsets, []);
  assert.equal(shown.tick, "none");
});

test("given the sender's delivered or partial message, when the bubble is marked, then one muted check is drawn", () => {
  for (const rows of [delivered, partial]) {
    const shown = tickLayout(true, rows);
    assert.equal(shown.marks, 1);
    assert.equal(shown.tone, "muted");
    assert.deepEqual(shown.offsets, [0]);
  }
});

test("given the sender's read message, when the bubble is marked, then two checks overlap by a few px in the read tone", () => {
  const shown = tickLayout(true, read);
  assert.equal(shown.tick, "read");
  assert.equal(shown.marks, 2);
  assert.equal(shown.tone, "read");
  assert.deepEqual(shown.offsets, [0, TICK_OFFSET_PX]);
  assert.ok(TICK_OFFSET_PX >= 2 && TICK_OFFSET_PX <= 6);
});

test("given the sender's pending or unaddressed message, when the bubble is marked, then nothing is drawn", () => {
  assert.equal(tickLayout(true, pending).marks, 0);
  assert.equal(tickLayout(true, null).marks, 0);
  assert.equal(tickLayout(true, []).marks, 0);
});

test("given a bound name, when the bubble is the viewer's, then read ticks are an image and a slash name is not", () => {
  const message = { username: "Ada", delivery: read };
  assert.equal(ownBubble(message, "Ada"), true);
  assert.equal(ownBubble({ username: "Ada/worker", delivery: read }, "Ada"), false);
  assert.equal(ownBubble({ username: "Ada/worker", delivery: read }, "Ada/worker"), true);
  assert.equal(ownBubble({ ...message, agentUserId: "agent-1" }, "Ada"), false);
  assert.equal(ownBubble({ username: "Bob", delivery: read }, "Ada"), false);
  assert.equal(tickAttrs({ username: "Ada/worker", delivery: read }, "Ada"), null);
  const shown = tickAttrs(message, "Ada");
  assert.equal(shown.role, "img");
  assert.equal(shown.className, "ticks read");
  assert.deepEqual(shown.offsets, [0, TICK_OFFSET_PX]);
  assert.equal(shown.offset, TICK_OFFSET_PX);
  assert.equal(shown.label, "dev read");
  assert.equal(tickAttrs({ username: "Bob", delivery: read }, "Ada"), null);
  assert.equal(tickAttrs({ username: "Ada", delivery: delivered }, "Ada").className, "ticks");
  assert.equal(tickAttrs({ username: "Ada", delivery: delivered }, "Ada").offsets.length, 1);
});

test("the web painter names the ticks as an image and sets the shared offset", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function paintTicks");
  const end = app.indexOf("\nfunction ", start + 1);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const fn = app.slice(start, end);
  assert.match(fn, /setAttribute\("role", shown\.role\)/);
  assert.match(fn, /tickAttrs\(/);
  assert.match(fn, /setProperty\("--tick-offset"/);
  assert.doesNotMatch(fn, /tickGlyph/);
  const canEdit = app.slice(
    app.indexOf("function canEdit"),
    app.indexOf("\nfunction ", app.indexOf("function canEdit") + 1),
  );
  assert.match(canEdit, /exactSender\(/);
  assert.doesNotMatch(canEdit, /sentByViewer|ownBubble/);
  const mine = app.slice(
    app.indexOf("function myMessage"),
    app.indexOf("\nfunction ", app.indexOf("function myMessage") + 1),
  );
  assert.match(mine, /return ownBubble\(/);
  assert.doesNotMatch(mine, /exactSender|sentByViewer/);
  const edit = app.slice(
    app.indexOf("function showEdit"),
    app.indexOf("\nfunction ", app.indexOf("function showEdit") + 1),
  );
  assert.ok(edit.includes(":scope > .message-stamp"));
  assert.doesNotMatch(app, /\.message-meta > time/);
  const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  assert.match(css, /\.ticks:has\(\.tick-mark \+ \.tick-mark\)/);
  assert.doesNotMatch(css, /\.ticks\.read\s*\{[^}]*width/);
  assert.doesNotMatch(css, /\.message-meta > time/);
  assert.match(css, /\.message-meta \.message-stamp \{[^}]*font-family:\s*inherit/);
  const transcript = readFileSync(new URL("../public/transcript.js", import.meta.url), "utf8");
  assert.doesNotMatch(transcript, /message-stamp/);
  assert.match(css, new RegExp(`--tick-offset:\\s*${TICK_OFFSET_PX}px`));
  assert.match(css, /var\(--tick-offset\)/);
  assert.match(css, /gap:\s*var\(--tick-gap\)/);
  assert.doesNotMatch(css, /\.ticks:empty/);
  assert.doesNotMatch(css, /margin-left:\s*-5px/);
  assert.doesNotMatch(css, /\.tick-mark\s*\{[^}]*font-family:\s*inherit/);
});
