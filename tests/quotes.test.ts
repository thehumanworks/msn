import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Quote a message in a reply (ADR 0059): a reply may carry `quote`, the part of its replyTo
// message it answers. The server stores it with the reply, so every reader sees what was answered.

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

type Message = { id: number; text: string; replyTo?: number; quote?: string; editedAt?: string };

async function fixture() {
  const tenant = `quote-${crypto.randomUUID()}`;
  const owner = (await (await call(tenant, "", undefined, "PUT", { username: "human" })).json()) as {
    token: string;
  };
  const post = (input: object, key?: string) =>
    call(tenant, "/channels/work/messages", owner.token, "POST", { username: "human", ...input }, key);
  const send = async (input: object, key?: string) => {
    const response = await post(input, key);
    expect(response.status).toBe(201);
    return ((await response.json()) as { message: Message }).message;
  };
  const read = async () =>
    (
      (await (await call(tenant, "/channels/work/messages?after=0", owner.token)).json()) as {
        messages: Message[];
      }
    ).messages;
  const usage = () =>
    runInDurableObject(env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant])), (_, state) =>
      state.storage.sql.exec<{ bytes: number }>("SELECT bytes FROM usage").one(),
    );
  return { tenant, owner: owner.token, post, send, read, usage };
}

describe("quote a message in a reply (ADR 0059)", () => {
  it("stores the quote with the reply and returns it on send, reads and point reads", async () => {
    const f = await fixture();
    const root = await f.send({ text: "Ship the Worker today.\nThen tag the CLI." });
    expect("quote" in root).toBe(false);
    const reply = await f.send({ text: "Done.", replyTo: root.id, quote: "Then tag the CLI." });
    expect(reply).toMatchObject({ replyTo: root.id, quote: "Then tag the CLI.", text: "Done." });
    // A plain reply has no quote key at all, so older clients see today's shape.
    const plain = await f.send({ text: "ok", replyTo: root.id, quote: null });
    expect("quote" in plain).toBe(false);
    expect((await f.read()).map((m) => m.quote)).toEqual([undefined, "Then tag the CLI.", undefined]);
    const point = (await (await call(f.tenant, `/channels/work/messages/${reply.id}`, f.owner)).json()) as {
      message: Message;
    };
    expect(point.message.quote).toBe("Then tag the CLI.");
  });

  it("rejects a quote without replyTo, blank, too long or not text, and stores nothing", async () => {
    const f = await fixture();
    const root = await f.send({ text: "root" });
    for (const input of [
      { quote: "root" },
      { quote: "root", replyTo: null },
      { quote: "", replyTo: root.id },
      { quote: "  \n", replyTo: root.id },
      { quote: "x".repeat(2049), replyTo: root.id },
      { quote: 7, replyTo: root.id },
      { quote: ["root"], replyTo: root.id },
    ]) {
      const response = await f.post({ text: "re", ...input });
      expect(response.status, JSON.stringify(input).slice(0, 60)).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_quote");
    }
    expect((await f.read()).map((m) => m.text)).toEqual(["root"]);
    // 2,048 UTF-8 bytes is the limit, counted in bytes, not characters.
    expect((await f.post({ text: "re", replyTo: root.id, quote: "x".repeat(2048) })).status).toBe(201);
    expect((await f.post({ text: "re", replyTo: root.id, quote: "é".repeat(1025) })).status).toBe(400);
  });

  it("makes the quote part of the idempotency digest", async () => {
    const f = await fixture();
    const root = await f.send({ text: "a\nb" });
    const first = await f.send({ text: "re", replyTo: root.id, quote: "a" }, "k1");
    const replay = await f.post({ text: "re", replyTo: root.id, quote: "a" }, "k1");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ message: first, replayed: true });
    expect((await f.post({ text: "re", replyTo: root.id, quote: "b" }, "k1")).status).toBe(409);
    expect((await f.post({ text: "re", replyTo: root.id }, "k1")).status).toBe(409);
    // The other way round: a key first used without a quote conflicts with a quoted retry.
    await f.send({ text: "re", replyTo: root.id }, "k2");
    expect((await f.post({ text: "re", replyTo: root.id, quote: "a" }, "k2")).status).toBe(409);
    expect((await f.post({ text: "re", replyTo: root.id }, "k2")).status).toBe(200);
  });

  it("counts the quote as stored content, keeps it through an edit and removes it on delete", async () => {
    const f = await fixture();
    const root = await f.send({ text: "root" });
    const before = (await f.usage()).bytes;
    const reply = await f.send({ text: "re", replyTo: root.id, quote: "root" });
    expect((await f.usage()).bytes - before).toBe(new TextEncoder().encode("human" + "re" + "root").length);
    const edited = await call(f.tenant, `/channels/work/messages/${reply.id}`, f.owner, "PATCH", {
      username: "human",
      text: "re: yes",
    });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { message: Message }).message).toMatchObject({
      text: "re: yes",
      quote: "root",
    });
    expect((await f.usage()).bytes - before).toBe(
      new TextEncoder().encode("human" + "re: yes" + "root").length,
    );
    const admin = "test-admin-secret-000000000000000000000";
    const removed = await exports.default.fetch(
      `https://msn.test/api/admin/tenants/${f.tenant}/channels/work/messages/${reply.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${admin}` } },
    );
    expect(removed.status).toBe(204);
    expect((await f.usage()).bytes).toBe(before);
    const stored = await runInDurableObject(
      env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant])),
      (_, state) =>
        state.storage.sql
          .exec<{ quote: string | null }>("SELECT quote FROM messages WHERE id = ?", reply.id)
          .one(),
    );
    expect(stored.quote).toBeNull();
  });
});
