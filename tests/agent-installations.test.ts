/** End-to-end Worker, SQLite DOs, local OAuth KV and real MCP SDK. No network fetch, model,
 * production account or provider is used. The authority URL names only the in-process Worker. */
import { abortAllDurableObjects, createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  auth,
  Client,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const origin = "https://msn.thehuman.sh";
const endpoint = `${origin}/mcp`;
const local = async (input: Request | string | URL, init?: RequestInit) => {
  const req = new Request(input instanceof Request ? input : String(input), init);
  if (new URL(req.url).origin !== origin) throw new Error("No external requests in this suite");
  return exports.default.fetch(req);
};
const request = (path: string, key = "", method = "GET", data?: object, extra?: HeadersInit) =>
  local(origin + path, {
    method,
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...extra,
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
async function obj<T>(r: Promise<Response>) {
  const res = await r;
  expect(res.status, res.ok ? "" : `MSN request refused (${res.status})`).toBeLessThan(300);
  return res.json<T>();
}
type User = { id: string; name: string };
type Install = { id: string; token: string };
async function workspace() {
  const tenant = `operator-${crypto.randomUUID()}`;
  const path = `/api/tenants/${tenant}`;
  const { token } = await obj<{ token: string }>(
    request(path, "", "PUT", { channel: "chat", username: "Owner" }),
  );
  const call = (sub: string, method = "GET", data?: object) => request(path + sub, token, method, data);
  return {
    tenant,
    path,
    token,
    call,
    ref: { tenant, channel: "chat" },
    agent: async (name = "Review") => (await obj<{ agent: User }>(call("/agents", "POST", { name }))).agent,
    install: (id: string, label: string) =>
      obj<Install>(call(`/agents/${id}/installations`, "POST", { label })),
    invite: (channel?: string, watch = false, maxUses = 1) =>
      obj<{ code: string }>(call("/invites", "POST", { channel, watch, maxUses })),
  };
}
async function client(key: string) {
  const c = new Client({ name: "portable-host", version: "1" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
      fetch: local,
    }),
  );
  return c;
}
async function tool(c: Client, name: string, args = {}, error?: string) {
  const r = await c.callTool({ name, arguments: args });
  if (error) expect(r.structuredContent).toMatchObject({ error: { code: error } });
  else expect(r.isError).not.toBe(true);
  return r.structuredContent;
}
type Owner = Awaited<ReturnType<typeof workspace>>;
const members = "/channels/chat/members";
const join = (w: Owner, u: User, invitation: string, action = "join") =>
  w.call(`/agents/${u.id}/invitations`, "POST", { invitation, action });
describe("owner-installed MSN connector", () => {
  it("bounds public registration writes before allocating OAuth records without throttling existing installations", async () => {
    const shard = env.MSN_DURABLE_OBJECT.getByName(
      JSON.stringify(["oauth-budget-test", crypto.randomUUID()]),
    );
    for (let n = 0; n < 12; n++) expect(await shard.connectorPublicBudget("register", "a")).toBe(0);
    expect(await shard.connectorPublicBudget("register", "a")).toBeGreaterThan(0);
    expect(await shard.connectorPublicBudget("consent", "a")).toBe(0);
    expect(await shard.connectorPublicBudget("register", "b")).toBe(0);
  });
  it("a deployment without OAuth advertises only a bearer challenge, never a fake sign-in flow", async () => {
    const noOAuth = { ...env, OAUTH_KV: undefined };
    for (const path of [
      "/oauth/register",
      "/oauth/authorize",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const r = await worker.fetch(new Request(origin + path), noOAuth, createExecutionContext());
      expect(r.status).toBe(404);
    }
    const r = await worker.fetch(new Request(endpoint), noOAuth, createExecutionContext());
    expect(r.status).toBe(401);
    expect(r.headers.get("WWW-Authenticate")).not.toContain("resource_metadata");
    expect(
      (await worker.fetch(new Request("https://alias.test/mcp"), noOAuth, createExecutionContext())).status,
    ).toBe(404);
  });
  it("resets installations and rejects identity fields supplied to the ordinary names-based REST API", async () => {
    const w = await workspace(),
      u = await w.agent();
    const i = await w.install(u.id, "Reset this host");
    expect((await w.call(`${members}/${u.id}`, "PUT", {})).ok).toBe(true);
    const legacy = await obj<{ message: { agentUserId?: string } }>(
      w.call("/channels/chat/messages", "POST", {
        username: "Owner",
        text: "Legacy post",
        agentUserId: u.id,
      }),
    );
    expect(legacy.message.agentUserId).toBeUndefined();
    const shared = "d".repeat(64);
    await w.call("/channels/chat/board", "PUT", { credential: shared, goal: "Roles" });
    expect((await request(`${w.path}/agents`, shared)).status).toBe(403);
    expect((await request("/mcp", shared)).status).toBe(401);
    expect(
      (
        await request(
          `/api/admin/tenants/${w.tenant}/token`,
          "test-admin-secret-000000000000000000000",
          "POST",
        )
      ).ok,
    ).toBe(true);
    expect((await request("/mcp", i.token)).status).toBe(401);
  });
  it("human completes setup while agent is offline; separate clients retain identity, membership and idempotent replies", async () => {
    const [a, b] = await Promise.all([workspace(), workspace()]);
    const u = await a.agent();
    expect((await b.call(`${members}/${u.id}`, "PUT", {})).status).toBe(404); // public ID alone is not an invitation
    expect((await a.call(`${members}/${u.id}`, "PUT", {})).ok).toBe(true);
    const code = (await b.invite("chat")).code;
    expect(await obj(join(a, u, code, "preview"))).toMatchObject(b.ref);
    const twice = await Promise.all([join(a, u, code), join(a, u, code)]);
    expect(twice.map((r) => r.status)).toEqual([200, 200]);
    const [i, j] = await Promise.all([a.install(u.id, "Host A"), a.install(u.id, "Host B")]);
    const meta = await (await a.call(`/agents/${u.id}`)).text();
    expect(meta).not.toContain(i.token);
    expect(meta).not.toContain(j.token);
    expect((await request(`${a.path}/agents`, i.token)).status).toBe(401);
    expect((await request("/mcp", a.token)).status).toBe(401);
    let c = await client(i.token);
    try {
      expect(await tool(c, "whoami")).toEqual(u);
      expect(await tool(c, "list_channels")).toMatchObject({
        channels: [
          { ...a.ref, watchOnly: false },
          { ...b.ref, watchOnly: false },
        ],
      });
      await tool(c, "read_messages", b.ref);
    } finally {
      await c.close();
    }
    await abortAllDurableObjects(); // New Worker-side object instances, same durable data.
    c = await client(j.token);
    const send = { ...b.ref, text: "Read and reviewed", key: "reply" };
    try {
      expect(await tool(c, "whoami")).toEqual(u);
      expect(await tool(c, "send", send)).toMatchObject({
        message: { username: "Review", agentUserId: u.id },
        replayed: false,
      });
      expect(await tool(c, "send", send)).toMatchObject({ replayed: true });
      const { messages } = await obj<{ messages: Array<{ id: number; agentUserId: string }> }>(
        b.call("/channels/chat/messages"),
      );
      expect(messages).toHaveLength(1);
      expect(messages[0].agentUserId).toBe(u.id);
      await a.call(`/agents/${u.id}/installations/${i.id}`, "DELETE");
      expect((await request("/mcp", i.token)).status).toBe(401);
      expect(await tool(c, "whoami")).toEqual(u); // another installation is untouched
      await b.call(`${members}/${u.id}`, "DELETE");
      await tool(c, "read_messages", b.ref, "channel_unavailable");
      expect((await join(a, u, code)).status).toBe(403);
      expect(await tool(c, "list_channels")).toMatchObject({ channels: [{ ...a.ref, watchOnly: false }] });
      await a.call(`/agents/${u.id}/installations/${j.id}`, "DELETE");
      expect((await request("/mcp", j.token)).status).toBe(401);
    } finally {
      await c.close();
    }
  });
  it("enforces specific operator-approved invites, owner, archive, watcher and board generation boundaries", async () => {
    const [a, b] = await Promise.all([workspace(), workspace()]);
    const u = await a.agent("Atlas"),
      other = await a.agent("Atlas");
    const i = await a.install(u.id, "Watcher host");
    const c = await client(i.token);
    try {
      const workspaceInvite = (await b.invite()).code;
      expect((await join(a, u, workspaceInvite)).status).toBe(400);
      expect(
        (await request(`${b.path}/invites/redeem`, "", "POST", { username: "Member", code: workspaceInvite }))
          .status,
      ).toBe(201);
      const invite = (await b.invite("chat", true)).code;
      await tool(c, "join_channel", { invitation: invite }, "operator_approval_required");
      expect((await join(a, u, invite, "approve")).ok).toBe(true);
      expect(await tool(c, "join_channel", { invitation: invite })).toMatchObject({
        ...b.ref,
        watchOnly: true,
      });
      expect(await tool(c, "join_channel", { invitation: invite })).toMatchObject({
        ...b.ref,
        watchOnly: true,
      });
      expect(await obj(join(a, u, (await b.invite("chat")).code))).toMatchObject({ watchOnly: true });
      await tool(c, "send", { ...b.ref, key: "x", text: "No" }, "watch_only");
      await a.call(`${members}/${u.id}`, "PUT", {});
      await a.call(`${members}/${other.id}`, "PUT", {});
      const d = await client((await a.install(other.id, "Other user")).token);
      try {
        for (const s of [c, d])
          expect(await tool(s, "send", { ...a.ref, text: "same", key: "same" })).toMatchObject({
            replayed: false,
          });
      } finally {
        await d.close();
      }
      const { messages } = await obj<{ messages: Array<{ id: number; agentUserId: string }> }>(
        a.call("/channels/chat/messages"),
      );
      expect(messages.map((m) => m.agentUserId)).toEqual([u.id, other.id]);
      const guest = await obj<{ token: string }>(
        request(`${a.path}/invites/redeem`, "", "POST", {
          username: "Atlas",
          code: (await a.invite("chat")).code,
        }),
      );
      for (const [path, method, data] of [
        ["/agents", "GET", undefined],
        ["/agents", "POST", { name: "Not mine" }],
        [`${members}/${u.id}`, "DELETE", undefined],
      ] as const)
        expect((await request(a.path + path, guest.token, method, data)).status).toBe(403);
      expect(
        (
          await request(`${a.path}/channels/chat/messages/${messages[0].id}`, guest.token, "PATCH", {
            username: "Atlas",
            text: "changed",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(`${a.path}/channels/chat/messages`, guest.token, "POST", {
            username: "Atlas",
            text: "changed",
            replaces: messages[0].id,
          })
        ).status,
      ).toBe(403);
      await a.call("/channels/chat/archive", "PUT");
      await tool(c, "send", { ...a.ref, key: "z", text: "No" }, "board_archived");
      expect((await a.call("/channels/chat?confirm=chat", "DELETE")).ok).toBe(true);
      await a.call("/channels/chat", "PUT", {});
      await tool(c, "read_messages", a.ref, "channel_unavailable");
      await tool(c, "read_messages", b.ref);
    } finally {
      await c.close();
    }
  });
  it("the SDK discovers OAuth, registers, exchanges S256 with human consent, refreshes and stops after disconnect", async () => {
    const w = await workspace(),
      u = await w.agent();
    await w.call(`${members}/${u.id}`, "PUT", {});
    type Saved = Awaited<ReturnType<OAuthClientProvider["tokens"]>>;
    let tokens: Saved,
      info: Awaited<ReturnType<OAuthClientProvider["clientInformation"]>>,
      redirect: URL | undefined,
      verifier = "";
    const cb = "https://host.example/complete";
    const provider: OAuthClientProvider = {
      redirectUrl: cb,
      clientMetadata: {
        redirect_uris: [cb],
        client_name: "Independent host",
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      },
      clientInformation: () => info,
      saveClientInformation(v) {
        info = v;
      },
      tokens: () => tokens,
      saveTokens(v) {
        tokens = v;
      },
      redirectToAuthorization(v) {
        redirect = v;
      },
      saveCodeVerifier(v) {
        verifier = v;
      },
      codeVerifier: () => verifier,
      state: () => "check-operator-state",
    };
    const opts = { serverUrl: endpoint, scope: "msn:chat offline_access", fetchFn: local };
    expect((await request("/mcp")).headers.get("WWW-Authenticate")).toContain(
      "/.well-known/oauth-protected-resource/mcp",
    );
    expect(await auth(provider, opts)).toBe("REDIRECT");
    if (!redirect) throw new Error("Expected authorization page");
    const plain = new URL(redirect);
    plain.searchParams.set("code_challenge_method", "plain");
    expect((await local(plain)).status).not.toBe(200);
    const page = await local(redirect);
    expect(page.status).toBe(200);
    const cookie = page.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    const html = await page.text();
    expect(html).toContain("host.example");
    const handle = html.match(/data-handle="([^"]+)"/)?.[1];
    expect(handle).toBeTruthy();
    const approval = { action: "approve", agent: u.id, tenant: w.tenant, handle };
    expect(
      (
        await request("/oauth/authorize", w.token, "POST", approval, {
          Origin: "https://other.example",
          Cookie: cookie,
        })
      ).status,
    ).toBe(403);
    expect((await request("/oauth/authorize", w.token, "POST", approval, { Origin: origin })).status).toBe(
      400,
    );
    const yes = await obj<{ redirectTo: string }>(
      request("/oauth/authorize", w.token, "POST", approval, { Origin: origin, Cookie: cookie }),
    );
    const back = new URL(yes.redirectTo);
    const repeated = await request("/oauth/authorize", w.token, "POST", approval, {
      Origin: origin,
      Cookie: cookie,
    });
    expect(repeated.status).toBe(400);
    expect(back.origin + back.pathname).toBe(cb);
    expect(back.searchParams.get("state")).toBe("check-operator-state");
    const code = back.searchParams.get("code"),
      issuer = back.searchParams.get("iss");
    if (!code || issuer !== origin) throw new Error("Missing or unexpected authorization callback");
    expect(
      await auth(provider, {
        ...opts,
        authorizationCode: code,
        iss: issuer,
      }),
    ).toBe("AUTHORIZED");
    const first = tokens?.access_token;
    if (!first || !tokens?.refresh_token) throw new Error("Expected offline authorization");
    const c = await client(first);
    try {
      expect(await tool(c, "whoami")).toEqual(u);
    } finally {
      await c.close();
    }
    expect(await auth(provider, opts)).toBe("AUTHORIZED");
    const second = tokens?.access_token;
    if (!second || second === first) throw new Error("Expected a new access token after refresh");
    const { installations } = await obj<{ installations: Install[] }>(w.call(`/agents/${u.id}`));
    expect(installations).toHaveLength(1);
    await w.call(`/agents/${u.id}/installations/${installations[0].id}`, "DELETE");
    for (const token of [first, second]) expect((await request("/mcp", token)).status).toBe(401);
  });
});
