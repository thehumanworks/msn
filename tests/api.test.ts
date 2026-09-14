import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Message } from "../src/store";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}
const ADMIN = "test-admin-secret-000000000000000000000";
const WRONG = "wrong-token-00000000000000000000000000";
type Page = { messages: Message[]; nextCursor: number; hasMore: boolean };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (path: string, token?: string, init: RequestInit = {}) =>
  exports.default.fetch(`https://msn.test${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
async function tenant() {
  const name = `t-${crypto.randomUUID()}`;
  const response = await call(`/api/admin/tenants/${name}`, ADMIN, { method: "PUT" });
  expect(response.status).toBe(201);
  const { token } = await response.json<{ token: string }>();
  return {
    name,
    token,
    path: `/api/tenants/${name}`,
    admin: `/api/admin/tenants/${name}`,
    stub: env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", name])),
  };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;
async function send(
  t: Tenant,
  content = "hello",
  channel = "general",
  key?: string,
  username = "human / agent",
  contentType?: string,
) {
  return call(`${t.path}/channels/${channel}/messages`, t.token, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify({ username, text: content, ...(contentType === undefined ? {} : { contentType }) }),
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

  it("migrates a version-1 schema in place so older rows read back as text/plain", async () => {
    const t = await tenant();
    await call(`${t.path}/channels/general`, t.token, { method: "PUT" });
    await runInDurableObject(t.stub, (_, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("ALTER TABLE messages DROP COLUMN contentType");
        state.storage.sql.exec("DELETE FROM schema_version WHERE version = 2");
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
    expect(versions).toEqual([{ version: 1 }, { version: 2 }]);
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
          state.storage.sql.exec("INSERT INTO channels VALUES (?, ?)", `c-${i}`, new Date().toISOString());
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
});
