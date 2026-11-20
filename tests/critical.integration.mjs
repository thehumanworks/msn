/**
 * Isolated real Wrangler + Rust trial for critical agent workflows.
 * Modeled on tests/swarm.integration.mjs. Root adds the package script.
 *
 * Goal: exercise start, peek/commit, show, and task CLI against a local Worker.
 *
 * Invariants:
 *  I1 start returns catchup fields plus identity {username,reader,tenant,origin}, protocolVersion 1,
 *     workflow, warnings; one page; no read/processing cursor mutation
 *     -> start identity / no-cursor / exact --after
 *  I2 peek exposes committedThrough + highestFetched with the poll page; peek never advances
 *     committedThrough; no-commit replay returns the same prefix
 *     -> peek replay / watermarks
 *  I3 commit is monotonic and <= highestFetched; after commit, peek continues after that id
 *     -> commit monotonic
 *  I4 processing progress is independent of the eager read cursor and per-reader isolated
 *     -> read-independent / two readers
 *  I5 explicit --cursor-file is bound (including reader); foreign/corrupt/backwards/future rejected
 *     -> cursor-file binding
 *  I6 task owner → ready (evidence) → reviewer close; unauthorized close does not close
 *     -> task lifecycle
 *  I7 competing claims expose conflicts (not last-write-wins); assign clears them
 *     -> claim conflict
 *  I8 dependent blockedOn then unblocks after predecessor close
 *     -> dependency
 *  I9 show live {message,historyRevision}; wrong-channel/missing 404; deleted 410 no wipe
 *     -> show isolation
 * I10 delete increments historyRevision observed by show and start
 *     -> historyRevision
 *
 * Edge cases: failed peek auth does not advance watermarks; ready with missing evidence
 * fails preflight; cycle/duplicate-open appear as warnings or blockedOn, never silent complete;
 * concurrent peek on one cursor-file exits 5.
 *
 * Out of scope: package.json script; args.rs/lib.rs/main.rs; running this file until root
 * says the debug binary is ready. Stdout-crash non-advancement stays a G01 unit case.
 * Recipe under test: start → peek → work/send/task events with --key → commit this peek's prefix
 * (normally nextCursor). Never commit-then-send; never blindly commit highestFetched (#426/#430).
 *
 * QA (root): cargo build --manifest-path cli/Cargo.toml --locked && node tests/critical.integration.mjs
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "msn-critical-e2e-"));
const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));

const url = `http://127.0.0.1:${port}`;
const admin = "isolated-critical-admin-token-00000000";
const tenantName = "critical-team";
const channel = "critical";
const otherChannel = "other-lane";
const idleChannel = "idle";
const binary = join(cwd, "cli/target/debug/msn");
const baseEnv = {
  PATH: process.env.PATH,
  HOME: dir,
  XDG_CONFIG_HOME: join(dir, "config"),
  XDG_STATE_HOME: join(dir, "state"),
  MSN_URL: url,
  MSN_WORKSPACE_TENANT: tenantName,
};

const server = spawn(
  join(cwd, "node_modules/.bin/wrangler"),
  ["dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(dir, "worker")],
  {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ADMIN_TOKEN: admin, WRANGLER_SEND_METRICS: "false" },
  },
);
let serverLog = "";
server.on("error", (error) => {
  serverLog += error.message;
});
for (const stream of [server.stdout, server.stderr]) {
  stream.on("data", (chunk) => {
    serverLog = (serverLog + chunk).slice(-20000);
  });
}

function envWith(overrides) {
  return { ...baseEnv, ...overrides };
}

async function rustRaw(args, overrides = {}) {
  try {
    const result = await exec(binary, args, {
      cwd,
      env: envWith(overrides),
      timeout: 20000,
    });
    const trimmed = result.stdout.trim();
    let json = null;
    if (trimmed) {
      try {
        json = JSON.parse(trimmed);
      } catch {
        throw Object.assign(new Error(`CLI stdout was not JSON: ${trimmed.slice(0, 200)}`), {
          stdout: result.stdout,
          stderr: result.stderr,
          code: 1,
        });
      }
    }
    return { ok: true, json, stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    return {
      ok: false,
      error,
      json: null,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      code: error.code,
    };
  }
}

async function rust(args, overrides = {}) {
  const result = await rustRaw(args, overrides);
  if (!result.ok) {
    throw result.error;
  }
  return result.json;
}

async function attempt(args, overrides = {}) {
  return rustRaw(args, overrides);
}

async function jsonFiles(root) {
  let names = [];
  try {
    names = await readdir(root, { recursive: true });
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".json")).map((name) => join(root, name));
}

function lastId(messages) {
  return messages.at(-1)?.id ?? 0;
}

function peekCmd(ch, reader, extra = []) {
  return ["peek", ch, "--reader", reader, ...extra];
}

function commitCmd(ch, reader, through, extra = []) {
  return ["commit", ch, "--through", String(through), "--reader", reader, ...extra];
}

function warningCodes(board) {
  return (board.warnings ?? []).map((warning) => (typeof warning === "string" ? warning : warning.code));
}

function taskById(board, id) {
  assert.ok(Array.isArray(board.tasks), "task list must include tasks[]");
  const task = board.tasks.find((item) => item.id === id);
  assert.ok(task, `missing task ${id}`);
  return task;
}

function assertTaskShape(task) {
  for (const key of [
    "id",
    "title",
    "owner",
    "reviewer",
    "state",
    "assertedState",
    "dependsOn",
    "blockedOn",
    "evidence",
    "messageIds",
    "conflicts",
  ]) {
    assert.ok(key in task, `task ${task.id ?? "?"} missing ${key}`);
  }
}

function assertNeverCleanClosed(task, why) {
  assert.notEqual(task.state, "closed", `${task.id} must not be effectively closed (${why})`);
  assert.ok(
    task.conflicts.length > 0 || (Array.isArray(task.blockedOn) && task.blockedOn.length > 0),
    `${task.id} must expose conflicts or blockedOn when it is not cleanly closed (${why})`,
  );
}

function assertPeekEnvelope(page) {
  assert.ok(Array.isArray(page.messages), "peek.messages");
  assert.equal(typeof page.nextCursor, "number", "peek.nextCursor");
  assert.equal(typeof page.hasMore, "boolean", "peek.hasMore");
  assert.equal(typeof page.committedThrough, "number", "peek.committedThrough");
  assert.equal(typeof page.highestFetched, "number", "peek.highestFetched");
}

function assertStartEnvelope(page) {
  assert.equal(typeof page.identity, "object");
  assert.equal(typeof page.identity.username, "string");
  assert.equal(typeof page.identity.reader, "string");
  assert.equal(page.identity.tenant, tenantName);
  assert.equal(page.identity.origin, url);
  assert.equal(page.protocolVersion, 1);
  assert.equal(typeof page.workflow, "object");
  assert.equal(typeof page.workflow.work, "string");
  assert.equal(typeof page.workflow.send, "string");
  assert.equal(typeof page.workflow.continuation, "string");
  assert.ok(Array.isArray(page.warnings), "start.warnings");
  assert.ok(Array.isArray(page.messages), "start.messages");
  assert.equal(typeof page.nextCursor, "number");
  assert.equal(typeof page.hasMore, "boolean");
  assert.equal(typeof page.historyRevision, "number");
}

async function listBoard(overrides, extra = []) {
  const board = await rust(
    ["task", "list", channel, "--max-pages", "100", "--limit", "20", ...extra],
    overrides,
  );
  assert.ok(Array.isArray(board.tasks));
  assert.ok(Array.isArray(board.warnings));
  assert.equal(typeof board.complete, "boolean");
  assert.ok("headCursor" in board);
  assert.equal(typeof board.historyRevision, "number");
  assert.ok(
    board.nextCursor == null || typeof board.nextCursor === "string" || typeof board.nextCursor === "number",
  );
  assert.equal(typeof board.hasMore, "boolean");
  for (const task of board.tasks) {
    assertTaskShape(task);
  }
  return board;
}

try {
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `local worker failed to start: ${serverLog.slice(-1200)}`);

  const adminEnv = { MSN_ADMIN_TOKEN: admin };
  await rust(["provision", tenantName, "--username", "bootstrap"], adminEnv);
  const owner = await rust(["key-create", "owner", "--username", "owner-agent"], adminEnv);
  const reviewer = await rust(["key-create", "reviewer", "--username", "reviewer-agent"], adminEnv);
  const other = await rust(["key-create", "other", "--username", "other-agent"], adminEnv);
  const reader = await rust(["key-create", "reader", "--username", "returning-agent"], adminEnv);
  const ownerEnv = { MSN_WORKSPACE_TOKEN: owner.token };
  const reviewerEnv = { MSN_WORKSPACE_TOKEN: reviewer.token };
  const otherEnv = { MSN_WORKSPACE_TOKEN: other.token };
  const readerEnv = { MSN_WORKSPACE_TOKEN: reader.token };

  await rust(["create", channel], ownerEnv);
  await rust(["create", otherChannel], ownerEnv);
  await rust(["create", idleChannel], ownerEnv);

  const first = await rust(
    [
      "send",
      channel,
      "--text",
      "initial objective",
      "--key",
      "work-1",
      "--correlation-id",
      "critical-run",
      "--to",
      "returning-agent",
    ],
    ownerEnv,
  );
  const firstId = first.message.id;
  const second = await rust(
    ["send", channel, "--text", "follow-up work", "--key", "work-2", "--reply-to", String(firstId)],
    ownerEnv,
  );
  const evidence = await rust(
    ["send", channel, "--text", "acceptance evidence", "--key", "evidence-1"],
    ownerEnv,
  );
  const doomed = await rust(["send", channel, "--text", "wipe-secret-body", "--key", "delete-1"], ownerEnv);
  const third = await rust(["send", channel, "--text", "tail-three", "--key", "work-3"], ownerEnv);
  const fourth = await rust(["send", channel, "--text", "tail-four", "--key", "work-4"], ownerEnv);
  const otherRow = await rust(
    ["send", otherChannel, "--text", "other-channel-secret", "--key", "other-1"],
    ownerEnv,
  );
  const liveIds = [
    firstId,
    second.message.id,
    evidence.message.id,
    doomed.message.id,
    third.message.id,
    fourth.message.id,
  ];

  // I1 start identity, one-page catchup, exact continuation, no cursor mutation.
  const readOnce = await rust(["read", channel], readerEnv);
  assert.deepEqual(
    readOnce.messages.map((message) => message.id),
    liveIds,
  );
  const started = await rust(["start", channel, "--limit", "2", "--max-bytes", "32768"], readerEnv);
  assertStartEnvelope(started);
  assert.equal(started.identity.username, "returning-agent");
  assert.equal(started.identity.reader, "returning-agent");
  assert.ok(started.messages.length <= 2);
  assert.deepEqual(
    started.messages.map((message) => message.id),
    liveIds.slice(0, started.messages.length),
  );
  const continued = await rust(
    ["start", channel, "--after", String(started.nextCursor), "--limit", "2", "--max-bytes", "32768"],
    readerEnv,
  );
  assertStartEnvelope(continued);
  assert.equal(continued.snapshot, null);
  assert.ok(continued.nextCursor >= started.nextCursor);
  assert.deepEqual(
    continued.messages.map((message) => message.id),
    liveIds.filter((id) => id > started.nextCursor).slice(0, 2),
  );
  const afterStartRead = await rust(["read", channel, "--wait", "0"], readerEnv);
  assert.deepEqual(afterStartRead.messages, []);
  const stateFilesAfterStart = await jsonFiles(join(dir, "state"));
  assert.equal(
    stateFilesAfterStart.some((path) => path.includes("/processing/")),
    false,
    "start must not create a processing cursor",
  );

  // I2 / I4 peek does not adopt the eager read cursor; replay before commit.
  const peekFresh = await rust(peekCmd(channel, "returning-agent", ["--limit", "100"]), readerEnv);
  assertPeekEnvelope(peekFresh);
  assert.equal(peekFresh.committedThrough, 0);
  assert.deepEqual(
    peekFresh.messages.map((message) => message.id),
    liveIds,
  );
  assert.equal(peekFresh.highestFetched, lastId(peekFresh.messages));
  const peekReplay = await rust(peekCmd(channel, "returning-agent", ["--limit", "100"]), readerEnv);
  assertPeekEnvelope(peekReplay);
  assert.equal(peekReplay.committedThrough, 0);
  assert.deepEqual(
    peekReplay.messages.map((message) => message.id),
    liveIds,
  );
  const processingFiles = (await jsonFiles(join(dir, "state"))).filter((path) =>
    path.includes("/processing/"),
  );
  assert.ok(processingFiles.length >= 1, "peek writes processing/<reader-hash>/<channel>.json");
  assert.equal(
    processingFiles.some((path) => path.includes("/readers/")),
    false,
  );
  for (const file of processingFiles) {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  const stillCaughtUp = await rust(["read", channel, "--wait", "0"], readerEnv);
  assert.deepEqual(stillCaughtUp.messages, []);

  // Failed auth must not advance processing watermarks.
  const badPeek = await attempt(peekCmd(channel, "returning-agent"), {
    MSN_WORKSPACE_TOKEN: "wrong-token-not-a-secret",
  });
  assert.equal(badPeek.ok, false);
  assert.equal(badPeek.code, 3);
  const peekAfterAuthFail = await rust(peekCmd(channel, "returning-agent", ["--limit", "100"]), readerEnv);
  assert.equal(peekAfterAuthFail.committedThrough, 0);
  assert.equal(peekAfterAuthFail.highestFetched, peekFresh.highestFetched);

  // I3 commit prefix, then peek continues; backwards/future rejected (G01 #417).
  const commitThrough = second.message.id;
  const committed = await rustRaw(commitCmd(channel, "returning-agent", commitThrough), readerEnv);
  assert.equal(committed.ok, true);
  assert.equal(committed.json.committedThrough, commitThrough);
  assert.equal(typeof committed.json.highestFetched, "number");
  assert.ok(committed.json.highestFetched >= commitThrough);
  const peekAfterCommit = await rust(peekCmd(channel, "returning-agent", ["--limit", "100"]), readerEnv);
  assertPeekEnvelope(peekAfterCommit);
  assert.equal(peekAfterCommit.committedThrough, commitThrough);
  assert.deepEqual(
    peekAfterCommit.messages.map((message) => message.id),
    liveIds.filter((id) => id > commitThrough),
  );
  const narrow = await rust(peekCmd(channel, "returning-agent", ["--limit", "1"]), readerEnv);
  assertPeekEnvelope(narrow);
  assert.equal(narrow.committedThrough, commitThrough);
  assert.ok(narrow.highestFetched >= peekFresh.highestFetched);
  assert.ok(narrow.nextCursor <= narrow.highestFetched);
  const backwards = await attempt(commitCmd(channel, "returning-agent", firstId), readerEnv);
  assert.equal(backwards.ok, false);
  assert.equal(backwards.code, 2);
  const future = await attempt(commitCmd(channel, "returning-agent", fourth.message.id + 100), readerEnv);
  assert.equal(future.ok, false);
  assert.equal(future.code, 2);
  const peekUnchanged = await rust(peekCmd(channel, "returning-agent", ["--limit", "100"]), readerEnv);
  assert.equal(peekUnchanged.committedThrough, commitThrough);

  // I4 distinct readers stay isolated (same token, different --reader).
  const alice = await rust(peekCmd(channel, "alice", ["--limit", "100"]), ownerEnv);
  assertPeekEnvelope(alice);
  assert.equal(alice.committedThrough, 0);
  assert.deepEqual(
    alice.messages.map((message) => message.id),
    liveIds,
  );
  await rust(commitCmd(channel, "alice", lastId(alice.messages)), ownerEnv);
  const bob = await rust(peekCmd(channel, "bob", ["--limit", "100"]), ownerEnv);
  assertPeekEnvelope(bob);
  assert.equal(bob.committedThrough, 0);
  assert.deepEqual(
    bob.messages.map((message) => message.id),
    liveIds,
  );
  const aliceAgain = await rust(peekCmd(channel, "alice", ["--limit", "100"]), ownerEnv);
  assert.equal(aliceAgain.committedThrough, lastId(alice.messages));
  assert.deepEqual(aliceAgain.messages, []);

  // I5 explicit --cursor-file binding + lock + foreign file. Reader always required (G01).
  // Two files for one reader are separate progress only when kept local (--local, ADR 0053); by
  // default both would share the reader's one server cursor.
  const cursorFile = join(dir, "processing-owner.json");
  const peekFile = await rust(
    peekCmd(channel, "owner-agent", ["--cursor-file", cursorFile, "--limit", "100", "--local"]),
    ownerEnv,
  );
  assertPeekEnvelope(peekFile);
  assert.equal(peekFile.committedThrough, 0);
  await rust(commitCmd(channel, "owner-agent", firstId, ["--cursor-file", cursorFile, "--local"]), ownerEnv);
  const defaultOwnerPeek = await rust(
    peekCmd(channel, "owner-agent", ["--limit", "100", "--local"]),
    ownerEnv,
  );
  assert.equal(defaultOwnerPeek.committedThrough, 0);
  const fileAgain = await rust(
    peekCmd(channel, "owner-agent", ["--cursor-file", cursorFile, "--limit", "100", "--local"]),
    ownerEnv,
  );
  assert.equal(fileAgain.committedThrough, firstId);
  const foreignPath = join(dir, "foreign-cursor.json");
  await writeFile(
    foreignPath,
    JSON.stringify({
      server: "https://other.test",
      tenant: "wrong",
      channel,
      reader: "owner-agent",
      committedThrough: 0,
      highestFetched: 0,
    }),
  );
  const foreign = await attempt(
    peekCmd(channel, "owner-agent", ["--cursor-file", foreignPath, "--local"]),
    ownerEnv,
  );
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, 2);

  const lockFile = join(dir, "idle-lock.json");
  const waiter = spawn(
    binary,
    peekCmd(idleChannel, "owner-agent", ["--wait", "3", "--cursor-file", lockFile, "--local"]),
    {
      cwd,
      env: envWith(ownerEnv),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  const locked = await attempt(
    peekCmd(idleChannel, "owner-agent", ["--wait", "0", "--cursor-file", lockFile, "--local"]),
    ownerEnv,
  );
  assert.equal(locked.ok, false);
  assert.equal(locked.code, 5);
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiter.kill("SIGTERM");
    }, 4000);
    waiter.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  // I9 / I10 show live identity, wrong channel, deleted wipe, historyRevision.
  const shown = await rust(["show", channel, String(firstId)], readerEnv);
  assert.equal(shown.message.id, firstId);
  assert.equal(shown.message.channel, channel);
  assert.equal(shown.message.tenant, tenantName);
  assert.equal(shown.message.username, "owner-agent");
  assert.equal(shown.message.text, "initial objective");
  assert.equal(shown.message.contentType, "text/plain");
  assert.equal(shown.message.to, "returning-agent");
  assert.equal(shown.message.correlationId, "critical-run");
  assert.ok(!("replyTo" in shown.message));
  assert.equal(typeof shown.historyRevision, "number");
  const revisionBeforeDelete = shown.historyRevision;
  const shownReply = await rust(["show", channel, String(second.message.id)], readerEnv);
  assert.equal(shownReply.message.replyTo, firstId);
  const shownOther = await rust(["show", otherChannel, String(otherRow.message.id)], readerEnv);
  assert.equal(shownOther.message.channel, otherChannel);
  assert.equal(shownOther.message.text, "other-channel-secret");

  const wrongChannel = await attempt(["show", otherChannel, String(firstId)], readerEnv);
  assert.equal(wrongChannel.ok, false);
  assert.equal(wrongChannel.code, 4);
  assert.match(wrongChannel.stderr, /404:.*[Mm]essage not found|message_not_found/);
  assert.doesNotMatch(wrongChannel.stderr, /410|message_deleted/);
  const missing = await attempt(["show", channel, String(firstId + 10_000)], readerEnv);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 4);
  const malformed = await attempt(["show", channel, "abc"], readerEnv);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 2);
  const zero = await attempt(["show", channel, "0"], readerEnv);
  assert.equal(zero.ok, false);
  assert.equal(zero.code, 2);
  const unknownChannel = await attempt(["show", "no-such-channel", String(firstId)], readerEnv);
  assert.equal(unknownChannel.ok, false);
  assert.equal(unknownChannel.code, 4);

  const leaked = await fetch(
    `${url}/api/tenants/${tenantName}/channels/${otherChannel}/messages/${firstId}`,
    {
      headers: { Authorization: `Bearer ${reader.token}` },
    },
  );
  assert.equal(leaked.status, 404);
  assert.equal((await leaked.json()).error.code, "message_not_found");
  const badHttp = await fetch(`${url}/api/tenants/${tenantName}/channels/${channel}/messages/abc`, {
    headers: { Authorization: `Bearer ${reader.token}` },
  });
  assert.equal(badHttp.status, 400);
  assert.equal((await badHttp.json()).error.code, "invalid_query");
  const zeroHttp = await fetch(`${url}/api/tenants/${tenantName}/channels/${channel}/messages/0`, {
    headers: { Authorization: `Bearer ${reader.token}` },
  });
  assert.equal(zeroHttp.status, 400);
  assert.equal((await zeroHttp.json()).error.code, "invalid_query");
  const missingAuth = await fetch(`${url}/api/tenants/${tenantName}/channels/${channel}/messages/${firstId}`);
  assert.equal(missingAuth.status, 401);
  const unknownHttp = await fetch(
    `${url}/api/tenants/${tenantName}/channels/no-such-channel/messages/${firstId}`,
    { headers: { Authorization: `Bearer ${reader.token}` } },
  );
  assert.equal(unknownHttp.status, 404);
  assert.equal((await unknownHttp.json()).error.code, "channel_not_found");

  await rust(["delete", channel, String(doomed.message.id)], adminEnv);
  const deletedCli = await attempt(["show", channel, String(doomed.message.id)], readerEnv);
  assert.equal(deletedCli.ok, false);
  assert.equal(deletedCli.code, 5);
  assert.match(deletedCli.stderr, /410:|message_deleted/);
  assert.doesNotMatch(`${deletedCli.stdout}\n${deletedCli.stderr}`, /wipe-secret-body/);
  const deletedHttp = await fetch(
    `${url}/api/tenants/${tenantName}/channels/${channel}/messages/${doomed.message.id}`,
    { headers: { Authorization: `Bearer ${reader.token}` } },
  );
  assert.equal(deletedHttp.status, 410);
  const deletedBody = await deletedHttp.json();
  assert.equal(deletedBody.error.code, "message_deleted");
  assert.ok(!("message" in deletedBody));
  assert.doesNotMatch(JSON.stringify(deletedBody), /wipe-secret-body/);

  const shownAfterDelete = await rust(["show", channel, String(firstId)], readerEnv);
  assert.ok(shownAfterDelete.historyRevision > revisionBeforeDelete);
  const startAfterDelete = await rust(["start", channel, "--limit", "1"], readerEnv);
  assert.equal(startAfterDelete.historyRevision, shownAfterDelete.historyRevision);
  const unauthShow = await attempt(["show", channel, String(firstId)], {
    MSN_WORKSPACE_TOKEN: "wrong-token-not-a-secret",
  });
  assert.equal(unauthShow.ok, false);
  assert.equal(unauthShow.code, 3);

  // I6–I8 task ledger: claims, assign, owner ready, reviewer close, dependencies.
  await rust(
    [
      "task",
      "open",
      channel,
      "ship-docs",
      "--title",
      "Ship critical docs",
      "--reviewer",
      "reviewer-agent",
      "--acceptance",
      "Reviewer closes after evidence",
      "--key",
      "task-open-ship",
    ],
    ownerEnv,
  );
  await rust(
    [
      "task",
      "open",
      channel,
      "follow-docs",
      "--title",
      "Follow-on docs",
      "--owner",
      "owner-agent",
      "--reviewer",
      "reviewer-agent",
      "--depends-on",
      "ship-docs",
      "--key",
      "task-open-follow",
    ],
    ownerEnv,
  );
  await rust(
    [
      "task",
      "open",
      channel,
      "cycle-a",
      "--title",
      "Cycle A",
      "--reviewer",
      "reviewer-agent",
      "--depends-on",
      "cycle-b",
      "--key",
      "task-open-cycle-a",
    ],
    ownerEnv,
  );
  await rust(
    [
      "task",
      "open",
      channel,
      "cycle-b",
      "--title",
      "Cycle B",
      "--reviewer",
      "reviewer-agent",
      "--depends-on",
      "cycle-a",
      "--key",
      "task-open-cycle-b",
    ],
    ownerEnv,
  );
  const opened = await listBoard(readerEnv);
  assert.equal(opened.complete, true);
  const ship = taskById(opened, "ship-docs");
  assert.equal(ship.title, "Ship critical docs");
  assert.equal(ship.reviewer, "reviewer-agent");
  assert.equal(ship.owner, null);
  assert.equal(ship.assertedState, "open");
  assert.equal(ship.state, "open");
  const follow = taskById(opened, "follow-docs");
  assert.equal(follow.owner, "owner-agent");
  assert.equal(follow.assertedState, "open");
  assert.equal(follow.state, "blocked");
  assert.deepEqual(follow.dependsOn, ["ship-docs"]);
  assert.ok(follow.blockedOn.includes("ship-docs"));
  assertNeverCleanClosed(follow, "unmet dependency");
  const cycleA = taskById(opened, "cycle-a");
  const cycleB = taskById(opened, "cycle-b");
  assert.ok(cycleA.conflicts.includes("dependency-cycle"));
  assert.ok(cycleB.conflicts.includes("dependency-cycle"));
  assert.ok(cycleA.blockedOn.length > 0);
  assert.ok(cycleB.blockedOn.length > 0);
  assert.equal(cycleA.assertedState, "open");
  assert.equal(cycleB.assertedState, "open");
  assertNeverCleanClosed(cycleA, "dependency-cycle");
  assertNeverCleanClosed(cycleB, "dependency-cycle");

  await rust(
    [
      "task",
      "open",
      channel,
      "dup-docs",
      "--title",
      "Duplicate target",
      "--reviewer",
      "reviewer-agent",
      "--key",
      "task-open-dup",
    ],
    ownerEnv,
  );
  const dup = await rust(
    [
      "task",
      "open",
      channel,
      "dup-docs",
      "--title",
      "Duplicate open",
      "--reviewer",
      "reviewer-agent",
      "--key",
      "task-open-dup-again",
    ],
    ownerEnv,
  );
  assert.ok(dup);
  const afterDup = await listBoard(readerEnv);
  const dupDocs = taskById(afterDup, "dup-docs");
  assert.ok(
    warningCodes(afterDup).includes("duplicate-open") || dupDocs.conflicts.includes("duplicate-open"),
  );
  assert.equal(dupDocs.title, "Duplicate target");
  assert.equal(taskById(afterDup, "ship-docs").title, "Ship critical docs");
  assertNeverCleanClosed(dupDocs, "duplicate-open");

  await rust(["task", "claim", channel, "ship-docs", "--key", "task-claim-owner"], ownerEnv);
  await rust(["task", "claim", channel, "ship-docs", "--key", "task-claim-other"], otherEnv);
  const claimed = await listBoard(readerEnv);
  const claimedShip = taskById(claimed, "ship-docs");
  assert.ok(claimedShip.conflicts.includes("claim-conflict"), "competing claims must remain visible");
  assert.equal(claimedShip.owner, null);
  assert.equal(claimedShip.assertedState, "open");
  assert.equal(claimedShip.state, "conflict");
  assertNeverCleanClosed(claimedShip, "claim-conflict");

  await rust(
    ["task", "assign", channel, "ship-docs", "--owner", "owner-agent", "--key", "task-assign-ship"],
    reviewerEnv,
  );
  const assigned = await listBoard(readerEnv);
  const assignedShip = taskById(assigned, "ship-docs");
  assert.equal(assignedShip.owner, "owner-agent");
  assert.equal(assignedShip.assertedState, "open");
  assert.equal(assignedShip.state, "open");
  assert.ok(!assignedShip.conflicts.includes("claim-conflict"));

  await rust(
    ["task", "block", channel, "ship-docs", "--reason", "waiting on evidence", "--key", "task-block-ship"],
    ownerEnv,
  );
  const blockedShip = taskById(await listBoard(readerEnv), "ship-docs");
  assert.equal(blockedShip.assertedState, "blocked");
  assert.equal(blockedShip.state, "blocked");

  const missingEvidence = await attempt(
    ["task", "ready", channel, "ship-docs", "--evidence", "99999", "--key", "task-ready-missing"],
    ownerEnv,
  );
  assert.equal(missingEvidence.ok, false);
  assert.ok([2, 4].includes(missingEvidence.code));

  await rust(
    [
      "task",
      "ready",
      channel,
      "ship-docs",
      "--evidence",
      String(evidence.message.id),
      "--key",
      "task-ready-ship",
    ],
    ownerEnv,
  );
  const readied = taskById(await listBoard(readerEnv), "ship-docs");
  assert.equal(readied.assertedState, "ready");
  assert.equal(readied.state, "ready");
  assert.ok(readied.evidence.includes(evidence.message.id));
  assert.ok(readied.messageIds.length >= 1);

  await rust(["task", "close", channel, "ship-docs", "--key", "task-close-other"], otherEnv);
  const notClosed = taskById(await listBoard(readerEnv), "ship-docs");
  assert.equal(notClosed.assertedState, "ready");
  assert.equal(notClosed.state, "ready");

  await rust(["task", "close", channel, "ship-docs", "--key", "task-close-reviewer"], reviewerEnv);
  const closedBoard = await listBoard(readerEnv);
  const closed = taskById(closedBoard, "ship-docs");
  assert.equal(closed.assertedState, "closed");
  assert.equal(closed.state, "closed");
  const unblocked = taskById(closedBoard, "follow-docs");
  assert.deepEqual(unblocked.blockedOn, []);
  assert.equal(unblocked.assertedState, "open");
  assert.equal(unblocked.state, "open");

  await rust(
    [
      "task",
      "ready",
      channel,
      "follow-docs",
      "--evidence",
      String(evidence.message.id),
      "--key",
      "task-ready-follow",
    ],
    ownerEnv,
  );
  await rust(["task", "close", channel, "follow-docs", "--key", "task-close-follow"], reviewerEnv);
  const followClosed = taskById(await listBoard(readerEnv), "follow-docs");
  assert.equal(followClosed.assertedState, "closed");
  assert.equal(followClosed.state, "closed");

  await rust(["delete", channel, String(evidence.message.id)], adminEnv);
  const afterEvidenceDelete = await listBoard(readerEnv);
  const shipAfterWipe = taskById(afterEvidenceDelete, "ship-docs");
  const followAfterWipe = taskById(afterEvidenceDelete, "follow-docs");
  assert.ok(shipAfterWipe.evidence.includes(evidence.message.id));
  assert.ok(shipAfterWipe.conflicts.includes("orphan-evidence"));
  assert.ok(warningCodes(afterEvidenceDelete).includes("unknown-evidence"));
  assert.equal(shipAfterWipe.assertedState, "closed");
  assert.equal(shipAfterWipe.state, "unknown");
  assertNeverCleanClosed(shipAfterWipe, "orphan-evidence after delete");
  assert.equal(followAfterWipe.assertedState, "closed");
  assert.equal(followAfterWipe.state, "unknown");
  assertNeverCleanClosed(followAfterWipe, "orphan-evidence after delete");

  const paged = await rust(["task", "list", channel, "--max-pages", "100", "--limit", "1"], readerEnv);
  assert.ok(paged.tasks.length <= 1);
  if (paged.hasMore) {
    const next = await rust(
      ["task", "list", channel, "--max-pages", "100", "--limit", "1", "--after", paged.nextCursor],
      readerEnv,
    );
    assert.ok(Array.isArray(next.tasks));
    if (next.tasks[0] && paged.tasks[0]) {
      assert.notEqual(next.tasks[0].id, paged.tasks[0].id);
    }
  }

  console.log(
    "PASS: isolated Worker + Rust critical trial covers start identity/no-cursor/exact continuation, peek/commit replay and per-reader isolation, show isolation/deletion/historyRevision, and task claim-conflict/ready/close/dependency visibility.",
  );
} finally {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
  await new Promise((resolve) =>
    server.exitCode !== null || server.signalCode !== null || !server.pid
      ? resolve()
      : server.once("exit", resolve),
  );
  await rm(dir, { recursive: true, force: true });
}
