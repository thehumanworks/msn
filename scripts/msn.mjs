#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { addressees } from "./host/protocol.mjs";

export const help = `msn — channel messaging for agents and humans (Node 22+)

Environment: MSN_URL, MSN_WORKSPACE_TENANT, MSN_WORKSPACE_TOKEN, optional MSN_USERNAME
Legacy aliases: MSN_TENANT, MSN_TOKEN (canonical workspace variables take precedence)
Admin only:  MSN_ADMIN_TOKEN (never reuse a tenant key)

node scripts/msn.mjs whoami
node scripts/msn.mjs channels
node scripts/msn.mjs create CHANNEL
node scripts/msn.mjs send CHANNEL --text 'hello' [--to USERNAME ...] [--key RETRY_KEY] [--reply-to ID [--quote TEXT]] [--correlation-id STR]
node scripts/msn.mjs send CHANNEL --json '{"op":"ping"}' [--key RETRY_KEY]
node scripts/msn.mjs poll CHANNEL [--after 0] [--wait 25] [--limit 100]
node scripts/msn.mjs follow CHANNEL [--after 0] [--cursor-file ./cursor.json]
node scripts/msn.mjs wait --all --cursor-file ./boards.json [--username NAME] [--wait 25]
node scripts/msn.mjs provision TENANT [--username NAME | --username-prefix PREFIX]
node scripts/msn.mjs rotate TENANT [--username NAME | --username-prefix PREFIX | --unbind]
node scripts/msn.mjs keys
node scripts/msn.mjs key-create KEY --username NAME [or --username-prefix PREFIX]
node scripts/msn.mjs key-revoke KEY
node scripts/msn.mjs delete CHANNEL MESSAGE_ID

poll defaults to wait=0; repeat a cursor to reread surviving messages.
follow prints one JSON message per line; cursor files are tenant/channel/server-bound.
wait --all blocks until a message addressed to you (--username, MSN_USERNAME or the key's name)
arrives on any board, prints {channel, message, messages, nextCursor} and moves only that board's
cursor in the --cursor-file, which keeps one cursor per board (a new board starts at 0).
Send retries MUST reuse --key after an uncertain result (printed to stderr).
--reply-to (same-channel message id), --quote (with --reply-to: the part of that message you answer)
and --correlation-id (opaque, <=128 bytes) are optional
annotations agents can filter on; every reader still receives every message.
--to USERNAME addresses a participant in the channel; repeat it for up to 8. It does not make a message private.
--json sends contentType application/json; invalid JSON exits 2 without any request.
Messages carry contentType (text/plain default); only parse text when it is application/json.
Provision/rotate print a secret once. Save securely; don't paste into shared channels.
A token bound with --username (or --username-prefix) may only send as that name (prefix);
the server answers 403 username_bound otherwise. rotate keeps the bind unless you pass
a new one or --unbind. Rotation revokes ALL participant keys in that workspace.
MSN_USERNAME never binds a token; key-create requires an explicit binding flag.
send infers the username from exact-name participant keys when MSN_USERNAME is absent.
Use the Rust msn CLI for shell profiles and persisted bounded reads (msn read).
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

// Same .lock protocol as the Rust CLI, including canonical path aliases. A dead
// process leaves a lock: never guess whether it is safe to remove someone else's.
async function lockCursor(file) {
  let path;
  try {
    path = await realpath(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      if ((await lstat(file)).isSymbolicLink())
        throw new Error("Cursor file must not be a dangling symlink.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    path = join(await realpath(dirname(file)), basename(file));
  }
  const lockPath = `${path}.lock`;
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        `Cursor is locked: ${lockPath}. After confirming the owner is no longer running, manually remove this .lock file and retry.`,
      );
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`);
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
    throw error;
  }
  return { path, lockPath };
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
      "reply-to": { type: "string" },
      quote: { type: "string" },
      "correlation-id": { type: "string" },
      to: { type: "string", multiple: true },
      after: { type: "string" },
      wait: { type: "string" },
      limit: { type: "string" },
      "cursor-file": { type: "string" },
      username: { type: "string" },
      "username-prefix": { type: "string" },
      unbind: { type: "boolean" },
      all: { type: "boolean" },
    },
  });
  if (values.help || !positionals.length) {
    out(help);
    return;
  }
  if (env.MSN_PROFILE !== undefined)
    throw new UsageError(
      "MSN_PROFILE selects a Rust CLI profile. Use msn, or unset MSN_PROFILE and configure this Node client explicitly.",
    );
  const [command, target, id] = positionals;
  if (
    ![
      "whoami",
      "keys",
      "key-create",
      "key-revoke",
      "channels",
      "create",
      "send",
      "poll",
      "follow",
      "wait",
      "provision",
      "rotate",
      "delete",
    ].includes(command)
  )
    throw new Error(`Unknown command: ${command}`);
  if (command === "wait" && !values.all)
    throw new UsageError("wait needs --all here; use the msn CLI to wait on one board.");
  const expected = ["channels", "whoami", "keys", "wait"].includes(command)
    ? 1
    : command === "delete"
      ? 3
      : 2;
  if (positionals.length !== expected) throw new Error("Wrong arguments. Run --help.");
  const admin = ["provision", "rotate", "delete", "keys", "key-create", "key-revoke"].includes(command);
  const token = admin ? env.MSN_ADMIN_TOKEN : (env.MSN_WORKSPACE_TOKEN ?? env.MSN_TOKEN);
  if (!token) throw new Error(`Set ${admin ? "MSN_ADMIN_TOKEN" : "MSN_WORKSPACE_TOKEN (or MSN_TOKEN)"}.`);
  const base = new URL(env.MSN_URL ?? "http://localhost:8787");
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/")
    throw new Error("MSN_URL must be a server origin without credentials, path, query or fragment.");
  if (
    base.protocol !== "https:" &&
    !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
  )
    throw new Error("Use HTTPS (HTTP is allowed only on localhost).");
  const tenant = slug(
    ["provision", "rotate"].includes(command) ? target : (env.MSN_WORKSPACE_TENANT ?? env.MSN_TENANT),
  );
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
  if (["provision", "rotate", "key-create"].includes(command)) {
    const chosen = [
      values.username !== undefined,
      values["username-prefix"] !== undefined,
      values.unbind,
    ].filter(Boolean).length;
    if (chosen > 1 || (values.unbind && command !== "rotate"))
      throw new Error("Use only one of --username, --username-prefix or --unbind (rotate only).");
    if (command === "key-create" && chosen !== 1)
      throw new UsageError(
        "key-create requires --username NAME or --username-prefix PREFIX; MSN_USERNAME never binds a key.",
      );
    for (const value of [values.username, values["username-prefix"]]) {
      if (value !== undefined && (!value.trim() || Buffer.byteLength(value) > 128))
        throw new UsageError("Key binding must be non-blank and at most 128 UTF-8 bytes.");
    }
    // No body: provision stays unbound and rotate keeps the current bind. Env MSN_USERNAME never binds.
    const bind = values.username
      ? { username: values.username }
      : values["username-prefix"]
        ? { usernamePrefix: values["username-prefix"] }
        : values.unbind
          ? { username: null }
          : undefined;
    out(
      JSON.stringify(
        await request(
          command === "rotate" ? "/token" : command === "key-create" ? `/keys/${slug(target)}` : "",
          {
            method: command === "rotate" ? "POST" : "PUT",
            ...(bind ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(bind) } : {}),
          },
        ),
      ),
    );
    return;
  }
  if (command === "whoami" || command === "keys") {
    out(JSON.stringify(await request(command === "whoami" ? "" : "/keys")));
    return;
  }
  if (command === "key-revoke") {
    out(JSON.stringify(await request(`/keys/${slug(target)}`, { method: "DELETE" })));
    return;
  }
  if (command === "channels") {
    out(JSON.stringify(await request("/channels?limit=1000")));
    return;
  }
  if (command === "wait") {
    await waitAll({ request, values, env, base, tenant, out, err, signal });
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
    // --username overrides MSN_USERNAME for this send; a token bound to another name is
    // rejected by the server with 403 username_bound.
    let username = values.username ?? env.MSN_USERNAME;
    if (!content?.trim()) throw new UsageError("Pass --text or --json with a non-blank message.");
    if (username !== undefined && (!username.trim() || Buffer.byteLength(username) > 128))
      throw new UsageError("Username must be non-blank and at most 128 UTF-8 bytes.");
    // Unset typing and correlation fields are omitted, so a plain --text send is byte-for-byte
    // what it was before either feature.
    const body = { username, text: content };
    if (values.json !== undefined) {
      // Validate locally so malformed JSON never reaches the Worker.
      try {
        JSON.parse(content);
      } catch {
        throw new UsageError("--json must be valid JSON.");
      }
      body.contentType = "application/json";
    }
    if (values["reply-to"] !== undefined) {
      body.replyTo = number(values["reply-to"], 0, Number.MAX_SAFE_INTEGER);
      if (!body.replyTo) throw new UsageError("--reply-to must be a positive message id.");
    }
    if (values.quote !== undefined) {
      // A quote (ADR 0059) is the part of the --reply-to message being answered.
      if (body.replyTo === undefined) throw new UsageError("--quote needs --reply-to.");
      if (!values.quote.trim() || Buffer.byteLength(values.quote) > 2048)
        throw new UsageError("--quote must be non-blank text of at most 2,048 UTF-8 bytes.");
      body.quote = values.quote;
    }
    if (values["correlation-id"] !== undefined) {
      const id = values["correlation-id"];
      if (!id.trim() || Buffer.byteLength(id) > 128)
        throw new UsageError("--correlation-id must be non-blank text of at most 128 UTF-8 bytes.");
      body.correlationId = id;
    }
    if (values.to !== undefined) {
      // Repeat --to for up to 8 names (ADR 0067); one name is sent as text, as before.
      const names = values.to;
      if (names.length > 8) throw new UsageError("--to names at most 8 people.");
      if (names.some((name) => !name.trim() || Buffer.byteLength(name) > 128))
        throw new UsageError("--to must be a non-blank username of at most 128 UTF-8 bytes.");
      if (new Set(names.map((name) => name.trim().toLowerCase())).size !== names.length)
        throw new UsageError("--to names someone twice.");
      body.to = names.length === 1 ? names[0] : names;
    }
    // Validate the payload before networking, then infer an exact-name key's sender.
    if (username === undefined) {
      const identity = await request("");
      if (identity.tenant !== tenant) throw new Error("Identity response belongs to a different workspace.");
      username = identity.username;
      if (typeof username !== "string" || !username.trim() || Buffer.byteLength(username) > 128)
        throw new UsageError("This key has no exact username binding. Choose --username NAME.");
      body.username = username;
    }
    const key = values.key ?? randomUUID();
    err(`Idempotency-Key: ${key}`);
    out(
      JSON.stringify(
        await request(`${path}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": key },
          body: JSON.stringify(body),
        }),
      ),
    );
    return;
  }
  let after = number(values.after, 0, Number.MAX_SAFE_INTEGER);
  const wait = number(values.wait, command === "follow" ? 25 : 0, 25);
  const limit = number(values.limit, 100, 100);
  if (!limit || (command === "follow" && !wait)) throw new Error("limit and follow wait must be positive.");
  let file = values["cursor-file"];
  if (file && command !== "follow") throw new Error("--cursor-file is only supported by follow.");
  const binding = { server: base.origin, tenant, channel };
  if (file && values.after !== undefined) throw new Error("Use either --after or --cursor-file, not both.");
  const lock = file ? await lockCursor(file) : null;
  if (lock) file = lock.path;
  try {
    if (file) {
      try {
        const saved = JSON.parse(await readFile(file, "utf8"));
        if (Object.keys(binding).some((key) => saved[key] !== binding[key]))
          throw new Error("Cursor file belongs to a different server, tenant or channel.");
        // A thread cursor (ADR 0063) is not a board cursor; this shim cannot follow threads.
        if (saved.thread !== undefined && saved.thread !== null)
          throw new Error("Cursor file follows one thread; use the msn CLI with --thread for it.");
        after = number(String(saved.after), 0, Number.MAX_SAFE_INTEGER);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    let backoff = 1000;
    do {
      let data;
      try {
        data = await request(`${path}/messages?after=${after}&wait=${wait}&limit=${limit}`);
      } catch (error) {
        if (signal?.aborted) return;
        if (command !== "follow" || (error.status && error.status < 500 && error.status !== 429)) throw error;
        if (error.code && error.code !== "ECONNRESET") throw error;
        err(`${error.message}; reconnecting from cursor ${after}`);
        const { setTimeout } = await import("node:timers/promises");
        try {
          await setTimeout(backoff, undefined, { signal });
        } catch {
          return;
        }
        backoff = Math.min(backoff * 2, 15000);
        continue;
      }
      if (command === "poll") {
        out(JSON.stringify(data));
        return;
      }
      // Output and disk failures are not network errors and must not be retried.
      for (const message of data.messages) out(JSON.stringify(message));
      after = data.nextCursor;
      if (file) {
        const temp = `${file}.${process.pid}.tmp`;
        try {
          await writeFile(temp, `${JSON.stringify({ ...binding, after })}\n`, { mode: 0o600 });
          await rename(temp, file);
        } finally {
          await unlink(temp).catch(() => {});
        }
      }
      backoff = 1000;
    } while (!signal?.aborted);
  } finally {
    if (lock) {
      await unlink(lock.lockPath).catch((error) =>
        err(`Could not remove cursor lock ${lock.lockPath}: ${error.message}`),
      );
    }
  }
}

/** A message addressed to `me` by someone else; names match trimmed and ignoring case (ADR 0069). */
export function addressedTo(message, me) {
  const self = me.trim().toLowerCase();
  if (!self || message.username === me) return false;
  return addressees(message).some((to) => to.trim().toLowerCase() === self);
}

/**
 * `wait --all` (ADR 0069): catch every board up from its cursor, then long-poll the event feed
 * and read only the boards it names, until a message addressed to this agent arrives.
 */
async function waitAll({ request, values, env, base, tenant, out, err, signal }) {
  let file = values["cursor-file"];
  if (!file) throw new UsageError("wait --all needs --cursor-file FILE to keep each board's cursor.");
  if (values.after !== undefined || values.limit !== undefined)
    throw new UsageError("wait --all keeps a cursor per board; --after and --limit do not apply.");
  const wait = number(values.wait, 25, 25);
  if (!wait) throw new Error("wait must be positive.");
  let me = values.username ?? env.MSN_USERNAME;
  if (me === undefined) {
    const identity = await request("");
    me = identity.username;
    if (typeof me !== "string" || !me.trim())
      throw new UsageError("This key has no exact username binding. Choose --username NAME.");
  }
  const lock = await lockCursor(file);
  file = lock.path;
  const binding = { server: base.origin, tenant, name: me };
  let boards = {};
  try {
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (Object.keys(binding).some((key) => saved[key] !== binding[key]))
        throw new Error("Cursor file belongs to a different server, tenant or name.");
      boards = saved.boards ?? {};
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Read the event head first, so a message sent while catching up still has a newer event.
    let events;
    try {
      events = (await request("/events/head")).head;
    } catch (error) {
      if (error.status !== 404) throw error;
      // A server before ADR 0069: page the journal to its end instead.
      events = 0;
      for (let more = true; more; ) {
        const page = await request(`/events?after=${events}&limit=100`);
        events = page.nextCursor;
        more = page.hasMore;
      }
    }
    const read = {};
    const scan = async (channel) => {
      const start = boards[channel] ?? 0;
      let after = Math.max(start, read[channel] ?? 0);
      for (;;) {
        const page = await request(`/channels/${channel}/messages?after=${after}&limit=100`);
        if (!page.messages.length && page.archived) return null;
        const found = page.messages.findIndex((message) => addressedTo(message, me));
        if (found >= 0) {
          const message = page.messages[found];
          // The board's new messages through the addressed one, as `msn wait CHANNEL` prints them.
          const messages = [];
          for (let from = start; from < message.id; ) {
            const chunk = await request(`/channels/${channel}/messages?after=${from}&limit=100`);
            messages.push(...chunk.messages.filter((m) => m.id <= message.id));
            if (!chunk.messages.length || chunk.nextCursor <= from) break;
            from = chunk.nextCursor;
          }
          return { channel, message, messages };
        }
        if (!page.messages.length || !page.hasMore || page.nextCursor <= after) {
          read[channel] = Math.max(after, page.nextCursor);
          return null;
        }
        after = page.nextCursor;
      }
    };
    const listed = [];
    for (let after = "", more = true; more; ) {
      const page = await request(`/channels?limit=1000&after=${after}`);
      listed.push(...page.channels.map((row) => row.name));
      more = page.hasMore && page.channels.length > 0;
      after = page.channels.at(-1)?.name ?? after;
    }
    let hit = null;
    for (const channel of listed) if (!hit) hit = await scan(slug(channel));
    let backoff = 1000;
    while (!hit && !signal?.aborted) {
      let page;
      try {
        page = await request(`/events?after=${events}&wait=${wait}&limit=100`);
      } catch (error) {
        if (signal?.aborted) return;
        if (error.status && error.status < 500 && error.status !== 429) throw error;
        err(`${error.message}; reconnecting from event ${events}`);
        const { setTimeout } = await import("node:timers/promises");
        try {
          await setTimeout(backoff, undefined, { signal });
        } catch {
          return;
        }
        backoff = Math.min(backoff * 2, 15000);
        continue;
      }
      backoff = 1000;
      events = page.nextCursor;
      const touched = [
        ...new Set(
          page.events
            .filter((event) => event.type === "message.created" || event.type === "channel.created")
            .map((event) => event.channel),
        ),
      ];
      for (const channel of touched) if (!hit) hit = await scan(slug(channel));
    }
    if (!hit) return;
    out(JSON.stringify({ ...hit, nextCursor: hit.message.id }));
    const temp = `${file}.${process.pid}.tmp`;
    try {
      const next = { ...binding, boards: { ...boards, [hit.channel]: hit.message.id } };
      await writeFile(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      await rename(temp, file);
    } finally {
      await unlink(temp).catch(() => {});
    }
  } finally {
    await unlink(lock.lockPath).catch((error) =>
      err(`Could not remove cursor lock ${lock.lockPath}: ${error.message}`),
    );
  }
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
