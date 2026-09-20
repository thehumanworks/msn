import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { extractTaskActivity, parseTaskActivity } from "../src/core/taskActivity.ts";
import type { Message } from "../src/core/types.ts";

function msg(overrides: Partial<Message>): Message {
  return {
    id: 1,
    tenant: "acme",
    channel: "general",
    username: "tomas",
    text: "hello",
    contentType: "text/plain",
    createdAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

test("parses a well-formed msn.task.v1 open event", () => {
  const entry = parseTaskActivity(
    msg({
      contentType: "application/json",
      text: JSON.stringify({ schema: "msn.task.v1", task: "ship-it", action: "open", title: "Ship it", reviewer: "asha" }),
    }),
  );
  assert.ok(entry);
  assert.equal(entry?.body.task, "ship-it");
  assert.equal(entry?.body.action, "open");
  assert.equal(entry?.actor, "tomas");
});

test("rejects plain text messages", () => {
  assert.equal(parseTaskActivity(msg({})), null);
});

test("rejects an unknown schema version rather than guessing", () => {
  const entry = parseTaskActivity(
    msg({ contentType: "application/json", text: JSON.stringify({ schema: "msn.task.v2", task: "x", action: "open" }) }),
  );
  assert.equal(entry, null);
});

test("rejects malformed JSON without throwing", () => {
  assert.equal(parseTaskActivity(msg({ contentType: "application/json", text: "{not json" })), null);
});

test("rejects an unknown action", () => {
  const entry = parseTaskActivity(
    msg({ contentType: "application/json", text: JSON.stringify({ schema: "msn.task.v1", task: "x", action: "approve" }) }),
  );
  assert.equal(entry, null);
});

test("extractTaskActivity preserves log order and skips non-task messages", () => {
  const messages = [
    msg({ id: 1, text: "hi" }),
    msg({ id: 2, contentType: "application/json", text: JSON.stringify({ schema: "msn.task.v1", task: "a", action: "open", title: "A", reviewer: "r" }) }),
    msg({ id: 3, text: "unrelated" }),
    msg({ id: 4, contentType: "application/json", text: JSON.stringify({ schema: "msn.task.v1", task: "a", action: "claim" }) }),
  ];
  const entries = extractTaskActivity(messages);
  assert.deepEqual(entries.map((e) => e.messageId), [2, 4]);
});
