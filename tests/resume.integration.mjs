/**
 * Product path (ADR 0034): an agent's machine dies; a replacement on another machine takes over
 * explicitly, resumes from committed progress, and the old agent can no longer commit.
 * Two machines are two state directories sharing one saved profile, against a real local Worker.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "msn-resume-integration-"));
const server = createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
await new Promise((r) => server.close(r));
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
  HOME: dir,
  XDG_CONFIG_HOME: join(dir, "config"),
  XDG_STATE_HOME: join(dir, "state-old"),
  ADMIN_TOKEN: "isolated-resume-test-admin-only",
  WRANGLER_SEND_METRICS: "false",
};
for (const key of Object.keys(env)) if (key.startsWith("MSN_")) delete env[key];
env.MSN_URL = origin;
const binary = join(cwd, "cli/target/debug/msn");
const children = [];
function child(command, args, options = {}) {
  const p = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], ...options });
  p.output = "";
  p.errors = "";
  p.stdout?.on("data", (b) => (p.output += b));
  p.stderr?.on("data", (b) => (p.errors += b));
  p.done = once(p, "exit");
  children.push(p);
  return p;
}
/** Runs the CLI on one "machine" and returns { code, json, errors }. */
async function run(machine, args) {
  const p = child(binary, args, {
    env: { ...env, XDG_STATE_HOME: join(dir, `state-${machine}`), MSN_RESUMABLE: "1" },
  });
  const [code] = await p.done;
  return { code, json: p.output.trim() ? JSON.parse(p.output) : null, errors: p.errors };
}
async function ok(machine, args) {
  const result = await run(machine, args);
  assert.equal(result.code, 0, `${machine}: msn ${args.join(" ")}: ${result.errors}`);
  return result.json;
}

let worker;
try {
  worker = child(
    join(cwd, "node_modules/.bin/wrangler"),
    ["dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(dir, "worker")],
    { detached: true },
  );
  const end = Date.now() + 20000;
  while (true) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) break;
    } catch {}
    if (Date.now() > end) throw new Error(`worker startup: ${worker.errors.slice(-3000)}`);
    await delay(25);
  }
  await ok("old", ["--username", "human", "login", "--create"]);
  for (const text of ["task 1", "task 2", "task 3"]) await ok("old", ["send", "general", "--text", text]);

  // The first agent works through task 1, commits, then fetches task 2 and its machine dies.
  const first = await ok("old", ["peek", "general", "--limit", "1"]);
  assert.equal(first.generation, 1);
  assert.deepEqual(
    first.messages.map((m) => m.text),
    ["task 1"],
  );
  await ok("old", ["commit", "general", "--through", String(first.nextCursor)]);
  const inFlight = await ok("old", ["peek", "general", "--limit", "1"]);
  assert.deepEqual(
    inFlight.messages.map((m) => m.text),
    ["task 2"],
  );
  console.log("PASS: first agent claims the reader and commits on the server");

  // A replacement never takes over silently.
  const held = await run("new", ["peek", "general"]);
  assert.equal(held.code, 5, held.errors);
  assert.match(held.errors, /msn takeover general --reader 'human'/);
  const taken = await ok("new", ["takeover", "general"]);
  assert.deepEqual(
    { generation: taken.generation, previousGeneration: taken.previousGeneration },
    { generation: 2, previousGeneration: 1 },
  );
  assert.equal(taken.committedThrough, first.nextCursor);
  const resumed = await ok("new", ["peek", "general"]);
  assert.deepEqual(
    resumed.messages.map((m) => m.text),
    ["task 2", "task 3"],
    "the replacement resumes after committed progress: nothing skipped, nothing before it replayed",
  );
  console.log("PASS: explicit takeover resumes from committed progress on a new machine");

  // The old agent comes back: it can neither commit nor peek any more.
  const stale = await run("old", ["commit", "general", "--through", String(inFlight.nextCursor)]);
  assert.equal(stale.code, 5, stale.errors);
  assert.match(stale.errors, /This agent was replaced/);
  const stalePeek = await run("old", ["peek", "general"]);
  assert.equal(stalePeek.code, 5, stalePeek.errors);
  const done = await ok("new", ["commit", "general", "--through", String(resumed.nextCursor)]);
  assert.equal(done.committedThrough, resumed.nextCursor);
  const empty = await ok("new", ["peek", "general"]);
  assert.deepEqual(empty.messages, []);
  console.log("PASS: the replaced agent is fenced out; the replacement commits");
} finally {
  for (const p of children)
    if (p.exitCode === null) {
      try {
        if (p === worker) process.kill(-p.pid, "SIGTERM");
        else p.kill("SIGTERM");
      } catch {}
    }
  await rm(dir, { recursive: true, force: true });
}
