import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { AppModel } from "../src/core/appModel.ts";
import { ACTIVE_PROFILE_KEY, listProfiles, readProfile, writeProfile } from "../src/core/profileStorage.ts";
import { SESSION_KEY, forgetSession, isSession, loadSession, saveSession, type SecretStore } from "../src/core/sessionStorage.ts";
import type { Session } from "../src/core/session.ts";
import { SCOPED_TOKEN, startMockServer, TEST_TOKEN, type MockServerHandle } from "./support/mockServer.ts";
import { memoryStore, nodeFetch, waitFor } from "./support/util.ts";

const fastController = { stream: { waitSeconds: 1, backoff: { baseMs: 5, maxMs: 20 } }, connectBackoff: { baseMs: 5, maxMs: 20 } };

function model(store: SecretStore) {
  return new AppModel(store, { fetchImpl: nodeFetch, controller: fastController });
}

function sessionFor(server: MockServerHandle, over: Partial<Session> = {}): Session {
  return { origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", usernamePrefix: null, ...over };
}

/** The session saved under a profile name, read the way the app reads it. */
const stored = (store: SecretStore, name: string) => readProfile(store, name);
const names = async (store: SecretStore) => (await listProfiles(store)).map((profile) => profile.name);
const active = (store: ReturnType<typeof memoryStore>) => store.data.get(ACTIVE_PROFILE_KEY) ?? null;

function dispose(app: AppModel) {
  const s = app.state.get();
  if (s.kind === "connected") s.controller.dispose();
}

// ---- storage ------------------------------------------------------------------------------

test("saved sessions round-trip and are validated on load", async () => {
  const store = memoryStore();
  const session: Session = { origin: "https://msn.example", tenant: "acme", token: TEST_TOKEN, username: "tomas", usernamePrefix: null };
  await saveSession(store, session);
  assert.deepEqual(await loadSession(store), session);
});

test("corrupt, insecure or tampered stored sessions are rejected and removed", async () => {
  const good = { origin: "https://msn.example", tenant: "acme", token: TEST_TOKEN, username: "t", usernamePrefix: null };
  const bad: unknown[] = [
    { ...good, origin: "http://msn.example" },
    { ...good, origin: "https://msn.example/path" },
    { ...good, origin: "https://user:pw@msn.example" },
    { ...good, origin: "https://msn.example?x=1" },
    { ...good, token: "short" },
    { ...good, tenant: "Bad Tenant" },
    { ...good, username: "" },
    { ...good, channel: "Not A Slug" },
  ];
  for (const value of bad) {
    assert.equal(isSession(value), false);
    const store = memoryStore({ [SESSION_KEY]: JSON.stringify(value) });
    assert.equal(await loadSession(store), null);
    assert.equal(store.data.has(SESSION_KEY), false, "invalid data is deleted");
  }
  const garbage = memoryStore({ [SESSION_KEY]: "{not json" });
  assert.equal(await loadSession(garbage), null);
  assert.equal(garbage.data.has(SESSION_KEY), false);
});

test("forgetSession reports failure instead of pretending the token is gone", async () => {
  const store = memoryStore({ [SESSION_KEY]: "x" });
  store.failRemove = true;
  assert.equal(await forgetSession(store), false);
  store.failRemove = false;
  assert.equal(await forgetSession(store), true);
});

test("localhost development origins are accepted for storage; other http is not", () => {
  const base = { tenant: "acme", token: TEST_TOKEN, username: "t", usernamePrefix: null };
  assert.equal(isSession({ ...base, origin: "http://localhost:8787" }), true);
  assert.equal(isSession({ ...base, origin: "http://192.168.1.5:8787" }), false);
});

// ---- app model ----------------------------------------------------------------------------

test("sign in with a key: saves a profile named after the user when asked and starts one live session", async () => {
  const server = await startMockServer();
  const store = memoryStore();
  const app = model(store);
  try {
    const error = await app.signInWithKey({ origin: server.url, tenant: " acme ", token: ` ${TEST_TOKEN} `, username: " tomas ", remember: true });
    assert.equal(error, null);
    await app.settled();
    const state = app.state.get();
    assert.equal(state.kind, "connected");
    assert.deepEqual(await names(store), ["tomas-acme"]);
    assert.deepEqual(await stored(store, "tomas-acme"), sessionFor(server));
    assert.equal(active(store), "tomas-acme", "reopened on next launch");
    assert.equal(store.data.has(SESSION_KEY), false, "the legacy single-session slot is no longer written");
    // Trimmed tenant is what reached the API.
    assert.ok(server.requests.every((r) => r.path.startsWith("/api/tenants/acme")));
    await waitFor(() => state.kind === "connected" && state.controller.state.get().ready, "ready");
  } finally {
    dispose(app);
    await server.close();
  }
});

test("without Remember nothing new is stored: that user's older profile is removed, other users' are kept", async () => {
  const server = await startMockServer();
  const store = memoryStore();
  await writeProfile(store, "tomas-acme", sessionFor(server));
  await writeProfile(store, "old-acme", sessionFor(server, { username: "old" }));
  store.data.set(ACTIVE_PROFILE_KEY, "tomas-acme");
  const app = model(store);
  try {
    assert.equal(await app.signInWithKey({ origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", remember: false }), null);
    await app.settled();
    assert.deepEqual(await names(store), ["old-acme"]);
    assert.equal(active(store), null, "an unsaved session is not reopened on launch");
  } finally {
    dispose(app);
    await server.close();
  }
});

test("bad input is rejected before any network request", async () => {
  const server = await startMockServer();
  const app = model(memoryStore());
  try {
    assert.match((await app.signInWithKey({ origin: "http://msn.example", tenant: "acme", token: TEST_TOKEN, username: "t", remember: false }))!, /https/);
    assert.match((await app.signInWithKey({ origin: server.url + "/x", tenant: "acme", token: TEST_TOKEN, username: "t", remember: false }))!, /origin/i);
    assert.match((await app.signInWithKey({ origin: server.url, tenant: "Bad Tenant", token: TEST_TOKEN, username: "t", remember: false }))!, /Workspace/);
    assert.match((await app.signInWithKey({ origin: server.url, tenant: "acme", token: "short", username: "t", remember: false }))!, /Access keys/);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("a rejected key returns a message and leaves the previous session untouched", async () => {
  const server = await startMockServer();
  const store = memoryStore();
  const app = model(store);
  try {
    await app.signInWithKey({ origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", remember: true });
    await app.settled();
    const before = app.state.get();
    const error = await app.signInWithKey({ origin: server.url, tenant: "acme", token: "z".repeat(64), username: "x", remember: true });
    assert.match(error!, /not accepted/);
    assert.equal(app.state.get(), before);
    assert.equal((await stored(store, "tomas-acme"))?.token, TEST_TOKEN);
    assert.deepEqual(await names(store), ["tomas-acme"], "a rejected key is never saved");
  } finally {
    dispose(app);
    await server.close();
  }
});

test("create workspace and redeem invitation adopt the returned scoped key", async () => {
  const server = await startMockServer();
  const app = model(memoryStore());
  try {
    assert.equal(await app.createWorkspace({ origin: server.url, tenant: "acme", username: "tomas", channel: "general", remember: false }), null);
    dispose(app);
    assert.equal(await app.redeemInvitation({ origin: server.url, tenant: "acme", code: "acme." + "0".repeat(64), username: "asha", remember: false }), null);
    const state = app.state.get();
    assert.equal(state.kind === "connected" && state.controller.session.channel, "scoped");
    assert.equal(state.kind === "connected" && state.controller.session.token, SCOPED_TOKEN);
  } finally {
    dispose(app);
    await server.close();
  }
});

test("a username prefix binding is enforced client-side", async () => {
  const fetchImpl = async (input: string) =>
    new Response(JSON.stringify({ tenant: "acme", username: null, usernamePrefix: "bot-" }), { status: 200, headers: { "Content-Type": "application/json" } });
  const app = new AppModel(memoryStore(), { fetchImpl: fetchImpl as never, controller: fastController });
  const error = await app.signInWithKey({ origin: "https://msn.example", tenant: "acme", token: TEST_TOKEN, username: "human", remember: false });
  assert.match(error!, /bot-/);
  assert.equal(app.state.get().kind, "hydrating");
});

test("hydration restores a remembered session; a slow hydration cannot overwrite a newer sign-in", async () => {
  const server = await startMockServer();
  const inner = memoryStore({ [SESSION_KEY]: JSON.stringify(sessionFor(server, { username: "remembered" })) });
  let releaseGet: () => void = () => {};
  const gate = new Promise<void>((resolve) => (releaseGet = resolve));
  const slow: SecretStore = { ...inner, get: async (k) => (await gate, inner.get(k)), set: inner.set, remove: inner.remove };
  const app = model(slow);
  try {
    const hydrating = app.hydrate();
    assert.equal(await app.signInWithKey({ origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "fresh", remember: false }), null);
    releaseGet();
    await hydrating;
    const state = app.state.get();
    assert.equal(state.kind === "connected" && state.controller.session.username, "fresh");
  } finally {
    dispose(app);
    await server.close();
  }
});

test("hydration with nothing stored, corrupt data or an unreadable keychain ends signed out", async () => {
  const empty = model(memoryStore());
  await empty.hydrate();
  assert.deepEqual(empty.state.get(), { kind: "signedOut", notice: null, profiles: [] });
  const broken = memoryStore();
  broken.failGet = true;
  const app = model(broken);
  await app.hydrate();
  const state = app.state.get();
  assert.equal(state.kind, "signedOut");
  assert.match(state.kind === "signedOut" ? state.notice! : "", /Secure storage/);
});

test("hydrated sessions connect and go live", async () => {
  const server = await startMockServer();
  const app = model(memoryStore({ [SESSION_KEY]: JSON.stringify(sessionFor(server)) }));
  try {
    await app.hydrate();
    const state = app.state.get();
    assert.equal(state.kind, "connected");
    await waitFor(() => state.kind === "connected" && state.controller.state.get().ready, "ready");
  } finally {
    dispose(app);
    await server.close();
  }
});

test("the single remembered session of older versions becomes a profile and stays signed in", async () => {
  const server = await startMockServer();
  const store = memoryStore({ [SESSION_KEY]: JSON.stringify(sessionFor(server)) });
  const app = model(store);
  try {
    await app.hydrate();
    assert.equal(app.state.get().kind, "connected");
    assert.equal(store.data.has(SESSION_KEY), false, "the legacy slot is removed after the profile is written");
    assert.deepEqual(await stored(store, "tomas-acme"), sessionFor(server));
    assert.equal(active(store), "tomas-acme");
  } finally {
    dispose(app);
    await server.close();
  }
});

test("sign out keeps the profile for switching back; sign out and forget deletes the key", async () => {
  const server = await startMockServer();
  const store = memoryStore();
  const app = model(store);
  try {
    await app.signInWithKey({ origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", remember: true });
    await app.settled();
    const first = app.state.get();
    await app.signOut();
    const out = app.state.get();
    assert.equal(out.kind, "signedOut");
    assert.equal(first.kind === "connected" && first.controller.isTerminal, true);
    assert.deepEqual(out.kind === "signedOut" && out.profiles.map((p) => p.name), ["tomas-acme"]);
    assert.equal(active(store), null, "a signed-out profile is not reopened on launch");
    assert.equal(JSON.stringify(out).includes(TEST_TOKEN), false, "the picker never holds a key");

    // Switch back with one tap, then forget it.
    assert.equal(await app.connectProfile("tomas-acme"), null);
    await app.settled();
    const again = app.state.get();
    assert.equal(again.kind === "connected" && again.controller.session.token, TEST_TOKEN);
    assert.equal(active(store), "tomas-acme");
    await app.signOut(null, { forget: true });
    assert.equal(store.data.size, 0, "nothing of the profile remains");
    const gone = app.state.get();
    assert.deepEqual(gone.kind === "signedOut" && gone.profiles, []);

    await app.signInWithKey({ origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", remember: true });
    await app.settled();
    store.failRemove = true;
    await app.signOut(null, { forget: true });
    const state = app.state.get();
    assert.match(state.kind === "signedOut" ? state.notice! : "", /could not be removed/);
    assert.deepEqual(state.kind === "signedOut" && state.profiles.map((p) => p.name), ["tomas-acme"], "still listed, so it can be retried");
  } finally {
    dispose(app);
    await server.close();
  }
});

test("saved profiles can be forgotten from the sign-in screen; a missing profile reports itself", async () => {
  const server = await startMockServer();
  const store = memoryStore();
  await writeProfile(store, "tomas-acme", sessionFor(server));
  await writeProfile(store, "asha-acme", sessionFor(server, { username: "asha" }));
  const app = model(store);
  try {
    await app.hydrate();
    const listed = app.state.get();
    assert.deepEqual(listed.kind === "signedOut" && listed.profiles.map((p) => p.name), ["asha-acme", "tomas-acme"]);
    assert.equal(await app.forgetProfile("asha-acme"), null);
    const after = app.state.get();
    assert.deepEqual(after.kind === "signedOut" && after.profiles.map((p) => p.name), ["tomas-acme"]);
    assert.equal(await stored(store, "asha-acme"), null);
    assert.match((await app.connectProfile("asha-acme"))!, /no longer available/);
    assert.equal(app.state.get().kind, "signedOut");
  } finally {
    dispose(app);
    await server.close();
  }
});

test("a slow save that began before sign-out-and-forget cannot resurrect the credential", async () => {
  const server = await startMockServer();
  const inner = memoryStore();
  let releaseSet: () => void = () => {};
  const gate = new Promise<void>((resolve) => (releaseSet = resolve));
  const slow: SecretStore = {
    get: inner.get,
    remove: inner.remove,
    set: async (k, v) => {
      await gate;
      await inner.set(k, v);
    },
  };
  const app = model(slow);
  try {
    await app.signInWithKey({ origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", remember: true });
    const signedOut = app.signOut(null, { forget: true }); // requested while the first save is still in flight
    releaseSet();
    await signedOut;
    await app.settled();
    assert.equal(inner.data.size, 0, "the newest intent (forgotten) wins");
  } finally {
    await server.close();
  }
});

test("rapid account swaps save both users and end with the last account active", async () => {
  const server = await startMockServer();
  const inner = memoryStore();
  const delays = [40, 5];
  const slow: SecretStore = {
    get: inner.get,
    remove: inner.remove,
    set: async (k, v) => {
      await new Promise((resolve) => setTimeout(resolve, delays.shift() ?? 0));
      await inner.set(k, v);
    },
  };
  const app = model(slow);
  try {
    await app.signInWithKey({ origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "first", remember: true });
    await app.signInWithKey({ origin: server.url, tenant: "acme", token: SCOPED_TOKEN, username: "second", remember: true });
    await app.settled();
    assert.deepEqual(await names(inner), ["first-acme", "second-acme"]);
    assert.equal((await stored(inner, "first-acme"))?.token, TEST_TOKEN, "one user's save never overwrites another's");
    assert.equal((await stored(inner, "second-acme"))?.token, SCOPED_TOKEN);
    assert.equal(active(inner), "second-acme");
    const state = app.state.get();
    assert.equal(state.kind === "connected" && state.controller.session.username, "second");
  } finally {
    dispose(app);
    await server.close();
  }
});

test("a failed save warns but stays connected; signing in without Remember clears a stuck older key", async () => {
  const server = await startMockServer();
  const store = memoryStore();
  store.failSet = true;
  const app = model(store);
  try {
    await app.signInWithKey({ origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", remember: true });
    await app.settled();
    await waitFor(() => {
      const s = app.state.get();
      return s.kind === "connected" && s.warning !== null;
    }, "warning");
  } finally {
    dispose(app);
    await server.close();
  }
});

test("a revoked key signs out, removes the remembered token and ignores stale sessions", async () => {
  const server = await startMockServer();
  const store = memoryStore();
  const app = model(store);
  try {
    await app.signInWithKey({ origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", remember: true });
    await app.settled();
    const state = app.state.get();
    assert.equal(state.kind, "connected");
    await waitFor(() => server.pendingPolls() === 1, "held poll");
    server.revoke(TEST_TOKEN);
    await waitFor(() => app.state.get().kind === "signedOut", "signed out");
    await app.settled();
    assert.equal(store.data.size, 0);
    const out = app.state.get();
    assert.match(out.kind === "signedOut" ? out.notice! : "", /revoked/);
  } finally {
    dispose(app);
    await server.close();
  }
});

test("revocation of the old account while signing into another does not cancel the new sign-in", async () => {
  const server = await startMockServer();
  const store = memoryStore();
  const app = model(store);
  try {
    await app.signInWithKey({ origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "one", remember: true });
    await waitFor(() => server.pendingPolls() === 1, "held poll");
    const hold = server.hold((p) => p === "/api/tenants/acme");
    const signingIn = app.signInWithKey({ origin: server.url, tenant: "acme", token: SCOPED_TOKEN, username: "two", remember: true });
    server.revoke(TEST_TOKEN);
    await waitFor(() => app.state.get().kind === "signedOut", "old session dropped");
    hold.release();
    assert.equal(await signingIn, null);
    await app.settled();
    const state = app.state.get();
    assert.equal(state.kind === "connected" && state.controller.session.token, SCOPED_TOKEN);
    assert.deepEqual(await names(store), ["two-acme"], "the revoked user's profile is deleted, the new one kept");
    assert.equal((await stored(store, "two-acme"))?.token, SCOPED_TOKEN);
    assert.equal(active(store), "two-acme");
  } finally {
    dispose(app);
    await server.close();
  }
});
