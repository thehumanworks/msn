import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { SessionController } from "../src/core/sessionController.ts";
import type { Session } from "../src/core/session.ts";
import type { CoordinationEvent } from "../src/core/types.ts";
import { track } from "./support/bounded.ts";
import { startMockServer, TEST_TOKEN, type MockServerHandle } from "./support/mockServer.ts";
import { nodeFetch, waitFor } from "./support/util.ts";

const fast = { stream: { waitSeconds: 1, backoff: { baseMs: 5, maxMs: 20 } }, connectBackoff: { baseMs: 5, maxMs: 20 } };

function session(server: MockServerHandle): Session {
  return { origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", usernamePrefix: null };
}

async function connected(server: MockServerHandle, onAuthExpired?: () => void) {
  const ctl = track(new SessionController(session(server), { ...fast, fetchImpl: nodeFetch, onAuthExpired }));
  const seen: CoordinationEvent[] = [];
  ctl.onEvent((e) => void seen.push(e));
  await ctl.start();
  return { ctl, seen };
}

test("the event cursor is drained to the tip before the session is ready", async () => {
  const server = await startMockServer();
  try {
    for (let i = 0; i < 3; i += 1) server.post("general", "asha", `old ${i}`);
    const { ctl, seen } = await connected(server);
    assert.equal(ctl.state.get().ready, true);
    assert.equal(ctl.cursor, server.events.at(-1)!.id);
    // Pre-existing events are covered by canonical reads and are not replayed as new events.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.length, 0);
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("events after bootstrap are dispatched in order via a held long poll (no polling loop)", async () => {
  const server = await startMockServer();
  try {
    const { ctl, seen } = await connected(server);
    await waitFor(() => server.pendingPolls() === 1, "held poll");
    const before = server.requests.length;
    server.post("general", "asha", "one");
    server.post("general", "asha", "two");
    await waitFor(() => seen.filter((e) => e.type === "message.created").length === 2, "events");
    assert.deepEqual(seen.map((e) => e.id), [...seen.map((e) => e.id)].sort((a, b) => a - b));
    // A handful of requests for two events, not a fast timer.
    assert.ok(server.requests.length - before < 8, `made ${server.requests.length - before} requests`);
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("pause cancels the held poll; resume replays what happened meanwhile without gaps", async () => {
  const server = await startMockServer();
  try {
    const { ctl, seen } = await connected(server);
    await waitFor(() => server.pendingPolls() === 1, "held poll");
    ctl.pause();
    assert.equal(ctl.state.get().kind, "paused");
    assert.equal(ctl.signal.aborted, true);
    await waitFor(() => server.pendingPolls() === 0, "poll cancelled");
    const requestsWhilePaused = server.requests.length;
    const m = server.post("general", "asha", "while backgrounded");
    server.remove(m.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(server.requests.length, requestsWhilePaused, "no requests while paused");
    ctl.resume();
    assert.equal(ctl.signal.aborted, false);
    await waitFor(() => seen.some((e) => e.type === "message.deleted"), "replayed deletion");
    assert.deepEqual(seen.map((e) => e.type), ["channel.created", "message.created", "message.deleted"]);
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("a revoked key stops polling, reports expiry once and never reconnects", async () => {
  const server = await startMockServer();
  try {
    let expired = 0;
    const { ctl } = await connected(server, () => void (expired += 1));
    await waitFor(() => server.pendingPolls() === 1, "held poll");
    server.revoke();
    await waitFor(() => ctl.state.get().kind === "expired", "expiry");
    const count = server.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(expired, 1);
    assert.equal(server.requests.length, count);
    ctl.resume();
    ctl.pause();
    assert.equal(ctl.state.get().kind, "expired");
  } finally {
    await server.close();
  }
});

test("transient failures back off and recover, staying subscribed", async () => {
  const server = await startMockServer();
  try {
    const { ctl, seen } = await connected(server);
    server.fail((p) => p.endsWith("/events"), 2, 503);
    server.post("general", "asha", "x");
    await waitFor(() => seen.some((e) => e.type === "message.created"), "recovered event");
    assert.equal(ctl.state.get().kind, "live");
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("connect failures retry with backoff until the server answers", async () => {
  const server = await startMockServer();
  try {
    server.fail((p) => p === "/api/tenants/acme", 2, 503);
    const ctl = track(new SessionController(session(server), { ...fast, fetchImpl: nodeFetch }));
    await ctl.start();
    assert.equal(ctl.state.get().ready, true);
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("a scope change on the key is a fatal, non-silent failure", async () => {
  const server = await startMockServer();
  try {
    const scoped: Session = { ...session(server), channel: "general" }; // server says: unscoped
    const ctl = track(new SessionController(scoped, { ...fast, fetchImpl: nodeFetch }));
    await ctl.start();
    assert.equal(ctl.state.get().kind, "failed");
    assert.equal(ctl.state.get().ready, false);
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("dispose stops everything and is idempotent", async () => {
  const server = await startMockServer();
  try {
    const { ctl } = await connected(server);
    await waitFor(() => server.pendingPolls() === 1, "held poll");
    ctl.dispose();
    ctl.dispose();
    await waitFor(() => server.pendingPolls() === 0, "poll cancelled");
    const count = server.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(server.requests.length, count);
  } finally {
    await server.close();
  }
});
