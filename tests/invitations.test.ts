import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ADMIN = "test-admin-secret-000000000000000000000";
const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(input ? { "Content-Type": "application/json" } : {}),
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
type Access = { tenant: string; token: string; username: string; channel?: string; keyId?: string };
type Invite = { id: string; code: string; url: string; expiresAt: string; channel: string | null };
async function workspace() {
  const tenant = `invite-${crypto.randomUUID()}`;
  const result = await call(tenant, "", undefined, "PUT", { username: "owner" });
  expect(result.status).toBe(201);
  return result.json<Access>();
}
async function invite(access: Access, input: Record<string, unknown> = { channel: "general" }) {
  const result = await call(access.tenant, "/invites", access.token, "POST", input);
  expect(result.status).toBe(201);
  return result.json<Invite>();
}
async function join(tenant: string, code: string, username = "lead-agent") {
  return call(tenant, "/invites/redeem", undefined, "POST", { code, username });
}
const stub = (tenant: string) => env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant]));

describe("self-service access", () => {
  it("migrates v7 keys and history in place before issuing scoped keys", async () => {
    const owner = await workspace();
    const before = await invite(owner, {});
    const member = await (await join(owner.tenant, before.code)).json<Access>();
    await call(owner.tenant, "/channels/general/messages", member.token, "POST", {
      username: member.username,
      text: "Before migration",
    });
    await runInDurableObject(stub(owner.tenant), (_, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("DROP TABLE invites");
        state.storage.sql.exec("ALTER TABLE access_keys DROP COLUMN channel_scope");
        state.storage.sql.exec("DELETE FROM schema_version WHERE version = 8");
      });
    });
    await abortAllDurableObjects();
    expect((await call(owner.tenant, "", member.token)).status).toBe(200);
    const channels = await (await call(owner.tenant, "/channels", member.token)).json<{
      channels: unknown[];
    }>();
    expect(channels.channels).toEqual([expect.objectContaining({ messageCount: 1 })]);
    const after = await invite(member);
    const scoped = await (await join(owner.tenant, after.code)).json<Access>();
    expect(scoped.channel).toBe("general");
    expect((await call(owner.tenant, "/channels/other", scoped.token, "PUT")).status).toBe(403);
  });

  it("does not consume an invitation on validation or participant quota failure", async () => {
    const owner = await workspace();
    const link = await invite(owner, { channel: "general", maxUses: 1 });
    expect((await join(owner.tenant, link.code, " ")).status).toBe(400);
    await runInDurableObject(stub(owner.tenant), (_, state) => {
      state.storage.transactionSync(() => {
        for (let index = 0; index < 1000; index++)
          state.storage.sql.exec(
            "INSERT INTO access_keys (id, token_hash, bound_username, createdAt) VALUES (?, ?, ?, ?)",
            `key-${index}`,
            `hash-${index}`,
            `agent-${index}`,
            new Date().toISOString(),
          );
      });
    });
    expect((await join(owner.tenant, link.code)).status).toBe(409);
    await runInDurableObject(stub(owner.tenant), (_, state) => {
      state.storage.sql.exec("DELETE FROM access_keys WHERE id = 'key-0'");
    });
    expect((await join(owner.tenant, link.code)).status).toBe(201);
  });

  it("creates atomically without an admin and never replaces an existing owner", async () => {
    const tenant = `race-${crypto.randomUUID()}`;
    const results = await Promise.all(
      ["alice", "bob"].map((username) => call(tenant, "", undefined, "PUT", { username, channel: "work" })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const created = results.find((r) => r.status === 201);
    if (!created) throw new Error("No workspace created");
    const owner = await created.json<Access>();
    expect((await call(tenant, "", owner.token)).status).toBe(200);
    const channels = await (await call(tenant, "/channels", owner.token)).json<{ channels: unknown[] }>();
    expect(channels.channels).toEqual([
      expect.objectContaining({ name: "work", messageCount: 0, participantCount: 0, lastActivityAt: null }),
    ]);
    expect((await call(tenant, "", undefined, "PUT", { username: "intruder" })).status).toBe(409);
    const invalid = `bad-${crypto.randomUUID()}`;
    expect((await call(invalid, "", undefined, "PUT", { username: " " })).status).toBe(400);
    expect((await call(invalid, "", undefined, "PUT", { username: "valid" })).status).toBe(201);
  });

  it("issues independent channel keys and permits agents to invite within the same scope", async () => {
    const owner = await workspace();
    await call(owner.tenant, "/channels/private", owner.token, "PUT");
    const link = await invite(owner);
    expect(link.url).toBe(`https://msn.test/#invite=${link.code}`);
    expect(link.url).not.toContain(owner.token);
    const alice = await (await join(owner.tenant, link.code)).json<Access>();
    const bob = await (await join(owner.tenant, link.code, "worker-agent")).json<Access>();
    expect(new Set([owner.token, alice.token, bob.token]).size).toBe(3);
    expect(alice.channel).toBe("general");
    const sent = await call(owner.tenant, "/channels/general/messages", alice.token, "POST", {
      username: "lead-agent",
      text: "Hello",
    });
    expect(sent.status).toBe(201);
    expect(
      (
        await call(owner.tenant, "/channels/general/messages", alice.token, "POST", {
          username: "owner",
          text: "Impersonation",
        })
      ).status,
    ).toBe(403);
    for (const [suffix, method, input] of [
      ["/channels/private/messages", "GET"],
      ["/channels/private/messages/1", "GET"],
      ["/channels/private/catchup", "GET"],
      ["/channels/private/snapshots", "GET"],
      ["/channels/private/snapshots/1", "GET"],
      ["/channels/new", "PUT"],
      ["/channels/new/messages", "POST", { username: "lead-agent", text: "no" }],
      ["/invites", "POST", {}],
      ["/invites", "POST", { channel: "private" }],
    ] as const)
      expect((await call(owner.tenant, suffix, alice.token, method, input)).status, suffix).toBe(403);
    const listing = await (await call(owner.tenant, "/channels", alice.token)).json<{
      channels: unknown[];
    }>();
    expect(listing.channels).toEqual([
      expect.objectContaining({
        name: "general",
        messageCount: 1,
        participantCount: 1,
        lastActivityAt: expect.any(String),
      }),
    ]);
    const downstream = await invite(alice);
    expect((await join(owner.tenant, downstream.code, "third-agent")).status).toBe(201);
    const other = await workspace();
    expect((await call(other.tenant, "/channels", alice.token)).status).toBe(401);
    await runInDurableObject(stub(owner.tenant), (_, state) => {
      const rows = JSON.stringify(state.storage.sql.exec("SELECT * FROM invites").toArray());
      expect(rows).not.toContain(link.code.split(".")[1]);
      expect(rows).not.toContain(owner.token);
    });
  });

  it("workspace invitations allow channel creation and broader delegation", async () => {
    const owner = await workspace();
    const link = await invite(owner, {});
    const participant = await (await join(owner.tenant, link.code)).json<Access>();
    expect(participant.channel).toBeUndefined();
    expect((await call(owner.tenant, "/channels/new", participant.token, "PUT")).status).toBe(201);
    expect((await invite(participant, {})).channel).toBeNull();
  });

  it("enforces use limits atomically, expiration and validation", async () => {
    const owner = await workspace();
    const link = await invite(owner, { channel: "general", maxUses: 1 });
    const results = await Promise.all([join(owner.tenant, link.code), join(owner.tenant, link.code)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 410]);
    const expiring = await invite(owner);
    await runInDurableObject(stub(owner.tenant), (_, state) => {
      state.storage.sql.exec("UPDATE invites SET expiresAt = 0");
    });
    expect((await join(owner.tenant, expiring.code)).status).toBe(410);
    expect((await join(owner.tenant, "invalid")).status).toBe(400);
    for (const input of [
      { maxUses: 0 },
      { maxUses: 101 },
      { maxUses: "1" },
      { expiresIn: 59 },
      { expiresIn: 604801 },
    ])
      expect((await call(owner.tenant, "/invites", owner.token, "POST", input)).status).toBe(400);
    expect((await call(owner.tenant, "/invites", undefined, "POST", {})).status).toBe(401);
    expect((await call(owner.tenant, "/invites", owner.token, "POST", { channel: "missing" })).status).toBe(
      404,
    );
    const origin = await exports.default.fetch(
      `https://msn.test/api/tenants/${owner.tenant}/invites/redeem`,
      {
        method: "POST",
        headers: { Origin: "https://evil.test", "Content-Type": "application/json" },
        body: JSON.stringify({ code: link.code, username: "evil" }),
      },
    );
    expect(origin.status).toBe(403);
  });

  it("revokes links, rejects a revoked inviter and invalidates all invites on rotation", async () => {
    const owner = await workspace();
    const link = await invite(owner);
    const participant = await (await join(owner.tenant, link.code)).json<Access>();
    expect((await call(owner.tenant, `/invites/${link.id}`, participant.token, "DELETE")).status).toBe(404);
    expect((await call(owner.tenant, `/invites/${link.id}`, owner.token, "DELETE")).status).toBe(204);
    expect((await join(owner.tenant, link.code)).status).toBe(410);
    expect((await call(owner.tenant, "", participant.token)).status).toBe(200);
    const downstream = await invite(participant);
    await exports.default.fetch(
      `https://msn.test/api/admin/tenants/${owner.tenant}/keys/${participant.keyId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN}` } },
    );
    expect((await join(owner.tenant, downstream.code)).status).toBe(410);
    const reset = await invite(owner);
    await exports.default.fetch(`https://msn.test/api/admin/tenants/${owner.tenant}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect((await join(owner.tenant, reset.code)).status).toBe(410);
  });
});
