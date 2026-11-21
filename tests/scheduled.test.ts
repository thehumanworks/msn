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
    await runInDurableObject(stub(), (_, state) => state.storage.setAlarm(Date.now()));
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
    ])
      expect(() => sendAtTime(bad, now)).toThrow(/sendAt/);
  });
});

describe("send a message later (ADR 0060)", () => {
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
      state.storage.sql.exec(
        "UPDATE scheduled_messages SET dueMs = ? WHERE id IN (?, ?)",
        Date.now() - 1,
        soon.id,
        next.id,
      );
      state.storage.sql.exec("UPDATE scheduled_messages SET dueMs = ? WHERE id = ?", Date.now() - 2, next.id);
    });
    await runInDurableObject(f.stub(), (_, state) => state.storage.setAlarm(Date.now()));
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
    // A failed message no longer holds the alarm.
    expect(await f.alarm()).toBeNull();
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
});
