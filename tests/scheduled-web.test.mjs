import assert from "node:assert/strict";
import { test } from "node:test";
import { localInput, presets, sendAtFrom, summary, whenText } from "../public/scheduled.js";

// The suite runs with TZ unset in CI; these tests only rely on round trips through the local zone.

test("a datetime-local value round-trips to a UTC sendAt in this device's zone", () => {
  const now = new Date(2026, 10, 21, 8, 30).getTime();
  const at = new Date(2026, 10, 21, 9, 15);
  assert.equal(localInput(at), "2026-11-21T09:15");
  assert.equal(sendAtFrom("2026-11-21T09:15", now), at.toISOString());
  assert.ok(sendAtFrom("2026-11-21T09:15", now).endsWith("Z"));
});

test("sendAtFrom refuses empty, malformed, past and too-far times", () => {
  const now = new Date(2026, 10, 21, 8, 30).getTime();
  for (const bad of [
    "",
    null,
    "tomorrow",
    "2026-11-21",
    "2026-11-21T08:29",
    "2026-11-21T08:30",
    "2028-01-01T00:00",
  ])
    assert.equal(sendAtFrom(bad, now), null, String(bad));
});

test("presets offer an hour from now, this evening while it is far enough, and tomorrow morning", () => {
  const morning = presets(new Date(2026, 10, 21, 8, 30, 45));
  assert.deepEqual(
    morning.map((p) => [p.label, localInput(p.at)]),
    [
      ["In 1 hour", "2026-11-21T09:30"],
      ["This evening, 18:00", "2026-11-21T18:00"],
      ["Tomorrow, 9:00", "2026-11-22T09:00"],
    ],
  );
  const late = presets(new Date(2026, 10, 30, 17, 45));
  assert.deepEqual(
    late.map((p) => localInput(p.at)),
    ["2026-11-30T18:45", "2026-12-01T09:00"],
  );
});

test("whenText names today and tomorrow, else the date", () => {
  const now = new Date(2026, 10, 21, 8, 0);
  assert.equal(whenText(new Date(2026, 10, 21, 18, 0).toISOString(), now), "today 18:00");
  assert.equal(whenText(new Date(2026, 10, 22, 9, 5).toISOString(), now), "tomorrow 09:05");
  assert.match(whenText(new Date(2026, 10, 24, 9, 0).toISOString(), now), /24.*09:00$/);
  assert.match(whenText(new Date(2027, 0, 2, 9, 0).toISOString(), now), /2027.*09:00$/);
});

test("summary counts waiting and failed messages", () => {
  assert.equal(summary([]), "");
  assert.equal(summary([{ status: "pending" }, { status: "pending" }]), "2 scheduled");
  assert.equal(summary([{ status: "pending" }, { status: "failed" }]), "1 scheduled · 1 failed to post");
  assert.equal(summary([{ status: "failed" }]), "1 failed to post");
});
