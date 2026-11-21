import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import {
  BRIEF_MAX_BYTES,
  briefBytes,
  briefCount,
  briefNoticeVersion,
  briefTitle,
  decodeBrief,
} from "../src/core/brief.ts";
import { ChannelController } from "../src/core/channelController.ts";
import { SessionController } from "../src/core/sessionController.ts";
import { track } from "./support/bounded.ts";
import { startMockServer, TEST_TOKEN, type MockServerHandle } from "./support/mockServer.ts";
import { nodeFetch, waitFor } from "./support/util.ts";

// The board brief (ADR 0074): the owner's standing instructions, shown as the board's header.

const fast = { stream: { waitSeconds: 1, backoff: { baseMs: 5, maxMs: 20 } }, connectBackoff: { baseMs: 5, maxMs: 20 } };

async function open(server: MockServerHandle, channel = "work") {
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

test("decodes a brief, a board without one, and rejects a malformed answer", () => {
  assert.deepEqual(decodeBrief({ brief: null, currentVersion: 0 }), { brief: null, currentVersion: 0 });
  assert.deepEqual(
    decodeBrief({
      brief: { version: 2, text: "Run the tests.", bytes: 14, updatedAt: "2026-11-21T17:00:00.000Z", updatedBy: "human" },
      currentVersion: 2,
    }),
    {
      brief: { version: 2, text: "Run the tests.", updatedAt: "2026-11-21T17:00:00.000Z", updatedBy: "human" },
      currentVersion: 2,
    },
  );
  // A removed brief keeps its version number, so the next write builds on it.
  assert.deepEqual(decodeBrief({ brief: null, currentVersion: 3 }), { brief: null, currentVersion: 3 });
  assert.equal(decodeBrief({ brief: { version: 1, text: "x", updatedAt: "t" }, currentVersion: 1 }).brief?.updatedBy, null);
  for (const raw of [
    null,
    {},
    { brief: null, currentVersion: -1 },
    { brief: { version: 0, text: "x", updatedAt: "t" }, currentVersion: 1 },
    { brief: { version: 2, text: "x", updatedAt: "t" }, currentVersion: 1 },
    { brief: { version: 1, text: "", updatedAt: "t" }, currentVersion: 1 },
    { brief: { version: 1, text: 7, updatedAt: "t" }, currentVersion: 1 },
    { brief: { version: 1, text: "x", updatedAt: "t", updatedBy: 7 }, currentVersion: 1 },
  ])
    assert.throws(() => decodeBrief(raw), /invalid brief/);
});

test("counts UTF-8 bytes as the server does, and titles a brief", () => {
  assert.equal(BRIEF_MAX_BYTES, 4096);
  for (const text of ["", "abc", "é€😀", "a\nb", "👩‍👩‍👧"]) assert.equal(briefBytes(text), Buffer.byteLength(text), text);
  assert.deepEqual(briefCount("abc"), { bytes: 3, over: false, label: "3 of 4,096 bytes" });
  assert.equal(briefCount("x".repeat(4096)).over, false);
  assert.deepEqual(briefCount("é".repeat(2049)), {
    bytes: 4098,
    over: true,
    label: "4,098 of 4,096 bytes: too long to save",
  });
  const brief = { version: 3, text: "x", updatedAt: "t", updatedBy: "human" };
  assert.equal(briefTitle(brief), "Brief · version 3 · human");
  assert.equal(briefTitle({ ...brief, updatedBy: null }), "Brief · version 3");
});

test("recognises only the board's own brief announcement", () => {
  const notice = { username: "board", contentType: "application/json" as const, text: '{"schema":"msn.brief.v1","version":4}' };
  assert.equal(briefNoticeVersion(notice), 4);
  assert.equal(briefNoticeVersion({ ...notice, username: "lead" }), null);
  assert.equal(briefNoticeVersion({ ...notice, contentType: "text/plain" }), null);
  assert.equal(briefNoticeVersion({ ...notice, text: '{"schema":"msn.board.v1","version":4}' }), null);
  assert.equal(briefNoticeVersion({ ...notice, text: '{"schema":"msn.brief.v1","version":0}' }), null);
  assert.equal(briefNoticeVersion({ ...notice, text: "not json" }), null);
});

test("the brief loads with the board and follows a change made on another device", async () => {
  const server = await startMockServer();
  try {
    server.createChannel("work");
    server.setBrief("work", "# Rules\n\nRun the tests.");
    const { ctl, channelCtl } = await open(server);
    await waitFor(() => channelCtl.state.get().brief !== null, "brief loaded");
    assert.deepEqual(
      [channelCtl.state.get().brief?.version, channelCtl.state.get().brief?.text, channelCtl.state.get().briefVersion],
      [1, "# Rules\n\nRun the tests.", 1],
    );
    // One read for the load, although the history holds the announcement too.
    const reads = () => server.requests.filter((r) => r.method === "GET" && r.path.endsWith("/channels/work/brief")).length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(reads(), 1);
    // An ordinary message does not read the brief again; the board's announcement does.
    server.post("work", "lead", "hello");
    await waitFor(() => channelCtl.state.get().messages.some((m) => m.text === "hello"), "message");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(reads(), 1);
    server.setBrief("work", "Be kind.");
    await waitFor(() => channelCtl.state.get().brief?.version === 2, "new version");
    assert.equal(channelCtl.state.get().brief?.text, "Be kind.");
    assert.equal(reads(), 2);
    // Removing it clears the header and still moves the version on.
    server.setBrief("work", "");
    await waitFor(() => channelCtl.state.get().brief === null, "removed");
    assert.equal(channelCtl.state.get().briefVersion, 3);
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("the owner saves a brief over the version shown; a conflict keeps the text and reads the newer one", async () => {
  const server = await startMockServer();
  try {
    const { ctl, channelCtl } = await open(server);
    assert.equal(await channelCtl.saveBrief("x".repeat(4097)), "A brief holds at most 4,096 bytes.");
    assert.equal(server.requests.filter((r) => r.method === "PUT" && r.path.endsWith("/brief")).length, 0);
    assert.equal(await channelCtl.saveBrief("First."), null);
    assert.deepEqual([channelCtl.state.get().brief?.text, channelCtl.state.get().briefVersion], ["First.", 1]);
    // Another device writes version 2 before this one hears of it.
    const before = channelCtl.state.get().briefVersion;
    server.setBrief("work", "Theirs.");
    let failed: string | null = null;
    if (channelCtl.state.get().briefVersion === before) failed = await channelCtl.saveBrief("Mine.");
    if (failed !== null) {
      assert.match(failed, /changed somewhere else/);
      assert.equal(channelCtl.state.get().brief?.text, "Theirs.");
    }
    await waitFor(() => channelCtl.state.get().briefVersion === 2, "their version");
    assert.equal(await channelCtl.saveBrief("Mine."), null);
    assert.deepEqual([channelCtl.state.get().brief?.text, channelCtl.state.get().briefVersion], ["Mine.", 3]);
    assert.equal(await channelCtl.saveBrief("  "), null);
    assert.deepEqual([channelCtl.state.get().brief, channelCtl.state.get().briefVersion], [null, 4]);
    // The editor saves over the version it opened with. A change that arrives while the owner
    // types, and that this device has already loaded, is still a conflict; the next press wins.
    const opened = channelCtl.state.get().briefVersion;
    server.setBrief("work", "Theirs again.");
    await waitFor(() => channelCtl.state.get().briefVersion === 5, "their second version");
    assert.match((await channelCtl.saveBrief("Late.", opened)) ?? "", /changed somewhere else/);
    assert.equal(channelCtl.state.get().brief?.text, "Theirs again.");
    assert.equal(await channelCtl.saveBrief("Late."), null);
    assert.deepEqual([channelCtl.state.get().brief?.text, channelCtl.state.get().briefVersion], ["Late.", 6]);
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});
