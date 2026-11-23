import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TICK_OFFSET_PX, tickFrame, tickLabel, tickLayout, tickOf } from "../src/core/ticks.ts";

// Delivery ticks on the bubble (ADR 0083).
// I1 another participant's message, even fully read, draws no ticks -> only the sender
// I2 the sender's delivered or partial message draws one muted check -> one muted check
// I3 the sender's read message draws two checks, the second a few px over, in the read tone -> two overlapping checks
// I4 the sender's pending or unaddressed message draws nothing -> nothing yet
// The row paints that layout only for `own`.

const cases = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/tick-cases.json", import.meta.url), "utf8"),
) as { rows: Parameters<typeof tickOf>[0]; tick: string; glyph: string; label: string }[];

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

test("given two checks, when the frame is sized, then the rotated second check stays inside and a one-check box does not", () => {
  const frame = tickFrame(11, 2);
  const rotW = (frame.markW + frame.markH) * Math.SQRT1_2;
  const firstLeft = frame.overhang + frame.markW / 2 - rotW / 2;
  const secondRight = frame.overhang + TICK_OFFSET_PX + frame.markW / 2 + rotW / 2;
  assert.ok(firstLeft >= -1e-9, `first check starts at ${firstLeft}`);
  assert.ok(secondRight <= frame.width + 1e-9, `second check ends at ${secondRight}, box is ${frame.width}`);
  const single = tickFrame(11, 1);
  assert.ok(secondRight > single.width);
  assert.ok(frame.bottom + frame.markH / 2 + rotW / 2 <= frame.height + 1e-9);
});

test("the message row asks the tick predicate, and the accent clears 3:1 on the outgoing bubble", () => {
  const source = readFileSync(new URL("../src/components/MessageRow.tsx", import.meta.url), "utf8");
  assert.match(source, /tickLayout\(me !== undefined && sentByViewer/);
  assert.doesNotMatch(source, /tickGlyph/);
  const channel = readFileSync(new URL("../src/screens/ChannelScreen.tsx", import.meta.url), "utf8");
  assert.match(channel, /onEditMessage=\{!archived && exactSender\(item\.username, me\)/);
  assert.doesNotMatch(channel, /sentByViewer/);
  const theme = readFileSync(new URL("../src/components/theme.ts", import.meta.url), "utf8");
  const accent = /accent: "(#[0-9a-f]{6})"/i.exec(theme)?.[1];
  const own = /own: "(#[0-9a-f]{6})"/i.exec(theme)?.[1];
  assert.ok(accent && own);
  const linear = (hex: string) => {
    const v = Number.parseInt(hex.slice(1), 16);
    const rgb = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    return rgb.map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
  };
  const lum = (hex: string) => {
    const [r, g, b] = linear(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (lum(accent) + 0.05) / (lum(own) + 0.05);
  assert.ok(ratio >= 3, `${accent} on ${own} is ${ratio.toFixed(2)}`);
});
