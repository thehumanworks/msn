import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Replace an instruction with a newer one (ADR 0068): a send may name `replaces`, an earlier
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

describe("replace a message (ADR 0068)", () => {
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

  it("links the oldest to the newest when the middle of a chain is deleted", async () => {
    const { tenant, post, send, point, read } = await fixture();
    const a = await send({ text: "one" });
    const b = await send({ text: "two", replaces: a.id });
    const c = await send({ text: "three", replaces: b.id });
    expect((await adminDelete(tenant, b.id)).status).toBe(204);
    // Only the newest is current; an agent skipping replaced messages acts on C, not A.
    expect((await point(a.id)).replacedBy).toBe(c.id);
    expect((await read()).filter((m) => m.replacedBy === undefined).map((m) => m.id)).toEqual([c.id]);
    expect(await refused(await post({ text: "x", replaces: a.id }), 409, "already_replaced")).toContain(
      `message ${c.id}`,
    );
    // Deleting the newest then makes the oldest current again.
    expect((await adminDelete(tenant, c.id)).status).toBe(204);
    expect(await point(a.id)).not.toHaveProperty("replacedBy");
  });

  it("refuses another board's id and a case variant of the sender's name", async () => {
    const { tenant, owner, post, send } = await fixture();
    await call(tenant, "/channels/other", owner.token, "PUT");
    const elsewhere = (await (
      await call(tenant, "/channels/other/messages", owner.token, "POST", {
        username: "tomas",
        text: "there",
      })
    ).json()) as { message: Message };
    await send({ text: "here" });
    await refused(await post({ text: "x", replaces: elsewhere.message.id }), 400, "invalid_replaces");
    const mine = await send({ text: "mine" });
    const variant = await post({ text: "x", replaces: mine.id, username: "Tomas" });
    expect(variant.status).toBe(403);
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

  it("refuses watch-only keys and archived boards", async () => {
    const { tenant, owner, post, send } = await fixture();
    const old = await send({ text: "old" });
    const invite = (await (
      await call(tenant, "/invites", owner.token, "POST", { channel: "work", watch: true })
    ).json()) as { code: string };
    const watcher = (await (
      await call(tenant, "/invites/redeem", undefined, "POST", { code: invite.code, username: "watcher" })
    ).json()) as { token: string };
    await refused(
      await call(tenant, "/channels/work/messages", watcher.token, "POST", {
        username: "watcher",
        text: "x",
        replaces: old.id,
      }),
      403,
      "watch_only",
    );
    expect((await call(tenant, "/channels/work/archive", owner.token, "PUT")).status).toBe(200);
    await refused(await post({ text: "x", replaces: old.id }), 409, "board_archived");
  });

  it("on a shared board, refuses a persona that took over another's old name", async () => {
    const tenant = `replace-board-${crypto.randomUUID()}`;
    const owner = (await (await call(tenant, "", undefined, "PUT", { username: "human" })).json()) as {
      token: string;
    };
    const agent = "f".repeat(64);
    expect(
      (await call(tenant, "/channels/work/board", owner.token, "PUT", { credential: agent, goal: "Ship" }))
        .status,
    ).toBe(201);
    for (const name of ["lead", "dev"])
      expect(
        (await call(tenant, `/channels/work/personas/${name}`, agent, "PUT", { displayName: name })).status,
      ).toBe(201);
    const send = (username: string, input: object) =>
      call(tenant, "/channels/work/messages", agent, "POST", { username, ...input });
    const sent = ((await (await send("lead", { text: "mine" })).json()) as { message: Message }).message;
    await refused(await send("dev", { text: "x", replaces: sent.id }), 403, "not_sender");
    // The same display name under another persona id is not the sender.
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant]));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE messages SET personaId = 'dev' WHERE id = ?", sent.id);
    });
    await refused(await send("lead", { text: "x", replaces: sent.id }), 403, "not_sender");
  });
});
