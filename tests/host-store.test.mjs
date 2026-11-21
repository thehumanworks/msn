import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RECOVERY_GRACE_MS, turnLease, validateConfig, validateResult } from "../scripts/host/protocol.mjs";
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
// Mirrors the binding built by transport.mjs from the verified participant identities.
function bindingFor(config) {
  return {
    version: 1,
    hostId: config.hostId,
    origin: "https://example.test",
    tenant: "team",
    agents: config.agents
      .map((a) => ({ id: a.id, username: a.username, allowedChannels: [...a.allowedChannels].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "msn-host-store-"));
  const config = fixtureConfig(dir, overrides);
  const binding = bindingFor(config);
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
    reopen(now = 10, nextConfig = config) {
      store.close();
      store = new HostStore(nextConfig, bindingFor(nextConfig), now);
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

test("explicit onMessage allows channel input to cancel a peer wait from another conversation", (t) => {
  const f = fixture(t);
  const job = turn(f, "alice", 1);
  f.store.finish(
    job,
    result(f.config, "alice", {
      wait: { for: ["bob"], timeoutMs: 60000, reason: "review", onMessage: true },
    }),
    null,
    10,
  );
  f.store.ingest("alice", event(2));
  const incoming = f.store.claim("alice", 100, 20);
  assert.equal(
    f.store.startTurn(incoming, "new-human-request", {
      id: 2,
      channel: "work",
      username: "human",
      correlationId: "different",
    }).resumed,
    true,
  );
  assert.equal(f.store.agent("alice").waiting, null);
  assert.equal(f.store.expire(90000), 0);
});

test("goal continuation survives restart and an explicit same-conversation completion supersedes its delayed wake", (t) => {
  const f = fixture(t);
  const job = turn(f, "alice", 1);
  f.store.finish(
    job,
    result(f.config, "alice", { progress: { status: "working", reason: "next step", delayMs: 10000 } }),
    null,
    10,
    { status: "active" },
  );
  f.reopen(20);
  assert.equal(f.store.claim("alice", 100, 50), null);
  f.store.ingest("alice", event(2));
  const incoming = f.store.claim("alice", 100, 60);
  f.store.startTurn(incoming, "conversation", { id: 2, channel: "work", username: "human" });
  f.store.finish(
    incoming,
    result(f.config, "alice", { progress: { status: "complete", reason: "done" } }),
    null,
    70,
    { status: "active" },
  );
  assert.equal(f.store.claim("alice", 100, 20000), null);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='failed'").get().n, 0);
});

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
test("timeoutMs null is an explicit no-deadline mode with a bounded recovery lease; 0 and strings fail", () => {
  const good = fixtureConfig("/tmp/state");
  const raw = (timeoutMs) => ({
    schema: good.schema,
    hostId: good.hostId,
    stateDir: good.stateDir,
    agents: [
      { id: "a", profile: "a", command: ["agent"], channels: ["work"], permissionMode: "yolo", timeoutMs },
    ],
  });
  assert.equal(validateConfig(raw(undefined), "/tmp").agents[0].timeoutMs, 300000);
  assert.equal(validateConfig(raw(null), "/tmp").agents[0].timeoutMs, null);
  for (const bad of [0, -1, "none", "null", Number.POSITIVE_INFINITY, 3600001]) {
    assert.throws(() => validateConfig(raw(bad), "/tmp"), /invalid_agent_limits/);
  }
  assert.equal(turnLease(1000, 10), 6010);
  assert.equal(turnLease(null, 10), 10 + RECOVERY_GRACE_MS);
  assert.ok(Number.isSafeInteger(turnLease(null)));
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
test("several edits to one message queue one turn; a running edit turn still gets a follow-up (ADR 0052)", (t) => {
  const f = fixture(t, { maxPending: 3 });
  const edited = (id, resourceId) => ({ ...event(id), type: "message.edited", resourceId });
  const queued = () =>
    f.store.db.prepare("SELECT event_id FROM jobs WHERE agent='alice' AND status='queued' ORDER BY id").all();
  assert.equal(f.store.ingest("alice", edited(5, 1)), true);
  assert.equal(f.store.ingest("alice", edited(6, 1)), true);
  assert.equal(f.store.ingest("alice", edited(7, 1)), true);
  assert.deepEqual(
    queued().map((row) => row.event_id),
    [5],
  );
  assert.equal(f.store.agent("alice").cursor, 7);
  // An edit to another message is its own turn.
  assert.equal(f.store.ingest("alice", edited(8, 2)), true);
  assert.deepEqual(
    queued().map((row) => row.event_id),
    [5, 8],
  );
  // Once the first edit turn runs, a newer edit to that message queues again: the running turn
  // may already have read the older text. Edits after that merge into the new queued job.
  f.store.claim("alice", 100, 10);
  assert.equal(f.store.ingest("alice", edited(9, 1)), true);
  assert.deepEqual(
    queued().map((row) => row.event_id),
    [8, 9],
  );
  assert.equal(f.store.ingest("alice", edited(10, 1)), true);
  assert.equal(queued().length, 2);
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
  const available = Math.max(lease, 10 + RECOVERY_GRACE_MS);
  assert.equal(f.store.claim("bob", 100, available - 1), null);
  assert.equal(f.store.claim("bob", 100, available).id, pending.id);
  assert.equal(f.store.claimOutput("alice", 10).body.text, "request");
});
test("roster additions migrate the binding; the newcomer starts at the host event boundary", (t) => {
  const f = fixture(t);
  const done = turn(f, "alice", 7);
  f.store.finish(done, result(f.config, "alice", { state: { session: "kept" } }), null, 10);
  const pending = turn(f, "bob", 8);
  const grown = fixtureConfig(f.dir);
  grown.agents.push({ ...grown.agents[0], id: "dave", username: "dave", profile: "dave", role: "peer" });
  f.reopen(10, grown);
  const saved = JSON.parse(f.store.db.prepare("SELECT value FROM meta WHERE key='binding'").get().value);
  assert.deepEqual(saved, bindingFor(grown));
  assert.deepEqual(f.store.agent("alice").state, { session: "kept" });
  assert.equal(f.store.db.prepare("SELECT status FROM jobs WHERE id=?").get(pending.id).status, "queued");
  assert.equal(f.store.agent("dave").cursor, 8, "first page starts after events peers already handled");
  assert.equal(f.store.agent("dave").initialized, 0, "replayHistory never applies to an added agent");
  // Peers lag the server: event 9 already exists remotely. The newcomer's first page must
  // fast-forward past it without queueing, exactly as a replayHistory:false first start would.
  f.store.bootstrap("dave", 9, true);
  assert.equal(f.store.agent("dave").cursor, 9);
  assert.equal(f.store.agent("dave").initialized, 1);
  assert.equal(f.store.status().jobs.find((j) => j.status === "queued").count, 1, "no pre-addition work");
  assert.equal(f.store.ingest("dave", event(10)), true);
  assert.equal(f.store.status().jobs.find((j) => j.status === "queued").count, 2);
  assert.deepEqual(
    f.store.status().agents.map((a) => a.id),
    ["alice", "bob", "coordinator", "dave"],
  );
  // The generation is part of every durable key; migration must not rotate it.
  const generation = f.store.generation;
  f.reopen(10, grown);
  assert.equal(f.store.generation, generation);
});
test("roster removals, renames and policy changes are rejected before any write; the original roster still opens", (t) => {
  const f = fixture(t);
  turn(f, "alice", 3);
  const before = f.store.db.prepare("SELECT value FROM meta WHERE key='binding'").get().value;
  const removed = fixtureConfig(f.dir);
  removed.agents = removed.agents.filter((a) => a.id !== "bob");
  const renamed = fixtureConfig(f.dir);
  renamed.agents.find((a) => a.id === "bob").username = "robert";
  const rehosted = fixtureConfig(f.dir, { hostId: "other-host" });
  const scoped = fixtureConfig(f.dir);
  scoped.agents.find((a) => a.id === "alice").allowedChannels = ["work", "review"];
  f.store.close();
  for (const [config, code] of [
    [removed, /host_state_agent_removed/],
    [renamed, /host_state_agent_identity_mismatch/],
    [rehosted, /host_state_binding_mismatch/],
    [scoped, /host_state_binding_mismatch/],
  ]) {
    assert.throws(() => new HostStore(config, bindingFor(config), 10), code);
  }
  f.reopen(10);
  assert.equal(f.store.db.prepare("SELECT value FROM meta WHERE key='binding'").get().value, before);
  assert.equal(f.store.agent("alice").cursor, 3);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM agents").get().n, 3);
});
test("recovery reserves the cleanup grace from replacement startup even when a no-deadline lease expired", (t) => {
  const f = fixture(t);
  const job = turn(f, "bob", 1);
  // The runtime records a no-deadline lease at turn start; the turn then outlives it before the host dies.
  f.store.db.prepare("UPDATE jobs SET lease_until=? WHERE id=?").run(turnLease(null, 0), job.id);
  const restart = 20000;
  assert.ok(turnLease(null, 0) < restart, "the recorded lease has already expired at restart");
  f.reopen(restart);
  const row = f.store.db.prepare("SELECT status, error, available FROM jobs WHERE id=?").get(job.id);
  assert.deepEqual(
    { ...row },
    {
      status: "queued",
      error: "host_restarted",
      available: restart + RECOVERY_GRACE_MS,
    },
  );
  assert.equal(
    f.store.claim("bob", 100, restart),
    null,
    "no immediate reclaim during the old watchdog's escalation",
  );
  assert.equal(f.store.claim("bob", 100, restart + RECOVERY_GRACE_MS - 1), null);
  assert.equal(f.store.claim("bob", 100, restart + RECOVERY_GRACE_MS).id, job.id);
  // Reconfiguring the agent from null to a finite deadline before the restart changes nothing: the
  // grace is measured from replacement startup, independent of the current configuration.
  f.store.db
    .prepare("UPDATE jobs SET status='running', lease_until=? WHERE id=?")
    .run(turnLease(null, 0), job.id);
  const finite = fixtureConfig(f.dir);
  finite.agents.forEach((a) => {
    a.timeoutMs = 300000;
  });
  const again = restart + RECOVERY_GRACE_MS + 1;
  f.reopen(again, finite);
  assert.equal(
    f.store.db.prepare("SELECT available FROM jobs WHERE id=?").get(job.id).available,
    again + RECOVERY_GRACE_MS,
  );
  assert.equal(f.store.claim("bob", 100, again + RECOVERY_GRACE_MS - 1), null);
  assert.equal(f.store.claim("bob", 100, again + RECOVERY_GRACE_MS).id, job.id);
});
test("repeated restart preserves queued recovery grace and longer original leases", (t) => {
  for (const timeout of [100, 60000]) {
    const f = fixture(t);
    f.store.ingest("alice", event(1));
    const job = f.store.claim("alice", timeout, 0);
    const available = Math.max(20000 + RECOVERY_GRACE_MS, timeout + 5000);
    f.reopen(20000);
    assert.equal(f.store.claim("alice", 100, available - 1), null);
    f.reopen(21000);
    assert.equal(f.store.claim("alice", 100, available - 1), null);
    const recovered = f.store.claim("alice", 100, available);
    assert.equal(recovered.id, job.id);
    assert.equal(recovered.attempts, 2);
  }
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

test("clean cancellation does not spend a retry before the next host can execute", (t) => {
  const f = fixture(t);
  f.store.ingest("alice", event(1));
  const interrupted = f.store.claim("alice", 100, 10);
  assert.equal(interrupted.attempts, 1);
  f.store.requeue(interrupted);
  f.reopen();
  const resumed = f.store.claim("alice", 100, 20);
  assert.equal(resumed.id, interrupted.id);
  assert.equal(resumed.attempts, 1);
});

test("terminal output failure atomically creates one durable continuation, never regenerating the old turn", (t) => {
  const f = fixture(t),
    job = turn(f, "alice", 1);
  f.store.finish(
    job,
    result(f.config, "alice", { actions: [{ type: "send", channel: "work", to: "bob", text: "request" }] }),
    null,
  );
  const output = f.store.claimOutput("alice", 10);
  assert.equal(f.store.outputResult(output, "http_400", false, 10), "failed");
  f.store.outputResult(output, "http_400", false, 10);
  f.reopen();
  const resumed = f.store.claim("alice", 100, 20);
  assert.notEqual(resumed.id, job.id);
  assert.equal(resumed.root, "conversation");
  assert.deepEqual(resumed.trigger.to, "bob");
  assert.equal(resumed.trigger.type, "coordination.delivery_failed");
  f.store.ignore(resumed);
  assert.equal(f.store.claim("alice", 100, 20), null);
});

test("fresh state generations cannot collide with old output keys; restarting a generation preserves keys", (t) => {
  const left = fixture(t),
    right = fixture(t);
  const a = turn(left, "alice", 1),
    b = turn(right, "alice", 1);
  left.store.finish(
    a,
    result(left.config, "alice", { actions: [{ type: "send", channel: "work", text: "old generation" }] }),
    null,
  );
  right.store.finish(
    b,
    result(right.config, "alice", { actions: [{ type: "send", channel: "work", text: "new generation" }] }),
    null,
  );
  const first = left.store.claimOutput("alice", 10),
    second = right.store.claimOutput("alice", 10);
  assert.notEqual(first.key, second.key);
  left.reopen();
  assert.equal(left.store.claimOutput("alice", 20).key, first.key);
});

const HUMAN = (id, root = "conversation") => ({ id, username: "human", correlationId: root });
const softBudget = (f, root = "conversation") =>
  f.store.db.prepare("SELECT * FROM budgets WHERE root=?").get(root);
const warnings = (f, agent) =>
  f.store.db
    .prepare("SELECT root, trigger FROM jobs WHERE agent=? AND trigger IS NOT NULL ORDER BY id")
    .all(agent)
    .map((row) => ({ root: row.root, ...JSON.parse(row.trigger) }))
    .filter((trigger) => trigger.type === "coordination.budget");
function humanTurn(f, agent, id, messageId = id, root = "conversation") {
  f.store.ingest(agent, event(id));
  const job = f.store.claim(agent, 100, 10);
  assert.ok(f.store.startTurn(job, root, HUMAN(messageId, root)));
  f.store.finish(job, result(f.config, agent), null);
  return job;
}

test("soft budget counts only agent-triggered logical turns once per job, excludes its own signal, and resets on new human input", (t) => {
  const f = fixture(t, { softTurnsPerConversation: 2 });
  const done = (job) => f.store.finish(job, result(f.config, job.agent), null);
  humanTurn(f, "alice", 1);
  assert.deepEqual(
    [softBudget(f).agent_turns, softBudget(f).last_human_event_id, softBudget(f).turns],
    [0, 1, 1],
    "a human-triggered job resets the soft counter but is never an agent turn",
  );
  done(turn(f, "bob", 2)); // alice's reply activates bob: first agent turn
  done(turn(f, "alice", 3)); // bob's reply activates alice: second agent turn crosses the budget
  const warning = f.store.claim("alice", 100, 11);
  assert.equal(warning.trigger.type, "coordination.budget");
  assert.equal(warning.trigger.agentTurns, 2);
  assert.equal(warning.trigger.softBudget, 2);
  assert.equal(warning.trigger.hardLimit, 64);
  assert.equal(warning.root, "conversation");
  assert.match(warning.trigger.instruction, /what changed, what remains and whether peer input/);
  assert.ok(f.store.startTurn(warning, "conversation", null));
  assert.equal(softBudget(f).agent_turns, 2, "the warning turn itself is not an agent turn");
  assert.equal(softBudget(f).turns, 4, "the hard budget still counts every activation");
  done(warning);
  assert.equal(f.store.claim("alice", 100, 12), null, "one warning per threshold");
  humanTurn(f, "bob", 4); // newer human message resets the soft counter
  assert.deepEqual(
    [softBudget(f).agent_turns, softBudget(f).last_human_event_id, softBudget(f).next_warning],
    [0, 4, 2],
  );
  humanTurn(f, "alice", 5, 4); // the same human message reaching a second recipient neither resets nor counts
  done(turn(f, "bob", 6));
  humanTurn(f, "alice", 7, 3); // a replayed older human message neither resets nor counts
  assert.equal(softBudget(f).agent_turns, 1);
  assert.equal(softBudget(f).last_human_event_id, 4, "the remembered human message never regresses");
  done(turn(f, "alice", 8));
  assert.equal(softBudget(f).next_warning, 4);
  assert.equal(f.store.claim("alice", 100, 13).trigger.type, "coordination.budget");
});
test("a human broadcast resets once across recipients despite interleaved agent work; older human replay never resets or counts", (t) => {
  const f = fixture(t, { softTurnsPerConversation: 3 });
  const done = (job) => f.store.finish(job, result(f.config, job.agent), null);
  done(turn(f, "alice", 1));
  done(turn(f, "bob", 1));
  assert.equal(softBudget(f).agent_turns, 2);
  humanTurn(f, "alice", 2, 10); // human message 10 reaches alice first: reset
  assert.deepEqual([softBudget(f).agent_turns, softBudget(f).last_human_event_id], [0, 10]);
  done(turn(f, "alice", 3));
  done(turn(f, "bob", 2));
  humanTurn(f, "bob", 3, 10); // the same broadcast reaches bob after two agent turns: no second reset
  assert.deepEqual([softBudget(f).agent_turns, softBudget(f).last_human_event_id], [2, 10]);
  humanTurn(f, "alice", 4, 7); // an older human message replayed later: no reset, no count, no regression
  assert.deepEqual([softBudget(f).agent_turns, softBudget(f).last_human_event_id], [2, 10]);
  assert.deepEqual([warnings(f, "alice").length, warnings(f, "bob").length], [0, 0]);
  done(turn(f, "bob", 4)); // third agent turn since human message 10
  assert.deepEqual(
    warnings(f, "bob").map((w) => w.agentTurns),
    [3],
  );
  assert.equal(warnings(f, "alice").length, 0);
});
test("two complete soft intervals without human input produce exactly two warnings at successive milestones", (t) => {
  const f = fixture(t, { softTurnsPerConversation: 2 });
  const done = (job) => f.store.finish(job, result(f.config, job.agent), null);
  for (const [agent, id] of [
    ["alice", 1],
    ["bob", 1],
    ["alice", 2],
    ["alice", 3],
  ])
    done(turn(f, agent, id));
  assert.deepEqual(
    [...warnings(f, "bob"), ...warnings(f, "alice")].map((w) => w.agentTurns),
    [2, 4],
  );
  for (const agent of ["bob", "alice"]) {
    const warning = f.store.claim(agent, 100, 10);
    assert.equal(warning.trigger.type, "coordination.budget");
    assert.ok(f.store.startTurn(warning, "conversation"));
    done(warning);
  }
  assert.deepEqual([softBudget(f).agent_turns, softBudget(f).next_warning, softBudget(f).turns], [4, 6, 6]);
  done(turn(f, "bob", 2));
  done(turn(f, "alice", 4));
  assert.deepEqual(
    [...warnings(f, "bob"), ...warnings(f, "alice")].map((w) => w.agentTurns),
    [2, 4, 6],
  );
});
test("retries and restarts mid-turn never inflate the soft budget; counters and pending warnings survive restart", (t) => {
  const f = fixture(t, { softTurnsPerConversation: 3 });
  const job = turn(f, "alice", 1);
  assert.equal(softBudget(f).agent_turns, 1);
  f.store.fail(job, "handler_timeout", 3, 10);
  const retry = f.store.claim("alice", 100, 500);
  assert.equal(retry.id, job.id);
  assert.ok(f.store.startTurn(retry, "conversation"));
  assert.equal(softBudget(f).agent_turns, 1, "a retry re-enters startTurn without a new logical turn");
  assert.equal(softBudget(f).turns, 2);
  f.reopen(); // crash mid-turn: recovery requeues the running job
  const recovered = f.store.claim("alice", 100, 10_000_000);
  assert.equal(recovered.id, job.id);
  assert.ok(f.store.startTurn(recovered, "conversation"));
  assert.equal(softBudget(f).agent_turns, 1);
  f.store.finish(recovered, result(f.config, "alice"), null);
  turn(f, "bob", 1);
  const third = turn(f, "alice", 2);
  assert.equal(softBudget(f).agent_turns, 3);
  f.reopen(); // restart exactly at the boundary keeps the queued warning and does not duplicate it
  f.store.finish(third, result(f.config, "alice"), null);
  assert.deepEqual(
    warnings(f, "alice").map((w) => w.agentTurns),
    [3],
  );
  assert.equal(softBudget(f).next_warning, 6);
});
test("clean cancellation refunds the attempt but keeps the counted marker; a retried warning neither counts nor recurses", (t) => {
  const f = fixture(t, { softTurnsPerConversation: 2 });
  const job = turn(f, "alice", 1);
  f.store.requeue(job); // host_stopped: attempts go back to 0
  const again = f.store.claim("alice", 100, 10);
  assert.deepEqual([again.id, again.attempts, again.error, again.counted], [job.id, 1, "host_stopped", 1]);
  assert.ok(f.store.startTurn(again, "conversation"));
  assert.deepEqual([softBudget(f).agent_turns, softBudget(f).turns], [1, 2]);
  f.store.finish(again, result(f.config, "alice"), null);
  f.store.finish(turn(f, "bob", 1), result(f.config, "bob"), null);
  const warning = f.store.claim("bob", 100, 10);
  assert.equal(warning.trigger.type, "coordination.budget");
  assert.ok(f.store.startTurn(warning, "conversation"));
  f.store.fail(warning, "handler_timeout", 3, 10);
  const retried = f.store.claim("bob", 100, 10_000);
  assert.equal(retried.id, warning.id);
  assert.ok(f.store.startTurn(retried, "conversation"));
  f.store.requeue(retried);
  assert.ok(f.store.startTurn(f.store.claim("bob", 100, 10_000), "conversation"));
  assert.equal(softBudget(f).agent_turns, 2, "warning attempts are never logical agent turns");
  assert.equal(softBudget(f).turns, 6, "warning attempts still consume the hard allowance");
  assert.equal(warnings(f, "bob").length, 1, "a warning cannot generate another warning");
});
test("independent conversation roots keep separate counters and human resets", (t) => {
  const f = fixture(t, { softTurnsPerConversation: 2 });
  const done = (job) => f.store.finish(job, result(f.config, job.agent), null);
  humanTurn(f, "alice", 1, 1, "a");
  humanTurn(f, "alice", 2, 2, "b");
  done(turn(f, "bob", 1, "a"));
  done(turn(f, "bob", 2, "b"));
  done(turn(f, "alice", 3, "a"));
  assert.deepEqual([softBudget(f, "a").agent_turns, softBudget(f, "b").agent_turns], [2, 1]);
  assert.deepEqual(
    warnings(f, "alice").map((w) => [w.root, w.agentTurns]),
    [["a", 2]],
  );
  assert.equal(warnings(f, "bob").length, 0);
  const warning = f.store.claim("alice", 100, 10);
  assert.ok(f.store.startTurn(warning, warning.root));
  done(warning);
  humanTurn(f, "bob", 3, 3, "b"); // newer human input on b resets b only
  assert.deepEqual(
    [softBudget(f, "a"), softBudget(f, "b")].map((b) => [b.agent_turns, b.last_human_event_id]),
    [
      [2, 1],
      [0, 3],
    ],
  );
});
test("softTurnsPerConversation 0 disables soft counting; enabling later initializes milestones without spurious warnings", (t) => {
  const f = fixture(t, { softTurnsPerConversation: 0 });
  for (const [agent, id] of [
    ["alice", 1],
    ["bob", 1],
    ["alice", 2],
  ])
    f.store.finish(turn(f, agent, id), result(f.config, agent), null);
  assert.deepEqual(
    [softBudget(f).turns, softBudget(f).agent_turns, softBudget(f).next_warning, warnings(f, "alice").length],
    [3, 0, 0, 0],
  );
  f.config.softTurnsPerConversation = 2;
  f.reopen();
  assert.deepEqual([softBudget(f).agent_turns, softBudget(f).next_warning], [0, 2]);
  f.store.finish(turn(f, "bob", 2), result(f.config, "bob"), null);
  assert.equal(warnings(f, "bob").length, 0);
  f.store.finish(turn(f, "alice", 3), result(f.config, "alice"), null);
  assert.deepEqual(
    warnings(f, "alice").map((w) => w.agentTurns),
    [2],
  );
});
test("a warning queued at the hard cap is dead-lettered like any other activation, never executed", (t) => {
  const f = fixture(t, { maxTurnsPerConversation: 2, softTurnsPerConversation: 2 });
  f.store.finish(turn(f, "alice", 1), result(f.config, "alice"), null);
  f.store.finish(turn(f, "bob", 1), result(f.config, "bob"), null);
  const warning = f.store.claim("bob", 100, 10);
  assert.equal(warning.trigger.type, "coordination.budget");
  assert.equal(f.store.startTurn(warning, "conversation"), false);
  assert.equal(
    f.store.db.prepare("SELECT status, error FROM jobs WHERE id=?").get(warning.id).error,
    "conversation_budget_exhausted",
  );
  assert.equal(softBudget(f).turns, 2);
});
test("a version 1 host state file migrates to version 2 with preserved hard counts and no spurious warning; unknown versions fail closed", (t) => {
  const f = fixture(t, { softTurnsPerConversation: 5 });
  f.store.db.exec(
    "DROP TABLE budgets; CREATE TABLE budgets (root TEXT PRIMARY KEY, turns INTEGER NOT NULL); INSERT INTO budgets VALUES ('old', 3); UPDATE meta SET value='1' WHERE key='version'",
  );
  f.reopen();
  assert.equal(f.store.db.prepare("SELECT value FROM meta WHERE key='version'").get().value, "2");
  assert.deepEqual(
    { ...softBudget(f, "old") },
    { root: "old", turns: 3, agent_turns: 0, last_human_event_id: 0, next_warning: 5 },
  );
  f.store.ingest("alice", event(1));
  assert.ok(f.store.startTurn(f.store.claim("alice", 100, 10), "old"));
  assert.equal(softBudget(f, "old").turns, 4, "the hard activation history is preserved and continues");
  assert.equal(f.store.claim("bob", 100, 10), null);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE trigger IS NOT NULL").get().n, 0);
  f.store.db.exec("UPDATE meta SET value='3' WHERE key='version'");
  f.store.close();
  assert.throws(() => new HostStore(f.config, f.binding, 10), /unsupported_host_state_version/);
  const raw = new DatabaseSync(join(f.dir, "state.sqlite"));
  raw.exec("UPDATE meta SET value='2' WHERE key='version'");
  raw.close();
  assert.doesNotThrow(() => f.reopen());
});
test("soft budget configuration defaults below the hard limit, allows 0 to disable, and rejects values above it", () => {
  assert.equal(fixtureConfig("/tmp/state").softTurnsPerConversation, 16);
  assert.equal(fixtureConfig("/tmp/state", { maxTurnsPerConversation: 4 }).softTurnsPerConversation, 4);
  assert.equal(fixtureConfig("/tmp/state", { softTurnsPerConversation: 8 }).softTurnsPerConversation, 8);
  assert.equal(fixtureConfig("/tmp/state", { softTurnsPerConversation: 0 }).softTurnsPerConversation, 0);
  assert.throws(
    () => fixtureConfig("/tmp/state", { maxTurnsPerConversation: 4, softTurnsPerConversation: 5 }),
    /invalid_host_limits/,
  );
  assert.throws(() => fixtureConfig("/tmp/state", { softTurnsPerConversation: -1 }), /invalid_host_limits/);
  assert.throws(() => fixtureConfig("/tmp/state", { softTurnsPerConversation: 1.5 }), /invalid_host_limits/);
});

test("explicit progress is bounded, survives restart, and a newer completion cancels stale continuation", (t) => {
  const f = fixture(t);
  const job = turn(f, "alice", 1);
  f.store.finish(
    job,
    result(f.config, "alice", {
      progress: { status: "working", reason: "next action", delayMs: 1000 },
      state: { step: 1 },
    }),
    null,
    10,
  );
  f.reopen(20);
  assert.equal(f.store.nextDeadline(20), 1010);
  assert.equal(f.store.claim("alice", 100, 1000), null);
  assert.deepEqual(f.store.agent("alice").state, { step: 1 });
  const next = turn(f, "alice", 2);
  f.store.finish(
    next,
    result(f.config, "alice", { progress: { status: "complete", reason: "already solved" } }),
    null,
    30,
  );
  assert.equal(f.store.claim("alice", 100, 2000), null);
});
test("progress cannot create implicit loops, conflicting waits, unbounded delays or leave-channel continuations", (t) => {
  const f = fixture(t);
  for (const progress of [
    null,
    { status: "unknown", reason: "x" },
    { status: "working", reason: "" },
    { status: "working", reason: "x", delayMs: 0 },
    { status: "working", reason: "x", delayMs: 3600001 },
  ])
    assert.throws(() => result(f.config, "alice", { progress }));
  assert.throws(() =>
    result(f.config, "alice", {
      progress: { status: "working", reason: "x" },
      wait: { for: ["bob"], timeoutMs: 100, reason: "x" },
    }),
  );
  let job = turn(f, "alice", 1);
  f.store.finish(job, result(f.config, "alice"), null, 10);
  assert.equal(f.store.claim("alice", 100, 2000), null);
  job = turn(f, "alice", 2);
  f.store.finish(
    job,
    result(f.config, "alice", {
      actions: [{ type: "leave", channel: "work" }],
      progress: { status: "working", reason: "x" },
    }),
    null,
    10,
  );
  assert.equal(f.store.claim("alice", 100, 2000), null);
});
test("remote personas do not reset the soft human-input budget", (t) => {
  const f = fixture(t, { softTurnsPerConversation: 2 });
  f.store.ingest("alice", event(1));
  const job = f.store.claim("alice", 100, 10);
  f.store.startTurn(job, "remote", { id: 1, username: "remote-agent", personaId: "persona-remote" });
  assert.equal(
    f.store.db.prepare("SELECT agent_turns FROM budgets WHERE root='remote'").get().agent_turns,
    1,
  );
});

test("complete progress clears only its own outstanding wait; working cannot silently disappear behind a wait", (t) => {
  const f = fixture(t);
  let job = turn(f, "alice", 1);
  f.store.finish(
    job,
    result(f.config, "alice", { wait: { for: ["bob"], timeoutMs: 1000, reason: "review" } }),
    null,
    10,
  );
  job = turn(f, "alice", 2);
  assert.throws(
    () =>
      f.store.finish(
        job,
        result(f.config, "alice", { progress: { status: "working", reason: "next" } }),
        null,
        20,
      ),
    /working_cannot_wait/,
  );
  assert.ok(f.store.agent("alice").waiting);
  f.store.finish(
    job,
    result(f.config, "alice", { progress: { status: "complete", reason: "solved" } }),
    null,
    20,
  );
  assert.equal(f.store.agent("alice").waiting, null);
  assert.equal(f.store.expire(2000), 0);
});
test("explicit continuations consume the hard budget instead of looping forever", (t) => {
  const f = fixture(t, { maxTurnsPerConversation: 2, softTurnsPerConversation: 0 });
  const output = () =>
    result(f.config, "alice", { progress: { status: "working", reason: "next", delayMs: 250 } });
  let job = turn(f, "alice", 1);
  f.store.finish(job, output(), null, 10);
  job = f.store.claim("alice", 100, 300);
  assert.ok(f.store.startTurn(job, "conversation", null));
  f.store.finish(job, output(), null, 300);
  job = f.store.claim("alice", 100, 600);
  assert.equal(f.store.startTurn(job, "conversation", null), false);
  assert.equal(
    f.store.db.prepare("SELECT status,error FROM jobs WHERE id=?").get(job.id).error,
    "conversation_budget_exhausted",
  );
  assert.equal(f.store.claim("alice", 100, 2000), null);
});

test("a send action can quote the message it replies to; a quote without replyTo is refused (ADR 0059)", (t) => {
  const f = fixture(t),
    job = turn(f, "alice", 1);
  f.store.finish(
    job,
    result(f.config, "alice", {
      actions: [{ type: "send", channel: "work", text: "Done", replyTo: 1, quote: "Then tag the CLI." }],
    }),
    null,
    10,
  );
  const output = f.store.claimOutput("alice", 10);
  assert.equal(output.body.replyTo, 1);
  assert.equal(output.body.quote, "Then tag the CLI.");
  f.store.outputResult(output, null, false, 10);
  // An explicit replyTo without a quote is kept as given, not replaced by the triggering message.
  const next = turn(f, "alice", 2);
  f.store.finish(
    next,
    result(f.config, "alice", { actions: [{ type: "send", channel: "work", text: "Re #1", replyTo: 1 }] }),
    // The triggering message is #2: before the fix, replyTo 1 was replaced by 2.
    { id: 2, channel: "work", username: "human" },
    20,
  );
  const explicit = f.store.claimOutput("alice", 20);
  assert.equal(explicit.body.replyTo, 1);
  assert.equal("quote" in explicit.body, false);
  f.store.outputResult(explicit, null, false, 20);
  // With no replyTo the reply still answers the triggering message.
  const third = turn(f, "alice", 3);
  f.store.finish(
    third,
    result(f.config, "alice", { actions: [{ type: "send", channel: "work", text: "ok" }] }),
    { id: 3, channel: "work", username: "human" },
    30,
  );
  assert.equal(f.store.claimOutput("alice", 30).body.replyTo, 3);
  for (const action of [
    { quote: "no target" },
    { replyTo: 1, quote: " " },
    { replyTo: 1, quote: "x".repeat(2049) },
    { replyTo: 1, quote: 7 },
  ])
    assert.throws(
      () => result(f.config, "alice", { actions: [{ type: "send", channel: "work", text: "x", ...action }] }),
      /invalid_quote/,
    );
});
