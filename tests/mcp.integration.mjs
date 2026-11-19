/** Product path: `msn mcp` over stdio, driven as an MCP client would, against a real local Worker. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "msn-mcp-integration-"));
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
  ADMIN_TOKEN: "isolated-mcp-test-admin-only",
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
async function cli(args) {
  const p = child(binary, args);
  const [code] = await p.done;
  assert.equal(code, 0, `CLI ${args.join(" ")}: ${p.errors}`);
  return JSON.parse(p.output);
}

/** A minimal MCP stdio client: newline-delimited JSON-RPC, responses matched by id. */
function mcp(profile) {
  const p = spawn(binary, ["--profile", profile, "mcp", "--channel", "work"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  p.errors = "";
  p.stderr.on("data", (b) => (p.errors += b));
  p.done = once(p, "exit");
  children.push(p);
  const pending = new Map();
  let next = 1;
  createInterface({ input: p.stdout }).on("line", (line) => {
    const message = JSON.parse(line); // stdout must carry only JSON-RPC
    assert.equal(message.jsonrpc, "2.0");
    const waiter = pending.get(message.id);
    assert.ok(waiter, `Unexpected message: ${line}`);
    pending.delete(message.id);
    waiter(message);
  });
  const request = (method, params) => {
    const id = next++;
    p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve) => pending.set(id, resolve));
  };
  return {
    process: p,
    request,
    notify: (method) => p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`),
    async tool(name, args = {}) {
      const reply = await request("tools/call", { name, arguments: args });
      assert.ok(reply.result, JSON.stringify(reply));
      return reply.result;
    },
    async ok(name, args) {
      const result = await this.tool(name, args);
      assert.equal(result.isError, false, `${name}: ${result.content?.[0]?.text}`);
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      return result.structuredContent;
    },
    async close() {
      p.stdin.end();
      const [code] = await p.done;
      assert.equal(code, 0, p.errors);
    },
  };
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
  await cli(["--username", "human", "login", "--create"]);
  await cli(["board", "create", "work", "--goal", "Ship the MCP tools", "--save-as", "lead"]);
  await cli(["--profile", "lead", "persona", "add", "work", "reviewer", "--save-as", "reviewer"]);

  const lead = mcp("lead");
  const init = await lead.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "integration", version: "1" },
  });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "msn");
  lead.notify("notifications/initialized");
  const { result } = await lead.request("tools/list", {});
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ["start", "catch_up", "send", "peek", "commit", "show_message", "board", "label", "find", "wait_label"],
  );

  const entered = await lead.ok("start");
  assert.equal(entered.board.goal, "Ship the MCP tools");
  assert.equal(entered.identity.sharedChannel, true);
  assert.equal(entered.identity.username, "lead");
  assert.equal((await lead.ok("board")).board.goal, "Ship the MCP tools");
  console.log("PASS: initialize, tools/list, start and board over stdio");

  // A blocked peek must return on the new message, without sleeping out its 25 seconds.
  const reviewer = mcp("reviewer");
  await reviewer.request("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
  const waiting = reviewer.ok("peek", { wait: 25 });
  await delay(300);
  const started = Date.now();
  const sent = await lead.ok("send", { text: "please review", key: "mcp-review-1" });
  assert.equal(sent.idempotencyKey, "mcp-review-1");
  const page = await waiting;
  assert.ok(Date.now() - started < 5000, "peek returned on the new message");
  assert.deepEqual(
    page.messages.map((m) => [m.text, m.username]),
    [["please review", "lead"]],
  );
  assert.equal(page.committedThrough, 0);
  console.log("PASS: a waiting peek wakes on a send from another MCP session");

  // Same key and bytes after an uncertain result: still one message.
  const replay = await lead.ok("send", { text: "please review", key: "mcp-review-1" });
  assert.equal(replay.message.id, sent.message.id);
  const ahead = await reviewer.tool("commit", { through: page.nextCursor + 1 });
  assert.equal(ahead.isError, true);
  const committed = await reviewer.ok("commit", { through: page.nextCursor });
  assert.equal(committed.committedThrough, page.nextCursor);
  const evidence = await reviewer.ok("show_message", { id: sent.message.id });
  assert.equal(evidence.message.text, "please review");
  await reviewer.ok("send", { text: "approved", replyTo: sent.message.id, to: "lead" });
  const empty = await reviewer.ok("peek", { wait: 0 });
  assert.deepEqual(
    empty.messages.map((m) => m.text),
    ["approved"],
    "peek resumes after committed progress",
  );
  await reviewer.close();
  await lead.close();

  const history = await cli(["--profile", "lead", "poll", "work", "--after", "0"]);
  assert.equal(history.messages.filter((m) => m.text === "please review").length, 1);
  const reply = history.messages.find((m) => m.text === "approved");
  assert.equal(reply.replyTo, sent.message.id);
  assert.equal(reply.username, "reviewer");
  console.log("PASS: idempotent send, commit bounds, evidence, replies and clean EOF shutdown");

  // Labels (ADR 0032): send with labels, claim with a condition, filter, and wait for a change.
  const labeler = mcp("lead");
  await labeler.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const task = await labeler.ok("send", { text: "fix the parser", labels: { state: "open", area: "cli" } });
  assert.deepEqual(task.message.labels, { area: "cli", state: "open" });
  const claimed = await labeler.ok("label", {
    id: task.message.id,
    set: { owner: "lead" },
    if: { owner: null },
  });
  assert.equal(claimed.changed, true);
  const lost = await labeler.tool("label", {
    id: task.message.id,
    set: { owner: "other" },
    if: { owner: null },
  });
  assert.equal(lost.isError, true);
  assert.match(lost.content[0].text, /^conflict error: .*"owner":"lead"/);
  const found = await labeler.ok("find", { labels: ["state=open", "area"] });
  assert.deepEqual(
    found.messages.map((m) => m.id),
    [task.message.id],
  );
  const none = await labeler.ok("wait_label", { labels: ["state=done"], id: task.message.id, wait: 0 });
  assert.equal(none.matched, false);
  // The CLI waits on the label while another process changes it.
  const waiter = child(binary, [
    "--profile",
    "lead",
    "wait-label",
    "work",
    "state=done",
    "--message",
    String(task.message.id),
    "--timeout",
    "20",
  ]);
  await delay(500);
  const done = await cli([
    "--profile",
    "reviewer",
    "label",
    "work",
    String(task.message.id),
    "state=done",
    "--if",
    "state=open",
  ]);
  assert.equal(done.message.labels.state, "done");
  const [waitCode] = await waiter.done;
  assert.equal(waitCode, 0, waiter.errors);
  assert.equal(JSON.parse(waiter.output).labels.state, "done");
  const matched = await labeler.ok("wait_label", { labels: ["state=done"], wait: 0 });
  assert.equal(matched.message.id, task.message.id);
  const filtered = await cli(["--profile", "lead", "poll", "work", "--label", "owner=lead"]);
  assert.deepEqual(
    filtered.messages.map((m) => m.text),
    ["fix the parser"],
  );
  const conflict = child(binary, [
    "--profile",
    "lead",
    "label",
    "work",
    String(task.message.id),
    "state=open",
    "--if",
    "state=open",
  ]);
  const [conflictCode] = await conflict.done;
  assert.equal(conflictCode, 5);
  assert.match(conflict.errors, /Current labels: .*"state":"done"/);
  await labeler.close();
  console.log("PASS: labels on send, conditional claims, filters and waiting on a label over MCP and CLI");
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
