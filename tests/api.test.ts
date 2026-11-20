import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { type Message, payload } from "../src/store";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}
const ADMIN = "test-admin-secret-000000000000000000000";
const WRONG = "wrong-token-00000000000000000000000000";
type Page = { messages: Message[]; nextCursor: number; hasMore: boolean };
const SCHEMA_HISTORY = [
  { version: 1 },
  { version: 2 },
  { version: 3 },
  { version: 4 },
  { version: 5 },
  { version: 6 },
  { version: 7 },
  { version: 8 },
  { version: 9 },
  { version: 10 },
  { version: 11 },
  { version: 12 },
  { version: 13 },
  { version: 14 },
  { version: 15 },
  { version: 16 },
  { version: 17 },
  { version: 18 },
];
/**
 * Rewinds a live database to an older schema version — dropping every column added after it —
 * so the constructor migration runs the whole chain again on the next restart.
 */
function rewind(state: DurableObjectState, version: 1 | 2 | 3 | 4 | 5): void {
  state.storage.transactionSync(() => {
    state.storage.sql.exec("DROP TABLE snapshots");
    state.storage.sql.exec("DROP TABLE channel_history");
    state.storage.sql.exec("DROP TABLE invites");
    if (version < 5) state.storage.sql.exec("DROP TABLE access_keys");
    else state.storage.sql.exec("ALTER TABLE access_keys DROP COLUMN channel_scope");
    if (version < 6) state.storage.sql.exec("ALTER TABLE messages DROP COLUMN recipient");
    if (version < 4) {
      state.storage.sql.exec("ALTER TABLE tenant DROP COLUMN bound_username");
      state.storage.sql.exec("ALTER TABLE tenant DROP COLUMN bound_prefix");
    }
    if (version < 3) state.storage.sql.exec("ALTER TABLE messages DROP COLUMN contentType");
    if (version < 2) {
      state.storage.sql.exec("ALTER TABLE messages DROP COLUMN replyTo");
      state.storage.sql.exec("ALTER TABLE messages DROP COLUMN correlationId");
    }
    state.storage.sql.exec("DELETE FROM schema_version WHERE version > ?", version);
  });
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (path: string, token?: string, init: RequestInit = {}) =>
  exports.default.fetch(`https://msn.test${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
type Identity = { tenant: string; token?: string; username: string | null; usernamePrefix: string | null };
const jsonBody = (data: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});
async function tenant(bind?: Record<string, unknown>) {
  const name = `t-${crypto.randomUUID()}`;
  const response = await call(`/api/admin/tenants/${name}`, ADMIN, {
    method: "PUT",
    ...(bind ? jsonBody(bind) : {}),
  });
  expect(response.status).toBe(201);
  const identity = await response.json<Identity>();
  return {
    name,
    token: identity.token as string,
    identity,
    path: `/api/tenants/${name}`,
    admin: `/api/admin/tenants/${name}`,
    stub: env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", name])),
  };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;
async function whoami(t: Tenant): Promise<Identity> {
  const response = await call(t.path, t.token);
  expect(response.status).toBe(200);
  return response.json<Identity>();
}
async function rotate(t: Tenant, bind?: Record<string, unknown>): Promise<Identity> {
  const response = await call(`${t.admin}/token`, ADMIN, { method: "POST", ...(bind ? jsonBody(bind) : {}) });
  expect(response.status).toBe(200);
  const identity = await response.json<Identity>();
  t.token = identity.token as string;
  return identity;
}
async function send(
  t: Tenant,
  content = "hello",
  channel = "general",
  key?: string,
  username = "human / agent",
  // An object adds arbitrary body fields; anything else is shorthand for { contentType }.
  extra: Record<string, unknown> | string = {},
) {
  return call(`${t.path}/channels/${channel}/messages`, t.token, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify({
      username,
      text: content,
      ...(typeof extra === "object" && extra !== null ? extra : { contentType: extra }),
    }),
  });
}
async function page(t: Tenant, query = "", channel = "general"): Promise<Page> {
  const response = await call(`${t.path}/channels/${channel}/messages${query}`, t.token);
  expect(response.status).toBe(200);
  return response.json<Page>();
}
async function pending(t: Tenant): Promise<number> {
  return runInDurableObject(
    t.stub,
    (instance) => (instance as unknown as { waiters: Set<unknown> }).waiters.size,
  );
}

describe("channel messaging on real workerd SQLite Durable Objects", () => {
  it("fails closed for missing admin configuration and invalid credentials", async () => {
    expect(
      (
        await worker.fetch(new Request("https://msn.test/api/admin/tenants/test", { method: "PUT" }), {
          ...env,
          ADMIN_TOKEN: "",
        })
      ).status,
    ).toBe(503);
    expect((await call("/api/admin/tenants/test", undefined, { method: "PUT" })).status).toBe(401);
    expect((await call("/api/admin/tenants/test", WRONG, { method: "PUT" })).status).toBe(403);
    expect((await call("/api/tenants/missing/channels", WRONG)).status).toBe(401);
  });

  it("provisions once; keys are isolated from tenants, admin roles and origins", async () => {
    const a = await tenant();
    const b = await tenant();
    expect(a.token).toMatch(/^[a-f0-9]{64}$/);
    expect((await call(a.admin, ADMIN, { method: "PUT" })).status).toBe(409);
    expect((await call(`${b.path}/channels`, a.token)).status).toBe(401);
    expect((await call(`${a.path}/channels`, ADMIN)).status).toBe(401);
    expect((await call(`${a.admin}/token`, a.token, { method: "POST" })).status).toBe(403);
    expect(
      (await call(`${a.path}/channels`, a.token, { headers: { Origin: "https://evil.test" } })).status,
    ).toBe(403);
    expect((await call(`${a.path}/channels?token=${a.token}`)).status).toBe(401);
    const response = await call(`${a.path}/channels`, a.token);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("round-trips free usernames, creation date, tenant, channel and Unicode text bidirectionally", async () => {
    const t = await tenant();
    const a = await send(t, "Hello agent 👋", "general", undefined, "Tomas");
    const b = await send(t, "Hello human", "general", undefined, "planner-agent");
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const first = await page(t);
    expect(first.messages.map((m) => m.username)).toEqual(["Tomas", "planner-agent"]);
    expect(first.messages[0]).toMatchObject({ tenant: t.name, channel: "general", text: "Hello agent 👋" });
    expect(new Date(first.messages[0].createdAt).toISOString()).toBe(first.messages[0].createdAt);
    expect(first.messages.map((m) => m.contentType)).toEqual(["text/plain", "text/plain"]); // omitted defaults
    expect(await page(t)).toEqual(first); // reads do not consume
    expect(await page(t, `?after=${first.nextCursor}`)).toEqual({
      messages: [],
      nextCursor: first.nextCursor,
      hasMore: false,
    });
  });

  it("types application/json payloads, rejects non-JSON text and unknown types, and keeps text/plain default", async () => {
    const t = await tenant();
    const command = '{"op":"ping","task":42}';
    const typed = await send(t, command, "general", "cmd-1", "planner-agent", "application/json");
    expect(typed.status).toBe(201);
    const explicit = await send(t, "Looks good to me", "general", undefined, "Tomas", "text/plain");
    expect(explicit.status).toBe(201);
    for (const value of ["[1,2]", '"quoted"', "42", " {} "]) {
      expect((await send(t, value, "general", undefined, "agent", "application/json")).status, value).toBe(
        201,
      );
    }
    for (const value of ['{"op":', "not json", "{'op':'ping'}", ""]) {
      const response = await send(t, value, "general", undefined, "agent", "application/json");
      expect(response.status, value).toBe(400);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe("invalid_message");
    }
    for (const value of ["text/html", "application/json; charset=utf-8", "", null, 1]) {
      const response = await send(t, "x", "general", undefined, "agent", value as string);
      expect(response.status, String(value)).toBe(400);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe("invalid_content_type");
    }
    const { messages } = await page(t);
    expect(messages.map((m) => [m.contentType, m.text])).toEqual([
      ["application/json", command],
      ["text/plain", "Looks good to me"],
      ["application/json", "[1,2]"],
      ["application/json", '"quoted"'],
      ["application/json", "42"],
      ["application/json", " {} "],
    ]);
    expect(
      messages.filter((m) => m.contentType === "application/json").map((m) => JSON.parse(m.text)),
    ).toEqual([{ op: "ping", task: 42 }, [1, 2], "quoted", 42, {}]);
    expect((await send(t, "🙂".repeat(4097), "general", undefined, "agent", "application/json")).status).toBe(
      400,
    );
    const big = JSON.stringify({ pad: "x".repeat(16384 - 10) });
    expect(new TextEncoder().encode(big).length).toBe(16384);
    expect((await send(t, big, "general", undefined, "agent", "application/json")).status).toBe(201);
    expect((await send(t, `${big} `, "general", undefined, "agent", "application/json")).status).toBe(400);
  });

  it("includes contentType in the idempotency digest and replays typed messages intact", async () => {
    const t = await tenant();
    const body = '{"op":"ping"}';
    const first = await send(t, body, "general", "typed", "agent", "application/json");
    expect(first.status).toBe(201);
    const replay = await send(t, body, "general", "typed", "agent", "application/json");
    expect(replay.status).toBe(200);
    const created = await first.json<{ message: Message; replayed: boolean }>();
    expect(await replay.json()).toEqual({ message: created.message, replayed: true });
    expect(created.message.contentType).toBe("application/json");
    expect((await send(t, body, "general", "typed", "agent", "text/plain")).status).toBe(409);
    expect((await send(t, body, "general", "typed", "agent")).status).toBe(409);
    expect((await send(t, body, "general", "untyped", "agent")).status).toBe(201);
    expect((await send(t, body, "general", "untyped", "agent", "text/plain")).status).toBe(200);
    expect((await send(t, body, "general", "untyped", "agent", "application/json")).status).toBe(409);
    expect((await page(t)).messages).toHaveLength(2);
  });

  it("migrates a version-2 schema in place so older rows read back as text/plain", async () => {
    const t = await tenant();
    await call(`${t.path}/channels/general`, t.token, { method: "PUT" });
    await runInDurableObject(t.stub, (_, state) => {
      rewind(state, 2);
      state.storage.transactionSync(() => {
        state.storage.sql.exec(
          "INSERT INTO messages(channel, username, text, createdAt, key, digest, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
          "general",
          "legacy",
          "written before contentType existed",
          new Date().toISOString(),
          null,
          "legacy-digest",
          0,
        );
      });
    });
    await abortAllDurableObjects();
    // The constructor migration runs on the first request after the restart; use a fresh stub handle.
    const restarted = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", t.name]));
    const versions = await runInDurableObject(restarted, (_, state) =>
      state.storage.sql
        .exec<{ version: number }>("SELECT version FROM schema_version ORDER BY version")
        .toArray(),
    );
    expect(versions).toEqual(SCHEMA_HISTORY);
    expect((await send(t, '{"op":"after"}', "general", undefined, "agent", "application/json")).status).toBe(
      201,
    );
    expect((await page(t)).messages.map((m) => [m.username, m.contentType])).toEqual([
      ["legacy", "text/plain"],
      ["agent", "application/json"],
    ]);
  });

  it("keeps 60 concurrent sends without lost writes, across independent tenants and channels", async () => {
    const a = await tenant();
    const b = await tenant();
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => send(i % 2 ? a : b, `message-${i}`, i % 3 ? "general" : "other")),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    for (const t of [a, b]) {
      const messages = [...(await page(t)).messages, ...(await page(t, "", "other")).messages];
      expect(messages).toHaveLength(30);
      expect(new Set(messages.map((m) => m.id)).size).toBe(30);
      expect(messages.every((m) => m.tenant === t.name)).toBe(true);
    }
  });

  it("paginates messages and channel names without skips, including interleaved IDs and writes", async () => {
    const t = await tenant();
    for (let i = 0; i < 5; i++) {
      await send(t, String(i));
      await send(t, "other", "z");
    }
    const first = await page(t, "?limit=2");
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(first.messages[1].id);
    await send(t, "5");
    const rest = await page(t, `?after=${first.nextCursor}`);
    expect([...first.messages, ...rest.messages].map((m) => m.text)).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(rest.hasMore).toBe(false);
    const channels = await (await call(`${t.path}/channels?limit=1`, t.token)).json<{
      channels: { name: string }[];
      hasMore: boolean;
      nextCursor: string;
    }>();
    expect(channels).toMatchObject({ channels: [{ name: "general" }], hasMore: true, nextCursor: "general" });
    const next = await (await call(`${t.path}/channels?after=general`, t.token)).json<{
      channels: { name: string }[];
    }>();
    expect(next.channels.map((c) => c.name)).toEqual(["z"]);
  });

  it("deduplicates concurrent retries transactionally and rejects changed payloads", async () => {
    const t = await tenant();
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => send(t, "same", "general", "retry")),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(19);
    expect((await page(t)).messages).toHaveLength(1);
    expect((await send(t, "changed", "general", "retry")).status).toBe(409);
    expect((await send(t, "same", "general", "retry", "someone else")).status).toBe(409);
    expect((await send(t, "same", "other", "retry")).status).toBe(201);
  });

  it("fans out a live message to all pending polls without a read/register race", async () => {
    const t = await tenant();
    await call(`${t.path}/channels/general`, t.token, { method: "PUT" });
    const polls = Array.from({ length: 5 }, () => page(t, "?wait=3"));
    await expect.poll(() => pending(t)).toBe(5);
    await send(t, "wake");
    for (const result of await Promise.all(polls))
      expect(result.messages.map((m) => m.text)).toEqual(["wake"]);
    expect(await pending(t)).toBe(0);
    for (let i = 0; i < 10; i++) {
      const after = (await page(t)).nextCursor;
      const poll = page(t, `?after=${after}&wait=3`);
      await send(t, `race-${i}`);
      expect((await poll).messages[0].text).toBe(`race-${i}`);
    }
  });

  it("times out empty polls, isolates channel wakeups and ignores IDs below a future cursor", async () => {
    const t = await tenant();
    await call(`${t.path}/channels/general`, t.token, { method: "PUT" });
    const start = Date.now();
    const poll = page(t, "?wait=1&after=999");
    await expect.poll(() => pending(t)).toBe(1);
    await send(t, "different channel", "other");
    await send(t, "earlier id");
    expect(await pending(t)).toBe(1);
    expect(await poll).toEqual({ messages: [], hasMore: false, nextCursor: 999 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
    expect(await pending(t)).toBe(0);
  });

  it("cleans up aborted polls and releases the waiter capacity", async () => {
    const t = await tenant();
    await call(`${t.path}/channels/general`, t.token, { method: "PUT" });
    // Call the instance with a local signal to exercise cleanup independent of network propagation.
    const status = await runInDurableObject(t.stub, async (instance) => {
      const controller = new AbortController();
      const response = instance.fetch(
        new Request(`https://msn.test${t.path}/channels/general/messages?wait=2`, {
          headers: { Authorization: `Bearer ${t.token}` },
          signal: controller.signal,
        }),
      );
      await delay(30);
      controller.abort();
      return (await response).status;
    });
    expect(status).toBe(499);
    expect(await pending(t)).toBe(0);
  });

  it("enforces pending-poll caps and rotation revokes old in-flight polls", async () => {
    const t = await tenant();
    await call(`${t.path}/channels/general`, t.token, { method: "PUT" });
    const polls = Array.from({ length: 128 }, () =>
      call(`${t.path}/channels/general/messages?wait=10`, t.token),
    );
    await expect.poll(() => pending(t), { timeout: 5000 }).toBe(128);
    expect((await call(`${t.path}/channels/general/messages?wait=1`, t.token)).status).toBe(429);
    const rotated = await (await call(`${t.admin}/token`, ADMIN, { method: "POST" })).json<{
      token: string;
    }>();
    expect((await Promise.all(polls)).every((r) => r.status === 401)).toBe(true);
    expect(await pending(t)).toBe(0);
    expect((await send(t)).status).toBe(401);
    expect((await call(`${t.path}/channels`, rotated.token)).status).toBe(200);
  });

  it("restricts deletion to admin, preserves monotonic cursors and cannot resurrect deleted retries", async () => {
    const t = await tenant();
    await send(t, "delete me", "general", "key");
    const original = (await page(t)).messages[0];
    const path = `/channels/general/messages/${original.id}`;
    expect((await call(t.path + path, t.token, { method: "DELETE" })).status).toBe(404);
    expect((await call(t.admin + path, undefined, { method: "DELETE" })).status).toBe(401);
    expect((await call(t.admin + path, t.token, { method: "DELETE" })).status).toBe(403);
    expect(
      (await call(`${t.admin}/channels/other/messages/${original.id}`, ADMIN, { method: "DELETE" })).status,
    ).toBe(404);
    expect((await call(t.admin + path, ADMIN, { method: "DELETE" })).status).toBe(204);
    expect((await page(t)).messages).toEqual([]);
    expect((await send(t, "delete me", "general", "key")).status).toBe(410);
    expect((await call(t.admin + path, ADMIN, { method: "DELETE" })).status).toBe(404);
    const stored = await runInDurableObject(t.stub, (_, state) =>
      state.storage.sql.exec("SELECT username, text, deleted FROM messages").one(),
    );
    expect(stored).toEqual({ username: "", text: "", deleted: 1 });
    await send(t, "next");
    expect((await page(t)).messages[0].id).toBeGreaterThan(original.id);
  });

  it("persists history and retry keys across Durable Object restarts", async () => {
    const t = await tenant();
    await send(t, "durable", "general", "survives");
    const original = await page(t);
    // Force a teardown rather than a graceful drain: exercise crash/restart recovery.
    await abortAllDurableObjects();
    expect(await page(t)).toEqual(original);
    expect((await send(t, "durable", "general", "survives")).status).toBe(200);
  });

  it("enforces content/lifetime quotas without partial channel creation or failed-key reservation", async () => {
    const t = await tenant();
    await runInDurableObject(t.stub, (_, state) => {
      state.storage.sql.exec("UPDATE usage SET messages = 100000");
    });
    expect((await send(t, "quota", "new", "failed")).status).toBe(409);
    expect(await (await call(`${t.path}/channels`, t.token)).json()).toMatchObject({ channels: [] });
    await runInDurableObject(t.stub, (_, state) => {
      state.storage.sql.exec("UPDATE usage SET messages = 0, bytes = 134217728");
    });
    expect((await send(t, "quota", "new", "failed")).status).toBe(409);
    await runInDurableObject(t.stub, (_, state) => {
      state.storage.sql.exec("UPDATE usage SET bytes = 0");
    });
    expect((await send(t, "quota", "new", "failed")).status).toBe(201);
  });

  it("rolls back an injected write failure including channel and usage changes", async () => {
    const t = await tenant();
    await runInDurableObject(t.stub, (_, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_write BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'test failure'); END",
      );
    });
    expect((await send(t, "fail", "rollback", "retry")).status).toBe(500);
    const state = await runInDurableObject(t.stub, (_, state) => ({
      channels: state.storage.sql.exec("SELECT * FROM channels").toArray(),
      usage: state.storage.sql.exec("SELECT messages, bytes FROM usage").one(),
    }));
    expect(state).toEqual({ channels: [], usage: { messages: 0, bytes: 0 } });
    await runInDurableObject(t.stub, (_, state) => {
      state.storage.sql.exec("DROP TRIGGER fail_write");
    });
    expect((await send(t, "fail", "rollback", "retry")).status).toBe(201);
  });

  it("rejects a send whose tenant key is rotated while its body is still streaming", async () => {
    const t = await tenant();
    const ready = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const stream = new ReadableStream<Uint8Array>({ start: ready.resolve });
    const streamController = await ready.promise;
    const result = call(`${t.path}/channels/general/messages`, t.token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
    });
    streamController.enqueue(new TextEncoder().encode('{"username":"human",'));
    await delay(30);
    const rotated = await call(`${t.admin}/token`, ADMIN, { method: "POST" });
    expect(rotated.status).toBe(200);
    streamController.enqueue(new TextEncoder().encode('"text":"late write"}'));
    streamController.close();
    expect((await result).status).toBe(401);
    const { token } = await rotated.json<{ token: string }>();
    const channels = await (await call(`${t.path}/channels`, token)).json();
    expect(channels).toMatchObject({ channels: [] });
  });

  it("bounds channel metadata, stores only token hashes and frees content bytes on deletion", async () => {
    const t = await tenant();
    const tokenHash = await runInDurableObject(
      t.stub,
      (_, state) =>
        state.storage.sql.exec<{ token_hash: string }>("SELECT token_hash FROM tenant").one().token_hash,
    );
    expect(tokenHash).not.toBe(t.token);
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    await runInDurableObject(t.stub, (_, state) => {
      state.storage.transactionSync(() => {
        for (let i = 0; i < 1000; i++)
          state.storage.sql.exec(
            "INSERT INTO channels (name, createdAt) VALUES (?, ?)",
            `c-${i}`,
            new Date().toISOString(),
          );
      });
    });
    expect((await call(`${t.path}/channels/overflow`, t.token, { method: "PUT" })).status).toBe(409);
    expect((await send(t, "overflow", "overflow")).status).toBe(409);
    expect((await send(t, "🙂", "c-0", "key", "x")).status).toBe(201);
    const message = (await page(t, "", "c-0")).messages[0];
    const before = await runInDurableObject(t.stub, (_, state) =>
      state.storage.sql.exec("SELECT messages, bytes FROM usage").one(),
    );
    expect(before).toEqual({ messages: 1, bytes: 5 });
    await call(`${t.admin}/channels/c-0/messages/${message.id}`, ADMIN, { method: "DELETE" });
    const after = await runInDurableObject(t.stub, (_, state) =>
      state.storage.sql.exec("SELECT messages, bytes FROM usage").one(),
    );
    expect(after).toEqual({ messages: 1, bytes: 0 });
  });

  // Verification contract for issue #4 (opaque correlation fields; fan-out semantics unchanged):
  // I1 send without replyTo/correlationId yields exactly today's JSON keys -> "omits correlation fields"
  // I2 fields round-trip through send, poll and long-poll follow -> "carries replyTo and correlationId"
  // I3 replyTo to a missing or other-channel id is 400 and stores nothing -> "rejects replyTo"
  // I4 same key + same payload including correlation replays 200 -> "carries replyTo and correlationId"
  // I5 same key + different replyTo/correlationId is 409 -> "includes correlation fields in the digest"
  // I6 key stored before v2 still replays with the same payload -> "includes correlation fields in the digest"
  // I7 v1 databases gain the columns on restart -> "migrates a version 1 schema"
  it("omits correlation fields from JSON when a send does not supply them", async () => {
    const t = await tenant();
    const created = await send(t, "plain", "general", "plain");
    expect(created.status).toBe(201);
    const { message } = await created.json<{ message: Message }>();
    expect(Object.keys(message).sort()).toEqual([
      "channel",
      "contentType",
      "createdAt",
      "id",
      "tenant",
      "text",
      "username",
    ]);
    // Explicit nulls mean "unset", so JSON clients that always serialize every field stay compatible.
    const nulls = await send(t, "nulls", "general", undefined, "human / agent", {
      replyTo: null,
      correlationId: null,
      to: null,
    });
    expect(nulls.status).toBe(201);
    const listed = (await page(t)).messages;
    const unsetShape = ["channel", "contentType", "createdAt", "id", "tenant", "text", "username"];
    expect(listed.map((m) => Object.keys(m).sort())).toEqual([unsetShape, unsetShape]);
    const replay = await send(t, "plain", "general", "plain");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ message, replayed: true });
  });

  it("carries an opaque recipient through send, poll, long-poll wakeups and idempotent replay", async () => {
    const t = await tenant();
    await send(t, "root");
    const after = (await page(t)).nextCursor;
    const waiting = page(t, `?after=${after}&wait=3`);
    await expect.poll(() => pending(t)).toBe(1);
    const created = await send(t, "assigned", "general", "recipient-key", "lead", {
      to: "  agent-🚀  ",
      correlationId: "task-recipient",
    });
    expect(created.status).toBe(201);
    const { message } = await created.json<{ message: Message }>();
    expect(message).toMatchObject({ to: "  agent-🚀  ", correlationId: "task-recipient" });
    expect((await waiting).messages).toEqual([message]);
    // Addressing is display metadata only: every reader still receives the same page.
    expect((await page(t)).messages.at(-1)).toEqual(message);
    expect((await page(t)).messages.at(-1)).toEqual(message);
    const replay = await send(t, "assigned", "general", "recipient-key", "lead", {
      to: "  agent-🚀  ",
      correlationId: "task-recipient",
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ message, replayed: true });
  });

  it("keeps historical payload serialization stable and appends recipients only when addressed", () => {
    expect(payload("sender", "plain", "text/plain", {})).toBe('["sender","plain"]');
    expect(
      payload("sender", '{"ok":true}', "application/json", {
        replyTo: 42,
        correlationId: "task-7",
      }),
    ).toBe('["sender","{\\"ok\\":true}","application/json",42,"task-7"]');
    expect(payload("sender", "plain", "text/plain", { to: "reviewer" })).toBe(
      '["sender","plain","reviewer"]',
    );
    expect(
      payload("sender", '{"ok":true}', "application/json", {
        replyTo: 42,
        correlationId: "task-7",
        to: "reviewer",
      }),
    ).toBe('["sender","{\\"ok\\":true}","application/json",42,"task-7","reviewer"]');
  });

  it("validates recipient labels and includes them in the idempotency digest", async () => {
    const t = await tenant();
    expect((await call(`${t.path}/channels/general`, t.token, { method: "PUT" })).status).toBe(201);
    for (const to of ["", " ", "x".repeat(129), "🙂".repeat(33), 7, {}]) {
      const response = await send(t, "bad", "general", undefined, "sender", { to });
      expect(response.status, JSON.stringify(to)).toBe(400);
    }
    expect((await page(t)).messages).toEqual([]);
    expect((await send(t, "same", "general", "to-key", "sender", { to: "agent-a" })).status).toBe(201);
    expect((await send(t, "same", "general", "to-key", "sender", { to: "agent-a" })).status).toBe(200);
    expect((await send(t, "same", "general", "to-key", "sender", { to: "agent-b" })).status).toBe(409);
    expect((await send(t, "same", "general", "to-key", "sender")).status).toBe(409);
    expect((await send(t, "unicode", "general", undefined, "sender", { to: "🙂".repeat(32) })).status).toBe(
      201,
    );
  });

  it("carries replyTo and correlationId through send, poll, long-poll wakeups and idempotent replay", async () => {
    const t = await tenant();
    const request = await send(t, "ping", "general", "req-1", "requester", { correlationId: "task-7" });
    expect(request.status).toBe(201);
    const { message: ping } = await request.json<{ message: Message }>();
    expect(ping).toMatchObject({ correlationId: "task-7" });
    expect(ping.replyTo).toBeUndefined();
    const waiting = page(t, `?after=${ping.id}&wait=3`);
    await expect.poll(() => pending(t)).toBe(1);
    const reply = await send(t, "pong", "general", "res-1", "responder", {
      replyTo: ping.id,
      correlationId: "task-7",
    });
    expect(reply.status).toBe(201);
    const { message: pong } = await reply.json<{ message: Message }>();
    expect(pong).toMatchObject({ replyTo: ping.id, correlationId: "task-7", text: "pong" });
    // Every reader receives the same copy, correlation fields included; reads never consume.
    expect((await waiting).messages).toEqual([pong]);
    expect((await page(t)).messages).toEqual([ping, pong]);
    expect((await page(t)).messages).toEqual([ping, pong]);
    const replay = await send(t, "pong", "general", "res-1", "responder", {
      replyTo: ping.id,
      correlationId: "task-7",
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ message: pong, replayed: true });
    await abortAllDurableObjects();
    expect((await page(t)).messages).toEqual([ping, pong]);
  });

  it("rejects replyTo that names a missing, other-channel or malformed id without storing anything", async () => {
    const t = await tenant();
    const elsewhere = await (await send(t, "elsewhere", "other")).json<{ message: Message }>();
    await send(t, "root");
    for (const replyTo of [elsewhere.message.id, 999999, 0, -1, 1.5, "1", true]) {
      const response = await send(t, "orphan", "general", "orphan", "human / agent", { replyTo });
      expect(response.status, String(replyTo)).toBe(400);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe("invalid_reply_to");
    }
    expect((await send(t, "orphan", "general", "orphan", "human / agent", { replyTo: 1 })).status).toBe(400);
    expect((await page(t)).messages.map((m) => m.text)).toEqual(["root"]);
    // A rejected reply reserves nothing: the same key then stores a valid message.
    const root = (await page(t)).messages[0];
    expect((await send(t, "child", "general", "orphan", "human / agent", { replyTo: root.id })).status).toBe(
      201,
    );
    // A reply cannot be the first message of a channel; nothing exists there to answer.
    expect((await send(t, "first", "fresh", undefined, "human / agent", { replyTo: root.id })).status).toBe(
      400,
    );
    expect(await (await call(`${t.path}/channels`, t.token)).json()).toMatchObject({
      channels: [{ name: "general" }, { name: "other" }],
    });
    for (const correlationId of ["", " ", "x".repeat(129), 7, {}]) {
      const response = await send(t, "bad", "general", undefined, "human / agent", { correlationId });
      expect(response.status, JSON.stringify(correlationId)).toBe(400);
    }
    expect(
      (await send(t, "ok", "general", undefined, "human / agent", { correlationId: "🙂".repeat(32) })).status,
    ).toBe(201);
  });

  it("includes correlation fields in the idempotency digest and keeps pre-v2 keys replayable", async () => {
    const t = await tenant();
    const root = (await (await send(t, "root")).json<{ message: Message }>()).message;
    expect((await send(t, "same", "general", "key", "human / agent", { replyTo: root.id })).status).toBe(201);
    expect((await send(t, "same", "general", "key")).status).toBe(409);
    expect((await send(t, "same", "general", "key", "human / agent", { replyTo: root.id + 1 })).status).toBe(
      409,
    );
    expect(
      (await send(t, "same", "general", "key", "human / agent", { replyTo: root.id, correlationId: "c" }))
        .status,
    ).toBe(409);
    expect((await send(t, "same", "general", "key", "human / agent", { replyTo: root.id })).status).toBe(200);
    expect((await send(t, "same", "general", "cid", "human / agent", { correlationId: "c" })).status).toBe(
      201,
    );
    expect((await send(t, "same", "general", "cid", "human / agent", { correlationId: "d" })).status).toBe(
      409,
    );
    expect((await send(t, "same", "general", "cid")).status).toBe(409);
    // A row stored before schema v2 hashed only [username, text]; the same retry must still replay.
    const legacy = await runInDurableObject(t.stub, async (_, state) => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(["human / agent", "legacy"])),
      );
      const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
      state.storage.sql.exec(
        "INSERT INTO messages(channel, username, text, createdAt, key, digest, bytes) VALUES ('general', 'human / agent', 'legacy', '2026-01-01T00:00:00.000Z', 'legacy', ?, 6)",
        hex,
      );
      return state.storage.sql.exec<{ id: number }>("SELECT id FROM messages WHERE key = 'legacy'").one().id;
    });
    const replay = await send(t, "legacy", "general", "legacy");
    expect(replay.status).toBe(200);
    expect((await replay.json<{ message: Message }>()).message).toMatchObject({ id: legacy, text: "legacy" });
    expect(
      (await send(t, "legacy", "general", "legacy", "human / agent", { correlationId: "c" })).status,
    ).toBe(409);
  });

  it("migrates a version 1 schema to the current version on restart without touching existing rows", async () => {
    const t = await tenant();
    await send(t, "before", "general", "old");
    const before = (await page(t)).messages[0];
    // A real v1 database carries exactly the version-1 marker (see docs/design.md).
    await runInDurableObject(t.stub, (_, state) => rewind(state, 1));
    await abortAllDurableObjects();
    expect((await page(t)).messages).toEqual([before]);
    // A forced abort invalidates the old stub; a fresh one addresses the restarted object.
    const fresh = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", t.name]));
    const versions = await runInDurableObject(fresh, (_, state) =>
      state.storage.sql
        .exec<{ version: number }>("SELECT version FROM schema_version ORDER BY version")
        .toArray(),
    );
    expect(versions).toEqual(SCHEMA_HISTORY);
    const reply = await send(t, "after", "general", undefined, "human / agent", {
      replyTo: before.id,
      correlationId: "migrated",
    });
    expect(reply.status).toBe(201);
    expect((await page(t)).messages[1]).toMatchObject({ replyTo: before.id, correlationId: "migrated" });
    expect((await send(t, "before", "general", "old")).status).toBe(200);
  });

  it("validates identifiers, methods, pagination, JSON, body sizes and idempotency keys", async () => {
    const t = await tenant();
    await send(t);
    for (const query of [
      "after=-1",
      "after=1e2",
      "after=9007199254740992",
      "wait=26",
      "wait=0.5",
      "limit=0",
      "limit=101",
    ]) {
      expect((await call(`${t.path}/channels/general/messages?${query}`, t.token)).status, query).toBe(400);
    }
    expect((await call(`${t.path}/channels/UPPER/messages`, t.token)).status).toBe(400);
    expect((await call("/api/nope")).status).toBe(404);
    expect((await call(`${t.path}/channels/missing/messages`, t.token)).status).toBe(404);
    for (const content of ["", " ", "🙂".repeat(4097)]) expect((await send(t, content)).status).toBe(400);
    expect((await send(t, "ok", "general", undefined, "a".repeat(129))).status).toBe(400);
    expect((await send(t, "ok", "general", "bad key")).status).toBe(400);
    for (const data of ["{broken", "[]", "null", "42"])
      expect(
        (
          await call(`${t.path}/channels/general/messages`, t.token, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: data,
          })
        ).status,
      ).toBe(400);
    expect(
      (await call(`${t.path}/channels/general/messages`, t.token, { method: "POST", body: "{}" })).status,
    ).toBe(415);
    expect(
      (
        await call(`${t.path}/channels/general/messages`, t.token, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "x".repeat(33000) }),
        })
      ).status,
    ).toBe(413);
    expect((await send(t, "x".repeat(16384))).status).toBe(201);
  });

  it("binds a token to one display name: mismatches are 403, store nothing and wake nobody", async () => {
    const t = await tenant({ username: "thehuman" });
    expect(t.identity).toEqual({
      tenant: t.name,
      token: expect.stringMatching(/^[a-f0-9]{64}$/),
      username: "thehuman",
      usernamePrefix: null,
    });
    expect(await whoami(t)).toEqual({
      owner: true,
      tenant: t.name,
      username: "thehuman",
      usernamePrefix: null,
    });
    await call(`${t.path}/channels/general`, t.token, { method: "PUT" });
    const poll = page(t, "?wait=3");
    await expect.poll(() => pending(t)).toBe(1);
    const denied = await send(t, "spoof", "general", "shared-key", "someone-else");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: { code: "username_bound", message: expect.stringContaining('"thehuman"') },
    });
    for (const name of ["THEHUMAN", " thehuman", "thehuman ", "thehuman2"])
      expect((await send(t, "spoof", "general", undefined, name)).status, name).toBe(403);
    expect(await pending(t)).toBe(1);
    expect(await page(t)).toEqual({ messages: [], nextCursor: 0, hasMore: false });
    const usage = await runInDurableObject(t.stub, (_, state) =>
      state.storage.sql.exec("SELECT messages, bytes FROM usage").one(),
    );
    expect(usage).toEqual({ messages: 0, bytes: 0 });
    // The rejected send did not reserve its idempotency key either.
    const accepted = await send(t, "real", "general", "shared-key", "thehuman");
    expect(accepted.status).toBe(201);
    expect((await poll).messages.map((m) => [m.username, m.text])).toEqual([["thehuman", "real"]]);
    expect((await send(t, "real", "general", "shared-key", "thehuman")).status).toBe(200);
    expect((await page(t)).messages).toHaveLength(1);
  });

  it("binds a token to a display-name prefix", async () => {
    const t = await tenant({ usernamePrefix: "agent-" });
    expect(t.identity).toMatchObject({ username: null, usernamePrefix: "agent-" });
    expect(await whoami(t)).toEqual({
      owner: true,
      tenant: t.name,
      username: null,
      usernamePrefix: "agent-",
    });
    expect((await send(t, "seven", "general", undefined, "agent-7")).status).toBe(201);
    expect((await send(t, "bare", "general", undefined, "agent-")).status).toBe(201);
    for (const name of ["agent", "Agent-7", "human", " agent-7", "the agent-7"]) {
      const denied = await send(t, "spoof", "general", undefined, name);
      expect(denied.status, name).toBe(403);
      expect((await denied.json<{ error: { code: string } }>()).error.code).toBe("username_bound");
    }
    expect((await page(t)).messages.map((m) => m.username)).toEqual(["agent-7", "agent-"]);
  });

  it("rotation keeps the bind by default, clears it with null and replaces it with a name or prefix", async () => {
    const t = await tenant({ username: "thehuman" });
    const first = t.token;
    const kept = await rotate(t);
    expect(kept).toEqual({
      owner: true,
      tenant: t.name,
      token: expect.stringMatching(/^[a-f0-9]{64}$/),
      username: "thehuman",
      usernamePrefix: null,
    });
    expect(kept.token).not.toBe(first);
    expect((await call(t.path, first)).status).toBe(401);
    expect((await send(t, "x", "general", undefined, "other")).status).toBe(403);
    expect((await send(t, "x", "general", undefined, "thehuman")).status).toBe(201);
    expect(await rotate(t, { usernamePrefix: "agent-" })).toMatchObject({
      username: null,
      usernamePrefix: "agent-",
    });
    expect((await send(t, "x", "general", undefined, "thehuman")).status).toBe(403);
    expect((await send(t, "x", "general", undefined, "agent-1")).status).toBe(201);
    expect(await rotate(t, { username: null })).toMatchObject({ username: null, usernamePrefix: null });
    expect((await send(t, "x", "general", undefined, "anyone at all")).status).toBe(201);
    expect(await rotate(t, { usernamePrefix: null })).toMatchObject({ username: null, usernamePrefix: null });
    expect(await rotate(t, { username: "late binder" })).toMatchObject({
      username: "late binder",
      usernamePrefix: null,
    });
    expect((await send(t, "x", "general", undefined, "anyone at all")).status).toBe(403);
    expect((await send(t, "x", "general", undefined, "late binder")).status).toBe(201);
    expect(await whoami(t)).toEqual({
      owner: true,
      tenant: t.name,
      username: "late binder",
      usernamePrefix: null,
    });
    expect((await page(t)).messages.map((m) => m.username)).toEqual([
      "thehuman",
      "agent-1",
      "anyone at all",
      "late binder",
    ]);
  });

  it("unbound tenants keep the any-name behaviour, including rows migrated from an older schema", async () => {
    const t = await tenant();
    expect(t.identity).toEqual({
      tenant: t.name,
      token: expect.any(String),
      username: null,
      usernamePrefix: null,
    });
    expect(await whoami(t)).toEqual({ owner: true, tenant: t.name, username: null, usernamePrefix: null });
    expect((await send(t, "before", "general", undefined, "anyone")).status).toBe(201);
    // Rewind the row to its v1 shape, then force a restart so the constructor migration runs again.
    await runInDurableObject(t.stub, (_, state) => rewind(state, 3));
    await abortAllDurableObjects();
    expect(await whoami(t)).toEqual({ owner: true, tenant: t.name, username: null, usernamePrefix: null });
    expect((await send(t, "after", "general", undefined, "someone else")).status).toBe(201);
    expect((await page(t)).messages.map((m) => m.username)).toEqual(["anyone", "someone else"]);
    const restarted = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", t.name]));
    const versions = await runInDurableObject(restarted, (_, state) =>
      state.storage.sql
        .exec<{ version: number }>("SELECT version FROM schema_version ORDER BY version")
        .toArray(),
    );
    expect(versions).toEqual(SCHEMA_HISTORY);
    expect((await tenant({ username: null })).identity).toMatchObject({
      username: null,
      usernamePrefix: null,
    });
  });

  it("rejects malformed bindings on provision and rotation without side effects", async () => {
    const name = `t-${crypto.randomUUID()}`;
    const path = `/api/admin/tenants/${name}`;
    for (const bind of [
      { username: "a", usernamePrefix: "b" },
      { username: "" },
      { username: "   " },
      { username: "a".repeat(129) },
      { usernamePrefix: "" },
      { username: 5 },
      { usernamePrefix: ["agent-"] },
    ]) {
      const response = await call(path, ADMIN, { method: "PUT", ...jsonBody(bind) });
      expect(response.status, JSON.stringify(bind)).toBe(400);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe("invalid_binding");
    }
    expect(
      (
        await call(path, ADMIN, {
          method: "PUT",
          headers: { "Content-Type": "text/plain" },
          body: "username=x",
        })
      ).status,
    ).toBe(415);
    expect(
      (await call(path, ADMIN, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{" }))
        .status,
    ).toBe(400);
    expect((await call(`/api/tenants/${name}`, WRONG)).status).toBe(401);
    const created = await call(path, ADMIN, { method: "PUT", ...jsonBody({ username: "a".repeat(128) }) });
    expect(created.status).toBe(201);
    const t = await tenant({ username: "thehuman" });
    const bad = await call(`${t.admin}/token`, ADMIN, {
      method: "POST",
      ...jsonBody({ username: "a", usernamePrefix: "b" }),
    });
    expect(bad.status).toBe(400);
    expect((await send(t, "still me", "general", undefined, "thehuman")).status).toBe(201);
    expect(await whoami(t)).toMatchObject({ username: "thehuman" });
  });

  it("issues independently bound participant keys for the same channels and lists no secrets", async () => {
    const t = await tenant({ username: "Tomas" });
    const other = await tenant();
    const created = await call(`${t.admin}/keys/planner`, ADMIN, {
      method: "PUT",
      ...jsonBody({ username: "planner-agent" }),
    });
    expect(created.status).toBe(201);
    const key = await created.json<{ id: string; token: string; username: string; createdAt: string }>();
    expect(key).toMatchObject({ id: "planner", username: "planner-agent", usernamePrefix: null });
    expect(key.token).toMatch(/^[a-f0-9]{64}$/);
    const agent = { ...t, token: key.token };
    expect(await whoami(agent)).toEqual({ tenant: t.name, username: "planner-agent", usernamePrefix: null });
    expect((await send(t, "please review", "general", undefined, "Tomas")).status).toBe(201);
    expect((await send(agent, "ready", "general", undefined, "planner-agent")).status).toBe(201);
    expect((await send(agent, "spoof", "general", undefined, "Tomas")).status).toBe(403);
    expect((await page(t)).messages).toEqual((await page(agent)).messages);
    expect((await call(`${other.path}/channels`, key.token)).status).toBe(401);
    for (const token of [t.token, key.token]) {
      expect((await call(`${t.admin}/keys`, token)).status).toBe(403);
      expect(
        (await call(`${t.admin}/keys/evil`, token, { method: "PUT", ...jsonBody({ username: "evil" }) }))
          .status,
      ).toBe(403);
      expect((await call(`${t.admin}/keys/planner`, token, { method: "DELETE" })).status).toBe(403);
    }
    const list = await (await call(`${t.admin}/keys`, ADMIN)).json<{ keys: unknown[] }>();
    expect(list).toEqual({
      keys: [{ id: "planner", username: "planner-agent", usernamePrefix: null, createdAt: key.createdAt }],
    });
    const stored = await runInDurableObject(t.stub, (_, state) =>
      state.storage.sql.exec("SELECT * FROM access_keys").one(),
    );
    expect(stored.token_hash).not.toBe(key.token);
    expect(JSON.stringify(stored)).not.toContain(key.token);
    expect(
      (
        await call(`${t.admin}/keys/planner`, ADMIN, {
          method: "PUT",
          ...jsonBody({ username: "replacement" }),
        })
      ).status,
    ).toBe(409);
    expect((await send(agent, "still authorized", "general", undefined, "planner-agent")).status).toBe(201);
    await abortAllDurableObjects();
    expect(await whoami(agent)).toMatchObject({ username: "planner-agent" });
  });

  it("revokes only the selected participant and its pending polls; replacement cannot revive the old key", async () => {
    const t = await tenant();
    async function issue(id: string) {
      const response = await call(`${t.admin}/keys/${id}`, ADMIN, {
        method: "PUT",
        ...jsonBody({ username: id }),
      });
      expect(response.status).toBe(201);
      return { ...t, token: (await response.json<{ token: string }>()).token };
    }
    const a = await issue("alice");
    const b = await issue("bob");
    await call(`${t.path}/channels/general`, t.token, { method: "PUT" });
    const waitingA = call(`${t.path}/channels/general/messages?wait=25`, a.token);
    const waitingB = call(`${t.path}/channels/general/messages?wait=25`, b.token);
    await expect.poll(() => pending(t)).toBe(2);
    expect((await call(`${t.admin}/keys/alice`, ADMIN, { method: "DELETE" })).status).toBe(204);
    expect((await waitingA).status).toBe(401);
    expect(await pending(t)).toBe(1);
    expect((await send(b, "hello", "general", undefined, "bob")).status).toBe(201);
    expect((await waitingB).status).toBe(200);
    expect((await call(`${t.path}/channels`, t.token)).status).toBe(200);
    expect((await call(`${t.path}/channels`, a.token)).status).toBe(401);
    expect((await send(a, "late", "general", undefined, "alice")).status).toBe(401);
    expect((await call(`${t.admin}/keys/alice`, ADMIN, { method: "DELETE" })).status).toBe(404);
    const replacement = await issue("alice");
    expect(replacement.token).not.toBe(a.token);
    expect((await call(`${t.path}/channels`, a.token)).status).toBe(401);
    expect((await send(replacement, "back", "general", undefined, "alice")).status).toBe(201);
  });

  it("workspace rotation atomically revokes all participant keys and pending polls", async () => {
    const t = await tenant();
    const created = await call(`${t.admin}/keys/agents`, ADMIN, {
      method: "PUT",
      ...jsonBody({ usernamePrefix: "agent-" }),
    });
    expect(created.status).toBe(201);
    const agent = { ...t, token: (await created.json<{ token: string }>()).token };
    expect((await send(agent, "bad", "general", undefined, "other")).status).toBe(403);
    expect((await send(agent, "hello", "general", undefined, "agent-one")).status).toBe(201);
    const first = await page(agent);
    const waiting = call(
      `${t.path}/channels/general/messages?after=${first.nextCursor}&wait=25`,
      agent.token,
    );
    await expect.poll(() => pending(t)).toBe(1);
    await rotate(t);
    expect((await waiting).status).toBe(401);
    expect((await call(`${t.path}/channels`, agent.token)).status).toBe(401);
    expect(await (await call(`${t.admin}/keys`, ADMIN)).json()).toEqual({ keys: [] });
    expect((await page(t)).messages).toEqual(first.messages);
  });

  it("rejects participant sends revoked while their bodies are still streaming", async () => {
    const t = await tenant();
    const response = await call(`${t.admin}/keys/agent`, ADMIN, {
      method: "PUT",
      ...jsonBody({ username: "agent" }),
    });
    const { token } = await response.json<{ token: string }>();
    const ready = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const stream = new ReadableStream<Uint8Array>({ start: ready.resolve });
    const controller = await ready.promise;
    const sending = call(`${t.path}/channels/general/messages`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
    });
    controller.enqueue(new TextEncoder().encode('{"username":"agent",'));
    await delay(30);
    expect((await call(`${t.admin}/keys/agent`, ADMIN, { method: "DELETE" })).status).toBe(204);
    controller.enqueue(new TextEncoder().encode('"text":"late"}'));
    controller.close();
    expect((await sending).status).toBe(401);
    expect(await (await call(`${t.path}/channels`, t.token)).json()).toMatchObject({ channels: [] });
  });

  it("requires a valid participant binding and bounds the number of active keys", async () => {
    const t = await tenant();
    for (const input of [
      {},
      { username: null },
      { usernamePrefix: null },
      { username: "" },
      { username: "a", usernamePrefix: "a" },
    ]) {
      expect((await call(`${t.admin}/keys/new`, ADMIN, { method: "PUT", ...jsonBody(input) })).status).toBe(
        400,
      );
    }
    expect((await call(`${t.admin}/keys/new`, ADMIN, { method: "PUT" })).status).toBe(415);
    expect(
      (await call(`${t.admin}/keys/UPPER`, ADMIN, { method: "PUT", ...jsonBody({ username: "a" }) })).status,
    ).toBe(400);
    expect(await (await call(`${t.admin}/keys`, ADMIN)).json()).toEqual({ keys: [] });
    await runInDurableObject(t.stub, (_, state) => {
      state.storage.transactionSync(() => {
        for (let i = 0; i < 1000; i++)
          state.storage.sql.exec(
            "INSERT INTO access_keys (id, token_hash, bound_username, bound_prefix, createdAt) VALUES (?, ?, ?, NULL, ?)",
            `key-${i}`,
            `hash-${i}`,
            `agent-${i}`,
            "2026-09-16T00:00:00.000Z",
          );
      });
    });
    const denied = await call(`${t.admin}/keys/overflow`, ADMIN, {
      method: "PUT",
      ...jsonBody({ username: "a" }),
    });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: { code: "key_quota" } });
    await call(`${t.admin}/keys/key-0`, ADMIN, { method: "DELETE" });
    expect(
      (await call(`${t.admin}/keys/new`, ADMIN, { method: "PUT", ...jsonBody({ username: "a" }) })).status,
    ).toBe(201);
  });

  it("migrates v4 in place without changing the workspace key, binding or history", async () => {
    const t = await tenant({ username: "Tomas" });
    await send(t, "old history", "general", "retry", "Tomas");
    const before = await page(t);
    await runInDurableObject(t.stub, (_, state) => rewind(state, 4));
    await abortAllDurableObjects();
    expect(await whoami(t)).toEqual({ owner: true, tenant: t.name, username: "Tomas", usernamePrefix: null });
    expect(await page(t)).toEqual(before);
    expect((await send(t, "old history", "general", "retry", "Tomas")).status).toBe(200);
    expect(await (await call(`${t.admin}/keys`, ADMIN)).json()).toEqual({ keys: [] });
    expect(
      (await call(`${t.admin}/keys/agent`, ADMIN, { method: "PUT", ...jsonBody({ username: "agent" }) }))
        .status,
    ).toBe(201);
    await abortAllDurableObjects();
    expect(
      await runInDurableObject(
        env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", t.name])),
        (_, state) => state.storage.sql.exec("SELECT version FROM schema_version ORDER BY version").toArray(),
      ),
    ).toEqual(SCHEMA_HISTORY);
  });

  it("migrates v5 recipient storage without changing history or old idempotency digests", async () => {
    const t = await tenant();
    expect((await call(`${t.path}/channels/general`, t.token, { method: "PUT" })).status).toBe(201);
    const historicalSerialization = '["sender","old history","text/plain",null,"work"]';
    const digestBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(historicalSerialization),
    );
    const historicalDigest = Array.from(new Uint8Array(digestBytes), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    await runInDurableObject(t.stub, (_, state) => {
      rewind(state, 5);
      state.storage.sql.exec(
        "INSERT INTO messages(channel, username, text, contentType, createdAt, key, digest, bytes, correlationId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "general",
        "sender",
        "old history",
        "text/plain",
        "2026-01-01T00:00:00.000Z",
        "old-v5",
        historicalDigest,
        17,
        "work",
      );
      state.storage.sql.exec("UPDATE usage SET messages = 1, bytes = 17 WHERE singleton = 1");
    });
    await abortAllDurableObjects();
    expect((await page(t)).messages).toEqual([
      {
        id: expect.any(Number),
        tenant: t.name,
        channel: "general",
        username: "sender",
        text: "old history",
        contentType: "text/plain",
        createdAt: "2026-01-01T00:00:00.000Z",
        correlationId: "work",
      },
    ]);
    expect(
      (await send(t, "old history", "general", "old-v5", "sender", { correlationId: "work" })).status,
    ).toBe(200);
    const addressed = await send(t, "new history", "general", "new-v6", "sender", { to: "agent" });
    expect(addressed.status).toBe(201);
    expect((await addressed.json<{ message: Message }>()).message.to).toBe("agent");
    const fresh = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", t.name]));
    expect(
      await runInDurableObject(fresh, (_, state) =>
        state.storage.sql.exec("SELECT version FROM schema_version ORDER BY version").toArray(),
      ),
    ).toEqual(SCHEMA_HISTORY);
  });
});
