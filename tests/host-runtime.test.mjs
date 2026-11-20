import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RECOVERY_GRACE_MS } from "../scripts/host/protocol.mjs";
import { HostRuntime, Pulse } from "../scripts/host/runtime.mjs";
import { validateHostPage } from "../scripts/host/transport.mjs";
import { hostFixture } from "./support/host-fixture.mjs";

test("single-slot host coordinates two different harness executables without coordinator or polling", async (t) => {
  const f = await hostFixture(t, { maxConcurrent: 1, pythonBob: true });
  f.post({ to: "alice", text: "coordinate" });
  await f.message((m) => m.to === "human" && m.text === "completed");
  const records = await f.records();
  assert.deepEqual(
    records.map((r) => r.who),
    ["alice", "bob", "alice"],
  );
  assert.equal(records[1].harness, "python");
  assert.equal(records[2].input.trigger.resumed, true);
  assert.equal(records[2].input.state.turns, 1);
  assert.equal(records[0].permission, "yolo");
  assert.equal(records[0].admin, false);
  assert.equal(records[0].other, false);
  assert.ok(f.logs.some((e) => e.type === "turn.completed" && e.suspended));
  assert.equal(f.status().failures.length, 0);
});
test("one-slot host delivers a durable budget continuation to a real executable, which finishes without polling", async (t) => {
  const f = await hostFixture(t, { maxConcurrent: 1, softTurnsPerConversation: 2 });
  f.post({ to: "alice", text: "coordinate" });
  await f.message((m) => m.to === "human" && m.text === "completed");
  await f.message((m) => m.to === "human" && m.text === "budget:2");
  const records = await f.records();
  const budget = records.filter((r) => r.input.trigger.type === "coordination.budget");
  assert.equal(budget.length, 1);
  assert.equal(
    budget[0].who,
    "alice",
    "the human-triggered turn is not counted; bob's request and alice's reply cross the milestone",
  );
  assert.equal(budget[0].input.conversationId, records[0].input.conversationId);
  assert.deepEqual(
    [budget[0].input.trigger.softBudget, budget[0].input.trigger.hardLimit, budget[0].input.message],
    [2, 64, null],
  );
  assert.equal(records.filter((r) => r.input.trigger.type === "message").length, 3);
  assert.equal(f.messages.filter((m) => m.text.startsWith("budget:")).length, 1);
  assert.equal(f.status().failures.length, 0);
});
test("hung peer cannot block ingestion/execution of another peer; later input still runs", async (t) => {
  const f = await hostFixture(t, { timeoutMs: 500, maxConcurrent: 2 });
  f.post({ to: "alice", text: "hang" });
  await f.log((e) => e.type === "turn.started" && e.agent === "alice");
  f.post({ to: "bob", text: "fast" });
  f.post({ to: "alice", text: "next" });
  await f.message((m) => m.to === "human" && m.text === "done:fast");
  assert.ok(!f.logs.some((e) => e.type === "turn.failed" && e.agent === "alice"));
  const failed = await f.log((e) => e.type === "turn.failed" && e.agent === "alice");
  assert.equal(failed.reason, "handler_timeout");
  await f.message((m) => m.to === "human" && m.text === "done:next");
  assert.equal(f.status().failures.length, 1);
  await f.message(
    (m) => m.contentType === "application/json" && JSON.parse(m.text).schema === "msn.host.status.v1",
  );
});
test("timeoutMs null runs a turn past the finite default, bounds its lease and still stops cleanly", async (t) => {
  const f = await hostFixture(t, { timeoutMs: null, maxConcurrent: 2 });
  f.post({ to: "alice", text: "slow" });
  const started = await f.log((e) => e.type === "turn.started" && e.agent === "alice");
  const jobRow = (id) => {
    const db = new DatabaseSync(join(f.config.stateDir, "state.sqlite"), { readOnly: true });
    try {
      return db.prepare("SELECT lease_until, error FROM jobs WHERE id=?").get(id);
    } finally {
      db.close();
    }
  };
  const lease = jobRow(started.jobId).lease_until;
  assert.ok(Number.isSafeInteger(lease) && lease <= Date.now() + RECOVERY_GRACE_MS);
  await f.message((m) => m.to === "human" && m.text === "done:slow");
  assert.ok(!f.logs.some((e) => e.type === "turn.failed"));
  f.post({ to: "bob", text: "hang" });
  const hung = await f.log((e) => e.type === "turn.started" && e.agent === "bob");
  const stopping = Date.now();
  await f.stop();
  assert.ok(Date.now() - stopping < 4000);
  assert.equal(jobRow(hung.jobId).error, "host_stopped");
});
test("an uncertain POST retries identical committed output without executing the model twice", async (t) => {
  const f = await hostFixture(t);
  f.dropReply();
  f.post({ to: "alice", text: "retry-output" });
  await f.log((e) => e.type === "output.sent" && e.agent === "alice");
  const sends = f.requests.filter((r) => r.method === "POST" && !r.path.includes("/processing/"));
  assert.equal(sends.length, 2);
  assert.equal(sends[0].key, sends[1].key);
  assert.equal(f.messages.filter((m) => m.text === "done:retry-output").length, 1);
  assert.equal((await f.records()).length, 1);
});
test("idle host holds server event subscriptions and invokes zero agents", async (t) => {
  const f = await hostFixture(t);
  await Promise.all(["alice", "bob"].map((who) => f.request((r) => r.who === who && r.wait === 25)));
  const initial = f.requests.filter((r) => r.path.endsWith("/events")).length;
  await delay(350);
  assert.equal((await f.records()).length, 0);
  assert.equal(f.requests.filter((r) => r.path.endsWith("/events")).length, initial);
  const source = await readFile(new URL("../scripts/host/runtime.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("setInterval"), false);
});
test("deleted queued canonical message is skipped, never passed to a harness", async (t) => {
  const f = await hostFixture(t, { maxConcurrent: 1 });
  const deleted = f.post({ to: "alice", text: "deleted-secret" });
  f.deleted.add(deleted.id);
  f.post({ to: "alice", text: "retained" });
  await f.message((m) => m.to === "human" && m.text === "done:retained");
  assert.equal(
    (await f.records()).some((r) => r.input.message?.text === "deleted-secret"),
    false,
  );
});
test("restart resumes durable cursors without duplicating committed effects", async (t) => {
  const f = await hostFixture(t);
  f.post({ to: "alice", text: "before" });
  await f.log((e) => e.type === "output.sent" && e.agent === "alice");
  await f.stop();
  f.start();
  f.post({ to: "alice", text: "after" });
  await f.message((m) => m.to === "human" && m.text === "done:after");
  assert.deepEqual(
    (await f.records()).map((r) => r.input.message.text),
    ["before", "after"],
  );
  assert.equal(f.messages.filter((m) => m.text === "done:before").length, 1);
});
test("an agent added on restart never executes pre-addition events, even when peers lag the server head", async (t) => {
  const f = await hostFixture(t, { replayHistory: true });
  f.post({ to: "alice", text: "before" });
  await f.message((m) => m.to === "human" && m.text === "done:before");
  await f.stop();
  // The server head moves past every saved cursor while the host is down: the newcomer must treat
  // this as history despite replayHistory:true, which is a first-start policy only.
  f.post({ to: "carol", text: "stale" });
  f.start(["alice", "bob", "carol"]);
  // A correct host bootstraps carol; a regressed one would start a turn for the stale event instead.
  await f.log((e) => e.agent === "carol" && (e.type === "agent.ready" || e.type === "turn.started"));
  f.post({ to: "carol", text: "after" });
  await f.message((m) => m.to === "human" && m.text === "done:after");
  assert.deepEqual(
    (await f.records()).filter((r) => r.who === "carol").map((r) => r.input.message.text),
    ["after"],
  );
  assert.equal(
    f.messages.some((m) => m.text === "done:stale"),
    false,
  );
  assert.equal(f.status().agents.find((a) => a.id === "carol").cursor, f.events.length);
});
test("an agent that already handled a message is told when its sender edits it (ADR 0052)", async (t) => {
  const f = await hostFixture(t);
  const original = f.post({ to: "bob", text: "first draft" });
  await f.message((m) => m.to === "human" && m.text === "done:first draft");
  const handled = f.status();
  f.edit(original.id, "second draft");
  await f.message((m) => m.to === "human" && m.text === `edited:${original.id}:second draft`);
  const records = (await f.records()).filter((r) => r.who === "bob");
  assert.equal(records.length, 2);
  const notice = records[1].input;
  assert.equal(notice.trigger.type, "message.edited");
  assert.equal(notice.trigger.messageId, original.id);
  assert.equal(notice.trigger.editedAt, notice.message.editedAt);
  assert.match(notice.trigger.notice, new RegExp(`^Message ${original.id} from human was edited at `));
  assert.equal(notice.message.id, original.id);
  assert.equal(notice.message.text, "second draft");
  assert.notEqual(notice.idempotencyKey, records[0].input.idempotencyKey);
  // Alice was not addressed, so the edit does not wake her either.
  assert.equal((await f.records()).filter((r) => r.who === "alice").length, 0);
  assert.ok(f.requests.filter((r) => r.path.endsWith("/events")).every((r) => r.include === "edits"));
  assert.equal(f.status().failures.length, handled.failures.length);
});
test("revoking one agent stops only that agent; remaining peer continues", async (t) => {
  const f = await hostFixture(t);
  f.revoke("alice");
  await f.log((e) => e.type === "agent.stopped" && e.agent === "alice");
  f.post({ to: "bob", text: "still-working" });
  await f.message((m) => m.to === "human" && m.text === "done:still-working");
  assert.equal(
    (await f.records()).some((r) => r.who === "alice"),
    false,
  );
});
test("event notification before registering sleep cannot be lost, and abort cleans listeners", async () => {
  const pulse = new Pulse(),
    controller = new AbortController();
  const epoch = pulse.epoch;
  pulse.notify();
  await pulse.wait(epoch, null, controller.signal);
  const waiting = pulse.wait(pulse.epoch, null, controller.signal);
  assert.equal(pulse.listeners.size, 1);
  controller.abort();
  await waiting;
  assert.equal(pulse.listeners.size, 0);
});
test("host stream rejects foreign scope, event counter confusion and malformed continuations", () => {
  const connection = { tenant: "team", channel: "work" };
  const event = {
    id: 2,
    tenant: "team",
    channel: "work",
    type: "message.created",
    resourceId: 99,
    historyRevision: 0,
    createdAt: "2026-09-20T10:00:00Z",
  };
  assert.equal(validateHostPage({ events: [event], nextCursor: 2, hasMore: false }, connection, 1).length, 1);
  for (const change of [
    { events: [{ ...event, channel: "foreign" }], nextCursor: 2, hasMore: false },
    { events: [{ ...event, tenant: "foreign" }], nextCursor: 2, hasMore: false },
    { events: [event], nextCursor: 99, hasMore: false },
    { events: [], nextCursor: 1, hasMore: true },
    { events: [{ ...event, command: "not-executable" }], nextCursor: 2, hasMore: false },
  ])
    assert.throws(() => validateHostPage(change, connection, 1));
});

test("two real executable peers recover from a circular wait with one execution slot", async (t) => {
  const f = await hostFixture(t, { maxConcurrent: 1 });
  f.post({ to: "alice", text: "cycle-start" });
  await f.message((m) => m.to === "human" && m.text === "completed");
  const records = await f.records();
  const cycle = records.find((r) => r.input.trigger.type === "coordination.cycle");
  assert.equal(cycle.who, "bob");
  assert.deepEqual(cycle.input.trigger.path, ["bob", "alice", "bob"]);
  assert.equal(records.at(-1).input.trigger.resumed, true);
  assert.equal(f.status().failures.length, 0);
});
test("nearest wait deadline wakes an idle agent without an incoming message or polling", async (t) => {
  const f = await hostFixture(t, { maxConcurrent: 1 });
  f.post({ to: "alice", text: "wait-missing" });
  await f.message((m) => m.to === "human" && m.text === "timeout recovered");
  const records = await f.records();
  assert.equal(records.length, 2);
  assert.equal(records[1].input.trigger.type, "coordination.timeout");
  assert.equal(records[1].input.waiting, null);
});
test("permanently failed delivery wakes its sender rather than silently waiting for a reply", async (t) => {
  const f = await hostFixture(t);
  f.rejectSend();
  f.post({ to: "alice", text: "terminal-send-failure" });
  await f.message((m) => m.to === "human" && m.text === "delivery failure observed");
  const records = await f.records();
  assert.equal(records.length, 2);
  assert.equal(records[1].input.trigger.type, "coordination.delivery_failed");
  assert.equal(records[1].input.trigger.reason, "http_400");
  assert.notEqual(records[1].input.idempotencyKey, records[0].input.idempotencyKey);
  assert.equal(
    f.messages.some((m) => m.text === "done:terminal-send-failure"),
    false,
  );
  assert.equal(f.status().failedOutputs.length, 1);
});

test("shared-board persona profiles preserve attribution and wake two independent agents", async (t) => {
  const f = await hostFixture(t, { shared: true, maxConcurrent: 1 });
  f.post({ to: "alice", text: "coordinate" });
  await f.message((m) => m.to === "human" && m.text === "completed");
  const records = await f.records();
  assert.deepEqual(
    records.map((r) => r.who),
    ["alice", "bob", "alice"],
  );
  for (const row of records) {
    assert.equal(row.reader, `persona-${row.who}`);
    assert.equal(row.profile, row.who);
    assert.equal(row.input.identity.sharedChannel, true);
    assert.equal(row.input.identity.personaId, `persona-${row.who}`);
    assert.equal(row.input.board.goal, f.board.goal);
  }
  assert.equal(f.messages.find((m) => m.text === "completed").personaId, "persona-alice");
  assert.equal(f.status().failures.length, 0);
  // Long polls report listening as the agent's own persona; the startup catch-up read does not.
  const polls = f.requests.filter((r) => r.path.endsWith("/events"));
  for (const poll of polls) assert.equal(poll.listener, poll.wait ? `persona-${poll.who}` : null);
  assert.ok(polls.some((poll) => poll.wait && poll.listener));
});
test("exact-name participants do not tag their event polls as board listeners", async (t) => {
  const f = await hostFixture(t);
  await f.request((r) => r.path.endsWith("/events") && r.wait > 0);
  assert.ok(f.requests.filter((r) => r.path.endsWith("/events")).every((r) => r.listener === null));
});
test("paused shared board retains work through restart and resumes on board event", async (t) => {
  const f = await hostFixture(t, { shared: true });
  f.board.status = "paused";
  f.post({ to: "alice", text: "paused-work" });
  await delay(200);
  assert.equal((await f.records()).length, 0);
  assert.ok(f.status().jobs.some((row) => row.status === "paused"));
  await f.stop();
  f.start();
  f.board.status = "active";
  f.post({
    username: "board",
    contentType: "application/json",
    text: JSON.stringify({ schema: "msn.board.v1", status: "active" }),
  });
  await f.message((m) => m.text === "done:paused-work");
  assert.equal((await f.records()).filter((r) => r.input.message?.text === "paused-work").length, 1);
});
test("explicit working yields a durable continuation without another human message", async (t) => {
  const f = await hostFixture(t, { maxConcurrent: 1 });
  f.post({ to: "alice", text: "continue-work" });
  await f.message((m) => m.text === "continued");
  await delay(400);
  const records = await f.records();
  assert.equal(records.length, 2);
  assert.equal(records[1].input.trigger.type, "goal.continue");
  assert.equal(records[1].input.state.turns, 1);
  assert.equal(records[1].input.conversationId, records[0].input.conversationId);
  assert.equal(f.status().failures.length, 0);
});

test("one scheduling pass claims and computes its wake deadline from the same clock reading", async () => {
  // Regression: claim at T-1 ("not yet due") then deadline at T ("only rows due after T") lost a
  // row due exactly at T, so the host slept with no timer until an unrelated notify.
  const seen = [];
  const controller = new AbortController();
  const store = {
    agent: () => ({ cursor: 0, initialized: true }),
    expire: (now) => seen.push(["expire", now]),
    claimOutput: (_agent, now) => {
      seen.push(["claimOutput", now]);
      return null;
    },
    claim: (_agent, _timeout, now) => {
      seen.push(["claim", now]);
      return null;
    },
    nextDeadline: (now) => {
      seen.push(["nextDeadline", now]);
      controller.abort();
      return null;
    },
  };
  const config = { agents: [{ id: "solo", channels: ["work"] }], maxConcurrent: 1 };
  const connections = new Map([["solo", { origin: "http://127.0.0.1:9", tenant: "team", token: "x" }]]);
  await new HostRuntime(config, store, connections, { log: () => {} }).run(controller.signal);
  assert.deepEqual(
    seen.map(([name]) => name),
    ["expire", "claimOutput", "claim", "nextDeadline"],
  );
  assert.equal(typeof seen[0][1], "number");
  for (const [, now] of seen) assert.equal(now, seen[0][1]);
});
