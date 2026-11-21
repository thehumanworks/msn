import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_SCHEDULE_AHEAD_MS, sendAtTime } from "../src/http";

// Send a message later (ADR 0060): a send with `sendAt` waits in the board's schedule, can be
// changed or cancelled, and the object's alarm posts it as a normal message at that time.

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
  channel: string;
  username: string;
  text: string;
  sendAt: string;
  status: "pending" | "failed";
  personaId?: string;
  replyTo?: number;
  labels?: Record<string, string>;
  error?: { code: string; message: string };
};
type Message = { id: number; text: string; username: string; createdAt: string; personaId?: string };

const later = (ms = 3600_000) => new Date(Date.now() + ms).toISOString();

/** An owner account with a board `work`, its shared agent credential and personas `lead` and `dev`. */
async function fixture() {
  const tenant = `sched-${crypto.randomUUID()}`;
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
  const schedule = async (text: string, extra: object = {}, username = "lead", token = agent) => {
    const response = await call(tenant, "/channels/work/messages", token, "POST", {
      username,
      text,
      sendAt: later(),
      ...extra,
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { scheduled: Scheduled }).scheduled;
  };
  const list = async (token = agent) =>
    ((await (await call(tenant, "/channels/work/scheduled", token)).json()) as { scheduled: Scheduled[] })
      .scheduled;
  const messages = async (token = agent) =>
    ((await (await call(tenant, "/channels/work/messages", token)).json()) as { messages: Message[] })
      .messages;
  const stub = () => env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant]));
  /** Makes every pending row due now and runs the alarm, as if its time had come. */
  const arrive = async () => {
    await runInDurableObject(stub(), (_, state) => {
      state.storage.sql.exec(
        "UPDATE scheduled_messages SET dueMs = ? WHERE failedAt IS NULL",
        Date.now() - 1,
      );
    });
    // A far alarm that only runDurableObjectAlarm fires: an alarm set to now could also fire on
    // its own and race the reads that follow.
    await runInDurableObject(stub(), (_, state) => state.storage.setAlarm(Date.now() + 3600_000));
    await runDurableObjectAlarm(stub());
  };
  const alarm = () => runInDurableObject(stub(), (_, state) => state.storage.getAlarm());
  return { tenant, owner: owner.token, agent, schedule, list, messages, stub, arrive, alarm };
}

describe("sendAtTime", () => {
  it("accepts a zoned RFC 3339 time in the future and returns UTC", () => {
    const now = Date.parse("2026-11-21T00:00:00Z");
    expect(sendAtTime("2026-11-21T10:00:00+01:00", now)).toBe("2026-11-21T09:00:00.000Z");
    expect(sendAtTime("2026-11-21T09:30Z", now)).toBe("2026-11-21T09:30:00.000Z");
  });

  it("refuses a time without a zone, in the past, too far ahead or not a string", () => {
    const now = Date.parse("2026-11-21T00:00:00Z");
    for (const bad of [
      "2026-11-21T09:00:00",
      "2026-11-20T23:59:59Z",
      "2026-11-21T00:00:00Z",
      new Date(now + MAX_SCHEDULE_AHEAD_MS + 1000).toISOString(),
      "tomorrow",
      42,
      // Real calendar dates only: Date.parse would roll these over into the next month or day.
      "2027-02-30T09:00:00Z",
      "2027-04-31T09:00:00Z",
      "2027-01-01T24:00:00Z",
      "2027-01-01T09:60:00Z",
    ])
      expect(() => sendAtTime(bad, now)).toThrow(/sendAt/);
  });
});

describe("send a message later (ADR 0060)", () => {
  it("replays a retry that arrives after its sendAt has passed", async () => {
    const f = await fixture();
    const input = { username: "lead", text: "late retry", sendAt: later(1500) };
    const headers = { "Idempotency-Key": "sched-late" };
    expect((await call(f.tenant, "/channels/work/messages", f.agent, "POST", input, headers)).status).toBe(
      201,
    );
    await new Promise((resolve) => setTimeout(resolve, 1700));
    // The time is now in the past. The retry replays (the scheduled message, or the message it
    // became if the alarm already ran) instead of refusing the time.
    const retry = await call(f.tenant, "/channels/work/messages", f.agent, "POST", input, headers);
    expect(retry.status).toBe(200);
    const body = (await retry.json()) as { scheduled?: Scheduled; message?: Message };
    expect((body.scheduled ?? body.message)?.text).toBe("late retry");
    // A new request with the same past time is refused.
    const fresh = await call(f.tenant, "/channels/work/messages", f.agent, "POST", input);
    expect(fresh.status).toBe(400);
    expect(((await fresh.json()) as { error: { code: string } }).error.code).toBe("invalid_send_at");
  });

  it("refuses an immediate send under a key that a scheduled message holds", async () => {
    const f = await fixture();
    const headers = { "Idempotency-Key": "sched-held" };
    const input = { username: "lead", text: "held", sendAt: later() };
    expect((await call(f.tenant, "/channels/work/messages", f.agent, "POST", input, headers)).status).toBe(
      201,
    );
    const now = await call(
      f.tenant,
      "/channels/work/messages",
      f.agent,
      "POST",
      { username: "lead", text: "held" },
      headers,
    );
    expect(now.status).toBe(409);
    expect(((await now.json()) as { error: { code: string } }).error.code).toBe("idempotency_conflict");
    expect(await f.messages()).toEqual([]);
    await f.arrive();
    expect((await f.messages()).map((m) => m.text)).toEqual(["held"]);
    expect(await f.list()).toEqual([]);
  });

  it("sets the alarm for a failed message's expiry and removes it when the alarm runs", async () => {
    const f = await fixture();
    const scheduled = await f.schedule("will fail");
    expect((await call(f.tenant, "/channels/work/archive", f.owner, "PUT")).status).toBe(200);
    await f.arrive();
    const [failed] = await f.list();
    expect(failed.status).toBe("failed");
    // Nothing waits, but the failed row still needs the alarm to expire it.
    const failedAt = await runInDurableObject(
      f.stub(),
      (_, state) =>
        state.storage.sql
          .exec<{ failedAt: string }>("SELECT failedAt FROM scheduled_messages WHERE id = ?", scheduled.id)
          .one().failedAt,
    );
    expect(await f.alarm()).toBe(Date.parse(failedAt) + 7 * 24 * 3600_000);
    // Past the TTL, the list hides it at once and the alarm removes it.
    await runInDurableObject(f.stub(), (_, state) => {
      state.storage.sql.exec(
        "UPDATE scheduled_messages SET failedAt = ? WHERE id = ?",
        new Date(Date.now() - 8 * 24 * 3600_000).toISOString(),
        scheduled.id,
      );
    });
    expect(await f.list()).toEqual([]);
    await runInDurableObject(f.stub(), (_, state) => state.storage.setAlarm(Date.now() + 3600_000));
    await runDurableObjectAlarm(f.stub());
    const left = await runInDurableObject(
      f.stub(),
      (_, state) => state.storage.sql.exec("SELECT id FROM scheduled_messages").toArray().length,
    );
    expect(left).toBe(0);
    expect(await f.alarm()).toBeNull();
  });

  it("carries a reply's quote through the schedule, a text change and posting", async () => {
    const f = await fixture();
    const source = await call(f.tenant, "/channels/work/messages", f.agent, "POST", {
      username: "dev",
      text: "Review the ADR. Then tag the CLI.",
    });
    const parent = ((await source.json()) as { message: Message }).message;
    const input = {
      username: "lead",
      text: "Will tag it.",
      replyTo: parent.id,
      quote: "Then tag the CLI.",
      sendAt: later(),
    };
    const headers = { "Idempotency-Key": "sched-quote" };
    const first = await call(f.tenant, "/channels/work/messages", f.agent, "POST", input, headers);
    expect(first.status).toBe(201);
    const scheduled = ((await first.json()) as { scheduled: Scheduled & { quote?: string } }).scheduled;
    expect(scheduled).toMatchObject({ replyTo: parent.id, quote: "Then tag the CLI." });
    // The quote is part of the digest, as for a direct send.
    const other = await call(
      f.tenant,
      "/channels/work/messages",
      f.agent,
      "POST",
      { ...input, quote: "Review the ADR." },
      headers,
    );
    expect(other.status).toBe(409);
    // A text change keeps the quote.
    const changed = await call(f.tenant, `/channels/work/scheduled/${scheduled.id}`, f.agent, "PATCH", {
      username: "lead",
      text: "Tagging it now.",
    });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as { scheduled: { quote?: string } }).scheduled.quote).toBe(
      "Then tag the CLI.",
    );
    await f.arrive();
    const posted = (await f.messages()).find((m) => m.username === "lead") as Message & {
      replyTo?: number;
      quote?: string;
    };
    expect(posted).toMatchObject({ text: "Tagging it now.", replyTo: parent.id, quote: "Then tag the CLI." });
    // A quote still needs replyTo when scheduled.
    const lone = await call(f.tenant, "/channels/work/messages", f.agent, "POST", {
      username: "lead",
      text: "x",
      quote: "y",
      sendAt: later(),
    });
    expect(lone.status).toBe(400);
  });

  it("backs off when an alarm job keeps throwing instead of re-firing at once", async () => {
    const f = await fixture();
    await runInDurableObject(f.stub(), async (instance, state) => {
      const object = instance as unknown as {
        backfillSearch: () => void;
        searchIndexed: () => boolean;
        alarm: () => Promise<void>;
      };
      // Backfill that never finishes and always throws would otherwise set the alarm to now.
      object.searchIndexed = () => false;
      object.backfillSearch = () => {
        throw new Error("boom");
      };
      const before = Date.now();
      await object.alarm();
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(before + 30_000);
    });
  });

  it("queues and sends a webhook notice when a scheduled message to a persona with a webhook posts", async () => {
    const f = await fixture();
    const sent: { url: string; body: string }[] = [];
    await runInDurableObject(f.stub(), (instance) => {
      (
        instance as unknown as { webhookFetch: (input: unknown, init?: RequestInit) => Promise<Response> }
      ).webhookFetch = async (input, init) => {
        sent.push({ url: String(input), body: String(init?.body) });
        return new Response("ok");
      };
    });
    const hook = await call(f.tenant, "/channels/work/personas/dev/webhook", f.owner, "PUT", {
      url: "https://agent.example.com/wake",
    });
    expect(hook.status).toBeLessThan(300);
    await f.schedule("Your turn", { to: "dev" });
    expect(sent).toEqual([]);
    await f.arrive();
    const [posted] = await f.messages();
    expect(posted.text).toBe("Your turn");
    // The same alarm run that posted it also sent the notice.
    expect(sent.length).toBe(1);
    expect(sent[0].url).toBe("https://agent.example.com/wake");
    expect(JSON.parse(sent[0].body)).toMatchObject({
      type: "message.addressed",
      channel: "work",
      persona: "dev",
    });
  });

  it("keeps the alarm set when one alarm job throws", async () => {
    const f = await fixture();
    const scheduled = await f.schedule("still armed");
    await runInDurableObject(f.stub(), async (instance, state) => {
      await state.storage.deleteAlarm();
      const object = instance as unknown as { postDue: () => number; alarm: () => Promise<void> };
      object.postDue = () => {
        throw new Error("boom");
      };
      await object.alarm();
      expect(await state.storage.getAlarm()).toBe(Date.parse(scheduled.sendAt));
    });
  });

  it("schedules instead of posting, lists it, and the alarm posts it as a normal message", async () => {
    const f = await fixture();
    const first = (await (
      await call(f.tenant, "/channels/work/messages", f.agent, "POST", { username: "lead", text: "earlier" })
    ).json()) as { message: Message };
    const scheduled = await f.schedule("Standup in 5 minutes", {
      replyTo: first.message.id,
      labels: { kind: "reminder" },
    });
    expect(scheduled).toMatchObject({
      channel: "work",
      username: "lead",
      text: "Standup in 5 minutes",
      status: "pending",
      replyTo: first.message.id,
      labels: { kind: "reminder" },
    });
    expect(scheduled.personaId).toBe("lead");
    // Nothing posted yet, and the alarm waits for the time.
    expect((await f.messages()).map((m) => m.text)).toEqual(["earlier"]);
    expect(await f.list()).toEqual([scheduled]);
    expect(await f.alarm()).toBe(Date.parse(scheduled.sendAt));
    await f.arrive();
    const posted = await f.messages();
    expect(posted.map((m) => m.text)).toEqual(["earlier", "Standup in 5 minutes"]);
    expect(posted[1]).toMatchObject({
      username: "lead",
      personaId: "lead",
      replyTo: first.message.id,
      labels: { kind: "reminder" },
    });
    expect(await f.list()).toEqual([]);
    // Posted messages go through the normal journal, so listeners hear of them.
    const events = (await (await call(f.tenant, "/events?channel=work", f.agent)).json()) as {
      events: { type: string; resourceId: number }[];
    };
    expect(events.events.filter((e) => e.type === "message.created").map((e) => e.resourceId)).toEqual([
      first.message.id,
      posted[1].id,
    ]);
    // Nothing is left to do, so no alarm stays set.
    expect(await f.alarm()).toBeNull();
  });

  it("posts only what is due, oldest first, and sets the alarm for the next one", async () => {
    const f = await fixture();
    const soon = await f.schedule("soon", { sendAt: later(60_000) });
    const next = await f.schedule("next", { sendAt: later(120_000) });
    const far = await f.schedule("far", { sendAt: later(86400_000) });
    expect((await f.list()).map((s) => s.id)).toEqual([soon.id, next.id, far.id]);
    expect(await f.alarm()).toBe(Date.parse(soon.sendAt));
    await runInDurableObject(f.stub(), (_, state) => {
      // One clock reading, so "next" is always 1 ms earlier than "soon" (two readings could tie).
      const now = Date.now();
      state.storage.sql.exec("UPDATE scheduled_messages SET dueMs = ? WHERE id = ?", now - 1, soon.id);
      state.storage.sql.exec("UPDATE scheduled_messages SET dueMs = ? WHERE id = ?", now - 2, next.id);
    });
    await runInDurableObject(f.stub(), (_, state) => state.storage.setAlarm(Date.now() + 3600_000));
    await runDurableObjectAlarm(f.stub());
    // The earlier due time posts first, whatever order they were scheduled in.
    expect((await f.messages()).map((m) => m.text)).toEqual(["next", "soon"]);
    expect((await f.list()).map((s) => s.id)).toEqual([far.id]);
    expect(await f.alarm()).toBe(Date.parse(far.sendAt));
  });

  it("lets the sender change the text and time, and others only read it", async () => {
    const f = await fixture();
    const scheduled = await f.schedule("Draft note");
    const sendAt = later(7200_000);
    const changed = await call(f.tenant, `/channels/work/scheduled/${scheduled.id}`, f.agent, "PATCH", {
      username: "lead",
      text: "Final note",
      sendAt,
    });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as { scheduled: Scheduled }).scheduled).toMatchObject({
      id: scheduled.id,
      text: "Final note",
      sendAt,
    });
    expect(await f.alarm()).toBe(Date.parse(sendAt));
    // Another persona and the owner can see it but not change it.
    const other = await call(f.tenant, `/channels/work/scheduled/${scheduled.id}`, f.agent, "PATCH", {
      username: "dev",
      text: "hijack",
    });
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe("not_sender");
    const byOwner = await call(f.tenant, `/channels/work/scheduled/${scheduled.id}`, f.owner, "PATCH", {
      username: "lead",
      text: "owner rewrite",
    });
    expect(byOwner.status).toBe(403);
    expect((await f.list(f.owner)).map((s) => s.text)).toEqual(["Final note"]);
    // Unknown fields, nothing to change and a past time are refused.
    for (const [input, code] of [
      [{ username: "lead", text: "x", extra: 1 }, "invalid_scheduled"],
      [{ username: "lead" }, "invalid_scheduled"],
      [{ username: "lead", sendAt: "2020-01-01T00:00:00Z" }, "invalid_send_at"],
    ] as const) {
      const response = await call(
        f.tenant,
        `/channels/work/scheduled/${scheduled.id}`,
        f.agent,
        "PATCH",
        input,
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    }
    await f.arrive();
    expect((await f.messages()).map((m) => m.text)).toEqual(["Final note"]);
    // After it posts, it can no longer be changed here.
    const gone = await call(f.tenant, `/channels/work/scheduled/${scheduled.id}`, f.agent, "PATCH", {
      username: "lead",
      text: "too late",
    });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { error: { code: string } }).error.code).toBe("scheduled_not_found");
  });

  it("cancels for the sender or the owner, and never posts a cancelled message", async () => {
    const f = await fixture();
    const a = await f.schedule("cancel me");
    const b = await f.schedule("owner cancels me", {}, "dev");
    expect(
      (await call(f.tenant, `/channels/work/scheduled/${a.id}?username=dev`, f.agent, "DELETE")).status,
    ).toBe(403);
    expect((await call(f.tenant, `/channels/work/scheduled/${a.id}`, f.agent, "DELETE")).status).toBe(400);
    expect(
      (await call(f.tenant, `/channels/work/scheduled/${a.id}?username=lead`, f.agent, "DELETE")).status,
    ).toBe(204);
    expect(
      (await call(f.tenant, `/channels/work/scheduled/${b.id}?username=human`, f.owner, "DELETE")).status,
    ).toBe(204);
    expect(await f.list()).toEqual([]);
    expect(await f.alarm()).toBeNull();
    await f.arrive();
    expect(await f.messages()).toEqual([]);
  });

  it("applies the send checks when scheduling", async () => {
    const f = await fixture();
    const post = (input: object, token = f.agent) =>
      call(f.tenant, "/channels/work/messages", token, "POST", { sendAt: later(), ...input });
    const code = async (response: Response) =>
      ((await response.json()) as { error: { code: string } }).error.code;
    // The board credential schedules only as a registered persona.
    const stranger = await post({ username: "stranger", text: "hi" });
    expect(stranger.status).toBe(400);
    expect(await code(stranger)).toBe("persona_required");
    const github = await post({ username: "github", text: "hi" }, f.owner);
    expect(github.status).toBe(403);
    const past = await post({ username: "lead", text: "hi", sendAt: "2020-01-01T00:00:00Z" });
    expect(await code(past)).toBe("invalid_send_at");
    const local = await post({ username: "lead", text: "hi", sendAt: "2030-01-01T09:00:00" });
    expect(await code(local)).toBe("invalid_send_at");
    const files = await post({
      username: "lead",
      text: "hi",
      attachments: [{ id: "a".repeat(32), name: "a.txt", mediaType: "text/plain" }],
    });
    expect(files.status).toBe(400);
    const json = await post({ username: "lead", text: "{not json", contentType: "application/json" });
    expect(json.status).toBe(400);
    // A watch-only key cannot schedule.
    const invite = (await (
      await call(f.tenant, "/invites", f.owner, "POST", { channel: "work", watch: true })
    ).json()) as { code: string };
    const redeemed = await call(f.tenant, "/invites/redeem", undefined, "POST", {
      code: invite.code,
      username: "viewer",
    });
    const viewer = ((await redeemed.json()) as { token: string }).token;
    expect((await post({ username: "viewer", text: "hi" }, viewer)).status).toBe(403);
    // ...but can read the schedule.
    expect((await call(f.tenant, "/channels/work/scheduled", viewer)).status).toBe(200);
    expect(await f.list()).toEqual([]);
  });

  it("replays an Idempotency-Key and keeps it on the posted message", async () => {
    const f = await fixture();
    const input = { username: "lead", text: "once", sendAt: later() };
    const headers = { "Idempotency-Key": "sched-1" };
    const first = await call(f.tenant, "/channels/work/messages", f.agent, "POST", input, headers);
    expect(first.status).toBe(201);
    const again = await call(f.tenant, "/channels/work/messages", f.agent, "POST", input, headers);
    expect(again.status).toBe(200);
    const created = ((await first.json()) as { scheduled: Scheduled }).scheduled;
    expect(((await again.json()) as { scheduled: Scheduled }).scheduled.id).toBe(created.id);
    const other = await call(
      f.tenant,
      "/channels/work/messages",
      f.agent,
      "POST",
      { ...input, text: "twice" },
      headers,
    );
    expect(other.status).toBe(409);
    expect((await f.list()).length).toBe(1);
    await f.arrive();
    // After it posts, a retry of the scheduling request replays the message it became.
    const late = await call(f.tenant, "/channels/work/messages", f.agent, "POST", input, headers);
    expect(late.status).toBe(200);
    const replay = (await late.json()) as { message: Message };
    expect(replay.message.text).toBe("once");
    expect((await f.messages()).length).toBe(1);
    // A plain retry of the posted message's key with different content still conflicts.
    const plain = await call(
      f.tenant,
      "/channels/work/messages",
      f.agent,
      "POST",
      { username: "lead", text: "once" },
      headers,
    );
    expect(plain.status).toBe(409);
  });

  it("marks a message failed when its board was archived, and the sender can retry at a new time", async () => {
    const f = await fixture();
    const scheduled = await f.schedule("after archive");
    expect((await call(f.tenant, "/channels/work/archive", f.owner, "PUT")).status).toBe(200);
    await f.arrive();
    const [failed] = await f.list();
    expect(failed).toMatchObject({ id: scheduled.id, status: "failed", error: { code: "board_archived" } });
    expect(await f.messages()).toEqual([]);
    // A failed message holds the alarm only for its 7-day expiry, not for posting.
    expect(await f.alarm()).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
    // Changing it on an archived board is refused, but cancelling is allowed.
    expect(
      (
        await call(f.tenant, `/channels/work/scheduled/${scheduled.id}`, f.agent, "PATCH", {
          username: "lead",
          sendAt: later(),
        })
      ).status,
    ).toBe(409);
    expect((await call(f.tenant, "/channels/work/archive", f.owner, "DELETE")).status).toBe(200);
    const retried = await call(f.tenant, `/channels/work/scheduled/${scheduled.id}`, f.agent, "PATCH", {
      username: "lead",
      sendAt: later(),
    });
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as { scheduled: Scheduled }).scheduled).toMatchObject({
      status: "pending",
    });
    expect("error" in (await f.list())[0]).toBe(false);
    await f.arrive();
    expect((await f.messages()).map((m) => m.text)).toEqual(["after archive"]);
  });

  it("allows cancelling a failed message on an archived board", async () => {
    const f = await fixture();
    const scheduled = await f.schedule("stuck");
    await call(f.tenant, "/channels/work/archive", f.owner, "PUT");
    await f.arrive();
    expect(
      (await call(f.tenant, `/channels/work/scheduled/${scheduled.id}?username=lead`, f.agent, "DELETE"))
        .status,
    ).toBe(204);
    expect(await f.list()).toEqual([]);
  });

  it("fails a message whose key was revoked, and a current key can post it", async () => {
    const f = await fixture();
    const issued = await exports.default.fetch(`https://msn.test/api/admin/tenants/${f.tenant}/keys/helper`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "helper" }),
    });
    expect(issued.status).toBe(201);
    const helper = ((await issued.json()) as { token: string }).token;
    const scheduled = await f.schedule("from helper", {}, "helper", helper);
    const revoked = await exports.default.fetch(
      `https://msn.test/api/admin/tenants/${f.tenant}/keys/helper`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ADMIN}` },
      },
    );
    expect(revoked.status).toBe(204);
    await f.arrive();
    expect((await f.list(f.owner))[0]).toMatchObject({ status: "failed", error: { code: "key_revoked" } });
    expect(await f.messages(f.owner)).toEqual([]);
    // A new key for the same name takes the message over with a new time.
    const reissued = await exports.default.fetch(
      `https://msn.test/api/admin/tenants/${f.tenant}/keys/helper2`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ username: "helper" }),
      },
    );
    const current = ((await reissued.json()) as { token: string }).token;
    const retried = await call(f.tenant, `/channels/work/scheduled/${scheduled.id}`, current, "PATCH", {
      username: "helper",
      sendAt: later(),
    });
    expect(retried.status).toBe(200);
    await f.arrive();
    expect((await f.messages(f.owner)).map((m) => m.username)).toEqual(["helper"]);
  });

  it("caps scheduled messages per board", async () => {
    const f = await fixture();
    await runInDurableObject(f.stub(), (_, state) => {
      for (let i = 0; i < 100; i++)
        state.storage.sql.exec(
          `INSERT INTO scheduled_messages(tenant, channel, username, text, contentType, sendAt, dueMs, createdAt,
             updatedAt, digest, tokenHash, notify) VALUES (?, 'work', 'lead', 'x', 'text/plain', ?, ?, ?, ?, '', '', 1)`,
          f.tenant,
          later(),
          Date.now() + 3600_000,
          new Date().toISOString(),
          new Date().toISOString(),
        );
    });
    const response = await call(f.tenant, "/channels/work/messages", f.agent, "POST", {
      username: "lead",
      text: "one too many",
      sendAt: later(),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("scheduled_quota");
  });

  it("caps waiting messages per sender, leaves failed ones out, and expires failed ones after 7 days", async () => {
    const f = await fixture();
    const insert = (failedAt: string | null) =>
      runInDurableObject(f.stub(), (_, state) => {
        state.storage.sql.exec(
          `INSERT INTO scheduled_messages(tenant, channel, username, text, contentType, sendAt, dueMs, createdAt,
             updatedAt, digest, tokenHash, notify, failedAt, error, errorMessage)
           VALUES (?, 'work', 'lead', 'x', 'text/plain', ?, ?, ?, ?, '', '', 1, ?, ?, ?)`,
          f.tenant,
          later(),
          Date.now() + 3600_000,
          new Date().toISOString(),
          new Date().toISOString(),
          failedAt,
          failedAt ? "board_archived" : null,
          failedAt ? "x" : null,
        );
      });
    for (let i = 0; i < 25; i++) await insert(null);
    const post = (username: string) =>
      call(f.tenant, "/channels/work/messages", f.agent, "POST", { username, text: "more", sendAt: later() });
    const refused = await post("lead");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("scheduled_quota");
    // Another sender on the same board is not held back.
    expect((await post("dev")).status).toBe(201);
    // Failed messages do not count toward the sender's cap.
    await runInDurableObject(f.stub(), (_, state) => {
      state.storage.sql.exec(
        "UPDATE scheduled_messages SET failedAt = ?, error = 'board_archived', errorMessage = 'x' WHERE username = 'lead'",
        new Date().toISOString(),
      );
    });
    expect((await post("lead")).status).toBe(201);
    // A failed message older than 7 days is hidden from the list at once and removed the next
    // time the schedule changes.
    await insert(new Date(Date.now() - 8 * 24 * 3600_000).toISOString());
    const rows = () =>
      runInDurableObject(
        f.stub(),
        (_, state) =>
          state.storage.sql.exec("SELECT id FROM scheduled_messages WHERE failedAt IS NOT NULL").toArray()
            .length,
      );
    expect(await rows()).toBe(26);
    expect((await f.list()).filter((item) => item.status === "failed").length).toBe(25);
    expect((await post("lead")).status).toBe(201);
    expect(await rows()).toBe(25);
  });
});
