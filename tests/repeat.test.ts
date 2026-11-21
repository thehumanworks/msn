import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { localParts, nextRepeat, type Repeat, repeatRequest, repeatStart, zonedTime } from "../src/repeat";

// Repeat a message on a schedule (ADR 0072): a scheduled message with `repeat` posts a copy each
// time and stays on the schedule until its end, and a retried alarm never posts a copy twice.

const ADMIN = "test-admin-secret-000000000000000000000";
const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown, headers = {}) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      ...headers,
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });

type Scheduled = {
  id: number;
  username: string;
  text: string;
  sendAt: string;
  status: "pending" | "failed";
  repeat?: Repeat;
  error?: { code: string; message: string };
};
type Message = { id: number; text: string; username: string };

const utc = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "ok";
};

describe("zone arithmetic", () => {
  it("reads and names wall-clock times in a zone, on both sides of a daylight-saving change", () => {
    expect(localParts(utc("2026-07-01T08:00:00Z"), "Europe/Lisbon")).toMatchObject({ hour: 9, day: 1 });
    expect(localParts(utc("2026-12-01T09:00:00Z"), "Europe/Lisbon")).toMatchObject({ hour: 9 });
    const nine = { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0 };
    expect(iso(zonedTime(nine, "Europe/Lisbon"))).toBe("2026-07-01T08:00:00.000Z");
    expect(iso(zonedTime({ ...nine, month: 12 }, "Europe/Lisbon"))).toBe("2026-12-01T09:00:00.000Z");
    expect(iso(zonedTime(nine, "Asia/Kolkata"))).toBe("2026-07-01T03:30:00.000Z");
  });

  it("moves a skipped time forward and takes the first of a repeated time", () => {
    // New York, 8 March 2026: 02:00 jumps to 03:00, so 02:30 does not exist.
    const gap = { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 };
    expect(iso(zonedTime(gap, "America/New_York"))).toBe("2026-03-08T07:30:00.000Z");
    // 1 November 2026: 01:30 happens twice; the first is still on summer time.
    const twice = { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 };
    expect(iso(zonedTime(twice, "America/New_York"))).toBe("2026-11-01T05:30:00.000Z");
  });
});

describe("repeatRequest", () => {
  it("accepts each kind and defaults the zone to UTC", () => {
    expect(repeatRequest({ every: "daily", at: "09:00" }, false)).toEqual({
      every: "daily",
      at: "09:00",
      timeZone: "UTC",
    });
    expect(
      repeatRequest(
        { every: "weekdays", at: "17:30", timeZone: "Europe/Lisbon", until: "2026-12-31" },
        false,
      ),
    ).toEqual({ every: "weekdays", at: "17:30", timeZone: "Europe/Lisbon", until: "2026-12-31" });
    expect(repeatRequest({ every: "hours", hours: 6, until: "2026-12-31T18:00:00+01:00" }, true)).toEqual({
      every: "hours",
      hours: 6,
      timeZone: "UTC",
      until: "2026-12-31T17:00:00.000Z",
    });
    expect(repeatRequest({ every: "daily" }, true)).toEqual({ every: "daily", timeZone: "UTC" });
  });

  it("refuses a rule it cannot read", () => {
    for (const [bad, hasSendAt] of [
      ["daily", false],
      [[], false],
      [{ every: "weekly", at: "09:00" }, false],
      [{ every: "daily" }, false],
      [{ every: "daily", at: "09:00" }, true],
      [{ every: "daily", at: "9:00" }, false],
      [{ every: "daily", at: "24:00" }, false],
      [{ every: "daily", at: "09:00", hours: 2 }, false],
      [{ every: "hours" }, false],
      [{ every: "hours", hours: 0 }, false],
      [{ every: "hours", hours: 1.5 }, false],
      [{ every: "hours", hours: 169 }, false],
      [{ every: "hours", hours: 2, at: "09:00" }, false],
      [{ every: "daily", at: "09:00", timeZone: "Mars/Olympus" }, false],
      [{ every: "daily", at: "09:00", timeZone: 5 }, false],
      [{ every: "daily", at: "09:00", until: "2026-02-30" }, false],
      [{ every: "daily", at: "09:00", until: "2026-12-31T09:00:00" }, false],
      [{ every: "daily", at: "09:00", until: 5 }, false],
      [{ every: "daily", at: "09:00", extra: 1 }, false],
    ] as const)
      expect(
        code(() => repeatRequest(bad, hasSendAt)),
        JSON.stringify(bad),
      ).toBe("invalid_repeat");
  });
});

describe("repeatStart", () => {
  const now = utc("2026-11-20T10:00:00Z"); // A Friday.

  it("finds the first daily time in the zone, today when it is still ahead", () => {
    const start = (at: string, timeZone = "UTC") =>
      repeatStart({ every: "daily", at, timeZone }, null, now).sendAt;
    expect(start("09:00")).toBe("2026-11-21T09:00:00.000Z");
    expect(start("10:00")).toBe("2026-11-21T10:00:00.000Z");
    expect(start("18:00")).toBe("2026-11-20T18:00:00.000Z");
    // 09:00 in Tokyo is midnight UTC: the next one after Friday 10:00 UTC is Saturday 00:00 UTC.
    expect(start("09:00", "Asia/Tokyo")).toBe("2026-11-21T00:00:00.000Z");
  });

  it("starts weekdays on a weekday of the zone and refuses a weekend sendAt", () => {
    const request = { every: "weekdays", at: "09:00", timeZone: "UTC" } as const;
    expect(repeatStart(request, null, now).sendAt).toBe("2026-11-23T09:00:00.000Z");
    expect(repeatStart({ ...request, at: "11:00" }, null, now).sendAt).toBe("2026-11-20T11:00:00.000Z");
    const zoned = { every: "weekdays", timeZone: "UTC" } as const;
    expect(code(() => repeatStart(zoned, "2026-11-21T09:00:00.000Z", now))).toBe("invalid_repeat");
    // Friday 23:30 UTC is Saturday morning in Tokyo.
    expect(
      code(() => repeatStart({ every: "weekdays", timeZone: "Asia/Tokyo" }, "2026-11-20T23:30:00.000Z", now)),
    ).toBe("invalid_repeat");
  });

  it("takes the wall clock from sendAt, and counts hours from now without one", () => {
    const daily = repeatStart({ every: "daily", timeZone: "Europe/Lisbon" }, "2026-11-21T09:15:00.000Z", now);
    expect(daily.sendAt).toBe("2026-11-21T09:15:00.000Z");
    expect(daily.repeat).toEqual({
      every: "daily",
      at: "09:15",
      timeZone: "Europe/Lisbon",
      until: "2027-11-21T10:00:00.000Z",
    });
    const hours = repeatStart({ every: "hours", hours: 6, timeZone: "UTC" }, null, now + 250);
    expect(hours.sendAt).toBe("2026-11-20T16:00:00.000Z");
    expect(hours.repeat.at).toBeUndefined();
  });

  it("reads a date end through that day in the zone, and checks the window", () => {
    const request = { every: "daily", at: "09:00", timeZone: "America/New_York" } as const;
    expect(repeatStart({ ...request, until: "2026-12-31" }, null, now).repeat.until).toBe(
      "2027-01-01T04:59:59.999Z",
    );
    expect(code(() => repeatStart({ ...request, until: "2026-11-19" }, null, now))).toBe("invalid_repeat");
    expect(code(() => repeatStart({ ...request, until: "2027-12-31" }, null, now))).toBe("invalid_repeat");
    expect(
      code(() => repeatStart({ every: "hours", hours: 2, timeZone: "UTC" }, "2026-11-20T09:00:00.000Z", now)),
    ).toBe("invalid_send_at");
  });
});

describe("nextRepeat", () => {
  const rule = (extra: Partial<Repeat>): Repeat => ({
    every: "daily",
    at: "09:00",
    timeZone: "UTC",
    until: "2027-06-01T00:00:00.000Z",
    ...extra,
  });

  it("keeps 09:00 on the wall clock across a daylight-saving change", () => {
    const lisbon = rule({ timeZone: "Europe/Lisbon" });
    // Saturday 24 October 2026 is on summer time (UTC+1); the clocks go back on the 25th.
    const before = utc("2026-10-24T08:00:00Z");
    const after = nextRepeat(lisbon, before, before);
    expect(iso(after)).toBe("2026-10-25T09:00:00.000Z");
    expect(localParts(after as number, "Europe/Lisbon")).toMatchObject({ hour: 9, minute: 0 });
  });

  it("skips Saturday and Sunday for weekdays, by the zone's days", () => {
    const friday = utc("2026-11-20T09:00:00Z");
    expect(iso(nextRepeat(rule({ every: "weekdays" }), friday, friday))).toBe("2026-11-23T09:00:00.000Z");
    // Friday 09:00 in Tokyo is Friday 00:00 UTC; the next weekday there is Monday.
    const tokyo = rule({ every: "weekdays", timeZone: "Asia/Tokyo" });
    const due = utc("2026-11-20T00:00:00Z");
    expect(iso(nextRepeat(tokyo, due, due))).toBe("2026-11-23T00:00:00.000Z");
  });

  it("steps hours from the due time and skips copies missed while late", () => {
    const hours = rule({ every: "hours", hours: 6, at: undefined });
    const due = utc("2026-11-20T10:00:00Z");
    expect(iso(nextRepeat(hours, due, due + 500))).toBe("2026-11-20T16:00:00.000Z");
    // The alarm ran 13 hours late: one copy posts now, and the next keeps the 6-hour grid.
    expect(iso(nextRepeat(hours, due, due + 13 * 3600_000))).toBe("2026-11-21T04:00:00.000Z");
    const daily = rule({});
    const late = utc("2026-11-23T12:00:00Z");
    expect(iso(nextRepeat(daily, utc("2026-11-20T09:00:00Z"), late))).toBe("2026-11-24T09:00:00.000Z");
  });

  it("gives no second copy on a day whose copy was moved earlier", () => {
    const moved = utc("2026-11-20T07:00:00Z");
    expect(iso(nextRepeat(rule({}), moved, moved + 1000))).toBe("2026-11-21T09:00:00.000Z");
  });

  it("ends at until, which may itself be a copy's time", () => {
    const due = utc("2026-11-20T09:00:00Z");
    expect(nextRepeat(rule({ until: "2026-11-21T08:59:59.999Z" }), due, due)).toBeNull();
    expect(iso(nextRepeat(rule({ until: "2026-11-21T09:00:00.000Z" }), due, due))).toBe(
      "2026-11-21T09:00:00.000Z",
    );
  });
});

/** An owner account with a board `work`, its shared agent credential and personas `lead` and `dev`. */
async function fixture() {
  const tenant = `repeat-${crypto.randomUUID()}`;
  const owner = (await (await call(tenant, "", undefined, "PUT", { username: "human" })).json()) as {
    token: string;
  };
  const agent = "c".repeat(64);
  expect(
    (await call(tenant, "/channels/work/board", owner.token, "PUT", { credential: agent, goal: "Ship" }))
      .status,
  ).toBe(201);
  for (const name of ["lead", "dev"])
    expect(
      (await call(tenant, `/channels/work/personas/${name}`, agent, "PUT", { displayName: name })).status,
    ).toBe(201);
  const post = (input: object, headers = {}, token = agent) =>
    call(tenant, "/channels/work/messages", token, "POST", { username: "lead", ...input }, headers);
  const schedule = async (input: object) => {
    const response = await post(input);
    expect(response.status).toBe(201);
    return ((await response.json()) as { scheduled: Scheduled }).scheduled;
  };
  const list = async (token = agent) =>
    ((await (await call(tenant, "/channels/work/scheduled", token)).json()) as { scheduled: Scheduled[] })
      .scheduled;
  const messages = async () =>
    ((await (await call(tenant, "/channels/work/messages", agent)).json()) as { messages: Message[] })
      .messages;
  const stub = () => env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant]));
  /** Runs the alarm by hand. It is set far ahead first, so it cannot also fire on its own. */
  const fire = async () => {
    await runInDurableObject(stub(), (_, state) => state.storage.setAlarm(Date.now() + 3600_000));
    await runDurableObjectAlarm(stub());
  };
  /** Makes every waiting row due now and runs the alarm, as if its time had come. */
  const arrive = async () => {
    await runInDurableObject(stub(), (_, state) => {
      state.storage.sql.exec(
        "UPDATE scheduled_messages SET dueMs = ? WHERE failedAt IS NULL",
        Date.now() - 1,
      );
    });
    await fire();
  };
  const alarm = () => runInDurableObject(stub(), (_, state) => state.storage.getAlarm());
  return { tenant, owner: owner.token, agent, post, schedule, list, messages, stub, fire, arrive, alarm };
}

describe("repeating messages", () => {
  it("schedules a daily repeat without sendAt and lists it with its rule and next time", async () => {
    const f = await fixture();
    const scheduled = await f.schedule({
      text: "standup",
      repeat: { every: "daily", at: "09:00", timeZone: "Europe/Lisbon", until: "2027-01-31" },
    });
    expect(scheduled.status).toBe("pending");
    expect(scheduled.repeat).toMatchObject({ every: "daily", at: "09:00", timeZone: "Europe/Lisbon" });
    expect(localParts(Date.parse(scheduled.sendAt), "Europe/Lisbon")).toMatchObject({ hour: 9, minute: 0 });
    expect(Date.parse(scheduled.sendAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(scheduled.sendAt) - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    expect(await f.messages()).toEqual([]);
    expect(await f.list(f.owner)).toEqual([scheduled]);
    expect(await f.alarm()).toBe(Date.parse(scheduled.sendAt));
  });

  it("posts a copy each time as an ordinary message and stays on the schedule", async () => {
    const f = await fixture();
    const scheduled = await f.schedule({ text: "check in", to: "dev", repeat: { every: "hours", hours: 6 } });
    await f.arrive();
    const first = await f.messages();
    expect(first.map((m) => m.text)).toEqual(["check in"]);
    expect(first[0]).toMatchObject({ username: "lead", to: "dev" });
    expect(first[0]).not.toHaveProperty("repeat");
    const [row] = await f.list();
    expect(row.id).toBe(scheduled.id);
    expect(row.status).toBe("pending");
    // The next copy is six hours after the one that just posted.
    const gap = Date.parse(row.sendAt) - Date.now();
    expect(gap).toBeGreaterThan(5.9 * 3600_000);
    expect(gap).toBeLessThanOrEqual(6 * 3600_000);
    expect(await f.alarm()).toBe(Date.parse(row.sendAt));
    await f.arrive();
    const second = await f.messages();
    expect(second.map((m) => m.text)).toEqual(["check in", "check in"]);
    expect(second[1].id).toBeGreaterThan(second[0].id);
    expect((await f.list()).length).toBe(1);
  });

  it("never posts a copy twice when the alarm runs again", async () => {
    const f = await fixture();
    await f.schedule({ text: "once per time", repeat: { every: "daily", at: "09:00" } });
    await f.arrive();
    // A retried alarm, and a second delivery pass for the same moment, find nothing due.
    await f.fire();
    await f.fire();
    const again = await runInDurableObject(f.stub(), (instance) =>
      (instance as unknown as { postDue(now?: number): number }).postDue(),
    );
    expect(again).toBe(0);
    expect((await f.messages()).map((m) => m.text)).toEqual(["once per time"]);
    expect((await f.list()).length).toBe(1);
  });

  it("posts one copy and skips the missed ones when the alarm is late", async () => {
    const f = await fixture();
    await f.schedule({ text: "hourly", repeat: { every: "hours", hours: 1 } });
    await runInDurableObject(f.stub(), (_, state) => {
      state.storage.sql.exec("UPDATE scheduled_messages SET dueMs = ?", Date.now() - 5 * 3600_000 - 60_000);
    });
    await f.fire();
    expect((await f.messages()).length).toBe(1);
    const [row] = await f.list();
    expect(Date.parse(row.sendAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(row.sendAt) - Date.now()).toBeLessThanOrEqual(3600_000);
  });

  it("ends after the last copy inside until and leaves the schedule", async () => {
    const f = await fixture();
    const scheduled = await f.schedule({ text: "last", repeat: { every: "hours", hours: 6 } });
    // Shorten the end so that the copy after this one would fall outside it.
    await runInDurableObject(f.stub(), (_, state) => {
      state.storage.sql.exec(
        "UPDATE scheduled_messages SET repeat = ? WHERE id = ?",
        JSON.stringify({ ...scheduled.repeat, until: new Date(Date.now() + 3600_000).toISOString() }),
        scheduled.id,
      );
    });
    await f.arrive();
    expect((await f.messages()).map((m) => m.text)).toEqual(["last"]);
    expect(await f.list()).toEqual([]);
    expect(await f.alarm()).toBeNull();
  });

  it("replays the scheduling request by key while it repeats, and the last copy after it ends", async () => {
    const f = await fixture();
    const input = { text: "keyed", repeat: { every: "hours", hours: 6 } };
    const headers = { "Idempotency-Key": "repeat-1" };
    const first = await f.post(input, headers);
    expect(first.status).toBe(201);
    const created = ((await first.json()) as { scheduled: Scheduled }).scheduled;
    await f.arrive();
    // A copy has posted; the key still belongs to the repeating message, not to that copy.
    const again = await f.post(input, headers);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { scheduled: Scheduled }).scheduled.id).toBe(created.id);
    expect((await f.post({ ...input, repeat: { every: "hours", hours: 7 } }, headers)).status).toBe(409);
    expect((await f.post({ text: "keyed" }, headers)).status).toBe(409);
    expect((await f.list()).length).toBe(1);
    await runInDurableObject(f.stub(), (_, state) => {
      state.storage.sql.exec(
        "UPDATE scheduled_messages SET repeat = ?",
        JSON.stringify({ ...created.repeat, until: new Date(Date.now() + 60_000).toISOString() }),
      );
    });
    await f.arrive();
    const late = await f.post(input, headers);
    expect(late.status).toBe(200);
    const replay = (await late.json()) as { message: Message };
    const all = await f.messages();
    expect(all.length).toBe(2);
    expect(replay.message.id).toBe(all[1].id);
  });

  it("lets the sender or the owner stop it, and nobody else", async () => {
    const f = await fixture();
    const mine = await f.schedule({ text: "stop me", repeat: { every: "daily", at: "09:00" } });
    const stop = (id: number, username: string, token: string) =>
      call(f.tenant, `/channels/work/scheduled/${id}?username=${username}`, token, "DELETE");
    expect((await stop(mine.id, "dev", f.agent)).status).toBe(403);
    expect((await stop(mine.id, "lead", f.agent)).status).toBe(204);
    const other = await f.schedule({ text: "owner stops", repeat: { every: "weekdays", at: "09:00" } });
    await f.arrive();
    expect((await stop(other.id, "human", f.owner)).status).toBe(204);
    expect(await f.list()).toEqual([]);
    expect(await f.alarm()).toBeNull();
    await f.fire();
    expect((await f.messages()).map((m) => m.text)).toEqual(["owner stops"]);
  });

  it("stops with the reason when a copy cannot post, and resumes at a new time", async () => {
    const f = await fixture();
    const scheduled = await f.schedule({ text: "resume", repeat: { every: "hours", hours: 6 } });
    expect((await call(f.tenant, "/channels/work/archive", f.owner, "PUT")).status).toBe(200);
    await f.arrive();
    const [failed] = await f.list(f.owner);
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("board_archived");
    expect(failed.repeat).toEqual(scheduled.repeat);
    expect((await call(f.tenant, "/channels/work/archive", f.owner, "DELETE")).status).toBe(200);
    const patch = (sendAt: string) =>
      call(f.tenant, `/channels/work/scheduled/${scheduled.id}`, f.agent, "PATCH", {
        username: "lead",
        sendAt,
      });
    // A new time past the end of the repeat is refused.
    const beyond = new Date(Date.parse(scheduled.repeat?.until as string) - 86400_000 * 2);
    await runInDurableObject(f.stub(), (_, state) => {
      state.storage.sql.exec(
        "UPDATE scheduled_messages SET repeat = ?",
        JSON.stringify({ ...scheduled.repeat, until: beyond.toISOString() }),
      );
    });
    const tooLate = await patch(new Date(beyond.getTime() + 3600_000).toISOString());
    expect(tooLate.status).toBe(400);
    expect(((await tooLate.json()) as { error: { code: string } }).error.code).toBe("invalid_send_at");
    expect((await patch(new Date(Date.now() + 3600_000).toISOString())).status).toBe(200);
    await f.arrive();
    expect((await f.messages()).map((m) => m.text)).toEqual(["resume"]);
    expect((await f.list())[0].status).toBe("pending");
  });

  it("takes sendAt as the first time and refuses what a scheduled send refuses", async () => {
    const f = await fixture();
    const sendAt = new Date(Date.now() + 2 * 3600_000).toISOString();
    const scheduled = await f.schedule({ text: "from a time", sendAt, repeat: { every: "hours", hours: 2 } });
    expect(scheduled.sendAt).toBe(sendAt);
    for (const [input, expected] of [
      [{ text: "x", repeat: { every: "sometimes" } }, "invalid_repeat"],
      [{ text: "x", repeat: { every: "daily", at: "09:00", until: "2020-01-01" } }, "invalid_repeat"],
      [{ text: "x", sendAt, repeat: { every: "daily", at: "09:00" } }, "invalid_repeat"],
      [
        { text: "x", to: "dev", choices: ["a", "b"], repeat: { every: "daily", at: "09:00" } },
        "invalid_send_at",
      ],
      [{ text: "x", replaces: 1, repeat: { every: "daily", at: "09:00" } }, "invalid_send_at"],
    ] as const) {
      const response = await f.post(input);
      expect(response.status, JSON.stringify(input)).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(expected);
    }
    expect((await f.list()).length).toBe(1);
    void ADMIN;
  });
});
