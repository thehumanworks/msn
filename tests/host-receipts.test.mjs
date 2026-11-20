// Processing commits from `msn run` go to the server by default (ADR 0053), so processed-by
// receipts (ADR 0040) name the agent. Same claim/generation fence as `msn peek` (ADR 0034).
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { serverCommitsEnabled } from "../scripts/host/server-commits.mjs";
import { hostFixture } from "./support/host-fixture.mjs";

const processingPosts = (f) => f.requests.filter((r) => r.path.includes("/processing/"));

test("a finished turn commits its message on the server under the agent's name", async (t) => {
  const f = await hostFixture(t);
  f.post({ to: "alice", text: "one" });
  await f.message((m) => m.text === "done:one");
  // Message 1 is the human post; alice's reply (2) is ignored by alice and handled by bob.
  await f.committed("alice", 2);
  const row = f.processing.get("work/alice");
  assert.equal(row.generation, 1);
  assert.match(row.holder, /\(msn run\)$/);
  // bob was not addressed, but finished with message 1 as well: a watermark covers skipped messages.
  await f.committed("bob", 1);
  assert.ok(processingPosts(f).some((r) => r.path.endsWith("/processing/alice/claim")));
});

test("restart reuses the saved generation instead of claiming again", async (t) => {
  const f = await hostFixture(t);
  f.post({ to: "alice", text: "first" });
  await f.committed("alice", 2);
  await f.stop();
  f.start();
  f.post({ to: "alice", text: "second" });
  await f.message((m) => m.text === "done:second");
  await f.committed("alice", 4);
  const claims = processingPosts(f).filter((r) => r.who === "alice" && r.path.endsWith("/claim"));
  assert.equal(claims.length, 1);
  assert.equal(f.processing.get("work/alice").generation, 1);
});

test("a takeover on another machine stops the replaced agent; its peer keeps working", async (t) => {
  const f = await hostFixture(t);
  f.post({ to: "alice", text: "before" });
  await f.committed("alice", 2);
  f.takeover("alice");
  f.post({ to: "alice", text: "after" });
  const stopped = await f.log((e) => e.type === "agent.stopped" && e.agent === "alice");
  assert.equal(stopped.reason, "processing_fenced");
  // The fence held: the replaced generation never moved the server's progress.
  assert.equal(f.processing.get("work/alice").committedThrough, 2);
  f.post({ to: "bob", text: "still here" });
  await f.message((m) => m.text === "done:still here");
});

test("a reader held by another machine is left alone: no takeover, no receipts, work goes on", async (t) => {
  const f = await hostFixture(t);
  f.processing.set("work/alice", { generation: 3, holder: "old-box", committedThrough: 0 });
  f.post({ to: "alice", text: "held" });
  await f.message((m) => m.text === "done:held");
  const log = await f.log((e) => e.type === "receipts.unavailable" && e.agent === "alice");
  assert.equal(log.reason, "processing_held");
  assert.deepEqual(f.processing.get("work/alice"), { generation: 3, holder: "old-box", committedThrough: 0 });
  f.post({ to: "alice", text: "again" });
  await f.message((m) => m.text === "done:again");
  // One refused claim, then nothing more for that reader in this run.
  assert.equal(processingPosts(f).filter((r) => r.who === "alice").length, 1);
  assert.equal(f.logs.filter((e) => e.type === "receipts.unavailable" && e.agent === "alice").length, 1);
});

test("a server without processing routes keeps the agent working with progress kept locally", async (t) => {
  const f = await hostFixture(t, { processing: false });
  f.post({ to: "alice", text: "old server" });
  await f.message((m) => m.text === "done:old server");
  const log = await f.log((e) => e.type === "receipts.unavailable" && e.agent === "alice");
  assert.equal(log.reason, "route_not_found");
  assert.equal(f.status().failures.length, 0);
});

for (const [label, options] of [
  ["serverCommits: false in the config", { serverCommits: false }],
  ["MSN_RESUMABLE=0", { env: { MSN_RESUMABLE: "0" } }],
]) {
  test(`${label} keeps processing progress local`, async (t) => {
    const f = await hostFixture(t, options);
    f.post({ to: "alice", text: "local" });
    await f.message((m) => m.text === "done:local");
    await delay(200);
    assert.equal(processingPosts(f).length, 0);
    assert.equal(f.processing.size, 0);
  });
}

test("a queued or paused message holds the watermark below it", async (t) => {
  const f = await hostFixture(t, { shared: true, maxConcurrent: 1 });
  f.post({ to: "alice", text: "a" });
  await f.committed("alice", 2);
  f.board.status = "paused";
  f.board.revision++;
  f.post({ to: "alice", text: "b" });
  for (let i = 0; i < 100 && !f.status().jobs.some((j) => j.status === "paused"); i++) await delay(20);
  assert.ok(f.status().jobs.some((j) => j.status === "paused" && j.count >= 1));
  await delay(200);
  // Message 3 is paused for alice, so nothing past 2 is committed.
  assert.equal(f.processing.get("work/alice").committedThrough, 2);
});

test("serverCommitsEnabled: config false or a falsey MSN_RESUMABLE turns commits off", () => {
  assert.equal(serverCommitsEnabled(true, {}), true);
  assert.equal(serverCommitsEnabled(undefined, { MSN_RESUMABLE: "" }), true);
  assert.equal(serverCommitsEnabled(true, { MSN_RESUMABLE: "1" }), true);
  assert.equal(serverCommitsEnabled(false, { MSN_RESUMABLE: "1" }), false);
  for (const value of ["0", "false", "no", "off", "n", "f", " OFF "])
    assert.equal(serverCommitsEnabled(true, { MSN_RESUMABLE: value }), false, value);
});
