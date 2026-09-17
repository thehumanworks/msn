import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type Snapshot = {
  version: number;
  coversThrough: number;
  username: string;
  text: string;
  invalidated: boolean;
};
type Envelope = {
  snapshot: Snapshot;
  snapshots: Snapshot[];
  messages: { id: number }[];
  nextCursor: number;
  incomplete: boolean;
  snapshotDue: boolean;
  snapshotDueReasons: string[];
};
const ADMIN = "test-admin-secret-000000000000000000000";
const call = (path: string, token: string, method = "GET", data?: unknown, key?: string) =>
  exports.default.fetch(`https://msn.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key === undefined ? {} : { "Idempotency-Key": key }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
async function workspace() {
  const name = `snap-${crypto.randomUUID()}`;
  const admin = `/api/admin/tenants/${name}`;
  const response = await call(admin, ADMIN, "PUT");
  const { token } = await response.json<{ token: string }>();
  const root = `/api/tenants/${name}`;
  const path = `${root}/channels/general`;
  await call(path, token, "PUT");
  return {
    name,
    token,
    admin,
    root,
    path,
    stub: env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", name])),
  };
}
type Workspace = Awaited<ReturnType<typeof workspace>>;
const publish = (w: Workspace, overrides = {}, key = crypto.randomUUID()) =>
  call(
    `${w.path}/snapshots`,
    w.token,
    "POST",
    {
      username: "agent",
      text: "# Objective\nKeep useful context",
      coversThrough: 0,
      baseVersion: 0,
      historyRevision: 0,
      ...overrides,
    },
    key,
  );
async function send(w: Workspace, text = "event", channel = "general", key?: string) {
  const response = await call(
    `${w.root}/channels/${channel}/messages`,
    w.token,
    "POST",
    { username: "agent", text },
    key,
  );
  expect(response.status).toBe(201);
  return (await response.json<{ message: { id: number } }>()).message.id;
}
async function get(w: Workspace, suffix = "/catchup") {
  const response = await call(w.path + suffix, w.token);
  expect(response.status).toBe(200);
  return response.json<Envelope>();
}
const remove = (w: Workspace, id: number) =>
  call(`${w.admin}/channels/general/messages/${id}`, ADMIN, "DELETE");

describe("authored channel snapshots and bounded re-entry", () => {
  it("recovers from a precise watermark, preserves appended tail and survives restart", async () => {
    const w = await workspace();
    const covered = await send(w, "decision");
    const tail = await send(w, "concurrent append");
    const response = await publish(w, { coversThrough: covered });
    expect(response.status).toBe(201);
    await abortAllDurableObjects();
    const state = await get(w);
    expect(state.snapshot).toMatchObject({
      version: 1,
      coversThrough: covered,
      username: "agent",
      invalidated: false,
    });
    expect(state.messages.map((m) => m.id)).toEqual([tail]);
    expect(state.nextCursor).toBe(tail);
    expect(state.incomplete).toBe(false);
    expect(state.snapshotDue).toBe(false);
    expect((await get(w, "/snapshots")).snapshots[0]).not.toHaveProperty("text");
  });

  it("serializes competing publishes and replays original keys before stale CAS checks", async () => {
    const w = await workspace();
    const results = await Promise.all([
      publish(w, { text: "one" }, "one"),
      publish(w, { text: "two" }, "two"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const first = await get(w, "/snapshots/1");
    expect((await publish(w, { baseVersion: 1, text: "newer" })).status).toBe(201);
    const replay = await publish(w, { text: first.snapshot.text }, first.snapshot.text);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, snapshot: { version: 1 } });
    expect((await publish(w, { text: "changed" }, first.snapshot.text)).status).toBe(409);
  });

  it("continues exactly from delivered cursor despite checkpoint churn", async () => {
    const w = await workspace();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await send(w, `event ${i}`));
    const first = await get(w, "/catchup?limit=2");
    expect(first.messages.map((m) => m.id)).toEqual(ids.slice(0, 2));
    expect(first).toMatchObject({ incomplete: true, hasMore: true, snapshot: null, snapshotDue: true });
    await publish(w, { coversThrough: ids[4] });
    const next = await get(w, `/catchup?after=${first.nextCursor}&limit=2`);
    expect(next.snapshot).toBeNull();
    expect(next.messages.map((m) => m.id)).toEqual(ids.slice(2, 4));
    expect((await get(w)).snapshot.coversThrough).toBe(ids[4]);
    expect((await get(w, `/catchup?after=${ids[4]}`)).messages).toEqual([]);
    expect((await call(`${w.path}/catchup?after=99999`, w.token)).status).toBe(400);
  });

  it("scrubs every snapshot and blocks stale redaction races while permitting tombstone repair", async () => {
    const w = await workspace();
    const id = await send(w, "sensitive");
    await publish(w, { text: "sensitive summary", coversThrough: id }, "old");
    await publish(w, { text: "derived sensitive summary", coversThrough: id, baseVersion: 1 });
    expect((await remove(w, id)).status).toBe(204);
    expect((await remove(w, id)).status).toBe(404);
    const state = await get(w);
    expect(state).toMatchObject({ snapshot: null, snapshotVersion: 2, historyRevision: 1, hasMore: false });
    expect(
      (await get(w, "/snapshots")).snapshots.every(
        (s) => s.invalidated && s.username === "" && !("text" in s),
      ),
    ).toBe(true);
    expect((await call(`${w.path}/snapshots/1`, w.token)).status).toBe(410);
    expect((await publish(w, { text: "sensitive summary", coversThrough: id }, "old")).status).toBe(410);
    expect((await publish(w, { coversThrough: id, baseVersion: 2 })).status).toBe(409);
    expect(
      (
        await publish(w, {
          coversThrough: id,
          baseVersion: 2,
          historyRevision: 1,
          text: "All prior content redacted",
        })
      ).status,
    ).toBe(201);
    expect((await get(w)).snapshot.version).toBe(3);
  });

  it("increments redaction revision before any snapshot exists and isolates channels", async () => {
    const w = await workspace();
    const id = await send(w);
    await send(w, "other", "other");
    await remove(w, id);
    expect((await publish(w)).status).toBe(409);
    const other = await call(`${w.root}/channels/other/catchup`, w.token);
    expect(await other.json()).toMatchObject({ historyRevision: 0 });
    expect((await publish(w, { coversThrough: id, historyRevision: 1 })).status).toBe(201);
  });

  it("enforces identity, tenant isolation, exact channel coverage and required preconditions", async () => {
    const w = await workspace();
    const id = await send(w);
    const otherId = await send(w, "other", "other");
    expect((await publish(w, { coversThrough: otherId })).status).toBe(400);
    expect((await publish(w, { coversThrough: otherId + 100 })).status).toBe(400);
    expect((await publish(w, { coversThrough: id })).status).toBe(201);
    expect((await publish(w, { coversThrough: 0, baseVersion: 1 })).status).toBe(400);
    for (const overrides of [
      { coversThrough: "1" },
      { baseVersion: -1 },
      { historyRevision: 1.5 },
      { coversThrough: 2 ** 53 },
    ])
      expect((await publish(w, overrides)).status).toBe(400);
    const noKey = await call(`${w.path}/snapshots`, w.token, "POST", {
      username: "agent",
      text: "x",
      coversThrough: id,
      baseVersion: 1,
      historyRevision: 0,
    });
    expect(noKey.status).toBe(400);
    const key = await call(`${w.admin}/keys/alice`, ADMIN, "PUT", { username: "alice" });
    const alice = (await key.json<{ token: string }>()).token;
    expect((await publish({ ...w, token: alice }, { baseVersion: 1, coversThrough: id })).status).toBe(403);
    const alien = await workspace();
    for (const suffix of ["/snapshots", "/snapshots/1", "/catchup"])
      expect((await call(w.path + suffix, alien.token)).status).toBe(401);
    // Message and snapshot retry namespaces are independent.
    await send(w, "key namespace", "general", "same");
    expect((await publish(w, { baseVersion: 1, coversThrough: id }, "same")).status).toBe(201);
  });

  it("bounds serialized UTF-8 including escaping and gives actionable no-progress errors", async () => {
    const w = await workspace();
    await publish(w, { text: '\\"😀'.repeat(500) });
    for (let i = 0; i < 5; i++) await send(w, '\\"😀'.repeat(500));
    const response = await call(`${w.path}/catchup?maxBytes=12000`, w.token);
    expect(response.status).toBe(200);
    const serialized = await response.text();
    expect(new TextEncoder().encode(serialized).length).toBeLessThanOrEqual(12000);
    expect(JSON.parse(serialized)).toMatchObject({ hasMore: true, incomplete: true, byteLimitReached: true });
    const tiny = await call(`${w.path}/catchup?maxBytes=1024`, w.token);
    expect(tiny.status).toBe(413);
    const error = (await tiny.json<{ error: { code: string; requiredBytes: number } }>()).error;
    expect(error.code).toBe("catchup_budget_too_small");
    expect(error.requiredBytes).toBeGreaterThan(1024);
    expect((await call(`${w.path}/catchup?maxBytes=${error.requiredBytes}`, w.token)).status).toBe(200);
  });

  it("returns a sufficient exact retry budget for a snapshot-only response", async () => {
    const w = await workspace();
    await publish(w, { text: "x".repeat(4096) });
    const tiny = await call(`${w.path}/catchup?maxBytes=1024`, w.token);
    expect(tiny.status).toBe(413);
    const { error } = await tiny.json<{ error: { requiredBytes: number } }>();
    const retry = await call(`${w.path}/catchup?maxBytes=${error.requiredBytes}`, w.token);
    expect(retry.status).toBe(200);
    expect(new TextEncoder().encode(await retry.text()).length).toBeLessThanOrEqual(error.requiredBytes);
  });

  it("reauthorizes snapshot authors after a slow body and cannot race revocation", async () => {
    const w = await workspace();
    const key = await call(`${w.admin}/keys/agent`, ADMIN, "PUT", { username: "agent" });
    const { token } = await key.json<{ token: string }>();
    const ready = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const stream = new ReadableStream<Uint8Array>({ start: ready.resolve });
    const controller = await ready.promise;
    const sending = exports.default.fetch(`https://msn.test${w.path}/snapshots`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "slow",
      },
      body: stream,
    });
    controller.enqueue(new TextEncoder().encode('{"username":"agent",'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await call(`${w.admin}/keys/agent`, ADMIN, "DELETE")).status).toBe(204);
    controller.enqueue(
      new TextEncoder().encode('"text":"late","coversThrough":0,"baseVersion":0,"historyRevision":0}'),
    );
    controller.close();
    expect((await sending).status).toBe(401);
    expect((await get(w, "/snapshots")).snapshots).toEqual([]);
  });

  it("exposes measured reminder thresholds independently of continuation position", async () => {
    const w = await workspace();
    await publish(w);
    let last = 0;
    for (let i = 0; i < 20; i++) last = await send(w);
    const state = await get(w, `/catchup?after=${last}`);
    expect(state).toMatchObject({
      pendingMessages: 0,
      snapshotPendingMessages: 20,
      snapshotDue: true,
      snapshotPolicy: { messageThreshold: 20, byteThreshold: 16384, maxAgeSeconds: 86400 },
    });
    expect(state.snapshotDueReasons).toContain("message_threshold");
    await publish(w, { coversThrough: last, baseVersion: 1 });
    await send(w, "x".repeat(16384));
    expect((await get(w)).snapshotDueReasons).toContain("byte_threshold");
    await runInDurableObject(w.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE snapshots SET createdAt = ?", "2000-01-01T00:00:00.000Z");
    });
    expect((await get(w)).snapshotDueReasons).toContain("age_threshold");
  });

  it("counts lifetime snapshot versions and accounts redaction bytes only once", async () => {
    const w = await workspace();
    const id = await send(w, "private");
    await publish(w, { coversThrough: id });
    await remove(w, id);
    await runInDurableObject(w.stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ bytes: number }>("SELECT bytes FROM usage").one().bytes).toBe(0);
      state.storage.sql.exec(
        `INSERT INTO snapshots(channel,version,username,text,coversThrough,historyRevision,createdAt,key,digest,bytes)
        SELECT 'other', value, '', '', 0, 0, '', 'key-' || value, '', 0 FROM json_each(?)`,
        JSON.stringify(Array.from({ length: 999 }, (_, i) => i + 1)),
      );
    });
    expect((await publish(w, { baseVersion: 1, historyRevision: 1, coversThrough: id })).status).toBe(409);
  });
});
