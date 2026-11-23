import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MsnDurableObject } from "../src/store";

// Per-recipient delivery ticks (ADR 0082).
// I1 unaddressed send has no delivery.
// I2 addressed send returns rows in order, timestamps null unless a listener is open.
// I3 a read as that name sets deliveredAt and not readAt; an unbound read does not.
// I4 a bound key cannot read as someone else; a shared key's participant must be a persona.
// I5 ack sets readAt, is idempotent, and refuses a non-recipient, an unknown id, and a deletion.
// I6 a watch-only key can ack and cannot post; an archived board can ack.
// I7 a delivered message.addressed webhook sets delivered; failure and message.posted do not.
// I8 a persona listening at send is delivered immediately.
// I9 acksAfter returns the change and wakes a long poll.
// I10 the events feed grows no new type, and receipts stay processed-by.
// I11 an idempotent replay does not duplicate rows.
// I12 a message whose rows were removed grows them again when acknowledged.
// I13 an edit cannot change addressees; a missing row among the others is filled in on ack.
// I14 deleting a message removes its delivery rows and drops it from acks.
// I15 a shared key cannot ack as github or an unregistered name; a watch-only key cannot ack
//     as another name; a key for another board is refused; an unaddressed message is not_recipient.
// I16 search and a non-addressee read do not deliver; one message and catch-up reader=name/worker do.
// I17 message.posted does not deliver, and neither does a webhook whose persona was deleted.
// I18 more tick changes than one page sets acksHasMore and the next cursor resumes.

const call = (
  tenant: string,
  suffix = "",
  token?: string,
  method = "GET",
  input?: unknown,
  headers?: HeadersInit,
) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      ...headers,
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });

type Row = { name: string; deliveredAt: string | null; readAt: string | null };
type Message = { id: number; text?: string; to?: string; recipients?: string[]; delivery?: Row[] };

async function fixture() {
  const tenant = `ticks-${crypto.randomUUID()}`;
  const owner = (await (await call(tenant, "", undefined, "PUT", { username: "human" })).json()) as {
    token: string;
  };
  const agent = "e".repeat(64);
  expect(
    (await call(tenant, "/channels/work/board", owner.token, "PUT", { credential: agent, goal: "Ship" }))
      .status,
  ).toBe(201);
  for (const name of ["lead", "dev"])
    expect(
      (await call(tenant, `/channels/work/personas/${name}`, agent, "PUT", { displayName: name })).status,
    ).toBe(201);
  const send = async (body: Record<string, unknown>, key?: string) => {
    const response = await call(
      tenant,
      "/channels/work/messages",
      agent,
      "POST",
      body,
      key ? { "Idempotency-Key": key } : undefined,
    );
    return response;
  };
  return { tenant, owner: owner.token, agent, send };
}

const page = async (f: { tenant: string }, token: string, query = "after=0") =>
  (await (await call(f.tenant, `/channels/work/messages?${query}`, token)).json()) as {
    messages: Message[];
    acks?: Message[];
    ackCursor?: number;
    acksHasMore?: boolean;
  };

describe("delivery ticks (ADR 0082)", () => {
  it("given an unaddressed message, when it is stored, then it has no delivery field", async () => {
    const f = await fixture();
    const response = await f.send({ username: "lead", text: "hello" });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { message: Message };
    expect(body.message.delivery).toBeUndefined();
    expect((await page(f, f.agent)).messages[0].delivery).toBeUndefined();
  });

  it("given addressees, when the message is stored, then delivery rows follow that order with no timestamps", async () => {
    const f = await fixture();
    const one = await (await f.send({ username: "lead", text: "one", to: "dev" })).json<{
      message: Message;
    }>();
    expect(one.message.delivery).toEqual([{ name: "dev", deliveredAt: null, readAt: null }]);
    const many = await (await f.send({ username: "lead", text: "many", to: ["dev", "lead"] })).json<{
      message: Message;
    }>();
    expect(many.message.delivery).toEqual([
      { name: "dev", deliveredAt: null, readAt: null },
      { name: "lead", deliveredAt: null, readAt: null },
    ]);
  });

  it("given a read as the recipient, when the page returns, then that name is delivered and not read", async () => {
    const f = await fixture();
    await f.send({ username: "lead", text: "for you", to: "dev" });
    const asLead = await page(f, f.agent, "after=0&participant=lead");
    expect(asLead.messages[0].delivery).toEqual([{ name: "dev", deliveredAt: null, readAt: null }]);
    const asDev = await page(f, f.agent, "after=0&participant=dev");
    expect(asDev.messages[0].delivery?.[0].deliveredAt).toEqual(expect.any(String));
    expect(asDev.messages[0].delivery?.[0].readAt).toBeNull();
    const owner = await page(f, f.owner);
    expect(owner.messages[0].delivery?.[0].readAt).toBeNull();
  });

  it("given a bound key or a shared key, when participant is wrong, then the read is refused", async () => {
    const f = await fixture();
    await f.send({ username: "lead", text: "x", to: "dev" });
    const bound = await call(f.tenant, "/channels/work/messages?after=0&participant=dev", f.owner);
    expect(bound.status).toBe(403);
    expect(await bound.json()).toMatchObject({ error: { code: "username_bound" } });
    const stranger = await call(f.tenant, "/channels/work/messages?after=0&participant=ghost", f.agent);
    expect(stranger.status).toBe(400);
    expect(await stranger.json()).toMatchObject({ error: { code: "persona_required" } });
  });

  it("given an addressee, when they ack, then the message is read once and a stranger cannot", async () => {
    const f = await fixture();
    const sent = await (await f.send({ username: "lead", text: "please", to: "dev" })).json<{
      message: Message;
    }>();
    const first = await call(f.tenant, `/channels/work/messages/${sent.message.id}/ack`, f.agent, "POST", {
      username: "dev",
    });
    expect(first.status).toBe(200);
    const acked = (await first.json()) as { changed: boolean; message: Message };
    expect(acked.changed).toBe(true);
    expect(acked.message.delivery?.[0].deliveredAt).toEqual(expect.any(String));
    expect(acked.message.delivery?.[0].readAt).toEqual(expect.any(String));
    const again = (await (
      await call(f.tenant, `/channels/work/messages/${sent.message.id}/ack`, f.agent, "POST", {
        username: "dev",
      })
    ).json()) as { changed: boolean; message: Message };
    expect(again.changed).toBe(false);
    expect(again.message.delivery).toEqual(acked.message.delivery);
    const stranger = await call(f.tenant, `/channels/work/messages/${sent.message.id}/ack`, f.agent, "POST", {
      username: "lead",
    });
    expect(stranger.status).toBe(403);
    expect(await stranger.json()).toMatchObject({ error: { code: "not_recipient" } });
    const other = await call(f.tenant, `/channels/work/messages/${sent.message.id}/ack`, f.owner, "POST", {
      username: "dev",
    });
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ error: { code: "username_bound" } });
    const missing = await call(f.tenant, "/channels/work/messages/99/ack", f.agent, "POST", {
      username: "dev",
    });
    expect(missing.status).toBe(404);
    expect(
      (
        await exports.default.fetch(
          `https://msn.test/api/admin/tenants/${f.tenant}/channels/work/messages/${sent.message.id}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${"test-admin-secret-000000000000000000000"}` },
          },
        )
      ).status,
    ).toBe(204);
    const gone = await call(f.tenant, `/channels/work/messages/${sent.message.id}/ack`, f.agent, "POST", {
      username: "dev",
    });
    expect(gone.status).toBe(410);
  });

  it("given a watch-only key or an archived board, when the recipient acks, then it is read and a post is still refused", async () => {
    const f = await fixture();
    const sent = await (await f.send({ username: "lead", text: "look", to: "dev" })).json<{
      message: Message;
    }>();
    const invite = await (
      await call(f.tenant, "/invites", f.owner, "POST", { channel: "work", watch: true })
    ).json<{ code: string }>();
    const watcher = await (
      await call(f.tenant, "/invites/redeem", undefined, "POST", { code: invite.code, username: "dev" })
    ).json<{ token: string }>();
    const posted = await call(f.tenant, "/channels/work/messages", watcher.token, "POST", {
      username: "dev",
      text: "no",
    });
    expect(posted.status).toBe(403);
    const acked = await call(
      f.tenant,
      `/channels/work/messages/${sent.message.id}/ack`,
      watcher.token,
      "POST",
      {
        username: "dev",
      },
    );
    expect(acked.status).toBe(200);
    expect(await acked.json()).toMatchObject({ changed: true });
    const later = await (await f.send({ username: "lead", text: "after", to: "dev" })).json<{
      message: Message;
    }>();
    expect((await call(f.tenant, "/channels/work/archive", f.owner, "PUT")).status).toBe(200);
    const archived = await call(
      f.tenant,
      `/channels/work/messages/${later.message.id}/ack`,
      f.agent,
      "POST",
      {
        username: "dev",
      },
    );
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ changed: true });
    const other = await call(
      f.tenant,
      `/channels/work/messages/${later.message.id}/ack`,
      watcher.token,
      "POST",
      {
        username: "lead",
      },
    );
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ error: { code: "username_bound" } });
  });

  it("given a webhook, when message.addressed is delivered, then that persona is delivered and a failure is not", async () => {
    const f = await fixture();
    const sent: { body: string }[] = [];
    let ok = true;
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    await runInDurableObject(stub, (instance: MsnDurableObject) => {
      instance.webhookFetch = async (_input, init) => {
        sent.push({ body: String(init?.body) });
        return ok ? new Response("ok") : new Response("no", { status: 500 });
      };
    });
    expect(
      (
        await call(f.tenant, "/channels/work/personas/dev/webhook", f.owner, "PUT", {
          url: "https://agent.example.com/wake",
        })
      ).status,
    ).toBe(201);
    const deliver = () =>
      runInDurableObject(stub, async (instance: MsnDurableObject, state) => {
        state.storage.sql.exec("UPDATE webhook_notices SET nextAttemptMs = 0");
        return instance.sendDueNotices();
      });
    await f.send({ username: "lead", text: "ping", to: "dev" });
    ok = false;
    await deliver();
    let stored = (await page(f, f.owner)).messages[0];
    expect(stored.delivery?.[0].deliveredAt).toBeNull();
    ok = true;
    await deliver();
    stored = (await page(f, f.owner)).messages[0];
    expect(stored.delivery?.[0].deliveredAt).toEqual(expect.any(String));
    expect(stored.delivery?.[0].readAt).toBeNull();
    const notice = JSON.parse(sent[0].body) as Record<string, unknown>;
    expect(notice.delivery).toBeUndefined();
    expect(notice.type).toBe("message.addressed");
  });

  it("given a persona already listening, when a message is addressed to them, then it is delivered at once", async () => {
    const f = await fixture();
    const head = await (await call(f.tenant, "/events?wait=0", f.agent)).json<{ nextCursor: number }>();
    const poll = call(f.tenant, `/events?wait=20&after=${head.nextCursor}&listener=dev`, f.agent);
    for (let i = 0; i < 50; i++) {
      const roster = await (await call(f.tenant, "/channels/work/personas", f.agent)).json<{
        personas: { id: string; listening: boolean }[];
      }>();
      if (roster.personas.find((persona) => persona.id === "dev")?.listening) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const sent = await (await f.send({ username: "lead", text: "live", to: "dev" })).json<{
      message: Message;
    }>();
    expect(sent.message.delivery?.[0].deliveredAt).toEqual(expect.any(String));
    expect(sent.message.delivery?.[0].readAt).toBeNull();
    expect((await poll).status).toBe(200);
  });

  it("given a waiter with acksAfter, when the recipient reads, then the poll returns the message", async () => {
    const f = await fixture();
    const sent = await (await f.send({ username: "lead", text: "wait", to: "dev" })).json<{
      message: Message;
    }>();
    const waiting = call(
      f.tenant,
      `/channels/work/messages?after=${sent.message.id}&wait=20&acksAfter=0`,
      f.owner,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      (
        await call(f.tenant, `/channels/work/messages/${sent.message.id}/ack`, f.agent, "POST", {
          username: "dev",
        })
      ).status,
    ).toBe(200);
    const woken = await (await waiting).json<{ acks: Message[]; ackCursor: number }>();
    expect(woken.acks.map((message) => message.id)).toEqual([sent.message.id]);
    expect(woken.acks[0].delivery?.[0].readAt).toEqual(expect.any(String));
    expect(woken.ackCursor).toBeGreaterThan(0);
  });

  it("given an ack, when events and receipts are read, then neither grows a delivery event", async () => {
    const f = await fixture();
    const sent = await (await f.send({ username: "lead", text: "quiet", to: "dev" })).json<{
      message: Message;
    }>();
    await call(f.tenant, `/channels/work/messages/${sent.message.id}/ack`, f.agent, "POST", {
      username: "dev",
    });
    const events = await (await call(f.tenant, "/events?wait=0", f.agent)).json<{
      events: { type: string }[];
    }>();
    expect(events.events.every((event) => event.type !== "message.acked")).toBe(true);
    const receipts = await call(f.tenant, `/channels/work/messages/${sent.message.id}/receipts`, f.agent);
    expect(receipts.status).toBe(200);
    const body = (await receipts.json()) as { processed: unknown; delivery?: unknown };
    expect(body.delivery).toBeUndefined();
    expect(Array.isArray(body.processed)).toBe(true);
  });

  it("given the same idempotency key, when send is retried, then delivery is not duplicated", async () => {
    const f = await fixture();
    const first = await (await f.send({ username: "lead", text: "once", to: "dev" }, "same-key")).json<{
      message: Message;
      replayed: boolean;
    }>();
    const second = await (await f.send({ username: "lead", text: "once", to: "dev" }, "same-key")).json<{
      message: Message;
      replayed: boolean;
    }>();
    expect(second.replayed).toBe(true);
    expect(second.message.delivery).toEqual(first.message.delivery);
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    const count = await runInDurableObject(
      stub,
      (_instance: MsnDurableObject, state) =>
        state.storage.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM message_delivery WHERE messageId = ?",
            first.message.id,
          )
          .one().n,
    );
    expect(count).toBe(1);
  });

  it("given an older message whose rows were removed, when it is acknowledged, then the rows return as read", async () => {
    const f = await fixture();
    const sent = await (await f.send({ username: "lead", text: "old", to: "dev" })).json<{
      message: Message;
    }>();
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    await runInDurableObject(stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec("DELETE FROM message_delivery WHERE messageId = ?", sent.message.id);
    });
    const bare = await (await call(f.tenant, `/channels/work/messages/${sent.message.id}`, f.owner)).json<{
      message: Message;
    }>();
    expect(bare.message.delivery).toBeUndefined();
    const acked = await (
      await call(f.tenant, `/channels/work/messages/${sent.message.id}/ack`, f.agent, "POST", {
        username: "dev",
      })
    ).json<{ message: Message }>();
    expect(acked.message.delivery?.[0].readAt).toEqual(expect.any(String));
    expect(acked.message.delivery?.[0].deliveredAt).toEqual(expect.any(String));
  });

  it("given an edit, when text changes, then addressees and delivery rows stay and a new name cannot be added", async () => {
    const f = await fixture();
    const sent = await (await f.send({ username: "lead", text: "please", to: ["dev", "lead"] })).json<{
      message: Message;
    }>();
    const rejected = await call(f.tenant, `/channels/work/messages/${sent.message.id}`, f.agent, "PATCH", {
      username: "lead",
      text: "please",
      to: "dev",
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: "invalid_edit" } });
    const edited = await (
      await call(f.tenant, `/channels/work/messages/${sent.message.id}`, f.agent, "PATCH", {
        username: "lead",
        text: "revised",
      })
    ).json<{ message: Message }>();
    expect(edited.message.text).toBe("revised");
    expect(edited.message.delivery).toEqual(sent.message.delivery);
    const stranger = await call(f.tenant, `/channels/work/messages/${sent.message.id}/ack`, f.agent, "POST", {
      username: "human",
    });
    expect(stranger.status).toBe(400);
    expect(await stranger.json()).toMatchObject({ error: { code: "persona_required" } });
  });

  it("given one recipient's row is missing, when they ack, then that row is created and marked read", async () => {
    const f = await fixture();
    const sent = await (await f.send({ username: "lead", text: "both", to: ["dev", "lead"] })).json<{
      message: Message;
    }>();
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    await runInDurableObject(stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec(
        "DELETE FROM message_delivery WHERE messageId = ? AND name = ?",
        sent.message.id,
        "lead",
      );
    });
    const acked = await (
      await call(f.tenant, `/channels/work/messages/${sent.message.id}/ack`, f.agent, "POST", {
        username: "lead",
      })
    ).json<{ changed: boolean; message: Message }>();
    expect(acked.changed).toBe(true);
    expect(acked.message.delivery?.find((row) => row.name === "lead")?.readAt).toEqual(expect.any(String));
    expect(acked.message.delivery?.find((row) => row.name === "dev")?.readAt).toBeNull();
  });

  it("given a deleted message, when ticks are read, then it is absent and its rows are gone", async () => {
    const f = await fixture();
    const sent = await (await f.send({ username: "lead", text: "gone", to: "dev" })).json<{
      message: Message;
    }>();
    await call(f.tenant, `/channels/work/messages/${sent.message.id}/ack`, f.agent, "POST", {
      username: "dev",
    });
    expect(
      (
        await exports.default.fetch(
          `https://msn.test/api/admin/tenants/${f.tenant}/channels/work/messages/${sent.message.id}`,
          { method: "DELETE", headers: { Authorization: "Bearer test-admin-secret-000000000000000000000" } },
        )
      ).status,
    ).toBe(204);
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    const left = await runInDurableObject(
      stub,
      (_instance: MsnDurableObject, state) =>
        state.storage.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM message_delivery WHERE messageId = ?",
            sent.message.id,
          )
          .one().n,
    );
    expect(left).toBe(0);
    const ticks = await page(f, f.owner, `after=${sent.message.id}&acksAfter=0`);
    expect(ticks.acks ?? []).toEqual([]);
  });

  it("given a shared key, when it acks as github, a stranger, or on another board, then each is refused", async () => {
    const f = await fixture();
    const sent = await (await f.send({ username: "lead", text: "plain", to: "dev" })).json<{
      message: Message;
    }>();
    const bare = await (await f.send({ username: "lead", text: "open" })).json<{ message: Message }>();
    const github = await call(f.tenant, `/channels/work/messages/${sent.message.id}/ack`, f.agent, "POST", {
      username: "github",
    });
    expect(github.status).toBe(403);
    expect(await github.json()).toMatchObject({ error: { code: "reserved_name" } });
    const ghost = await call(f.tenant, `/channels/work/messages/${sent.message.id}/ack`, f.agent, "POST", {
      username: "ghost",
    });
    expect(ghost.status).toBe(400);
    expect(await ghost.json()).toMatchObject({ error: { code: "persona_required" } });
    const open = await call(f.tenant, `/channels/work/messages/${bare.message.id}/ack`, f.agent, "POST", {
      username: "dev",
    });
    expect(open.status).toBe(403);
    expect(await open.json()).toMatchObject({ error: { code: "not_recipient" } });
    const invite = await (await call(f.tenant, "/invites", f.owner, "POST", { channel: "work" })).json<{
      code: string;
    }>();
    const member = await (
      await call(f.tenant, "/invites/redeem", undefined, "POST", { code: invite.code, username: "dev" })
    ).json<{ token: string }>();
    expect((await call(f.tenant, "/channels/other", f.owner, "PUT")).status).toBe(201);
    const scoped = await call(
      f.tenant,
      `/channels/other/messages/${sent.message.id}/ack`,
      member.token,
      "POST",
      {
        username: "dev",
      },
    );
    expect(scoped.status).toBe(403);
    expect(await scoped.json()).toMatchObject({ error: { code: "channel_forbidden" } });
  });

  it("given search, one message, and catch-up, when the recipient reads, then only the message and catch-up deliver", async () => {
    const f = await fixture();
    const sent = await (await f.send({ username: "lead", text: "needletick", to: "dev" })).json<{
      message: Message;
    }>();
    const invite = await (await call(f.tenant, "/invites", f.owner, "POST", { channel: "work" })).json<{
      code: string;
    }>();
    const member = await (
      await call(f.tenant, "/invites/redeem", undefined, "POST", { code: invite.code, username: "dev" })
    ).json<{ token: string }>();
    // A bound key's search still must not mark the hit delivered.
    const found = await call(f.tenant, `/channels/work/search?q=needletick`, member.token);
    expect(found.status).toBe(200);
    let stored = (await page(f, f.owner)).messages.find((message) => message.id === sent.message.id);
    expect(stored?.delivery?.[0].deliveredAt).toBeNull();
    const one = await (
      await call(f.tenant, `/channels/work/messages/${sent.message.id}?participant=dev`, f.agent)
    ).json<{ message: Message }>();
    expect(one.message.delivery?.[0].deliveredAt).toEqual(expect.any(String));
    expect(one.message.delivery?.[0].readAt).toBeNull();
    const second = await (await f.send({ username: "lead", text: "later", to: "dev" })).json<{
      message: Message;
    }>();
    const caught = await call(f.tenant, "/channels/work/catchup?reader=dev/worker", member.token);
    expect(caught.status).toBe(200);
    stored = (await page(f, f.owner)).messages.find((message) => message.id === second.message.id);
    expect(stored?.delivery?.[0].deliveredAt).toEqual(expect.any(String));
    expect(stored?.delivery?.[0].readAt).toBeNull();
  });

  it("given a webhook, when the notice is message.posted or the persona is gone, then nothing is delivered", async () => {
    const f = await fixture();
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    await runInDurableObject(stub, (instance: MsnDurableObject) => {
      instance.webhookFetch = async () => new Response("ok");
    });
    expect(
      (
        await call(f.tenant, "/channels/work/personas/dev/webhook", f.owner, "PUT", {
          url: "https://agent.example.com/wake",
          subscribe: "board",
        })
      ).status,
    ).toBe(201);
    const posted = await (await f.send({ username: "lead", text: "board", to: "lead" })).json<{
      message: Message;
    }>();
    await runInDurableObject(stub, async (instance: MsnDurableObject, state) => {
      state.storage.sql.exec("UPDATE webhook_notices SET nextAttemptMs = 0");
      return instance.sendDueNotices();
    });
    let stored = (await page(f, f.owner)).messages.find((message) => message.id === posted.message.id);
    expect(stored?.delivery?.[0].deliveredAt).toBeNull();
    const addressed = await (await f.send({ username: "lead", text: "you", to: "dev" })).json<{
      message: Message;
    }>();
    await runInDurableObject(stub, (_instance: MsnDurableObject, state) => {
      state.storage.sql.exec("DELETE FROM personas WHERE channel = ? AND id = ?", "work", "dev");
    });
    await runInDurableObject(stub, async (instance: MsnDurableObject, state) => {
      state.storage.sql.exec("UPDATE webhook_notices SET nextAttemptMs = 0");
      return instance.sendDueNotices();
    });
    stored = (await page(f, f.owner)).messages.find((message) => message.id === addressed.message.id);
    expect(stored?.delivery?.[0].deliveredAt).toBeNull();
  });

  it("given more tick changes than one page, when the client follows ackCursor, then the rest arrive", async () => {
    const f = await fixture();
    const ids: number[] = [];
    for (let n = 0; n < 21; n++) {
      const sent = await (await f.send({ username: "lead", text: `n${n}`, to: "dev" })).json<{
        message: Message;
      }>();
      ids.push(sent.message.id);
      expect(
        (
          await call(f.tenant, `/channels/work/messages/${sent.message.id}/ack`, f.agent, "POST", {
            username: "dev",
          })
        ).status,
      ).toBe(200);
    }
    const through = ids[ids.length - 1];
    const first = await page(f, f.owner, `after=${through}&acksAfter=0`);
    expect(first.acksHasMore).toBe(true);
    expect(first.acks).toHaveLength(20);
    const second = await page(f, f.owner, `after=${through}&acksAfter=${first.ackCursor}`);
    expect(second.acksHasMore).toBe(false);
    expect(second.acks?.map((message) => message.id)).toEqual([ids[20]]);
  });
});
