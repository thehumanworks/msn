import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  automatedSender,
  CHANNEL_MENTION_CAP,
  CHANNEL_MENTION_WINDOW_MS,
  channelMentionLimited,
  expandChannelRecipients,
  mentionsChannel,
} from "../src/channel-mention";
import type { MsnDurableObject } from "../src/store";

// @channel (ADR 0086).
// I1 a member's @channel addresses every other member, not the sender -> sender is a member
// I2 an otherwise empty channel still stores the message, addressed to nobody -> empty channel
// I3 case, word boundary, code and JSON do not over-match -> token edges
// I4 names are deduped; explicit To is kept; "channel" is not a person -> dedupe and reserved
// I5 each recipient gets a delivery row; each other agent gets one addressed webhook -> ticks and webhooks
// I6 an agent cannot @channel again inside the window; a person can -> echo cap
// I7 more than CHANNEL_MENTION_CAP other members refuses the send -> fan-out cap
// I8 an edit does not resolve the token again; a retry replays the first expansion -> edit and replay

const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });

type Msg = {
  id: number;
  username: string;
  text: string;
  to?: string;
  recipients?: string[];
  delivery?: { name: string; deliveredAt: string | null; readAt: string | null }[];
};

async function fixture() {
  const tenant = `ch-${crypto.randomUUID()}`;
  const owner = (
    await (await call(tenant, "", undefined, "PUT", { username: "human" })).json<{ token: string }>()
  ).token;
  const agent = "e".repeat(64);
  expect(
    (await call(tenant, "/channels/work/board", owner, "PUT", { credential: agent, goal: "Ship it" })).status,
  ).toBe(201);
  for (const [id, name] of [
    ["lead", "lead"],
    ["rev", "reviewer"],
    ["work", "worker"],
  ])
    expect(
      (await call(tenant, `/channels/work/personas/${id}`, agent, "PUT", { displayName: name })).status,
    ).toBe(201);
  const invite = async (username: string, watch = false) => {
    const link = await (
      await call(tenant, "/invites", owner, "POST", { channel: "work", ...(watch ? { watch: true } : {}) })
    ).json<{ code: string }>();
    const joined = await (
      await call(tenant, "/invites/redeem", undefined, "POST", { code: link.code, username })
    ).json<{ token: string; username: string }>();
    expect(joined.username).toBe(username);
    return joined.token;
  };
  const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant]));
  const post = async (token: string, input: Record<string, unknown>, key?: string) => {
    const response = await exports.default.fetch(
      `https://msn.test/api/tenants/${tenant}/channels/work/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: JSON.stringify({ username: token === owner ? "human" : "lead", text: "hello", ...input }),
      },
    );
    return response;
  };
  return { tenant, owner, agent, stub, invite, post };
}

describe("@channel rules", () => {
  const now = Date.parse("2026-11-23T12:00:00.000Z");

  it("matches @channel outside code, in any case, and not inside a word or an address", () => {
    expect(mentionsChannel("@channel")).toBe(true);
    expect(mentionsChannel("hey @CHANNEL.")).toBe(true);
    expect(mentionsChannel("(@Channel)")).toBe(true);
    expect(mentionsChannel("line\n@channel")).toBe(true);
    expect(mentionsChannel("@channeling")).toBe(false);
    expect(mentionsChannel("@channel-wide")).toBe(false);
    expect(mentionsChannel("a@channel")).toBe(false);
    expect(mentionsChannel("me@channel.com")).toBe(false);
    expect(mentionsChannel("@channelé")).toBe(false);
    expect(mentionsChannel("see `@channel` please")).toBe(false);
    expect(mentionsChannel("see `@channel`\n@channel")).toBe(true);
    expect(mentionsChannel("```\n@channel\n```\n")).toBe(false);
    expect(mentionsChannel("~~~\n@channel\n~~~\nstill @channel")).toBe(true);
    expect(mentionsChannel("")).toBe(false);
  });

  it("drops the sender and the token, keeps the first spelling, then explicit names", () => {
    expect(
      expandChannelRecipients(["human", "Human", "lead", "channel", " ada "], "Lead", ["guest", "human"]),
    ).toEqual(["human", "ada", "guest"]);
    expect(expandChannelRecipients(["only"], "only")).toEqual([]);
    expect(automatedSender({ username: "lead", personaId: "lead" })).toBe(true);
    expect(automatedSender({ username: "lead", agentUserId: "u" })).toBe(true);
    expect(automatedSender({ username: "github" })).toBe(true);
    expect(automatedSender({ username: "human", personaId: null, agentUserId: null })).toBe(false);
  });

  it("limits only an automated sender, and only while a mention is inside the window", () => {
    const hit = (age: number, text = "@channel") => ({
      text,
      createdAt: new Date(now - age).toISOString(),
    });
    expect(channelMentionLimited(false, [hit(0)], now)).toBe(false);
    expect(channelMentionLimited(true, [hit(0)], now)).toBe(true);
    expect(channelMentionLimited(true, [hit(CHANNEL_MENTION_WINDOW_MS - 1)], now)).toBe(true);
    expect(channelMentionLimited(true, [hit(CHANNEL_MENTION_WINDOW_MS)], now)).toBe(false);
    expect(channelMentionLimited(true, [hit(0, "see `@channel`")], now)).toBe(false);
    expect(channelMentionLimited(true, [hit(0, "hello")], now)).toBe(false);
  });
});

describe("@channel on a board", () => {
  it("given the sender is a member, when the text contains @channel, then every other member is addressed and the sender is not", async () => {
    const f = await fixture();
    const ada = await f.invite("ada");
    await f.invite("pat", true);
    for (const persona of ["lead", "rev", "work"])
      expect(
        (
          await call(f.tenant, `/channels/work/personas/${persona}/webhook`, f.owner, "PUT", {
            url: `https://agent.example.com/${persona}`,
          })
        ).status,
      ).toBe(201);
    const sent = await f.post(f.agent, { username: "lead", text: "hey @CHANNEL" });
    expect(sent.status).toBe(201);
    const message = (await sent.json<{ message: Msg }>()).message;
    expect(message).toMatchObject({
      to: "human",
      recipients: ["human", "ada", "pat", "reviewer", "worker"],
    });
    expect(message.recipients).not.toContain("lead");
    expect(message.delivery?.map((row) => row.name)).toEqual(message.recipients);
    expect(message.delivery?.every((row) => row.deliveredAt === null && row.readAt === null)).toBe(true);
    const notices = await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) =>
      state.storage.sql
        .exec<{ personaId: string; body: string }>(
          "SELECT personaId, body FROM webhook_notices ORDER BY personaId",
        )
        .toArray(),
    );
    expect(notices.map((row) => row.personaId)).toEqual(["rev", "work"]);
    expect(notices.every((row) => row.body.includes("message.addressed"))).toBe(true);
    // The same key replays the first expansion. A new key sees a member who joined after.
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec(
        "INSERT INTO personas VALUES (?, ?, ?, ?)",
        "work",
        "extra",
        "extra",
        new Date().toISOString(),
      );
    });
    // A new key is a new send. The agent is still inside the echo window, so it is refused.
    expect((await f.post(f.agent, { username: "lead", text: "hey @CHANNEL" }, "once")).status).toBe(429);
    const quiet = await f.post(f.owner, { text: "see `@channel` in the docs" });
    expect(quiet.status).toBe(201);
    expect((await quiet.json<{ message: Msg }>()).message.to).toBeUndefined();
    // A person is not limited, so this still expands, including a member who joined after the first send.
    const again = await f.post(ada, { username: "ada", text: "@channel" });
    expect(again.status).toBe(201);
    const people = (await again.json<{ message: Msg }>()).message.recipients;
    expect(people).toContain("human");
    expect(people).toContain("extra");
    expect(people).not.toContain("ada");
  });

  it("given a channel whose only member is the sender, when they mention @channel, then the message is stored and addressed to nobody", async () => {
    const tenant = `empty-${crypto.randomUUID()}`;
    const owner = (
      await (await call(tenant, "", undefined, "PUT", { username: "human" })).json<{ token: string }>()
    ).token;
    expect(
      (
        await call(tenant, "/channels/quiet/board", owner, "PUT", {
          credential: "f".repeat(64),
          goal: "Quiet",
        })
      ).status,
    ).toBe(201);
    const response = await call(tenant, "/channels/quiet/messages", owner, "POST", {
      username: "human",
      text: "@channel",
    });
    expect(response.status).toBe(201);
    const message = (await response.json<{ message: Msg }>()).message;
    expect(message.text).toBe("@channel");
    expect(message.to).toBeUndefined();
    expect(message.recipients).toBeUndefined();
    expect(message.delivery).toBeUndefined();
  });

  it("refuses a second agent mention inside the window and allows it once that message is old", async () => {
    const f = await fixture();
    expect((await f.post(f.agent, { username: "lead", text: "@channel" })).status).toBe(201);
    const blocked = await f.post(f.agent, { username: "worker", text: "and @channel" });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: { code: "channel_mention_limited" } });
    const human = await f.post(f.owner, { text: "@channel from me" });
    expect(human.status).toBe(201);
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec(
        "UPDATE messages SET createdAt = ?",
        new Date(Date.now() - CHANNEL_MENTION_WINDOW_MS - 1000).toISOString(),
      );
    });
    expect((await f.post(f.agent, { username: "worker", text: "@channel later" })).status).toBe(201);
  });

  it("refuses @channel when more than the cap would be notified, and allows exactly the cap", async () => {
    const f = await fixture();
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      for (let i = 0; i < CHANNEL_MENTION_CAP - 3; i += 1)
        state.storage.sql.exec(
          "INSERT INTO personas VALUES (?, ?, ?, ?)",
          "work",
          `p${i}`,
          `agent-${i}`,
          new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        );
    });
    // Owner plus the three fixture personas is four members. The sender is one of them.
    // CAP - 3 extra personas makes CAP other members when lead sends (owner + reviewer + worker + extras).
    const within = await f.post(f.agent, { username: "lead", text: "@channel" });
    expect(within.status).toBe(201);
    expect((await within.json<{ message: Msg }>()).message.recipients).toHaveLength(CHANNEL_MENTION_CAP);
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec(
        "INSERT INTO personas VALUES (?, ?, ?, ?)",
        "work",
        "overflow",
        "overflow",
        "2026-02-01T00:00:00.000Z",
      );
    });
    const over = await f.post(f.owner, { text: "@channel" });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: { code: "channel_mention_capped" } });
  });

  it("reserves the name channel, rejects it as To, and does not expand JSON or a code span", async () => {
    const f = await fixture();
    expect(
      (await call(f.tenant, "/channels/work/personas/nope", f.agent, "PUT", { displayName: "Channel" }))
        .status,
    ).toBe(403);
    expect((await call(f.tenant, "/agents", f.owner, "POST", { name: "channel" })).status).toBe(403);
    const created = await call(`nope-${crypto.randomUUID()}`, "", undefined, "PUT", { username: "channel" });
    expect(created.status).toBe(403);
    const link = await (await call(f.tenant, "/invites", f.owner, "POST", { channel: "work" })).json<{
      code: string;
    }>();
    expect(
      (await call(f.tenant, "/invites/redeem", undefined, "POST", { code: link.code, username: "CHANNEL" }))
        .status,
    ).toBe(403);
    expect((await f.post(f.agent, { username: "lead", to: "channel", text: "hi" })).status).toBe(400);
    const json = await f.post(f.agent, {
      username: "lead",
      contentType: "application/json",
      text: JSON.stringify({ note: "@channel" }),
    });
    expect(json.status).toBe(201);
    expect((await json.json<{ message: Msg }>()).message.to).toBeUndefined();
    const code = await f.post(f.owner, { text: "see `@channel` only" });
    expect(code.status).toBe(201);
    expect((await code.json<{ message: Msg }>()).message.to).toBeUndefined();
    const question = await f.post(f.agent, {
      username: "lead",
      text: "@channel?",
      to: "reviewer",
      choices: ["yes", "no"],
    });
    expect(question.status).toBe(400);
    expect(await question.json()).toMatchObject({ error: { code: "invalid_choices" } });
  });

  it("keeps the first expansion on retry and does not re-resolve an edit", async () => {
    const f = await fixture();
    const first = await f.post(f.agent, { username: "lead", text: "@channel" }, "k1");
    expect(first.status).toBe(201);
    const original = (await first.json<{ message: Msg; replayed: boolean }>()).message;
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec("UPDATE messages SET createdAt = ?", "2020-01-01T00:00:00.000Z");
      state.storage.sql.exec(
        "INSERT INTO personas VALUES (?, ?, ?, ?)",
        "work",
        "late",
        "late",
        new Date().toISOString(),
      );
    });
    const retry = await f.post(f.agent, { username: "lead", text: "@channel" }, "k1");
    expect(retry.status).toBe(200);
    const replayed = await retry.json<{ message: Msg; replayed: boolean }>();
    expect(replayed.replayed).toBe(true);
    expect(replayed.message.recipients).toEqual(original.recipients);
    expect(replayed.message.recipients).not.toContain("late");
    const fresh = await f.post(f.agent, { username: "worker", text: "please @channel" }, "k2");
    expect(fresh.status).toBe(201);
    expect((await fresh.json<{ message: Msg }>()).message.recipients).toContain("late");
    const plain = await f.post(f.owner, { text: "note" });
    const noted = (await plain.json<{ message: Msg }>()).message;
    const edited = await call(f.tenant, `/channels/work/messages/${noted.id}`, f.owner, "PATCH", {
      username: "human",
      text: "note @channel",
    });
    expect(edited.status).toBe(200);
    expect((await edited.json<{ message: Msg }>()).message.to).toBeUndefined();
    const wiped = await call(f.tenant, `/channels/work/messages/${original.id}`, f.agent, "PATCH", {
      username: "lead",
      text: "no longer",
    });
    expect(wiped.status).toBe(200);
    expect((await wiped.json<{ message: Msg }>()).message.recipients).toEqual(original.recipients);
  });

  it("dedupes the owner and a persona who differ only by case, and keeps an explicit name", async () => {
    const f = await fixture();
    expect(
      (await call(f.tenant, "/channels/work/personas/same", f.agent, "PUT", { displayName: "Human" })).status,
    ).toBe(201);
    const sent = await f.post(f.agent, { username: "lead", text: "@channel", to: "guest" });
    expect(sent.status).toBe(201);
    const message = (await sent.json<{ message: Msg }>()).message;
    expect(message.recipients?.filter((name) => name.toLowerCase() === "human")).toEqual(["human"]);
    expect(message.recipients?.at(-1)).toBe("guest");
  });
});
