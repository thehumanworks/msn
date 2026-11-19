import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ADMIN = "test-admin-secret-000000000000000000000";

type EventType = "channel.created" | "message.created" | "message.deleted" | "snapshot.published";
type CoordinationEvent = {
  id: number;
  tenant: string;
  channel: string;
  type: EventType;
  resourceId: number | null;
  historyRevision: number;
  createdAt: string;
};
type EventsPage = { events: CoordinationEvent[]; nextCursor: number; hasMore: boolean };
type Identity = { tenant: string; token?: string; keyId?: string; channel?: string };

const call = (path: string, token?: string, init: RequestInit = {}) =>
  exports.default.fetch(`https://msn.test${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
const jsonBody = (data: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

async function tenant() {
  const name = `evt-${crypto.randomUUID()}`;
  const response = await call(`/api/admin/tenants/${name}`, ADMIN, { method: "PUT" });
  expect(response.status).toBe(201);
  const identity = await response.json<Identity>();
  return {
    name,
    token: identity.token as string,
    path: `/api/tenants/${name}`,
    admin: `/api/admin/tenants/${name}`,
    stub: env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", name])),
  };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

async function send(t: Tenant, channel = "general", text = "hi", key?: string, username = "agent") {
  return call(`${t.path}/channels/${channel}/messages`, t.token, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify({ username, text }),
  });
}

async function events(path: string, token: string, query = ""): Promise<EventsPage> {
  const response = await call(`${path}/events${query}`, token);
  expect(response.status).toBe(200);
  return response.json<EventsPage>();
}

async function pendingEvents(t: Tenant): Promise<number> {
  return runInDurableObject(
    t.stub,
    (instance) => (instance as unknown as { eventWaiters: Set<unknown> }).eventWaiters.size,
  );
}

async function scopedKey(t: Tenant, channel: string, username = "member") {
  const invite = await call(`${t.path}/invites`, t.token, { method: "POST", ...jsonBody({ channel }) });
  expect(invite.status).toBe(201);
  const { code } = await invite.json<{ code: string }>();
  const redeemed = await call(`${t.path}/invites/redeem`, undefined, {
    method: "POST",
    ...jsonBody({ code, username }),
  });
  expect(redeemed.status).toBe(201);
  return redeemed.json<Identity>();
}

describe("durable coordination event feed", () => {
  it("requires a bearer token and rejects an unknown tenant", async () => {
    expect((await call("/api/tenants/missing/events")).status).toBe(401);
  });

  it("emits channel.created then message.created atomically, in an id space independent of message ids", async () => {
    const t = await tenant();
    const created = await call(`${t.path}/channels/general`, t.token, { method: "PUT" });
    expect(created.status).toBe(201);
    const sent = await send(t);
    expect(sent.status).toBe(201);
    const { message } = await sent.json<{ message: { id: number } }>();
    const page = await events(t.path, t.token);
    expect(page.events.map((e) => e.type)).toEqual(["channel.created", "message.created"]);
    expect(page.events[0]).toMatchObject({ tenant: t.name, channel: "general", resourceId: null });
    expect(page.events[1]).toMatchObject({ channel: "general", resourceId: message.id });
    // The event id counter and the message id counter are distinct sequences.
    expect(page.events[1].id).not.toBe(message.id);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBe(page.events[1].id);
  });

  it("after is a strict event-id cursor, never the resourceId/message-id space", async () => {
    const t = await tenant();
    await call(`${t.path}/channels/general`, t.token, { method: "PUT" }); // event id 1
    await send(t, "general", "first"); // message id 1, event id 2
    const second = await send(t, "general", "second"); // message id 2, event id 3
    const { message } = await second.json<{ message: { id: number } }>();
    expect(message.id).toBe(2);
    // 2 happens to equal the second message's id; a cursor mix-up would misread this as its own event.
    const page = await events(t.path, t.token, "?after=2");
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ id: 3, resourceId: 2, type: "message.created" });
  });

  it("idempotent replay emits no duplicate events", async () => {
    const t = await tenant();
    const first = await send(t, "general", "hello", "retry-key");
    expect(first.status).toBe(201);
    const replay = await send(t, "general", "hello", "retry-key");
    expect(replay.status).toBe(200);
    const page = await events(t.path, t.token);
    expect(page.events.filter((e) => e.type === "message.created")).toHaveLength(1);
  });

  it("snapshot.published carries the snapshot version as resourceId", async () => {
    const t = await tenant();
    await call(`${t.path}/channels/general`, t.token, { method: "PUT" });
    const publish = await call(`${t.path}/channels/general/snapshots`, t.token, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "snap-1" },
      body: JSON.stringify({
        username: "agent",
        text: "# notes",
        coversThrough: 0,
        baseVersion: 0,
        historyRevision: 0,
      }),
    });
    expect(publish.status).toBe(201);
    const page = await events(t.path, t.token);
    const published = page.events.find((e) => e.type === "snapshot.published");
    expect(published).toMatchObject({ channel: "general", resourceId: 1 });
    // A replay of the same publish must not emit a second snapshot.published event.
    const replay = await call(`${t.path}/channels/general/snapshots`, t.token, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "snap-1" },
      body: JSON.stringify({
        username: "agent",
        text: "# notes",
        coversThrough: 0,
        baseVersion: 0,
        historyRevision: 0,
      }),
    });
    expect(replay.status).toBe(200);
    const after = await events(t.path, t.token);
    expect(after.events.filter((e) => e.type === "snapshot.published")).toHaveLength(1);
  });

  it("message.deleted carries no message text or username, and reflects the bumped history revision", async () => {
    const t = await tenant();
    const sent = await send(t, "general", "secret payload", undefined, "human");
    const { message } = await sent.json<{ message: { id: number } }>();
    const del = await call(`${t.admin}/channels/general/messages/${message.id}`, ADMIN, { method: "DELETE" });
    expect(del.status).toBe(204);
    const page = await events(t.path, t.token);
    const deleted = page.events.find((e) => e.type === "message.deleted");
    expect(deleted).toMatchObject({ resourceId: message.id, historyRevision: 1 });
    const raw = JSON.stringify(deleted);
    expect(raw).not.toContain("secret payload");
    expect(raw).not.toContain("human");
    expect(Object.keys(deleted as object).sort()).toEqual(
      ["channel", "createdAt", "historyRevision", "id", "resourceId", "tenant", "type"].sort(),
    );
  });

  it("isolates filtered long polls per channel and wakes immediately rather than on a timer", async () => {
    const t = await tenant();
    await call(`${t.path}/channels/a`, t.token, { method: "PUT" });
    await call(`${t.path}/channels/b`, t.token, { method: "PUT" });
    const baseline = await events(t.path, t.token);
    const pollA = events(t.path, t.token, `?channel=a&after=${baseline.nextCursor}&wait=5`);
    await expect.poll(() => pendingEvents(t)).toBe(1);
    await send(t, "b", "irrelevant to a");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await pendingEvents(t)).toBe(1); // channel b activity must not wake the channel-a-only poll
    const start = Date.now();
    await send(t, "a", "relevant");
    const page = await pollA;
    expect(Date.now() - start).toBeLessThan(1000); // event-driven wake, not the 5s timeout
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ channel: "a", type: "message.created" });
    expect(await pendingEvents(t)).toBe(0);
  });

  it("a scoped key always sees only its granted channel; conflicting filters are forbidden", async () => {
    const t = await tenant();
    await call(`${t.path}/channels/general`, t.token, { method: "PUT" });
    await call(`${t.path}/channels/other`, t.token, { method: "PUT" });
    const member = await scopedKey(t, "general");
    await send(t, "general", "hi-general");
    await send(t, "other", "hi-other");
    const unfiltered = await events(t.path, member.token as string);
    expect(unfiltered.events.length).toBeGreaterThan(0);
    expect(unfiltered.events.every((e) => e.channel === "general")).toBe(true);
    const matching = await events(t.path, member.token as string, "?channel=general");
    expect(matching).toEqual(unfiltered);
    const conflicting = await call(`${t.path}/events?channel=other`, member.token);
    expect(conflicting.status).toBe(403);
  });

  it("token rotation aborts a pending event poll instead of leaving it hanging", async () => {
    const t = await tenant();
    await call(`${t.path}/channels/general`, t.token, { method: "PUT" });
    const baseline = await events(t.path, t.token);
    const pending = call(`${t.path}/events?wait=10&after=${baseline.nextCursor}`, t.token);
    await expect.poll(() => pendingEvents(t)).toBe(1);
    const start = Date.now();
    expect((await call(`${t.admin}/token`, ADMIN, { method: "POST" })).status).toBe(200);
    const response = await pending;
    expect(response.status).toBe(401);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("participant key revocation aborts only that key's pending event poll", async () => {
    const t = await tenant();
    await call(`${t.path}/channels/general`, t.token, { method: "PUT" });
    const member = await scopedKey(t, "general");
    const baseline = await events(t.path, t.token);
    const ownerPoll = call(`${t.path}/events?wait=10&after=${baseline.nextCursor}`, t.token);
    const memberPoll = call(`${t.path}/events?wait=10&after=${baseline.nextCursor}`, member.token);
    await expect.poll(() => pendingEvents(t)).toBe(2);
    const revoked = await call(`${t.admin}/keys/${member.keyId}`, ADMIN, { method: "DELETE" });
    expect(revoked.status).toBe(204);
    expect((await memberPoll).status).toBe(401);
    expect(await pendingEvents(t)).toBe(1);
    await send(t, "general", "wake owner");
    expect((await ownerPoll).status).toBe(200);
  });

  it("validates query bounds and treats an unknown channel filter as legitimately empty, not an error", async () => {
    const t = await tenant();
    expect((await call(`${t.path}/events?limit=0`, t.token)).status).toBe(400);
    expect((await call(`${t.path}/events?limit=101`, t.token)).status).toBe(400);
    expect((await call(`${t.path}/events?wait=26`, t.token)).status).toBe(400);
    expect((await call(`${t.path}/events?after=-1`, t.token)).status).toBe(400);
    const missing = await events(t.path, t.token, "?channel=never-created");
    expect(missing).toEqual({ events: [], nextCursor: 0, hasMore: false });
  });

  it("journal persists across a Durable Object restart", async () => {
    const t = await tenant();
    await call(`${t.path}/channels/general`, t.token, { method: "PUT" });
    await send(t, "general", "hi");
    const before = await events(t.path, t.token);
    await abortAllDurableObjects();
    const after = await events(t.path, t.token); // exports.default.fetch re-resolves the stub
    expect(after).toEqual(before);
  });

  it("migrates a v8 database in place: prior history survives, but the journal starts empty at the migration point", async () => {
    const t = await tenant();
    await call(`${t.path}/channels/general`, t.token, { method: "PUT" });
    await send(t, "general", "before migration");
    await runInDurableObject(t.stub, (_, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("DROP TABLE events");
        state.storage.sql.exec("DELETE FROM schema_version WHERE version >= 9");
      });
    });
    await abortAllDurableObjects();
    const restarted = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", t.name]));
    const versions = await runInDurableObject(restarted, (_, state) =>
      state.storage.sql
        .exec<{ version: number }>("SELECT version FROM schema_version ORDER BY version")
        .toArray(),
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const messages = await call(`${t.path}/channels/general/messages`, t.token);
    expect((await messages.json<{ messages: { text: string }[] }>()).messages.map((m) => m.text)).toEqual([
      "before migration",
    ]);
    // No backfill: the pre-migration channel and message never appear in the journal.
    const empty = await events(t.path, t.token);
    expect(empty.events).toEqual([]);
    await send(t, "general", "after migration");
    const populated = await events(t.path, t.token);
    expect(populated.events.map((e) => e.type)).toEqual(["message.created"]);
  });

  it("fails closed without silently pruning when the event journal reaches capacity", async () => {
    const t = await tenant();
    await call(`${t.path}/channels/general`, t.token, { method: "PUT" });
    // Mirrors store.ts's MAX_EVENTS = MAX_MESSAGES * 2 + MAX_CHANNELS + MAX_SNAPSHOTS.
    const MAX_EVENTS = 100000 * 2 + 1000 + 1000;
    await runInDurableObject(t.stub, (_, state) => {
      state.storage.transactionSync(() => {
        const existing = state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM events")
          .one().count;
        const fill = MAX_EVENTS - existing - 1; // leave exactly one slot of headroom
        state.storage.sql.exec(
          `INSERT INTO events (channel, type, resourceId, historyRevision, createdAt)
           SELECT 'general', 'message.created', NULL, 0, datetime('now')
           FROM (WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x < ${fill}) SELECT x FROM seq)`,
        );
      });
    });
    expect((await send(t, "general", "last one")).status).toBe(201);
    const rejected = await send(t, "general", "over capacity");
    expect(rejected.status).toBe(409);
    expect((await rejected.json<{ error: { code: string } }>()).error.code).toBe("event_quota");
    // Fail-closed: the rejected mutation is rolled back too, not just its missing event.
    const msgs = await call(`${t.path}/channels/general/messages`, t.token);
    expect((await msgs.json<{ messages: { text: string }[] }>()).messages.map((m) => m.text)).toEqual([
      "last one",
    ]);
  });
});
