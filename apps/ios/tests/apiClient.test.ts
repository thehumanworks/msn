import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { ApiClient, provisionWorkspace, redeemInvite } from "../src/core/apiClient.ts";
import { ApiError, NetworkError, ProtocolError } from "../src/core/errors.ts";
import { SCOPED_TOKEN, startMockServer, TEST_TOKEN } from "./support/mockServer.ts";
import { nodeFetch } from "./support/util.ts";

test("channels, messages and idempotent sends round-trip against the fixture", async () => {
  const server = await startMockServer();
  try {
    const api = new ApiClient(server.url, "acme", TEST_TOKEN, nodeFetch);
    assert.equal((await api.getIdentity()).tenant, "acme");
    await api.createChannel("general");
    const first = await api.sendMessage("general", { username: "tomas", text: "hi", to: "asha" }, "key-1");
    const again = await api.sendMessage("general", { username: "tomas", text: "hi", to: "asha" }, "key-1");
    assert.equal(first.replayed, false);
    assert.equal(again.replayed, true);
    assert.equal(again.message.id, first.message.id);
    assert.equal(server.messages.length, 1);
    const list = await api.listChannels();
    assert.equal(list.channels[0].name, "general");
    await assert.rejects(
      () => api.sendMessage("general", { username: "tomas", text: "different" }, "key-1"),
      (e: unknown) => e instanceof ApiError && e.status === 409,
    );
  } finally {
    await server.close();
  }
});

test("getEvents sends the documented query and decodes", async () => {
  const server = await startMockServer();
  try {
    const api = new ApiClient(server.url, "acme", TEST_TOKEN, nodeFetch);
    server.post("general", "asha", "hello");
    const page = await api.getEvents({ after: 0, limit: 100, wait: 0 });
    assert.deepEqual(page.events.map((e) => e.type), ["channel.created", "message.created"]);
    const request = server.requests.at(-1)!;
    assert.equal(request.path, "/api/tenants/acme/events");
    assert.equal(new URLSearchParams(request.query).get("wait"), "0");
    assert.equal(new URLSearchParams(request.query).has("channel"), false);
  } finally {
    await server.close();
  }
});

test("a scoped key never sends a channel filter and sees only its channel", async () => {
  const server = await startMockServer();
  try {
    server.post("general", "asha", "secret");
    server.post("scoped", "asha", "visible");
    const api = new ApiClient(server.url, "acme", SCOPED_TOKEN, nodeFetch, "scoped");
    const page = await api.getEvents({ after: 0, limit: 100, wait: 0, channel: "general" });
    assert.ok(page.events.length > 0 && page.events.every((e) => e.channel === "scoped"));
    assert.equal(new URLSearchParams(server.requests.at(-1)!.query).has("channel"), false);
  } finally {
    await server.close();
  }
});

test("getEvents rejects a feed for the wrong tenant without progress", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ events: [{ id: 1, tenant: "evil", channel: "general", type: "message.created", resourceId: 1, historyRevision: 0, createdAt: "2026-09-20T00:00:00Z" }], nextCursor: 1, hasMore: false }), { status: 200 });
  const api = new ApiClient("https://msn.example", "acme", TEST_TOKEN, fetchImpl);
  await assert.rejects(() => api.getEvents({ after: 0, limit: 100, wait: 0 }), ProtocolError);
});

test("provisioning and invitation redemption return a usable key", async () => {
  const server = await startMockServer();
  try {
    const created = await provisionWorkspace(server.url, "acme", "tomas", "general", nodeFetch);
    assert.equal(created.token, TEST_TOKEN);
    const redeemed = await redeemInvite(server.url, "acme", "acme." + "0".repeat(64), "asha", nodeFetch);
    assert.equal(redeemed.channel, "scoped");
    assert.equal(redeemed.token, SCOPED_TOKEN);
  } finally {
    await server.close();
  }
});

test("a hung request times out instead of stalling forever", async () => {
  const server = await startMockServer();
  try {
    server.hold((path) => path.endsWith("/channels"));
    const api = new ApiClient(server.url, "acme", TEST_TOKEN, nodeFetch);
    const started = Date.now();
    // listChannels uses the default budget; use the low-level client for a short one.
    await assert.rejects(
      () => (api as unknown as { http: { request: (p: string, o: object) => Promise<unknown> } }).http.request("/channels", { timeoutMs: 50 }),
      NetworkError,
    );
    assert.ok(Date.now() - started < 1000);
  } finally {
    await server.close();
  }
});

test("an oversized response is refused, but an 8 MiB budget admits 100 large messages", async () => {
  const big = (bytes: number) => async () => new Response(JSON.stringify({ messages: [], nextCursor: 0, hasMore: false, pad: "x".repeat(bytes) }), { status: 200 });
  const api = (size: number) => new ApiClient("https://msn.example", "acme", TEST_TOKEN, big(size));
  await assert.rejects(() => api(9 * 1024 * 1024).listMessages("general", 0, 100, 0), ProtocolError);
  const hundred = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, tenant: "acme", channel: "general", username: "a", text: "y".repeat(16384), contentType: "text/plain", createdAt: "x" }));
  const ok = new ApiClient("https://msn.example", "acme", TEST_TOKEN, async () => new Response(JSON.stringify({ messages: hundred, nextCursor: 100, hasMore: false }), { status: 200 }));
  assert.equal((await ok.listMessages("general", 0, 100, 0)).messages.length, 100);
});

test("non-JSON error bodies still produce an ApiError with the status", async () => {
  const api = new ApiClient("https://msn.example", "acme", TEST_TOKEN, async () => new Response("<html>Bad gateway</html>", { status: 502 }));
  await assert.rejects(() => api.getIdentity(), (e: unknown) => e instanceof ApiError && e.status === 502 && e.isRetryable);
});
