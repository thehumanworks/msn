import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { READ_TICK, SENT_TICK, tickColor } from "../src/lib/tickColors.ts";

function contrast(hex: string, on: string): number {
  const lum = (value: string) => {
    const n = Number.parseInt(value.slice(1), 16);
    const channel = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const r = channel((n >> 16) & 255);
    const g = channel((n >> 8) & 255);
    const b = channel(n & 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const lighter = Math.max(lum(hex), lum(on));
  const darker = Math.min(lum(hex), lum(on));
  return (lighter + 0.05) / (darker + 0.05);
}

// Read on the system-blue outgoing bubble (ADR 0085). Delivered stays the one muted check.
test("given a read tick on the outgoing bubble, when the phone colours it, then it clears 3:1 and is not the sent grey", () => {
  assert.equal(tickColor("read"), READ_TICK);
  assert.equal(READ_TICK, "#E8F7FF");
  assert.equal(tickColor("muted"), SENT_TICK);
  assert.equal(SENT_TICK, "#E4EAF1");
  assert.notEqual(tickColor("read"), tickColor("muted"));
  assert.ok(contrast(READ_TICK, "#007AFF") >= 3);
  assert.ok(contrast(READ_TICK, "#0A84FF") >= 3);
  assert.ok(contrast(SENT_TICK, "#007AFF") >= 3);
  assert.ok(contrast(SENT_TICK, "#0A84FF") >= 3);
});

test("given the message bubble, when it paints ticks, then the tick predicate is separate from the mine side", () => {
  const source = readFileSync(new URL("../src/components/MessageBubble.tsx", import.meta.url), "utf8");
  const start = source.indexOf("export const MessageBubble");
  assert.ok(start >= 0);
  const fn = source.slice(start);
  assert.match(fn, /tickLayout\(ownBubble\(message, me\)/);
  assert.doesNotMatch(fn, /tickLayout\(mine/);
  assert.match(fn, /tickColor\(ticks\.tone\)/);
  assert.doesNotMatch(fn, /tickGlyph/);
  assert.doesNotMatch(source, /#A5EBFF/);
  const board = readFileSync(new URL("../src/app/board/[name].tsx", import.meta.url), "utf8");
  assert.match(board, /mine: message\.username === me && !message\.agentUserId/);
  assert.doesNotMatch(board, /sentByViewer|ownBubble/);
});
