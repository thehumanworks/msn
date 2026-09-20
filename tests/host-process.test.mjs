import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeTurn } from "../scripts/host/process.mjs";
import { HostStore } from "../scripts/host/store.mjs";

async function fixture(t, source) {
  const dir = await mkdtemp(join(tmpdir(), "msn-host-process-")),
    script = join(dir, "handler.mjs");
  await writeFile(script, source);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agent = {
    id: "alice",
    username: "alice",
    command: [process.execPath, script],
    cwd: dir,
    timeoutMs: 400,
  };
  const connection = { origin: "https://example.test", tenant: "team", token: "selected-token" };
  const envelope = {
    channel: "work",
    idempotencyKey: "stable-key",
    message: { text: "$(not a command); literal" },
  };
  const config = { hostId: "test-host", agents: [agent] };
  return {
    dir,
    agent,
    config,
    connection,
    envelope,
    run: (signal = new AbortController().signal) => executeTurn(agent, connection, envelope, config, signal),
  };
}
test("supervised executable receives literal stdin, not shell-expanded arguments", async (t) => {
  const f = await fixture(
    t,
    `let s='';for await(const c of process.stdin)s+=c; console.log(JSON.stringify({text:JSON.parse(s).message.text,permission:process.env.MSN_PERMISSION_MODE}));`,
  );
  assert.deepEqual(await f.run(), { text: "$(not a command); literal", permission: "yolo" });
});
test("stdout budget, invalid JSON, missing executable and nonzero exits fail finitely", async (t) => {
  for (const [source, code] of [
    ["process.stdout.write('x'.repeat(70000));setTimeout(()=>{},60000)", "handler_output_too_large"],
    ["console.log('not json')", "handler_invalid_json"],
    ["process.exit(7)", "handler_failed"],
  ]) {
    const f = await fixture(t, source);
    await assert.rejects(f.run(), new RegExp(code));
  }
  const f = await fixture(t, "");
  f.agent.command = [join(f.dir, "does-not-exist")];
  await assert.rejects(f.run(), /handler_spawn_failed/);
});
test("noncooperative executable is killed after deadline and cancellation is bounded", async (t) => {
  const f = await fixture(t, `process.on('SIGTERM',()=>{});setTimeout(()=>{},60000);`);
  const start = Date.now();
  await assert.rejects(f.run(), /handler_timeout/);
  assert.ok(Date.now() - start < 3500);
  const controller = new AbortController();
  const execution = f.run(controller.signal);
  controller.abort();
  await assert.rejects(execution, /host_stopped/);
});
test("watchdog does not retain its startup timer after accepting a long turn", async (t) => {
  const f = await fixture(t, `setTimeout(()=>console.log('{"ok":true}'),5200)`);
  f.agent.timeoutMs = 6500;
  assert.deepEqual(await f.run(), { ok: true });
});
test("SIGKILL releases SQLite ownership without a stale lock or manual intervention", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "msn-host-lock-crash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storeUrl = new URL("../scripts/host/store.mjs", import.meta.url).href;
  const config = {
    stateDir: join(dir, "state"),
    hostId: "lock-test",
    agents: [{ id: "alice", username: "alice", channels: ["work"] }],
  };
  const script = join(dir, "owner.mjs");
  await writeFile(
    script,
    `import {HostStore} from ${JSON.stringify(storeUrl)}; globalThis.owner = new HostStore(${JSON.stringify(config)},{version:1}); console.log('owned');setTimeout(()=>{},60000);`,
  );
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => child.kill("SIGKILL"));
  await once(child.stdout, "data");
  assert.throws(() => new HostStore(config, { version: 1 }), /already_owned/);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const store = new HostStore(config, { version: 1 });
  store.close();
});
test("watchdog reaps its child when the host IPC parent dies", async (t) => {
  const f = await fixture(
    t,
    `import {writeFileSync} from 'node:fs';writeFileSync('agent.pid',String(process.pid));setTimeout(()=>{},60000);`,
  );
  f.agent.timeoutMs = 10000;
  const parent = join(f.dir, "parent.mjs");
  await writeFile(
    parent,
    `import {executeTurn} from ${JSON.stringify(new URL("../scripts/host/process.mjs", import.meta.url).href)}; executeTurn(${JSON.stringify(f.agent)},${JSON.stringify(f.connection)},${JSON.stringify(f.envelope)},${JSON.stringify(f.config)},new AbortController().signal).catch(()=>{});`,
  );
  const child = spawn(process.execPath, [parent], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  // Filesystem notification is used instead of polling for child startup.
  const { watch } = await import("node:fs");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error("child not started"));
    }, 3000);
    const watcher = watch(f.dir, async (_event, path) => {
      if (String(path) === "agent.pid") {
        clearTimeout(timer);
        watcher.close();
        resolve();
      }
    });
  });
  const pid = Number(await readFile(join(f.dir, "agent.pid"), "utf8"));
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  // Give SIGTERM/disconnect cleanup its bounded grace; this is a test, not an agent work loop.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") alive = false;
    else throw error;
  }
  if (alive && process.platform === "linux") {
    // A reaped-by-init zombie is terminated, not a running orphan.
    const status = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    alive = Boolean(status) && status.split(") ")[1]?.[0] !== "Z";
  }
  assert.equal(alive, false);
});
