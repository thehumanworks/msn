import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
// Opt-in real-Worker/Rust/Node contract test. All state and credentials are local fixtures.
const cwd = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "msn-improve-e2e-"));
const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const url = `http://127.0.0.1:${port}`;
const admin = "isolated-local-e2e-admin-0000000000000000";
const baseEnv = {
  PATH: process.env.PATH,
  HOME: dir,
  XDG_CONFIG_HOME: join(dir, "config"),
  XDG_STATE_HOME: join(dir, "state"),
  MSN_URL: url,
  MSN_WORKSPACE_TENANT: "review-team",
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
server.stdout.on("data", (b) => {
  serverLog = (serverLog + b).slice(-16000);
});
server.stderr.on("data", (b) => {
  serverLog = (serverLog + b).slice(-16000);
});
async function rust(args, overrides = {}) {
  const result = await exec(join(cwd, "cli/target/debug/msn"), args, {
    cwd,
    env: { ...baseEnv, ...overrides },
    timeout: 10000,
  });
  return JSON.parse(result.stdout);
}
async function node(args, overrides = {}) {
  const result = await exec(process.execPath, ["scripts/msn.mjs", ...args], {
    cwd,
    env: { ...baseEnv, ...overrides },
    timeout: 10000,
  });
  return JSON.parse(result.stdout);
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
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, `local worker failed to start: ${serverLog.slice(-1000)}`);
  const adminEnv = { MSN_ADMIN_TOKEN: admin };
  const workspace = await rust(["provision", "review-team", "--username", "bootstrap"], adminEnv);
  const human = await rust(["key-create", "tomas", "--username", "Tomas"], adminEnv);
  const planner = await rust(["key-create", "planner", "--username", "planner-agent"], adminEnv);
  const reviewer = await node(["key-create", "reviewer", "--username", "review-agent"], adminEnv);
  // No duplicate username configuration: all clients infer each key's exact binding.
  const humanEnv = { MSN_WORKSPACE_TOKEN: human.token };
  const plannerEnv = { MSN_WORKSPACE_TOKEN: planner.token };
  const reviewerEnv = { MSN_WORKSPACE_TOKEN: reviewer.token };
  assert.equal((await node(["whoami"], plannerEnv)).username, "planner-agent");
  const question = await rust(
    [
      "send",
      "general",
      "--to",
      "planner-agent",
      "--text",
      "Please review task 7",
      "--key",
      "request-7",
      "--correlation-id",
      "task-7",
    ],
    humanEnv,
  );
  assert.equal(question.message.to, "planner-agent");
  assert.equal(question.message.username, "Tomas");
  await rust(["profile", "save", "planner"], plannerEnv);
  await rust(["profile", "save", "reviewer"], reviewerEnv);
  const staleEnv = {
    MSN_URL: "https://wrong.invalid",
    MSN_WORKSPACE_TENANT: "wrong-workspace",
    MSN_WORKSPACE_TOKEN: "wrong-token",
    MSN_USERNAME: "wrong-user",
    MSN_READER: "wrong-reader",
  };
  for (const profile of ["planner", "reviewer"]) {
    const first = await rust(["--profile", profile, "read", "general"], staleEnv);
    assert.equal(first.messages[0].to, "planner-agent", "addressing preserves channel fan-out");
    const empty = await rust(["--profile", profile, "read", "general", "--wait", "0"], staleEnv);
    assert.deepEqual(empty.messages, []);
    assert.equal(empty.nextCursor, question.message.id);
  }
  const firstA = await rust(["wait", "general", "--reader", "planner"], plannerEnv);
  const firstB = await rust(["wait", "general", "--reader", "reviewer"], reviewerEnv);
  assert.deepEqual(
    firstA.messages.map((m) => m.id),
    [question.message.id],
  );
  assert.deepEqual(
    firstB.messages.map((m) => m.id),
    [question.message.id],
  );
  const reply = await rust(
    [
      "send",
      "general",
      "--to",
      "Tomas",
      "--text",
      "Reviewed",
      "--key",
      "reply-7",
      "--reply-to",
      String(question.message.id),
      "--correlation-id",
      "task-7",
    ],
    plannerEnv,
  );
  assert.equal(reply.message.to, "Tomas");
  const replay = await rust(
    [
      "--profile",
      "planner",
      "send",
      "general",
      "--to",
      "Tomas",
      "--text",
      "Reviewed",
      "--key",
      "reply-7",
      "--reply-to",
      String(question.message.id),
      "--correlation-id",
      "task-7",
    ],
    staleEnv,
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.message.id, reply.message.id);
  await assert.rejects(
    rust(
      [
        "--profile",
        "planner",
        "send",
        "general",
        "--to",
        "review-agent",
        "--text",
        "Reviewed",
        "--key",
        "reply-7",
        "--reply-to",
        String(question.message.id),
        "--correlation-id",
        "task-7",
      ],
      staleEnv,
    ),
    (e) => e.code === 5,
  );
  for (const [name, env] of [
    ["planner", plannerEnv],
    ["reviewer", reviewerEnv],
  ]) {
    const next = await rust(["wait", "general", "--reader", name], env);
    assert.deepEqual(
      next.messages.map((m) => m.id),
      [reply.message.id],
    );
  }
  await assert.rejects(
    rust(["send", "general", "--text", "spoof", "--username", "Tomas"], plannerEnv),
    (e) => e.code === 3,
  );
  const listed = await rust(["keys"], adminEnv);
  assert.equal(listed.keys.length, 3);
  assert.ok(listed.keys.every((k) => !("token" in k) && !("token_hash" in k)));
  const pending = fetch(
    `${url}/api/tenants/review-team/channels/general/messages?after=${reply.message.id}&wait=25`,
    { headers: { Authorization: `Bearer ${planner.token}` } },
  );
  await new Promise((r) => setTimeout(r, 100));
  await rust(["key-revoke", "planner"], adminEnv);
  assert.equal((await pending).status, 401);
  await assert.rejects(rust(["whoami"], plannerEnv), (e) => e.code === 3);
  assert.equal((await rust(["whoami"], humanEnv)).username, "Tomas");
  // Both installed clients honor the same canonical lock protocol.
  const file = join(dir, "shared-cursor.json");
  const follow = spawn(join(cwd, "cli/target/debug/msn"), ["follow", "general", "--cursor-file", file], {
    cwd,
    env: { ...baseEnv, ...reviewerEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  follow.stdout.on("data", (b) => {
    output += b;
  });
  follow.stderr.resume();
  const stopped = new Promise((r) => follow.once("exit", (code, signal) => r({ code, signal })));
  try {
    for (let i = 0; i < 100 && !output; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(output);
    await assert.rejects(node(["follow", "general", "--cursor-file", file], reviewerEnv), (e) =>
      /Cursor is locked/.test(e.stderr),
    );
    follow.kill("SIGTERM");
    assert.equal((await stopped).code, 0);
    await assert.rejects(access(`${file}.lock`), { code: "ENOENT" });
  } finally {
    if (follow.exitCode === null) follow.kill("SIGTERM");
    await stopped;
  }
  const rotated = await rust(["rotate", "review-team"], adminEnv);
  assert.notEqual(rotated.token, workspace.token);
  await assert.rejects(rust(["whoami"], humanEnv), (e) => e.code === 3);
  await assert.rejects(rust(["whoami"], reviewerEnv), (e) => e.code === 3);
  assert.deepEqual((await rust(["keys"], adminEnv)).keys, []);
  console.log(
    "PASS: real local Worker + Rust/Node inferred identity, profiles ignoring stale env, bounded reads, addressed fan-out/replies/retries, shared-HOME reader isolation, revocation, cross-CLI locks, signals and rotation.",
  );
} finally {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
  await new Promise((r) =>
    server.exitCode !== null || server.signalCode !== null || !server.pid ? r() : server.once("exit", r),
  );
  await rm(dir, { recursive: true, force: true });
}
