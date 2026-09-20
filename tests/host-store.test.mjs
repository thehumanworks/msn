import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateConfig, validateResult } from "../scripts/host/protocol.mjs";
import { HostStore } from "../scripts/host/store.mjs";

function fixtureConfig(dir, overrides = {}) {
  const config = validateConfig(
    {
      schema: "msn.host.v1",
      hostId: "test-host",
      stateDir: dir,
      replayHistory: true,
      agents: ["alice", "bob", "coordinator"].map((id) => ({
        id,
        profile: id,
        command: [process.execPath, "agent.mjs"],
        channels: ["work"],
        allowedChannels: ["*"],
        permissionMode: "yolo",
        role: id === "coordinator" ? "coordinator" : "peer",
      })),
      ...overrides,
    },
    dir,
  );
  config.agents.forEach((a) => {
    a.username = a.id;
  });
  return config;
}
function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "msn-host-store-"));
  const config = fixtureConfig(dir, overrides);
  const binding = { version: 1, hostId: config.hostId, origin: "https://example.test", tenant: "team" };
  let store = new HostStore(config, binding);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    config,
    dir,
    binding,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new HostStore(config, binding, 10);
      return store;
    },
  };
}
const event = (id, channel = "work") => ({
  id,
  tenant: "team",
  channel,
  type: "message.created",
  resourceId: id,
  historyRevision: 0,
  createdAt: "2026-09-20T12:00:00Z",
});
function result(config, agent, value = {}, channels = ["work"]) {
  return validateResult(
    { schema: "msn.turn.result.v1", actions: [], ...value },
    config.agents.find((a) => a.id === agent),
    channels,
  );
}
function turn(f, agent, id, root = "conversation") {
  f.store.ingest(agent, event(id));
  const job = f.store.claim(agent, 100, 10);
  assert.ok(f.store.startTurn(job, root));
  return job;
}

test("configuration fails closed on missing identity, non-YOLO, arbitrary remote commands and bad channels", () => {
  const good = fixtureConfig("/tmp/state");
  const raw = {
    schema: good.schema,
    hostId: good.hostId,
    stateDir: good.stateDir,
    agents: [{ id: "a", profile: "a", command: ["agent"], channels: ["work"], permissionMode: "yolo" }],
  };
  assert.equal(validateConfig(raw, "/tmp").maxConcurrent, 4);
  for (const mutate of [
    (c) => {
      delete c.hostId;
    },
    (c) => {
      delete c.agents[0].id;
    },
    (c) => {
      c.agents[0].permissionMode = "ask";
    },
    (c) => {
      c.agents[0].remoteCommand = "from message";
    },
    (c) => {
      c.agents[0].command = "echo shell";
    },
    (c) => {
      c.agents[0].channels = ["../secret"];
    },
    (c) => {
      c.maxConcurrent = 0;
    },
    (c) => {
      c.replayHistory = "false";
    },
    (c) => {
      c.agents.push(c.agents[0]);
    },
  ]) {
    const copy = structuredClone(raw);
    mutate(copy);
    assert.throws(() => validateConfig(copy, "/tmp"));
  }
});
test("one OS-released SQLite ownership lock per host state directory", (t) => {
  const f = fixture(t);
  assert.throws(() => new HostStore(f.config, f.binding), /already_owned/);
  assert.doesNotThrow(() => f.reopen());
  f.store.close();
  assert.throws(() => new HostStore(f.config, { ...f.binding, tenant: "foreign" }), /binding_mismatch/);
  // close is idempotent even after an explicit close.
});
test("inbox reference and cursor are atomic, replay deduplicates, queue overflow does not advance", (t) => {
  const f = fixture(t, { maxPending: 1 });
  assert.equal(f.store.ingest("alice", event(1)), true);
  assert.equal(f.store.ingest("alice", event(1)), true);
  assert.equal(f.store.ingest("alice", event(2)), false);
  assert.equal(f.store.agent("alice").cursor, 1);
  assert.equal(f.store.status().jobs[0].count, 1);
  const job = f.store.claim("alice", 100, 10);
  f.store.ignore(job);
  assert.equal(f.store.ingest("alice", event(2)), true);
  assert.equal(f.store.agent("alice").cursor, 2);
  assert.equal(f.store.db.prepare("SELECT event FROM jobs WHERE id=1").get().event.includes('"text"'), false);
});
test("restart persists cursors, committed state/outbox and defers unfinished process lease", (t) => {
  const f = fixture(t);
  const done = turn(f, "alice", 1);
  f.store.finish(
    done,
    result(f.config, "alice", {
      state: { session: "durable" },
      actions: [{ type: "send", channel: "work", to: "bob", text: "request" }],
    }),
    null,
    10,
  );
  const pending = turn(f, "bob", 2);
  const lease = f.store.db.prepare("SELECT lease_until FROM jobs WHERE id=?").get(pending.id).lease_until;
  f.reopen();
  assert.deepEqual(f.store.agent("alice").state, { session: "durable" });
  assert.equal(f.store.agent("alice").cursor, 1);
  assert.equal(f.store.claim("bob", 100, lease - 1), null);
  assert.equal(f.store.claim("bob", 100, lease).id, pending.id);
  assert.equal(f.store.claimOutput("alice", 10).body.text, "request");
});
test("failed short transaction rolls back cursor and inbox together", (t) => {
  const f = fixture(t);
  f.store.db.exec(
    "CREATE TRIGGER reject_cursor BEFORE UPDATE OF cursor ON agents BEGIN SELECT RAISE(ABORT,'test'); END",
  );
  assert.throws(() => f.store.ingest("alice", event(1)), /test/);
  assert.equal(f.store.agent("alice").cursor, 0);
  assert.equal(f.store.status().jobs.length, 0);
});
test("only one active turn per agent, without blocking peers", (t) => {
  const f = fixture(t);
  f.store.ingest("alice", event(1));
  f.store.ingest("alice", event(2));
  f.store.ingest("bob", event(1));
  assert.ok(f.store.claim("alice", 100, 10));
  assert.equal(f.store.claim("alice", 100, 10), null);
  assert.ok(f.store.claim("bob", 100, 10));
});
test("cooperative wait releases the lane and a reply already in the inbox wakes it", (t) => {
  const f = fixture(t);
  const first = turn(f, "alice", 1);
  f.store.ingest("alice", event(2)); // reply races the running handler
  f.store.finish(
    first,
    result(f.config, "alice", { wait: { for: ["bob"], timeoutMs: 100, reason: "review" } }),
    null,
    10,
  );
  const next = f.store.claim("alice", 100, 11);
  assert.ok(next);
  assert.deepEqual(
    f.store.startTurn(next, "conversation", { username: "bob", correlationId: "conversation" }),
    { resumed: true },
  );
  assert.equal(f.store.agent("alice").waiting, null);
});
test("A→B→A wait cycle generates a continuation; no coordinator permission gate", (t) => {
  const f = fixture(t);
  const alice = turn(f, "alice", 1),
    bob = turn(f, "bob", 1);
  f.store.finish(
    alice,
    result(f.config, "alice", { wait: { for: ["bob"], timeoutMs: 100, reason: "need bob" } }),
    null,
    10,
  );
  f.store.finish(
    bob,
    result(f.config, "bob", { wait: { for: ["alice"], timeoutMs: 100, reason: "need alice" } }),
    null,
    10,
  );
  assert.equal(f.store.agent("bob").waiting, null);
  const signal = f.store.claim("bob", 100, 11);
  assert.equal(signal.trigger.type, "coordination.cycle");
  assert.deepEqual(signal.trigger.path, ["bob", "alice", "bob"]);
  assert.ok(f.store.claim("coordinator", 100, 11) === null);
});
test("self wait is rejected with an actionable continuation", (t) => {
  const f = fixture(t),
    job = turn(f, "alice", 1);
  f.store.finish(
    job,
    result(f.config, "alice", { wait: { for: ["alice"], timeoutMs: 100, reason: "self" } }),
    null,
    10,
  );
  assert.equal(f.store.agent("alice").waiting, null);
  assert.deepEqual(f.store.claim("alice", 100, 11).trigger.path, ["alice", "alice"]);
});
test("deadline is one-shot, durable across restart, and synthetic continuations preserve conversation", (t) => {
  const f = fixture(t),
    job = turn(f, "alice", 1);
  f.store.finish(
    job,
    result(f.config, "alice", { wait: { for: ["external-human"], timeoutMs: 100, reason: "decision" } }),
    null,
    10,
  );
  f.reopen();
  assert.equal(f.store.nextDeadline(10), 110);
  assert.equal(f.store.expire(109), 0);
  assert.equal(f.store.expire(110), 1);
  assert.equal(f.store.expire(111), 0);
  const continuation = f.store.claim("alice", 100, 112);
  assert.equal(continuation.trigger.type, "coordination.timeout");
  assert.equal(continuation.root, "conversation");
});
test("bounded retry dead-letters poison input and permits later input", (t) => {
  const f = fixture(t),
    first = turn(f, "alice", 1);
  f.store.ingest("alice", event(2));
  f.store.fail(first, "handler_timeout", 2, 10);
  const next = f.store.claim("alice", 100, 11);
  assert.notEqual(next.id, first.id);
  f.store.ignore(next);
  const retry = f.store.claim("alice", 100, 260);
  assert.equal(retry.id, first.id);
  f.store.fail(retry, "handler_timeout", 2, 260);
  assert.equal(f.store.status().failures[0].error, "handler_timeout");
  assert.equal(JSON.parse(f.store.claimOutput("alice", 300).body.text).schema, "msn.host.status.v1");
});
test("outbox replay uses exact stable key and body without regenerating model output", (t) => {
  const f = fixture(t),
    job = turn(f, "alice", 1);
  f.store.finish(
    job,
    result(f.config, "alice", { actions: [{ type: "send", channel: "work", text: "once" }] }),
    null,
    10,
  );
  const output = f.store.claimOutput("alice", 10);
  f.store.outputResult(output, "transport_failed", true, 10);
  const retry = f.store.claimOutput("alice", 510);
  assert.equal(retry.key, output.key);
  assert.deepEqual(retry.body, output.body);
  assert.equal(f.store.claim("alice", 100, 510), null);
  f.store.outputResult(retry, null, false, 510);
  assert.equal(f.store.claimOutput("alice", 1000), null);
});
test("conversation budget bounds peer ping-pong and retries", (t) => {
  const f = fixture(t, { maxTurnsPerConversation: 2 });
  const a = turn(f, "alice", 1);
  f.store.finish(a, result(f.config, "alice"), null);
  const b = turn(f, "bob", 1);
  f.store.finish(b, result(f.config, "bob"), null);
  f.store.ingest("alice", event(2));
  const third = f.store.claim("alice", 100, 10);
  assert.equal(f.store.startTurn(third, "conversation"), false);
  assert.equal(f.store.status().failures[0].error, "conversation_budget_exhausted");
});
test("organic join/send/leave changes live routing, not authority or executable argv", (t) => {
  const f = fixture(t),
    job = turn(f, "alice", 1);
  const output = result(f.config, "alice", {
    actions: [
      { type: "join", channel: "review" },
      { type: "send", channel: "review", to: "bob", text: "join me" },
      { type: "leave", channel: "work" },
    ],
  });
  f.store.finish(job, output, null);
  assert.deepEqual(f.store.agent("alice").channels, ["review"]);
  assert.equal(f.store.ingest("alice", event(2, "work")), true);
  assert.equal(f.store.claim("alice", 100, 10), null);
  assert.equal(f.store.ingest("alice", event(3, "review")), true);
  assert.ok(f.store.claim("alice", 100, 10));
  assert.throws(() => result(f.config, "alice", { actions: [{ type: "exec", command: "bad" }] }));
  assert.throws(() =>
    result(f.config, "alice", { actions: [{ type: "send", channel: "work", to: "alice", text: "loop" }] }),
  );
  assert.throws(() =>
    result(f.config, "alice", { actions: [{ type: "send", channel: "unjoined", text: "no" }] }),
  );
  assert.throws(() => result(f.config, "alice", { wait: { for: ["bob"], reason: "forever" } }));
});
