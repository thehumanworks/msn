import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  conflictText,
  groupTasks,
  parseJson,
  projectTasks,
  scanTasks,
  skippedCount,
  stateText,
} from "../public/tasks.js";

// The parity corpus (ADR 0070): expected boards come from cli/src/tasks.rs. See tests/task-fixtures.mjs.
const corpusPath =
  process.env.MSN_TASK_FIXTURES ?? new URL("./fixtures/task-projection.json", import.meta.url);
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

test("the web reducer projects every corpus case exactly like the Rust reducer", () => {
  assert.ok(corpus.cases.length >= 100);
  let tasks = 0;
  for (const item of corpus.cases) {
    assert.ok(item.expected, `${item.name} has no expected board: regenerate the corpus`);
    assert.deepEqual(projectTasks(item.messages), item.expected, item.name);
    tasks += item.expected.tasks.length;
  }
  assert.ok(tasks > 200);
});

const event = (id, username, body, extra = {}) => ({
  id,
  tenant: "acme",
  channel: "work",
  username,
  contentType: "application/json",
  text: JSON.stringify({ schema: "msn.task.v1", ...body }),
  ...extra,
});

test("a claimed, readied and closed task moves through the sections", () => {
  const log = [
    event(1, "alice", { task: "spec", action: "open", title: "Write the spec", reviewer: "bob" }),
    event(2, "carol", { task: "spec", action: "claim" }),
    { id: 3, tenant: "acme", channel: "work", username: "carol", contentType: "text/plain", text: "spec.md" },
    event(4, "alice", {
      task: "build",
      action: "open",
      title: "Build it",
      reviewer: "bob",
      dependsOn: ["spec"],
    }),
  ];
  let board = projectTasks(log);
  assert.deepEqual(
    groupTasks(board.tasks).map((s) => [s.key, s.tasks.map((t) => t.id)]),
    [
      ["blocked", ["build"]],
      ["claimed", ["spec"]],
    ],
  );
  assert.equal(stateText(board.tasks[0]), "Claimed");
  board = projectTasks([
    ...log,
    event(5, "carol", { task: "spec", action: "ready", evidence: [3] }),
    event(6, "bob", { task: "spec", action: "close" }),
  ]);
  const sections = groupTasks(board.tasks);
  assert.deepEqual(
    sections.map((s) => [s.key, s.tasks.map((t) => t.id)]),
    [
      ["open", ["build"]],
      ["closed", ["spec"]],
    ],
  );
  assert.deepEqual(board.tasks[0].messageIds, [1, 2, 5, 6]);
  assert.equal(stateText(board.tasks[1]), "Open");
});

test("conflicts read in plain words, and unknown codes show as they are", () => {
  assert.equal(conflictText("claim-conflict"), "claimed by more than one person");
  assert.equal(conflictText("something-new"), "something-new");
});

test("JSON parsing follows serde_json where JavaScript differs", () => {
  assert.equal(parseJson("[1.0]")[0].raw, "1.0");
  assert.throws(() => parseJson("[1e999]"), SyntaxError);
  assert.throws(() => parseJson('"\\ud800"'), SyntaxError);
  assert.doesNotThrow(() => parseJson(`${"[".repeat(127)}${"]".repeat(127)}`));
  assert.throws(() => parseJson(`${"[".repeat(128)}${"]".repeat(128)}`), SyntaxError);
  assert.deepEqual(parseJson('{"a":1,"a":"x"}'), { a: "x" });
  assert.throws(() => parseJson("{} x"), SyntaxError);
  // A float evidence id is not an id, as in serde_json's as_u64.
  const board = projectTasks([
    event(1, "a", { task: "t", action: "open", title: "T", reviewer: "b", owner: "a" }),
    { id: 2, username: "a", contentType: "text/plain", text: "x" },
    {
      id: 3,
      username: "a",
      contentType: "application/json",
      text: '{"schema":"msn.task.v1","task":"t","action":"ready","evidence":[2.0]}',
    },
  ]);
  assert.equal(board.tasks[0].state, "open");
  assert.equal(board.warnings[0].code, "malformed-event");
});

/** A fake /catchup over `rows`, `pageSize` rows a page; `revisions` gives each call's revision. */
function fakeApi(rows, { pageSize = 2, revisions = () => 1 } = {}) {
  let calls = 0;
  const api = async (path) => {
    const url = new URL(path, "https://x");
    const after = Number(url.searchParams.get("after"));
    const limit = Math.min(pageSize, Number(url.searchParams.get("limit")));
    const page = rows.filter((row) => row.id > after).slice(0, limit);
    const head = rows.at(-1)?.id ?? 0;
    return {
      messages: page,
      nextCursor: page.at(-1)?.id ?? after,
      hasMore: page.length > 0 && page.at(-1).id < head,
      headCursor: head,
      historyRevision: revisions(calls++),
    };
  };
  return { api, calls: () => calls };
}

test("the scan reads every page from the start, then checks the revision once more", async () => {
  const rows = [
    event(1, "alice", { task: "t1", action: "open", title: "One", reviewer: "bob" }),
    event(2, "alice", { task: "t2", action: "open", title: "Two", reviewer: "bob" }),
    event(3, "carol", { task: "t1", action: "claim" }),
    event(4, "alice", { task: "t3", action: "open", title: "Three", reviewer: "bob" }),
    event(5, "alice", { task: "t4", action: "open", title: "Four", reviewer: "bob" }),
  ];
  const fake = fakeApi(rows);
  const seen = [];
  const board = await scanTasks(fake.api, { tenant: "acme", channel: "work", progress: (n) => seen.push(n) });
  assert.deepEqual(
    board.tasks.map((t) => [t.id, t.owner]),
    [
      ["t1", "carol"],
      ["t2", null],
      ["t3", null],
      ["t4", null],
    ],
  );
  assert.deepEqual(seen, [2, 4, 5]);
  assert.equal(fake.calls(), 4);
  assert.equal(board.messages, 5);
});

test("the scan refuses a board when history changes, or rows belong elsewhere", async () => {
  const rows = [1, 2, 3].map((id) =>
    event(id, "a", { task: `t${id}`, action: "open", title: "T", reviewer: "b" }),
  );
  await assert.rejects(
    scanTasks(fakeApi(rows, { revisions: (n) => (n < 1 ? 1 : 2) }).api, { tenant: "acme", channel: "work" }),
    /history changed/,
  );
  await assert.rejects(
    scanTasks(fakeApi(rows, { revisions: (n) => (n < 2 ? 1 : 2) }).api, { tenant: "acme", channel: "work" }),
    /history changed/,
  );
  await assert.rejects(scanTasks(fakeApi(rows).api, { tenant: "acme", channel: "other" }), /out of order/);
  assert.equal(
    await scanTasks(fakeApi(rows).api, { tenant: "acme", channel: "work", current: () => false }),
    null,
  );
});

test("a page with a missing or odd cursor field fails closed instead of showing an empty board", async () => {
  const rows = [event(1, "a", { task: "t1", action: "open", title: "T", reviewer: "b" })];
  for (const broken of [
    { headCursor: undefined },
    { historyRevision: "1" },
    { nextCursor: 1.5 },
    { hasMore: "no" },
    { messages: null },
  ]) {
    const fake = fakeApi(rows);
    const api = async (path) => ({ ...(await fake.api(path)), ...broken });
    await assert.rejects(scanTasks(api, { tenant: "acme", channel: "work" }), /malformed/);
  }
});

test("skipped task messages count each message once, without deleted rows or missing evidence", () => {
  assert.equal(
    skippedCount([
      { code: "deleted-or-redacted", messageId: 4 },
      { code: "unknown-evidence", messageId: 9, task: "t" },
      { code: "unauthorized", messageId: 5 },
      { code: "malformed-event", messageId: 5 },
      { code: "malformed-event", messageId: null },
    ]),
    2,
  );
});
