/** Dedicated watchdog survives host death long enough to reap its executable process group. */
import { spawn } from "node:child_process";
import { MAX_OUTPUT } from "./protocol.mjs";

let child,
  timer,
  escalation,
  failure,
  completed = false;
function kill(signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") child.kill(signal);
  }
}
function finish(result) {
  if (completed) return;
  completed = true;
  clearTimeout(timer);
  clearTimeout(escalation);
  kill("SIGKILL");
  child?.stdin?.destroy();
  child?.stdout?.destroy();
  if (process.connected) {
    process.send(result, () => {
      if (process.connected) process.disconnect();
      process.exit(0);
    });
  } else process.exit(0);
}
function stop(code) {
  if (failure || completed) return;
  failure = code;
  kill("SIGTERM");
  escalation = setTimeout(() => {
    kill("SIGKILL");
    finish({ ok: false, code });
  }, 1000);
}
process.on("disconnect", () => stop("host_disconnected"));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => stop("host_stopped"));
process.on("message", (input) => {
  if (input.stop) {
    stop("host_stopped");
    return;
  }
  if (child || completed) return;
  try {
    const env = { ...process.env };
    delete env.NODE_CHANNEL_FD;
    child = spawn(input.command[0], input.command.slice(1), {
      cwd: input.cwd,
      env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (process.connected && child.pid) process.send({ started: child.pid });
    let chunks = [],
      bytes = 0;
    clearTimeout(timer);
    timer = setTimeout(() => stop("handler_timeout"), input.timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) {
        chunks = [];
        stop("handler_output_too_large");
      } else if (!failure) chunks.push(chunk);
    });
    child.stdin.on("error", () => {});
    child.on("error", () => finish({ ok: false, code: "handler_spawn_failed" }));
    child.on("close", (code) => {
      if (failure || code !== 0) {
        finish({ ok: false, code: failure ?? "handler_failed" });
        return;
      }
      try {
        finish({ ok: true, result: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        finish({ ok: false, code: "handler_invalid_json" });
      }
    });
    child.stdin.end(JSON.stringify(input.envelope));
  } catch {
    finish({ ok: false, code: "handler_spawn_failed" });
  }
});
// Parent may die between fork and the first IPC message.
timer = setTimeout(() => stop("handler_start_timeout"), 5000);
