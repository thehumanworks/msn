/** Real isolated Worker, real Node/Python agent processes, and remote-protocol human observer. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../scripts/host/protocol.mjs";
import { inspectState, runHost } from "../scripts/host-runner.mjs";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "msn-host-worker-"));
const reserve = createServer();
reserve.listen(0, "127.0.0.1");
await once(reserve, "listening");
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const tenant = "host-runtime-team";
const admin = "isolated-host-integration-admin-not-a-production-credential";
const base = `/api/tenants/${tenant}`;
const logs = [],
  updates = new EventEmitter();
let worker,
  workerLog = "",
  hostController,
  hostRun,
  hostError;
const deadline = AbortSignal.timeout(75000);
async function api(path, token, { method = "GET", body, key, signal = deadline } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    signal,
    redirect: "error",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  assert.ok(response.ok, `HTTP ${response.status}: ${JSON.stringify(result)}`);
  return result;
}
async function startWorker() {
  worker = spawn(
    join(cwd, "node_modules/.bin/wrangler"),
    ["dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(dir, "worker")],
    {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ADMIN_TOKEN: admin, WRANGLER_SEND_METRICS: "false" },
    },
  );
  for (const stream of [worker.stdout, worker.stderr])
    stream.on("data", (chunk) => {
      workerLog = (workerLog + chunk).slice(-8000);
    });
  // Infrastructure readiness only: agents themselves never run this loop.
  for (let i = 0; i < 250; i++) {
    try {
      if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    if (worker.exitCode !== null) break;
    await delay(100);
  }
  throw new Error(`Isolated Worker did not start: ${workerLog.slice(-1600)}`);
}
async function stopHost() {
  hostController?.abort();
  await hostRun;
}
function startHost(config, env) {
  hostController = new AbortController();
  hostError = null;
  hostRun = runHost(config, AbortSignal.any([hostController.signal, deadline]), {
    env,
    log(entry) {
      logs.push(entry);
      updates.emit("log");
    },
  }).catch((error) => {
    hostError = error;
    updates.emit("log");
  });
}
async function logWhen(predicate, after = 0) {
  if (hostError) throw hostError;
  const found = logs.slice(after).find(predicate);
  if (found) return found;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      updates.off("log", check);
      reject(new Error(`Missing host log: ${JSON.stringify(logs)}`));
    }, 12000);
    function check() {
      const entry = logs.slice(after).find(predicate);
      if (!entry && !hostError) return;
      clearTimeout(timer);
      updates.off("log", check);
      if (hostError) reject(hostError);
      else resolve(entry);
    }
    updates.on("log", check);
    check();
  });
}
let observerCursor = 0;
async function observeText(token, text) {
  for (;;) {
    const page = await api(`${base}/events?channel=work&after=${observerCursor}&wait=25`, token);
    for (const event of page.events) {
      observerCursor = event.id;
      if (event.type !== "message.created") continue;
      const { message } = await api(`${base}/channels/work/messages/${event.resourceId}`, token);
      if (message.to === "human" && message.text === text) return message;
    }
    if (hostError) throw hostError;
  }
}
try {
  const nodeAgent = join(dir, "agent.mjs"),
    pythonAgent = join(dir, "agent.py"),
    record = join(dir, "turns.jsonl");
  await writeFile(
    nodeAgent,
    `import {appendFile} from 'node:fs/promises';
let raw='';for await(const c of process.stdin)raw+=c;const input=JSON.parse(raw);
await appendFile(process.env.MSN_TEST_RECORD,JSON.stringify({who:input.identity.username,id:input.idempotencyKey,resumed:input.trigger.resumed,state:input.state})+'\\n');
let actions=[],wait;
if(input.message.text==='coordinate') {actions=[{type:'send',channel:input.channel,to:'bob',text:'independent peer work'}];wait={for:['bob'],timeoutMs:10000,reason:'peer result'};}
else if(input.message.text==='peer result') actions=[{type:'send',channel:input.channel,to:'human',text:'completed'}];
else actions=[{type:'send',channel:input.channel,to:'human',text:'after restart'}];
console.log(JSON.stringify({schema:'msn.turn.result.v1',actions,state:{turns:(input.state?.turns||0)+1},...(wait?{wait}:{})}));
`,
  );
  await writeFile(
    pythonAgent,
    `import json,sys
inp=json.load(sys.stdin)
print(json.dumps({'schema':'msn.turn.result.v1','actions':[{'type':'send','channel':inp['channel'],'to':'alice','text':'peer result'}]}))
`,
  );
  await startWorker();
  const human = await api(`/api/admin/tenants/${tenant}`, admin, {
    method: "PUT",
    body: { username: "human" },
  });
  const alice = await api(`/api/admin/tenants/${tenant}/keys/alice`, admin, {
    method: "PUT",
    body: { username: "alice" },
  });
  const bob = await api(`/api/admin/tenants/${tenant}/keys/bob`, admin, {
    method: "PUT",
    body: { username: "bob" },
  });
  await api(`${base}/channels/work/messages`, human.token, {
    method: "POST",
    body: { username: "human", text: "Workspace prepared before host activation" },
    key: "seed-workspace",
  });
  const config = validateConfig(
    {
      schema: "msn.host.v1",
      hostId: "worker-integration",
      stateDir: join(dir, "host"),
      maxConcurrent: 1,
      agents: [
        {
          id: "alice",
          connection: { origin, tenant, tokenEnv: "HOST_ALICE_KEY" },
          command: [process.execPath, nodeAgent],
          cwd: dir,
          channels: ["work"],
          permissionMode: "yolo",
          attempts: 1,
          timeoutMs: 5000,
        },
        {
          id: "bob",
          connection: { origin, tenant, tokenEnv: "HOST_BOB_KEY" },
          command: ["python3", pythonAgent],
          cwd: dir,
          channels: ["work"],
          permissionMode: "yolo",
          attempts: 1,
          timeoutMs: 5000,
        },
      ],
    },
    dir,
  );
  const env = {
    ...process.env,
    HOST_ALICE_KEY: alice.token,
    HOST_BOB_KEY: bob.token,
    MSN_TEST_RECORD: record,
  };
  // MSN-prefixed variables are deliberately scrubbed by childEnvironment. This test record is local-only.
  env.HOST_TEST_RECORD = record;
  await writeFile(
    nodeAgent,
    (await readFile(nodeAgent, "utf8")).replaceAll("MSN_TEST_RECORD", "HOST_TEST_RECORD"),
  );
  startHost(config, env);
  await Promise.all(
    ["alice", "bob"].map((agent) => logWhen((e) => e.type === "agent.ready" && e.agent === agent)),
  );
  const start = Date.now();
  await api(`${base}/channels/work/messages`, human.token, {
    method: "POST",
    body: { username: "human", to: "alice", text: "coordinate" },
    key: "human-assignment",
  });
  await observeText(human.token, "completed");
  await logWhen((e) => e.type === "output.sent" && e.agent === "alice" && e.outputId >= 3);
  const elapsed = Date.now() - start;
  const turns = (await readFile(record, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(turns.length, 2);
  assert.equal(turns[1].resumed, true);
  assert.deepEqual(turns[1].state, { turns: 1 });
  assert.ok(logs.some((e) => e.type === "turn.completed" && e.agent === "bob"));
  assert.equal(inspectState(config).failures.length, 0);
  assert.ok(elapsed < 10000, "Peer handoff waited instead of releasing its sole execution slot");
  await stopHost();
  startHost(config, env);
  await api(`${base}/channels/work/messages`, human.token, {
    method: "POST",
    body: { username: "human", to: "alice", text: "restart check" },
    key: "human-after-restart",
  });
  await observeText(human.token, "after restart");
  await logWhen((e) => e.type === "output.sent" && e.agent === "alice" && e.outputId >= 4);
  await stopHost();
  const history = await api(`${base}/channels/work/messages?limit=100`, human.token);
  assert.equal(history.messages.filter((m) => m.text === "completed").length, 1);
  assert.equal(history.messages.filter((m) => m.text === "after restart").length, 1);
  assert.equal((await readFile(record, "utf8")).trim().split("\n").length, 3);
  assert.ok(history.messages.some((m) => m.username === "bob" && m.text === "peer result"));
  const state = inspectState(config);
  assert.equal(state.failures.length, 0, JSON.stringify(state.failures));
  assert.equal(state.failedOutputs.length, 0);
  assert.ok(!JSON.stringify(logs).includes(alice.token) && !JSON.stringify(logs).includes(bob.token));
  console.log(
    JSON.stringify({
      ok: true,
      backend: "isolated real Cloudflare Worker",
      harnesses: ["Node executable", "Python executable"],
      human: "remote HTTP/event client",
      coordinatorRequired: false,
      executionSlots: 1,
      peerReplyResumed: true,
      eventDrivenHandoffMs: elapsed,
      restartDuplicateEffects: 0,
      messageCount: history.messages.length,
      state,
    }),
  );
} finally {
  await stopHost();
  if (worker && worker.exitCode === null) {
    const exited = once(worker, "exit");
    try {
      process.kill(-worker.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") console.error("Could not stop isolated Worker process group");
    }
    await exited;
  }
  await rm(dir, { recursive: true, force: true });
}
