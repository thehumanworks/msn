import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { ChannelController } from "../src/core/channelController.ts";
import { claimControl, claimNote, decodeClaim, withClaim } from "../src/core/claims.ts";
import { decodeMessage, decodeReactionPage } from "../src/core/decode.ts";
import { SessionController } from "../src/core/sessionController.ts";
import type { Message } from "../src/core/types.ts";
import { track } from "./support/bounded.ts";
import { startMockServer, TEST_TOKEN, type MockServerHandle } from "./support/mockServer.ts";
import { nodeFetch, waitFor } from "./support/util.ts";

// Take a request (ADR 0075): one name marks a message as being handled, so others skip it.

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
  // A zero refresh interval: every sync re-reads reactions and claims.
  const channelCtl = track(new ChannelController(ctl, channel, { baseMs: 5, maxMs: 20 }, 0));
  channelCtl.start();
  await waitFor(() => channelCtl.state.get().phase === "ready", "channel ready");
  return { ctl, channelCtl };
}

const base: Message = { id: 4, tenant: "acme", channel: "general", username: "lead", text: "x", contentType: "text/plain", createdAt: "t" };
const at = "2026-11-21T18:00:00.000Z";

test("decode keeps a claim and drops a malformed one without failing the message", () => {
  assert.deepEqual(decodeMessage({ ...base, claim: { username: "dev", claimedAt: at } }).claim, { username: "dev", claimedAt: at });
  assert.equal(decodeMessage(base).claim, undefined);
  for (const bad of [null, "dev", {}, { username: "", claimedAt: at }, { username: "dev" }, { username: 1, claimedAt: at }]) {
    assert.equal(decodeClaim(bad), undefined);
    assert.equal(decodeMessage({ ...base, claim: bad }).claim, undefined);
  }
});

test("the reactions page lists claims, and says so when the server sent none", () => {
  const page = decodeReactionPage({
    reactions: [],
    claims: [{ id: 3, claim: { username: "dev", claimedAt: at } }, { id: 5, claim: { username: "" } }],
    hasMore: false,
  });
  assert.deepEqual([...(page.claims ?? [])], [[3, { username: "dev", claimedAt: at }]]);
  assert.equal(decodeReactionPage({ reactions: [], hasMore: false }).claims, null);
  assert.throws(() => decodeReactionPage({ reactions: [], claims: [{ id: 0, claim: {} }], hasMore: false }));
});

test("a row offers Taking this on a free message and Release to the holder or the owner", () => {
  const taken = { ...base, claim: { username: "dev", claimedAt: at } };
  assert.equal(claimControl(base, "tomas", false), "take");
  assert.equal(claimControl(taken, "tomas", false), null);
  assert.equal(claimControl(taken, "dev", false), "release");
  assert.equal(claimControl(taken, "tomas", true), "release");
  // A case variant is another name.
  assert.equal(claimControl(taken, "Dev", false), null);
  // A replaced message cannot be taken; an earlier claim on it can still be released.
  assert.equal(claimControl({ ...base, replacedBy: 9 }, "tomas", true), null);
  assert.equal(claimControl({ ...taken, replacedBy: 9 }, "dev", false), "release");
  assert.equal(claimControl(base, undefined, true), null);
  assert.equal(claimNote(taken.claim, "tomas"), "Taken by dev");
  assert.equal(claimNote(taken.claim, "dev"), "Taken by dev (you)");
  assert.equal("claim" in withClaim(taken, undefined), false);
  assert.deepEqual(withClaim(base, taken.claim).claim, taken.claim);
});

test("taking and releasing update the row; a refusal names the holder and shows them", async () => {
  const server = await startMockServer();
  try {
    const first = server.post("general", "lead", "Deploy the worker");
    const second = server.post("general", "lead", "Review the PR");
    const { channelCtl } = await open(server);
    const claimOf = (id: number) => channelCtl.state.get().messages.find((m) => m.id === id)?.claim;
    await waitFor(() => channelCtl.state.get().messages.length === 2, "messages loaded");

    assert.equal(await channelCtl.claim(first.id, false), null);
    assert.equal(claimOf(first.id)?.username, "tomas");
    const sent = server.requests.filter((r) => r.path.endsWith(`/messages/${first.id}/claim`));
    assert.equal(sent.length, 1);
    assert.equal(await channelCtl.claim(first.id, true), null);
    assert.equal(claimOf(first.id), undefined);

    // Someone else took the second message first: the tap is refused and the row shows them.
    server.claims.set(second.id, { username: "dev", claimedAt: at });
    assert.match((await channelCtl.claim(second.id, false)) ?? "", /already taken by "dev"/);
    assert.equal(claimOf(second.id)?.username, "dev");
    assert.equal(await channelCtl.claim(99, false), "That message is no longer loaded.");
  } finally {
    await server.close();
  }
});

test("claims made and released elsewhere arrive with the reactions refresh", async () => {
  const server = await startMockServer();
  try {
    const first = server.post("general", "lead", "Deploy the worker");
    server.claims.set(first.id, { username: "dev", claimedAt: at });
    const { channelCtl } = await open(server);
    const claimOf = (id: number) => channelCtl.state.get().messages.find((m) => m.id === id)?.claim;
    await waitFor(() => claimOf(first.id)?.username === "dev", "claim loaded with the message");

    // Released elsewhere: no event is sent, so the next sync's refresh clears it.
    server.claims.delete(first.id);
    const second = server.post("general", "lead", "next");
    await waitFor(() => channelCtl.state.get().messages.some((m) => m.id === second.id), "second loaded");
    await waitFor(() => claimOf(first.id) === undefined, "release shown");

    // A server from before ADR 0075 lists no claims: what is shown stays.
    server.claims.set(second.id, { username: "qa", claimedAt: at });
    const third = server.post("general", "lead", "third");
    await waitFor(() => claimOf(second.id)?.username === "qa", "new claim shown");
    server.listsClaims = false;
    server.claims.delete(second.id);
    server.post("general", "lead", "fourth");
    await waitFor(() => channelCtl.state.get().messages.length === 4, "fourth loaded");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(claimOf(second.id)?.username, "qa");
    assert.equal(claimOf(third.id), undefined);
  } finally {
    await server.close();
  }
});
