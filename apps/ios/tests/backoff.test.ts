import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { backoffDelayMs } from "../src/core/backoff.ts";

test("backoffDelayMs grows exponentially and is capped", () => {
  const random = () => 1; // full jitter ceiling
  assert.equal(backoffDelayMs(0, { baseMs: 100, factor: 2, maxMs: 10_000, random }), 100);
  assert.equal(backoffDelayMs(1, { baseMs: 100, factor: 2, maxMs: 10_000, random }), 200);
  assert.equal(backoffDelayMs(2, { baseMs: 100, factor: 2, maxMs: 10_000, random }), 400);
  assert.equal(backoffDelayMs(10, { baseMs: 100, factor: 2, maxMs: 10_000, random }), 10_000);
});

test("backoffDelayMs never returns a negative attempt's delay above base", () => {
  const random = () => 1;
  assert.equal(backoffDelayMs(-5, { baseMs: 50, random }), 50);
});

test("backoffDelayMs jitters between 0 and the cap", () => {
  const random = () => 0.5;
  assert.equal(backoffDelayMs(0, { baseMs: 1000, random }), 500);
});
