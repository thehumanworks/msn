import assert from "node:assert/strict";
import { test } from "node:test";
import {
  localInput,
  presets,
  repeatFrom,
  repeatText,
  sendAtFrom,
  summary,
  whenText,
} from "../public/scheduled.js";

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

test("summary says how many of the waiting messages repeat (ADR 0072)", () => {
  const repeat = { every: "daily" };
  assert.equal(summary([{ status: "pending", repeat }, { status: "pending" }]), "2 scheduled (1 repeating)");
  assert.equal(summary([{ status: "failed", repeat }]), "1 failed to post");
});

test("repeatFrom builds the rule a send carries, in the given zone", () => {
  const first = "2026-11-23T09:00"; // A Monday.
  assert.deepEqual(repeatFrom({ every: "", hours: "6", until: "", first }), { repeat: null });
  assert.deepEqual(repeatFrom({ every: "daily", hours: "6", until: "", first }, "Europe/Lisbon"), {
    repeat: { every: "daily", timeZone: "Europe/Lisbon" },
  });
  assert.deepEqual(repeatFrom({ every: "weekdays", until: "2026-12-31", first }, "UTC"), {
    repeat: { every: "weekdays", timeZone: "UTC", until: "2026-12-31" },
  });
  assert.deepEqual(repeatFrom({ every: "hours", hours: " 6 ", until: "", first }, "UTC"), {
    repeat: { every: "hours", hours: 6, timeZone: "UTC" },
  });
  // The last day may be the day of the first copy.
  assert.ok(repeatFrom({ every: "daily", until: "2026-11-23", first }, "UTC").repeat);
});

test("repeatFrom explains what it cannot take", () => {
  const first = "2026-11-23T09:00";
  for (const hours of ["", "0", "169", "1.5", "six", "-2"])
    assert.match(repeatFrom({ every: "hours", hours, until: "", first }).error, /1 to 168/, hours);
  assert.match(repeatFrom({ every: "weekdays", until: "", first: "2026-11-21T09:00" }).error, /weekday/);
  assert.match(repeatFrom({ every: "weekdays", until: "", first: "2026-11-22T09:00" }).error, /weekday/);
  assert.match(repeatFrom({ every: "daily", until: "2026-11-22", first }).error, /before the first/);
  assert.match(repeatFrom({ every: "daily", until: "soon", first }).error, /date/);
  assert.match(repeatFrom({ every: "weekly", until: "", first }).error, /how often/);
});

test("repeatText says the rule, its zone and its last day", () => {
  const until = "2026-12-31T23:59:59.999Z";
  assert.equal(repeatText(null), "");
  assert.match(
    repeatText({ every: "daily", at: "09:00", timeZone: "UTC", until }),
    /^Repeats every day at 09:00 \(UTC time\) · until .*31.*2026/,
  );
  assert.match(
    repeatText({ every: "weekdays", at: "17:30:15", timeZone: "Europe/Lisbon", until }),
    /^Repeats Monday to Friday at 17:30 \(Europe\/Lisbon time\) · until /,
  );
  assert.match(
    repeatText({ every: "hours", hours: 6, timeZone: "UTC", until }),
    /^Repeats every 6 hours · until /,
  );
  assert.match(
    repeatText({ every: "hours", hours: 1, timeZone: "UTC", until }),
    /^Repeats every hour · until /,
  );
  // The last day reads in the rule's zone: the end of 31 December in New York is 1 January UTC.
  assert.match(
    repeatText({
      every: "daily",
      at: "09:00",
      timeZone: "America/New_York",
      until: "2027-01-01T04:59:59.999Z",
    }),
    /31.*2026/,
  );
  assert.equal(repeatText({ every: "hours", hours: 2, timeZone: "UTC" }), "Repeats every 2 hours");
});
