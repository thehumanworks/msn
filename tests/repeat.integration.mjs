/**
 * Product path (ADR 0072): `msn send --repeat` and the MCP `send` tool against a real local
 * Worker. A daily repeat is listed with its rule, zone and next time; an hourly one posts a copy
 * from the real Durable Object alarm, stays on the schedule, and stops with `msn scheduled cancel`.
 */
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
const dir = await mkdtemp(join(tmpdir(), "msn-repeat-integration-"));
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
  ADMIN_TOKEN: "isolated-repeat-test-admin-only",
  WRANGLER_SEND_METRICS: "false",
  // The CLI reads this computer's zone from TZ when --tz is not given.
  TZ: "America/New_York",
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
async function run(args) {
  const p = child(binary, args);
  const [code] = await p.done;
  return { code, output: p.output, errors: p.errors };
}
async function ok(args) {
  const r = await run(args);
  assert.equal(r.code, 0, `msn ${args.join(" ")}: ${r.errors}`);
  return r.output.trim() ? JSON.parse(r.output) : null;
}

/** One MCP tools/call over stdio, after the handshake. */
async function mcpTool(tool, args = {}) {
  const p = spawn(binary, ["mcp"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
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
    clientInfo: { name: "repeat-integration", version: "1" },
  });
  p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const reply = await request(2, "tools/call", { name: tool, arguments: args });
  p.stdin.end();
  await once(p, "exit");
  return reply.result;
}

const texts = async () => (await ok(["poll", "general"])).messages.map((m) => m.text);

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
  await ok(["create", "general"]);

  // Daily at 09:00 in an explicit zone: nothing posts now, and the list shows the rule.
  const daily = (
    await ok([
      "send",
      "general",
      "--text",
      "Morning check-in",
      "--repeat",
      "daily",
      "--at",
      "9:00",
      "--tz",
      "Europe/Lisbon",
      "--until",
      "2027-01-31",
    ])
  ).scheduled;
  assert.equal(daily.status, "pending");
  assert.deepEqual(daily.repeat, {
    every: "daily",
    at: "09:00",
    timeZone: "Europe/Lisbon",
    until: "2027-01-31T23:59:59.999Z",
  });
  const lisbon = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Lisbon",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(daily.sendAt));
  assert.equal(lisbon, "09:00");
  assert.ok(Date.parse(daily.sendAt) > Date.now());

  // Without --tz the rule takes this computer's zone (TZ here).
  const weekdays = (
    await ok(["send", "general", "--text", "Weekday wrap-up", "--repeat", "weekdays", "--at", "17:30"])
  ).scheduled;
  assert.equal(weekdays.repeat.timeZone, "America/New_York");
  assert.equal(weekdays.repeat.at, "17:30");
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(
    new Date(weekdays.sendAt),
  );
  assert.ok(!["Sat", "Sun"].includes(day), day);

  // A rule the CLI cannot read fails before any request, with a usage error.
  for (const args of [
    ["--repeat", "daily"],
    ["--repeat", "weekly", "--at", "09:00"],
    ["--repeat", "6h", "--at", "09:00"],
    ["--at", "10m", "--until", "2027-01-01"],
  ]) {
    const bad = await run(["send", "general", "--text", "no", ...args]);
    assert.notEqual(bad.code, 0, args.join(" "));
  }
  // One the Worker refuses says why.
  const zone = await run([
    "send",
    "general",
    "--text",
    "no",
    "--repeat",
    "daily",
    "--at",
    "09:00",
    "--tz",
    "Mars/Olympus",
  ]);
  assert.notEqual(zone.code, 0);
  assert.match(zone.errors, /IANA time zone/);
  assert.deepEqual(await texts(), []);

  // Every hour, first copy in three seconds: the real alarm posts it and keeps the rule listed.
  const key = "repeat-integration-1";
  const hourlyArgs = ["send", "general", "--text", "Any blockers?", "--repeat", "1h", "--key", key];
  const first = await run([...hourlyArgs, "--at", "3s"]);
  assert.equal(first.code, 0, first.errors);
  const hourly = JSON.parse(first.output).scheduled;
  const sendAt = /sendAt: (\S+)/.exec(first.errors)?.[1];
  assert.ok(sendAt, first.errors);
  // A retry with the same key and that absolute time replays it instead of starting a second.
  const again = (await ok([...hourlyArgs, "--at", sendAt])).scheduled;
  assert.equal(again.id, hourly.id);
  const deadline = Date.now() + 15000;
  while (!(await texts()).length) {
    assert.ok(Date.now() < deadline, "the first copy did not post");
    await delay(250);
  }
  assert.deepEqual(await texts(), ["Any blockers?"]);
  let listed = (await ok(["scheduled", "list", "general"])).scheduled;
  const next = listed.find((item) => item.id === hourly.id);
  assert.equal(next.status, "pending");
  assert.equal(Date.parse(next.sendAt), Date.parse(sendAt) + 3600_000);
  assert.equal(listed.length, 3);
  // The key still belongs to the repeating message after a copy posted.
  assert.equal((await ok([...hourlyArgs, "--at", sendAt])).scheduled.id, hourly.id);
  assert.deepEqual(await texts(), ["Any blockers?"]);

  // MCP: the same forms, with the time of day in sendAt.
  const viaMcp = await mcpTool("send", {
    channel: "general",
    text: "Status, please",
    repeat: "weekdays",
    sendAt: "08:15",
    timeZone: "Asia/Tokyo",
    until: "2026-12-31",
  });
  assert.equal(viaMcp.isError, false, JSON.stringify(viaMcp));
  assert.deepEqual(viaMcp.structuredContent.scheduled.repeat, {
    every: "weekdays",
    at: "08:15",
    timeZone: "Asia/Tokyo",
    until: "2026-12-31T14:59:59.999Z",
  });
  const badMcp = await mcpTool("send", { channel: "general", text: "no", repeat: "fortnightly" });
  assert.equal(badMcp.isError, true);

  // Stop them all: nothing is left, and the copy that posted stays.
  listed = (await ok(["scheduled", "list", "general"])).scheduled;
  assert.equal(listed.length, 4);
  for (const item of listed) await ok(["scheduled", "cancel", "general", String(item.id)]);
  assert.deepEqual((await ok(["scheduled", "list", "general"])).scheduled, []);
  assert.deepEqual(await texts(), ["Any blockers?"]);
  console.log("repeat integration passed");
} finally {
  for (const p of children) {
    try {
      if (p === worker) process.kill(-p.pid, "SIGTERM");
      else p.kill("SIGTERM");
    } catch {}
  }
  await rm(dir, { recursive: true, force: true });
}
