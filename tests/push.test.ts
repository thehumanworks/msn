import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  base64url,
  encryptPayload,
  fromBase64url,
  generateVapidKeys,
  needsOwner,
  parseSubscription,
  vapidAuthorization,
} from "../src/push";
import type { MsnDurableObject } from "../src/store";

const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });

/** A browser's side of a push subscription: its ECDH key pair and auth secret. */
async function browser(endpoint = "https://fcm.googleapis.com/fcm/send/device-1") {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    pair,
    publicKey,
    auth,
    subscription: { endpoint, keys: { p256dh: base64url(publicKey), auth: base64url(auth) } },
  };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: string | Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const infoBytes = typeof info === "string" ? new TextEncoder().encode(info) : info;
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: infoBytes }, key, bytes * 8),
  );
}

/** Independent RFC 8291 decryption, as a browser does it. */
async function decrypt(device: Awaited<ReturnType<typeof browser>>, body: Uint8Array) {
  const salt = body.slice(0, 16);
  expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(4096);
  const idLength = body[20];
  const asPublic = body.slice(21, 21 + idLength);
  const cipher = body.slice(21 + idLength);
  const serverKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: serverKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      device.pair.privateKey,
      256,
    ),
  );
  const info = new Uint8Array([
    ...new TextEncoder().encode("WebPush: info\0"),
    ...device.publicKey,
    ...asPublic,
  ]);
  const ikm = await hkdf(device.auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, cipher));
  expect(plain.at(-1)).toBe(2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

describe("web push primitives", () => {
  it("encrypts a payload that the subscribed browser can decrypt", async () => {
    const device = await browser();
    const body = await encryptPayload(device.subscription.keys, new TextEncoder().encode("hello owner"));
    expect(await decrypt(device, body)).toBe("hello owner");
  });

  it("signs a VAPID token for the push service origin with the workspace key", async () => {
    const keys = await generateVapidKeys();
    const header = await vapidAuthorization(
      keys,
      "https://fcm.googleapis.com/fcm/send/x",
      "https://msn.test",
      1_700_000_000_000,
    );
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match as RegExpExecArray;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(claims)))).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: 1_700_000_000 + 12 * 3600,
      sub: "https://msn.test",
    });
    const publicKey = await crypto.subtle.importKey(
      "raw",
      fromBase64url(keys.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        fromBase64url(signature),
        new TextEncoder().encode(`${head}.${claims}`),
      ),
    ).toBe(true);
  });

  it("accepts only well-formed subscriptions on known push services", async () => {
    const { subscription } = await browser();
    expect(parseSubscription(subscription).endpoint).toBe(subscription.endpoint);
    for (const endpoint of [
      "https://web.push.apple.com/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://wns2-db5p.notify.windows.com/w/?token=abc",
    ])
      expect(parseSubscription({ ...subscription, endpoint }).endpoint).toBe(endpoint);
    for (const endpoint of [
      "http://fcm.googleapis.com/x",
      "https://evil.example/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://fcm.googleapis.com:8443/x",
      "https://user@fcm.googleapis.com/x",
      "not a url",
    ])
      expect(() => parseSubscription({ ...subscription, endpoint })).toThrow();
    expect(() =>
      parseSubscription({ ...subscription, keys: { ...subscription.keys, auth: "short" } }),
    ).toThrow();
    expect(() =>
      parseSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: "AAAA" } }),
    ).toThrow();
    expect(() => parseSubscription(null)).toThrow();
  });

  it("decides which messages mean an agent needs the owner", () => {
    const owners = new Set(["human"]);
    const json = (data: unknown, username = "lead") => ({
      username,
      text: JSON.stringify(data),
      contentType: "application/json",
    });
    expect(
      needsOwner(json({ schema: "msn.board.v1", goal: "Ship", status: "blocked" }, "board"), owners),
    ).toEqual({
      reason: "board_blocked",
      summary: "Board blocked: Ship",
    });
    expect(
      needsOwner(json({ schema: "msn.board.v1", goal: "Ship", status: "paused" }, "board"), owners),
    ).toBeNull();
    expect(
      needsOwner(
        json({ schema: "msn.task.v1", task: "release", action: "block", reason: "Need a token" }),
        owners,
      ),
    ).toEqual({ reason: "task_blocked", summary: "Task release blocked: Need a token" });
    expect(needsOwner(json({ schema: "msn.task.v1", task: "release", action: "claim" }), owners)).toBeNull();
    expect(
      needsOwner(json({ schema: "msn.host.status.v1", status: "failed", reason: "timeout" }), owners),
    ).toEqual({
      reason: "job_failed",
      summary: "A job failed: timeout",
    });
    expect(
      needsOwner(
        { username: "lead", text: "Which  region?\n", contentType: "text/plain", to: "human" },
        owners,
      ),
    ).toEqual({ reason: "question", summary: "Which region?" });
    expect(
      needsOwner({ username: "lead", text: "x".repeat(500), contentType: "text/plain", to: "human" }, owners)
        ?.summary,
    ).toHaveLength(140);
    expect(
      needsOwner({ username: "lead", text: "hi", contentType: "text/plain", to: "reviewer" }, owners),
    ).toBeNull();
    expect(needsOwner({ username: "lead", text: "hi", contentType: "text/plain" }, owners)).toBeNull();
    expect(
      needsOwner({ username: "human", text: "hi", contentType: "text/plain", to: "human" }, owners),
    ).toBeNull();
    expect(
      needsOwner({ username: "lead", text: "{bad", contentType: "application/json" }, owners),
    ).toBeNull();
  });
});

type Sent = { url: string; headers: Headers; body: Uint8Array };

async function fixture() {
  const tenant = `push-${crypto.randomUUID()}`;
  const owner = (
    await (await call(tenant, "", undefined, "PUT", { username: "human" })).json<{ token: string }>()
  ).token;
  const agent = "b".repeat(64);
  expect(
    (await call(tenant, "/channels/work/board", owner, "PUT", { credential: agent, goal: "Ship it" })).status,
  ).toBe(201);
  expect(
    (await call(tenant, "/channels/work/personas/p1", agent, "PUT", { displayName: "lead" })).status,
  ).toBe(201);
  const sent: Sent[] = [];
  let status = 201;
  const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant]));
  await runInDurableObject(stub, (instance: MsnDurableObject) => {
    // Delivery tests check every trigger; the cooldown has its own test.
    instance.pushCooldownMs = 0;
    instance.pushFetch = async (input, init) => {
      sent.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: new Uint8Array(init?.body as Uint8Array),
      });
      return new Response(null, { status });
    };
  });
  return {
    tenant,
    owner,
    agent,
    sent,
    stub,
    respondWith: (code: number) => {
      status = code;
    },
  };
}

const say = (f: { tenant: string; agent: string }, text: string, extra: Record<string, unknown> = {}) =>
  call(f.tenant, "/channels/work/messages", f.agent, "POST", { username: "lead", text, ...extra });

describe("owner push notifications", () => {
  it("only the owner reads the key and registers devices", async () => {
    const f = await fixture();
    const device = await browser();
    expect((await call(f.tenant, "/push", f.agent)).status).toBe(403);
    expect((await call(f.tenant, "/push/subscriptions", f.agent, "PUT", device.subscription)).status).toBe(
      403,
    );
    expect((await call(f.tenant, "/push/subscriptions", f.owner, "PUT", device.subscription)).status).toBe(
      409,
    );
    const first = await (await call(f.tenant, "/push", f.owner)).json<{
      publicKey: string;
      devices: number;
    }>();
    expect(fromBase64url(first.publicKey)).toHaveLength(65);
    expect(first.devices).toBe(0);
    expect((await call(f.tenant, "/push/subscriptions", f.owner, "PUT", device.subscription)).status).toBe(
      201,
    );
    expect((await call(f.tenant, "/push/subscriptions", f.owner, "PUT", device.subscription)).status).toBe(
      201,
    );
    const again = await (await call(f.tenant, "/push", f.owner)).json<{
      publicKey: string;
      devices: number;
    }>();
    expect(again).toEqual({ publicKey: first.publicKey, devices: 1 });
    expect(
      (
        await call(f.tenant, "/push/subscriptions", f.owner, "PUT", {
          ...device.subscription,
          endpoint: "https://evil.example/collect",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(f.tenant, "/push/subscriptions", f.owner, "DELETE", {
          endpoint: device.subscription.endpoint,
        })
      ).status,
    ).toBe(204);
    expect((await (await call(f.tenant, "/push", f.owner)).json<{ devices: number }>()).devices).toBe(0);
  });

  it("caps registered devices per workspace", async () => {
    const f = await fixture();
    await call(f.tenant, "/push", f.owner);
    const device = await browser();
    for (let i = 0; i < 20; i++)
      expect(
        (
          await call(f.tenant, "/push/subscriptions", f.owner, "PUT", {
            ...device.subscription,
            endpoint: `https://fcm.googleapis.com/fcm/send/d${i}`,
          })
        ).status,
      ).toBe(201);
    const over = await call(f.tenant, "/push/subscriptions", f.owner, "PUT", device.subscription);
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: { code: "push_quota" } });
  });

  it("notifies subscribed devices when an agent asks the owner or blocks work", async () => {
    const f = await fixture();
    const device = await browser();
    await call(f.tenant, "/push", f.owner);
    await call(f.tenant, "/push/subscriptions", f.owner, "PUT", device.subscription);

    expect((await say(f, "Which region should I deploy to?", { to: "human" })).status).toBe(201);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    const [question] = f.sent;
    expect(question.url).toBe(device.subscription.endpoint);
    expect(question.headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(question.headers.get("TTL")).toBe("86400");
    expect(question.headers.get("Authorization")).toMatch(/^vapid t=.+, k=.+$/);
    const sentMessage = await (await call(f.tenant, "/channels/work/messages", f.agent)).json<{
      messages: { id: number }[];
    }>();
    expect(JSON.parse(await decrypt(device, question.body))).toEqual({
      schema: "msn.push.v1",
      tenant: f.tenant,
      channel: "work",
      messageId: sentMessage.messages.at(-1)?.id,
      reason: "question",
      title: "#work",
      body: "lead: Which region should I deploy to?",
    });

    // Plain chatter, messages to someone else and replayed sends never notify.
    await say(f, "Working on it");
    await say(f, "Over to you", { to: "reviewer" });
    expect((await say(f, "Which region should I deploy to?", { to: "human" })).status).toBe(201);
    const keyed = () =>
      exports.default.fetch(`https://msn.test/api/tenants/${f.tenant}/channels/work/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.agent}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "q-1",
        },
        body: JSON.stringify({ username: "lead", text: "Still need the region", to: "human" }),
      });
    expect((await keyed()).status).toBe(201);
    await vi.waitFor(() => expect(f.sent).toHaveLength(3));
    expect((await keyed()).status).toBe(200);

    // An agent blocks the board: one notification, and none for a later goal edit while blocked.
    expect(
      (await call(f.tenant, "/channels/work/board", f.agent, "POST", { revision: 1, status: "blocked" }))
        .status,
    ).toBe(200);
    await vi.waitFor(() => expect(f.sent).toHaveLength(4));
    expect(JSON.parse(await decrypt(device, f.sent[3].body))).toMatchObject({
      reason: "board_blocked",
      body: "board: Board blocked: Ship it",
    });
    await call(f.tenant, "/channels/work/board", f.agent, "POST", { revision: 2, goal: "Ship it soon" });

    // A blocked task event.
    await say(
      f,
      JSON.stringify({ schema: "msn.task.v1", task: "release", action: "block", reason: "Need the key" }),
      { contentType: "application/json" },
    );
    await vi.waitFor(() => expect(f.sent).toHaveLength(5));
    expect(JSON.parse(await decrypt(device, f.sent[4].body))).toMatchObject({
      reason: "task_blocked",
      body: "lead: Task release blocked: Need the key",
    });

    // The owner's own actions never notify the owner.
    await call(f.tenant, "/channels/work/messages", f.owner, "POST", {
      username: "human",
      text: "hi",
      to: "human",
    });
    await call(f.tenant, "/channels/work/board", f.owner, "POST", { revision: 3, status: "active" });
    await call(f.tenant, "/channels/work/board", f.owner, "POST", { revision: 4, status: "blocked" });
    await say(f, "flush", { to: "human" });
    await vi.waitFor(() => expect(f.sent).toHaveLength(6));
    expect(JSON.parse(await decrypt(device, f.sent[5].body))).toMatchObject({ body: "lead: flush" });
  });

  it("forgets a device the push service reports as gone, and keeps it on other failures", async () => {
    const f = await fixture();
    const device = await browser();
    await call(f.tenant, "/push", f.owner);
    await call(f.tenant, "/push/subscriptions", f.owner, "PUT", device.subscription);
    f.respondWith(500);
    expect((await say(f, "ping", { to: "human" })).status).toBe(201);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    expect((await (await call(f.tenant, "/push", f.owner)).json<{ devices: number }>()).devices).toBe(1);
    f.respondWith(410);
    await say(f, "ping again", { to: "human" });
    await vi.waitFor(async () =>
      expect((await (await call(f.tenant, "/push", f.owner)).json<{ devices: number }>()).devices).toBe(0),
    );
  });

  it("sends nothing and stores no key until an owner turns notifications on", async () => {
    const f = await fixture();
    expect((await say(f, "Anyone there?", { to: "human" })).status).toBe(201);
    await runInDurableObject(f.stub, (_, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM push_keys").one().n).toBe(0);
      expect(state.storage.sql.exec("SELECT MAX(version) AS v FROM schema_version").one().v).toBe(12);
    });
    expect(f.sent).toHaveLength(0);
  });

  it("sends at most one push per board and reason per cooldown", async () => {
    const f = await fixture();
    await runInDurableObject(f.stub, (instance: MsnDurableObject) => {
      instance.pushCooldownMs = 60_000;
    });
    const device = await browser();
    await call(f.tenant, "/push", f.owner);
    await call(f.tenant, "/push/subscriptions", f.owner, "PUT", device.subscription);
    for (let i = 0; i < 5; i++) expect((await say(f, `question ${i}`, { to: "human" })).status).toBe(201);
    await say(f, JSON.stringify({ schema: "msn.task.v1", task: "release", action: "block", reason: "x" }), {
      contentType: "application/json",
    });
    await say(f, JSON.stringify({ schema: "msn.task.v1", task: "other", action: "block", reason: "y" }), {
      contentType: "application/json",
    });
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    // Give any extra (wrong) delivery a chance to show up before asserting there is none.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(f.sent).toHaveLength(2);
    expect(JSON.parse(await decrypt(device, f.sent[0].body))).toMatchObject({ body: "lead: question 0" });
    expect(JSON.parse(await decrypt(device, f.sent[1].body))).toMatchObject({ reason: "task_blocked" });
  });

  it("an owner credential never notifies, even when sending under another name", async () => {
    // A legacy unbound workspace token is an owner credential that may send as any name.
    const tenant = `push-${crypto.randomUUID()}`;
    const provisioned = await exports.default.fetch(`https://msn.test/api/admin/tenants/${tenant}`, {
      method: "PUT",
      headers: { Authorization: "Bearer test-admin-secret-000000000000000000000" },
    });
    const workspace = (await provisioned.json<{ token: string }>()).token;
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant]));
    const human = (await stub.accountSession(tenant, "human")).token;
    const sent: string[] = [];
    await runInDurableObject(stub, (instance: MsnDurableObject) => {
      instance.pushCooldownMs = 0;
      instance.pushFetch = async (input) => {
        sent.push(String(input));
        return new Response(null, { status: 201 });
      };
    });
    const device = await browser();
    await call(tenant, "/push", human);
    await call(tenant, "/push/subscriptions", human, "PUT", device.subscription);
    expect(
      (
        await call(tenant, "/channels/ops/messages", workspace, "POST", {
          username: "ops",
          text: "hi",
          to: "human",
        })
      ).status,
    ).toBe(201);
    // A participant key (not an owner credential) with the same message does notify.
    const key = await exports.default.fetch(`https://msn.test/api/admin/tenants/${tenant}/keys/agent`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer test-admin-secret-000000000000000000000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: "ops" }),
    });
    expect(key.status).toBe(201);
    const agent = (await key.json<{ token: string }>()).token;
    expect(
      (
        await call(tenant, "/channels/ops/messages", agent, "POST", {
          username: "ops",
          text: "hi",
          to: "human",
        })
      ).status,
    ).toBe(201);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent).toHaveLength(1);
  });

  it("an admin token rotation removes every registered device", async () => {
    const f = await fixture();
    const device = await browser();
    await call(f.tenant, "/push", f.owner);
    await call(f.tenant, "/push/subscriptions", f.owner, "PUT", device.subscription);
    const rotated = await exports.default.fetch(`https://msn.test/api/admin/tenants/${f.tenant}/token`, {
      method: "POST",
      headers: { Authorization: "Bearer test-admin-secret-000000000000000000000" },
    });
    expect(rotated.status).toBe(200);
    const { token } = await rotated.json<{ token: string }>();
    expect((await (await call(f.tenant, "/push", token)).json<{ devices: number }>()).devices).toBe(0);
  });
});
