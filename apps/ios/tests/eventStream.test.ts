import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { bootstrapEventCursor, EventStreamManager, type FetchEventsPage } from "../src/core/eventStream.ts";
import { ApiError, CapacityError, ProtocolError } from "../src/core/errors.ts";
import type { CoordinationEvent, EventPage } from "../src/core/types.ts";

function ev(id: number, type: CoordinationEvent["type"] = "message.created"): CoordinationEvent {
  return { id, tenant: "acme", channel: "general", type, resourceId: id, historyRevision: 0, createdAt: "" };
}

test("bootstrapEventCursor drains pages until hasMore is false", async () => {
  const pages: EventPage[] = [
    { events: [ev(1), ev(2)], nextCursor: 2, hasMore: true },
    { events: [ev(3)], nextCursor: 3, hasMore: false },
  ];
  const calls: number[] = [];
  const fetchPage: FetchEventsPage = async (after) => {
    calls.push(after);
    return pages.shift()!;
  };
  const cursor = await bootstrapEventCursor(fetchPage);
  assert.equal(cursor, 3);
  assert.deepEqual(calls, [0, 2]);
});

test("bootstrapEventCursor fails loudly instead of silently truncating an oversized backlog", async () => {
  const fetchPage: FetchEventsPage = async (after) => ({
    events: [ev(after + 1)],
    nextCursor: after + 1,
    hasMore: true,
  });
  await assert.rejects(() => bootstrapEventCursor(fetchPage, { maxPages: 5 }), CapacityError);
});

function parked<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

test("EventStreamManager advances the cursor only after onEvents resolves", async () => {
  let resolveProcessing: () => void = () => {};
  const processing = new Promise<void>((resolve) => (resolveProcessing = resolve));
  let calls = 0;
  const manager = new EventStreamManager(
    async () => {
      calls += 1;
      return calls === 1 ? { events: [ev(1)], nextCursor: 1, hasMore: false } : parked<EventPage>();
    },
    { onEvents: () => processing, onAuthError: () => assert.fail("no auth error expected") },
  );
  manager.start(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(manager.currentCursor, 0, "cursor must not advance before onEvents resolves");
  resolveProcessing();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(manager.currentCursor, 1);
  manager.stop();
});

test("a failing onEvents replays the same page instead of skipping it", async () => {
  let calls = 0;
  const seen: number[] = [];
  const manager = new EventStreamManager(
    async (after) => (calls++ < 2 ? { events: [ev(1)], nextCursor: 1, hasMore: false } : parked<EventPage>()),
    {
      onEvents: (events) => {
        seen.push(events[0].id);
        if (seen.length === 1) throw new Error("handler failed");
      },
      onAuthError: () => assert.fail("no auth error expected"),
    },
    { backoff: { baseMs: 1, maxMs: 1, random: () => 1 } },
  );
  manager.start(0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(seen, [1, 1]);
  assert.equal(manager.currentCursor, 1);
  manager.stop();
});

test("EventStreamManager drains hasMore pages back-to-back", async () => {
  const pages: EventPage[] = [
    { events: [ev(1)], nextCursor: 1, hasMore: true },
    { events: [ev(2)], nextCursor: 2, hasMore: true },
    { events: [ev(3)], nextCursor: 3, hasMore: false },
  ];
  const seenAfter: number[] = [];
  const manager = new EventStreamManager(
    async (after) => {
      seenAfter.push(after);
      return pages.shift() ?? parked<EventPage>();
    },
    { onEvents: () => {}, onAuthError: () => assert.fail("no auth error expected") },
  );
  manager.start(0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  manager.stop();
  assert.deepEqual(seenAfter, [0, 1, 2, 3]);
  assert.equal(manager.currentCursor, 3);
});

test("EventStreamManager treats 401 as terminal and does not reconnect", async () => {
  let calls = 0;
  let authErrors = 0;
  const manager = new EventStreamManager(
    async () => {
      calls += 1;
      throw new ApiError(401, "unauthorized", "nope");
    },
    { onEvents: () => {}, onAuthError: () => void (authErrors += 1) },
  );
  manager.start(0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(authErrors, 1);
  assert.equal(manager.isRunning, false);
  assert.equal(calls, 1);
});

test("an invalid feed is fatal, not retried, and makes no progress", async () => {
  let fatal: Error | null = null;
  let calls = 0;
  const manager = new EventStreamManager(
    async () => {
      calls += 1;
      throw new ProtocolError("bad feed");
    },
    { onEvents: () => assert.fail("no events"), onAuthError: () => {}, onFatalError: (e) => void (fatal = e) },
  );
  manager.start(7);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fatal);
  assert.equal(calls, 1);
  assert.equal(manager.currentCursor, 7);
});

test("EventStreamManager retries a transient error with backoff, then recovers", async () => {
  let attempts = 0;
  const delays: number[] = [];
  let recovered = 0;
  const manager = new EventStreamManager(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("network blip");
      return attempts === 2 ? { events: [ev(1)], nextCursor: 1, hasMore: false } : parked<EventPage>();
    },
    { onEvents: () => {}, onAuthError: () => {}, onRecovered: () => void (recovered += 1) },
    {
      setTimeout: (fn, ms) => {
        delays.push(ms);
        return setTimeout(fn, 0);
      },
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      backoff: { baseMs: 5, random: () => 1 },
    },
  );
  manager.start(0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [5]);
  assert.equal(recovered, 1);
  assert.equal(manager.currentCursor, 1);
  manager.stop();
});

test("stop() during a backoff sleep resolves the sleeper and never retries", async () => {
  let attempts = 0;
  const manager = new EventStreamManager(
    async () => {
      attempts += 1;
      throw new Error("down");
    },
    { onEvents: () => {}, onAuthError: () => {} },
    { backoff: { baseMs: 60_000, maxMs: 60_000, random: () => 1 } },
  );
  manager.start(0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  manager.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(attempts, 1);
  assert.equal(manager.isRunning, false);
});

test("stop() aborts the in-flight request's signal", async () => {
  let signal: AbortSignal | undefined;
  const manager = new EventStreamManager(
    async (_a, _l, _w, _c, s) => {
      signal = s;
      return parked<EventPage>();
    },
    { onEvents: () => {}, onAuthError: () => {} },
  );
  manager.start(0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  manager.stop();
  assert.equal(signal?.aborted, true);
});

test("stop() ignores a late response from the previous generation", async () => {
  let releaseFirst: (page: EventPage) => void = () => {};
  const firstFetch = new Promise<EventPage>((resolve) => (releaseFirst = resolve));
  let fetchCount = 0;
  const delivered: number[] = [];
  const manager = new EventStreamManager(
    async () => (++fetchCount === 1 ? firstFetch : parked<EventPage>()),
    { onEvents: (events) => void delivered.push(events.length), onAuthError: () => {} },
  );
  manager.start(0);
  manager.stop();
  releaseFirst({ events: [ev(99)], nextCursor: 99, hasMore: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(delivered.length, 0);
  assert.equal(manager.currentCursor, 0);
});

test("an empty long poll that returns instantly does not spin", async () => {
  let calls = 0;
  const manager = new EventStreamManager(
    async (after) => {
      calls += 1;
      return { events: [], nextCursor: after, hasMore: false };
    },
    { onEvents: () => {}, onAuthError: () => {} },
  );
  manager.start(0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  manager.stop();
  assert.ok(calls <= 2, `expected at most 2 calls, saw ${calls}`);
});
