import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeScheduledList, presets, sendAtFrom, whenText } from "../src/core/scheduled.ts";

test("sendAtFrom takes delays and zoned times, and refuses the rest (ADR 0060)", () => {
  const now = Date.parse("2026-11-21T08:00:00Z");
  assert.equal(sendAtFrom("10m", now), "2026-11-21T08:10:00.000Z");
  assert.equal(sendAtFrom("+1h30m", now), "2026-11-21T09:30:00.000Z");
  assert.equal(sendAtFrom("1d", now), "2026-11-22T08:00:00.000Z");
  assert.equal(sendAtFrom("2026-11-21T10:00:00+01:00", now), "2026-11-21T09:00:00.000Z");
  for (const bad of ["", "0m", "soon", "2026-11-21T10:00:00", "2026-11-20T10:00:00Z", "400d", "1w"])
    assert.equal(sendAtFrom(bad, now), null, bad);
});

test("presets are an hour ahead and tomorrow at 9:00, and whenText names the day", () => {
  const now = new Date(2026, 10, 21, 8, 30, 15);
  const [hour, morning] = presets(now);
  assert.equal(new Date(hour.sendAt).getTime(), new Date(2026, 10, 21, 9, 30).getTime());
  assert.equal(new Date(morning.sendAt).getTime(), new Date(2026, 10, 22, 9, 0).getTime());
  assert.equal(whenText(morning.sendAt, now), "tomorrow 09:00");
  assert.equal(whenText(new Date(2026, 10, 21, 18, 5).toISOString(), now), "today 18:05");
  assert.equal(whenText(new Date(2026, 11, 2, 9, 0).toISOString(), now), "2026-12-02 09:00");
});

test("decodeScheduledList keeps this board's rows and refuses others", () => {
  const row = {
    id: 1,
    channel: "general",
    username: "tomas",
    text: "later",
    sendAt: "2026-11-21T09:00:00.000Z",
    status: "failed",
    error: { code: "board_archived", message: "archived" },
  };
  assert.deepEqual(decodeScheduledList({ scheduled: [row] }, "general"), [row]);
  assert.throws(() => decodeScheduledList({ scheduled: [row] }, "other"));
  assert.throws(() => decodeScheduledList({ scheduled: [{ ...row, status: "sent" }] }, "general"));
  assert.throws(() => decodeScheduledList({}, "general"));
});
