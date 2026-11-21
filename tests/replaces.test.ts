import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Replace an instruction with a newer one (ADR 0067): a send may name `replaces`, an earlier
// message by the same sender. The new message carries `replaces` and the old one `replacedBy`,
// so a reader going in order can skip to the current instruction. Nothing is deleted.

const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown, key?: string) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
      "Content-Type": "application/json",
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });

type Message = { id: number; text: string; username: string; replaces?: number; replacedBy?: number };
type ErrorBody = { error: { code: string; message: string } };
const adminDelete = (tenant: string, id: number) =>
  exports.default.fetch(`https://msn.test/api/admin/tenants/${tenant}/channels/work/messages/${id}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer test-admin-secret-000000000000000000000" },
  });

async function fixture() {
  const tenant = `replace-${crypto.randomUUID()}`;
  const owner = (await (await call(tenant, "", undefined, "PUT", { username: "tomas" })).json()) as {
    token: string;
  };
  await call(tenant, "/channels/work", owner.token, "PUT");
  const invite = (await (
    await call(tenant, "/invites", owner.token, "POST", { channel: "work" })
  ).json()) as { code: string };
  const agent = (await (
    await call(tenant, "/invites/redeem", undefined, "POST", { code: invite.code, username: "lead" })
  ).json()) as { token: string };
  const post = (input: object, key?: string, token = owner.token) =>
    call(
      tenant,
      "/channels/work/messages",
      token,
      "POST",
      { username: token === owner.token ? "tomas" : "lead", ...input },
      key,
    );
  const send = async (input: object, key?: string, token = owner.token) => {
    const response = await post(input, key, token);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    return ((await response.json()) as { message: Message }).message;
  };
  const read = async () =>
    (
      (await (await call(tenant, "/channels/work/messages?after=0", owner.token)).json()) as {
        messages: Message[];
      }
    ).messages;
  const point = async (id: number) =>
    (
      (await (await call(tenant, `/channels/work/messages/${id}`, owner.token)).json()) as {
        message: Message;
      }
    ).message;
  return { tenant, owner, agent, post, send, read, point };
}

async function refused(response: Response, status: number, code: string) {
  const body = (await response.json()) as ErrorBody;
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.error.code).toBe(code);
  return body.error.message;
}

describe("replace a message (ADR 0067)", () => {
  it("links the new message to the old one both ways and keeps the old text", async () => {
    const { send, read, point } = await fixture();
    const old = await send({ text: "Deploy to staging" });
    expect(old).not.toHaveProperty("replaces");
    expect(old).not.toHaveProperty("replacedBy");
    const next = await send({ text: "Deploy to production", replaces: old.id });
    expect(next.replaces).toBe(old.id);
    expect(next).not.toHaveProperty("replacedBy");
    const log = await read();
    expect(log.map((m) => [m.id, m.text, m.replaces, m.replacedBy])).toEqual([
      [old.id, "Deploy to staging", undefined, next.id],
      [next.id, "Deploy to production", old.id, undefined],
    ]);
    expect((await point(old.id)).replacedBy).toBe(next.id);
  });

  it("replaces only once, and a chain points at the newest", async () => {
    const { post, send } = await fixture();
    const first = await send({ text: "one" });
    const second = await send({ text: "two", replaces: first.id });
    const message = await refused(await post({ text: "again", replaces: first.id }), 409, "already_replaced");
    expect(message).toContain(`message ${second.id}`);
    const third = await send({ text: "three", replaces: second.id });
    expect(third.replaces).toBe(second.id);
  });

  it("lets only the sender replace", async () => {
    const { post, send, agent } = await fixture();
    const owners = await send({ text: "owner's instruction" });
    await refused(
      await post({ text: "mine now", replaces: owners.id }, undefined, agent.token),
      403,
      "not_sender",
    );
    const leads = await send({ text: "lead's", replaces: undefined }, undefined, agent.token);
    await refused(await post({ text: "not yours", replaces: leads.id }), 403, "not_sender");
  });

  it("refuses unknown, deleted, scheduled, answer and malformed replacements", async () => {
    const { tenant, post, send } = await fixture();
    await refused(await post({ text: "x", replaces: 999 }), 400, "invalid_replaces");
    await refused(await post({ text: "x", replaces: "1" }), 400, "invalid_replaces");
    await refused(await post({ text: "x", replaces: 0 }), 400, "invalid_replaces");
    const gone = await send({ text: "gone" });
    expect((await adminDelete(tenant, gone.id)).status).toBe(204);
    await refused(await post({ text: "x", replaces: gone.id }), 410, "message_deleted");
    const live = await send({ text: "live" });
    await refused(
      await post({
        text: "later",
        replaces: live.id,
        sendAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      400,
      "invalid_send_at",
    );
    await refused(
      await post({ replyTo: live.id, answer: "yes", replaces: live.id }),
      400,
      "invalid_replaces",
    );
  });

  it("makes the old message current again when the replacement is deleted", async () => {
    const { tenant, send, point } = await fixture();
    const old = await send({ text: "old" });
    const next = await send({ text: "new", replaces: old.id });
    expect((await adminDelete(tenant, next.id)).status).toBe(204);
    expect(await point(old.id)).not.toHaveProperty("replacedBy");
    const again = await send({ text: "newer", replaces: old.id });
    expect((await point(old.id)).replacedBy).toBe(again.id);
  });

  it("replays a retry and refuses the same key for another replacement", async () => {
    const { post, send } = await fixture();
    const a = await send({ text: "a" });
    const b = await send({ text: "b" });
    const first = await send({ text: "fix", replaces: a.id }, "k1");
    const retry = await post({ text: "fix", replaces: a.id }, "k1");
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { message: Message }).message.id).toBe(first.id);
    await refused(await post({ text: "fix", replaces: b.id }, "k1"), 409, "idempotency_conflict");
    // A send without `replaces` hashes as before, so its key does not match one with it.
    await refused(await post({ text: "fix" }, "k1"), 409, "idempotency_conflict");
  });

  it("keeps the thread and address it is given", async () => {
    const { send } = await fixture();
    const root = await send({ text: "root" });
    const old = await send({ text: "do A", replyTo: root.id, to: "lead" });
    const next = (await send({ text: "do B", replyTo: root.id, to: "lead", replaces: old.id })) as Message & {
      replyTo?: number;
      to?: string;
    };
    expect([next.replyTo, next.to, next.replaces]).toEqual([root.id, "lead", old.id]);
  });
});
