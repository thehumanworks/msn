import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { searchMatch } from "../src/http";
import type { MsnDurableObject } from "../src/store";

const ADMIN = "test-admin-secret-000000000000000000000";

type Message = { id: number; text: string; username: string; labels?: Record<string, string> };
type Result = { messages: Message[]; hasMore: boolean; nextBefore?: number; complete: boolean };

const call = (path: string, token?: string, init: RequestInit = {}) =>
  exports.default.fetch(`https://msn.test${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });

async function workspace() {
  const name = `srch-${crypto.randomUUID()}`;
  const response = await call(`/api/admin/tenants/${name}`, ADMIN, { method: "PUT" });
  expect(response.status).toBe(201);
  const { token } = await response.json<{ token: string }>();
  return {
    name,
    token,
    path: `/api/tenants/${name}`,
    stub: () => env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", name])),
  };
}
type Workspace = Awaited<ReturnType<typeof workspace>>;

async function send(
  w: Workspace,
  text: string,
  { channel = "general", username = "agent", contentType, labels }: Record<string, unknown> = {},
): Promise<Message> {
  const response = await call(`${w.path}/channels/${channel}/messages`, w.token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, text, contentType, labels }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ message: Message }>()).message;
}
const search = (w: Workspace, query: string, channel = "general") =>
  call(`${w.path}/channels/${channel}/search?${query}`, w.token);
async function found(w: Workspace, query: string, channel = "general"): Promise<Result> {
  const response = await search(w, query, channel);
  expect(response.status).toBe(200);
  return response.json<Result>();
}
const ids = (result: Result) => result.messages.map((message) => message.id);

describe("searchMatch", () => {
  it("quotes every word as a prefix and keeps quoted text as a phrase", () => {
    expect(searchMatch("deploy fail")).toBe('"deploy"* "fail"*');
    expect(searchMatch('"merge it" now')).toBe('"merge it" "now"*');
    expect(searchMatch('unclosed "phrase here')).toBe('"unclosed"* "phrase here"');
  });

  it("never passes FTS5 syntax through", () => {
    expect(searchMatch('NEAR(a b) OR c* -d ^e "f')).toBe('"NEAR"* "a" "b" "OR" "c" "d" "e" "f"');
    expect(searchMatch("text: AND")).toBe('"text"* "AND"*');
    expect(searchMatch("!!! ...")).toBeNull();
    expect(searchMatch("___ \u0301")).toBeNull();
    expect(searchMatch("")).toBeNull();
  });

  it("matches word starts only for words of three or more characters", () => {
    expect(searchMatch("ci is red")).toBe('"ci" "is" "red"*');
    expect(searchMatch("née")).toBe('"née"*');
  });

  it("limits length and the number of terms", () => {
    expect(() => searchMatch("a".repeat(257))).toThrow(/256/);
    expect(() => searchMatch(Array.from({ length: 17 }, (_, i) => `w${i}`).join(" "))).toThrow(/16/);
  });
});

describe("message search (ADR 0037)", () => {
  it("finds messages by words, newest first, only in the asked channel", async () => {
    const w = await workspace();
    const first = await send(w, "We decided to deploy on Friday.");
    await send(w, "Lunch is at noon.");
    const second = await send(w, "Deployment failed: rolling back");
    await send(w, "deploy elsewhere", { channel: "other" });
    const result = await found(w, "q=deploy");
    expect(ids(result)).toEqual([second.id, first.id]);
    expect(result).toMatchObject({ hasMore: false, complete: true });
    expect(ids(await found(w, "q=deploy+friday"))).toEqual([first.id]);
    expect(ids(await found(w, `q=${encodeURIComponent('"rolling back"')}`))).toEqual([second.id]);
    expect(ids(await found(w, `q=${encodeURIComponent('"back rolling"')}`))).toEqual([]);
  });

  it("folds case and accents", async () => {
    const w = await workspace();
    const message = await send(w, "Café RÉSUMÉ ready");
    expect(ids(await found(w, "q=cafe+resume"))).toEqual([message.id]);
  });

  it("narrows by sender, kind and label, and searches without words", async () => {
    const w = await workspace();
    const ada = await send(w, "plan: ship search", { username: "ada", labels: { state: "open" } });
    const bob = await send(w, "plan: review search", { username: "bob" });
    const json = await send(w, '{"plan":"search"}', { username: "ada", contentType: "application/json" });
    expect(ids(await found(w, "q=plan&from=ada"))).toEqual([json.id, ada.id]);
    expect(ids(await found(w, "from=bob"))).toEqual([bob.id]);
    expect(ids(await found(w, "q=search&kind=json"))).toEqual([json.id]);
    expect(ids(await found(w, "kind=text&from=ada"))).toEqual([ada.id]);
    const labeled = await found(w, "q=search&label=state=open");
    expect(ids(labeled)).toEqual([ada.id]);
    expect(labeled.messages[0].labels).toEqual({ state: "open" });
  });

  it("returns attachments with matching messages", async () => {
    const w = await workspace();
    await send(w, "unrelated note");
    const upload = await call(`${w.path}/channels/general/attachments`, w.token, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: "step 2 FAILED\n",
    });
    expect(upload.ok).toBe(true);
    const { attachment } = await upload.json<{ attachment: { id: string } }>();
    const response = await call(`${w.path}/channels/general/messages`, w.token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "agent",
        text: "build log attached",
        attachments: [{ id: attachment.id, name: "build.log" }],
      }),
    });
    expect(response.status).toBe(201);
    const [found_] = (await found(w, "q=build")).messages as Array<Message & { attachments?: unknown[] }>;
    expect(found_.attachments).toMatchObject([{ index: 0, id: attachment.id, name: "build.log" }]);
  });

  it("pages to older matches with before", async () => {
    const w = await workspace();
    const sent = [];
    for (let i = 0; i < 5; i++) sent.push(await send(w, `status update ${i}`));
    const page = await found(w, "q=status&limit=2");
    expect(ids(page)).toEqual([sent[4].id, sent[3].id]);
    expect(page).toMatchObject({ hasMore: true, nextBefore: sent[3].id });
    const next = await found(w, `q=status&limit=2&before=${page.nextBefore}`);
    expect(ids(next)).toEqual([sent[2].id, sent[1].id]);
    const last = await found(w, `q=status&limit=2&before=${next.nextBefore}`);
    expect(ids(last)).toEqual([sent[0].id]);
    expect(last.hasMore).toBe(false);
    expect(last.nextBefore).toBeUndefined();
  });

  it("drops deleted messages from the index", async () => {
    const w = await workspace();
    const secret = await send(w, "the password is hunter2");
    expect(ids(await found(w, "q=hunter2"))).toEqual([secret.id]);
    const deleted = await call(`/api/admin/tenants/${w.name}/channels/general/messages/${secret.id}`, ADMIN, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    expect(ids(await found(w, "q=hunter2"))).toEqual([]);
    const rows = await runInDurableObject(w.stub(), (_, state) =>
      state.storage.sql
        .exec(`SELECT rowid FROM message_search WHERE message_search MATCH '"hunter2"'`)
        .toArray(),
    );
    expect(rows).toEqual([]);
  });

  it("rejects bad input and other channels' credentials", async () => {
    const w = await workspace();
    await send(w, "hello");
    for (const query of [
      "",
      "q=!!!",
      "q=___",
      "kind=text/plain",
      "kind=xml",
      "q=a&limit=0",
      "q=a&sort=old",
      `q=${"a".repeat(257)}`,
    ])
      expect((await search(w, query)).status).toBe(400);
    expect((await search(w, "q=hello", "missing")).status).toBe(404);
    expect((await call(`${w.path}/channels/general/search?q=hello`, "wrong-token")).status).toBe(401);
  });

  it("lets short words match only whole words", async () => {
    const w = await workspace();
    const ci = await send(w, "CI is red again");
    await send(w, "circle back on the cinema plan");
    expect(ids(await found(w, "q=ci"))).toEqual([ci.id]);
    expect(ids(await found(w, "q=cir"))).toHaveLength(1);
  });

  it("keeps a channel-scoped key to its own channel", async () => {
    const w = await workspace();
    await send(w, "secret plan", { channel: "private" });
    await send(w, "open plan");
    const created = await call(`${w.path}/invites`, w.token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "general" }),
    });
    expect(created.status).toBe(201);
    const { code } = await created.json<{ code: string }>();
    const redeemed = await call(`${w.path}/invites/redeem`, undefined, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, username: "guest" }),
    });
    expect(redeemed.status).toBe(201);
    const { token } = await redeemed.json<{ token: string }>();
    expect((await call(`${w.path}/channels/private/search?q=plan`, token)).status).toBe(403);
    const own = await call(`${w.path}/channels/general/search?q=plan`, token);
    expect(own.status).toBe(200);
    expect((await own.json<Result>()).messages.map((m) => m.text)).toEqual(["open plan"]);
  });

  it("sets no alarm on a fresh workspace", async () => {
    const w = await workspace();
    await send(w, "hello");
    expect(await runInDurableObject(w.stub(), (_, state) => state.storage.getAlarm())).toBeNull();
  });

  it("indexes older messages in batches and reports complete only at the end", async () => {
    const w = await workspace();
    const old = [];
    for (let i = 0; i < 3; i++) old.push(await send(w, `legacy note ${i}`));
    // Empty the index and set the backfill state as the v17 migration leaves it, without a restart,
    // so no alarm runs and each batch is stepped by hand.
    await runInDurableObject(w.stub(), (_, state) => {
      state.storage.sql.exec("DELETE FROM message_search");
      state.storage.sql.exec("INSERT OR REPLACE INTO search_backfill SELECT 1, 0, MAX(id) FROM messages");
    });
    const fresh = await send(w, "legacy note after migration");
    const before = await found(w, "q=legacy");
    expect(before.complete).toBe(false);
    expect(ids(before)).toEqual([fresh.id]);
    const step = () =>
      runInDurableObject(w.stub(), (instance: MsnDurableObject) => instance.backfillSearch(2));
    expect(await step()).toBe(false);
    expect(ids(await found(w, "q=legacy"))).toEqual([fresh.id, old[1].id, old[0].id]);
    expect(await step()).toBe(true);
    const after = await found(w, "q=legacy");
    expect(after.complete).toBe(true);
    expect(ids(after)).toEqual([fresh.id, ...old.map((message) => message.id).reverse()]);
    expect(await step()).toBe(true);
  });

  it("never indexes a message deleted before the backfill reaches it", async () => {
    const w = await workspace();
    const kept = await send(w, "legacy keep");
    const gone = await send(w, "legacy hunter2");
    await runInDurableObject(w.stub(), (_, state) => {
      state.storage.sql.exec("DELETE FROM message_search");
      state.storage.sql.exec("INSERT OR REPLACE INTO search_backfill SELECT 1, 0, MAX(id) FROM messages");
    });
    const deleted = await call(`/api/admin/tenants/${w.name}/channels/general/messages/${gone.id}`, ADMIN, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    expect(
      await runInDurableObject(w.stub(), (instance: MsnDurableObject) => instance.backfillSearch()),
    ).toBe(true);
    expect(ids(await found(w, "q=legacy"))).toEqual([kept.id]);
    const rows = await runInDurableObject(w.stub(), (_, state) =>
      state.storage.sql.exec("SELECT rowid FROM message_search").toArray(),
    );
    expect(rows).toEqual([{ rowid: kept.id }]);
  });

  it("indexes messages sent while code without search ran (a rollback), on the next start", async () => {
    const w = await workspace();
    const before = await send(w, "rollback before");
    const during = await send(w, "rollback during");
    // Simulate v16 code handling the second send: its index row is missing, backfill says done.
    await runInDurableObject(w.stub(), (_, state) => {
      state.storage.sql.exec("DELETE FROM message_search WHERE rowid = ?", during.id);
      state.storage.sql.exec("UPDATE search_backfill SET indexedThrough = 0, target = 0");
    });
    expect(ids(await found(w, "q=rollback"))).toEqual([before.id]);
    await abortAllDurableObjects();
    await found(w, "q=rollback");
    await runDurableObjectAlarm(w.stub());
    const after = await found(w, "q=rollback");
    expect(ids(after)).toEqual([during.id, before.id]);
    expect(after.complete).toBe(true);
    // The re-indexed range held no duplicates.
    const rows = await runInDurableObject(w.stub(), (_, state) =>
      state.storage.sql.exec("SELECT rowid FROM message_search ORDER BY rowid").toArray(),
    );
    expect(rows).toEqual([{ rowid: before.id }, { rowid: during.id }]);
  });

  it("backfills a database that a later schema (v18) reached without the search index", async () => {
    const w = await workspace();
    const old = [];
    for (let i = 0; i < 3; i++) old.push(await send(w, `pinned era ${i}`));
    // PR order can record rows 17 and 18 before this code first runs: no index, no backfill row.
    await runInDurableObject(w.stub(), (_, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("DROP TABLE message_search");
        state.storage.sql.exec("DROP TABLE search_backfill");
        state.storage.sql.exec("INSERT OR IGNORE INTO schema_version VALUES (17), (18)");
      });
    });
    await abortAllDurableObjects();
    await found(w, "q=pinned");
    await runDurableObjectAlarm(w.stub());
    const after = await found(w, "q=pinned");
    expect(after.complete).toBe(true);
    expect(ids(after)).toEqual(old.map((message) => message.id).reverse());
  });

  it("migrates a v16 database: the alarm indexes every live message that existed before", async () => {
    const w = await workspace();
    const old = [];
    for (let i = 0; i < 3; i++) old.push(await send(w, `legacy note ${i}`));
    await send(w, "deleted legacy note");
    // Rewind to v16: no index, no backfill state, no schema row 17.
    await runInDurableObject(w.stub(), (_, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("DROP TABLE message_search");
        state.storage.sql.exec("DROP TABLE search_backfill");
        state.storage.sql.exec("DELETE FROM schema_version WHERE version = 17");
        state.storage.sql.exec(
          "UPDATE messages SET deleted = 1, text = '' WHERE text = 'deleted legacy note'",
        );
      });
    });
    await abortAllDurableObjects();
    // The restarted object schedules its backfill alarm; run it if it has not fired yet.
    await found(w, "q=legacy");
    await runDurableObjectAlarm(w.stub());
    const after = await found(w, "q=legacy");
    expect(after.complete).toBe(true);
    expect(ids(after)).toEqual(old.map((message) => message.id).reverse());
    expect(ids(await found(w, "q=deleted"))).toEqual([]);
    const versions = await runInDurableObject(w.stub(), (_, state) =>
      state.storage.sql
        .exec<{ version: number }>("SELECT version FROM schema_version ORDER BY version")
        .toArray()
        .map((row) => row.version),
    );
    expect(versions.at(-1)).toBe(17);
    expect(await runInDurableObject(w.stub(), (_, state) => state.storage.getAlarm())).toBeNull();
  });
});
