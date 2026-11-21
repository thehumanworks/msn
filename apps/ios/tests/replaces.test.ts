import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { ChannelController } from "../src/core/channelController.ts";
import { decodeMessage } from "../src/core/decode.ts";
import { SessionController } from "../src/core/sessionController.ts";
import { track } from "./support/bounded.ts";
import { startMockServer, TEST_TOKEN, type MockServerHandle } from "./support/mockServer.ts";
import { nodeFetch, waitFor } from "./support/util.ts";

// Replace an instruction with a newer one (ADR 0068).

const fast = { stream: { waitSeconds: 1, backoff: { baseMs: 5, maxMs: 20 } }, connectBackoff: { baseMs: 5, maxMs: 20 } };

async function open(server: MockServerHandle, channel = "general") {
  server.createChannel(channel);
  const ctl = track(
    new SessionController(
      { origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", usernamePrefix: null },
      { ...fast, fetchImpl: nodeFetch },
    ),
  );
  await ctl.start();
  const channelCtl = track(new ChannelController(ctl, channel, { baseMs: 5, maxMs: 20 }));
  channelCtl.start();
  await waitFor(() => channelCtl.state.get().phase === "ready", "channel ready");
  return { ctl, channelCtl };
}

const base = { id: 4, tenant: "acme", channel: "general", username: "tomas", text: "x", contentType: "text/plain", createdAt: "t" };

test("decode keeps replaces and replacedBy, and refuses malformed ones", () => {
  const message = decodeMessage({ ...base, replaces: 2, replacedBy: 9 });
  assert.equal(message.replaces, 2);
  assert.equal(message.replacedBy, 9);
  assert.equal(decodeMessage(base).replacedBy, undefined);
  for (const bad of [{ replaces: 0 }, { replaces: "2" }, { replacedBy: -1 }])
    assert.throws(() => decodeMessage({ ...base, ...bad }));
});

test("a sent replacement carries replaces and marks the loaded message replaced", async () => {
  const server = await startMockServer();
  try {
    const old = server.post("general", "tomas", "Deploy to staging");
    const { channelCtl } = await open(server);
    await waitFor(() => channelCtl.state.get().messages.some((m) => m.id === old.id), "old loaded");
    // A replacement cannot be scheduled.
    assert.match(
      (await channelCtl.schedule({ text: "later", replaces: old.id }, "2099-01-01T00:00:00Z")) ?? "",
      /cannot be scheduled/,
    );
    assert.deepEqual(channelCtl.send({ text: "Deploy to production", replaces: old.id }), { ok: true });
    await waitFor(
      () => channelCtl.state.get().messages.find((m) => m.id === old.id)?.replacedBy !== undefined,
      "old marked replaced",
    );
    const next = channelCtl.state.get().messages.find((m) => m.replaces === old.id);
    assert.equal(next?.text, "Deploy to production");
    assert.equal(channelCtl.state.get().messages.find((m) => m.id === old.id)?.replacedBy, next?.id);
    assert.equal(server.messages.find((m) => m.id === old.id)?.replacedBy, next?.id);
  } finally {
    await server.close();
  }
});

test("deleting the middle of a chain links the oldest to the newest", async () => {
  const server = await startMockServer();
  try {
    const a = server.post("general", "tomas", "one");
    const { channelCtl } = await open(server);
    const find = (id: number) => channelCtl.state.get().messages.find((m) => m.id === id);
    await waitFor(() => find(a.id) !== undefined, "a loaded");
    assert.deepEqual(channelCtl.send({ text: "two", replaces: a.id }), { ok: true });
    await waitFor(() => find(a.id)?.replacedBy !== undefined, "a replaced");
    const b = find(a.id)!.replacedBy!;
    assert.deepEqual(channelCtl.send({ text: "three", replaces: b }), { ok: true });
    await waitFor(() => find(b)?.replacedBy !== undefined, "b replaced");
    const c = find(b)!.replacedBy!;
    server.remove(b);
    await waitFor(() => find(b) === undefined, "b removed");
    assert.equal(find(a.id)?.replacedBy, c);
    // The newest is still current; deleting it makes the oldest current again.
    server.remove(c);
    await waitFor(() => find(c) === undefined && find(a.id)?.replacedBy === undefined, "a current again");
  } finally {
    await server.close();
  }
});
