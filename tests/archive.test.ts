import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Archived boards (ADR 0046): the owner archives a finished board. It leaves the default list,
// refuses every write with 409 board_archived, stays readable, and unarchive restores it.

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}
type Init = {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  type?: string;
  headers?: Record<string, string>;
};
const call = (path: string, token: string | undefined, init: Init = {}) =>
  exports.default.fetch(`https://msn.test${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(init.type ? { "Content-Type": init.type } : {}),
      ...init.headers,
    },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
type Access = { tenant: string; token: string };
type Message = { id: number; text: string };
type Channel = { name: string; archivedAt?: string };

/** An owner with boards `work` (one message, a file and a pin) and `next`. */
async function fixture() {
  const tenant = `archive-${crypto.randomUUID()}`;
  const api = `/api/tenants/${tenant}`;
  const owner = (
    await (await call(api, undefined, { method: "PUT", json: { username: "human" } })).json<Access>()
  ).token;
  const shared = "b".repeat(64);
  for (const [channel, credential] of [
    ["work", shared],
    ["next", "d".repeat(64)],
  ])
    expect(
      (
        await call(`${api}/channels/${channel}/board`, owner, {
          method: "PUT",
          json: { credential, goal: "Ship the release" },
        })
      ).status,
    ).toBe(201);
  expect(
    (
      await call(`${api}/channels/work/personas/lead`, shared, {
        method: "PUT",
        json: { displayName: "lead" },
      })
    ).status,
  ).toBe(201);
  const file = await (
    await call(`${api}/channels/work/attachments`, owner, {
      method: "POST",
      type: "application/octet-stream",
      body: "build log",
    })
  ).json<{ attachment: { id: string } }>();
  const first = (
    await (
      await call(`${api}/channels/work/messages`, shared, {
        method: "POST",
        json: {
          username: "lead",
          text: "Release shipped",
          attachments: [{ id: file.attachment.id, name: "build.log" }],
        },
      })
    ).json<{ message: Message }>()
  ).message;
  expect((await call(`${api}/channels/work/pins/${first.id}`, owner, { method: "PUT" })).status).toBeLessThan(
    300,
  );
  return { tenant, api, owner, shared, first };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const archive = (f: Fixture, token = f.owner, method = "PUT") =>
  call(`${f.api}/channels/work/archive`, token, { method });
const names = async (f: Fixture, query = "") =>
  (await (await call(`${f.api}/channels${query}`, f.owner)).json<{ channels: Channel[] }>()).channels;

const counts = (f: Fixture) =>
  runInDurableObject(env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant])), (_, state) =>
    Object.fromEntries(
      [
        "messages",
        "channels",
        "snapshots",
        "invites",
        "access_keys",
        "personas",
        "message_labels",
        "attachments",
        "processing_cursors",
        "github_links",
        "boards",
        "pins",
        "events",
      ].map((table) => [
        table,
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n,
      ]),
    ),
  );

describe("archived boards", () => {
  it("lets only the owner archive, idempotently, and reports it on the board", async () => {
    const f = await fixture();
    for (const token of [f.shared]) {
      const refused = await archive(f, token);
      expect(refused.status).toBe(403);
      expect((await refused.json<{ error: { code: string } }>()).error.code).toBe("owner_required");
    }
    expect((await archive(f, "z".repeat(64))).status).toBe(401);
    const first = await archive(f);
    expect(first.status).toBe(200);
    const archived = await first.json<{ archived: boolean; archivedAt: string }>();
    expect(archived).toMatchObject({ channel: "work", archived: true });
    const again = await (await archive(f)).json<{ archivedAt: string }>();
    expect(again.archivedAt).toBe(archived.archivedAt);
    const board = await (await call(`${f.api}/channels/work/board`, f.shared)).json<{
      board: { archivedAt?: string; goal: string };
    }>();
    expect(board.board).toMatchObject({ goal: "Ship the release", archivedAt: archived.archivedAt });
    expect((await call(`${f.api}/channels/missing/archive`, f.owner, { method: "PUT" })).status).toBe(404);
  });

  it("leaves the default board list and comes back with include=archived", async () => {
    const f = await fixture();
    await archive(f);
    expect((await names(f)).map((c) => c.name)).toEqual(["general", "next"]);
    const all = await names(f, "?include=archived");
    expect(all.map((c) => c.name)).toEqual(["general", "next", "work"]);
    expect(all.find((c) => c.name === "work")?.archivedAt).toBeTruthy();
    expect("archivedAt" in (all.find((c) => c.name === "next") ?? {})).toBe(false);
    expect((await call(`${f.api}/channels?include=everything`, f.owner)).status).toBe(400);
  });

  it("stays readable, searchable and exportable", async () => {
    const f = await fixture();
    await archive(f);
    for (const token of [f.owner, f.shared]) {
      const read = async (path: string) => {
        const response = await call(`${f.api}${path}`, token);
        expect(response.status, path).toBe(200);
        return response;
      };
      const history = await (await read("/channels/work/messages")).json<{
        messages: Message[];
        archived?: boolean;
      }>();
      expect(history.messages.map((m) => m.text)).toEqual(["Release shipped"]);
      expect(history.archived).toBe(true);
      expect(await (await read(`/channels/work/messages/${f.first.id}/attachments/0`)).text()).toBe(
        "build log",
      );
      const found = await (await read("/channels/work/search?q=shipped")).json<{ results?: unknown[] }>();
      expect(JSON.stringify(found)).toContain("Release shipped");
      for (const path of [
        `/channels/work/messages/${f.first.id}`,
        "/channels/work/catchup",
        "/channels/work/snapshots",
        "/channels/work/pins",
        "/channels/work/personas",
        "/channels/work/receipts",
        "/events?channel=work",
      ])
        await read(path);
    }
    // Active boards carry no archived field.
    const active = await (await call(`${f.api}/channels/next/messages`, f.owner)).json<object>();
    expect("archived" in active).toBe(false);
  });

  it("refuses every write route with 409 board_archived and changes nothing", async () => {
    const f = await fixture();
    const message = `/channels/work/messages/${f.first.id}`;
    const routes: { name: string; method: string; path: string; token?: string; init?: Init }[] = [
      {
        name: "send",
        method: "POST",
        path: "/channels/work/messages",
        token: f.shared,
        init: { json: { username: "lead", text: "One more thing" } },
      },
      {
        name: "owner send",
        method: "POST",
        path: "/channels/work/messages",
        init: { json: { username: "human", text: "One more thing" } },
      },
      {
        name: "snapshot",
        method: "POST",
        path: "/channels/work/snapshots",
        init: {
          headers: { "Idempotency-Key": "snap-1" },
          json: {
            username: "human",
            text: "Sum",
            coversThrough: f.first.id,
            baseVersion: 0,
            historyRevision: 0,
          },
        },
      },
      {
        name: "label",
        method: "POST",
        path: `${message}/labels`,
        init: { json: { set: { state: "done" } } },
      },
      {
        name: "attachment",
        method: "POST",
        path: "/channels/work/attachments",
        init: { type: "application/octet-stream", body: "more" },
      },
      { name: "pin", method: "DELETE", path: `/channels/work/pins/${f.first.id}` },
      {
        name: "processing claim",
        method: "POST",
        path: "/channels/work/processing/lead/claim",
        token: f.shared,
        init: { json: { expectGeneration: 0 } },
      },
      {
        name: "processing commit",
        method: "POST",
        path: "/channels/work/processing/lead/commit",
        token: f.shared,
        init: { json: { generation: 1, through: f.first.id } },
      },
      { name: "invite", method: "POST", path: "/invites", init: { json: { channel: "work" } } },
      {
        name: "persona",
        method: "PUT",
        path: "/channels/work/personas/late",
        token: f.shared,
        init: { json: { displayName: "late" } },
      },
      {
        name: "board update",
        method: "POST",
        path: "/channels/work/board",
        init: { json: { revision: 1, status: "complete" } },
      },
      {
        name: "board rotate",
        method: "POST",
        path: "/channels/work/board/rotate",
        init: { json: { credential: "c".repeat(64) } },
      },
      { name: "follow pull request", method: "PUT", path: "/channels/work/github/pulls/acme/app/7" },
      { name: "create channel", method: "PUT", path: "/channels/work" },
    ];
    await archive(f);
    const before = await counts(f);
    for (const route of routes) {
      const response = await call(`${f.api}${route.path}`, route.token ?? f.owner, {
        ...route.init,
        method: route.method,
      });
      expect(response.status, route.name).toBe(409);
      const error = (await response.json<{ error: { code: string; message: string } }>()).error;
      expect(error.code, route.name).toBe("board_archived");
      expect(error.message).toContain("msn board unarchive work");
    }
    expect(await counts(f)).toEqual(before);
    // Other boards are untouched.
    expect(
      (
        await call(`${f.api}/channels/next/messages`, f.owner, {
          method: "POST",
          json: { username: "human", text: "hi" },
        })
      ).status,
    ).toBe(201);

    // Control: after unarchive each request succeeds, so the 409 came from the archive alone.
    expect((await archive(f, f.owner, "DELETE")).status).toBe(200);
    expect(await names(f)).toHaveLength(3);
    for (const route of routes) {
      const response = await call(`${f.api}${route.path}`, route.token ?? f.owner, {
        ...route.init,
        method: route.method,
      });
      expect(response.status, `after unarchive: ${route.name}`).toBeLessThan(300);
    }
  });

  it("refuses a stranger before saying the board is archived", async () => {
    const f = await fixture();
    await archive(f);
    const response = await call(`${f.api}/channels/work/messages`, "z".repeat(64), {
      method: "POST",
      json: { username: "x", text: "y" },
    });
    expect(response.status).toBe(401);
  });

  it("holds an existing invitation until the board is unarchived", async () => {
    const f = await fixture();
    const invite = await (
      await call(`${f.api}/invites`, f.owner, { method: "POST", json: { channel: "work", watch: true } })
    ).json<{ code: string }>();
    await archive(f);
    const redeem = () =>
      call(`${f.api}/invites/redeem`, undefined, {
        method: "POST",
        json: { code: invite.code, username: "w" },
      });
    const refused = await redeem();
    expect(refused.status).toBe(409);
    expect((await refused.json<{ error: { code: string } }>()).error.code).toBe("board_archived");
    await archive(f, f.owner, "DELETE");
    expect((await redeem()).status).toBe(201);
  });

  it("ends pending long polls with archived: true", async () => {
    const f = await fixture();
    const started = Date.now();
    const poll = call(`${f.api}/channels/work/messages?after=${f.first.id}&wait=20`, f.shared);
    const events = await (await call(`${f.api}/events?channel=work`, f.shared)).json<{
      nextCursor: number;
    }>();
    const eventPoll = call(`${f.api}/events?channel=work&after=${events.nextCursor}&wait=20`, f.shared);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await archive(f);
    const page = await (await poll).json<{ messages: Message[]; archived?: boolean }>();
    expect(page).toMatchObject({ messages: [], archived: true });
    const journal = await (await eventPoll).json<{ events: unknown[]; archived?: boolean }>();
    expect(journal).toMatchObject({ events: [], archived: true });
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it("stays archived after the workspace restarts", async () => {
    const f = await fixture();
    await archive(f);
    await abortAllDurableObjects();
    const send = await call(`${f.api}/channels/work/messages`, f.shared, {
      method: "POST",
      json: { username: "lead", text: "after restart" },
    });
    expect(send.status).toBe(409);
    await runInDurableObject(
      env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant])),
      (_, state) => {
        expect(
          state.storage.sql.exec("SELECT archivedAt FROM channels WHERE name = 'work'").one().archivedAt,
        ).toBeTruthy();
      },
    );
  });
});
