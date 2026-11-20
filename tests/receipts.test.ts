import { abortAllDurableObjects } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Processed-by receipts (ADR 0040): read only from explicit resumable commits (ADR 0034).
const ADMIN = "test-admin-secret-000000000000000000000";
const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
type Connection = { tenant: string; token: string };
type Receipt = {
  name: string;
  reader: string | null;
  personaId: string | null;
  committedThrough: number | null;
  updatedAt: string | null;
};
type Split = { channel: string; messageId: number; processed: Receipt[]; notYet: Receipt[] };

async function fixture() {
  const tenant = `rcpt-${crypto.randomUUID()}`;
  const owner = await (await call(tenant, "", undefined, "PUT", { username: "human" })).json<Connection>();
  const board = "c".repeat(64);
  expect(
    (await call(tenant, "/channels/work/board", owner.token, "PUT", { credential: board, goal: "Ship it" }))
      .status,
  ).toBe(201);
  for (const [id, displayName] of [
    ["p1", "lead"],
    ["p2", "reviewer"],
    ["p3", "worker"],
  ])
    await call(tenant, `/channels/work/personas/${id}`, board, "PUT", { displayName });
  for (let i = 1; i <= 4; i++)
    expect(
      (
        await call(tenant, "/channels/work/messages", owner.token, "POST", {
          username: "human",
          text: `m${i}`,
        })
      ).status,
    ).toBe(201);
  return { tenant, owner: owner.token, board };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function commitAs(f: Fixture, reader: string, through: number) {
  const base = `/channels/work/processing/${encodeURIComponent(reader)}`;
  const claimed = await call(f.tenant, `${base}/claim`, f.board, "POST", { expectGeneration: 0 });
  expect(claimed.status).toBe(201);
  const { generation } = await claimed.json<{ generation: number }>();
  if (through > 0)
    expect((await call(f.tenant, `${base}/commit`, f.board, "POST", { generation, through })).status).toBe(
      200,
    );
}
const split = async (f: Fixture, id: number, token = f.board) => {
  const response = await call(f.tenant, `/channels/work/messages/${id}/receipts`, token);
  expect(response.status).toBe(200);
  return response.json<Split>();
};
const names = (receipts: Receipt[]) => receipts.map((receipt) => receipt.name);

describe("processed-by receipts (ADR 0040)", () => {
  it("lists every persona as not yet until an explicit commit covers the message", async () => {
    const f = await fixture();
    const result = await split(f, 1);
    expect(result).toMatchObject({ channel: "work", messageId: 1, processed: [] });
    expect(result.notYet).toEqual([
      { name: "lead", reader: null, personaId: "p1", committedThrough: null, updatedAt: null },
      { name: "reviewer", reader: null, personaId: "p2", committedThrough: null, updatedAt: null },
      { name: "worker", reader: null, personaId: "p3", committedThrough: null, updatedAt: null },
    ]);
  });

  it("splits personas by committedThrough, keeps worker suffixes and unknown readers, and survives a restart", async () => {
    const f = await fixture();
    await commitAs(f, "p1", 2);
    await commitAs(f, "p2/w1", 4);
    await commitAs(f, "ops", 1);
    await abortAllDurableObjects();

    const one = await split(f, 1);
    expect(names(one.processed)).toEqual(["lead", "reviewer/w1", "ops"]);
    expect(names(one.notYet)).toEqual(["worker"]);
    expect(one.processed[1]).toMatchObject({ reader: "p2/w1", personaId: "p2", committedThrough: 4 });
    expect(one.processed[2]).toMatchObject({ reader: "ops", personaId: null, committedThrough: 1 });

    const three = await split(f, 3);
    expect(names(three.processed)).toEqual(["reviewer/w1"]);
    expect(names(three.notYet)).toEqual(["lead", "worker", "ops"]);
    expect(three.notYet[0]).toMatchObject({ committedThrough: 2 });

    const all = await (await call(f.tenant, "/channels/work/receipts", f.owner)).json<{
      channel: string;
      receipts: Receipt[];
    }>();
    expect(all.channel).toBe("work");
    expect(all.receipts.map((r) => [r.name, r.committedThrough])).toEqual([
      ["lead", 2],
      ["reviewer/w1", 4],
      ["worker", null],
      ["ops", 1],
    ]);
  });

  it("never counts a claim without a commit, listening or posting as processed", async () => {
    const f = await fixture();
    await commitAs(f, "p1", 0);
    // p2 listens and p3 posts; neither is a commit.
    expect((await call(f.tenant, "/events?channel=work&wait=0&listener=p2", f.board)).status).toBe(200);
    expect(
      (
        await call(f.tenant, "/channels/work/messages", f.board, "POST", {
          username: "worker",
          personaId: "p3",
          text: "on it",
        })
      ).status,
    ).toBe(201);
    const result = await split(f, 1);
    expect(result.processed).toEqual([]);
    expect(result.notYet.map((r) => [r.name, r.committedThrough])).toEqual([
      ["lead", 0],
      ["reviewer", null],
      ["worker", null],
    ]);
  });

  it("works on a channel without personas and refuses missing, deleted and out-of-scope messages", async () => {
    const tenant = `rcpt-${crypto.randomUUID()}`;
    const owner = await (
      await call(tenant, "", undefined, "PUT", { username: "human", channel: "plain" })
    ).json<Connection>();
    for (const text of ["a", "b"])
      await call(tenant, "/channels/plain/messages", owner.token, "POST", { username: "human", text });
    const empty = await (
      await call(tenant, "/channels/plain/messages/1/receipts", owner.token)
    ).json<Split>();
    expect(empty).toMatchObject({ processed: [], notYet: [] });

    const base = `/channels/plain/processing/human`;
    await call(tenant, `${base}/claim`, owner.token, "POST", { expectGeneration: 0 });
    await call(tenant, `${base}/commit`, owner.token, "POST", { generation: 1, through: 1 });
    const one = await (await call(tenant, "/channels/plain/messages/1/receipts", owner.token)).json<Split>();
    expect(one.processed).toMatchObject([{ name: "human", reader: "human", personaId: null }]);

    const missing = await call(tenant, "/channels/plain/messages/99/receipts", owner.token);
    expect(missing.status).toBe(404);
    expect(
      (
        await exports.default.fetch(
          `https://msn.test/api/admin/tenants/${tenant}/channels/plain/messages/2`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${ADMIN}` },
          },
        )
      ).status,
    ).toBe(204);
    expect((await call(tenant, "/channels/plain/messages/2/receipts", owner.token)).status).toBe(410);
    expect((await call(tenant, "/channels/nowhere/receipts", owner.token)).status).toBe(404);

    const f = await fixture();
    expect((await call(f.tenant, "/channels/other/receipts", f.board)).status).toBe(403);
    expect((await call(f.tenant, "/channels/work/receipts")).status).toBe(401);
  });
});
