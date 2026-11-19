import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ADMIN = "test-admin-secret-000000000000000000000";

type Message = { id: number; text: string; labels?: Record<string, string> };
type Page = { messages: Message[]; nextCursor: number; hasMore: boolean };
type Event = { id: number; type: string; resourceId: number | null };

const call = (path: string, token?: string, init: RequestInit = {}) =>
  exports.default.fetch(`https://msn.test${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
const post = (data: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(data),
});

async function tenant() {
  const name = `lbl-${crypto.randomUUID()}`;
  const response = await call(`/api/admin/tenants/${name}`, ADMIN, { method: "PUT" });
  expect(response.status).toBe(201);
  const { token } = await response.json<{ token: string }>();
  return {
    name,
    token,
    path: `/api/tenants/${name}`,
    channel: `/api/tenants/${name}/channels/general`,
    stub: env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", name])),
  };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

async function send(t: Tenant, text: string, labels?: unknown, key?: string) {
  return call(
    `${t.channel}/messages`,
    t.token,
    post(
      { username: "agent", text, ...(labels === undefined ? {} : { labels }) },
      key ? { "Idempotency-Key": key } : {},
    ),
  );
}
async function sent(t: Tenant, text: string, labels?: Record<string, string>): Promise<Message> {
  const response = await send(t, text, labels);
  expect(response.status).toBe(201);
  return (await response.json<{ message: Message }>()).message;
}
const relabel = (t: Tenant, id: number, change: unknown) =>
  call(`${t.channel}/messages/${id}/labels`, t.token, post(change));
async function list(t: Tenant, query: string): Promise<Page> {
  const response = await call(`${t.channel}/messages${query}`, t.token);
  expect(response.status).toBe(200);
  return response.json<Page>();
}

describe("message labels (ADR 0032)", () => {
  it("stores labels on send, shows them on read, and omits the field when there are none", async () => {
    const t = await tenant();
    const labeled = await sent(t, "bug in cli", { state: "open", area: "cli" });
    expect(labeled.labels).toEqual({ area: "cli", state: "open" });
    const plain = await sent(t, "hello");
    expect("labels" in plain).toBe(false);
    const page = await list(t, "");
    expect(page.messages.map((m) => m.labels ?? null)).toEqual([{ area: "cli", state: "open" }, null]);
    const shown = await call(`${t.channel}/messages/${labeled.id}`, t.token);
    expect((await shown.json<{ message: Message }>()).message.labels).toEqual({ area: "cli", state: "open" });
  });

  it("validates keys, values and the per-message limit", async () => {
    const t = await tenant();
    for (const labels of [
      { State: "open" },
      { "-x": "y" },
      { state: "" },
      { state: "a\nb" },
      { state: 3 },
      { state: "x".repeat(257) },
      ["state=open"],
    ]) {
      const response = await send(t, "x", labels);
      expect(response.status).toBe(400);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe("invalid_label");
    }
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]));
    const tooMany = await send(t, "x", many);
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json<{ error: { code: string } }>()).error.code).toBe("label_limit");
    expect((await send(t, "x", { "a.b_c-1": "x".repeat(256) })).status).toBe(201);
  });

  it("keeps unlabeled idempotent sends replaying and rejects a key reused with different labels", async () => {
    const t = await tenant();
    expect((await send(t, "same", undefined, "k1")).status).toBe(201);
    expect((await send(t, "same", undefined, "k1")).status).toBe(200);
    expect((await send(t, "same", { state: "open" }, "k1")).status).toBe(409);
    expect((await send(t, "x", { state: "open" }, "k2")).status).toBe(201);
    expect((await send(t, "x", { state: "open" }, "k2")).status).toBe(200);
    expect((await send(t, "x", { state: "done" }, "k2")).status).toBe(409);
  });

  it("sets, replaces and removes labels, and records one opt-in event per real change", async () => {
    const t = await tenant();
    const message = await sent(t, "task", { state: "open", owner: "ana" });
    const changed = await relabel(t, message.id, { set: { state: "done", pr: "27" }, unset: ["owner"] });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      changed: true,
      message: { id: message.id, labels: { pr: "27", state: "done" } },
    });
    const again = await relabel(t, message.id, { set: { state: "done" }, unset: ["owner"] });
    expect(await again.json()).toMatchObject({ changed: false });

    const withLabels = await call(`${t.path}/events?include=labels`, t.token);
    const labeled = (await withLabels.json<{ events: Event[] }>()).events.filter(
      (e) => e.type === "message.labeled",
    );
    expect(labeled).toHaveLength(1);
    expect(labeled[0].resourceId).toBe(message.id);
    // Clients built before labels reject unknown event types, so they never see one by default.
    const plain = await call(`${t.path}/events`, t.token);
    expect((await plain.json<{ events: Event[] }>()).events.map((e) => e.type)).toEqual([
      "channel.created",
      "message.created",
    ]);
    expect((await call(`${t.path}/events?include=other`, t.token)).status).toBe(400);
  });

  it("applies the if condition as compare-and-set and changes nothing on conflict", async () => {
    const t = await tenant();
    const message = await sent(t, "who takes this?", { state: "open" });
    const claim = (owner: string) =>
      relabel(t, message.id, { set: { owner }, if: { owner: null, state: "open" } });
    const first = await claim("ana");
    expect(first.status).toBe(200);
    const second = await claim("bo");
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: { code: "label_conflict", message: "The if condition did not match; nothing changed." },
      labels: { owner: "ana", state: "open" },
    });
    const shown = await call(`${t.channel}/messages/${message.id}`, t.token);
    expect((await shown.json<{ message: Message }>()).message.labels).toEqual({
      owner: "ana",
      state: "open",
    });
  });

  it("treats keys named like object properties as ordinary keys", async () => {
    const t = await tenant();
    const message = await sent(t, "x");
    const claim = await relabel(t, message.id, { set: { constructor: "a" }, if: { constructor: null } });
    expect(claim.status).toBe(200);
    expect((await relabel(t, message.id, { set: { tostring: "b" }, if: { constructor: "a" } })).status).toBe(
      200,
    );
    const removed = await relabel(t, message.id, { set: { valueof: "c" }, unset: ["constructor"] });
    expect(removed.status).toBe(200);
    expect((await removed.json<{ message: Message }>()).message.labels).toEqual({
      tostring: "b",
      valueof: "c",
    });
    expect((await relabel(t, message.id, { unset: ["constructor"], if: { constructor: null } })).status).toBe(
      200,
    );
    expect((await send(t, "y", { constructor: "z" })).status).toBe(201);
    expect((await list(t, "?label=constructor=z")).messages.map((m) => m.text)).toEqual(["y"]);
  });

  it("rejects C1 control characters in values, like the CLI", async () => {
    const t = await tenant();
    const response = await send(t, "x", { state: "a\u0085b" });
    expect(response.status).toBe(400);
  });

  it("rejects malformed changes, missing messages and a change past the label limit", async () => {
    const t = await tenant();
    const message = await sent(
      t,
      "x",
      Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "v"])),
    );
    for (const change of [
      {},
      { set: {} },
      { set: { a: "b" }, unset: ["a"] },
      { unset: "a" },
      { set: { a: "b" }, extra: 1 },
    ])
      expect((await relabel(t, message.id, change)).status).toBe(400);
    expect((await relabel(t, message.id, { set: { k16: "v" } })).status).toBe(400);
    expect((await relabel(t, message.id, { set: { k0: "w" } })).status).toBe(200);
    expect((await relabel(t, 999, { set: { a: "b" } })).status).toBe(404);
    const deleted = await call(
      `/api/admin/tenants/${t.name}/channels/general/messages/${message.id}`,
      ADMIN,
      {
        method: "DELETE",
      },
    );
    expect(deleted.status).toBe(204);
    expect((await relabel(t, message.id, { set: { a: "b" } })).status).toBe(410);
    const rows = await runInDurableObject(t.stub, (_, state) =>
      state.storage.sql.exec("SELECT * FROM message_labels WHERE messageId = ?", message.id).toArray(),
    );
    expect(rows).toEqual([]);
  });

  it("filters by key, by value, by alternatives and by several labels together", async () => {
    const t = await tenant();
    const a = await sent(t, "a", { state: "open", area: "cli" });
    const b = await sent(t, "b", { state: "draft", area: "web" });
    const c = await sent(t, "c", { state: "done", area: "cli" });
    await sent(t, "d");
    const ids = async (query: string) => (await list(t, query)).messages.map((m) => m.id);
    expect(await ids("?label=state")).toEqual([a.id, b.id, c.id]);
    expect(await ids("?label=state=open")).toEqual([a.id]);
    expect(await ids(`?label=${encodeURIComponent("state=open|draft")}`)).toEqual([a.id, b.id]);
    expect(await ids("?label=area=cli&label=state=done")).toEqual([c.id]);
    expect(await ids("?label=missing")).toEqual([]);
    expect(await ids(`?label=state&after=${a.id}&limit=1`)).toEqual([b.id]);
    expect(await ids(`?after=${a.id}&before=${c.id}`)).toEqual([b.id]);
    expect((await call(`${t.channel}/messages?label=Bad`, t.token)).status).toBe(400);
    // The filter's driving index skips deleted messages and other channels' labels.
    await call(
      `${t.path}/channels/other/messages`,
      t.token,
      post({ username: "agent", text: "o", labels: { state: "open" } }),
    );
    expect(
      (
        await call(`/api/admin/tenants/${t.name}/channels/general/messages/${a.id}`, ADMIN, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(await ids("?label=state=open")).toEqual([]);
    expect(await ids(`?label=${encodeURIComponent("state=done|draft")}&label=area`)).toEqual([b.id, c.id]);
  });

  it("wakes a filtered long poll when an older message gains the label", async () => {
    const t = await tenant();
    const message = await sent(t, "pending review", { state: "review" });
    const waiting = call(
      `${t.channel}/messages?label=state=approved&after=${message.id - 1}&before=${message.id + 1}&wait=10`,
      t.token,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await sent(t, "unrelated", { state: "approved" });
    expect((await relabel(t, message.id, { set: { state: "approved" } })).status).toBe(200);
    const page = await (await waiting).json<Page>();
    expect(page.messages.map((m) => [m.id, m.labels?.state])).toEqual([[message.id, "approved"]]);
  });

  it("migrates a v12 database to v13 with no labels and usable label writes", async () => {
    const t = await tenant();
    const before = await sent(t, "old");
    await runInDurableObject(t.stub, (_, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("DROP TABLE message_labels");
        state.storage.sql.exec("ALTER TABLE usage DROP COLUMN labelChanges");
        state.storage.sql.exec("DELETE FROM schema_version WHERE version = 13");
      });
    });
    await abortAllDurableObjects();
    const restarted = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", t.name]));
    const versions = await runInDurableObject(restarted, (_, state) =>
      state.storage.sql.exec<{ version: number }>("SELECT MAX(version) AS version FROM schema_version").one(),
    );
    expect(versions.version).toBe(13);
    expect((await list(t, "")).messages[0]).not.toHaveProperty("labels");
    expect((await relabel(t, before.id, { set: { state: "open" } })).status).toBe(200);
  });

  it("stops label changes at the lifetime cap without blocking sends", async () => {
    const t = await tenant();
    const message = await sent(t, "x");
    await runInDurableObject(t.stub, (_, state) =>
      state.storage.sql.exec("UPDATE usage SET labelChanges = 100000"),
    );
    const capped = await relabel(t, message.id, { set: { state: "open" } });
    expect(capped.status).toBe(409);
    expect((await capped.json<{ error: { code: string } }>()).error.code).toBe("label_quota");
    expect((await send(t, "still sending", { state: "open" })).status).toBe(201);
  });
});
