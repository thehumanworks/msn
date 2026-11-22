import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MsnDurableObject } from "../src/store";

// Delete a board (ADR 0080): the owner removes a board and everything on it, for good. Nothing
// that names the board stays, the keys and invitations held to it stop working, other boards are
// untouched, and a board made later under the same name starts empty.

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}
type Init = { method?: string; json?: unknown; body?: BodyInit; type?: string };
const call = (path: string, token: string | undefined, init: Init = {}) =>
  exports.default.fetch(`https://msn.test${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(init.type ? { "Content-Type": init.type } : {}),
    },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
type Access = { tenant: string; token: string };
type Message = { id: number; text: string };
type ErrorBody = { error: { code: string; message: string } };
const code = async (response: Response) => (await response.json<ErrorBody>()).error.code;

const SHARED = "b".repeat(64);
const KEPT = "d".repeat(64);

/**
 * An owner with two boards. `doomed` holds one of everything a board can hold; `kept` holds a
 * message, and a persona whose workspace webhook has a notice waiting about a `doomed` message.
 */
async function fixture() {
  const tenant = `delete-${crypto.randomUUID()}`;
  const api = `/api/tenants/${tenant}`;
  const owner = (
    await (await call(api, undefined, { method: "PUT", json: { username: "human" } })).json<Access>()
  ).token;
  const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant]));
  // Every receiver is down, so notices stay waiting instead of leaving the test's network.
  await runInDurableObject(stub, (instance: MsnDurableObject) => {
    instance.webhookFetch = async () => new Response(null, { status: 503 });
  });
  const ok = async (response: Response | Promise<Response>, what: string) => {
    const got = await response;
    expect(got.status, `${what}: ${got.status < 300 ? "" : await got.clone().text()}`).toBeLessThan(300);
    return got;
  };
  const post = (board: string, token: string, json: unknown) =>
    ok(call(`${api}/channels/${board}/messages`, token, { method: "POST", json }), `send on ${board}`);

  for (const [board, credential] of [
    ["doomed", SHARED],
    ["kept", KEPT],
  ])
    await ok(
      call(`${api}/channels/${board}/board`, owner, { method: "PUT", json: { credential, goal: "Ship it" } }),
      `board ${board}`,
    );
  await ok(
    call(`${api}/channels/doomed/personas/lead`, SHARED, { method: "PUT", json: { displayName: "lead" } }),
    "persona lead",
  );
  await ok(
    call(`${api}/channels/kept/personas/watcher`, KEPT, { method: "PUT", json: { displayName: "watcher" } }),
    "persona watcher",
  );
  // Webhooks first, so the messages below queue notices: one on the doomed board's own webhook,
  // one on the kept board's workspace webhook.
  await ok(
    call(`${api}/channels/doomed/personas/lead/webhook`, owner, {
      method: "PUT",
      json: { url: "https://agent.example.com/lead", subscribe: "board" },
    }),
    "webhook lead",
  );
  await ok(
    call(`${api}/channels/kept/personas/watcher/webhook`, owner, {
      method: "PUT",
      json: { url: "https://agent.example.com/watcher", subscribe: "workspace" },
    }),
    "webhook watcher",
  );

  const file = await (
    await ok(
      call(`${api}/channels/doomed/attachments`, owner, {
        method: "POST",
        type: "application/octet-stream",
        body: "build log",
      }),
      "attachment",
    )
  ).json<{ attachment: { id: string } }>();
  const first = (
    await (
      await post("doomed", owner, {
        username: "human",
        text: "Zanzibar release shipped",
        to: "watcher",
        attachments: [{ id: file.attachment.id, name: "build.log" }],
      })
    ).json<{ message: Message }>()
  ).message;
  await post("doomed", SHARED, { username: "lead", text: "On it" });
  const message = `${api}/channels/doomed/messages/${first.id}`;
  await ok(call(`${api}/channels/doomed/pins/${first.id}`, owner, { method: "PUT" }), "pin");
  await ok(
    call(`${message}/reactions`, SHARED, { method: "POST", json: { username: "lead", kind: "done" } }),
    "reaction",
  );
  await ok(call(`${message}/labels`, owner, { method: "POST", json: { set: { state: "done" } } }), "label");
  await ok(
    call(`${api}/channels/doomed/brief`, owner, {
      method: "PUT",
      json: { text: "Be brief.", baseVersion: 0 },
    }),
    "brief",
  );
  await ok(
    call(`${api}/channels/doomed/status`, SHARED, {
      method: "PUT",
      json: { username: "lead", text: "shipping" },
    }),
    "status",
  );
  await ok(call(`${api}/push/mutes/doomed`, owner, { method: "PUT", json: {} }), "mute");
  await ok(
    call(`${api}/channels/doomed/messages`, owner, {
      method: "POST",
      json: { username: "human", text: "later", sendAt: new Date(Date.now() + 3600_000).toISOString() },
    }),
    "scheduled message",
  );
  // An invited member of the doomed board, and an invitation to it that nobody used yet.
  const invite = () =>
    call(`${api}/invites`, owner, { method: "POST", json: { channel: "doomed" } }).then((made) =>
      made.json<{ code: string }>(),
    );
  const member = (
    await (
      await ok(
        call(`${api}/invites/redeem`, undefined, {
          method: "POST",
          json: { code: (await invite()).code, username: "guest" },
        }),
        "redeem",
      )
    ).json<Access>()
  ).token;
  const unused = (await invite()).code;

  const keptMessage = (
    await (
      await post("kept", owner, { username: "human", text: "Zanzibar is still on the kept board" })
    ).json<{ message: Message }>()
  ).message;
  return { tenant, api, owner, stub, first, member, unused, keptMessage };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** `token` null sends no key at all; left out, the owner's. */
const remove = (f: Fixture, token: string | null = f.owner, query = "?confirm=doomed", board = "doomed") =>
  call(`${f.api}/channels/${board}${query}`, token ?? undefined, { method: "DELETE" });
const usage = (f: Fixture) =>
  runInDurableObject(f.stub, (_: MsnDurableObject, state) =>
    state.storage.sql
      .exec<{ messages: number; bytes: number; reactions: number }>(
        "SELECT messages, bytes, reactions FROM usage",
      )
      .one(),
  );

/**
 * Every place in the live schema where a value is exactly the board's name: `table.column` and
 * how many rows. Reads the schema itself, so a table added later is covered without a change here.
 */
const mentions = (f: Fixture, name: string) =>
  runInDurableObject(f.stub, (_: MsnDurableObject, state) => {
    const sql = state.storage.sql;
    const found: Record<string, number> = {};
    const tables = sql
      .exec<{ name: string }>(
        // The search index and SQLite's and the platform's own tables hold no board names.
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'message_search%'",
      )
      .toArray();
    for (const table of tables)
      for (const column of sql.exec<{ name: string }>(`PRAGMA table_info(${table.name})`).toArray()) {
        const n = sql
          .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table.name} WHERE "${column.name}" = ?`, name)
          .one().n;
        if (n) found[`${table.name}.${column.name}`] = n;
      }
    const inNotices = sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM webhook_notices WHERE json_extract(body, '$.channel') = ?",
        name,
      )
      .one().n;
    if (inNotices) found["webhook_notices.body"] = inNotices;
    return found;
  });

describe("delete a board (ADR 0080)", () => {
  it("is the owner's alone, and needs the board's name repeated", async () => {
    const f = await fixture();
    expect((await remove(f, null)).status).toBe(401);
    expect((await remove(f, "z".repeat(64))).status).toBe(401);
    for (const token of [SHARED, f.member]) {
      const refused = await remove(f, token);
      expect(refused.status).toBe(403);
      expect(await code(refused)).toBe("owner_required");
    }
    // A key held to another board cannot even name this one.
    const other = await remove(f, KEPT);
    expect(other.status).toBe(403);
    expect(await code(other)).toBe("channel_forbidden");

    for (const query of ["", "?confirm=", "?confirm=kept", "?confirm=DOOMED", "?confirm=true"]) {
      const unconfirmed = await remove(f, f.owner, query);
      expect(unconfirmed.status, query).toBe(400);
      expect(await code(unconfirmed)).toBe("confirm_required");
    }
    const missing = await remove(f, f.owner, "?confirm=nope", "nope");
    expect(missing.status).toBe(404);
    expect(await code(missing)).toBe("channel_not_found");
    // Nothing above changed anything.
    expect((await call(`${f.api}/channels/doomed/messages/${f.first.id}`, f.owner)).status).toBe(200);
    expect(Object.keys(await mentions(f, "doomed")).length).toBeGreaterThan(15);
  });

  it("removes everything that names the board, and nothing else", async () => {
    const f = await fixture();
    const before = await usage(f);
    const keptBefore = await mentions(f, "kept");
    // The fixture really did fill the tables this test is about.
    const filled = await mentions(f, "doomed");
    for (const place of [
      "messages.channel",
      "attachments.channel",
      "message_attachments.channel",
      "pins.channel",
      "reactions.channel",
      "message_labels.channel",
      "board_briefs.channel",
      "agent_status.channel",
      "push_mutes.channel",
      "scheduled_messages.channel",
      "personas.channel",
      "boards.channel",
      "channel_credentials.channel",
      "webhooks.channel",
      "webhook_notices.channel",
      "webhook_notices.body",
      "events.channel",
      "invites.channel",
      "access_keys.channel_scope",
      "channels.name",
    ])
      expect(filled[place], place).toBeGreaterThan(0);

    const gone = await remove(f);
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual({ channel: "doomed", deleted: true });

    expect(await mentions(f, "doomed")).toEqual({});
    // The other board keeps every row, except its workspace webhook's two notices about the
    // deleted board's messages (one addressed to its persona, one for the rest). The notice
    // about its own board still waits.
    expect(keptBefore["webhook_notices.channel"]).toBe(3);
    expect(await mentions(f, "kept")).toEqual({ ...keptBefore, "webhook_notices.channel": 1 });

    const after = await usage(f);
    // Storage and live reactions are given back; the lifetime message count is not.
    expect(after.bytes).toBeLessThan(before.bytes);
    expect(after.bytes).toBeGreaterThan(0);
    expect(after.reactions).toBe(before.reactions - 1);
    expect(after.messages).toBe(before.messages);
    const live = await runInDurableObject(
      f.stub,
      (_: MsnDurableObject, state) =>
        state.storage.sql
          .exec<{ bytes: number }>(
            `SELECT (SELECT COALESCE(SUM(bytes), 0) FROM messages) + (SELECT COALESCE(SUM(bytes), 0) FROM attachments)
             + (SELECT COALESCE(SUM(bytes), 0) FROM snapshots) + (SELECT COALESCE(SUM(bytes), 0) FROM board_briefs) AS bytes`,
          )
          .one().bytes,
    );
    expect(after.bytes).toBe(live);

    // Rows that point at a message by id rather than by board name: none may outlive its message.
    const orphans = await runInDurableObject(f.stub, (_: MsnDurableObject, state) => {
      const sql = state.storage.sql;
      const found: Record<string, number> = {};
      const count = (query: string) => sql.exec<{ n: number }>(query).one().n;
      for (const table of sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'message_search%'",
        )
        .toArray())
        if (
          sql
            .exec<{ name: string }>(`PRAGMA table_info(${table.name})`)
            .toArray()
            .some((column) => column.name === "messageId")
        )
          found[table.name] = count(
            `SELECT COUNT(*) AS n FROM ${table.name} WHERE messageId NOT IN (SELECT id FROM messages)`,
          );
      found.message_search = count(
        "SELECT COUNT(*) AS n FROM message_search WHERE rowid NOT IN (SELECT id FROM messages)",
      );
      found.replies = count(
        "SELECT COUNT(*) AS n FROM messages WHERE replyTo IS NOT NULL AND replyTo NOT IN (SELECT id FROM messages)",
      );
      return found;
    });
    expect(Object.keys(orphans).length).toBeGreaterThan(4);
    for (const [table, n] of Object.entries(orphans)) expect(n, table).toBe(0);
  });

  it("never reuses a message or event number, even when the deleted board held the newest", async () => {
    const f = await fixture();
    // The newest message and the newest events are the doomed board's.
    const last = (
      await (
        await call(`${f.api}/channels/doomed/messages`, f.owner, {
          method: "POST",
          json: { username: "human", text: "the newest message" },
        })
      ).json<{ message: Message }>()
    ).message;
    const head = async () =>
      (await (await call(`${f.api}/events/head`, f.owner)).json<{ head: number }>()).head;
    const before = await head();
    expect((await remove(f)).status).toBe(200);
    // The head falls back to the newest event that is left; the numbers above it stay spent.
    expect(await head()).toBeLessThan(before);

    const next = (
      await (
        await call(`${f.api}/channels/kept/messages`, f.owner, {
          method: "POST",
          json: { username: "human", text: "after the delete" },
        })
      ).json<{ message: Message }>()
    ).message;
    expect(next.id).toBeGreaterThan(last.id);
    // A client that had read up to the old head still gets the new event, numbered above it.
    const page = await (await call(`${f.api}/events?after=${before}`, f.owner)).json<{
      events: Array<{ id: number; channel: string }>;
    }>();
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.every((event) => event.id > before && event.channel === "kept")).toBe(true);
  });

  it("leaves the board unreadable, unlisted and unsearchable, and the other board working", async () => {
    const f = await fixture();
    const search = async () =>
      (
        await (
          await call(`${f.api}/search?q=zanzibar`, f.owner)
        ).json<{
          messages: Array<{ id: number; channel: string }>;
        }>()
      ).messages.map((found) => found.channel);
    expect((await search()).sort()).toEqual(["doomed", "kept"]);
    expect((await remove(f)).status).toBe(200);

    for (const path of ["messages", `messages/${f.first.id}`, "board", "personas", "webhooks", "pins"]) {
      const read = await call(`${f.api}/channels/doomed/${path}`, f.owner);
      expect(read.status, path).toBe(404);
    }
    const listed = await (await call(`${f.api}/channels?include=archived`, f.owner)).json<{
      channels: Array<{ name: string }>;
    }>();
    // `general` is the board every new workspace starts with.
    expect(listed.channels.map((channel) => channel.name)).toEqual(["general", "kept"]);
    expect(await search()).toEqual(["kept"]);
    const events = await (await call(`${f.api}/events?after=0`, f.owner)).json<{
      events: Array<{ channel: string }>;
    }>();
    expect(events.events.length).toBeGreaterThan(0);
    expect(events.events.some((event) => event.channel === "kept")).toBe(true);
    expect(events.events.some((event) => event.channel === "doomed")).toBe(false);

    expect((await call(`${f.api}/channels/kept/messages/${f.keptMessage.id}`, f.owner)).status).toBe(200);
    const sent = await call(`${f.api}/channels/kept/messages`, KEPT, {
      method: "POST",
      json: { username: "watcher", text: "still here" },
    });
    expect(sent.status).toBe(201);
    // Deleting again finds nothing: the board is gone, not hidden.
    expect((await remove(f)).status).toBe(404);
  });

  it("ends the access that was held to the board", async () => {
    const f = await fixture();
    expect((await call(`${f.api}/channels/doomed/messages`, SHARED)).status).toBe(200);
    expect((await call(`${f.api}/channels/doomed/messages`, f.member)).status).toBe(200);
    expect((await remove(f)).status).toBe(200);

    for (const token of [SHARED, f.member]) expect((await call(f.api, token)).status).toBe(401);
    const redeem = await call(`${f.api}/invites/redeem`, undefined, {
      method: "POST",
      json: { code: f.unused, username: "late" },
    });
    expect(redeem.status).toBe(410);
    // The owner and the other board's key are untouched.
    expect((await call(f.api, f.owner)).status).toBe(200);
    expect((await call(f.api, KEPT)).status).toBe(200);
  });

  it("starts a later board of the same name empty, without the old key", async () => {
    const f = await fixture();
    expect((await remove(f)).status).toBe(200);
    const fresh = "e".repeat(64);
    const made = await call(`${f.api}/channels/doomed/board`, f.owner, {
      method: "PUT",
      json: { credential: fresh, goal: "Start over" },
    });
    expect(made.status).toBe(201);
    expect((await call(f.api, SHARED)).status).toBe(401);
    expect((await call(f.api, f.member)).status).toBe(401);
    const page = await (await call(`${f.api}/channels/doomed/messages`, fresh)).json<{
      messages: Message[];
    }>();
    expect(page.messages).toEqual([]);
    const roster = await (await call(`${f.api}/channels/doomed/personas`, fresh)).json<{
      personas: unknown[];
    }>();
    expect(roster.personas).toEqual([]);
    expect((await call(`${f.api}/channels/doomed/brief`, f.owner)).status).toBeLessThan(500);
    const hooks = await (await call(`${f.api}/channels/doomed/webhooks`, f.owner)).json<{
      webhooks: unknown[];
    }>();
    expect(hooks.webhooks).toEqual([]);
    // Message ids are never reused, so an old link cannot land on a new message.
    const next = await (
      await call(`${f.api}/channels/doomed/messages`, f.owner, {
        method: "POST",
        json: { username: "human", text: "first again" },
      })
    ).json<{ message: Message }>();
    expect(next.message.id).toBeGreaterThan(f.keptMessage.id);
  });

  it("deletes an archived board too, and answers pending polls instead of leaving them open", async () => {
    const f = await fixture();
    expect((await call(`${f.api}/channels/doomed/archive`, f.owner, { method: "PUT" })).status).toBe(200);
    // Every other write on an archived board is refused; deleting it is the exception.
    const refused = await call(`${f.api}/channels/doomed/messages`, f.owner, {
      method: "POST",
      json: { username: "human", text: "no" },
    });
    expect(await code(refused)).toBe("board_archived");
    const last = f.first.id + 10;
    const waiting = call(`${f.api}/channels/doomed/messages?after=${last}&wait=20`, f.owner);
    const listening = call(`${f.api}/events?after=1000&wait=20`, SHARED);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    expect((await remove(f)).status).toBe(200);
    expect((await waiting).status).toBe(200);
    expect((await listening).status).toBeLessThan(500);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await mentions(f, "doomed")).toEqual({});
  });

  it("leaves the alarm nothing to do for a deleted board", async () => {
    const f = await fixture();
    const work = () =>
      runInDurableObject(f.stub, async (_: MsnDurableObject, state) => ({
        alarm: await state.storage.getAlarm(),
        notices: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_notices").one().n,
        scheduled: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM scheduled_messages").one()
          .n,
      }));
    expect(await work()).toMatchObject({ notices: 4, scheduled: 1 });
    expect((await remove(f)).status).toBe(200);
    expect(await work()).toMatchObject({ notices: 1, scheduled: 0 });
    expect((await remove(f, f.owner, "?confirm=kept", "kept")).status).toBe(200);
    const left = await work();
    expect(left).toMatchObject({ notices: 0, scheduled: 0 });
    // With no scheduled message and no notice left, only a search backfill (which is due at
    // once and independent of boards) may still hold the alarm: never a time in the future.
    if (left.alarm !== null) expect(left.alarm).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
