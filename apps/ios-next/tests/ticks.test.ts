import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The bubble paints the shared layout only for the sender (ADR 0083).
test("given the message bubble, when it paints ticks, then only the sender's message gets them", () => {
  const source = readFileSync(new URL("../src/components/MessageBubble.tsx", import.meta.url), "utf8");
  assert.match(source, /tickLayout\(mine,/);
  assert.match(source, /tone === "read" \? READ_TICK : SENT_TICK/);
  assert.doesNotMatch(source, /tickGlyph/);
});
