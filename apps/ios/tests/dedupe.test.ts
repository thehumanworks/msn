import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { BoundedIdSet } from "../src/core/dedupe.ts";

test("BoundedIdSet reports duplicates and new ids", () => {
  const set = new BoundedIdSet(10);
  assert.equal(set.add(1), true);
  assert.equal(set.add(1), false);
  assert.equal(set.has(1), true);
  assert.equal(set.has(2), false);
});

test("BoundedIdSet evicts the oldest id once capacity is exceeded", () => {
  const set = new BoundedIdSet(3);
  set.add(1);
  set.add(2);
  set.add(3);
  set.add(4); // evicts 1
  assert.equal(set.has(1), false);
  assert.equal(set.has(2), true);
  assert.equal(set.has(4), true);
  assert.equal(set.size, 3);
});

test("BoundedIdSet rejects a non-positive capacity", () => {
  assert.throws(() => new BoundedIdSet(0));
});
