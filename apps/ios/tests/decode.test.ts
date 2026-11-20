import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { decodeChannelList, decodeEventPage, decodeMessagePage } from "../src/core/decode.ts";
import { ProtocolError } from "../src/core/errors.ts";

const base = { tenant: "acme", channel: "general", type: "message.created", resourceId: 5, historyRevision: 0, createdAt: "2026-09-20T00:00:00.000Z" };
const expected = { tenant: "acme", after: 10, limit: 100 };

function page(events: unknown[], nextCursor: number, hasMore = false) {
  return { events, nextCursor, hasMore };
}

test("a valid event page decodes", () => {
  const decoded = decodeEventPage(page([{ ...base, id: 11 }, { ...base, id: 12, type: "channel.created", resourceId: null }], 12), expected);
  assert.deepEqual(decoded.events.map((e) => e.id), [11, 12]);
  assert.equal(decoded.nextCursor, 12);
});

test("an empty page must echo the request cursor", () => {
  assert.equal(decodeEventPage(page([], 10), expected).nextCursor, 10);
  assert.throws(() => decodeEventPage(page([], 11), expected), ProtocolError);
});

const invalid: Array<[string, unknown]> = [
  ["not an object", []],
  ["events not an array", { events: {}, nextCursor: 10, hasMore: false }],
  ["hasMore missing", { events: [], nextCursor: 10 }],
  ["id not after the request cursor", page([{ ...base, id: 10 }], 10)],
  ["ids out of order", page([{ ...base, id: 12 }, { ...base, id: 11 }], 11)],
  ["duplicate ids", page([{ ...base, id: 11 }, { ...base, id: 11 }], 11)],
  ["unsafe id", page([{ ...base, id: Number.MAX_SAFE_INTEGER + 2 }], 10)],
  ["fractional id", page([{ ...base, id: 11.5 }], 11.5)],
  ["foreign tenant", page([{ ...base, id: 11, tenant: "other" }], 11)],
  ["bad channel", page([{ ...base, id: 11, channel: "Not A Slug" }], 11)],
  ["unknown type", page([{ ...base, id: 11, type: "message.updated" }], 11)],
  ["message event without resource", page([{ ...base, id: 11, resourceId: null }], 11)],
  ["channel.created with resource", page([{ ...base, id: 11, type: "channel.created", resourceId: 3 }], 11)],
  ["negative revision", page([{ ...base, id: 11, historyRevision: -1 }], 11)],
  ["bad timestamp", page([{ ...base, id: 11, createdAt: "yesterday" }], 11)],
  ["nextCursor behind last id", page([{ ...base, id: 11 }], 10)],
  ["nextCursor ahead of last id", page([{ ...base, id: 11 }], 50)],
  ["hasMore with no events", page([], 10, true)],
  ["more events than the limit", page(Array.from({ length: 101 }, (_, i) => ({ ...base, id: 11 + i })), 111)],
];
for (const [name, raw] of invalid) {
  test(`invalid event feed is rejected: ${name}`, () => {
    assert.throws(() => decodeEventPage(raw, expected), ProtocolError);
  });
}

test("a scoped decoder rejects events for another channel", () => {
  assert.throws(
    () => decodeEventPage(page([{ ...base, id: 11, channel: "other" }], 11), { ...expected, channel: "general" }),
    ProtocolError,
  );
  assert.doesNotThrow(() => decodeEventPage(page([{ ...base, id: 11 }], 11), { ...expected, channel: "general" }));
});

test("message pages must be increasing and echo the cursor", () => {
  const m = (id: number) => ({ id, tenant: "acme", channel: "general", username: "a", text: "t", contentType: "text/plain", createdAt: "x" });
  assert.equal(decodeMessagePage({ messages: [m(3), m(4)], nextCursor: 4, hasMore: false }, 2).nextCursor, 4);
  assert.throws(() => decodeMessagePage({ messages: [m(4), m(3)], nextCursor: 3, hasMore: false }, 2), ProtocolError);
  assert.throws(() => decodeMessagePage({ messages: [m(2)], nextCursor: 2, hasMore: false }, 2), ProtocolError);
});

test("channel summaries use the API's `name` field", () => {
  const list = decodeChannelList({ channels: [{ name: "general", createdAt: "x", messageCount: 2, participantCount: 1, lastActivityAt: null }], nextCursor: "general", hasMore: false });
  assert.equal(list.channels[0].name, "general");
  assert.throws(() => decodeChannelList({ channels: [{ channel: "general", createdAt: "x" }], nextCursor: "", hasMore: false }), ProtocolError);
});

test("catchup pins must belong to the stream and lead only a first page (ADR 0038)", async () => {
  const { decodeCatchup } = await import("../src/core/decode.ts");
  const message = (id: number, tenant = "acme", channel = "general") => ({
    id,
    tenant,
    channel,
    username: "asha",
    text: `m${id}`,
    contentType: "text/plain",
    createdAt: "2026-11-19T00:00:00.000Z",
  });
  const pin = (id: number, tenant = "acme") => ({ ...message(id, tenant), pinnedAt: "2026-11-19T00:00:00.000Z" });
  const body = (pinned: unknown) => ({
    pinned,
    pinnedOmitted: 0,
    snapshot: null,
    snapshotVersion: 0,
    historyRevision: 0,
    messages: [message(1)],
    nextCursor: 1,
    hasMore: false,
    incomplete: false,
    headCursor: 1,
    pendingMessages: 1,
    pendingBytes: 0,
    snapshotDue: true,
    snapshotDueReasons: ["no_snapshot"],
  });
  const stream = { tenant: "acme", channel: "general" };
  assert.deepEqual(decodeCatchup(body([pin(1)]), undefined, stream).pinned?.map((m) => m.id), [1]);
  assert.equal(decodeCatchup({ ...body([]), pinned: undefined }, 0, stream).pinned, undefined);
  assert.throws(() => decodeCatchup(body([pin(1)]), 0, stream), ProtocolError);
  assert.throws(() => decodeCatchup(body([pin(1, "evil")]), undefined, stream), ProtocolError);
  assert.throws(() => decodeCatchup(body([message(1)]), undefined, stream), ProtocolError);
  assert.throws(() => decodeCatchup(body([pin(2), pin(1)]), undefined, stream), ProtocolError);
});

test("messages keep known reactions and drop unknown kinds; bad reactions are protocol errors (ADR 0047)", async () => {
  const { decodeMessage, decodeReactionPage } = await import("../src/core/decode.ts");
  const raw = {
    id: 3,
    tenant: "acme",
    channel: "general",
    username: "asha",
    text: "hi",
    contentType: "text/plain",
    createdAt: "2026-11-20T00:00:00.000Z",
  };
  assert.equal("reactions" in decodeMessage(raw), false);
  assert.deepEqual(decodeMessage({ ...raw, reactions: { done: ["a", "b"], heart: ["x"] } }).reactions, {
    done: ["a", "b"],
  });
  assert.equal("reactions" in decodeMessage({ ...raw, reactions: { heart: ["x"] } }), false);
  assert.throws(() => decodeMessage({ ...raw, reactions: { done: "a" } }), ProtocolError);
  assert.throws(() => decodeMessage({ ...raw, reactions: [] }), ProtocolError);
  const page = decodeReactionPage({ reactions: [{ id: 3, reactions: { seen: ["a"] } }], hasMore: true, nextAfter: 3 });
  assert.deepEqual([...page.reactions], [[3, { seen: ["a"] }]]);
  assert.equal(page.nextAfter, 3);
  assert.equal(decodeReactionPage({ reactions: [], hasMore: false }).nextAfter, null);
  assert.throws(() => decodeReactionPage({ reactions: [], hasMore: true }), ProtocolError);
  assert.throws(() => decodeReactionPage({ reactions: [{ id: 0, reactions: {} }], hasMore: false }), ProtocolError);
});
