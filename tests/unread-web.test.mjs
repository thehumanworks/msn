import assert from "node:assert/strict";
import { test } from "node:test";
import { markId } from "../public/since.js";
import { badge, currentEntry, UNREAD_BOARDS, unreadByBoard, unreadQuery } from "../public/unread.js";

// Unread counts on the web board list (ADR 0045): built from the read marks since-you-left keeps.

test("asks only for listed boards this reader has a mark on, most recent last", () => {
  const marks = {
    [markId("Tomas", "work")]: 12,
    [markId("someone", "work")]: 99,
    [markId("Tomas", "gone")]: 3,
    [markId("Tomas", "ops")]: 40,
  };
  const query = new URLSearchParams(unreadQuery(marks, "Tomas", ["ops", "work", "never-read"]));
  assert.equal(query.get("me"), "Tomas");
  assert.deepEqual(query.getAll("mark"), ["work:12", "ops:40"]);
  assert.equal(unreadQuery({}, "Tomas", ["work"]), null);
  assert.equal(unreadQuery(marks, "nobody", ["work"]), null);
});

test("keeps the most recently read boards when there are too many", () => {
  const marks = {};
  const names = [];
  for (let index = 0; index < UNREAD_BOARDS + 5; index += 1) {
    names.push(`b${index}`);
    marks[markId("Tomas", `b${index}`)] = index;
  }
  const pairs = new URLSearchParams(unreadQuery(marks, "Tomas", names)).getAll("mark");
  assert.equal(pairs.length, UNREAD_BOARDS);
  assert.equal(pairs[0], "b5:5");
  assert.equal(pairs.at(-1), `b${UNREAD_BOARDS + 4}:${UNREAD_BOARDS + 4}`);
});

test("drops answers for marks that moved and boards with nothing new", () => {
  const marks = { [markId("Tomas", "work")]: 12, [markId("Tomas", "ops")]: 50 };
  const counts = unreadByBoard(
    {
      unread: [
        { channel: "work", after: 12, count: 4, toYou: 1 },
        { channel: "ops", after: 40, count: 9, toYou: 0 },
        { channel: "quiet", after: 1, count: 0, toYou: 0 },
      ],
    },
    { ...marks, [markId("Tomas", "quiet")]: 1 },
    "Tomas",
  );
  assert.deepEqual([...counts.keys()], ["work"]);
  assert.deepEqual(currentEntry(counts, marks, "Tomas", "work"), {
    after: 12,
    count: 4,
    toYou: 1,
    capped: false,
  });
  // Reading the board moves its mark; the old count no longer applies.
  assert.equal(currentEntry(counts, { ...marks, [markId("Tomas", "work")]: 16 }, "Tomas", "work"), null);
});

test("badge text and spoken label", () => {
  assert.equal(badge(null), null);
  assert.equal(badge({ count: 0, toYou: 0 }), null);
  assert.deepEqual(badge({ count: 1, toYou: 0, capped: false }), {
    count: "1",
    toYou: null,
    label: "1 unread message",
  });
  assert.deepEqual(badge({ count: 99, toYou: 2, capped: true }), {
    count: "99+",
    toYou: "2",
    label: "99+ unread messages, 2 to you",
  });
});
