import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { AppModel } from "../src/core/appModel.ts";
import { ChannelListController } from "../src/core/channelList.ts";
import {
  advanceMarks,
  currentUnread,
  decodeUnread,
  MAX_MARKS,
  marksForListed,
  parseMarks,
  ReadMarks,
  readMarksKey,
  seenMark,
  UNREAD_BOARDS,
  unreadBadge,
  type MarkList,
} from "../src/core/readMarks.ts";
import { SessionController } from "../src/core/sessionController.ts";
import { track } from "./support/bounded.ts";
import { startMockServer, TEST_TOKEN } from "./support/mockServer.ts";
import { memoryStore, nodeFetch, waitFor } from "./support/util.ts";

// Unread counts (ADR 0045): read marks kept on this device, counts from the server above them.

const fast = { stream: { waitSeconds: 1, backoff: { baseMs: 5, maxMs: 20 } }, connectBackoff: { baseMs: 5, maxMs: 20 } };

test("marks move forward only, keep the most recent boards and parse defensively", () => {
  let marks: MarkList = [];
  marks = advanceMarks(marks, "work", 10)!;
  assert.equal(advanceMarks(marks, "work", 10), null);
  assert.equal(advanceMarks(marks, "work", 3), null);
  assert.equal(advanceMarks(marks, "work", -1), null);
  marks = advanceMarks(marks, "ops", 4)!;
  marks = advanceMarks(marks, "work", 12)!;
  assert.deepEqual(marks, [["ops", 4], ["work", 12]]);
  assert.deepEqual(marksForListed(marks, ["work", "new"]), [["work", 12]]);
  for (let i = 0; i < MAX_MARKS; i += 1) marks = advanceMarks(marks, `b${i}`, 1)!;
  assert.equal(marks.length, MAX_MARKS);
  assert.equal(marks.some(([name]) => name === "ops"), false, "the oldest mark is dropped");
  assert.equal(marksForListed(marks, marks.map(([name]) => name)).length, UNREAD_BOARDS);
  assert.deepEqual(parseMarks('[["ok",2],["Bad Name",1],["neg",-1],"x",["ok",1]]'), [["ok", 2]]);
  assert.deepEqual(parseMarks("{not json"), []);
  assert.deepEqual(parseMarks(null), []);
  assert.match(readMarksKey({ origin: "https://a", tenant: "t", username: "u" }), /^msn\.read\.v1\.[0-9a-f]{16}$/);
  assert.notEqual(
    readMarksKey({ origin: "https://a", tenant: "t", username: "u" }),
    readMarksKey({ origin: "https://a", tenant: "t", username: "v" }),
  );
});

test("what is on screen is read, but not past a folded reply", () => {
  assert.equal(seenMark([3, 9, 5], []), 9);
  assert.equal(seenMark([3, 9, 5], [7, 8]), 6);
  assert.equal(seenMark([], []), null);
});

test("counts apply only to the mark they were asked for; badge text", () => {
  const asked: MarkList = [["work", 7], ["ops", 3]];
  const counts = decodeUnread(
    {
      unread: [
        { channel: "work", after: 7, count: 4, toYou: 9, capped: true },
        { channel: "ops", after: 2, count: 1, toYou: 0 },
        { channel: "other", after: 1, count: 1, toYou: 0 },
      ],
    },
    asked,
  );
  assert.deepEqual([...counts.keys()], ["work"]);
  assert.deepEqual(counts.get("work"), { channel: "work", after: 7, count: 4, toYou: 4, capped: true });
  assert.throws(() => decodeUnread({}, asked));
  assert.throws(() => decodeUnread({ unread: [{ channel: "work" }] }, asked));
  assert.equal(currentUnread(counts, asked, "work")?.count, 4);
  assert.equal(currentUnread(counts, [["work", 8]], "work"), undefined, "the mark moved on");
  assert.deepEqual(unreadBadge(counts.get("work")), { count: "4+", toYou: "@4", label: "4+ unread messages, 4 to you" });
  assert.deepEqual(unreadBadge({ channel: "x", after: 0, count: 1, toYou: 0, capped: false }), {
    count: "1",
    toYou: null,
    label: "1 unread message",
  });
  assert.equal(unreadBadge(undefined), null);
});

test("marks persist in the keychain with coalesced writes, or not at all when not remembered", async () => {
  const store = memoryStore();
  const identity = { origin: "https://msn.example", tenant: "acme", username: "tomas" };
  const marks = new ReadMarks(store, identity, { saveDelayMs: 20 });
  await marks.ready;
  assert.equal(marks.advance("work", 5), true);
  assert.equal(marks.advance("work", 6), true);
  assert.equal(marks.advance("work", 6), false);
  await waitFor(() => store.data.has(readMarksKey(identity)), "saved");
  assert.equal(store.data.get(readMarksKey(identity)), '[["work",6]]');
  const again = new ReadMarks(store, identity);
  await again.ready;
  assert.equal(again.get("work"), 6);

  const other = memoryStore();
  const temporary = new ReadMarks(other, identity, { saveDelayMs: 1, persist: false });
  await temporary.ready;
  temporary.advance("work", 3);
  await temporary.flush();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(other.data.size, 0);
  assert.equal(temporary.get("work"), 3);
});

test("the channel list shows counts above this device's marks, others' messages only", async () => {
  const server = await startMockServer();
  try {
    server.createChannel("general");
    server.createChannel("ops");
    server.createChannel("never");
    const seen = server.post("ops", "asha", "already read");
    server.post("never", "asha", "never opened here");
    const store = memoryStore();
    const marks = new ReadMarks(store, { origin: server.url, tenant: "acme", username: "tomas" });
    marks.advance("ops", seen.id);
    const ctl = track(
      new SessionController(
        { origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", usernamePrefix: null },
        { ...fast, fetchImpl: nodeFetch, readMarks: marks },
      ),
    );
    await ctl.start();
    const list = track(new ChannelListController(ctl, 5));
    await list.load();
    await waitFor(() => list.state.get().unread.has("ops"), "first counts");
    assert.equal(list.state.get().unread.get("ops")?.count, 0);
    assert.equal(list.state.get().unread.has("never"), false, "no mark, no count");

    server.post("ops", "asha", "plan");
    server.post("ops", "asha", "question").to = "Tomas";
    server.post("ops", "tomas", "my own note");
    await waitFor(() => list.state.get().unread.get("ops")?.count === 2, "counts follow events");
    assert.equal(list.state.get().unread.get("ops")?.toYou, 1);
    const asked = server.requests.filter((r) => r.path === "/api/tenants/acme/unread").at(-1)!;
    assert.equal(new URLSearchParams(asked.query).getAll("mark").join(), `ops:${seen.id}`);
    assert.equal(new URLSearchParams(asked.query).get("me"), "tomas");

    // Reading ops moves the mark: the old count no longer shows.
    marks.advance("ops", seen.id + 3);
    assert.equal(currentUnread(list.state.get().unread, marks.state.get(), "ops"), undefined);
    list.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("forgetting a saved profile removes its read marks too", async () => {
  const server = await startMockServer();
  const store = memoryStore();
  const app = new AppModel(store, { fetchImpl: nodeFetch, controller: fast });
  try {
    const session = { origin: server.url, tenant: "acme", username: "tomas" };
    assert.equal(
      await app.signInWithKey({ ...session, token: TEST_TOKEN, remember: true }),
      null,
    );
    await app.settled();
    const current = app.state.get();
    assert.equal(current.kind, "connected");
    if (current.kind !== "connected") return;
    current.controller.marks!.advance("general", 4);
    await current.controller.marks!.flush();
    assert.equal(store.data.has(readMarksKey(session)), true);
    await app.signOut(null, { forget: true });
    await app.settled();
    assert.equal(store.data.has(readMarksKey(session)), false);
  } finally {
    const s = app.state.get();
    if (s.kind === "connected") s.controller.dispose();
    await server.close();
  }
});
