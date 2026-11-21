import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, headline, MAX_MARKS, markId, parseMarks, SINCE_ITEMS, summarize } from "../public/since.js";

let next = 10;
const text = (username, body, extra = {}) => ({
  id: next++,
  username,
  text: body,
  contentType: "text/plain",
  ...extra,
});
const typed = (username, data) => ({
  id: next++,
  username,
  text: JSON.stringify(data),
  contentType: "application/json",
});
const task = (action, slug, extra = {}) => ({ schema: "msn.task.v1", action, task: slug, ...extra });

test("lists task, board and question events from others, what needs you first", () => {
  next = 10;
  const messages = [
    text("lead", "already read"),
    typed("lead", task("open", "auth", { title: "Fix login", reviewer: "Tomas" })),
    typed("worker", task("claim", "auth")),
    text("worker", "Which region?", { to: "Tomas" }),
    typed("worker", task("block", "auth", { reason: "needs a  key" })),
    typed("lead", { schema: "msn.board.v1", goal: "Ship", status: "paused" }),
    typed("worker", task("close", "auth")),
    typed("lead", task("assign", "docs", { owner: "Tomas" })),
    text("Tomas", "my own note", { to: "Tomas" }),
    typed("Tomas", task("claim", "mine")),
    text("worker", "plain chatter"),
  ];
  const summary = summarize(messages, { after: 10, me: "Tomas" });
  assert.equal(summary.count, 8);
  assert.equal(summary.firstId, 11);
  assert.deepEqual(summary.authors, ["lead", "worker"]);
  assert.deepEqual(
    summary.items.map((i) => i.text),
    [
      "worker to you: “Which region?”",
      "worker blocked Fix login: needs a key",
      "lead assigned you docs",
      "lead opened Fix login",
      "worker claimed Fix login",
      "lead set the board to paused",
      "worker closed Fix login",
    ],
  );
  assert.equal(headline(summary), "Since you last looked: 8 new messages from lead and worker");
});

test("untrusted text stays text, unknown schemas and malformed JSON are plain messages", () => {
  next = 1;
  const messages = [
    { id: next++, username: "x", text: "{not json", contentType: "application/json" },
    typed("x", { schema: "msn.task.v2", action: "close", task: "a" }),
    typed("x", task("explode", "a")),
    typed("x", { schema: "msn.board.v1", status: "on-fire", goal: "g" }),
    typed("x", { schema: "msn.host.status.v1", status: "failed", reason: "<img src=x>" }),
  ];
  const summary = summarize(messages, { after: 0, me: "Tomas" });
  assert.equal(summary.count, 5);
  assert.deepEqual(
    summary.items.map((i) => i.text),
    ["A job failed for x: <img src=x>"],
  );
});

test("caps the list and reports truncation in the headline", () => {
  next = 1;
  const messages = Array.from({ length: SINCE_ITEMS + 3 }, (_, i) =>
    typed(`a${i % 4}`, task("claim", `t${i}`)),
  );
  const summary = summarize(messages, { after: 0, me: "Tomas", truncated: true });
  assert.equal(summary.items.length, SINCE_ITEMS);
  assert.equal(summary.hidden, 3);
  assert.equal(headline(summary), "Since you last looked: 11+ new messages from a0, a1 and 2 others");
  assert.equal(
    headline(summarize([text("solo", "hi")], { after: 0, me: "Tomas" })),
    "Since you last looked: 1 new message from solo",
  );
});

test("own messages alone are nothing new", () => {
  next = 1;
  const summary = summarize([text("Tomas", "hello")], { after: 0, me: "Tomas" });
  assert.equal(summary.count, 0);
  assert.equal(summary.items.length, 0);
});

test("marks only move forward, survive bad storage, and stay bounded", () => {
  assert.deepEqual(parseMarks("garbage"), {});
  assert.deepEqual(parseMarks('{"a":3,"b":-1,"c":"4","d":1.5}'), { a: 3 });
  const key = markId("Tomas", "work");
  let marks = advance({}, key, 5);
  assert.deepEqual(marks, { [key]: 5 });
  assert.equal(advance(marks, key, 5), null);
  assert.equal(advance(marks, key, 4), null);
  assert.equal(advance(marks, key, null), null);
  marks = {};
  for (let i = 0; i < MAX_MARKS + 5; i++) marks = advance(marks, `k${i}`, 1);
  assert.equal(Object.keys(marks).length, MAX_MARKS);
  assert.equal(marks.k0, undefined);
  // Moving an old mark makes it the newest, so it is kept.
  marks = advance(marks, "k5", 2);
  marks = advance(marks, "new", 1);
  assert.equal(marks.k5, 2);
  assert.equal(marks.k6, undefined);
});

test("messages and tasks for you match your name with spaces trimmed and case ignored", () => {
  next = 1;
  const messages = [
    text("lead", "Which region?", { to: "  tomas " }),
    typed("lead", task("assign", "docs", { owner: "TOMAS" })),
    text("lead", "not for you", { to: "Tomasz" }),
  ];
  const summary = summarize(messages, { after: 0, me: "Tomas" });
  assert.deepEqual(
    summary.items.map((i) => i.text),
    ["lead to you: “Which region?”", "lead assigned you docs"],
  );
});

test("your own messages are left out by name in any case, or by your persona id", () => {
  const messages = [
    { id: 1, username: " tomas ", text: "mine", contentType: "text/plain" },
    { id: 2, username: "renamed", personaId: "p1", text: "also mine", contentType: "text/plain" },
    { id: 3, username: "lead", text: "theirs", contentType: "text/plain" },
  ];
  const summary = summarize(messages, { after: 0, me: "Tomas", personaId: "p1" });
  assert.equal(summary.count, 1);
  assert.deepEqual(summary.authors, ["lead"]);
});
