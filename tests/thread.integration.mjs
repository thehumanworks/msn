/**
 * Product path (ADR 0063): an agent follows one thread with msn poll, peek/commit, wait, follow,
 * the MCP peek tool and plain HTTP, against a real local Worker. It sees only the thread's root
 * and replies (nested ones too), waits only for new replies there, and its thread cursors never
 * move its board progress on the server or its board read cursor.
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
const dir = await mkdtemp(join(tmpdir(), "msn-thread-integration-"));
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
  ADMIN_TOKEN: "isolated-thread-test-admin-only",
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

/** One MCP tools/call over stdio on a machine with MSN_RESUMABLE set, after the handshake. */
async function mcpTool(machine, name, args = {}) {
  const p = spawn(binary, ["mcp", "--channel", "general"], {
    cwd,
    env: { ...env, XDG_STATE_HOME: join(dir, `state-${machine}`), MSN_RESUMABLE: "1" },
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
    clientInfo: { name: "thread-integration", version: "1" },
  });
  p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const reply = await request(2, "tools/call", { name, arguments: args });
  p.stdin.end();
  await once(p, "exit");
  return reply.result;
}

/** The saved profile's workspace key and tenant, for plain HTTP reads like a curl agent's. */
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
  await ok("a", ["--username", "human", "login", "--create"]);
  const send = async (text, replyTo) =>
    (await ok("a", ["send", "general", "--text", text, ...(replyTo ? ["--reply-to", String(replyTo)] : [])]))
      .message.id;
  const root = await send("Plan the release");
  await send("Unrelated chatter");
  const reply = await send("Tests pass", root);
  const nested = await send("Which suite?", reply);
  const other = await send("Another topic");
  await send("On the other topic", other);
  const texts = (page) => page.messages.map((m) => m.text);

  // Poll and plain HTTP: only the thread, in id order, nested replies included; a reply id
  // names its thread.
  const polled = await ok("a", ["poll", "general", "--thread", String(nested)]);
  assert.deepEqual(texts(polled), ["Plan the release", "Tests pass", "Which suite?"]);
  assert.equal(polled.thread, root);
  const { tenant, token } = await profile();
  const http = await fetch(
    `${origin}/api/tenants/${tenant}/channels/general/messages?thread=${root}&after=${reply}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(http.status, 200);
  assert.deepEqual(texts(await http.json()), ["Which suite?"]);
  console.log("PASS: poll --thread returns the root and every reply, nested ones too");

  // Board progress on the server first, so we can prove the thread never moves it.
  const board = await ok("a", ["peek", "general", "--limit", "1"]);
  assert.equal(board.generation, 1);
  await ok("a", ["commit", "general", "--through", String(board.nextCursor)]);
  const thread = await ok("a", ["peek", "general", "--thread", String(root)]);
  assert.deepEqual(texts(thread), ["Plan the release", "Tests pass", "Which suite?"]);
  assert.equal(thread.generation, undefined, "thread progress is never on the server");
  const committed = await ok("a", [
    "commit",
    "general",
    "--thread",
    String(root),
    "--through",
    String(thread.nextCursor),
  ]);
  assert.equal(committed.committedThrough, nested);
  const again = await ok("a", ["peek", "general", "--thread", String(root)]);
  assert.deepEqual(again.messages, []);
  const boardAgain = await ok("a", ["peek", "general", "--limit", "1"]);
  assert.equal(boardAgain.committedThrough, board.nextCursor, "board progress is unchanged");
  assert.deepEqual(texts(boardAgain), ["Unrelated chatter"]);
  const resumable = await run("a", ["peek", "general", "--thread", String(root), "--resumable"]);
  assert.equal(resumable.code, 2, "--thread keeps progress local, so --resumable is refused");
  console.log("PASS: peek/commit --thread keep their own progress and never move the board's");

  // wait --thread blocks through board noise and other threads, and keeps its own cursor.
  const first = await ok("a", ["wait", "general", "--thread", String(root), "--wait", "2"]);
  assert.deepEqual(texts(first), ["Plan the release", "Tests pass", "Which suite?"]);
  const waiting = child(binary, ["wait", "general", "--thread", String(root), "--wait", "5"], {
    env: { ...env, XDG_STATE_HOME: join(dir, "state-a"), MSN_RESUMABLE: "1" },
  });
  await delay(1000);
  await send("Board noise");
  await send("Reply elsewhere", other);
  assert.equal(waiting.exitCode, null, "board noise and other threads do not end the wait");
  const deep = await send("The full suite", nested);
  const [code] = await waiting.done;
  assert.equal(code, 0, waiting.errors);
  assert.deepEqual(texts(JSON.parse(waiting.output)), ["The full suite"]);
  // The board's own wait cursor did not move: it starts at the first message.
  const boardWait = await ok("a", ["wait", "general", "--limit", "1"]);
  assert.deepEqual(texts(boardWait), ["Plan the release"]);
  console.log("PASS: wait --thread wakes only for replies in the thread, with its own cursor");

  // follow --thread from a cursor prints only thread messages, one per line.
  const following = child(
    binary,
    ["follow", "general", "--thread", String(root), "--after", String(nested), "--once"],
    { env: { ...env, XDG_STATE_HOME: join(dir, "state-a") } },
  );
  const [followCode] = await following.done;
  assert.equal(followCode, 0, following.errors);
  assert.deepEqual(
    following.output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).id),
    [deep],
  );
  console.log("PASS: follow --thread prints only the thread");

  // MCP peek and commit take thread too, and share progress with msn peek --thread.
  const tool = await mcpTool("a", "peek", { thread: root });
  assert.equal(tool.isError, false, JSON.stringify(tool));
  assert.deepEqual(texts(tool.structuredContent), ["The full suite"]);
  const toolCommit = await mcpTool("a", "commit", {
    thread: root,
    through: tool.structuredContent.nextCursor,
  });
  assert.equal(toolCommit.isError, false, JSON.stringify(toolCommit));
  assert.deepEqual((await ok("a", ["peek", "general", "--thread", String(root)])).messages, []);
  console.log("PASS: MCP peek and commit follow one thread");
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
