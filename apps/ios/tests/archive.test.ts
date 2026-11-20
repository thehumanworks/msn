import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { ApiClient } from "../src/core/apiClient.ts";
import { ChannelListController } from "../src/core/channelList.ts";
import { ApiError } from "../src/core/errors.ts";
import type { SessionController } from "../src/core/sessionController.ts";
import { SCOPED_TOKEN, startMockServer, TEST_TOKEN } from "./support/mockServer.ts";
import { nodeFetch } from "./support/util.ts";

// Archived boards (ADR 0046): the list carries archivedAt, the owner archives and unarchives,
// and an archived board refuses posts with 409 board_archived.

function fakeSession(api: ApiClient): SessionController {
  return {
    api,
    signal: new AbortController().signal,
    onEvent: () => () => {},
    onLifecycle: () => () => {},
    reportAuthFailure: () => {},
  } as unknown as SessionController;
}

test("the list includes archived boards with archivedAt, and the owner archives and unarchives", async () => {
  const server = await startMockServer();
  try {
    server.createChannel("done");
    server.createChannel("work");
    const api = new ApiClient(server.url, "acme", TEST_TOKEN, nodeFetch);
    const list = new ChannelListController(fakeSession(api));
    await list.load();
    assert.equal(list.isArchived("done"), false);
    assert.equal(await list.setArchived("done", true), null);
    assert.equal(list.isArchived("done"), true);
    await list.load();
    const done = list.state.get().channels.find((c) => c.name === "done");
    assert.ok(done?.archivedAt, "archived boards still load, with archivedAt");
    assert.equal(new URLSearchParams(server.requests.find((r) => r.path.endsWith("/channels"))!.query).get("include"), "archived");
    // The default list (without include) leaves it out.
    assert.deepEqual((await api.listChannels()).channels.map((c) => c.name), ["work"]);
    await assert.rejects(
      () => api.sendMessage("done", { username: "tomas", text: "late" }, "k1"),
      (e: unknown) => e instanceof ApiError && e.status === 409,
    );
    assert.equal(await list.setArchived("done", false), null);
    assert.equal(list.isArchived("done"), false);
    await api.sendMessage("done", { username: "tomas", text: "back" }, "k2");
    list.dispose();
  } finally {
    await server.close();
  }
});

test("a participant who tries to archive gets a plain refusal and stays signed in", async () => {
  const server = await startMockServer();
  try {
    server.createChannel("scoped");
    let signedOut = false;
    const api = new ApiClient(server.url, "acme", SCOPED_TOKEN, nodeFetch, "scoped");
    const list = new ChannelListController({
      ...fakeSession(api),
      reportAuthFailure: () => {
        signedOut = true;
      },
    } as unknown as SessionController);
    assert.equal(await list.setArchived("scoped", true), "Only the board owner can archive or unarchive a board.");
    assert.equal(signedOut, false);
    list.dispose();
  } finally {
    await server.close();
  }
});
