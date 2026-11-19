import { abortAllDurableObjects } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Resumable processing cursors (ADR 0034): progress lives on the server, and a takeover fences
// the replaced generation out of every later peek and commit.
const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
type Connection = { tenant: string; token: string };
type Cursor = { reader: string; generation: number; committedThrough: number; holder: string | null };
type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };
const P = "/channels/work/processing/human%2Fagent%201";

async function fixture(messages = 3) {
  const tenant = `proc-${crypto.randomUUID()}`;
  const owner = await (
    await call(tenant, "", undefined, "PUT", { username: "human", channel: "work" })
  ).json<Connection>();
  for (let i = 1; i <= messages; i++)
    expect(
      (
        await call(tenant, "/channels/work/messages", owner.token, "POST", {
          username: "human",
          text: `m${i}`,
        })
      ).status,
    ).toBe(201);
  return { tenant, token: owner.token };
}
const claim = (f: Connection, expectGeneration: number, extra: Record<string, unknown> = {}) =>
  call(f.tenant, `${P}/claim`, f.token, "POST", { expectGeneration, ...extra });
const commit = (f: Connection, generation: number, through: number) =>
  call(f.tenant, `${P}/commit`, f.token, "POST", { generation, through });
const peek = (f: Connection, generation: number, query = "") =>
  call(
    f.tenant,
    `/channels/work/messages?processingReader=${encodeURIComponent("human/agent 1")}&generation=${generation}${query}`,
    f.token,
  );

describe("resumable processing cursors", () => {
  it("claims once, resumes on another machine after an explicit takeover, and fences the old generation", async () => {
    const f = await fixture();
    expect(await (await call(f.tenant, P, f.token)).json<Cursor>()).toMatchObject({
      generation: 0,
      committedThrough: 0,
    });
    const first = await claim(f, 0, { holder: "laptop" });
    expect(first.status).toBe(201);
    expect(await first.json<Cursor>()).toMatchObject({
      generation: 1,
      committedThrough: 0,
      holder: "laptop",
    });

    const page = await (await peek(f, 1)).json<{ messages: { id: number }[]; committedThrough: number }>();
    expect(page.messages.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(page.committedThrough).toBe(0);
    expect((await commit(f, 1, 2)).status).toBe(200);

    // A second machine never takes over silently: a first claim on a held reader is refused.
    const held = await claim(f, 0, { holder: "server" });
    expect(held.status).toBe(409);
    expect(await held.json<ErrorBody>()).toMatchObject({
      error: { code: "processing_held", details: { generation: 1, holder: "laptop", committedThrough: 2 } },
    });

    // Explicit takeover names the generation it replaces and resumes from committed progress.
    const taken = await claim(f, 1, { holder: "server" });
    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({ generation: 2, previousGeneration: 1, committedThrough: 2 });
    const resumed = await (await peek(f, 2)).json<{ messages: { id: number }[] }>();
    expect(resumed.messages.map((m) => m.id)).toEqual([3]);

    // The old generation can neither commit nor peek any more, even after a restart.
    await abortAllDurableObjects();
    for (const response of [await commit(f, 1, 3), await peek(f, 1)]) {
      expect(response.status).toBe(409);
      expect((await response.json<ErrorBody>()).error.code).toBe("processing_fenced");
    }
    expect(await (await call(f.tenant, P, f.token)).json<Cursor>()).toMatchObject({
      generation: 2,
      committedThrough: 2,
    });
    expect((await commit(f, 2, 3)).status).toBe(200);
  });

  it("lets only one of two racing takeovers win", async () => {
    const f = await fixture();
    expect((await claim(f, 0)).status).toBe(201);
    const results = await Promise.all([claim(f, 1, { holder: "a" }), claim(f, 1, { holder: "b" })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409);
    expect((await loser?.json<ErrorBody>())?.error.code).toBe("processing_generation_mismatch");
  });

  it("fences a long poll that a takeover overtakes", async () => {
    const f = await fixture(0);
    expect((await claim(f, 0)).status).toBe(201);
    const waiting = peek(f, 1, "&wait=5");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await claim(f, 1)).status).toBe(200);
    expect(
      (await call(f.tenant, "/channels/work/messages", f.token, "POST", { username: "human", text: "late" }))
        .status,
    ).toBe(201);
    const response = await waiting;
    expect(response.status).toBe(409);
    expect((await response.json<ErrorBody>()).error.code).toBe("processing_fenced");
  });

  it("validates commits, first-claim progress and query shape", async () => {
    const f = await fixture();
    expect((await commit(f, 1, 1)).status).toBe(404);
    expect((await claim(f, 0, { committedThrough: 99 })).status).toBe(400);
    expect(await (await claim(f, 0, { committedThrough: 2 })).json()).toMatchObject({
      generation: 1,
      committedThrough: 2,
    });
    expect((await commit(f, 1, 1)).status).toBe(409);
    expect((await commit(f, 1, 4)).status).toBe(400);
    expect((await commit(f, 1, 2)).status).toBe(200);
    expect((await claim(f, 1, { committedThrough: 0 })).status).toBe(400);
    expect((await peek(f, 1, "&after=0")).status).toBe(400);
    expect((await call(f.tenant, "/channels/work/messages?processingReader=x", f.token)).status).toBe(400);
    expect((await call(f.tenant, `${P}/claim`, f.token, "POST", { expectGeneration: -1 })).status).toBe(400);
    expect((await call(f.tenant, P, "x".repeat(40))).status).toBe(401);
  });
  it("lets a key bound to a name claim, take over or commit only that name's reader", async () => {
    const ADMIN = "test-admin-secret-000000000000000000000";
    const tenant = `proc-bound-${crypto.randomUUID()}`;
    const admin = (suffix: string, input?: unknown) =>
      exports.default.fetch(`https://msn.test/api/admin/tenants/${tenant}${suffix}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
        ...(input ? { body: JSON.stringify(input) } : {}),
      });
    const created = await admin("", {});
    const owner = await created.json<{ token: string }>();
    expect(created.status, JSON.stringify(owner)).toBe(201);
    expect((await call(tenant, "/channels/work", owner.token, "PUT")).status).toBe(201);
    const alice = await (await admin("/keys/alice", { username: "alice" })).json<{ token: string }>();
    const bob = { tenant, token: owner.token };
    const bobPath = "/channels/work/processing/bob";
    expect((await call(tenant, `${bobPath}/claim`, bob.token, "POST", { expectGeneration: 0 })).status).toBe(
      201,
    );
    // Alice's key cannot take over (and so fence) bob's agent, nor commit for it.
    for (const [suffix, input] of [
      ["claim", { expectGeneration: 1 }],
      ["commit", { generation: 1, through: 0 }],
    ] as const) {
      const refused = await call(tenant, `${bobPath}/${suffix}`, alice.token, "POST", input);
      expect(refused.status).toBe(403);
      expect((await refused.json<ErrorBody>()).error.code).toBe("username_bound");
    }
    expect(await (await call(tenant, bobPath, alice.token)).json<Cursor>()).toMatchObject({ generation: 1 });
    for (const reader of ["alice", "alice%2Fworker-2"])
      expect(
        (
          await call(tenant, `/channels/work/processing/${reader}/claim`, alice.token, "POST", {
            expectGeneration: 0,
          })
        ).status,
      ).toBe(201);
    // `alice/…` is alice's namespace, not a prefix match on another name.
    expect(
      (
        await call(tenant, "/channels/work/processing/alicex/claim", alice.token, "POST", {
          expectGeneration: 0,
        })
      ).status,
    ).toBe(403);
  });
});
