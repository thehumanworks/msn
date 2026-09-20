import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import {
  ACTIVE_PROFILE_KEY,
  listProfiles,
  MAX_PROFILES,
  migrateLegacySession,
  planProfileName,
  PROFILE_INDEX_KEY,
  profileKey,
  readActive,
  readProfile,
  removeProfile,
  summarize,
  writeActive,
  writeProfile,
} from "../src/core/profileStorage.ts";
import { SESSION_KEY } from "../src/core/sessionStorage.ts";
import type { Session } from "../src/core/session.ts";
import { TEST_TOKEN } from "./support/mockServer.ts";
import { memoryStore } from "./support/util.ts";

const session = (over: Partial<Session> = {}): Session => ({
  origin: "https://msn.example",
  tenant: "acme",
  token: TEST_TOKEN,
  username: "tomas",
  usernamePrefix: null,
  ...over,
});

test("profiles round-trip; summaries never contain the key", async () => {
  const store = memoryStore();
  await writeProfile(store, "tomas-acme", session());
  await writeProfile(store, "asha-acme", session({ username: "asha", channel: "general" }));
  assert.deepEqual(await readProfile(store, "tomas-acme"), session());
  const profiles = await listProfiles(store);
  assert.deepEqual(profiles, [
    { name: "asha-acme", origin: "https://msn.example", tenant: "acme", username: "asha", channel: "general" },
    { name: "tomas-acme", origin: "https://msn.example", tenant: "acme", username: "tomas" },
  ]);
  assert.equal(JSON.stringify(profiles).includes(TEST_TOKEN), false);
  assert.equal(store.data.get(PROFILE_INDEX_KEY)!.includes(TEST_TOKEN), false, "the index holds names only");
});

test("names follow the user and workspace; the same user reuses their profile; others never collide", () => {
  assert.equal(planProfileName([], session({ username: "Alice B." })), "alice-b-acme");
  assert.equal(planProfileName([], session({ username: "日本" })), "acme");
  const existing = [summarize("tomas-acme", session())];
  assert.equal(planProfileName(existing, session({ token: "z".repeat(64) })), "tomas-acme", "a rotated key replaces its own profile");
  assert.equal(planProfileName(existing, session({ origin: "https://other.example" })), "tomas-acme-2", "another server is another user");
  assert.equal(planProfileName(existing, session({ channel: "general" })), "tomas-acme-2", "a channel-scoped key is a different identity");
  const long = planProfileName([], session({ username: "x".repeat(128), tenant: "t".repeat(64) }))!;
  assert.match(long, /^[a-z0-9][a-z0-9_-]{0,63}$/);
  const full = Array.from({ length: MAX_PROFILES }, (_, i) => summarize(`user${i}-acme`, session({ username: `user${i}` })));
  assert.equal(planProfileName(full, session({ username: "one-more" })), null);
  assert.equal(planProfileName(full, session({ username: "user3" })), "user3-acme", "a full device can still refresh a saved user");
});

test("every stored key is always listed, even when a write is interrupted", async () => {
  // Secure storage cannot enumerate keys: an unlisted key could never be found or forgotten again.
  const store = memoryStore();
  const realSet = store.set;
  store.set = async (key, value) => {
    if (key === profileKey("tomas-acme")) throw new Error("interrupted");
    await realSet(key, value);
  };
  await assert.rejects(writeProfile(store, "tomas-acme", session()));
  assert.equal(store.data.has(profileKey("tomas-acme")), false);
  store.set = realSet;
  assert.deepEqual(await listProfiles(store), [], "the dangling name heals itself away");
  assert.equal(store.data.has(PROFILE_INDEX_KEY), false);

  await writeProfile(store, "tomas-acme", session());
  store.failRemove = true;
  await assert.rejects(removeProfile(store, "tomas-acme"));
  assert.deepEqual((await listProfiles(store)).map((p) => p.name), ["tomas-acme"], "a key that could not be deleted stays listed");
  store.failRemove = false;
  await removeProfile(store, "tomas-acme");
  assert.equal(store.data.size, 0);
});

test("corrupt, tampered or insecure profiles are removed and unlisted; a corrupt index is empty", async () => {
  const store = memoryStore();
  await writeProfile(store, "tomas-acme", session());
  await writeProfile(store, "asha-acme", session({ username: "asha" }));
  await writeActive(store, "tomas-acme");
  store.data.set(profileKey("tomas-acme"), JSON.stringify(session({ origin: "http://msn.example" })));
  assert.equal(await readProfile(store, "tomas-acme"), null);
  assert.equal(store.data.has(profileKey("tomas-acme")), false);
  assert.equal(await readActive(store), null, "the active pointer never dangles");
  assert.deepEqual((await listProfiles(store)).map((p) => p.name), ["asha-acme"]);

  assert.equal(await readProfile(store, "../escape"), null);
  store.data.set(PROFILE_INDEX_KEY, "{not json");
  assert.deepEqual(await listProfiles(store), []);
  store.data.set(PROFILE_INDEX_KEY, JSON.stringify(["Bad Name", 7, "asha-acme", "asha-acme"]));
  assert.deepEqual((await listProfiles(store)).map((p) => p.name), ["asha-acme"]);
  store.data.set(ACTIVE_PROFILE_KEY, "Bad Name");
  assert.equal(await readActive(store), null);
});

test("the device holds a bounded number of profiles", async () => {
  const store = memoryStore();
  for (let i = 0; i < MAX_PROFILES; i += 1) await writeProfile(store, `user${i}-acme`, session({ username: `user${i}` }));
  await assert.rejects(writeProfile(store, "one-more-acme", session({ username: "one-more" })), /Too many/);
  await writeProfile(store, "user3-acme", session({ username: "user3", token: "z".repeat(64) }));
  assert.equal((await readProfile(store, "user3-acme"))?.token, "z".repeat(64));
});

test("legacy migration is idempotent, keeps existing profiles and drops corrupt legacy data", async () => {
  const store = memoryStore({ [SESSION_KEY]: JSON.stringify(session()) });
  await writeProfile(store, "asha-acme", session({ username: "asha" }));
  await migrateLegacySession(store);
  await migrateLegacySession(store);
  assert.deepEqual((await listProfiles(store)).map((p) => p.name), ["asha-acme", "tomas-acme"]);
  assert.equal(await readActive(store), "tomas-acme");
  assert.equal(store.data.has(SESSION_KEY), false);

  const corrupt = memoryStore({ [SESSION_KEY]: "{not json" });
  await migrateLegacySession(corrupt);
  assert.equal(corrupt.data.size, 0);

  // If the profile cannot be written, the legacy key is kept rather than lost.
  const failing = memoryStore({ [SESSION_KEY]: JSON.stringify(session()) });
  failing.failSet = true;
  await assert.rejects(migrateLegacySession(failing));
  assert.equal(failing.data.has(SESSION_KEY), true);
});
