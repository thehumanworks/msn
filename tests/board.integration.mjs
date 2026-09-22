/** Product path: actual Rust CLI, bundled runner, real Worker and generic executable. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const liveOrigin = process.env.MSN_BOARD_TEST_URL;
const liveAdmin = process.env.MSN_ADMIN_TOKEN;
if (liveOrigin) {
  assert.equal(new URL(liveOrigin).protocol, "https:", "Live verification requires HTTPS.");
  assert.ok(liveAdmin, "Live verification requires MSN_ADMIN_TOKEN to clean up its test messages.");
}
const dir = await mkdtemp(join(tmpdir(), "msn-board-integration-"));
const server = createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
await new Promise((r) => server.close(r));
const origin = liveOrigin ? new URL(liveOrigin).origin : `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
  XDG_CONFIG_HOME: join(dir, "config"),
  XDG_STATE_HOME: join(dir, "state"),
  ADMIN_TOKEN: "isolated-board-test-admin-only",
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
async function cli(args, expected = 0) {
  const p = child(binary, args);
  const [code] = await p.done;
  assert.equal(code, expected, `CLI ${args[0]}: ${p.errors}`);
  return expected === 0 ? JSON.parse(p.output) : null;
}
async function until(predicate, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(
    `Timed out: ${label}${label === "worker startup" ? `: ${worker.errors.slice(-3000)} ${worker.output.slice(-1500)}` : ""}`,
  );
}
async function stop(p) {
  if (p?.exitCode === null) {
    p.kill("SIGTERM");
    await p.done;
  }
}
let worker;
let liveAccount;
async function cleanLiveAccount() {
  if (!liveAccount) return;
  const request = async (path, token, method = "GET") => {
    const response = await fetch(`${origin}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.ok(response.ok, `Live cleanup ${method}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  const base = `/api/tenants/${liveAccount.tenant}`;
  const { channels } = await request(`${base}/channels`, liveAccount.token);
  for (const { name } of channels) {
    let after = 0;
    while (true) {
      const page = await request(
        `${base}/channels/${name}/messages?after=${after}&limit=100`,
        liveAccount.token,
      );
      for (const { id } of page.messages)
        await request(
          `/api/admin/tenants/${liveAccount.tenant}/channels/${name}/messages/${id}`,
          liveAdmin,
          "DELETE",
        );
      if (!page.hasMore) break;
      after = page.nextCursor;
    }
  }
  await request(`/api/admin/tenants/${liveAccount.tenant}/token`, liveAdmin, "POST");
  console.log("PASS: live test messages removed and test credentials revoked; empty test account retained");
}
try {
  if (!liveOrigin)
    worker = child(
      join(cwd, "node_modules/.bin/wrangler"),
      ["dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(dir, "worker")],
      { detached: true },
    );
  await until(
    async () => {
      try {
        return (await fetch(`${origin}/api/health`)).ok;
      } catch {
        return false;
      }
    },
    liveOrigin ? "live worker health" : "worker startup",
    20000,
  );
  await cli(["--username", "human", "login", "--create"]);
  if (liveOrigin)
    liveAccount = JSON.parse(await readFile(join(dir, "config/msn/profiles/account.json"), "utf8"));
  await cli(["--username", "human", "login", "--create"]);
  await cli(["board", "create", "work", "--goal", "Finish the integration goal", "--save-as", "lead"]);
  await cli(["--profile", "lead", "persona", "add", "work", "reviewer", "--save-as", "reviewer"]);
  const lead = JSON.parse(await readFile(join(dir, "config/msn/profiles/lead.json"), "utf8"));
  const reviewer = JSON.parse(await readFile(join(dir, "config/msn/profiles/reviewer.json"), "utf8"));
  const account = JSON.parse(await readFile(join(dir, "config/msn/profiles/account.json"), "utf8"));
  assert.ok(lead.token === reviewer.token, "Personas share the channel credential");
  assert.notEqual(lead.reader, reviewer.reader);
  assert.ok(lead.token !== account.token, "Channel and owner credentials are distinct");
  await cli(["--profile", "lead", "create", "outside"], 3);
  const roster = await cli(["--profile", "reviewer", "persona", "list", "work"]);
  assert.equal(roster.personas.length, 2);
  const entered = await cli(["--profile", "lead", "start", "work"]);
  assert.equal(entered.board.goal, "Finish the integration goal");
  assert.equal(entered.identity.sharedChannel, true);
  // A 25-second wait must return on the message, without sleeping out its timer.
  const waiter = child(binary, ["--profile", "reviewer", "wait", "work", "--after", "0", "--wait", "25"]);
  await delay(150);
  const started = Date.now();
  await cli(["send", "work", "--text", "begin"]);
  await waiter.done;
  assert.equal(waiter.exitCode, 0, waiter.errors);
  assert.ok(Date.now() - started < 5000);
  const fixture = join(dir, "agent.mjs");
  await writeFile(
    fixture,
    `let raw='';for await(const c of process.stdin)raw+=c;const t=JSON.parse(raw);let r={schema:'msn.turn.result.v1',actions:[]};
if(t.message?.text==='begin'){r.wait={for:['reviewer'],timeoutMs:60000,reason:'waiting for review'};r.state={phase:'waiting'};}
else if(t.message?.text==='interrupt'){if(!t.trigger.resumed)process.exit(2);r.progress={status:'working',reason:'final step',delayMs:250};r.state={phase:'finishing'};}
else if(t.trigger.type==='goal.continue'){r.actions=[{type:'send',channel:t.channel,text:'goal done',to:'human'}];r.progress={status:'complete',reason:'finished'};}
else r.progress={status:'waiting',reason:'no action'};
process.stdout.write(JSON.stringify(r));`,
  );
  const args = ["--profile", "lead", "run", "work", "--state-dir", join(dir, "runner")];
  let runner = child(binary, [...args, "--", process.execPath, fixture]);
  await until(
    () => runner.output.includes('"suspended":true') || runner.exitCode !== null,
    "suspended agent",
  );
  assert.equal(runner.exitCode, null, runner.errors);
  // Different conversation and sender must interrupt the peer wait immediately.
  await cli(["send", "work", "--text", "interrupt", "--correlation-id", "new-human-thread"]);
  await until(
    () => runner.output.includes('"actions":1') || runner.exitCode !== null,
    "autonomous goal continuation",
  );
  assert.equal(runner.exitCode, null, runner.errors);
  await until(async () => {
    const page = await cli(["poll", "work", "--after", "0"]);
    return page.messages.some((m) => m.text === "goal done");
  }, "outbox delivery");
  await stop(runner);
  runner = child(binary, args);
  await until(() => runner.output.includes('"host.started"') || runner.exitCode !== null, "runner restart");
  assert.equal(runner.exitCode, null, runner.errors);
  await delay(350);
  assert.ok(!runner.output.includes('"turn.started"'), "completed work must not replay on restart");
  await stop(runner);
  const page = await cli(["poll", "work", "--after", "0"]);
  assert.equal(page.messages.filter((m) => m.text === "goal done").length, 1);
  if (process.platform === "linux") {
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "systemctl"), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
    env.PATH = `${bin}:${env.PATH}`;
    const service = await cli([...args, "--install-service"]);
    const unit = await readFile(service.path, "utf8");
    assert.ok(unit.includes("Restart=on-failure"));
    assert.ok(unit.includes('--profile" "lead" "run" "work"'));
    assert.ok(!unit.includes(lead.token) && !unit.includes(account.token));
  }
  const exported = join(dir, "account.json");
  await cli(["connection-export", "--out", exported]);
  const imported = await cli(["login", "--connection", exported, "--save-as", "second-device"]);
  assert.equal(imported.tenant, account.tenant);
  const channels = await cli(["--profile", "second-device", "channels"]);
  assert.ok(channels.channels.some((c) => c.name === "work"));
  console.log(
    "PASS: shared personas, scoped access, cross-client account, CLI wake, goal continuation and restart without duplicate output",
  );
} finally {
  for (const p of children.reverse()) if (p !== worker) await stop(p);
  if (worker?.exitCode === null) {
    try {
      process.kill(-worker.pid, "SIGTERM");
    } catch {}
    await worker.done;
  }
  try {
    await cleanLiveAccount();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
