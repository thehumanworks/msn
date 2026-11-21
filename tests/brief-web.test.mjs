import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRIEF_MAX_BYTES,
  briefBytes,
  briefCount,
  briefLabel,
  briefNotice,
  closedKey,
  startsOpen,
} from "../public/brief.js";

// The web side of the board brief (ADR 0074).

test("counts UTF-8 bytes, as the server does", () => {
  assert.equal(BRIEF_MAX_BYTES, 4096);
  assert.equal(briefBytes("abc"), 3);
  assert.equal(briefBytes("é€😀"), 2 + 3 + 4);
  assert.deepEqual(briefCount(""), { bytes: 0, over: false, text: "0 of 4,096 bytes" });
  assert.deepEqual(briefCount("x".repeat(4096)), { bytes: 4096, over: false, text: "4,096 of 4,096 bytes" });
  assert.equal(briefCount("é".repeat(2049)).over, true);
});

test("describes a brief change in plain words and ignores everything else", () => {
  assert.equal(
    briefNotice({ schema: "msn.brief.v1", version: 3, cleared: false, bytes: 10, updatedBy: "human" }),
    "human changed the board's brief (version 3). Everyone sees it at the top of the board, and agents get it when they start.",
  );
  assert.equal(
    briefNotice({ schema: "msn.brief.v1", version: 4, cleared: true, bytes: 0 }),
    "The owner removed the board's brief.",
  );
  for (const data of [
    null,
    "text",
    { schema: "msn.board.v1", version: 1 },
    { schema: "msn.brief.v1" },
    { schema: "msn.brief.v1", version: 0 },
    { schema: "msn.brief.v1", version: "2" },
  ])
    assert.equal(briefNotice(data), null);
});

test("labels a version with who wrote it and when", () => {
  const brief = { version: 2, updatedBy: "human", updatedAt: "2026-11-21T17:08:00.000Z" };
  assert.equal(briefLabel(brief), "Version 2 · human · 2026-11-21T17:08:00.000Z");
  assert.equal(
    briefLabel({ ...brief, updatedBy: undefined }, () => "today"),
    "Version 2 · today",
  );
});

test("a folded brief stays folded only until a newer version", () => {
  assert.equal(closedKey("https://a", "t", "work"), "msn.brief.closed:https://a:t:work");
  assert.equal(startsOpen(null, 1), true);
  assert.equal(startsOpen("1", 1), false);
  assert.equal(startsOpen("1", 2), true);
  assert.equal(startsOpen("junk", 2), true);
});
