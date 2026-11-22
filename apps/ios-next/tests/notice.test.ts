import assert from "node:assert/strict";
import { test } from "node:test";
import { boardNotice } from "../src/lib/notice.ts";

const json = (data: unknown) => ({ username: "board", contentType: "application/json", text: JSON.stringify(data) });

test("brief changes and removals read as a plain line", () => {
  assert.equal(
    boardNotice(json({ schema: "msn.brief.v1", version: 2, cleared: false, updatedBy: "tomas" })),
    "tomas changed the board's brief (version 2).",
  );
  assert.equal(boardNotice(json({ schema: "msn.brief.v1", version: 3, cleared: true })), "The owner removed the board's brief.");
});

test("goal changes read as a plain line", () => {
  assert.equal(boardNotice(json({ schema: "msn.board.v1", goal: "Ship it", status: "paused" })), "Goal paused: Ship it");
  assert.equal(boardNotice(json({ schema: "msn.board.v1", goal: "Ship it", status: "weird" })), null);
});

test("anything else is not a notice", () => {
  assert.equal(boardNotice({ username: "lead", contentType: "text/plain", text: "hi" }), null);
  assert.equal(boardNotice({ username: "lead", contentType: "application/json", text: "not json" }), null);
  assert.equal(boardNotice(json({ schema: "msn.brief.v1", version: 0 })), null);
  assert.equal(boardNotice(json([1, 2])), null);
});
