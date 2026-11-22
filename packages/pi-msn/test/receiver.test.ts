import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { MAX_BODY_BYTES, type Notice, type Receiver, startReceiver } from "../src/receiver.ts";

const KEY = "receiver-key-0123456789";
let receiver: Receiver;
let notices: Notice[];

async function start() {
  notices = [];
  receiver = await startReceiver({
    bearer: KEY,
    path: "/msn-wake",
    port: 0,
    onNotice: (notice) => notices.push(notice),
  });
  return `http://127.0.0.1:${receiver.port}`;
}

afterEach(() => receiver?.close());

const body = (extra: object = {}) =>
  JSON.stringify({
    schema: "msn.webhook.v1",
    type: "message.addressed",
    id: "n1",
    channel: "work",
    messageId: 7,
    ...extra,
  });

function post(
  origin: string,
  options: { key?: string | null; id?: string; body?: string; path?: string } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.key !== null) headers.authorization = `Bearer ${options.key ?? KEY}`;
  if (options.id) headers["msn-webhook-id"] = options.id;
  return fetch(`${origin}${options.path ?? "/msn-wake"}`, {
    method: "POST",
    headers,
    body: options.body ?? body(),
  });
}

test("a notice with the right key is acknowledged and handed on once", async () => {
  const origin = await start();
  assert.equal((await post(origin, { id: "a" })).status, 204);
  assert.deepEqual(
    notices.map((n) => [n.id, n.channel, n.messageId]),
    [["a", "work", 7]],
  );
  // At-least-once delivery: a retry carries the same MSN-Webhook-Id and must not be handled twice.
  assert.equal((await post(origin, { id: "a" })).status, 204);
  assert.equal((await post(origin, { id: "b" })).status, 204);
  assert.deepEqual(
    notices.map((n) => n.id),
    ["a", "b"],
  );
  assert.deepEqual([receiver.stats.accepted, receiver.stats.duplicates, receiver.stats.rejected], [2, 1, 0]);
});

test("without the header, the id in the body identifies the notice", async () => {
  const origin = await start();
  await post(origin);
  await post(origin);
  assert.deepEqual(
    notices.map((n) => n.id),
    ["n1"],
  );
});

test("a wrong or missing key is refused before the body is used", async () => {
  const origin = await start();
  for (const key of ["wrong-key-00000000000000", `${KEY}x`, KEY.slice(0, -1), null])
    assert.equal((await post(origin, { key, id: "x" })).status, 401);
  const basic = await fetch(`${origin}/msn-wake`, {
    method: "POST",
    headers: { authorization: KEY },
    body: body(),
  });
  assert.equal(basic.status, 401);
  assert.equal(notices.length, 0);
  assert.equal(receiver.stats.rejected, 5);
});

test("things that are not a notice are refused", async () => {
  const origin = await start();
  assert.equal((await post(origin, { id: "a", body: "{not json" })).status, 400);
  assert.equal((await post(origin, { id: "b", body: body({ schema: "other.v1" }) })).status, 400);
  assert.equal((await post(origin, { id: "c", body: "null" })).status, 400);
  assert.equal((await post(origin, { id: "d", body: "x".repeat(MAX_BODY_BYTES + 1) })).status, 413);
  assert.equal((await post(origin, { path: "/elsewhere" })).status, 404);
  assert.equal((await fetch(`${origin}/msn-wake`)).status, 405);
  assert.equal(notices.length, 0);
});

test("a ping is recorded, and the health page answers without a key", async () => {
  const origin = await start();
  assert.equal(receiver.stats.lastPingAt, null);
  await post(origin, { id: "p", body: body({ type: "ping", messageId: null }) });
  assert.match(String(receiver.stats.lastPingAt), /^20/);
  const health = await fetch(`${origin}/healthz`);
  assert.deepEqual([health.status, await health.text()], [200, "ok\n"]);
});

test("a handler that throws does not break the receiver", async () => {
  receiver = await startReceiver({
    bearer: KEY,
    path: "/msn-wake",
    port: 0,
    onNotice: () => {
      throw new Error("handler failed");
    },
  });
  const origin = `http://127.0.0.1:${receiver.port}`;
  assert.equal((await post(origin, { id: "a" })).status, 204);
  assert.equal((await post(origin, { id: "b" })).status, 204);
});
