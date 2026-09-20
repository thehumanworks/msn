import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { createPendingSend, generateIdempotencyKey } from "../src/core/composer.ts";

test("generateIdempotencyKey matches the server's Idempotency-Key format", () => {
  assert.match(generateIdempotencyKey(), /^[A-Za-z0-9_-]{1,128}$/);
});

test("each new draft gets its own key and keeps its body", () => {
  const input = { username: "tomas", text: "hello" };
  const a = createPendingSend(input);
  const b = createPendingSend(input);
  assert.notEqual(a.key, b.key);
  assert.deepEqual(a.input, input);
});
