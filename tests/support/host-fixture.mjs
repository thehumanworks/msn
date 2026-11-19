import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../../scripts/host/protocol.mjs";
import { inspectState, runHost } from "../../scripts/host-runner.mjs";

const HANDLER = `import {appendFile} from 'node:fs/promises';
let raw=''; for await(const chunk of process.stdin) raw+=chunk; const i=JSON.parse(raw);
await appendFile(process.env.HOST_TEST_RECORDS, JSON.stringify({who:i.identity.username,input:i,permission:process.env.MSN_PERMISSION_MODE,admin:!!process.env.MSN_ADMIN_TOKEN,reader:process.env.MSN_READER,profile:process.env.MSN_PROFILE,other:!!process.env.ALICE_TOKEN||!!process.env.BOB_TOKEN})+'\\n');
if (i.message?.text==='hang') {process.on('SIGTERM',()=>{}); await new Promise(r=>setTimeout(r,60000));}
if (i.message?.text==='slow') await new Promise(r=>setTimeout(r,1800));
let actions=[],wait,progress;
if(i.message?.text==='continue-work') {progress={status:'working',reason:'second useful step',delayMs:300};}
else if(i.trigger.type==='goal.continue') {actions=[{type:'send',channel:i.channel,to:'human',text:'continued'}];progress={status:'complete',reason:'finished'};}
else
if(i.message?.text==='cycle-start') {actions=[{type:'send',channel:i.channel,to:'bob',text:'cycle-request'}]; wait={for:['bob'],timeoutMs:3000,reason:'bob'};}
else if(i.message?.text==='cycle-request') wait={for:['alice'],timeoutMs:3000,reason:'alice'};
else if(i.trigger.type==='coordination.cycle') actions=[{type:'send',channel:i.channel,to:'alice',text:'reply'}];
else if(i.message?.text==='wait-missing') wait={for:['absent-peer'],timeoutMs:100,reason:'missing peer'};
else if(i.trigger.type==='coordination.timeout') actions=[{type:'send',channel:i.channel,to:'human',text:'timeout recovered'}];
else if(i.trigger.type==='coordination.delivery_failed') actions=[{type:'send',channel:i.channel,to:'human',text:'delivery failure observed'}];
else if(i.trigger.type==='coordination.budget') actions=[{type:'send',channel:i.channel,to:'human',text:'budget:'+i.trigger.agentTurns}];
else if(i.message?.text==='coordinate') {actions=[{type:'send',channel:i.channel,to:'bob',text:'request'}]; wait={for:['bob'],timeoutMs:5000,reason:'peer work'};}
else if(i.message?.text==='request') actions=[{type:'send',channel:i.channel,to:'alice',text:'reply'}];
else if(i.message?.text==='reply') actions=[{type:'send',channel:i.channel,to:'human',text:'completed'}];
else if(i.message) actions=[{type:'send',channel:i.channel,to:'human',text:'done:'+i.message.text}];
console.log(JSON.stringify({schema:'msn.turn.result.v1',actions,state:{turns:(i.state?.turns||0)+1},...(wait?{wait}:{}),...(progress?{progress}:{})}));`;
const PYTHON_HANDLER = `import json, os, sys
inp = json.load(sys.stdin)
with open(os.environ['HOST_TEST_RECORDS'], 'a') as out:
 out.write(json.dumps({'who': inp['identity']['username'], 'input':inp, 'harness':'python'})+'\\n')
text = inp.get('message',{}).get('text','')
actions = [{'type':'send','channel':inp['channel'],'to':'alice' if text=='request' else 'human','text':'reply' if text=='request' else 'done:'+text}]
print(json.dumps({'schema':'msn.turn.result.v1','actions':actions}))
`;
export async function hostFixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "msn-host-runtime-"));
  const handler = join(dir, "handler.mjs"),
    python = join(dir, "handler.py"),
    records = join(dir, "records.jsonl");
  await writeFile(handler, HANDLER);
  await writeFile(python, PYTHON_HANDLER);
  const changes = new EventEmitter();
  changes.setMaxListeners(100);
  const messages = [],
    events = [],
    requests = [],
    logs = [];
  const retryKeys = new Map(),
    denied = new Set(),
    deleted = new Set();
  const board = { channel: "work", goal: "Test shared board", status: "active", revision: 1 };
  let dropNextReply = false,
    rejectNextSend = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const who = {
      "Bearer alice-secret-fixture": "alice",
      "Bearer bob-secret-fixture": "bob",
      "Bearer carol-secret-fixture": "carol",
    }[req.headers.authorization];
    requests.push({
      method: req.method,
      path: url.pathname,
      key: req.headers["idempotency-key"],
      who,
      wait: Number(url.searchParams.get("wait")),
      listener: url.searchParams.get("listener"),
    });
    changes.emit("request");
    const respond = (value, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (!who || denied.has(who)) return respond({}, 401);
    if (url.pathname === "/api/tenants/team")
      return respond(
        options.shared
          ? { tenant: "team", username: null, usernamePrefix: null, channel: "work", sharedChannel: true }
          : { tenant: "team", username: who, usernamePrefix: null, channel: null },
      );
    if (url.pathname === "/api/tenants/team/channels/work/personas")
      return respond({
        personas: ["alice", "bob", "carol"].map((id) => ({ id: `persona-${id}`, displayName: id })),
      });
    if (url.pathname === "/api/tenants/team/channels/work/board") return respond({ board });
    if (url.pathname === "/api/tenants/team/events") {
      const after = Number(url.searchParams.get("after"));
      const page = () => {
        const selected = events.filter((event) => event.id > after).slice(0, 100);
        return {
          events: selected,
          nextCursor: selected.at(-1)?.id ?? after,
          hasMore: events.some((event) => event.id > (selected.at(-1)?.id ?? after)),
        };
      };
      if (page().events.length || !Number(url.searchParams.get("wait"))) return respond(page());
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        changes.off("event", wake);
      };
      const wake = () => {
        cleanup();
        if (!res.destroyed) denied.has(who) ? respond({}, 401) : respond(page());
      };
      changes.on("event", wake);
      timer = setTimeout(wake, 25000);
      res.once("close", cleanup);
      return;
    }
    const channel = url.pathname.split("/")[5];
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(body.username, who);
      if (options.shared) assert.equal(body.personaId, `persona-${who}`);
      if (rejectNextSend) {
        rejectNextSend = false;
        return respond({}, 400);
      }
      const key = `${channel}:${req.headers["idempotency-key"]}`;
      const saved = retryKeys.get(key);
      if (saved) {
        assert.deepEqual(body, saved.body);
        return respond({ message: saved.message });
      }
      const message = post({ ...body, channel });
      retryKeys.set(key, { body, message });
      if (dropNextReply) {
        dropNextReply = false;
        req.socket.destroy();
        return;
      }
      return respond({ message });
    }
    const id = Number(url.pathname.split("/").at(-1));
    if (deleted.has(id)) return respond({}, 410);
    const message = messages.find((item) => item.id === id && item.channel === channel);
    return message ? respond({ message, historyRevision: 0 }) : respond({}, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  function post(body) {
    const message = {
      tenant: "team",
      channel: "work",
      username: "human",
      contentType: "text/plain",
      ...body,
      id: messages.length + 1,
    };
    messages.push(message);
    events.push({
      id: events.length + 1,
      tenant: "team",
      channel: message.channel,
      type: "message.created",
      resourceId: message.id,
      historyRevision: 0,
      createdAt: new Date().toISOString(),
    });
    changes.emit("event");
    changes.emit("message");
    return message;
  }
  const configFor = (ids) =>
    validateConfig(
      {
        schema: "msn.host.v1",
        hostId: "test-host",
        stateDir: join(dir, "state"),
        replayHistory: options.replayHistory ?? false,
        maxConcurrent: options.maxConcurrent ?? 2,
        maxTurnsPerConversation: options.maxTurnsPerConversation ?? 64,
        softTurnsPerConversation: options.softTurnsPerConversation ?? 16,
        agents: ids.map((id) => ({
          id,
          ...(options.shared
            ? { profile: id }
            : { connection: { origin, tenant: "team", tokenEnv: `${id.toUpperCase()}_TOKEN` } }),
          command: options.pythonBob && id === "bob" ? ["python3", python] : [process.execPath, handler],
          cwd: dir,
          channels: ["work"],
          allowedChannels: ["*"],
          permissionMode: "yolo",
          attempts: 1,
          timeoutMs: options.timeoutMs === undefined ? 1200 : options.timeoutMs,
        })),
      },
      dir,
    );
  if (options.shared) {
    await mkdir(join(dir, "config/msn/profiles"), { recursive: true });
    for (const id of ["alice", "bob", "carol"])
      await writeFile(
        join(dir, `config/msn/profiles/${id}.json`),
        JSON.stringify({
          url: origin,
          tenant: "team",
          token: `${id}-secret-fixture`,
          username: id,
          reader: `persona-${id}`,
        }),
        { mode: 0o600 },
      );
  }
  let config = configFor(["alice", "bob"]);
  const env = {
    ...process.env,
    ...(options.shared ? { XDG_CONFIG_HOME: join(dir, "config") } : {}),
    ALICE_TOKEN: "alice-secret-fixture",
    BOB_TOKEN: "bob-secret-fixture",
    CAROL_TOKEN: "carol-secret-fixture",
    HOST_TEST_RECORDS: records,
    MSN_ADMIN_TOKEN: "must-not-pass",
  };
  let controller, running, runError;
  // start(ids) restarts against the same state directory with a changed roster (ADR 0025).
  function start(ids) {
    if (ids) config = configFor(ids);
    controller = new AbortController();
    runError = null;
    running = runHost(config, controller.signal, {
      env,
      log(entry) {
        logs.push({ ...entry, at: Date.now() });
        changes.emit("log");
      },
    }).catch((error) => {
      runError = error;
      changes.emit("log");
    });
  }
  async function stop() {
    controller?.abort();
    await running;
  }
  function until(kind, collection, predicate, timeout = 8000) {
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        changes.off(kind, check);
      };
      const check = () => {
        const found = collection.find(predicate);
        if (found) {
          cleanup();
          resolve(found);
        } else if (runError) {
          cleanup();
          reject(runError);
        }
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Missing ${kind}: ${JSON.stringify(logs)}`));
      }, timeout);
      changes.on(kind, check);
      check();
    });
  }
  start();
  t.after(async () => {
    await stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  // A replayHistory:true first start never bootstraps, so agent.ready is not emitted; the first
  // event subscription is the equivalent liveness signal.
  await Promise.all(
    ["alice", "bob"].map((id) =>
      options.replayHistory
        ? until("request", requests, (r) => r.who === id && r.path.endsWith("/events"))
        : until("log", logs, (log) => log.type === "agent.ready" && log.agent === id),
    ),
  );
  return {
    dir,
    get config() {
      return config;
    },
    env,
    board,
    post,
    stop,
    start,
    messages,
    events,
    requests,
    logs,
    deleted,
    status: () => inspectState(config),
    message: (predicate) => until("message", messages, predicate),
    request: (predicate) => until("request", requests, predicate),
    log: (predicate) => until("log", logs, predicate),
    records: async () => {
      try {
        return (await readFile(records, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    },
    rejectSend: () => {
      rejectNextSend = true;
    },
    dropReply: () => {
      dropNextReply = true;
    },
    revoke: (who) => {
      denied.add(who);
      changes.emit("event");
    },
  };
}
