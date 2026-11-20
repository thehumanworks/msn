import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ADMIN = "test-admin-secret-000000000000000000000";

const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });

type Message = { id: number; text: string; pinnedAt?: string; pinnedBy?: string; tenant: string };
type Catchup = {
  pinned?: Message[];
  pinnedOmitted?: number;
  messages: Message[];
  nextCursor: number;
  hasMore: boolean;
  byteLimitReached: boolean;
};

/** An owner account with a board `work`, its shared agent credential and persona `lead`. */
async function fixture() {
  const tenant = `pin-${crypto.randomUUID()}`;
  const owner = (await (await call(tenant, "", undefined, "PUT", { username: "human" })).json()) as {
    token: string;
  };
  const agent = "c".repeat(64);
  expect(
    (await call(tenant, "/channels/work/board", owner.token, "PUT", { credential: agent, goal: "Ship" }))
      .status,
  ).toBe(201);
  expect(
    (await call(tenant, "/channels/work/personas/lead", agent, "PUT", { displayName: "lead" })).status,
  ).toBe(201);
  const send = async (text: string, token = agent, username = "lead") => {
    const response = await call(tenant, "/channels/work/messages", token, "POST", { username, text });
    expect(response.status).toBe(201);
    return ((await response.json()) as { message: Message }).message;
  };
  return { tenant, owner: owner.token, agent, send };
}

const pin = (f: { tenant: string }, id: number, token: string, method = "PUT") =>
  call(f.tenant, `/channels/work/pins/${id}`, token, method);
const pins = async (f: { tenant: string }, token: string) =>
  ((await (await call(f.tenant, "/channels/work/pins", token)).json()) as { pins: Message[]; limit: number })
    .pins;

describe("pinned messages (ADR 0038)", () => {
  it("lets only the owner pin and unpin, and lists pins in message order for every reader", async () => {
    const f = await fixture();
    const rules = await f.send("Rules: one task per agent.");
    const plan = await f.send("Plan: ship pins today.");
    const denied = await pin(f, rules.id, f.agent);
    expect(denied.status).toBe(403);
    expect(await pins(f, f.agent)).toEqual([]);

    const second = await pin(f, plan.id, f.owner);
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ created: true, pin: { id: plan.id, pinnedBy: "human" } });
    expect((await pin(f, rules.id, f.owner)).status).toBe(201);
    const again = await pin(f, rules.id, f.owner);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false });

    const listed = await pins(f, f.agent);
    expect(listed.map((m) => m.id)).toEqual([rules.id, plan.id]);
    expect(listed[0]).toMatchObject({ text: rules.text, pinnedBy: "human", tenant: f.tenant });
    expect(typeof listed[0].pinnedAt).toBe("string");

    expect((await pin(f, rules.id, f.agent, "DELETE")).status).toBe(403);
    expect((await pin(f, rules.id, f.owner, "DELETE")).status).toBe(204);
    expect((await pin(f, rules.id, f.owner, "DELETE")).status).toBe(204);
    expect((await pins(f, f.owner)).map((m) => m.id)).toEqual([plan.id]);
  });

  it("does not send a message or move cursors", async () => {
    const f = await fixture();
    const first = await f.send("first");
    await pin(f, first.id, f.owner);
    const page = (await (await call(f.tenant, "/channels/work/messages?after=0", f.agent)).json()) as {
      messages: Message[];
      nextCursor: number;
    };
    expect(page.messages.map((m) => m.id)).toEqual([first.id]);
    expect(page.nextCursor).toBe(first.id);
    expect("pinnedAt" in page.messages[0]).toBe(false);
    const next = await f.send("second");
    expect(next.id).toBe(first.id + 1);
  });

  it("caps a board at 10 pins and rejects unknown ids, other boards and bad ids", async () => {
    const f = await fixture();
    const sent: Message[] = [];
    for (let i = 0; i < 11; i++) sent.push(await f.send(`m${i}`));
    for (const message of sent.slice(0, 10)) expect((await pin(f, message.id, f.owner)).status).toBe(201);
    const over = await pin(f, sent[10].id, f.owner);
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: { code: "pin_limit" } });
    // Pinning an already pinned message at the cap is not an error.
    expect((await pin(f, sent[0].id, f.owner)).status).toBe(200);
    expect((await pin(f, 99999, f.owner)).status).toBe(404);
    expect((await pin(f, 0, f.owner)).status).toBe(400);
    expect((await call(f.tenant, "/channels/work/pins/1/x", f.owner, "PUT")).status).toBe(404);
    expect((await call(f.tenant, "/channels/missing/pins", f.owner)).status).toBe(404);
  });

  it("drops the pin when an admin deletes the message, and refuses to pin a deleted one", async () => {
    const tenant = `pin-admin-${crypto.randomUUID()}`;
    const created = await exports.default.fetch(`https://msn.test/api/admin/tenants/${tenant}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    const { token } = (await created.json()) as { token: string };
    const send = async (text: string) =>
      (
        (await (
          await call(tenant, "/channels/general/messages", token, "POST", { username: "a", text })
        ).json()) as {
          message: Message;
        }
      ).message;
    const keep = await send("keep");
    const gone = await send("gone");
    for (const id of [keep.id, gone.id])
      expect((await call(tenant, `/channels/general/pins/${id}`, token, "PUT")).status).toBe(201);
    const deleted = await exports.default.fetch(
      `https://msn.test/api/admin/tenants/${tenant}/channels/general/messages/${gone.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN}` } },
    );
    expect(deleted.status).toBe(204);
    const listed = (await (await call(tenant, "/channels/general/pins", token)).json()) as {
      pins: Message[];
    };
    expect(listed.pins.map((m) => m.id)).toEqual([keep.id]);
    expect((await call(tenant, `/channels/general/pins/${gone.id}`, token, "PUT")).status).toBe(410);
  });

  it("leads the first catch-up page with pins, inside the byte budget, and never on continuations", async () => {
    const f = await fixture();
    const rules = await f.send(`Rules ${"r".repeat(3000)}`);
    for (let i = 0; i < 4; i++) await f.send(`work ${i} ${"w".repeat(1500)}`);
    await pin(f, rules.id, f.owner);

    const first = (await (
      await call(f.tenant, "/channels/work/catchup?limit=10", f.agent)
    ).json()) as Catchup;
    expect(first.pinned?.map((m) => m.id)).toEqual([rules.id]);
    expect(first.pinnedOmitted).toBe(0);
    expect(first.messages.map((m) => m.id)[0]).toBe(rules.id);

    const continued = (await (
      await call(f.tenant, `/channels/work/catchup?after=${rules.id}`, f.agent)
    ).json()) as Catchup;
    expect("pinned" in continued).toBe(false);

    // A small budget keeps the pin and sheds tail messages first.
    const tight = await call(f.tenant, "/channels/work/catchup?limit=10&maxBytes=8000", f.agent);
    const tightBody = await tight.text();
    expect(new TextEncoder().encode(tightBody).length).toBeLessThanOrEqual(8000);
    const page = JSON.parse(tightBody) as Catchup;
    expect(page.pinned?.map((m) => m.id)).toEqual([rules.id]);
    expect(page.messages.length).toBeGreaterThanOrEqual(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(page.messages.at(-1)?.id);

    // When the pin cannot fit next to the first pending message, it is omitted and counted.
    const tiny = await call(f.tenant, "/channels/work/catchup?limit=10&maxBytes=4500", f.agent);
    const tinyBody = await tiny.text();
    expect(tiny.status).toBe(200);
    expect(new TextEncoder().encode(tinyBody).length).toBeLessThanOrEqual(4500);
    const small = JSON.parse(tinyBody) as Catchup;
    expect(small.pinned).toEqual([]);
    expect(small.pinnedOmitted).toBe(1);
    expect(small.messages.map((m) => m.id)).toEqual([rules.id]);
    expect(small.byteLimitReached).toBe(true);
  });

  it("keeps a channel-scoped key inside its own board", async () => {
    const f = await fixture();
    expect((await call(f.tenant, "/channels/other", f.owner, "PUT")).status).toBe(201);
    const response = await call(f.tenant, "/channels/other/messages", f.owner, "POST", {
      username: "human",
      text: "elsewhere",
    });
    const other = ((await response.json()) as { message: Message }).message;
    expect((await call(f.tenant, `/channels/other/pins/${other.id}`, f.owner, "PUT")).status).toBe(201);
    expect((await call(f.tenant, "/channels/other/pins", f.agent)).status).toBe(403);
    expect((await call(f.tenant, `/channels/other/pins/${other.id}`, f.agent, "PUT")).status).toBe(403);
    expect((await call(f.tenant, `/channels/other/pins/${other.id}`, f.agent, "DELETE")).status).toBe(403);
    expect((await call(f.tenant, "/channels/other/catchup", f.agent)).status).toBe(403);
    const own = (await (await call(f.tenant, "/channels/work/catchup", f.agent)).json()) as Catchup;
    expect(own.pinned).toEqual([]);
  });

  it("keeps the oldest pins when a tight budget drops some, and counts the rest", async () => {
    const f = await fixture();
    const pinnedIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const message = await f.send(`pin ${i} ${"p".repeat(1500)}`);
      pinnedIds.push(message.id);
      await pin(f, message.id, f.owner);
    }
    await f.send("tail");
    const response = await call(f.tenant, "/channels/work/catchup?limit=10&maxBytes=6500", f.agent);
    const body = await response.text();
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(6500);
    const page = JSON.parse(body) as Catchup;
    expect(page.messages).toHaveLength(1);
    expect(page.pinned?.map((m) => m.id)).toEqual(pinnedIds.slice(0, 2));
    expect(page.pinnedOmitted).toBe(1);
    expect(page.byteLimitReached).toBe(true);
  });

  it("records schema version 18 (now the latest, 20) and creates the pins table", async () => {
    const f = await fixture();
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    await runInDurableObject(stub, (_instance, state) => {
      const versions = state.storage.sql
        .exec<{ version: number }>("SELECT version FROM schema_version ORDER BY version")
        .toArray()
        .map((row) => row.version);
      expect(versions.at(-1)).toBe(20);
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pins'")
        .toArray();
      expect(tables).toHaveLength(1);
    });
  });
});
