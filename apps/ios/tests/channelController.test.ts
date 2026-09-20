import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { ChannelController, MAX_MESSAGES } from "../src/core/channelController.ts";
import { ChannelListController } from "../src/core/channelList.ts";
import { SessionController } from "../src/core/sessionController.ts";
import { track } from "./support/bounded.ts";
import { startMockServer, TEST_TOKEN, type MockServerHandle } from "./support/mockServer.ts";
import { nodeFetch, waitFor } from "./support/util.ts";

const fast = { stream: { waitSeconds: 1, backoff: { baseMs: 5, maxMs: 20 } }, connectBackoff: { baseMs: 5, maxMs: 20 } };

async function open(server: MockServerHandle, channel = "general", fetchImpl = nodeFetch) {
  server.createChannel(channel);
  const ctl = track(
    new SessionController(
      { origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", usernamePrefix: null },
      { ...fast, fetchImpl },
    ),
  );
  await ctl.start();
  const channelCtl = track(new ChannelController(ctl, channel, { baseMs: 5, maxMs: 20 }));
  channelCtl.start();
  await waitFor(() => channelCtl.state.get().phase === "ready", "channel ready");
  return { ctl, channelCtl };
}

const ids = (c: ChannelController) => c.state.get().messages.map((m) => m.id);

test("loads canonical history, then follows new messages through events", async () => {
  const server = await startMockServer();
  try {
    server.post("general", "asha", "before 1");
    server.post("general", "asha", "before 2");
    const { ctl, channelCtl } = await open(server);
    assert.deepEqual(ids(channelCtl), [1, 2]);
    server.post("general", "asha", "live");
    await waitFor(() => ids(channelCtl).length === 3, "live message");
    server.post("other", "asha", "elsewhere");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(ids(channelCtl), [1, 2, 3]);
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("a message posted between the cursor bootstrap and the canonical read is not lost or duplicated", async () => {
  const server = await startMockServer();
  try {
    server.post("general", "asha", "one");
    const ctl = track(
      new SessionController(
        { origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", usernamePrefix: null },
        { ...fast, fetchImpl: nodeFetch },
      ),
    );
    await ctl.start(); // event cursor drained here...
    server.post("general", "asha", "gap"); // ...then a change lands before any canonical read
    const channelCtl = track(new ChannelController(ctl, "general", { baseMs: 5, maxMs: 20 }));
    channelCtl.start();
    await waitFor(() => channelCtl.state.get().phase === "ready", "ready");
    await waitFor(() => ids(channelCtl).length === 2, "both messages");
    assert.deepEqual(ids(channelCtl), [1, 2]);
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("redaction removes the message and reloads canonical state", async () => {
  const server = await startMockServer();
  try {
    server.post("general", "asha", "keep");
    const secret = server.post("general", "asha", "oops");
    const { ctl, channelCtl } = await open(server);
    assert.deepEqual(ids(channelCtl), [1, 2]);
    server.remove(secret.id);
    await waitFor(() => ids(channelCtl).length === 1, "redaction applied");
    assert.deepEqual(ids(channelCtl), [1]);
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("a deletion while backgrounded is applied on resume", async () => {
  const server = await startMockServer();
  try {
    const target = server.post("general", "asha", "to be redacted");
    const { ctl, channelCtl } = await open(server);
    ctl.pause();
    server.remove(target.id);
    server.post("general", "asha", "new while away");
    ctl.resume();
    await waitFor(() => JSON.stringify(ids(channelCtl)) === "[2]", "resumed state");
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("snapshot.published fetches the new snapshot; task events stay plain messages", async () => {
  const server = await startMockServer();
  try {
    server.post("general", "asha", JSON.stringify({ schema: "msn.task.v1", task: "t1", action: "open", title: "T", reviewer: "r" }), "application/json");
    const { ctl, channelCtl } = await open(server);
    assert.equal(channelCtl.state.get().snapshot, null);
    server.publishSnapshot("general", "Objective: ship");
    await waitFor(() => channelCtl.state.get().snapshot?.text === "Objective: ship", "snapshot");
    assert.equal(channelCtl.state.get().snapshotVersion, 1);
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("a failed canonical read backs off and self-heals; stale flag reflects it", async () => {
  const server = await startMockServer();
  try {
    server.post("general", "asha", "one");
    const ctl = track(
      new SessionController(
        { origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", usernamePrefix: null },
        { ...fast, fetchImpl: nodeFetch },
      ),
    );
    await ctl.start();
    server.fail((p) => p.endsWith("/catchup"), 1, 503);
    const channelCtl = track(new ChannelController(ctl, "general", { baseMs: 5, maxMs: 20 }));
    channelCtl.start();
    await waitFor(() => channelCtl.state.get().phase === "error" || channelCtl.state.get().phase === "ready", "first result");
    await waitFor(() => channelCtl.state.get().phase === "ready", "self-heal", 5000);
    assert.equal(channelCtl.state.get().stale, false);
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("a disposed controller (channel switch) ignores late responses", async () => {
  const server = await startMockServer();
  try {
    server.post("general", "asha", "one");
    const ctl = track(
      new SessionController(
        { origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", usernamePrefix: null },
        { ...fast, fetchImpl: nodeFetch },
      ),
    );
    await ctl.start();
    const hold = server.hold((p) => p.endsWith("/catchup"));
    const channelCtl = track(new ChannelController(ctl, "general", { baseMs: 5, maxMs: 20 }));
    channelCtl.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    channelCtl.dispose();
    hold.release();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(channelCtl.state.get().phase, "loading");
    assert.deepEqual(ids(channelCtl), []);
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("the in-memory window is bounded and says so", async () => {
  const server = await startMockServer();
  try {
    for (let i = 0; i < MAX_MESSAGES + 30; i += 1) server.post("general", "asha", `m${i}`);
    const { ctl, channelCtl } = await open(server);
    assert.equal(channelCtl.state.get().messages.length, MAX_MESSAGES);
    assert.equal(channelCtl.state.get().olderNotLoaded, true);
    assert.equal(ids(channelCtl).at(-1), MAX_MESSAGES + 30);
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

// ---- sending ------------------------------------------------------------------------------

/** Performs the request (the server stores it) but loses the response, like a dropped connection. */
function lossyOnce(): typeof nodeFetch {
  let armed = true;
  return async (input, init) => {
    const response = await nodeFetch(input, init);
    if (armed && init?.method === "POST") {
      armed = false;
      await response.text();
      throw new TypeError("connection dropped after the server stored the message");
    }
    return response;
  };
}

test("an uncertain send keeps its key and body; retry is idempotent (one stored message)", async () => {
  const server = await startMockServer();
  try {
    const { ctl, channelCtl } = await open(server, "general", lossyOnce());
    assert.deepEqual(channelCtl.send({ text: "hello", to: "asha" }), { ok: true });
    await waitFor(() => channelCtl.state.get().outbox[0]?.status === "uncertain", "uncertain");
    const [item] = channelCtl.state.get().outbox;
    assert.equal(server.messages.length, 1, "the server did store it");
    // Composer edits elsewhere cannot touch the pending item: it is immutable state.
    channelCtl.retrySend(item.id);
    await waitFor(() => channelCtl.state.get().outbox.length === 0, "delivered");
    assert.equal(server.messages.length, 1, "retry replayed idempotently");
    assert.equal(server.messages[0].key, item.key);
    assert.equal(server.messages[0].to, "asha");
    assert.deepEqual(ids(channelCtl), [1]);
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("a new draft while one is uncertain gets its own key and waits its turn", async () => {
  const server = await startMockServer();
  try {
    const { ctl, channelCtl } = await open(server, "general", lossyOnce());
    channelCtl.send({ text: "first" });
    await waitFor(() => channelCtl.state.get().outbox[0]?.status === "uncertain", "uncertain");
    channelCtl.send({ text: "second" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const [a, b] = channelCtl.state.get().outbox;
    assert.notEqual(a.key, b.key);
    assert.equal(b.status, "queued", "ordering preserved: blocked behind the uncertain head");
    channelCtl.retrySend(a.id);
    await waitFor(() => channelCtl.state.get().outbox.length === 0, "both delivered");
    assert.deepEqual(server.messages.map((m) => m.text), ["first", "second"]);
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("a definitive 4xx rejection returns to the composer and stores nothing", async () => {
  const server = await startMockServer();
  try {
    const { ctl, channelCtl } = await open(server);
    server.fail((p, m) => m === "POST" && p.endsWith("/messages"), 1, 403);
    channelCtl.send({ text: "nope", replyTo: 1 });
    await waitFor(() => channelCtl.state.get().outbox[0]?.status === "rejected", "rejected");
    const draft = channelCtl.takeRejected(channelCtl.state.get().outbox[0].id);
    assert.deepEqual(draft, { text: "nope", to: undefined, replyTo: 1 });
    assert.equal(channelCtl.state.get().outbox.length, 0);
    assert.equal(server.messages.length, 0);
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("backgrounding mid-send is uncertain, and resume retries with the same key", async () => {
  const server = await startMockServer();
  try {
    const { ctl, channelCtl } = await open(server);
    const hold = server.hold((p, m) => m === "POST" && p.endsWith("/messages"));
    channelCtl.send({ text: "in flight" });
    await waitFor(() => channelCtl.state.get().outbox[0]?.status === "sending", "sending");
    const key = channelCtl.state.get().outbox[0].key;
    ctl.pause();
    await waitFor(() => channelCtl.state.get().outbox[0]?.status === "uncertain", "interrupted");
    hold.release();
    ctl.resume();
    await waitFor(() => channelCtl.state.get().outbox.length === 0, "delivered after resume");
    assert.equal(server.messages.length, 1);
    assert.equal(server.messages[0].key, key);
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("validation and outbox bounds", async () => {
  const server = await startMockServer();
  try {
    const { ctl, channelCtl } = await open(server);
    assert.equal(channelCtl.send({ text: "   " }).ok, false);
    assert.equal(channelCtl.send({ text: "x".repeat(16385) }).ok, false);
    assert.equal(channelCtl.send({ text: "hi", to: "y".repeat(129) }).ok, false);
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("channel list reloads on channel.created and is coalesced", async () => {
  const server = await startMockServer();
  try {
    server.createChannel("alpha");
    const { ctl } = await open(server);
    const list = track(new ChannelListController(ctl, 20, { baseMs: 5, maxMs: 20 }));
    await list.load();
    assert.deepEqual(list.state.get().channels.map((c) => c.name), ["alpha", "general"]);
    server.createChannel("beta");
    await waitFor(() => list.state.get().channels.length === 3, "new channel");
    list.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("a failing canonical read does not spin: events during backoff do not bypass it", async () => {
  const server = await startMockServer();
  try {
    server.createChannel("general");
    const ctl = track(
      new SessionController(
        { origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", usernamePrefix: null },
        { ...fast, fetchImpl: nodeFetch },
      ),
    );
    await ctl.start();
    server.fail((p) => p.endsWith("/catchup"), 1000, 503);
    const channelCtl = track(new ChannelController(ctl, "general", { baseMs: 200, maxMs: 200, random: () => 1 }));
    channelCtl.start();
    await waitFor(() => channelCtl.state.get().stale, "failure noticed");
    const catchups = () => server.requests.filter((r) => r.path.endsWith("/catchup")).length;
    const before = catchups();
    for (let i = 0; i < 20; i += 1) server.post("general", "asha", `burst ${i}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(catchups(), before, "no retry before the backoff elapsed");
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.ok(catchups() - before <= 3, `retries were rate limited (${catchups() - before})`);
    assert.equal(channelCtl.state.get().stale, true, "invalidation stays pending");
  } finally {
    await server.close();
  }
});
