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
  HOME: dir,
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

  // A template creates the board, every persona and a profile for each, in one command.
  const listed = await cli(["board", "templates"]);
  assert.deepEqual(
    listed.templates.map((t) => t.id),
    ["solo", "lead-reviewer", "lead-workers"],
  );
  const team = await cli(["board", "create", "team", "--template", "lead-workers"]);
  assert.deepEqual(
    team.profiles.map((p) => [p.profile, p.username]),
    [
      ["team-lead", "lead"],
      ["team-worker-1", "worker-1"],
      ["team-worker-2", "worker-2"],
      ["team-worker-3", "worker-3"],
    ],
  );
  assert.deepEqual(await cli(["board", "create", "team", "--template", "lead-workers"]), team);
  const teamRoster = await cli(["--profile", "team-worker-2", "persona", "list", "team"]);
  assert.deepEqual(teamRoster.personas.map((p) => p.displayName).sort(), [
    "lead",
    "worker-1",
    "worker-2",
    "worker-3",
  ]);
  const teamStart = await cli(["--profile", "team-worker-3", "start", "team"]);
  assert.match(
    teamStart.board.goal,
    /^Split the project into tasks, finish every task and verify the result\.\n\nTeam \(Lead and three workers\):\n- lead: Splits/,
  );
  assert.match(teamStart.board.goal, /\n- worker-3: Claims a task/);
  await cli([
    "board",
    "create",
    "pair",
    "--template",
    "lead-reviewer",
    "--goal",
    "Ship the docs",
    "--save-as",
    "pair-lead",
  ]);
  assert.match(
    (await cli(["--profile", "pair-reviewer", "board", "show", "pair"])).board.goal,
    /^Ship the docs\n\nTeam \(Lead and reviewer\):/,
  );
  await cli(["board", "create", "nope", "--template", "unknown", "--save-as", "nope-lead"], 2);
  // Conflicts are found before the board exists, so a fixed retry never meets a half-made board.
  await cli(["--username", "reviewer", "board", "create", "clash", "--template", "lead-reviewer"], 2);
  await cli(["--profile", "lead", "persona", "add", "work", "other", "--save-as", "clash-reviewer"]);
  await cli(["board", "create", "clash", "--template", "lead-reviewer"], 2);
  assert.ok(
    !(await cli(["channels"])).channels.some((c) => c.name === "clash"),
    "A rejected template create makes no board",
  );
  // One paste hands an agent the board: run its join command on a host with no MSN setup.
  const handoff = async () => {
    const p = child(binary, ["invite", "work", "--for-agent", "--name", "helper"]);
    const [code] = await p.done;
    assert.equal(code, 0, `invite --for-agent: ${p.errors}`);
    return p;
  };
  const first = await handoff();
  const paragraph = first.output;
  assert.ok(!first.errors.includes("Reusing existing persona"), "The first invite adds the persona");
  const repeat = await handoff();
  assert.equal(repeat.output, paragraph, "Repeating the invite keeps the same persona");
  assert.ok(
    repeat.errors.includes("Reusing existing persona helper."),
    "A repeat says it reuses the persona",
  );
  assert.ok(paragraph.includes("Finish the integration goal"), "The paragraph quotes the board goal");
  assert.ok(paragraph.includes("msn --profile work-helper peek work --wait 25"), "It says how to wait");
  assert.ok(paragraph.includes("msn --profile work-helper mcp --channel work"), "It offers MCP");
  assert.ok(paragraph.includes("msn --profile work-helper doctor work"), "It says how to get unstuck");
  const joinCommand = paragraph.match(/`(printf '%s' .*? --save-as work-helper)`/)?.[1];
  assert.ok(joinCommand, "The paragraph has a join command");
  const agentHome = join(dir, "agent-host");
  const agentEnv = {
    ...env,
    HOME: agentHome,
    XDG_CONFIG_HOME: join(agentHome, "config"),
    XDG_STATE_HOME: join(agentHome, "state"),
    PATH: `${dirname(binary)}:${env.PATH}`,
  };
  delete agentEnv.MSN_URL;
  for (let attempt = 0; attempt < 2; attempt++) {
    const sh = child("sh", ["-c", joinCommand], { env: agentEnv });
    const [code] = await sh.done;
    assert.equal(code, 0, `join command: ${sh.errors}`);
  }
  const agentRun = async (args) => {
    const p = child(binary, args, { env: agentEnv });
    const [code] = await p.done;
    assert.equal(code, 0, `agent ${args.join(" ")}: ${p.errors}`);
    return JSON.parse(p.output);
  };
  const helperStart = await agentRun(["--profile", "work-helper", "start", "work"]);
  assert.equal(helperStart.board.goal, "Finish the integration goal");
  assert.equal(helperStart.identity.sharedChannel, true);
  // The pasted connection passes doctor against the real Worker, end to end.
  const doctor = await agentRun(["--profile", "work-helper", "doctor", "work", "--json"]);
  assert.equal(doctor.ok, true, JSON.stringify(doctor));
  for (const id of ["login", "profile", "server", "workspace", "board"])
    assert.equal(
      doctor.checks.find((c) => c.check === id)?.status,
      "ok",
      `doctor ${id}: ${JSON.stringify(doctor)}`,
    );
  const sharedKey = joinCommand.match(/"token":"([^"]+)"/)?.[1];
  assert.ok(sharedKey && !JSON.stringify(doctor).includes(sharedKey), "doctor never prints the key");
  const helpers = (await cli(["--profile", "lead", "persona", "list", "work"])).personas.filter(
    (row) => row.displayName === "helper",
  );
  assert.equal(helpers.length, 1, "The invited persona is on the roster once");
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
  await until(() => runner.output.includes('"agent.ready"') || runner.exitCode !== null, "runner readiness");
  assert.equal(runner.exitCode, null, runner.errors);
  // First start deliberately fast-forwards history; only new work activates the configured executable.
  await cli(["send", "work", "--text", "begin", "--key", "runner-begin"]);
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
    const unit = await readFile(service.unit, "utf8");
    assert.ok(unit.includes("Restart=on-failure"));
    assert.ok(unit.includes("--saved-config"));
    assert.ok(unit.includes("agent-runner.mjs"));
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
