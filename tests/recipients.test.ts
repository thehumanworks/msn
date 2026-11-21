import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addressees, isAddressed, MAX_RECIPIENTS } from "../src/http";
import { needsOwner } from "../src/push";
import type { MsnDurableObject } from "../src/store";

// Address a message to several agents (ADR 0067): `to` takes one name or a list of up to 8. The
// message keeps `to` as the first name and lists every name in `recipients` when there are several.

const ADMIN = "test-admin-secret-000000000000000000000";
const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });

type Message = {
  id: number;
  username: string;
  text: string;
  to?: string;
  recipients?: string[];
  replyTo?: number;
};

/** An owner account with board `work`, its shared agent key and personas lead, reviewer and worker. */
async function fixture() {
  const tenant = `to-${crypto.randomUUID()}`;
  const owner = (
    await (await call(tenant, "", undefined, "PUT", { username: "human" })).json<{ token: string }>()
  ).token;
  const agent = "d".repeat(64);
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
  const send = (input: Record<string, unknown>, key?: string) =>
    exports.default.fetch(`https://msn.test/api/tenants/${tenant}/channels/work/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent}`,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify({ username: "lead", text: "please look", ...input }),
    });
  const sent = async (input: Record<string, unknown>, key?: string) => {
    const response = await send(input, key);
    expect(response.status).toBe(201);
    return (await response.json<{ message: Message }>()).message;
  };
  const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant]));
  return { tenant, owner, agent, send, sent, stub };
}

describe("several names on one message (ADR 0067)", () => {
  it("given a list of names, when sent, then to is the first and recipients lists all, on every read", async () => {
    const f = await fixture();
    const message = await f.sent({ to: ["reviewer", "worker"] });
    expect(message).toMatchObject({ to: "reviewer", recipients: ["reviewer", "worker"] });
    const one = await (await call(f.tenant, `/channels/work/messages/${message.id}`, f.agent)).json<{
      message: Message;
    }>();
    expect(one.message).toMatchObject({ to: "reviewer", recipients: ["reviewer", "worker"] });
    const page = await (await call(f.tenant, "/channels/work/messages", f.agent)).json<{
      messages: Message[];
    }>();
    expect(page.messages.at(-1)).toMatchObject({ to: "reviewer", recipients: ["reviewer", "worker"] });
  });

  it("given one name as text or as a one-name list, when sent, then the message keeps today's shape", async () => {
    const f = await fixture();
    const text = await f.sent({ to: "reviewer" }, "same-key");
    expect(text.to).toBe("reviewer");
    expect("recipients" in text).toBe(false);
    // The same send written as a list replays: one name hashes exactly as before.
    const replay = await f.send({ to: ["reviewer"] }, "same-key");
    expect(replay.status).toBe(200);
    expect((await replay.json<{ message: Message }>()).message.id).toBe(text.id);
  });

  it("given a retried key with a different list, when sent, then it conflicts instead of replaying", async () => {
    const f = await fixture();
    await f.sent({ to: ["reviewer", "worker"] }, "k1");
    expect((await f.send({ to: ["reviewer", "worker"] }, "k1")).status).toBe(200);
    expect((await f.send({ to: ["worker", "reviewer"] }, "k1")).status).toBe(409);
    expect((await f.send({ to: "reviewer" }, "k1")).status).toBe(409);
  });

  it("refuses an empty list, more than 8 names, repeats and blank or non-text names", async () => {
    const f = await fixture();
    const nine = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `agent-${i}`);
    for (const to of [
      [],
      nine,
      ["reviewer", "reviewer"],
      ["reviewer", " "],
      ["reviewer", 7],
      ["x".repeat(129)],
    ]) {
      const response = await f.send({ to });
      expect(response.status, JSON.stringify(to)).toBe(400);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe("invalid_message");
    }
    const eight = await f.sent({ to: nine.slice(0, MAX_RECIPIENTS) });
    expect(eight.recipients).toHaveLength(MAX_RECIPIENTS);
  });

  it("refuses a question with buttons addressed to several names", async () => {
    const f = await fixture();
    const response = await f.send({ to: ["reviewer", "worker"], choices: ["yes", "no"] });
    expect(response.status).toBe(400);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe("invalid_choices");
    // A one-name list is still one person.
    const single = await f.sent({ to: ["reviewer"], choices: ["yes", "no"] });
    expect(single).toMatchObject({ to: "reviewer", choices: ["yes", "no"] });
  });

  it("counts the message as to you for every named reader in unread counts", async () => {
    const f = await fixture();
    await f.sent({ to: ["reviewer", " Worker "] });
    for (const me of ["reviewer", "worker"]) {
      const body = await (await call(f.tenant, `/unread?me=${me}&mark=work:0`, f.agent)).json<{
        unread: { toYou: number }[];
      }>();
      expect(body.unread[0].toYou, me).toBe(1);
    }
    const lead = await (await call(f.tenant, `/unread?me=human&mark=work:0`, f.agent)).json<{
      unread: { toYou: number }[];
    }>();
    expect(lead.unread[0].toYou).toBe(0);
  });

  it("keeps replies from each named agent in the one thread", async () => {
    const f = await fixture();
    const root = await f.sent({ to: ["reviewer", "worker"] });
    for (const username of ["reviewer", "worker"])
      await f.sent({ username, text: `done by ${username}`, replyTo: root.id, to: "lead" });
    const thread = await (
      await call(f.tenant, `/channels/work/messages?thread=${root.id}&after=0`, f.agent)
    ).json<{ messages: Message[] }>();
    expect(thread.messages.map((m) => m.username)).toEqual(["lead", "reviewer", "worker"]);
  });

  it("shows each named agent in receipts once it commits past the message", async () => {
    const f = await fixture();
    const message = await f.sent({ to: ["reviewer", "worker"] });
    for (const reader of ["reviewer", "worker"]) {
      const base = `/channels/work/processing/${reader}`;
      const claimed = await call(f.tenant, `${base}/claim`, f.agent, "POST", { expectGeneration: 0 });
      const { generation } = await claimed.json<{ generation: number }>();
      expect(
        (await call(f.tenant, `${base}/commit`, f.agent, "POST", { generation, through: message.id })).status,
      ).toBe(200);
    }
    const receipts = await (
      await call(f.tenant, `/channels/work/messages/${message.id}/receipts`, f.agent)
    ).json<{ processed: { name: string }[] }>();
    expect(receipts.processed.map((r) => r.name).sort()).toEqual(["reviewer", "worker"]);
  });

  it("wakes each addressed persona's webhook once, and never the sender's own", async () => {
    const f = await fixture();
    // Notices stay queued: delivery is covered by tests/webhooks.test.ts.
    await runInDurableObject(f.stub, (instance: MsnDurableObject) => {
      instance.webhookFetch = async () => new Response("ok");
    });
    for (const persona of ["rev", "work", "lead"])
      expect(
        (
          await call(f.tenant, `/channels/work/personas/${persona}/webhook`, f.owner, "PUT", {
            url: `https://agent.example.com/${persona}`,
          })
        ).status,
      ).toBe(201);
    // "Reviewer" and "reviewer" find one persona; the sender "lead" names itself too.
    await f.sent({ to: ["reviewer", "Reviewer", "worker", "lead"] });
    const notices = await runInDurableObject(f.stub, (_: MsnDurableObject, state) =>
      state.storage.sql
        .exec<{ personaId: string }>("SELECT personaId FROM webhook_notices ORDER BY personaId")
        .toArray()
        .map((row) => row.personaId),
    );
    expect(notices).toEqual(["rev", "work"]);
  });

  it("posts a scheduled message with all its names", async () => {
    const f = await fixture();
    const response = await f.send({
      to: ["reviewer", "worker"],
      sendAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(response.status).toBe(201);
    const { scheduled } = await response.json<{ scheduled: { to: string; recipients: string[] } }>();
    expect(scheduled).toMatchObject({ to: "reviewer", recipients: ["reviewer", "worker"] });
    await runInDurableObject(f.stub, (_, state) => {
      state.storage.sql.exec("UPDATE scheduled_messages SET dueMs = ?", Date.now() - 1);
    });
    await runInDurableObject(f.stub, (_, state) => state.storage.setAlarm(Date.now() + 3600_000));
    await runDurableObjectAlarm(f.stub);
    const page = await (await call(f.tenant, "/channels/work/messages", f.agent)).json<{
      messages: Message[];
    }>();
    expect(page.messages.at(-1)).toMatchObject({ to: "reviewer", recipients: ["reviewer", "worker"] });
  });

  it("clears every name when an admin deletes the message", async () => {
    const f = await fixture();
    const message = await f.sent({ to: ["reviewer", "worker"] });
    const deleted = await exports.default.fetch(
      `https://msn.test/api/admin/tenants/${f.tenant}/channels/work/messages/${message.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN}` } },
    );
    expect(deleted.status).toBeLessThan(300);
    const row = await runInDurableObject(f.stub, (_: MsnDurableObject, state) =>
      state.storage.sql
        .exec<{ recipient: string | null; recipients: string | null }>(
          "SELECT recipient, recipients FROM messages WHERE id = ?",
          message.id,
        )
        .one(),
    );
    expect(row).toEqual({ recipient: null, recipients: null });
  });
});

describe("addressing helpers (ADR 0067)", () => {
  it("reads every name from recipients, else to alone, else none", () => {
    expect(addressees({ to: "a", recipients: ["a", "b"] })).toEqual(["a", "b"]);
    expect(addressees({ to: "a" })).toEqual(["a"]);
    expect(addressees({})).toEqual([]);
    expect(addressees({ to: null, recipients: null })).toEqual([]);
  });

  it("matches any name exactly or trimmed and ignoring case", () => {
    const message = { to: "Reviewer", recipients: ["Reviewer", " worker "] };
    expect(isAddressed("reviewer", message)).toBe(true);
    expect(isAddressed("Worker", message)).toBe(true);
    expect(isAddressed("lead", message)).toBe(false);
  });

  it("notifies the owner when any of the names is theirs", () => {
    const message = { username: "lead", text: "need you", contentType: "text/plain", to: "worker" };
    const owners = new Set(["human"]);
    expect(needsOwner(message, owners)).toBeNull();
    expect(needsOwner({ ...message, recipients: ["worker", "human"] }, owners)).toMatchObject({
      reason: "question",
    });
  });
});
