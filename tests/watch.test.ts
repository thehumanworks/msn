import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Watch-only invitations (ADR 0039): the redeemed key reads a board live, and every write is
// refused with 403 watch_only before any route runs.

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}
const ADMIN = "test-admin-secret-000000000000000000000";
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
type Access = { tenant: string; token: string; username: string; channel?: string; watchOnly?: boolean };
type Message = { id: number; text: string; attachments?: { index: number }[] };

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
async function subscription() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
    keys: { p256dh: base64url(raw), auth: base64url(crypto.getRandomValues(new Uint8Array(16))) },
  };
}

/** An owner with a board `work` holding one message with a file, a snapshot and a persona. */
async function fixture() {
  const tenant = `watch-${crypto.randomUUID()}`;
  const api = `/api/tenants/${tenant}`;
  const owner = await (
    await call(api, undefined, { method: "PUT", json: { username: "human" } })
  ).json<Access>();
  const shared = "b".repeat(64);
  expect(
    (
      await call(`${api}/channels/work/board`, owner.token, {
        method: "PUT",
        json: { credential: shared, goal: "Ship the release" },
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
    await call(`${api}/channels/work/attachments`, owner.token, {
      method: "POST",
      type: "application/octet-stream",
      body: "build log",
    })
  ).json<{ attachment: { id: string } }>();
  const first = await (
    await call(`${api}/channels/work/messages`, shared, {
      method: "POST",
      json: {
        username: "lead",
        text: "Started",
        attachments: [{ id: file.attachment.id, name: "build.log" }],
      },
    })
  ).json<{ message: Message }>();
  expect(
    (
      await call(`${api}/channels/work/snapshots`, owner.token, {
        method: "POST",
        headers: { "Idempotency-Key": "snap-1" },
        json: {
          username: "human",
          text: "Summary",
          coversThrough: first.message.id,
          baseVersion: 0,
          historyRevision: 0,
        },
      })
    ).status,
  ).toBe(201);
  const invite = await call(`${api}/invites`, owner.token, {
    method: "POST",
    json: { channel: "work", watch: true },
  });
  expect(invite.status).toBe(201);
  const link = await invite.json<{ code: string; watch?: boolean }>();
  expect(link.watch).toBe(true);
  const redeemed = await call(`${api}/invites/redeem`, undefined, {
    method: "POST",
    json: { code: link.code, username: "watcher" },
  });
  expect(redeemed.status).toBe(201);
  const watcher = await redeemed.json<Access>();
  return {
    tenant,
    api,
    owner: owner.token,
    shared,
    watcher: watcher.token,
    identity: watcher,
    first: first.message,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

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
        "push_subscriptions",
        "github_hook",
        "github_links",
        "boards",
        "persona_presence",
      ].map((table) => [
        table,
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n,
      ]),
    ),
  );

describe("watch-only invitations", () => {
  it("issues a channel-scoped key that says it is watch-only", async () => {
    const f = await fixture();
    expect(f.identity).toMatchObject({ channel: "work", username: "watcher", watchOnly: true });
    const identity = await (await call(f.api, f.watcher)).json<Access>();
    expect(identity).toMatchObject({ channel: "work", watchOnly: true });
    expect("owner" in identity || "sharedChannel" in identity).toBe(false);
    const keys = await (await call(`/api/admin/tenants/${f.tenant}/keys`, ADMIN)).json<{
      keys: { username: string; watchOnly?: boolean }[];
    }>();
    expect(keys.keys.find((key) => key.username === "watcher")?.watchOnly).toBe(true);
    // Ordinary invitations and their keys are unchanged.
    const plain = await (
      await call(`${f.api}/invites`, f.owner, { method: "POST", json: { channel: "work" } })
    ).json<{ code: string; watch?: boolean }>();
    expect("watch" in plain).toBe(false);
    const member = await (
      await call(`${f.api}/invites/redeem`, undefined, {
        method: "POST",
        json: { code: plain.code, username: "member" },
      })
    ).json<Access>();
    expect("watchOnly" in member).toBe(false);
    expect(
      (
        await call(`${f.api}/channels/work/messages`, member.token, {
          method: "POST",
          json: { username: "member", text: "hi" },
        })
      ).status,
    ).toBe(201);
  });

  it("rejects a watch flag that is not a boolean", async () => {
    const f = await fixture();
    const response = await call(`${f.api}/invites`, f.owner, {
      method: "POST",
      json: { channel: "work", watch: "yes" },
    });
    expect(response.status).toBe(400);
  });

  it("reads history, the live poll, events, files, snapshots and the board", async () => {
    const f = await fixture();
    const read = async (path: string) => {
      const response = await call(`${f.api}${path}`, f.watcher);
      expect(response.status, path).toBe(200);
      return response;
    };
    const history = await (await read("/channels/work/messages")).json<{ messages: Message[] }>();
    expect(history.messages.map((m) => m.text)).toContain("Started");
    expect((await read(`/channels/work/messages/${f.first.id}`)).status).toBe(200);
    expect(await (await read(`/channels/work/messages/${f.first.id}/attachments/0`)).text()).toBe(
      "build log",
    );
    expect((await read("/channels/work/catchup")).status).toBe(200);
    expect((await read("/channels/work/snapshots")).status).toBe(200);
    expect((await read("/channels/work/snapshots/1")).status).toBe(200);
    expect((await read("/channels/work/board")).status).toBe(200);
    expect((await read("/channels/work/personas")).status).toBe(200);
    expect((await read("/channels/work/processing/lead")).status).toBe(200);
    expect((await read("/channels")).status).toBe(200);
    expect((await read("/channels/work/search?q=Started")).status).toBe(200);
    expect((await read("/events")).status).toBe(200);

    // Live: a long poll and an event poll wake on a new message.
    const after = f.first.id;
    const poll = call(`${f.api}/channels/work/messages?after=${after}&wait=10`, f.watcher);
    const eventCursor = await (await call(`${f.api}/events?limit=100`, f.watcher)).json<{
      nextCursor: number;
    }>();
    const eventPoll = call(`${f.api}/events?after=${eventCursor.nextCursor}&wait=10`, f.watcher);
    await call(`${f.api}/channels/work/messages`, f.shared, {
      method: "POST",
      json: { username: "lead", text: "Done" },
    });
    const woken = await (await poll).json<{ messages: Message[] }>();
    expect(woken.messages.map((m) => m.text)).toEqual(["Done"]);
    const journal = await (await eventPoll).json<{ events: { type: string }[] }>();
    expect(journal.events.map((e) => e.type)).toContain("message.created");
  });

  it("cannot see the board's shared agent credential or report listening", async () => {
    const f = await fixture();
    expect((await call(`${f.api}/channels/work/board/connection`, f.watcher)).status).toBe(403);
    expect((await call(`${f.api}/events?listener=lead`, f.watcher)).status).toBe(400);
    expect((await call(`${f.api}/push`, f.watcher)).status).toBe(403);
    expect((await call(`${f.api}/github`, f.watcher)).status).toBe(403);
    expect((await call(`${f.api}/channels/other/messages`, f.watcher)).status).toBe(403);
  });

  it("refuses every write route on the router with 403 watch_only and changes nothing", async () => {
    const f = await fixture();
    const invite = await (
      await call(`${f.api}/invites`, f.owner, { method: "POST", json: { channel: "work" } })
    ).json<{ id: string }>();
    const message = `/channels/work/messages/${f.first.id}`;
    // Every non-GET route the workspace router serves to an access key, in router order.
    // Each body is valid: the owner control below proves the request would otherwise succeed.
    const routes: { name: string; method: string; path: string; init?: Init }[] = [
      { name: "create invitation", method: "POST", path: "/invites", init: { json: { channel: "work" } } },
      {
        name: "create watch invitation",
        method: "POST",
        path: "/invites",
        init: { json: { channel: "work", watch: true } },
      },
      { name: "revoke invitation", method: "DELETE", path: `/invites/${invite.id}` },
      {
        name: "register persona",
        method: "PUT",
        path: "/channels/work/personas/spy",
        init: { json: { displayName: "spy" } },
      },
      {
        name: "update board",
        method: "POST",
        path: "/channels/work/board",
        init: { json: { revision: 1, status: "blocked" } },
      },
      {
        name: "create board",
        method: "PUT",
        path: "/channels/work/board",
        init: { json: { credential: f.shared, goal: "x" } },
      },
      {
        name: "rotate board",
        method: "POST",
        path: "/channels/work/board/rotate",
        init: { json: { credential: "c".repeat(64) } },
      },
      {
        name: "push subscribe",
        method: "PUT",
        path: "/push/subscriptions",
        init: { json: await subscription() },
      },
      {
        name: "push unsubscribe",
        method: "DELETE",
        path: "/push/subscriptions",
        init: { json: { endpoint: "https://fcm.googleapis.com/fcm/send/x" } },
      },
      { name: "GitHub webhook secret", method: "POST", path: "/github/secret" },
      { name: "follow pull request", method: "PUT", path: "/channels/work/github/pulls/acme/app/7" },
      { name: "unfollow pull request", method: "DELETE", path: "/channels/work/github/pulls/acme/app/7" },
      { name: "create channel", method: "PUT", path: "/channels/work" },
      {
        name: "claim processing",
        method: "POST",
        path: "/channels/work/processing/watcher/claim",
        init: { json: { expectGeneration: 0 } },
      },
      {
        name: "commit processing",
        method: "POST",
        path: "/channels/work/processing/watcher/commit",
        init: { json: { generation: 1, through: f.first.id } },
      },
      {
        name: "publish snapshot",
        method: "POST",
        path: "/channels/work/snapshots",
        init: {
          headers: { "Idempotency-Key": "snap-2" },
          json: {
            username: "watcher",
            text: "Mine",
            coversThrough: f.first.id,
            baseVersion: 1,
            historyRevision: 0,
          },
        },
      },
      {
        name: "upload attachment",
        method: "POST",
        path: "/channels/work/attachments",
        init: { type: "application/octet-stream", body: "secret plans" },
      },
      {
        name: "label message",
        method: "POST",
        path: `${message}/labels`,
        init: { json: { set: { state: "done" } } },
      },
      {
        name: "send message",
        method: "POST",
        path: "/channels/work/messages",
        init: { json: { username: "watcher", text: "I am posting" } },
      },
    ];
    // The owner's first push read creates the workspace's push key, so a subscription is valid.
    expect((await call(`${f.api}/push`, f.owner)).status).toBe(200);
    const before = await counts(f);
    for (const route of routes) {
      const response = await call(`${f.api}${route.path}`, f.watcher, {
        ...route.init,
        method: route.method,
      });
      expect(response.status, route.name).toBe(403);
      expect((await response.json<{ error: { code: string } }>()).error.code, route.name).toBe("watch_only");
    }
    // Methods the router does not serve are refused too: the gate stands in front of routing.
    for (const method of ["PATCH", "DELETE", "PUT", "POST", "HEAD", "OPTIONS"])
      expect((await call(`${f.api}${message}`, f.watcher, { method })).status, method).toBe(403);
    expect(await counts(f)).toEqual(before);

    // Control: the owner can make each request, so the 403 above came from the watch gate alone.
    for (const route of routes) {
      const init = { ...route.init, method: route.method };
      if (init.json && typeof init.json === "object" && "username" in init.json)
        init.json = { ...init.json, username: "human" };
      const path = route.path.replace("/processing/watcher/", "/processing/human/");
      const response = await call(`${f.api}${path}`, f.owner, init);
      expect(response.status, `owner control: ${route.name}`).toBeLessThan(300);
    }
  });

  it("stays watch-only after the workspace restarts", async () => {
    const f = await fixture();
    await abortAllDurableObjects();
    const response = await call(`${f.api}/channels/work/messages`, f.watcher, {
      method: "POST",
      json: { username: "watcher", text: "after restart" },
    });
    expect(response.status).toBe(403);
    expect((await call(`${f.api}`, f.watcher)).status).toBe(200);
  });

  it("adds the columns to a database from before watch-only keys", async () => {
    const f = await fixture();
    // A participant key from before the upgrade: it lives in access_keys, unlike the owner's.
    const plain = await (
      await call(`${f.api}/invites`, f.owner, { method: "POST", json: { channel: "work" } })
    ).json<{ code: string }>();
    const member = await (
      await call(`${f.api}/invites/redeem`, undefined, {
        method: "POST",
        json: { code: plain.code, username: "member" },
      })
    ).json<Access>();
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    await runInDurableObject(stub, (_, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("DELETE FROM access_keys WHERE read_only = 1");
        state.storage.sql.exec("ALTER TABLE access_keys DROP COLUMN read_only");
        state.storage.sql.exec("ALTER TABLE invites DROP COLUMN watch");
      });
    });
    await abortAllDurableObjects();
    // Older keys keep posting; new watch invitations work after the in-place upgrade.
    expect(
      (
        await call(`${f.api}/channels/work/messages`, member.token, {
          method: "POST",
          json: { username: "member", text: "old key still posts" },
        })
      ).status,
    ).toBe(201);
    expect("watchOnly" in (await (await call(f.api, member.token)).json<Access>())).toBe(false);
    expect(
      (
        await call(`${f.api}/channels/work/messages`, f.owner, {
          method: "POST",
          json: { username: "human", text: "still here" },
        })
      ).status,
    ).toBe(201);
    const link = await (
      await call(`${f.api}/invites`, f.owner, { method: "POST", json: { channel: "work", watch: true } })
    ).json<{ code: string }>();
    const watcher = await (
      await call(`${f.api}/invites/redeem`, undefined, {
        method: "POST",
        json: { code: link.code, username: "late" },
      })
    ).json<Access>();
    expect(watcher.watchOnly).toBe(true);
    expect((await call(`${f.api}/channels/work`, watcher.token, { method: "PUT" })).status).toBe(403);
  });
});
