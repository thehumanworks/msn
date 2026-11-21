/**
 * Product path (ADR 0069): an agent waits on every board at once with `msn wait --all`, the MCP
 * `wait_all` tool and the Node client, against a real local Worker. It wakes only for a message
 * addressed to it (one of several names counts), learns which board, and only that board's
 * progress moves. Archived boards are left out, and a board created while waiting is watched.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "msn-wait-all-integration-"));
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
  XDG_STATE_HOME: join(dir, "state"),
  ADMIN_TOKEN: "isolated-wait-all-test-admin-only",
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
async function ok(args) {
  const p = child(binary, args);
  const [code] = await p.done;
  assert.equal(code, 0, `msn ${args.join(" ")}: ${p.errors}`);
  return p.output.trim() ? JSON.parse(p.output) : null;
}
const send = async (channel, text, to = [], as = "human") =>
  (await ok(["--username", as, "send", channel, "--text", text, ...to.flatMap((n) => ["--to", n])])).message
    .id;
/** Starts `msn wait --all` for `name` and resolves once it has caught up and is polling events. */
const waiter = async (name) => {
  const p = child(binary, ["--username", name, "--reader", name, "wait", "--all", "--wait", "3"]);
  await delay(1500);
  return p;
};
const result = async (p) => {
  const [code] = await p.done;
  assert.equal(code, 0, p.errors);
  return JSON.parse(p.output);
};
const texts = (messages) => messages.map((m) => m.text);

/** One MCP tools/call over stdio for `name`, after the handshake. */
async function mcpTool(name, tool, args = {}) {
  const p = spawn(binary, ["--username", name, "--reader", name, "mcp"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(p);
  const replies = new Map();
  createInterface({ input: p.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    replies.get(message.id)?.(message);
  });
  const request = (id, method, params) => {
    p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve) => replies.set(id, resolve));
  };
  await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "wait-all-integration", version: "1" },
  });
  p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const reply = await request(2, "tools/call", { name: tool, arguments: args });
  p.stdin.end();
  await once(p, "exit");
  assert.equal(reply.result.isError, false, JSON.stringify(reply.result));
  return reply.result.structuredContent;
}

async function profile() {
  const folder = join(dir, "config", "msn", "profiles");
  const [file] = (await readdir(folder)).filter((name) => name.endsWith(".json"));
  return JSON.parse(await readFile(join(folder, file), "utf8"));
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
  await ok(["--username", "human", "login", "--create"]);
  for (const board of ["alpha", "beta", "gamma", "done"]) await ok(["create", board]);
  await send("alpha", "Hello everyone");
  await send("alpha", "For the worker only", ["worker"]);
  await send("done", "Stale ask on a finished board", ["reviewer"]);
  await ok(["board", "archive", "done"]);
  // The reviewer has read beta before; gamma and alpha have never been read.
  await send("beta", "Earlier beta note");
  await ok(["--username", "reviewer", "--reader", "reviewer", "read", "beta"]);

  // wait --all blocks through messages for others and to everyone, then wakes for a
  // message naming it among several, on whichever board.
  const reviewer = await waiter("reviewer");
  const tester = await waiter("tester");
  await send("beta", "Beta noise");
  await send("alpha", "Worker again", ["worker"]);
  await send("beta", "To the whole board");
  await delay(500);
  assert.equal(reviewer.exitCode, null, "noise does not end the wait");
  await send("gamma", "Gamma context");
  const ask = await send("gamma", "Please both check PR 9", ["reviewer", "tester"]);
  const got = await result(reviewer);
  assert.equal(got.channel, "gamma");
  assert.equal(got.message.id, ask);
  assert.deepEqual(got.message.recipients, ["reviewer", "tester"]);
  assert.deepEqual(texts(got.messages), ["Gamma context", "Please both check PR 9"]);
  assert.equal(got.nextCursor, ask);
  assert.equal((await result(tester)).message.id, ask, "the second name is woken too");
  console.log("PASS: wait --all wakes for a message to one of several names, with the board name");

  // Only gamma's cursor moved; alpha and beta start where they did, and the archived board was
  // never offered.
  await send("gamma", "After the ask");
  assert.deepEqual(
    texts((await ok(["--username", "reviewer", "--reader", "reviewer", "read", "gamma"])).messages),
    ["After the ask"],
  );
  assert.deepEqual(
    texts((await ok(["--username", "reviewer", "--reader", "reviewer", "read", "alpha"])).messages),
    ["Hello everyone", "For the worker only", "Worker again"],
  );
  assert.deepEqual(
    texts((await ok(["--username", "reviewer", "--reader", "reviewer", "read", "beta"])).messages),
    ["Beta noise", "To the whole board"],
  );
  console.log("PASS: only the woken board's cursor moves; archived boards are left out");

  // A board created while waiting is watched too.
  const late = await waiter("reviewer");
  await ok(["create", "fresh"]);
  const fresh = await send("fresh", "New board, new ask", ["Reviewer"]);
  const lateGot = await result(late);
  assert.equal(lateGot.channel, "fresh");
  assert.equal(lateGot.message.id, fresh, "names match ignoring case");
  console.log("PASS: a board created during the wait is watched");

  // MCP wait_all reads after processing progress and moves nothing: the same message comes back
  // until the agent peeks and commits that board.
  const first = await mcpTool("tester", "wait_all", { wait: 0 });
  assert.equal(first.matched, true);
  assert.equal(first.channel, "gamma");
  assert.equal(first.message.id, ask);
  assert.equal((await mcpTool("tester", "wait_all", { wait: 0 })).message.id, ask);
  const peeked = await mcpTool("tester", "peek", { channel: "gamma" });
  await mcpTool("tester", "commit", { channel: "gamma", through: peeked.nextCursor });
  assert.deepEqual(await mcpTool("tester", "wait_all", { wait: 1 }), { matched: false });
  const pending = mcpTool("tester", "wait_all", { wait: 10 });
  await delay(1500);
  const direct = await send("beta", "Tester, one more", ["tester"]);
  const woke = await pending;
  assert.equal(woke.channel, "beta");
  assert.equal(woke.message.id, direct);
  console.log("PASS: MCP wait_all follows processing progress and wakes on a new message");

  // The Node client keeps one cursor per board in its file and moves only the woken board's.
  const { tenant, token } = await profile();
  const nodeEnv = { ...env, MSN_WORKSPACE_TENANT: tenant, MSN_WORKSPACE_TOKEN: token };
  const file = join(dir, "boards.json");
  const node = () =>
    child(
      process.execPath,
      ["scripts/msn.mjs", "wait", "--all", "--cursor-file", file, "--username", "tester"],
      {
        env: nodeEnv,
      },
    );
  const replay = await result(node());
  assert.equal(replay.channel, "beta", "a first run replays history, board by board in name order");
  assert.equal(replay.message.id, direct);
  const again = await result(node());
  assert.equal(again.channel, "gamma");
  assert.equal(again.message.id, ask);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved.boards, { beta: direct, gamma: ask });
  const waitingNode = node();
  await delay(1500);
  const last = await send("alpha", "Node tester ask", ["tester"]);
  const nodeGot = await result(waitingNode);
  assert.equal(nodeGot.channel, "alpha");
  assert.equal(nodeGot.message.id, last);
  console.log("PASS: the Node client waits on all boards with a cursor per board");
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
