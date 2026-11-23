import { exports } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { agentMcp, type BoardRef, channelInvitation } from "../src/remote-mcp";
import { fixtureAgent, type Ticket } from "./fixtures/remote-agent";

const origin = "https://msn.test";
const endpoint = `${origin}/mcp`;
const worker = (req: Request) => exports.default.fetch(req);
const ownerCall = (tenant: string, path: string, token: string, method: string, data?: object) =>
  worker(
    new Request(`${origin}/api/tenants/${tenant}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      ...(data ? { body: JSON.stringify(data) } : {}),
    }),
  );

async function workspace() {
  const tenant = `remote-${crypto.randomUUID()}`;
  const res = await ownerCall(tenant, "", "", "PUT", { username: "Owner", channel: "chat" });
  expect(res.status).toBe(201);
  const { token } = await res.json<{ token: string }>();
  return {
    tenant,
    channel: "chat",
    token,
    async invite(channel?: string, watch?: boolean) {
      const response = await ownerCall(tenant, "/invites", token, "POST", { channel, watch, maxUses: 1 });
      expect(response.status).toBe(201);
      return response.json<{ url: string; code: string }>();
    },
  };
}

function fixture(name = "Ada") {
  const actor = { id: crypto.randomUUID(), name };
  const credential = crypto.randomUUID();
  const grants = new Map<string, Ticket>();
  const index = (board: BoardRef) => `${board.tenant}/${board.channel}`;
  let enabled = true;
  const authenticate = vi.fn(async (req: Request) => {
    if (!enabled || req.headers.get("Authorization") !== `Bearer ${credential}`)
      return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    return fixtureAgent(
      actor,
      {
        async get(ref) {
          return grants.get(index(ref));
        },
        async put(member) {
          grants.set(index(member), member);
        },
        async list() {
          return [...grants.values()];
        },
      },
      origin,
      worker,
    );
  });
  return {
    actor,
    credential,
    grants,
    authenticate,
    revoke: () => {
      enabled = false;
    },
    async connect(mode: "legacy" | "auto" = "auto") {
      const client = new Client(
        { name: "independent-harness", version: "1" },
        { versionNegotiation: { mode } },
      );
      const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${credential}` } },
        fetch: (input, init) =>
          agentMcp(new Request(input instanceof Request ? input : String(input), init), origin, authenticate),
      });
      await client.connect(transport, { timeout: 4000 });
      return client;
    },
  };
}

async function call(client: Client, name: string, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(
    result.isError,
    result.content[0]?.type === "text" ? result.content[0].text : "tool result",
  ).not.toBe(true);
  const data = result.structuredContent;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Expected a tool result object");
  return data as Record<string, unknown>;
}
const denied = async (client: Client, name: string, args: Record<string, unknown>, code: string) => {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ error: { code } });
};

describe("host-neutral remote MCP data plane (test-only resolver)", () => {
  it("negotiates two MCP revisions, joins once, reads and replies after reconnect, without repeating the reply", async () => {
    const w = await workspace();
    const board = { tenant: w.tenant, channel: w.channel };
    const actor = fixture();
    let client = await actor.connect("legacy");
    try {
      expect(await call(client, "whoami")).toEqual(actor.actor);
      expect(await call(client, "list_channels")).toEqual({ channels: [] });
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names.sort()).toEqual(["join_channel", "list_channels", "read_messages", "send", "whoami"]);
      await denied(client, "read_messages", board, "channel_unavailable");
      const invite = await w.invite(w.channel);
      expect(await call(client, "join_channel", { invitation: invite.url })).toEqual({
        ...board,
        watchOnly: false,
      });
      const ref = await ownerCall(w.tenant, "/channels/chat/messages", w.token, "POST", {
        username: "Owner",
        text: "Please review",
        to: "Ada",
      });
      expect(ref.status).toBe(201);
      const {
        message: { id },
      } = await ref.json<{ message: { id: number } }>();
      await client.close();
      client = await actor.connect("auto");
      expect(client.getDiscoverResult()?.supportedVersions).toContain("2026-07-28");
      expect(await call(client, "list_channels")).toEqual({ channels: [{ ...board, watchOnly: false }] });
      expect(await call(client, "read_messages", board)).toMatchObject({
        messages: [{ id, to: "Ada" }],
        nextCursor: id,
      });
      const input = { ...board, text: "Reviewed", to: "Owner", replyTo: id, key: "review-1" };
      const answer = await call(client, "send", input);
      expect(answer).toMatchObject({ message: { username: "Ada", replyTo: id }, replayed: false });
      await client.close();
      client = await actor.connect("legacy");
      expect(await call(client, "send", input)).toEqual({ ...answer, replayed: true });
      await denied(client, "send", { ...input, text: "Changed" }, "idempotency_conflict");
      const history = await ownerCall(w.tenant, "/channels/chat/messages", w.token, "GET");
      expect((await history.json<{ messages: unknown[] }>()).messages).toHaveLength(2);
      const other = fixture("Ada");
      const sameName = await other.connect();
      try {
        expect(await call(sameName, "list_channels")).toEqual({ channels: [] });
        await denied(sameName, "read_messages", board, "channel_unavailable");
      } finally {
        await sameName.close();
      }
      actor.revoke();
      await expect(call(client, "read_messages", board)).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it("the tenant refuses workspace invites BEFORE spending them; watch-only and archived channels stay read-only", async () => {
    const w = await workspace();
    const ref = { tenant: w.tenant, channel: w.channel };
    const scope = await w.invite();
    const actor = fixture();
    const c = await actor.connect();
    try {
      await denied(c, "join_channel", { invitation: scope.code }, "channel_invite_required");
      expect(await call(c, "list_channels")).toEqual({ channels: [] });
      const redeem = await ownerCall(w.tenant, "/invites/redeem", "", "POST", {
        username: "Legacy member",
        code: scope.code,
      });
      expect(redeem.status).toBe(201);
      const watch = await w.invite(w.channel, true);
      expect(await call(c, "join_channel", { invitation: watch.code })).toEqual({ ...ref, watchOnly: true });
      expect(await call(c, "read_messages", ref)).toMatchObject({ messages: [] });
      const post = { ...ref, key: "not-posted", text: "no write" };
      await denied(c, "send", post, "watch_only");
      await denied(c, "read_messages", { ...ref, channel: "not-mine" }, "channel_unavailable");
      const fresh = await w.invite(w.channel);
      await call(c, "join_channel", { invitation: fresh.code });
      expect((await ownerCall(w.tenant, "/channels/chat/archive", w.token, "PUT")).ok).toBe(true);
      await denied(c, "send", post, "board_archived");
      expect((await ownerCall(w.tenant, "/channels/chat?confirm=chat", w.token, "DELETE")).ok).toBe(true);
      expect((await ownerCall(w.tenant, "/channels/chat", w.token, "PUT", {})).ok).toBe(true);
      await denied(c, "read_messages", ref, "channel_unavailable");
    } finally {
      await c.close();
    }
  });

  it("separates same-named channels in different workspaces; removing one membership does not affect the other", async () => {
    const [a, b] = await Promise.all([workspace(), workspace()]);
    const actor = fixture();
    const c = await actor.connect();
    try {
      for (const w of [a, b]) await call(c, "join_channel", { invitation: (await w.invite("chat")).url });
      expect((await call(c, "list_channels"))?.channels).toHaveLength(2);
      actor.grants.delete(`${a.tenant}/chat`);
      await denied(c, "read_messages", { tenant: a.tenant, channel: "chat" }, "channel_unavailable");
      expect(await call(c, "read_messages", { tenant: b.tenant, channel: "chat" })).toMatchObject({
        messages: [],
      });
      const forged = await c.callTool({
        name: "send",
        arguments: { tenant: b.tenant, channel: "chat", text: "no", key: "a", username: "Owner" },
      });
      expect(forged.isError).toBe(true);
    } finally {
      await c.close();
    }
  });

  it("bounds a page without losing the next message and refuses reads after the scoped key is revoked", async () => {
    const w = await workspace();
    const ref = { tenant: w.tenant, channel: "chat" };
    const actor = fixture();
    const c = await actor.connect();
    try {
      await call(c, "join_channel", { invitation: (await w.invite("chat")).code });
      for (const ch of ["a", "b", "c"]) {
        expect(
          (
            await ownerCall(w.tenant, "/channels/chat/messages", w.token, "POST", {
              username: "Owner",
              text: ch.repeat(16000),
            })
          ).status,
        ).toBe(201);
      }
      const page = await call(c, "read_messages", { ...ref, limit: 3 });
      const rows = page.messages as { id: number }[];
      expect(page.hasMore).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(3);
      expect(page.nextCursor).toBe(rows.at(-1)?.id);
      const next = await call(c, "read_messages", { ...ref, after: page.nextCursor });
      const tail = next.messages as { id: number }[];
      expect(tail.length + rows.length).toBe(3);
      expect(tail[0].id).toBeGreaterThan(rows[rows.length - 1].id);
      const ticket = actor.grants.get(`${w.tenant}/chat`);
      expect(ticket).toBeDefined();
      const revoked = await exports.default.fetch(
        `${origin}/api/admin/tenants/${w.tenant}/keys/${ticket?.keyId}`,
        {
          method: "DELETE",
          headers: { Authorization: "Bearer test-admin-secret-000000000000000000000" },
        },
      );
      expect(revoked.status).toBe(204);
      await denied(c, "read_messages", ref, "channel_unavailable");
      await denied(c, "send", { ...ref, key: "with-revoked-key", text: "no post" }, "channel_unavailable");
    } finally {
      await c.close();
    }
  });

  it("will not accept an alternate origin, credentials in a URL or a transport session as authorization", async () => {
    const { authenticate } = fixture();
    for (const [url, originHeader, status] of [
      [endpoint, "https://elsewhere.invalid", 403],
      [endpoint, "null", 403],
      [`${endpoint}?access_token=not-allowed`, "", 404],
      ["https://elsewhere.invalid/mcp", "", 404],
    ] as const) {
      const res = await agentMcp(
        new Request(url, { headers: originHeader ? { Origin: originHeader } : {} }),
        origin,
        authenticate,
      );
      expect(res.status).toBe(status);
    }
    expect(authenticate).not.toHaveBeenCalled();
    for (const method of ["POST", "GET", "DELETE"]) {
      const res = await agentMcp(
        new Request(endpoint, { method, headers: { "Mcp-Session-Id": "not-a-user" } }),
        origin,
        authenticate,
      );
      expect(res.status).toBe(401);
    }
  });

  it("only accepts a private invite from the configured server; rejects shared connections without echoing them", () => {
    const code = `my-team.${"a".repeat(64)}`;
    expect(channelInvitation(code, origin)).toEqual({ tenant: "my-team", code });
    expect(channelInvitation(`${origin}/#invite=${code}`, origin)).toEqual({ tenant: "my-team", code });
    for (const url of [
      `https://elsewhere.invalid/#invite=${code}`,
      `${origin}/#board=${code}`,
      `${origin}/#account=${code}`,
      `${origin}/#invite=${code}&invite=${code}`,
      `${origin}/?invite=${code}`,
      `https://u@msn.test/#invite=${code}`,
      `${origin}/extra#invite=${code}`,
    ]) {
      expect(() => channelInvitation(url, origin)).toThrowError(
        /^Use a channel invitation from this MSN server\.$/,
      );
    }
  });
});
