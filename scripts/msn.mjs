#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const help = `msn — channel messaging for agents and humans (Node 22+)

Environment: MSN_URL, MSN_TENANT, MSN_TOKEN, MSN_USERNAME
Admin only:  MSN_ADMIN_TOKEN (never reuse a tenant key)

node scripts/msn.mjs channels
node scripts/msn.mjs create CHANNEL
node scripts/msn.mjs send CHANNEL --text 'hello' [--key RETRY_KEY]
node scripts/msn.mjs send CHANNEL --json '{"op":"ping"}' [--key RETRY_KEY]
node scripts/msn.mjs poll CHANNEL [--after 0] [--wait 25] [--limit 100]
node scripts/msn.mjs follow CHANNEL [--after 0] [--cursor-file ./cursor.json]
node scripts/msn.mjs provision TENANT
node scripts/msn.mjs rotate TENANT
node scripts/msn.mjs delete CHANNEL MESSAGE_ID

poll defaults to wait=0; repeat a cursor to reread surviving messages.
follow prints one JSON message per line; cursor files are tenant/channel/server-bound.
Send retries MUST reuse --key after an uncertain result (printed to stderr).
--json sends contentType application/json; invalid JSON exits 2 without any request.
Messages carry contentType (text/plain default); only parse text when it is application/json.
Provision/rotate print a secret once. Save securely; don't paste into shared channels.
`;

class UsageError extends Error {
  exitCode = 2;
}

function number(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max)
    throw new Error(`Invalid integer: ${value}`);
  return Number(value);
}
function slug(value) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value ?? ""))
    throw new Error("Use a lowercase tenant/channel identifier (1–64 letters, digits, _ or -).");
  return value;
}

export async function run({
  argv = process.argv.slice(2),
  env = process.env,
  fetcher = fetch,
  out = console.log,
  err = console.error,
  signal,
} = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      text: { type: "string" },
      json: { type: "string" },
      key: { type: "string" },
      after: { type: "string" },
      wait: { type: "string" },
      limit: { type: "string" },
      "cursor-file": { type: "string" },
    },
  });
  if (values.help || !positionals.length) {
    out(help);
    return;
  }
  const [command, target, id] = positionals;
  if (!["channels", "create", "send", "poll", "follow", "provision", "rotate", "delete"].includes(command))
    throw new Error(`Unknown command: ${command}`);
  const expected = command === "channels" ? 1 : command === "delete" ? 3 : 2;
  if (positionals.length !== expected) throw new Error("Wrong arguments. Run --help.");
  const admin = ["provision", "rotate", "delete"].includes(command);
  const token = env[admin ? "MSN_ADMIN_TOKEN" : "MSN_TOKEN"];
  if (!token) throw new Error(`Set ${admin ? "MSN_ADMIN_TOKEN" : "MSN_TOKEN"}.`);
  const base = new URL(env.MSN_URL ?? "http://localhost:8787");
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/")
    throw new Error("MSN_URL must be a server origin without credentials, path, query or fragment.");
  if (
    base.protocol !== "https:" &&
    !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
  )
    throw new Error("Use HTTPS (HTTP is allowed only on localhost).");
  const tenant = slug(["provision", "rotate"].includes(command) ? target : env.MSN_TENANT);
  const prefix = `/api/${admin ? "admin/" : ""}tenants/${tenant}`;
  async function request(path, options = {}) {
    const response = await fetcher(`${base.origin}${prefix}${path}`, {
      ...options,
      signal,
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
    const data = response.status === 204 ? { deleted: true } : await response.json();
    if (!response.ok) {
      const error = new Error(`${response.status}: ${data.error?.message ?? "Request failed"}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  if (command === "provision" || command === "rotate") {
    out(
      JSON.stringify(
        await request(command === "rotate" ? "/token" : "", {
          method: command === "rotate" ? "POST" : "PUT",
        }),
      ),
    );
    return;
  }
  if (command === "channels") {
    out(JSON.stringify(await request("/channels?limit=1000")));
    return;
  }
  const channel = slug(target);
  const path = `/channels/${channel}`;
  if (command === "create") {
    out(JSON.stringify(await request(path, { method: "PUT" })));
    return;
  }
  if (command === "delete") {
    out(
      JSON.stringify(
        await request(`${path}/messages/${number(id, 0, Number.MAX_SAFE_INTEGER)}`, { method: "DELETE" }),
      ),
    );
    return;
  }
  if (command === "send") {
    if (values.text !== undefined && values.json !== undefined)
      throw new UsageError("Pass either --text or --json, not both.");
    const content = values.json ?? values.text;
    if (!env.MSN_USERNAME?.trim() || !content?.trim())
      throw new UsageError("Set MSN_USERNAME and pass --text or --json.");
    const payload = { username: env.MSN_USERNAME, text: content };
    if (values.json !== undefined) {
      // Validate locally so malformed JSON never reaches the Worker.
      try {
        JSON.parse(content);
      } catch {
        throw new UsageError("--json must be valid JSON.");
      }
      payload.contentType = "application/json";
    }
    const key = values.key ?? randomUUID();
    err(`Idempotency-Key: ${key}`);
    out(
      JSON.stringify(
        await request(`${path}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": key },
          body: JSON.stringify(payload),
        }),
      ),
    );
    return;
  }
  let after = number(values.after, 0, Number.MAX_SAFE_INTEGER);
  const wait = number(values.wait, command === "follow" ? 25 : 0, 25);
  const limit = number(values.limit, 100, 100);
  if (!limit || (command === "follow" && !wait)) throw new Error("limit and follow wait must be positive.");
  const file = values["cursor-file"];
  if (file && command !== "follow") throw new Error("--cursor-file is only supported by follow.");
  const binding = { server: base.origin, tenant, channel };
  if (file) {
    if (values.after !== undefined) throw new Error("Use either --after or --cursor-file, not both.");
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (Object.keys(binding).some((key) => saved[key] !== binding[key]))
        throw new Error("Cursor file belongs to a different server, tenant or channel.");
      after = number(String(saved.after), 0, Number.MAX_SAFE_INTEGER);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  let backoff = 1000;
  do {
    try {
      const data = await request(`${path}/messages?after=${after}&wait=${wait}&limit=${limit}`);
      if (command === "poll") {
        out(JSON.stringify(data));
        return;
      }
      for (const message of data.messages) out(JSON.stringify(message));
      after = data.nextCursor;
      if (file) {
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, `${JSON.stringify({ ...binding, after })}\n`, { mode: 0o600 });
        await rename(temp, file);
      }
      backoff = 1000;
    } catch (error) {
      if (signal?.aborted) return;
      if (command !== "follow" || (error.status && error.status < 500 && error.status !== 429)) throw error;
      // Local disk failures are not retryable network errors.
      if (error.code && error.code !== "ECONNRESET") throw error;
      err(`${error.message}; reconnecting from cursor ${after}`);
      const { setTimeout } = await import("node:timers/promises");
      try {
        await setTimeout(backoff, undefined, { signal });
      } catch {
        return;
      }
      backoff = Math.min(backoff * 2, 15000);
    }
  } while (!signal?.aborted);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  run({ signal: controller.signal }).catch((error) => {
    if (!controller.signal.aborted) {
      console.error(error.message);
      process.exitCode = error.exitCode ?? 1;
    }
  });
}
