#!/usr/bin/env node
/** Harness-neutral, at-least-once dispatch. Only operator-supplied argv is executable. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Fenced, ServerCommits, serverCommitsEnabled, unavailableHint } from "./host/server-commits.mjs";
import { loadProfile, normalizeOrigin } from "./onboarding-check.mjs";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TYPES = new Set([
  "channel.created",
  "message.created",
  "message.deleted",
  "message.edited",
  "snapshot.published",
]);
const DISPATCHED = new Set(["message.created", "message.edited"]);
const MAX_RESPONSE_BYTES = 1024 * 1024;
const HELP = `Usage: node scripts/event-runner.mjs --channel CHANNEL --state-file FILE [options] -- PROGRAM [ARG...]

Connection: --profile NAME, or MSN_URL + MSN_WORKSPACE_TENANT + MSN_WORKSPACE_TOKEN.
Options: --username NAME, --once (one page), --include-broadcast, --attempts 1..10,
         --wait 0..25 (default 25), --handler-timeout-ms 1..3600000 (default 300000),
         --local (keep processing progress on this machine; same as MSN_RESUMABLE=0).

After each acknowledged message, the dispatcher commits that message id to the server for its
reader (ADR 0053), so processed-by receipts name it. A reader held by another machine is left
alone (no receipts); a takeover (msn takeover) stops this dispatcher with exit 5.

Only messages addressed to the selected identity are dispatched by default; self messages are ignored.
The handler receives one msn.dispatch.v1 JSON envelope on stdin. It must finish synchronously.
When the sender edits a message (ADR 0052), the handler runs again with event.type
"message.edited", the new text in message, and a plain "notice" that says which message changed.
MSN_IDEMPOTENCY_KEY is stable across retries; use it for result sends and other deduplicated effects.
Handler output is suppressed so credentials cannot be echoed to runner logs. A nonzero exit retries
without acknowledging input. Exit 0 acknowledges dispatch, NOT evidence-based task completion.
A dedicated, private, origin/tenant/channel/reader-bound event checkpoint is required. Never reuse a
message cursor file. No shell parsing is performed. Only run a local handler you trust.
A selected profile replaces ambient connection and username variables.
`;

export class RunnerError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.name = "RunnerError";
    this.retryable = retryable;
  }
}
function number(raw, min, max, label) {
  if (
    !/^\d+$/.test(String(raw)) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < min ||
    Number(raw) > max
  ) {
    throw new RunnerError(`${label} must be an integer from ${min} to ${max}.`);
  }
  return Number(raw);
}
export function parseArgs(argv, env = process.env) {
  const split = argv.indexOf("--");
  const flags = split === -1 ? argv : argv.slice(0, split);
  const result = {
    profile: env.MSN_PROFILE || "",
    channel: env.MSN_CHANNEL || "",
    username: "",
    stateFile: "",
    once: false,
    includeBroadcast: false,
    attempts: 3,
    wait: 25,
    handlerTimeoutMs: 300000,
    local: false,
    command: split === -1 ? [] : argv.slice(split + 1),
    help: false,
  };
  let explicitUsername = false;
  const valued = new Map([
    ["--profile", "profile"],
    ["--channel", "channel"],
    ["--username", "username"],
    ["--state-file", "stateFile"],
    ["--attempts", "attempts"],
    ["--wait", "wait"],
    ["--handler-timeout-ms", "handlerTimeoutMs"],
  ]);
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    if (flag === "--help" || flag === "-h") result.help = true;
    else if (flag === "--once") result.once = true;
    else if (flag === "--include-broadcast") result.includeBroadcast = true;
    else if (flag === "--local") result.local = true;
    else if (valued.has(flag) && flags[i + 1] && !flags[i + 1].startsWith("--")) {
      result[valued.get(flag)] = flags[++i];
      if (flag === "--username") explicitUsername = true;
    } else throw new RunnerError("Unknown option or missing option value. Use --help.");
  }
  if (!explicitUsername && !result.profile) result.username = env.MSN_USERNAME || "";
  if (result.help) return result;
  if (!SLUG.test(result.channel)) throw new RunnerError("A valid --channel slug is required.");
  if (!result.stateFile) throw new RunnerError("A dedicated --state-file is required.");
  if (!result.command.length || !result.command[0])
    throw new RunnerError("Supply a trusted handler after --.");
  result.stateFile = resolve(result.stateFile);
  result.attempts = number(result.attempts, 1, 10, "attempts");
  result.wait = number(result.wait, 0, 25, "wait");
  if (!result.once && result.wait === 0)
    throw new RunnerError("Continuous dispatch requires a positive --wait.");
  result.handlerTimeoutMs = number(result.handlerTimeoutMs, 1, 3600000, "handler-timeout-ms");
  return result;
}
function validInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function validName(value) {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= 128;
}
export function validatePage(page, binding, after) {
  if (!page || !Array.isArray(page.events) || page.events.length > 100 || typeof page.hasMore !== "boolean") {
    throw new RunnerError("Invalid event page.");
  }
  let previous = after;
  for (const event of page.events) {
    if (
      !event ||
      !validInteger(event.id) ||
      event.id <= previous ||
      event.tenant !== binding.tenant ||
      event.channel !== binding.channel ||
      !TYPES.has(event.type) ||
      !validInteger(event.historyRevision) ||
      typeof event.createdAt !== "string" ||
      !Number.isFinite(Date.parse(event.createdAt)) ||
      (event.type === "channel.created"
        ? event.resourceId !== null
        : !validInteger(event.resourceId) || event.resourceId === 0)
    ) {
      throw new RunnerError("Invalid event identity, ordering or resource reference; checkpoint unchanged.");
    }
    previous = event.id;
  }
  if (page.nextCursor !== previous || (page.hasMore && page.events.length === 0)) {
    throw new RunnerError("Invalid event continuation; checkpoint unchanged.");
  }
  return page.events;
}
export function dispatchKey(binding, eventId) {
  return `msn-event-${createHash("sha256")
    .update(JSON.stringify([binding.server, binding.tenant, binding.channel, binding.reader, eventId]))
    .digest("hex")}`;
}
export async function acquireCheckpoint(file, binding) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let lock;
  try {
    lock = await open(`${file}.lock`, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new RunnerError(
        "Event reader is locked. Confirm the owner has stopped before removing a stale .lock.",
      );
    throw new RunnerError("Cannot create private event reader lock.");
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await lock.close();
    await unlink(`${file}.lock`);
  };
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await lock.sync();
    let after = 0;
    let generation = 0;
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 8192) throw new RunnerError("Invalid checkpoint file.");
      const saved = JSON.parse(await handle.readFile("utf8"));
      if (
        saved.version !== 1 ||
        !validInteger(saved.after) ||
        Object.entries(binding).some(([k, v]) => saved[k] !== v)
      ) {
        throw new RunnerError("Event checkpoint belongs to another reader/stream or is invalid.");
      }
      after = saved.after;
      // The server fence for processing commits (ADR 0053); absent in older checkpoints.
      if (saved.generation !== undefined) {
        if (!validInteger(saved.generation)) throw new RunnerError("Invalid checkpoint file.");
        generation = saved.generation;
      }
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new RunnerError("Event checkpoint is invalid or bound to a different stream; not reset.");
    } finally {
      await handle?.close();
    }
    const write = async (next, nextGeneration) => {
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        const output = await open(temp, "wx", 0o600);
        try {
          await output.writeFile(
            `${JSON.stringify({ version: 1, ...binding, after: next, ...(nextGeneration ? { generation: nextGeneration } : {}) })}\n`,
          );
          await output.sync();
        } finally {
          await output.close();
        }
        await rename(temp, file);
        const dir = await open(dirname(file), constants.O_RDONLY);
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
        after = next;
        generation = nextGeneration;
      } finally {
        await unlink(temp).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    };
    return {
      get after() {
        return after;
      },
      get generation() {
        return generation;
      },
      close,
      async commit(next) {
        if (!validInteger(next) || next < after)
          throw new RunnerError("Refusing invalid checkpoint advance.");
        await write(next, generation);
      },
      async saveGeneration(next) {
        if (!validInteger(next) || next < 1) throw new RunnerError("Refusing invalid generation.");
        await write(after, next);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
/** The channel slug in an API path, for messages; "this board" when the path names none. */
function channelOf(path) {
  return /\/channels\/([a-z0-9][a-z0-9_-]{0,63})(?:[/?]|$)/.exec(path)?.[1] ?? "this board";
}
export async function request(connection, path, signal, options = {}) {
  let response;
  try {
    response = await fetch(`${connection.origin}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(40000)]),
    });
  } catch {
    if (signal.aborted) throw new RunnerError("Stopped; unprocessed input remains unacknowledged.");
    throw new RunnerError("Transport failed (redirects are forbidden).", true);
  }
  if (response.status < 200 || response.status >= 300) {
    // Keep only the error code (a slug), never the message text, from a small error body.
    let code = null;
    // 400/403/404/409 bodies carry the codes that processing commits (ADR 0053) branch on.
    if ([400, 403, 404, 409].includes(response.status)) {
      const text = await response.text().catch(() => "");
      try {
        const parsed = text.length <= 4096 ? JSON.parse(text)?.error?.code : null;
        if (typeof parsed === "string" && /^[a-z_]{1,64}$/.test(parsed)) code = parsed;
      } catch {}
    } else await response.body?.cancel();
    const error = new RunnerError(
      code === "board_archived"
        ? `board_archived: Board ${channelOf(path)} is archived and read-only; do not retry. The board owner can run msn board unarchive.`
        : `Server returned HTTP ${response.status}.`,
      response.status === 429 || response.status >= 500,
    );
    error.status = response.status;
    if (code) error.code = code;
    throw error;
  }
  if (!response.body) throw new RunnerError("Missing JSON response body.");
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new RunnerError("Response exceeded the bounded dispatch budget.");
      parts.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(parts, size).toString("utf8"));
    } catch {
      throw new RunnerError("Response was not valid JSON.");
    }
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw new RunnerError("Response transport interrupted.", true);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function runHandler(command, envelope, connection, timeoutMs, signal) {
  if (signal.aborted) return Promise.reject(new RunnerError("Stopped before dispatch."));
  return new Promise((resolveResult, reject) => {
    const env = {
      ...process.env,
      MSN_URL: connection.origin,
      MSN_WORKSPACE_TENANT: connection.tenant,
      MSN_WORKSPACE_TOKEN: connection.token,
      MSN_USERNAME: connection.username,
      MSN_CHANNEL: envelope.event.channel,
      MSN_EVENT_ID: String(envelope.event.id),
      MSN_MESSAGE_ID: String(envelope.message.id),
      MSN_IDEMPOTENCY_KEY: envelope.idempotencyKey,
    };
    for (const key of ["MSN_PROFILE", "MSN_TENANT", "MSN_TOKEN", "MSN_ADMIN_TOKEN"]) delete env[key];
    const child = spawn(command[0], command.slice(1), {
      shell: false,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "ignore", "ignore"],
    });
    let interrupted = false;
    let killTimer;
    const kill = (name) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
        else child.kill(name);
      } catch (error) {
        if (error.code !== "ESRCH") child.kill(name);
      }
    };
    const stop = () => {
      if (interrupted) return;
      interrupted = true;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 1000);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", stop);
    };
    child.on("error", () => {
      cleanup();
      reject(new RunnerError("Cannot start the configured handler."));
    });
    child.stdin.on("error", () => {});
    child.on("close", (code, terminated) => {
      if (interrupted) kill("SIGKILL");
      cleanup();
      if (interrupted || signal.aborted)
        reject(new RunnerError("Handler stopped or timed out; input not acknowledged."));
      else if (code === 0 && !terminated) resolveResult();
      else reject(new RunnerError("Handler failed; input not acknowledged."));
    });
    child.stdin.end(JSON.stringify(envelope));
    if (signal.aborted) stop();
  });
}
async function dispatch(event, connection, binding, options, signal) {
  if (!DISPATCHED.has(event.type)) return false;
  let result;
  try {
    result = await request(
      connection,
      `/api/tenants/${connection.tenant}/channels/${binding.channel}/messages/${event.resourceId}`,
      signal,
    );
  } catch (error) {
    if (error.status === 404 || error.status === 410) return false;
    throw error;
  }
  const message = result?.message;
  if (
    !message ||
    message.id !== event.resourceId ||
    message.tenant !== binding.tenant ||
    message.channel !== binding.channel ||
    !validName(message.username) ||
    typeof message.text !== "string" ||
    Buffer.byteLength(message.text) > 65536 ||
    !["text/plain", "application/json"].includes(message.contentType) ||
    (message.to !== undefined && !validName(message.to)) ||
    (event.type === "message.edited" && typeof message.editedAt !== "string")
  )
    throw new RunnerError("Canonical message identity or content is invalid.");
  if (message.username === connection.username) return false;
  if (message.to !== connection.username && !(options.includeBroadcast && message.to === undefined))
    return false;
  const envelope = {
    schema: "msn.dispatch.v1",
    event,
    message,
    identity: {
      origin: connection.origin,
      tenant: binding.tenant,
      channel: binding.channel,
      username: connection.username,
    },
    idempotencyKey: dispatchKey(binding, event.id),
  };
  // An edit changes a message the handler may already have acted on; say so plainly (ADR 0052).
  if (event.type === "message.edited")
    envelope.notice = `Message ${message.id} from ${message.username} was edited at ${message.editedAt}. Its new text is in message.text; it replaces what you read before.`;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      await runHandler(options.command, envelope, connection, options.handlerTimeoutMs, signal);
      return true;
    } catch (error) {
      if (signal.aborted || attempt === options.attempts) throw error;
      await delay(Math.min(250 * 2 ** (attempt - 1), 2000), undefined, { signal });
    }
  }
  return false;
}
export async function run(options, signal = new AbortController().signal, env = process.env) {
  const connection = options.profile
    ? await loadProfile(options.profile, env)
    : {
        origin: normalizeOrigin(env.MSN_URL),
        tenant: env.MSN_WORKSPACE_TENANT ?? env.MSN_TENANT,
        token: env.MSN_WORKSPACE_TOKEN ?? env.MSN_TOKEN,
        username: options.username,
      };
  if (
    !SLUG.test(connection.tenant ?? "") ||
    typeof connection.token !== "string" ||
    !connection.token.trim()
  ) {
    throw new RunnerError("Valid workspace connection credentials are required.");
  }
  const identity = await request(connection, `/api/tenants/${connection.tenant}`, signal);
  connection.username = options.username || connection.username || identity.username;
  if (
    identity.tenant !== connection.tenant ||
    !validName(connection.username) ||
    (identity.username != null && identity.username !== connection.username) ||
    (identity.usernamePrefix != null && !connection.username.startsWith(identity.usernamePrefix)) ||
    (identity.channel != null && identity.channel !== options.channel)
  )
    throw new RunnerError("Identity or channel does not match this access key.");
  const binding = {
    server: connection.origin,
    tenant: connection.tenant,
    channel: options.channel,
    reader: connection.username,
  };
  const checkpoint = await acquireCheckpoint(options.stateFile, binding);
  const commits = serverCommitsEnabled(!options.local, env)
    ? new ServerCommits({
        request,
        connection,
        channel: binding.channel,
        reader: binding.reader,
        generation: checkpoint.generation,
        save: (generation) => checkpoint.saveGeneration(generation),
        role: "msn dispatcher",
      })
    : null;
  let reported = false;
  let reconnect = 500;
  try {
    do {
      if (signal.aborted) break;
      try {
        const params = new URLSearchParams({
          after: String(checkpoint.after),
          channel: binding.channel,
          limit: "100",
          wait: String(options.wait),
          include: "edits",
        });
        const page = await request(connection, `/api/tenants/${connection.tenant}/events?${params}`, signal);
        const events = validatePage(page, binding, checkpoint.after);
        // An empty page may mean the board was archived (ADR 0046): nothing new can arrive, so
        // stop instead of waiting forever. One empty message page (before=1) carries the flag.
        if (!events.length && !options.once) {
          const probe = await request(
            connection,
            `/api/tenants/${connection.tenant}/channels/${binding.channel}/messages?after=0&before=1&limit=1`,
            signal,
          );
          if (probe?.archived === true) {
            const error = new RunnerError(
              `board_archived: Board ${binding.channel} is archived and read-only, so no new messages will arrive. Stopping; the board owner can run msn board unarchive ${binding.channel}.`,
            );
            error.code = "board_archived";
            throw error;
          }
        }
        for (const event of events) {
          if (signal.aborted) break;
          const acted = await dispatch(event, connection, binding, options, signal);
          if (signal.aborted) break;
          await checkpoint.commit(event.id);
          process.stdout.write(
            `${JSON.stringify({ eventId: event.id, dispatched: acted, acknowledgedThrough: checkpoint.after })}\n`,
          );
          // Acknowledged means finished with this message, so commit it on the server (ADR 0053).
          if (commits && event.type === "message.created") {
            let result;
            try {
              result = await commits.commit(event.resourceId, signal);
            } catch (error) {
              if (!(error instanceof Fenced)) throw error;
              const stopped = new RunnerError(`${error.message} Stopping this dispatcher.`);
              stopped.code = "processing_fenced";
              throw stopped;
            }
            if (result.status === "unavailable" && !reported) {
              reported = true;
              process.stderr.write(
                `No processed-by receipts for ${binding.reader}: ${result.reason}. ${unavailableHint(result.reason)}\n`,
              );
            }
          }
        }
        reconnect = 500;
        if (options.once) break;
      } catch (error) {
        if (signal.aborted) break;
        if (!error.retryable || options.once) throw error;
        process.stderr.write(
          "Temporary server/transport failure; replaying from the committed event cursor.\n",
        );
        await delay(reconnect + Math.floor(Math.random() * 250), undefined, { signal });
        reconnect = Math.min(reconnect * 2, 15000);
      }
    } while (!signal.aborted);
  } finally {
    await checkpoint.close();
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => controller.abort());
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(HELP);
    else await run(options, controller.signal);
    if (controller.signal.aborted) process.exitCode = 130;
  } catch (error) {
    process.stderr.write(
      `${error instanceof RunnerError ? error.message : "Event dispatcher stopped; checkpoint was not reset."}\n`,
    );
    // Exit 5 (conflict), like msn wait: a supervisor should not restart a listener on an archived
    // board, or one that another machine took over (ADR 0034).
    process.exitCode = controller.signal.aborted
      ? 130
      : ["board_archived", "processing_fenced"].includes(error?.code)
        ? 5
        : 1;
  }
}
