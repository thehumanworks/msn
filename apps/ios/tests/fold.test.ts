import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { FOLD_LINES, FOLDED_LINES, foldState, toggled } from "../src/core/fold.ts";

test("a body taller than FOLD_LINES lines folds to FOLDED_LINES until it is opened", () => {
  const line = 20;
  assert.deepEqual(foldState(undefined, line, false), { long: false, maxHeight: null });
  assert.deepEqual(foldState(FOLD_LINES * line, line, false), { long: false, maxHeight: null });
  assert.deepEqual(foldState(FOLD_LINES * line + 1, line, false), { long: true, maxHeight: FOLDED_LINES * line });
  assert.deepEqual(foldState(4000, line, true), { long: true, maxHeight: null });
  assert.deepEqual(foldState(4000, 0, false), { long: false, maxHeight: null });
});

test("toggled adds or removes an id and never changes the old set", () => {
  const empty: ReadonlySet<number> = new Set();
  const one = toggled(empty, 7);
  assert.deepEqual([...one], [7]);
  assert.deepEqual([...empty], []);
  assert.deepEqual([...toggled(one, 7)], []);
});
