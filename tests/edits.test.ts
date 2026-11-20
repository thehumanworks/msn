import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Edit a message you sent (ADR 0052): only the sender replaces the text; the id and everything
// keyed by it stay, and one `message.edited` event goes to clients that ask for it.

const ADMIN = "test-admin-secret-000000000000000000000";
const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });

type Message = {
  id: number;
  text: string;
  username: string;
  createdAt: string;
  editedAt?: string;
  reactions?: Record<string, string[]>;
  labels?: Record<string, string>;
};

/** An owner account with a board `work`, its shared agent credential and personas `lead` and `dev`. */
async function fixture() {
  const tenant = `edit-${crypto.randomUUID()}`;
  const owner = (await (await call(tenant, "", undefined, "PUT", { username: "human" })).json()) as {
    token: string;
  };
  const agent = "e".repeat(64);
  expect(
    (await call(tenant, "/channels/work/board", owner.token, "PUT", { credential: agent, goal: "Ship" }))
      .status,
  ).toBe(201);
  for (const name of ["lead", "dev"])
    expect(
      (await call(tenant, `/channels/work/personas/${name}`, agent, "PUT", { displayName: name })).status,
    ).toBe(201);
  const send = async (text: string, username = "lead", token = agent, extra: object = {}) => {
    const response = await call(tenant, "/channels/work/messages", token, "POST", {
      username,
      text,
      ...extra,
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { message: Message }).message;
  };
  return { tenant, owner: owner.token, agent, send };
}

const edit = (f: { tenant: string }, id: number, token: string, username: string, text: string) =>
  call(f.tenant, `/channels/work/messages/${id}`, token, "PATCH", { username, text });

const read = async (f: { tenant: string }, token: string, after = 0) =>
  (await (await call(f.tenant, `/channels/work/messages?after=${after}`, token)).json()) as {
    messages: Message[];
    nextCursor: number;
  };

describe("edit a message you sent (ADR 0052)", () => {
  it("replaces the sender's text, stamps editedAt and keeps the id and createdAt", async () => {
    const f = await fixture();
    const sent = await f.send("Deploy the wroker");
    expect("editedAt" in sent).toBe(false);
    const response = await edit(f, sent.id, f.agent, "lead", "Deploy the worker");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: Message; changed: boolean };
    expect(body.changed).toBe(true);
    expect(body.message).toMatchObject({ id: sent.id, text: "Deploy the worker", createdAt: sent.createdAt });
    expect(Date.parse(body.message.editedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(sent.createdAt));
    const [stored] = (await read(f, f.agent)).messages;
    expect(stored).toMatchObject({ id: sent.id, text: "Deploy the worker", editedAt: body.message.editedAt });
    // The same text again changes nothing and writes no event.
    const same = (await (await edit(f, sent.id, f.agent, "lead", "Deploy the worker")).json()) as {
      changed: boolean;
      message: Message;
    };
    expect(same).toMatchObject({ changed: false, message: { editedAt: body.message.editedAt } });
  });

  it("lets only the sender edit", async () => {
    const f = await fixture();
    const sent = await f.send("mine");
    const other = await edit(f, sent.id, f.agent, "dev", "taken over");
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ error: { code: "not_sender" } });
    // The owner's key cannot rewrite an agent's message under its own name.
    expect((await edit(f, sent.id, f.owner, "human", "owner rewrite")).status).toBe(403);
    // A shared credential edits only as a registered persona.
    const unknown = await edit(f, sent.id, f.agent, "ghost", "x");
    expect(unknown.status).toBe(403);
    // A bound key edits only as its own name.
    const invite = (await (
      await call(f.tenant, "/invites", f.owner, "POST", { channel: "work" })
    ).json()) as {
      code: string;
    };
    const bob = (await (
      await call(f.tenant, "/invites/redeem", undefined, "POST", { code: invite.code, username: "bob" })
    ).json()) as { token: string };
    const bound = await edit(f, sent.id, bob.token, "lead", "impersonated");
    expect(bound.status).toBe(403);
    expect(await bound.json()).toMatchObject({ error: { code: "username_bound" } });
    const own = await f.send("bob here", "bob", bob.token);
    expect((await edit(f, own.id, bob.token, "bob", "bob was here")).status).toBe(200);
    // A persona renamed onto another persona's old display name cannot edit the old messages.
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE messages SET personaId = 'dev' WHERE id = ?", sent.id);
    });
    const borrowed = await edit(f, sent.id, f.agent, "lead", "not yours");
    expect(borrowed.status).toBe(403);
    expect((await read(f, f.agent)).messages[0].text).toBe("mine");
  });

  it("keeps the text limits and the content type", async () => {
    const f = await fixture();
    const sent = await f.send("short");
    for (const text of ["", "   ", "x".repeat(16385)]) {
      const bad = await edit(f, sent.id, f.agent, "lead", text);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: { code: "invalid_message" } });
    }
    expect((await edit(f, sent.id, f.agent, "lead", "y".repeat(16384))).status).toBe(200);
    const extra = await call(f.tenant, `/channels/work/messages/${sent.id}`, f.agent, "PATCH", {
      username: "lead",
      text: "x",
      contentType: "application/json",
    });
    expect(extra.status).toBe(400);
    expect(await extra.json()).toMatchObject({ error: { code: "invalid_edit" } });
    const json = await f.send('{"state":"open"}', "lead", f.agent, { contentType: "application/json" });
    const notJson = await edit(f, json.id, f.agent, "lead", "not json");
    expect(notJson.status).toBe(400);
    expect((await edit(f, json.id, f.agent, "lead", '{"state":"done"}')).status).toBe(200);
  });

  it("does not move order, cursors, receipts, unread or since-you-left", async () => {
    const f = await fixture();
    const first = await f.send("first");
    const second = await f.send("second", "dev");
    const reader = "/channels/work/processing/dev";
    const claimed = await call(f.tenant, `${reader}/claim`, f.agent, "POST", { expectGeneration: 0 });
    expect(claimed.status).toBe(201);
    const claim = (await claimed.json()) as { generation: number };
    expect(
      (
        await call(f.tenant, `${reader}/commit`, f.agent, "POST", {
          generation: claim.generation,
          through: first.id,
        })
      ).status,
    ).toBe(200);
    const receiptsBefore = await (await call(f.tenant, "/channels/work/receipts", f.agent)).json();
    const unreadBefore = await (
      await call(f.tenant, `/unread?me=human&mark=work:${first.id}`, f.owner)
    ).json();
    expect((await edit(f, first.id, f.agent, "lead", "first, edited")).status).toBe(200);
    const page = await read(f, f.agent);
    expect(page.messages.map((m) => m.id)).toEqual([first.id, second.id]);
    expect(page.nextCursor).toBe(second.id);
    // Nothing after a cursor that already passed the edited message.
    expect((await read(f, f.agent, first.id)).messages.map((m) => m.id)).toEqual([second.id]);
    expect(await (await call(f.tenant, "/channels/work/receipts", f.agent)).json()).toEqual(receiptsBefore);
    expect(await (await call(f.tenant, `/unread?me=human&mark=work:${first.id}`, f.owner)).json()).toEqual(
      unreadBefore,
    );
    expect((await f.send("third")).id).toBe(second.id + 1);
  });

  it("writes one message.edited event, only for clients that ask for edits", async () => {
    const f = await fixture();
    const sent = await f.send("draft");
    const plain = (await (await call(f.tenant, "/events?channel=work&after=0", f.agent)).json()) as {
      events: { type: string }[];
      nextCursor: number;
    };
    await edit(f, sent.id, f.agent, "lead", "final");
    await edit(f, sent.id, f.agent, "lead", "final");
    const old = (await (
      await call(f.tenant, `/events?channel=work&after=${plain.nextCursor}`, f.agent)
    ).json()) as { events: unknown[] };
    expect(old.events).toEqual([]);
    const opted = (await (
      await call(f.tenant, `/events?channel=work&after=${plain.nextCursor}&include=edits`, f.agent)
    ).json()) as { events: { type: string; resourceId: number }[] };
    expect(opted.events.map((e) => [e.type, e.resourceId])).toEqual([["message.edited", sent.id]]);
    // Both opt-ins combine, comma-separated or repeated; anything else is refused.
    for (const include of ["labels,edits", "labels&include=edits"])
      expect(
        (await call(f.tenant, `/events?channel=work&after=${plain.nextCursor}&include=${include}`, f.agent))
          .status,
      ).toBe(200);
    expect((await call(f.tenant, "/events?include=edits,pins", f.agent)).status).toBe(400);
  });

  it("wakes an event long poll that asked for edits", async () => {
    const f = await fixture();
    const sent = await f.send("draft");
    const head = (await (await call(f.tenant, "/events?channel=work&after=0", f.agent)).json()) as {
      nextCursor: number;
    };
    const poll = call(
      f.tenant,
      `/events?channel=work&after=${head.nextCursor}&wait=10&include=edits`,
      f.agent,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await edit(f, sent.id, f.agent, "lead", "final");
    const woke = (await (await poll).json()) as { events: { type: string }[] };
    expect(woke.events.map((e) => e.type)).toEqual(["message.edited"]);
  });

  it("finds the new words in search and not the old ones", async () => {
    const f = await fixture();
    const sent = await f.send("rollout blocked on staging");
    await edit(f, sent.id, f.agent, "lead", "rollout finished on production");
    const search = async (q: string) =>
      (
        (await (await call(f.tenant, `/channels/work/search?q=${q}`, f.agent)).json()) as {
          messages: Message[];
        }
      ).messages.map((m) => m.id);
    expect(await search("staging")).toEqual([]);
    expect(await search("production")).toEqual([sent.id]);
    expect(await search("rollout")).toEqual([sent.id]);
  });

  it("shows the edit on every read: single message, catch-up and pins", async () => {
    const f = await fixture();
    const sent = await f.send("pinned plan v1");
    expect((await call(f.tenant, `/channels/work/pins/${sent.id}`, f.owner, "PUT")).status).toBe(201);
    await edit(f, sent.id, f.agent, "lead", "pinned plan v2");
    const one = (await (await call(f.tenant, `/channels/work/messages/${sent.id}`, f.agent)).json()) as {
      message: Message;
    };
    expect(one.message).toMatchObject({ text: "pinned plan v2", editedAt: expect.any(String) });
    const catchup = (await (await call(f.tenant, "/channels/work/catchup", f.agent)).json()) as {
      messages: Message[];
      pinned: Message[];
    };
    expect(catchup.messages[0].text).toBe("pinned plan v2");
    expect(catchup.pinned[0]).toMatchObject({ text: "pinned plan v2", editedAt: expect.any(String) });
    // Catch-up without editsAfter keeps its old shape.
    expect("edited" in catchup).toBe(false);
    expect("editCursor" in catchup).toBe(false);
  });

  it("returns earlier edited messages on catch-up with editsAfter, and advances editCursor", async () => {
    const f = await fixture();
    const a = await f.send("a1");
    const b = await f.send("b1");
    const start = (await (await call(f.tenant, "/channels/work/catchup?editsAfter=0", f.agent)).json()) as {
      edited: Message[];
      editCursor: number;
      editsHasMore: boolean;
      nextCursor: number;
    };
    expect(start).toMatchObject({ edited: [], editCursor: 0, editsHasMore: false, nextCursor: b.id });
    await edit(f, b.id, f.agent, "lead", "b2");
    await edit(f, a.id, f.agent, "lead", "a2");
    const c = await f.send("c1");
    await edit(f, c.id, f.agent, "lead", "c2");
    const next = (await (
      await call(f.tenant, `/channels/work/catchup?after=${b.id}&editsAfter=${start.editCursor}`, f.agent)
    ).json()) as { edited: Message[]; editCursor: number; editsHasMore: boolean; messages: Message[] };
    // Oldest edit first; only messages at or before the cursor (c arrives in messages, current text).
    expect(next.edited.map((m) => [m.id, m.text])).toEqual([
      [b.id, "b2"],
      [a.id, "a2"],
    ]);
    expect(next.messages.map((m) => [m.id, m.text])).toEqual([[c.id, "c2"]]);
    expect(next.editsHasMore).toBe(false);
    const again = (await (
      await call(f.tenant, `/channels/work/catchup?after=${c.id}&editsAfter=${next.editCursor}`, f.agent)
    ).json()) as { edited: Message[]; editCursor: number };
    expect(again.edited).toEqual([]);
    expect(again.editCursor).toBe(next.editCursor);
    // A later edit shows up exactly once.
    await edit(f, a.id, f.agent, "lead", "a3");
    const later = (await (
      await call(f.tenant, `/channels/work/catchup?after=${c.id}&editsAfter=${again.editCursor}`, f.agent)
    ).json()) as { edited: Message[]; editCursor: number };
    expect(later.edited.map((m) => [m.id, m.text])).toEqual([[a.id, "a3"]]);
    expect(later.editCursor).toBeGreaterThan(again.editCursor);
  });

  it("pages catch-up edits by count and by bytes", async () => {
    const f = await fixture();
    const ids: number[] = [];
    for (let i = 0; i < 22; i++) ids.push((await f.send(`m${i}`)).id);
    for (const id of ids) await edit(f, id, f.agent, "lead", `edited ${id} ${"z".repeat(900)}`);
    const head = ids.at(-1);
    const first = (await (
      await call(f.tenant, `/channels/work/catchup?after=${head}&editsAfter=0&maxBytes=262144`, f.agent)
    ).json()) as { edited: Message[]; editCursor: number; editsHasMore: boolean };
    expect(first.edited.length).toBe(20);
    expect(first.editsHasMore).toBe(true);
    const rest = (await (
      await call(f.tenant, `/channels/work/catchup?after=${head}&editsAfter=${first.editCursor}`, f.agent)
    ).json()) as { edited: Message[]; editsHasMore: boolean };
    expect(rest.edited.map((m) => m.id)).toEqual(ids.slice(20));
    expect(rest.editsHasMore).toBe(false);
    const small = (await (
      await call(f.tenant, `/channels/work/catchup?after=${head}&editsAfter=0&maxBytes=4096`, f.agent)
    ).json()) as { edited: Message[]; editCursor: number; editsHasMore: boolean; byteLimitReached: boolean };
    expect(small.edited.length).toBeGreaterThan(0);
    expect(small.edited.length).toBeLessThan(20);
    expect(small).toMatchObject({ editsHasMore: true, byteLimitReached: true });
    const resumed = (await (
      await call(f.tenant, `/channels/work/catchup?after=${head}&editsAfter=${small.editCursor}`, f.agent)
    ).json()) as { edited: Message[] };
    expect(resumed.edited[0].id).toBe(ids[small.edited.length]);
  });

  it("lists edits after an edit cursor for clients refreshing what they show", async () => {
    const f = await fixture();
    const a = await f.send("a1");
    const b = await f.send("b1");
    const start = (await (await call(f.tenant, "/channels/work/edits", f.agent)).json()) as {
      edits: Message[];
      editCursor: number;
    };
    expect(start).toEqual({ edits: [], editCursor: 0, hasMore: false });
    await edit(f, b.id, f.agent, "lead", "b2");
    await edit(f, a.id, f.agent, "lead", "a2");
    const page = (await (
      await call(f.tenant, `/channels/work/edits?after=${start.editCursor}`, f.agent)
    ).json()) as { edits: Message[]; editCursor: number; hasMore: boolean };
    expect(page.edits.map((m) => [m.id, m.text])).toEqual([
      [b.id, "b2"],
      [a.id, "a2"],
    ]);
    expect(page.hasMore).toBe(false);
    const none = (await (
      await call(f.tenant, `/channels/work/edits?after=${page.editCursor}`, f.agent)
    ).json()) as { edits: Message[]; editCursor: number };
    expect(none).toEqual({ edits: [], editCursor: page.editCursor, hasMore: false });
    // Edits on another board do not show here, and their cursor values do not confuse this one.
    expect((await call(f.tenant, "/channels/other", f.owner, "PUT")).status).toBe(201);
    const sent = (await (
      await call(f.tenant, "/channels/other/messages", f.owner, "POST", { username: "human", text: "x" })
    ).json()) as { message: Message };
    expect(
      (
        await call(f.tenant, `/channels/other/messages/${sent.message.id}`, f.owner, "PATCH", {
          username: "human",
          text: "y",
        })
      ).status,
    ).toBe(200);
    const after = (await (
      await call(f.tenant, `/channels/work/edits?after=${page.editCursor}`, f.agent)
    ).json()) as { edits: Message[] };
    expect(after.edits).toEqual([]);
    // A board-scoped key cannot read another board's edits.
    expect((await call(f.tenant, "/channels/other/edits", f.agent)).status).toBe(403);
    expect((await call(f.tenant, "/channels/work/edits?before=1", f.agent)).status).toBe(400);
  });

  it("refuses watch-only keys with 403 and archived boards with 409", async () => {
    const f = await fixture();
    const sent = await f.send("x");
    const invite = (await (
      await call(f.tenant, "/invites", f.owner, "POST", { channel: "work", watch: true })
    ).json()) as { code: string };
    const watcher = (await (
      await call(f.tenant, "/invites/redeem", undefined, "POST", { code: invite.code, username: "watcher" })
    ).json()) as { token: string };
    const watched = await edit(f, sent.id, watcher.token, "lead", "y");
    expect(watched.status).toBe(403);
    expect(await watched.json()).toMatchObject({ error: { code: "watch_only" } });
    expect((await call(f.tenant, "/channels/work/archive", f.owner, "PUT")).status).toBe(200);
    const archived = await edit(f, sent.id, f.agent, "lead", "y");
    expect(archived.status).toBe(409);
    expect(await archived.json()).toMatchObject({ error: { code: "board_archived" } });
    expect((await read(f, f.agent)).messages[0].text).toBe("x");
  });

  it("refuses GitHub messages, deleted messages and unknown ids", async () => {
    const tenant = `edit-gh-${crypto.randomUUID()}`;
    const created = await exports.default.fetch(`https://msn.test/api/admin/tenants/${tenant}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    const { token } = (await created.json()) as { token: string };
    const sent = (await (
      await call(tenant, "/channels/general/messages", token, "POST", { username: "a", text: "hi" })
    ).json()) as { message: Message };
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant]));
    const githubId = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ id: number }>(
            "INSERT INTO messages(channel, username, text, contentType, createdAt, digest, bytes) VALUES ('general', 'github', 'PR #1 opened', 'text/plain', ?, 'x', 18) RETURNING id",
            new Date().toISOString(),
          )
          .one().id,
    );
    const patch = (id: number, username: string) =>
      call(tenant, `/channels/general/messages/${id}`, token, "PATCH", { username, text: "rewritten" });
    const github = await patch(githubId, "github");
    expect(github.status).toBe(403);
    expect(await github.json()).toMatchObject({ error: { code: "github_message" } });
    expect((await patch(githubId + 1000, "a")).status).toBe(404);
    const deleted = await exports.default.fetch(
      `https://msn.test/api/admin/tenants/${tenant}/channels/general/messages/${sent.message.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN}` } },
    );
    expect(deleted.status).toBe(204);
    expect((await patch(sent.message.id, "a")).status).toBe(410);
  });

  it("keeps the byte quota exact and caps lifetime edits", async () => {
    const f = await fixture();
    const sent = await f.send("1234");
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    const usage = () =>
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ bytes: number; edits: number }>("SELECT bytes, edits FROM usage").one(),
      );
    const before = await usage();
    await edit(f, sent.id, f.agent, "lead", "12345678");
    expect(await usage()).toEqual({ bytes: before.bytes + 4, edits: before.edits + 1 });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE usage SET edits = 100000");
    });
    const full = await edit(f, sent.id, f.agent, "lead", "again");
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: { code: "edit_quota" } });
  });

  it("keeps labels and reactions on the edited message", async () => {
    const f = await fixture();
    const sent = await f.send("task", "lead", f.agent, { labels: { state: "open" } });
    await call(f.tenant, `/channels/work/messages/${sent.id}/reactions`, f.agent, "POST", {
      username: "dev",
      kind: "seen",
    });
    const body = (await (await edit(f, sent.id, f.agent, "lead", "task, clarified")).json()) as {
      message: Message;
    };
    expect(body.message).toMatchObject({ labels: { state: "open" }, reactions: { seen: ["dev"] } });
  });
});
