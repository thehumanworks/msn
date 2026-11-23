import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TICK_OFFSET_PX, tickGlyph, tickLabel, tickLayout, tickOf } from "../public/ticks.js";

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
    assert.equal(tickGlyph(tick), item.glyph);
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

test("the web painter asks for ticks only on the signed-in sender's message", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const fn = app.slice(app.indexOf("function paintTicks"), app.indexOf("function applyAcks"));
  assert.match(fn, /tickLayout\(myMessage\(message\)/);
  assert.doesNotMatch(fn, /tickGlyph/);
});
