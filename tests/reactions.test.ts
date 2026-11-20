import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Message reactions (ADR 0047): a fixed set of four kinds, one of each per name per message,
// stored beside the message. Reacting writes no message and no event.

const ADMIN = "test-admin-secret-000000000000000000000";
const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });

type Reactions = Partial<Record<"done" | "seen" | "yes" | "no", string[]>>;
type Message = { id: number; text: string; reactions?: Reactions };

/** An owner account with a board `work`, its shared agent credential and personas `lead` and `dev`. */
async function fixture() {
  const tenant = `react-${crypto.randomUUID()}`;
  const owner = (await (await call(tenant, "", undefined, "PUT", { username: "human" })).json()) as {
    token: string;
  };
  const agent = "d".repeat(64);
  expect(
    (await call(tenant, "/channels/work/board", owner.token, "PUT", { credential: agent, goal: "Ship" }))
      .status,
  ).toBe(201);
  for (const name of ["lead", "dev"])
    expect(
      (await call(tenant, `/channels/work/personas/${name}`, agent, "PUT", { displayName: name })).status,
    ).toBe(201);
  const send = async (text: string) => {
    const response = await call(tenant, "/channels/work/messages", agent, "POST", { username: "lead", text });
    expect(response.status).toBe(201);
    return ((await response.json()) as { message: Message }).message;
  };
  return { tenant, owner: owner.token, agent, send };
}

const react = (
  f: { tenant: string },
  id: number,
  token: string,
  username: string,
  kind: string,
  remove?: boolean,
) =>
  call(f.tenant, `/channels/work/messages/${id}/reactions`, token, "POST", {
    username,
    kind,
    ...(remove === undefined ? {} : { remove }),
  });

const read = async (f: { tenant: string }, token: string) =>
  ((await (await call(f.tenant, "/channels/work/messages?after=0", token)).json()) as { messages: Message[] })
    .messages;

describe("message reactions (ADR 0047)", () => {
  it("adds one reaction of each kind per name, idempotently, and removes it", async () => {
    const f = await fixture();
    const task = await f.send("Deploy the worker");
    const first = await react(f, task.id, f.agent, "lead", "done");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      changed: true,
      message: { id: task.id, reactions: { done: ["lead"] } },
    });
    const again = await (await react(f, task.id, f.agent, "lead", "done")).json();
    expect(again).toMatchObject({ changed: false, message: { reactions: { done: ["lead"] } } });
    await react(f, task.id, f.agent, "dev", "done");
    await react(f, task.id, f.agent, "dev", "seen");
    await react(f, task.id, f.owner, "human", "no");
    const [message] = await read(f, f.agent);
    // Kinds in fixed order; names in the order they reacted.
    expect(message.reactions).toEqual({ done: ["lead", "dev"], seen: ["dev"], no: ["human"] });
    expect(Object.keys(message.reactions ?? {})).toEqual(["done", "seen", "no"]);

    const removed = await (await react(f, task.id, f.agent, "dev", "seen", true)).json();
    expect(removed).toMatchObject({ changed: true });
    const twice = await (await react(f, task.id, f.agent, "dev", "seen", true)).json();
    expect(twice).toMatchObject({ changed: false });
    await react(f, task.id, f.agent, "lead", "done", true);
    await react(f, task.id, f.agent, "dev", "done", true);
    await react(f, task.id, f.owner, "human", "no", true);
    const [bare] = await read(f, f.agent);
    expect("reactions" in bare).toBe(false);
  });

  it("does not send a message, move cursors, or add events", async () => {
    const f = await fixture();
    const first = await f.send("first");
    const before = (await (await call(f.tenant, "/events?channel=work&after=0", f.agent)).json()) as {
      events: unknown[];
      nextCursor: number;
    };
    await react(f, first.id, f.agent, "dev", "seen");
    const page = (await (await call(f.tenant, "/channels/work/messages?after=0", f.agent)).json()) as {
      messages: Message[];
      nextCursor: number;
    };
    expect(page.messages.map((m) => m.id)).toEqual([first.id]);
    expect(page.nextCursor).toBe(first.id);
    const after = (await (await call(f.tenant, "/events?channel=work&after=0", f.agent)).json()) as {
      events: unknown[];
      nextCursor: number;
    };
    expect(after.events.length).toBe(before.events.length);
    expect(after.nextCursor).toBe(before.nextCursor);
    const unread = (await (
      await call(f.tenant, `/unread?me=human&mark=work:${first.id}`, f.owner)
    ).json()) as { unread: { count: number }[] };
    expect(unread.unread[0].count).toBe(0);
    expect((await f.send("second")).id).toBe(first.id + 1);
  });

  it("shows reactions on every message read: catch-up, single message, search and pins", async () => {
    const f = await fixture();
    const task = await f.send("searchable reaction target");
    await react(f, task.id, f.agent, "lead", "yes");
    const want = { yes: ["lead"] };
    const catchup = (await (await call(f.tenant, "/channels/work/catchup", f.agent)).json()) as {
      messages: Message[];
    };
    expect(catchup.messages[0].reactions).toEqual(want);
    const one = (await (await call(f.tenant, `/channels/work/messages/${task.id}`, f.agent)).json()) as {
      message: Message;
    };
    expect(one.message.reactions).toEqual(want);
    await call(f.tenant, `/channels/work/pins/${task.id}`, f.owner, "PUT");
    const pins = (await (await call(f.tenant, "/channels/work/pins", f.agent)).json()) as {
      pins: Message[];
    };
    expect(pins.pins[0].reactions).toEqual(want);
    // Search indexes in the background; a match, when present, carries reactions too.
    const found = (await (await call(f.tenant, "/channels/work/search?q=searchable", f.agent)).json()) as {
      messages: Message[];
    };
    for (const message of found.messages) expect(message.reactions).toEqual(want);
  });

  it("lists current reactions by id range so clients can refresh what they show", async () => {
    const f = await fixture();
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await f.send(`m${i}`)).id);
    await react(f, ids[0], f.agent, "lead", "seen");
    await react(f, ids[2], f.agent, "dev", "done");
    await react(f, ids[3], f.agent, "dev", "no");
    const all = (await (await call(f.tenant, "/channels/work/reactions", f.agent)).json()) as {
      reactions: { id: number; reactions: Reactions }[];
      hasMore: boolean;
    };
    expect(all).toEqual({
      reactions: [
        { id: ids[0], reactions: { seen: ["lead"] } },
        { id: ids[2], reactions: { done: ["dev"] } },
        { id: ids[3], reactions: { no: ["dev"] } },
      ],
      hasMore: false,
    });
    const range = (await (
      await call(f.tenant, `/channels/work/reactions?after=${ids[0]}&before=${ids[3]}`, f.agent)
    ).json()) as { reactions: { id: number }[] };
    expect(range.reactions.map((r) => r.id)).toEqual([ids[2]]);
    expect((await call(f.tenant, "/channels/work/reactions?after=x", f.agent)).status).toBe(400);
  });

  it("rejects unknown kinds, fields, ids, names the key cannot use, and unregistered personas", async () => {
    const f = await fixture();
    const task = await f.send("x");
    const bad = await react(f, task.id, f.agent, "lead", "heart");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_reaction" } });
    expect(
      (
        await call(f.tenant, `/channels/work/messages/${task.id}/reactions`, f.agent, "POST", {
          username: "lead",
          kind: "done",
          extra: 1,
        })
      ).status,
    ).toBe(400);
    expect((await react(f, task.id, f.agent, "lead", "done", "yes" as unknown as boolean)).status).toBe(400);
    expect((await react(f, 99999, f.agent, "lead", "done")).status).toBe(404);
    const stranger = await react(f, task.id, f.agent, "stranger", "done");
    expect(stranger.status).toBe(400);
    expect(await stranger.json()).toMatchObject({ error: { code: "persona_required" } });
    // The owner account key is bound to its own name.
    const bound = await react(f, task.id, f.owner, "lead", "done");
    expect(bound.status).toBe(403);
    expect(await bound.json()).toMatchObject({ error: { code: "username_bound" } });
    expect(
      (await call(f.tenant, `/channels/work/messages/${task.id}/reactions`, f.agent, "PUT")).status,
    ).toBe(404);
  });

  it("refuses watch-only keys with 403 and archived boards with 409", async () => {
    const f = await fixture();
    const task = await f.send("x");
    const invite = (await (
      await call(f.tenant, "/invites", f.owner, "POST", { channel: "work", watch: true })
    ).json()) as { code: string };
    const watcher = (await (
      await call(f.tenant, "/invites/redeem", undefined, "POST", { code: invite.code, username: "watcher" })
    ).json()) as { token: string };
    const watched = await react(f, task.id, watcher.token, "watcher", "seen");
    expect(watched.status).toBe(403);
    expect(await watched.json()).toMatchObject({ error: { code: "watch_only" } });
    // Watch-only keys still read reactions.
    expect((await call(f.tenant, "/channels/work/reactions", watcher.token)).status).toBe(200);

    await react(f, task.id, f.agent, "lead", "done");
    expect((await call(f.tenant, "/channels/work/archive", f.owner, "PUT")).status).toBe(200);
    const archived = await react(f, task.id, f.agent, "dev", "done");
    expect(archived.status).toBe(409);
    expect(await archived.json()).toMatchObject({ error: { code: "board_archived" } });
    expect((await react(f, task.id, f.agent, "lead", "done", true)).status).toBe(409);
    expect((await read(f, f.agent))[0].reactions).toEqual({ done: ["lead"] });
  });

  it("drops reactions when an admin deletes the message, and refuses to react to a deleted one", async () => {
    const tenant = `react-admin-${crypto.randomUUID()}`;
    const created = await exports.default.fetch(`https://msn.test/api/admin/tenants/${tenant}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    const { token } = (await created.json()) as { token: string };
    const sent = (await (
      await call(tenant, "/channels/general/messages", token, "POST", { username: "a", text: "gone" })
    ).json()) as { message: Message };
    const id = sent.message.id;
    expect(
      (
        await call(tenant, `/channels/general/messages/${id}/reactions`, token, "POST", {
          username: "a",
          kind: "done",
        })
      ).status,
    ).toBe(200);
    const deleted = await exports.default.fetch(
      `https://msn.test/api/admin/tenants/${tenant}/channels/general/messages/${id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN}` } },
    );
    expect(deleted.status).toBe(204);
    const listed = (await (await call(tenant, "/channels/general/reactions", token)).json()) as {
      reactions: unknown[];
    };
    expect(listed.reactions).toEqual([]);
    expect(
      (
        await call(tenant, `/channels/general/messages/${id}/reactions`, token, "POST", {
          username: "a",
          kind: "done",
        })
      ).status,
    ).toBe(410);
  });

  it("caps the names per kind on one message", async () => {
    const f = await fixture();
    const task = await f.send("popular");
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    await runInDurableObject(stub, (_instance, state) => {
      for (let i = 0; i < 100; i++)
        state.storage.sql.exec(
          "INSERT INTO reactions(channel, messageId, kind, name, createdAt) VALUES ('work', ?, 'seen', ?, ?)",
          task.id,
          `n${i}`,
          new Date().toISOString(),
        );
    });
    const over = await react(f, task.id, f.agent, "lead", "seen");
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: { code: "reaction_limit" } });
    expect((await react(f, task.id, f.agent, "lead", "done")).status).toBe(200);
  });

  it("caps reactions per workspace, frees a place on removal, and keeps the count across deletion", async () => {
    const f = await fixture();
    const task = await f.send("busy");
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    const count = () =>
      runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql.exec<{ reactions: number }>("SELECT reactions FROM usage").one().reactions,
      );
    await react(f, task.id, f.agent, "lead", "done");
    await react(f, task.id, f.agent, "lead", "done");
    await react(f, task.id, f.agent, "dev", "seen");
    expect(await count()).toBe(2);
    await react(f, task.id, f.agent, "dev", "seen", true);
    await react(f, task.id, f.agent, "dev", "seen", true);
    expect(await count()).toBe(1);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE usage SET reactions = 100000");
    });
    const full = await react(f, task.id, f.agent, "dev", "yes");
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: { code: "reaction_limit" } });
    // Removing one frees a place; re-adding an existing one is not blocked by the cap.
    expect((await react(f, task.id, f.agent, "lead", "done")).status).toBe(200);
    expect((await react(f, task.id, f.agent, "lead", "done", true)).status).toBe(200);
    expect((await react(f, task.id, f.agent, "dev", "yes")).status).toBe(200);
    expect(await count()).toBe(100000);
  });

  it("reserves the github name, as sends do", async () => {
    const f = await fixture();
    const task = await f.send("x");
    const tenant = `react-gh-${crypto.randomUUID()}`;
    const created = await exports.default.fetch(`https://msn.test/api/admin/tenants/${tenant}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    const { token } = (await created.json()) as { token: string };
    const sent = (await (
      await call(tenant, "/channels/general/messages", token, "POST", { username: "a", text: "hi" })
    ).json()) as { message: Message };
    const github = await call(
      tenant,
      `/channels/general/messages/${sent.message.id}/reactions`,
      token,
      "POST",
      {
        username: "github",
        kind: "done",
      },
    );
    expect(github.status).toBe(403);
    expect(await github.json()).toMatchObject({ error: { code: "reserved_name" } });
    expect((await react(f, task.id, f.agent, "github", "done")).status).toBe(403);
  });

  it("keeps reactions inside their board: other boards' ids are 404, other boards' keys are 403", async () => {
    const f = await fixture();
    expect((await call(f.tenant, "/channels/other", f.owner, "PUT")).status).toBe(201);
    const other = (await (
      await call(f.tenant, "/channels/other/messages", f.owner, "POST", {
        username: "human",
        text: "elsewhere",
      })
    ).json()) as { message: Message };
    // The id exists, but on another board.
    const wrongBoard = await call(
      f.tenant,
      `/channels/work/messages/${other.message.id}/reactions`,
      f.owner,
      "POST",
      {
        username: "human",
        kind: "done",
      },
    );
    expect(wrongBoard.status).toBe(404);
    // The work board's shared credential cannot reach the other board.
    const scoped = await call(
      f.tenant,
      `/channels/other/messages/${other.message.id}/reactions`,
      f.agent,
      "POST",
      {
        username: "lead",
        kind: "done",
      },
    );
    expect(scoped.status).toBe(403);
    expect((await call(f.tenant, "/channels/other/reactions", f.agent)).status).toBe(403);
  });

  it("search reads reactions only for its matches", async () => {
    const f = await fixture();
    const first = await f.send("needle one");
    for (let i = 0; i < 5; i++) await react(f, (await f.send(`hay ${i}`)).id, f.agent, "dev", "seen");
    const last = await f.send("needle two");
    await react(f, first.id, f.agent, "lead", "done");
    await react(f, last.id, f.agent, "dev", "no");
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    await runInDurableObject(stub, (instance: { backfillSearch?: (n: number) => unknown }) =>
      instance.backfillSearch?.(1000),
    );
    const found = (await (await call(f.tenant, "/channels/work/search?q=needle", f.agent)).json()) as {
      messages: Message[];
    };
    expect(found.messages.map((m) => [m.id, m.reactions])).toEqual([
      [last.id, { no: ["dev"] }],
      [first.id, { done: ["lead"] }],
    ]);
  });

  it("records schema v19 (now the latest, 20) and creates the reactions table", async () => {
    const f = await fixture();
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    const versions = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ version: number }>("SELECT version FROM schema_version ORDER BY version")
        .toArray()
        .map((row) => row.version),
    );
    expect(versions).toContain(19);
    expect(versions.at(-1)).toBe(20);
  });
});
