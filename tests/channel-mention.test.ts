import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { splitChannelMentions } from "../public/mention.js";
import {
  CHANNEL_MENTION_CAP,
  CHANNEL_MENTION_WINDOW_MS,
  channelMentionLimited,
  expandChannelRecipients,
  mentionsChannel,
} from "../src/channel-mention";
import { sign } from "../src/github";
import type { MsnDurableObject } from "../src/store";
import { MAX_PENDING_NOTICES } from "../src/webhook";

const ADMIN = "test-admin-secret-000000000000000000000";

// @channel (ADR 0086).
// I1 a member's @channel addresses every other member, not the sender -> sender is a member
// I2 an otherwise empty channel still stores the message, addressed to nobody -> empty channel
// I3 case, word boundary, code and JSON do not over-match -> token edges
// I4 names are deduped; explicit To is kept; "channel" is not a person -> dedupe and reserved
// I5 each recipient gets a delivery row; each other agent gets one addressed webhook -> ticks and webhooks
// I6 a non-owner cannot @channel again inside the window; the owner can, and a person's mention counts -> echo cap
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

async function deliverChannel(f: { tenant: string; owner: string }, body: string) {
  const secretResponse = await call(f.tenant, "/github/secret", f.owner, "POST");
  expect(secretResponse.status).toBe(200);
  const { secret } = await secretResponse.json<{ secret: string }>();
  expect(
    (await call(f.tenant, "/channels/work/github/pulls/TheHumanWorks/msn/34", f.owner, "PUT")).status,
  ).toBe(201);
  const payload = {
    action: "submitted",
    repository: { full_name: "TheHumanWorks/msn" },
    pull_request: { number: 34 },
    review: {
      state: "COMMENTED",
      body,
      user: { login: "reviewer" },
      html_url: "https://github.com/thehumanworks/msn/pull/34#pullrequestreview-9",
    },
  };
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const delivered = await exports.default.fetch(`https://msn.test/api/github/hooks/${f.tenant}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "pull_request_review",
      "X-GitHub-Delivery": crypto.randomUUID(),
      "X-Hub-Signature-256": await sign(secret, raw),
    },
    body: raw,
  });
  expect(delivered.status).toBe(200);
}

describe("@channel rules", () => {
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
    expect(mentionsChannel("**@channel**")).toBe(true);
    expect(mentionsChannel("_@channel_")).toBe(true);
    expect(mentionsChannel("**bold**@channel")).toBe(true);
    expect(mentionsChannel("``@channel``")).toBe(false);
    expect(mentionsChannel("``@channel`")).toBe(true);
    expect(mentionsChannel("snake_@channel")).toBe(false);
    expect(mentionsChannel("a*@channel")).toBe(false);
    expect(mentionsChannel("   ```\n@channel\n   ```\n")).toBe(false);
    expect(mentionsChannel("İ@channel")).toBe(false);
    expect(mentionsChannel("İ @channel")).toBe(true);
  });

  it("agrees with the web client on every token edge", () => {
    const samples = [
      "@channel",
      "hey @CHANNEL.",
      "(@Channel)",
      "**@channel**",
      "_@channel_",
      "**bold**@channel",
      "@channeling",
      "a@channel",
      "me@channel.com",
      "İ@channel",
      "İ @CHANNEL",
      "see `@channel` please",
      "see `@channel`\n@channel",
      "``@channel``",
      "``@channel`",
      "snake_@channel",
      "a*@channel",
      "```\n@channel\n```\n",
      "   ```\n@channel\n   ```\nstill @channel",
      "~~~\n@channel\n~~~\nstill @channel",
    ];
    for (const text of samples)
      expect(
        splitChannelMentions(text).some((part) => part.channel),
        text,
      ).toBe(mentionsChannel(text));
    const marked = splitChannelMentions("İ @CHANNEL").find((part) => part.channel);
    expect(marked?.text).toBe("@CHANNEL");
  });

  it("drops the sender and the token, keeps the first spelling, then explicit names", () => {
    expect(
      expandChannelRecipients(["human", "Human", "lead", "channel", " ada "], "Lead", ["guest", "human"]),
    ).toEqual(["human", "ada", "guest"]);
    expect(expandChannelRecipients(["only"], "only")).toEqual([]);
    expect(CHANNEL_MENTION_CAP).toBeLessThanOrEqual(MAX_PENDING_NOTICES);
  });

  it("limits every non-owner while a flagged mention is inside the window", () => {
    expect(channelMentionLimited(true, true)).toBe(false);
    expect(channelMentionLimited(false, true)).toBe(true);
    expect(channelMentionLimited(false, false)).toBe(false);
    expect(channelMentionLimited(true, false)).toBe(false);
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
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec(
        "INSERT INTO personas (channel, id, displayName, createdAt) VALUES (?, ?, ?, ?)",
        "work",
        "extra",
        "extra",
        new Date().toISOString(),
      );
    });
    // A new key is a new send. The window is still open, so another non-owner is refused.
    expect((await f.post(f.agent, { username: "lead", text: "hey @CHANNEL" }, "once")).status).toBe(429);
    const quiet = await f.post(f.owner, { text: "see `@channel` in the docs" });
    expect(quiet.status).toBe(201);
    expect((await quiet.json<{ message: Msg }>()).message.to).toBeUndefined();
    // ada is not the owner, so the open window still refuses them.
    expect((await f.post(ada, { username: "ada", text: "@channel" })).status).toBe(429);
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec(
        "UPDATE messages SET createdAt = ?",
        new Date(Date.now() - CHANNEL_MENTION_WINDOW_MS - 1000).toISOString(),
      );
    });
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

  it("refuses every non-owner inside the window, including after the text is edited or the message is deleted", async () => {
    const f = await fixture();
    const first = await f.post(f.agent, { username: "lead", text: "@channel" });
    expect(first.status).toBe(201);
    const id = (await first.json<{ message: Msg }>()).message.id;
    const blocked = await f.post(f.agent, { username: "worker", text: "and @channel" });
    expect(blocked.status).toBe(429);
    const body = await blocked.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("channel_mention_limited");
    expect(body.error.message).toContain("Only the owner");
    expect(body.error.message).toContain("a person's mention counts");
    const edited = await call(f.tenant, `/channels/work/messages/${id}`, f.agent, "PATCH", {
      username: "lead",
      text: "no token",
    });
    expect(edited.status).toBe(200);
    expect((await f.post(f.agent, { username: "worker", text: "@channel" })).status).toBe(429);
    const removed = await exports.default.fetch(
      `https://msn.test/api/admin/tenants/${f.tenant}/channels/work/messages/${id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN}` } },
    );
    expect(removed.status).toBe(204);
    expect((await f.post(f.agent, { username: "worker", text: "@channel" })).status).toBe(429);
    const human = await f.post(f.owner, { text: "@channel from me" });
    expect(human.status).toBe(201);
    const humanId = (await human.json<{ message: Msg }>()).message.id;
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec(
        "UPDATE messages SET createdAt = ? WHERE id <> ?",
        "2020-01-01T00:00:00.000Z",
        humanId,
      );
    });
    expect((await f.post(f.agent, { username: "worker", text: "@channel" })).status).toBe(429);
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec(
        "UPDATE messages SET createdAt = ?",
        new Date(Date.now() - CHANNEL_MENTION_WINDOW_MS).toISOString(),
      );
    });
    expect((await f.post(f.agent, { username: "worker", text: "@channel later" })).status).toBe(201);
  });

  it("refuses @channel when more than the cap would be notified, and allows exactly the cap", async () => {
    const f = await fixture();
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      for (let i = 0; i < CHANNEL_MENTION_CAP - 3; i += 1)
        state.storage.sql.exec(
          "INSERT INTO personas (channel, id, displayName, createdAt) VALUES (?, ?, ?, ?)",
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
        "INSERT INTO personas (channel, id, displayName, createdAt) VALUES (?, ?, ?, ?)",
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
    const persona = await call(f.tenant, "/channels/work/personas/nope", f.agent, "PUT", {
      displayName: "Channel",
    });
    expect(persona.status).toBe(403);
    expect(await persona.json()).toMatchObject({ error: { code: "reserved_name" } });
    const agent = await call(f.tenant, "/agents", f.owner, "POST", { name: "channel" });
    expect(agent.status).toBe(403);
    expect(await agent.json()).toMatchObject({ error: { code: "reserved_name" } });
    const created = await call(`nope-${crypto.randomUUID()}`, "", undefined, "PUT", { username: "channel" });
    expect(created.status).toBe(403);
    expect(await created.json()).toMatchObject({ error: { code: "reserved_name" } });
    const link = await (await call(f.tenant, "/invites", f.owner, "POST", { channel: "work" })).json<{
      code: string;
    }>();
    const redeemed = await call(f.tenant, "/invites/redeem", undefined, "POST", {
      code: link.code,
      username: "CHANNEL",
    });
    expect(redeemed.status).toBe(403);
    expect(await redeemed.json()).toMatchObject({ error: { code: "reserved_name" } });
    const bound = await exports.default.fetch(`https://msn.test/api/admin/tenants/${f.tenant}/keys/bound`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "channel" }),
    });
    expect(bound.status).toBe(403);
    expect(await bound.json()).toMatchObject({ error: { code: "reserved_name" } });
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
        "INSERT INTO personas (channel, id, displayName, createdAt) VALUES (?, ?, ?, ?)",
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
    const refused = await call(f.tenant, "/channels/work/personas/same", f.agent, "PUT", {
      displayName: "Human",
    });
    expect(refused.status).toBe(403);
    expect((await refused.json<{ error: { code: string } }>()).error.code).toBe("owner_name");
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec(
        "INSERT INTO personas (channel, id, displayName, createdAt) VALUES (?, ?, ?, ?)",
        "work",
        "same",
        "Human",
        new Date().toISOString(),
      );
    });
    const sent = await f.post(f.agent, { username: "lead", text: "@channel", to: "guest" });
    expect(sent.status).toBe(201);
    const message = (await sent.json<{ message: Msg }>()).message;
    expect(message.recipients?.filter((name) => name.toLowerCase() === "human")).toEqual(["human"]);
    expect(message.recipients?.at(-1)).toBe("guest");
  });

  it("keeps an explicit name on an empty board, and a quoted @channel does not mention anyone", async () => {
    const tenant = `empty-${crypto.randomUUID()}`;
    const owner = (
      await (await call(tenant, "", undefined, "PUT", { username: "human" })).json<{ token: string }>()
    ).token;
    expect(
      (
        await call(tenant, "/channels/quiet/board", owner, "PUT", {
          credential: "a".repeat(64),
          goal: "Quiet",
        })
      ).status,
    ).toBe(201);
    const kept = await call(tenant, "/channels/quiet/messages", owner, "POST", {
      username: "human",
      text: "@channel",
      to: "guest",
    });
    expect(kept.status).toBe(201);
    expect((await kept.json<{ message: Msg }>()).message.to).toBe("guest");
    const f = await fixture();
    const root = await f.post(f.owner, { text: "the plan" });
    const rootId = (await root.json<{ message: Msg }>()).message.id;
    const quoted = await f.post(f.agent, {
      username: "lead",
      text: "noted",
      replyTo: rootId,
      quote: "please @channel everyone",
    });
    expect(quoted.status).toBe(201);
    expect((await quoted.json<{ message: Msg }>()).message.to).toBeUndefined();
    const own = await f.post(f.agent, {
      username: "reviewer",
      text: "@channel",
      replyTo: rootId,
      quote: "the plan",
    });
    expect(own.status).toBe(201);
    expect((await own.json<{ message: Msg }>()).message.recipients).toContain("human");
  });

  it("skips a revoked key and a key for another channel, and still lets a persona named channel post", async () => {
    const f = await fixture();
    const link = await (await call(f.tenant, "/invites", f.owner, "POST", { channel: "work" })).json<{
      code: string;
    }>();
    const joined = await (
      await call(f.tenant, "/invites/redeem", undefined, "POST", { code: link.code, username: "gone" })
    ).json<{ token: string; keyId: string }>();
    const revoked = await exports.default.fetch(
      `https://msn.test/api/admin/tenants/${f.tenant}/keys/${joined.keyId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN}` } },
    );
    expect(revoked.status).toBe(204);
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec(
        "INSERT INTO access_keys (id, token_hash, bound_username, bound_prefix, createdAt, channel_scope) VALUES (?, ?, ?, NULL, ?, ?)",
        "other-key",
        "b".repeat(64),
        "bob",
        new Date().toISOString(),
        "other",
      );
      state.storage.sql.exec(
        "INSERT INTO access_keys (id, token_hash, bound_username, bound_prefix, createdAt, channel_scope) VALUES (?, ?, ?, NULL, ?, NULL)",
        "wide-key",
        "c".repeat(64),
        "wide",
        new Date().toISOString(),
      );
      state.storage.sql.exec(
        "INSERT INTO personas (channel, id, displayName, createdAt) VALUES (?, ?, ?, ?)",
        "work",
        "held",
        "channel",
        new Date().toISOString(),
      );
    });
    const held = await f.post(f.agent, { username: "channel", text: "I can still talk" });
    expect(held.status).toBe(201);
    expect((await f.post(f.agent, { username: "lead", to: "channel", text: "hi" })).status).toBe(400);
    const sent = await f.post(f.owner, { text: "@channel" });
    expect(sent.status).toBe(201);
    const names = (await sent.json<{ message: Msg }>()).message.recipients ?? [];
    expect(names).toContain("wide");
    expect(names).not.toContain("gone");
    expect(names).not.toContain("bob");
    expect(names).not.toContain("channel");
  });

  it("stores a GitHub delivery unaddressed instead of answering 429 when the window is open", async () => {
    const f = await fixture();
    expect((await f.post(f.owner, { text: "@channel" })).status).toBe(201);
    const secretResponse = await call(f.tenant, "/github/secret", f.owner, "POST");
    expect(secretResponse.status).toBe(200);
    const { secret } = await secretResponse.json<{ secret: string }>();
    expect(
      (await call(f.tenant, "/channels/work/github/pulls/TheHumanWorks/msn/34", f.owner, "PUT")).status,
    ).toBe(201);
    const payload = {
      action: "submitted",
      repository: { full_name: "TheHumanWorks/msn" },
      pull_request: { number: 34 },
      review: {
        state: "COMMENTED",
        body: "please @channel",
        user: { login: "reviewer" },
        html_url: "https://github.com/thehumanworks/msn/pull/34#pullrequestreview-9",
      },
    };
    const raw = new TextEncoder().encode(JSON.stringify(payload));
    const delivered = await exports.default.fetch(`https://msn.test/api/github/hooks/${f.tenant}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request_review",
        "X-GitHub-Delivery": crypto.randomUUID(),
        "X-Hub-Signature-256": await sign(secret, raw),
      },
      body: raw,
    });
    expect(delivered.status).toBe(200);
    const page = await (await call(f.tenant, "/channels/work/messages", f.owner)).json<{ messages: Msg[] }>();
    const github = page.messages.find(
      (message) => message.username === "github" && message.text.includes("@channel"),
    );
    expect(github?.text).toContain("please @channel");
    expect(github?.to).toBeUndefined();
    expect(github?.recipients).toBeUndefined();
    const flags = await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) =>
      state.storage.sql
        .exec<{ username: string; mentionsChannel: number }>("SELECT username, mentionsChannel FROM messages")
        .toArray(),
    );
    expect(flags.find((row) => row.username === "github")?.mentionsChannel).toBe(0);
    expect(flags.find((row) => row.username === "human")?.mentionsChannel).toBe(1);
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec(
        "UPDATE messages SET createdAt = ? WHERE username = ?",
        "2020-01-01T00:00:00.000Z",
        "human",
      );
    });
    expect((await f.post(f.agent, { username: "lead", text: "@channel" })).status).toBe(201);
  });

  it("refuses a persona registered under the owner's name", async () => {
    const f = await fixture();
    for (const displayName of ["human", "Human"]) {
      const response = await call(f.tenant, "/channels/work/personas/clone", f.agent, "PUT", { displayName });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "owner_name" } });
    }
  });

  it("does not treat a borrowed owner name as the owner, even when the owner has no bound name", async () => {
    const f = await fixture();
    expect((await f.post(f.agent, { username: "lead", text: "@channel" })).status).toBe(201);
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec(
        "INSERT INTO personas (channel, id, displayName, createdAt) VALUES (?, ?, ?, ?)",
        "work",
        "owner-face",
        "human",
        new Date().toISOString(),
      );
    });
    expect((await f.post(f.agent, { username: "human", text: "@channel" })).status).toBe(429);
    const scheduled = await f.post(f.agent, {
      username: "human",
      text: "@channel later",
      sendAt: new Date(Date.now() + 120_000).toISOString(),
    });
    expect(scheduled.status).toBe(201);
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec(
        "UPDATE scheduled_messages SET dueMs = ? WHERE failedAt IS NULL",
        Date.now() - 1,
      );
      state.storage.sql.exec("UPDATE tenant SET bound_username = NULL");
      state.storage.setAlarm(Date.now() + 3_600_000);
    });
    await runDurableObjectAlarm(f.stub);
    const listed = await (await call(f.tenant, "/channels/work/scheduled", f.agent)).json<{
      scheduled: { status: string; error?: { code: string } }[];
    }>();
    expect(listed.scheduled[0]).toMatchObject({
      status: "failed",
      error: { code: "channel_mention_limited" },
    });
    expect((await f.post(f.agent, { username: "lead", text: "@channel again" })).status).toBe(429);
    expect((await f.post(f.owner, { username: "lead", text: "@channel from the owner key" })).status).toBe(
      201,
    );
  });

  it("does not arm the window when GitHub is over the cap or has nobody to mention", async () => {
    const over = await fixture();
    await runInDurableObject(over.stub, (_instance: MsnDurableObject, state) => {
      for (let i = 0; i < CHANNEL_MENTION_CAP; i += 1)
        state.storage.sql.exec(
          "INSERT INTO personas (channel, id, displayName, createdAt) VALUES (?, ?, ?, ?)",
          "work",
          `extra-${i}`,
          `extra-${i}`,
          new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        );
    });
    await deliverChannel(over, "over the cap @channel");
    const capped = await runInDurableObject(
      over.stub,
      (_instance: MsnDurableObject, state) =>
        state.storage.sql
          .exec<{ n: number }>(
            "SELECT COALESCE(SUM(mentionsChannel), 0) AS n FROM messages WHERE username = 'github'",
          )
          .one().n,
    );
    expect(capped).toBe(0);
    await runInDurableObject(over.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec("DELETE FROM personas WHERE id LIKE 'extra-%'");
    });
    expect((await over.post(over.agent, { username: "lead", text: "@channel" })).status).toBe(201);

    const empty = await fixture();
    await runInDurableObject(empty.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec("UPDATE tenant SET bound_username = NULL");
      state.storage.sql.exec("UPDATE access_keys SET bound_username = NULL");
      state.storage.sql.exec("DELETE FROM personas");
    });
    await deliverChannel(empty, "nobody @channel");
    const quiet = await runInDurableObject(
      empty.stub,
      (_instance: MsnDurableObject, state) =>
        state.storage.sql
          .exec<{ n: number }>(
            "SELECT COALESCE(SUM(mentionsChannel), 0) AS n FROM messages WHERE username = 'github'",
          )
          .one().n,
    );
    expect(quiet).toBe(0);
    await runInDurableObject(empty.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec(
        "INSERT INTO personas (channel, id, displayName, createdAt) VALUES (?, ?, ?, ?)",
        "work",
        "lead",
        "lead",
        new Date().toISOString(),
      );
    });
    expect((await empty.post(empty.agent, { username: "lead", text: "@channel" })).status).toBe(201);
  });

  it("fails a scheduled @channel from a non-owner while the window is open", async () => {
    const f = await fixture();
    expect((await f.post(f.owner, { text: "@channel" })).status).toBe(201);
    const scheduled = await f.post(f.agent, {
      username: "worker",
      text: "@channel later",
      sendAt: new Date(Date.now() + 120_000).toISOString(),
    });
    expect(scheduled.status).toBe(201);
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec(
        "UPDATE scheduled_messages SET dueMs = ? WHERE failedAt IS NULL",
        Date.now() - 1,
      );
      state.storage.setAlarm(Date.now() + 3_600_000);
    });
    await runDurableObjectAlarm(f.stub);
    const listed = await (await call(f.tenant, "/channels/work/scheduled", f.agent)).json<{
      scheduled: { status: string; error?: { code: string } }[];
    }>();
    expect(listed.scheduled[0]).toMatchObject({
      status: "failed",
      error: { code: "channel_mention_limited" },
    });
  });

  it("wakes one webhook for each of the 32 agents a mention addresses", async () => {
    const f = await fixture();
    await runInDurableObject(f.stub, (_instance: MsnDurableObject, state) => {
      const now = new Date().toISOString();
      for (const id of ["lead", "rev", "work"])
        state.storage.sql.exec(
          "INSERT INTO webhooks (channel, personaId, url, secret, origin, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
          "work",
          id,
          `https://agent.example.com/${id}`,
          "secret",
          "https://agent.example.com",
          now,
        );
      for (let i = 0; i < CHANNEL_MENTION_CAP - 3; i += 1) {
        state.storage.sql.exec(
          "INSERT INTO personas (channel, id, displayName, createdAt) VALUES (?, ?, ?, ?)",
          "work",
          `p${i}`,
          `agent-${i}`,
          new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        );
        state.storage.sql.exec(
          "INSERT INTO webhooks (channel, personaId, url, secret, origin, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
          "work",
          `p${i}`,
          `https://agent.example.com/p${i}`,
          "secret",
          "https://agent.example.com",
          now,
        );
      }
    });
    const sent = await f.post(f.owner, { text: "@channel" });
    expect(sent.status).toBe(201);
    expect((await sent.json<{ message: Msg }>()).message.recipients).toHaveLength(CHANNEL_MENTION_CAP);
    const count = await runInDurableObject(
      f.stub,
      (_instance: MsnDurableObject, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_notices").one().n,
    );
    expect(count).toBe(CHANNEL_MENTION_CAP);
  });
});
