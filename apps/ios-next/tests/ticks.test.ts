import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { READ_TICK, SENT_TICK, tickColor } from "../src/lib/tickColors.ts";

// Phone tick colour (ADR 0084). Read is WhatsApp blue, and it is not the muted sent grey.
test("given a read tick, when the phone colours it, then it is WhatsApp blue and not the sent grey", () => {
  assert.equal(tickColor("read"), "#53bdeb");
  assert.equal(READ_TICK, "#53bdeb");
  assert.equal(tickColor("muted"), SENT_TICK);
  assert.equal(SENT_TICK, "#E4EAF1");
  assert.notEqual(tickColor("read"), tickColor("muted"));
});

test("given the message bubble, when it paints ticks, then only the sender's message gets the phone colour", () => {
  const source = readFileSync(new URL("../src/components/MessageBubble.tsx", import.meta.url), "utf8");
  const start = source.indexOf("export const MessageBubble");
  assert.ok(start >= 0);
  const fn = source.slice(start);
  assert.match(fn, /tickLayout\(mine,/);
  assert.match(fn, /tickColor\(ticks\.tone\)/);
  assert.doesNotMatch(fn, /tickGlyph/);
  assert.doesNotMatch(source, /#A5EBFF/);
});
