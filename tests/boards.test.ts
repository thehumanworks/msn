import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
type Connection = { tenant: string; token: string };
async function fixture() {
  const tenant = `board-${crypto.randomUUID()}`;
  const owner = await (await call(tenant, "", undefined, "PUT", { username: "human" })).json<Connection>();
  const token = "b".repeat(64);
  expect(
    (
      await call(tenant, "/channels/work/board", owner.token, "PUT", {
        credential: token,
        goal: "Finish the review",
      })
    ).status,
  ).toBe(201);
  return { tenant, owner: owner.token, token };
}
describe("account-owned agent message boards", () => {
  it("shares one scoped credential across unique personas, including after restart", async () => {
    const f = await fixture();
    const identity = await (await call(f.tenant, "", f.token)).json();
    expect(identity).toMatchObject({ sharedChannel: true, channel: "work", username: null });
    for (const [id, displayName] of [
      ["p1", "lead"],
      ["p2", "reviewer"],
    ]) {
      expect(
        (await call(f.tenant, `/channels/work/personas/${id}`, f.token, "PUT", { displayName })).status,
      ).toBe(201);
      const sent = await (
        await call(f.tenant, "/channels/work/messages", f.token, "POST", {
          username: displayName,
          text: "hello",
        })
      ).json();
      expect(sent).toMatchObject({ message: { personaId: id, username: displayName } });
    }
    await abortAllDurableObjects();
    expect(
      (await (await call(f.tenant, "/channels/work/personas", f.token)).json<{ personas: unknown[] }>())
        .personas,
    ).toHaveLength(2);
    expect((await call(f.tenant, "/channels/other", f.token, "PUT")).status).toBe(403);
    expect((await call(f.tenant, "/channels/other/personas", f.token)).status).toBe(403);
    expect(
      (
        await call(f.tenant, "/channels/other/board", f.token, "PUT", {
          credential: "c".repeat(64),
          goal: "escape",
        })
      ).status,
    ).toBe(403);
    expect((await call(f.tenant, "/invites", f.token, "POST", { channel: "work" })).status).toBe(400);
    const channels = await (await call(f.tenant, "/channels", f.token)).json<{
      channels: { name: string }[];
    }>();
    expect(channels.channels.map((c) => c.name)).toEqual(["work"]);
  });
  it("owner sees all boards from another client and can recover or rotate channel access", async () => {
    const f = await fixture();
    const recovered = await (
      await call(f.tenant, "/channels/work/board/connection", f.owner)
    ).json<Connection>();
    expect(recovered.token).toBe(f.token);
    expect(
      (await call(f.tenant, "/channels/work/board/rotate", f.token, "POST", { credential: "c".repeat(64) }))
        .status,
    ).toBe(403);
    expect(
      (await call(f.tenant, "/channels/work/board/rotate", f.owner, "POST", { credential: "c".repeat(64) }))
        .status,
    ).toBe(200);
    expect((await call(f.tenant, "", f.token)).status).toBe(401);
    expect((await call(f.tenant, "", "c".repeat(64))).status).toBe(200);
    expect((await call(f.tenant, "/channels", f.owner)).status).toBe(200);
  });
  it("goals are revisioned and changes wake blocked message reads", async () => {
    const f = await fixture();
    const waiting = call(f.tenant, "/channels/work/messages?after=0&wait=25", f.token);
    expect(
      (await call(f.tenant, "/channels/work/board", f.token, "POST", { revision: 1, status: "paused" }))
        .status,
    ).toBe(200);
    const page = await (await waiting).json<{ messages: { text: string }[] }>();
    expect(JSON.parse(page.messages[0].text)).toMatchObject({ schema: "msn.board.v1", status: "paused" });
    expect(
      (await call(f.tenant, "/channels/work/board", f.token, "POST", { revision: 1, status: "complete" }))
        .status,
    ).toBe(409);
  });
  it("goal notifications stay within the message wire limit even for escaped content", async () => {
    const f = await fixture();
    const goal = "\u0001".repeat(3000);
    expect(
      (await call(f.tenant, "/channels/work/board", f.token, "POST", { revision: 1, goal })).status,
    ).toBe(200);
    const page = await (await call(f.tenant, "/channels/work/messages", f.token)).json<{
      messages: { text: string }[];
    }>();
    expect(new TextEncoder().encode(page.messages[0].text).length).toBeLessThanOrEqual(16384);
    expect(
      (await (await call(f.tenant, "/channels/work/board", f.token)).json<{ board: { goal: string } }>())
        .board.goal,
    ).toBe(goal);
  });

  it("reserves SSO accounts and never trusts an asserted user without a configured verifier", async () => {
    expect((await call("account-forged", "", undefined, "PUT", { username: "human" })).status).toBe(403);
    const response = await exports.default.fetch("https://msn.test/api/account/login", {
      method: "POST",
      headers: { "Cf-Access-Authenticated-User-Email": "someone@example.com" },
    });
    expect(response.status).toBe(503);
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", "account-test"]));
    const first = await stub.accountSession("account-test", "human");
    await call("account-test", "/channels/a", first.token, "PUT");
    const second = await stub.accountSession("account-test", "human");
    expect(first.token).not.toBe(second.token);
    expect((await call("account-test", "/channels", second.token)).status).toBe(200);
    await runInDurableObject(stub, (_, state) =>
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM tenant").one().n).toBe(1),
    );
  });
});
