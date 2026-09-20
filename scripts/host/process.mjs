import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HostError } from "./protocol.mjs";

const WORKER = fileURLToPath(new URL("./turn-worker.mjs", import.meta.url));
export function childEnvironment(agent, connection, envelope, config, source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env))
    if (key.startsWith("MSN_") || ["ADMIN_TOKEN", "NODE_OPTIONS", "NODE_PATH"].includes(key)) delete env[key];
  for (const member of config.agents) if (member.connection?.tokenEnv) delete env[member.connection.tokenEnv];
  return {
    ...env,
    MSN_URL: connection.origin,
    MSN_WORKSPACE_TENANT: connection.tenant,
    MSN_WORKSPACE_TOKEN: connection.token,
    MSN_USERNAME: agent.username,
    MSN_CHANNEL: envelope.channel,
    MSN_HOST_ID: config.hostId,
    MSN_PERMISSION_MODE: "yolo",
    MSN_IDEMPOTENCY_KEY: envelope.idempotencyKey,
  };
}
export function executeTurn(agent, connection, envelope, config, signal, env = process.env) {
  if (signal.aborted) return Promise.reject(new HostError("host_stopped"));
  return new Promise((resolve, reject) => {
    let outcome,
      group,
      settled = false;
    const worker = fork(WORKER, [], {
      cwd: agent.cwd,
      env: childEnvironment(agent, connection, envelope, config, env),
      execArgv: [],
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const reap = () => {
      if (group) {
        try {
          process.kill(-group, "SIGKILL");
        } catch {}
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(stopTimer);
      signal.removeEventListener("abort", stop);
      reap();
      if (signal.aborted) reject(new HostError("host_stopped"));
      else if (outcome?.ok) resolve(outcome.result);
      else reject(new HostError(outcome?.code ?? "handler_supervisor_failed"));
    };
    let stopTimer;
    const stop = () => {
      if (stopTimer || settled) return;
      if (worker.connected) worker.send({ stop: true }, () => {});
      stopTimer = setTimeout(() => {
        reap();
        worker.kill("SIGKILL");
        finish();
      }, 1500);
    };
    const timer = setTimeout(() => {
      outcome = { ok: false, code: "handler_supervisor_timeout" };
      stop();
    }, agent.timeoutMs + 2500);
    signal.addEventListener("abort", stop, { once: true });
    worker.on("message", (message) => {
      if (Number.isSafeInteger(message.started) && message.started > 0) group = message.started;
      else if (typeof message.ok === "boolean") outcome = message;
    });
    worker.on("error", () => {
      outcome = { ok: false, code: "handler_supervisor_failed" };
      stop();
    });
    worker.on("exit", finish);
    worker.send({ command: agent.command, cwd: agent.cwd, timeoutMs: agent.timeoutMs, envelope }, (error) => {
      if (error) stop();
    });
    if (signal.aborted) stop();
  });
}
