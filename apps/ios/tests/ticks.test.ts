import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tickGlyph, tickLabel, tickOf } from "../src/core/ticks.ts";

const cases = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/tick-cases.json", import.meta.url), "utf8"),
) as { rows: Parameters<typeof tickOf>[0]; tick: string; glyph: string; label: string }[];

test("given the shared delivery rows, when folded, then the mark matches", () => {
  for (const item of cases) {
    const tick = tickOf(item.rows);
    assert.equal(tick, item.tick);
    assert.equal(tickGlyph(tick), item.glyph);
    assert.equal(tickLabel(item.rows), item.label);
  }
});
