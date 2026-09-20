import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "msn-dispatch-integration-"));
const reserve = createServer();
reserve.listen(0, "127.0.0.1");
await once(reserve, "listening");
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const tenant = "dispatch-team";
const admin = "isolated-dispatch-e2e-admin-not-a-real-credential";
const binary = join(cwd, "cli/target/debug/msn");
let server,
  serverLog = "";
async function startServer() {
  server = spawn(
    join(cwd, "node_modules/.bin/wrangler"),
    ["dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(dir, "worker")],
    {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ADMIN_TOKEN: admin, WRANGLER_SEND_METRICS: "false" },
    },
  );
  for (const output of [server.stdout, server.stderr])
    output.on("data", (chunk) => {
      serverLog = (serverLog + chunk).slice(-8000);
    });
  for (let i = 0; i < 250; i++) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Local test Worker did not become ready: ${serverLog.slice(-1200)}`);
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, "exit");
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await exited;
}
async function api(path, token, method = "GET", body, key) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = response.status === 204 ? null : await response.json();
  assert.ok(response.ok, `HTTP ${response.status} at ${path}: ${JSON.stringify(result)}`);
  return result;
}
function envFor(token) {
  return {
    ...process.env,
    MSN_PROFILE: "",
    MSN_USERNAME: "",
    MSN_ADMIN_TOKEN: "",
    MSN_URL: origin,
    MSN_WORKSPACE_TENANT: tenant,
    MSN_WORKSPACE_TOKEN: token,
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_STATE_HOME: join(dir, "state"),
  };
}
async function cli(args, token) {
  const { stdout } = await exec(binary, args, { cwd, env: envFor(token), timeout: 15000 });
  return JSON.parse(stdout);
}
async function runner(role, token) {
  const { stdout, stderr } = await exec(
    process.execPath,
    [
      "scripts/event-runner.mjs",
      "--channel",
      "work",
      "--state-file",
      join(dir, `${role}-events.json`),
      "--once",
      "--wait",
      "0",
      "--attempts",
      "1",
      "--",
      process.execPath,
      join(dir, "handler.mjs"),
      role,
      binary,
    ],
    {
      cwd,
      env: envFor(token),
      timeout: 20000,
    },
  );
  assert.ok(!stdout.includes(token));
  assert.ok(!stderr.includes(token));
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const handler = `import assert from 'node:assert/strict'; import {execFile} from 'node:child_process'; import {promisify} from 'node:util';
const exec=promisify(execFile); let raw=''; for await(const chunk of process.stdin) raw+=chunk; const input=JSON.parse(raw);
const role=process.argv[2], binary=process.argv[3], key=process.env.MSN_IDEMPOTENCY_KEY;
const cli=async args=>JSON.parse((await exec(binary,args,{env:process.env,timeout:10000})).stdout);
assert.equal(input.schema,'msn.dispatch.v1'); assert.equal(input.message.to,role);
if(role==='worker') {
 const board=await cli(['task','list','work']); const task=board.tasks.find(t=>t.id==='deliver');
 assert.equal(task.owner,'worker'); assert.equal(task.state,'open');
 const result=await cli(['send','work','--text','Evidence: acceptance fixture passed','--correlation-id','deliver','--key',key+'-evidence']);
 await cli(['task','ready','work','deliver','--evidence',String(result.message.id),'--key',key+'-ready']);
 await cli(['send','work','--to','reviewer','--text','Verify deliver evidence and close','--correlation-id','deliver','--key',key+'-review']);
} else {
 const board=await cli(['task','list','work']); const task=board.tasks.find(t=>t.id==='deliver');
 assert.equal(task.state,'ready'); assert.equal(task.reviewer,'reviewer');
 const evidence=await cli(['show','work',String(task.evidence[0])]); assert.equal(evidence.message.text,'Evidence: acceptance fixture passed');
 await cli(['task','close','work','deliver','--key',key+'-close']);
}
`;
try {
  await writeFile(join(dir, "handler.mjs"), handler);
  await startServer();
  const planner = await api(`/api/admin/tenants/${tenant}`, admin, "PUT", { username: "planner" });
  const worker = await api(`/api/admin/tenants/${tenant}/keys/worker`, admin, "PUT", { username: "worker" });
  const reviewer = await api(`/api/admin/tenants/${tenant}/keys/reviewer`, admin, "PUT", {
    username: "reviewer",
  });
  await cli(["create", "work"], planner.token);
  const before = await api(`/api/tenants/${tenant}/events?channel=work`, planner.token);
  const started = Date.now();
  const pending = fetch(
    `${origin}/api/tenants/${tenant}/events?channel=work&after=${before.nextCursor}&wait=25`,
    { headers: { Authorization: `Bearer ${worker.token}` } },
  );
  await sleep(120);
  await cli(
    [
      "task",
      "open",
      "work",
      "deliver",
      "--title",
      "Deliver the acceptance fixture",
      "--owner",
      "worker",
      "--reviewer",
      "reviewer",
      "--key",
      "task-open",
    ],
    planner.token,
  );
  const awakened = await (await pending).json();
  assert.equal(awakened.events[0].type, "message.created");
  assert.ok(Date.now() - started < 5000, "Event long-poll did not wake promptly");
  await cli(
    [
      "send",
      "work",
      "--to",
      "worker",
      "--text",
      "Complete deliver using its acceptance fixture",
      "--correlation-id",
      "deliver",
      "--key",
      "assignment",
    ],
    planner.token,
  );
  const workerDispatch = await runner("worker", worker.token);
  assert.equal(workerDispatch.filter((e) => e.dispatched).length, 1);
  const reviewDispatch = await runner("reviewer", reviewer.token);
  assert.equal(reviewDispatch.filter((e) => e.dispatched).length, 1);
  const board = await cli(["task", "list", "work"], planner.token);
  assert.equal(board.complete, true);
  assert.equal(board.tasks[0].state, "closed");
  const finalPage = await api(`/api/tenants/${tenant}/events?channel=work`, planner.token);
  const history = await api(`/api/tenants/${tenant}/channels/work/messages`, planner.token);
  assert.equal(finalPage.events.length, history.messages.length + 1);
  assert.ok(finalPage.events.every((e) => !("text" in e) && !("username" in e)));
  const workerCheckpoint = JSON.parse(await readFile(join(dir, "worker-events.json")));
  await stopServer();
  await startServer();
  const replay = await api(`/api/tenants/${tenant}/events?channel=work`, planner.token);
  assert.deepEqual(replay, finalPage, "Durable events changed across Worker restart");
  assert.equal((await runner("worker", worker.token)).filter((e) => e.dispatched).length, 0);
  assert.equal((await runner("reviewer", reviewer.token)).filter((e) => e.dispatched).length, 0);
  const resumed = JSON.parse(await readFile(join(dir, "worker-events.json")));
  assert.ok(resumed.after >= workerCheckpoint.after);
  const after = await api(`/api/tenants/${tenant}/channels/work/messages`, planner.token);
  assert.equal(after.messages.length, history.messages.length, "Replay duplicated a side effect");
  console.log(
    JSON.stringify({
      ok: true,
      participants: ["planner", "worker", "reviewer"],
      dispatched: 2,
      taskState: board.tasks[0].state,
      messageCount: history.messages.length,
      eventCount: finalPage.events.length,
      restartReplay: "identical",
      duplicateSideEffects: 0,
      liveWakeVerified: true,
    }),
  );
} finally {
  await stopServer();
}
