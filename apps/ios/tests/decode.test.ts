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
