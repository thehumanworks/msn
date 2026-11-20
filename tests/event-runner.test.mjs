import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { acquireCheckpoint, dispatchKey, parseArgs, validatePage } from "../scripts/event-runner.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/event-runner.mjs", import.meta.url));
const TOKEN = "runner-test-credential-never-log";
const binding = { server: "https://msn.example", tenant: "team", channel: "work", reader: "reviewer" };
const event = (id, resourceId = id, type = "message.created") => ({
  id,
  tenant: "team",
  channel: "work",
  type,
  resourceId,
  historyRevision: 0,
  createdAt: "2026-09-20T10:00:00.000Z",
});
const message = (id, fields = {}) => ({
  id,
  tenant: "team",
  channel: "work",
  username: "planner",
  text: "Review the patch",
  contentType: "text/plain",
  to: "reviewer",
  ...fields,
});
const handlerSource = `import {appendFile} from 'node:fs/promises'; let raw=''; for await (const c of process.stdin) raw+=c; const input=JSON.parse(raw); await appendFile(process.argv[2], JSON.stringify({input,key:process.env.MSN_IDEMPOTENCY_KEY,arg:process.argv[4],hasAdmin:!!process.env.MSN_ADMIN_TOKEN,hasProfile:!!process.env.MSN_PROFILE})+'\\n'); console.error(process.env.MSN_WORKSPACE_TOKEN); if (process.argv[3]==='wait') await new Promise(r=>setTimeout(r,60000)); else process.exit(Number(process.argv[3]||0));`;

async function fixture(t, events = [], messages = {}) {
  const dir = await mkdtemp(join(tmpdir(), "msn-event-runner-test-"));
  const output = join(dir, "handled.jsonl");
  const handler = join(dir, "handler.mjs");
  const state = join(dir, "checkpoint.json");
  await writeFile(handler, handlerSource);
  const requests = [];
  const config = { eventStatus: 200, identityStatus: 200, page: null, events, messages, archived: false };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push(url.pathname + url.search);
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/tenants/team") {
      res.writeHead(config.identityStatus);
      return res.end(JSON.stringify({ tenant: "team", username: "reviewer", usernamePrefix: null }));
    }
    if (url.pathname === "/api/tenants/team/events") {
      assert.equal(url.searchParams.get("channel"), "work");
      const after = Number(url.searchParams.get("after"));
      const remaining = config.events.filter((e) => e.id > after);
      res.writeHead(config.eventStatus);
      return res.end(
        JSON.stringify(
          config.page ?? { events: remaining, nextCursor: remaining.at(-1)?.id ?? after, hasMore: false },
        ),
      );
    }
    if (url.pathname === "/api/tenants/team/channels/work/messages") {
      // The archive probe (ADR 0046): an empty page that says whether the board is archived.
      return res.end(
        JSON.stringify({
          messages: [],
          nextCursor: 0,
          hasMore: false,
          ...(config.archived ? { archived: true } : {}),
        }),
      );
    }
    const id = Number(url.pathname.split("/").at(-1));
    const row = config.messages[id];
    if (row === "deleted") {
      res.writeHead(410);
      return res.end('{"error":{"code":"message_deleted"}}');
    }
    if (!row) {
      res.writeHead(404);
      return res.end("{}");
    }
    res.end(JSON.stringify({ message: row, historyRevision: 0 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  function start({ code = "0", extra = [], argument = "literal", onceFlag = true } = {}) {
    const args = [
      SCRIPT,
      "--channel",
      "work",
      "--state-file",
      state,
      "--attempts",
      "1",
      ...(onceFlag ? ["--once", "--wait", "0"] : []),
      ...extra,
      "--",
      process.execPath,
      handler,
      output,
      code,
      argument,
    ];
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MSN_URL: origin,
        MSN_WORKSPACE_TENANT: "team",
        MSN_WORKSPACE_TOKEN: TOKEN,
        MSN_PROFILE: "",
        MSN_USERNAME: "",
        MSN_ADMIN_TOKEN: "do-not-inherit-admin",
      },
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (x) => {
      stdout += x;
    });
    child.stderr.on("data", (x) => {
      stderr += x;
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 10000);
    const done = once(child, "close").then(([code, signal]) => {
      clearTimeout(timeout);
      return { code, signal, stdout, stderr };
    });
    return { child, done };
  }
  const records = async () => {
    try {
      return (await readFile(output, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((x) => JSON.parse(x));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  return { dir, origin, config, state, requests, records, start };
}

// Invariants are tested against real local HTTP and executable children, never model mocks.
test("argument validation requires an isolated checkpoint and explicit executable", () => {
  const valid = ["--channel", "work", "--state-file", "state", "--", "node", "handler.mjs"];
  assert.equal(parseArgs(valid, {}).wait, 25);
  assert.throws(() => parseArgs(["--channel", "work", "--", "node"], {}), /state-file/);
  assert.throws(() => parseArgs(["--channel", "work", "--state-file", "state"], {}), /handler/);
  assert.throws(() => parseArgs(["--wait", "0", ...valid], {}), /positive/);
  assert.throws(() => parseArgs(["--attempts", "11", ...valid], {}), /attempts/);
  assert.equal(parseArgs(["--profile", "review", ...valid], { MSN_USERNAME: "stale" }).username, "");
  assert.equal(
    parseArgs(["--profile", "review", "--username", "explicit", ...valid], { MSN_USERNAME: "stale" })
      .username,
    "explicit",
  );
});

test("event validation rejects foreign streams, malformed ids and invalid continuation", () => {
  const good = { events: [event(2)], nextCursor: 2, hasMore: false };
  assert.deepEqual(validatePage(good, binding, 1), good.events);
  for (const mutate of [
    (p) => {
      p.events[0].tenant = "foreign";
    },
    (p) => {
      p.events[0].channel = "elsewhere";
    },
    (p) => {
      p.events[0].id = 1;
    },
    (p) => {
      p.events[0].id = Number.MAX_SAFE_INTEGER + 1;
    },
    (p) => {
      p.events[0].resourceId = 0;
    },
    (p) => {
      p.events[0].type = "execute";
    },
    (p) => {
      p.events[0].historyRevision = -1;
    },
    (p) => {
      p.nextCursor = 3;
    },
    (p) => {
      p.events = [];
      p.hasMore = true;
      p.nextCursor = 1;
    },
  ]) {
    const bad = structuredClone(good);
    mutate(bad);
    assert.throws(() => validatePage(bad, binding, 1));
  }
});

test("checkpoint locks, monotonicity, permissions, and complete stream binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "msn-checkpoint-test-"));
  const file = join(dir, "cursor.json");
  const checkpoint = await acquireCheckpoint(file, binding);
  await assert.rejects(acquireCheckpoint(file, binding), /locked/);
  await checkpoint.commit(12);
  await assert.rejects(checkpoint.commit(11), /advance/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await checkpoint.close();
  const resumed = await acquireCheckpoint(file, binding);
  assert.equal(resumed.after, 12);
  await resumed.close();
  for (const field of ["server", "tenant", "channel", "reader"])
    await assert.rejects(acquireCheckpoint(file, { ...binding, [field]: "other" }), /invalid|different/);
  const alias = join(dir, "alias.json");
  await symlink(file, alias);
  await assert.rejects(acquireCheckpoint(alias, binding), /invalid/);
  assert.equal(JSON.parse(await readFile(file)).after, 12);
});

test("dispatch keys survive restart and distinguish origins/readers/events", () => {
  assert.equal(dispatchKey(binding, 9), dispatchKey(structuredClone(binding), 9));
  assert.notEqual(dispatchKey(binding, 9), dispatchKey(binding, 10));
  assert.notEqual(dispatchKey(binding, 9), dispatchKey({ ...binding, server: "https://other.example" }, 9));
  assert.notEqual(dispatchKey(binding, 9), dispatchKey({ ...binding, reader: "other" }, 9));
});

test("only addressed non-self messages invoke the handler; argv is literal and secrets suppressed", async (t) => {
  const f = await fixture(t, [event(1, null, "channel.created"), ...[2, 3, 4, 5].map((id) => event(id))], {
    2: message(2, { username: "reviewer" }),
    3: message(3, { to: "another-agent" }),
    4: message(4),
    5: message(5, { to: undefined }),
  });
  const literal = "$(touch /tmp/THIS_MUST_NOT_EXECUTE); echo hello";
  const result = await f.start({ argument: literal }).done;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!result.stderr.includes(TOKEN));
  assert.ok(!result.stdout.includes(TOKEN));
  const records = await f.records();
  assert.equal(records.length, 1);
  assert.equal(records[0].input.schema, "msn.dispatch.v1");
  assert.equal(records[0].input.message.id, 4);
  assert.equal(records[0].arg, literal);
  assert.equal(records[0].hasAdmin, false);
  assert.equal(records[0].hasProfile, false);
  assert.equal(JSON.parse(await readFile(f.state)).after, 5);
  assert.equal((await f.start().done).code, 0);
  assert.equal((await f.records()).length, 1);
});

test("broadcast handling is explicit opt-in", async (t) => {
  const f = await fixture(t, [event(1)], { 1: message(1, { to: undefined }) });
  assert.equal((await f.start({ extra: ["--include-broadcast"] }).done).code, 0);
  assert.equal((await f.records()).length, 1);
});

test("failed handler leaves failed event unacknowledged and restart reuses idempotency key", async (t) => {
  const f = await fixture(t, [event(1, null, "channel.created"), event(2, 90)], { 90: message(90) });
  const failed = await f.start({ code: "7" }).done;
  assert.equal(failed.code, 1);
  assert.equal(JSON.parse(await readFile(f.state)).after, 1);
  const success = await f.start().done;
  assert.equal(success.code, 0, success.stderr);
  const records = await f.records();
  assert.equal(records.length, 2);
  assert.equal(records[0].key, records[1].key);
  assert.equal(JSON.parse(await readFile(f.state)).after, 2);
});

test("redacted canonical message is never dispatched", async (t) => {
  const f = await fixture(t, [event(1, 9), event(2, 9, "message.deleted")], { 9: "deleted" });
  const result = await f.start().done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.records()).length, 0);
  assert.equal(JSON.parse(await readFile(f.state)).after, 2);
});

test("authentication loss stops without advancing checkpoint", async (t) => {
  const f = await fixture(t, [event(1)], { 1: message(1) });
  f.config.eventStatus = 401;
  const result = await f.start().done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /401/);
  await assert.rejects(readFile(f.state), { code: "ENOENT" });
  assert.equal((await f.records()).length, 0);
  await assert.rejects(stat(`${f.state}.lock`), { code: "ENOENT" });
});

test("an archived board stops the dispatcher with exit 5 after the last event is handled", async (t) => {
  const f = await fixture(t, [event(1)], { 1: message(1) });
  f.config.archived = true;
  const result = await f.start({ onceFlag: false, extra: ["--wait", "1"] }).done;
  assert.equal(result.code, 5);
  assert.match(result.stderr, /board_archived/);
  assert.match(result.stderr, /msn board unarchive work/);
  // The pending event was handled and acknowledged before the dispatcher stopped.
  assert.equal((await f.records()).length, 1);
  assert.equal(JSON.parse(await readFile(f.state, "utf8")).after, 1);
});

test("an active board keeps the dispatcher waiting after an empty page", async (t) => {
  const f = await fixture(t, [], {});
  const run = f.start({ onceFlag: false, extra: ["--wait", "1"] });
  await delay(500);
  assert.equal(run.child.exitCode, null);
  run.child.kill("SIGTERM");
  assert.equal((await run.done).code, 130);
  assert.ok(f.requests.some((r) => r.startsWith("/api/tenants/team/channels/work/messages?")));
});

test("foreign canonical message is rejected before invoking handler", async (t) => {
  const f = await fixture(t, [event(1)], { 1: message(1, { tenant: "foreign" }) });
  const result = await f.start().done;
  assert.equal(result.code, 1);
  assert.equal((await f.records()).length, 0);
  await assert.rejects(readFile(f.state), { code: "ENOENT" });
});

test("invalid page cursor cannot acknowledge or launch any event", async (t) => {
  const f = await fixture(t, [event(1)], { 1: message(1) });
  f.config.page = { events: [event(1)], nextCursor: 800, hasMore: false };
  const result = await f.start().done;
  assert.equal(result.code, 1);
  assert.equal((await f.records()).length, 0);
  await assert.rejects(readFile(f.state), { code: "ENOENT" });
});

test("handler timeout preserves cursor and releases reader lock", async (t) => {
  const f = await fixture(t, [event(1)], { 1: message(1) });
  const result = await f.start({ code: "wait", extra: ["--handler-timeout-ms", "300"] }).done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /timed out/);
  await assert.rejects(readFile(f.state), { code: "ENOENT" });
  await assert.rejects(stat(`${f.state}.lock`), { code: "ENOENT" });
});

test("SIGTERM during a handler stops the process without acknowledging input", async (t) => {
  const f = await fixture(t, [event(1)], { 1: message(1) });
  const running = f.start({ code: "wait" });
  for (let n = 0; n < 100 && (await f.records()).length === 0; n += 1) await delay(20);
  assert.equal((await f.records()).length, 1);
  running.child.kill("SIGTERM");
  const result = await running.done;
  assert.equal(result.code, 130);
  await assert.rejects(readFile(f.state), { code: "ENOENT" });
  await assert.rejects(stat(`${f.state}.lock`), { code: "ENOENT" });
});

test("HTTP redirect is not followed with workspace credentials", async (t) => {
  let targetHits = 0;
  const target = createServer((_req, res) => {
    targetHits += 1;
    res.end("{}");
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const source = createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/capture` });
    res.end();
  });
  source.listen(0, "127.0.0.1");
  await once(source, "listening");
  t.after(() => {
    target.closeAllConnections();
    target.close();
    source.closeAllConnections();
    source.close();
  });
  const child = spawn(
    process.execPath,
    [
      SCRIPT,
      "--channel",
      "work",
      "--state-file",
      join(tmpdir(), "unused-checkpoint"),
      "--once",
      "--",
      "node",
    ],
    {
      env: {
        ...process.env,
        MSN_PROFILE: "",
        MSN_URL: `http://127.0.0.1:${source.address().port}`,
        MSN_WORKSPACE_TENANT: "team",
        MSN_WORKSPACE_TOKEN: TOKEN,
      },
      stdio: "ignore",
    },
  );
  const [code] = await once(child, "close");
  assert.equal(code, 1);
  assert.equal(targetHits, 0);
});
