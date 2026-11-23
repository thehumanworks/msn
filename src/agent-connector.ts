import { AuthorizationError, OAuthAuthorizationServer, OAuthError } from "@cloudflare/workers-oauth-provider";
import type { AgentPrincipal } from "./agent-users";
import { bearer, body, digest, HttpError, json, rawBody, slug, text } from "./http";
import { type AgentChat, agentMcp } from "./remote-mcp";
import type { Refusal } from "./store";

/** No KV binding in a header-only deployment. Never pretend it supports interactive sign-in. */
type ConnectorEnv = Env & { OAUTH_KV?: KVNamespace };
type Install = { home: string; agent: string; install: string };
const scope = "msn:chat";
const authPath = "/oauth/authorize";
const metaPath = "/.well-known/oauth-protected-resource/mcp";
const serverMeta = "/.well-known/oauth-authorization-server";
const homeStub = (env: Env, t: string) =>
  env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", slug(t)]));
function accepted<T extends object>(v: T): Exclude<T, Refusal> {
  if (v && typeof v === "object" && "refused" in v) {
    const { status, code, message } = (v as Refusal).refused;
    throw new HttpError(status, code, message);
  }
  return v as Exclude<T, Refusal>;
}
function authority(env: ConnectorEnv, origin: string) {
  const resource = `${origin}/mcp`;
  return new OAuthAuthorizationServer<ConnectorEnv>({
    issuer: origin,
    authorizeEndpoint: authPath,
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    resources: [resource],
    defaultResource: resource,
    scopesSupported: [scope, "offline_access"],
    accessTokenTTL: 900,
    refreshTokenTTL: 30 * 86400,
    refreshTokenIdleTTL: 30 * 86400,
    // No lookup of arbitrary client-provided metadata URLs. DCR covers public and confidential hosts.
    clientIdMetadataDocumentEnabled: false,
    tokenExchangeCallback: async ({ props, grantType, resource: aud, userId, requestedScope }) => {
      const grant = props as Install;
      if (
        aud !== resource ||
        grant.agent !== userId ||
        !requestedScope.includes(scope) ||
        !(await homeStub(env, grant.home).connectorExchange(
          grant.agent,
          grant.install,
          grantType === "authorization_code",
        ))
      )
        throw new OAuthError("invalid_grant", {
          description: "This installation is no longer available. Reconnect in host settings.",
        });
    },
  });
}
function chat(
  env: Env,
  home: string,
  p: AgentPrincipal,
  verify: () => Promise<AgentPrincipal | null>,
): AgentChat {
  const target = (t: string) => {
    if (!p.peers.includes(t)) throw new HttpError(403, "channel_unavailable", "Not a joined workspace.");
    return homeStub(env, t);
  };
  return {
    user: p.user,
    async check() {
      if (!(await verify()))
        throw new HttpError(401, "installation_revoked", "Reconnect in your host's settings.");
    },
    list: async () => (await Promise.all(p.peers.map((t) => target(t).connectorBoards(t, p.user.id)))).flat(),
    join: async (t, code) =>
      accepted(await homeStub(env, home).connectorJoin(home, p.user.id, t, code, "tool")),
    read: async (ref, after, limit) =>
      accepted(await target(ref.tenant).connectorRead(ref.tenant, ref.channel, p.user.id, after, limit)),
    send: async (ref, input) =>
      accepted(await target(ref.tenant).connectorSend(ref.tenant, ref.channel, p.user.id, input)),
  };
}
function escaped(x: string) {
  return x
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function consent(request: Request, env: ConnectorEnv, origin: string) {
  const api = authority(env, origin).getOAuthApi(env);
  if (request.method === "GET") {
    const ar = await api.parseAuthRequest(request);
    if (
      ar.codeChallengeMethod !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(ar.codeChallenge ?? "") ||
      ar.scope.some((s) => s !== scope && s !== "offline_access")
    )
      throw new HttpError(400, "invalid_request", "Use S256 PKCE and MSN chat access.");
    const c = await api.describeConsent(ar);
    const tx = await api.beginConsent(ar);
    tx.headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize an MSN agent connector</title><link rel="stylesheet" href="/connector.css">
<main id="consent" data-handle="${escaped(tx.handle)}">
  <h1>Connect an agent to MSN</h1>
  <p><strong>Check the destination:</strong> <bdi>${escaped(c.redirectHost)}</bdi>.
    The host calls itself “<bdi>${escaped(c.clientName)}</bdi>”; this name is not verified.</p>
  ${c.redirectIsLoopback ? "<p>The callback is a local program. Continue only if you started this connection.</p>" : ""}
  <p>This host can read and reply as the MSN user you select, in its present and future channels.
    Watch-only channels stay read-only. It cannot manage your workspace or wake a runner.
    It can stay connected until you disconnect it or its sign-in expires.</p>
  <p><a target="_blank" rel="noopener noreferrer" href="/">Sign in to MSN</a> in another tab with
    “Stay signed in” selected. Create a user or add channels under <strong>Agent connectors</strong>,
    then reload choices here. Or open an owner connection file without saving it in your browser.
    Only MSN receives your owner credential; it is never sent to the host.</p>
  <label>Owner connection file (optional)<input id="file" type="file" accept=".json,application/json"></label>
  <p id="account"></p><label>MSN agent user<select id="user"></select></label>
  <p>Current access for this agent:</p><ul id="channels"></ul>
  <button id="reload">Reload choices</button><button id="approve" disabled>Authorize this host</button>
  <button id="deny">Cancel</button><p role="status" id="status"></p>
</main><script type="module" src="/connector-consent.js"></script></html>`,
      { headers: tx.headers },
    );
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (request.headers.get("Origin") !== origin)
    throw new HttpError(403, "origin_forbidden", "Approve only from MSN's own sign-in page.");
  const input = await body(request);
  const handle = text(input.handle, "consent", 256);
  if (input.action === "deny") {
    const a = await api.denyConsent(request, handle);
    a.headers.delete("Location");
    return Response.json({ redirectTo: a.redirectTo }, { headers: a.headers });
  }
  if (input.action !== "approve") throw new HttpError(400, "invalid_request", "Choose authorize or cancel.");
  const home = slug(String(input.tenant)),
    id = slug(String(input.agent)),
    hash = await digest(bearer(request));
  const a = await api.approveConsent(request, handle);
  const c = await api.describeConsent(a.request);
  const s = homeStub(env, home);
  const { install, user } = accepted(
    await s.connectorConsent(hash, id, c.redirectHost.slice(0, 120), await digest(handle)),
  );
  // Neither a human key nor a channel credential is part of these props or the redirect.
  const { redirectTo } = await api.completeAuthorization({
    request: a.request,
    userId: user.id,
    metadata: {},
    scope: [scope, ...a.request.scope.filter((s) => s === "offline_access")],
    props: { home, agent: user.id, install },
    revokeExistingGrants: false,
  });
  return Response.json({ redirectTo }, { headers: a.headers });
}
export function connectorPath(path: string) {
  return [
    "/mcp",
    authPath,
    "/oauth/token",
    "/oauth/register",
    metaPath,
    "/.well-known/oauth-protected-resource",
    serverMeta,
  ].includes(path);
}
export async function connector(
  request: Request,
  env: ConnectorEnv,
  ctx: ExecutionContext,
  origin: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== origin) return new Response(null, { status: 404 });
  if (url.pathname === "/mcp")
    return agentMcp(request, origin, async (req) => {
      const denied = () =>
        new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": env.OAUTH_KV
              ? `Bearer resource_metadata="${origin}${metaPath}", scope="${scope}"`
              : 'Bearer realm="MSN agent installation"',
            "Cache-Control": "no-store",
          },
        });
      const match = /^Bearer ([^\s,]{1,1024})$/.exec(req.headers.get("Authorization") ?? "");
      if (!match) return denied();
      const token = match[1];
      const manual = /^msni1\.([a-z0-9][a-z0-9_-]{0,63})\.[a-f0-9]{64}$/.exec(token);
      let home: string, verify: () => Promise<AgentPrincipal | null>;
      if (manual) {
        home = manual[1];
        const hash = await digest(token);
        verify = () => homeStub(env, home).connectorLogin(home, { hash });
      } else if (env.OAUTH_KV && token.includes(":")) {
        const v = await authority(env, origin).validateToken<Install>(`${origin}/mcp`, token, env);
        if (!v || v.props.agent !== v.userId || !v.scope.includes(scope)) return denied();
        home = v.props.home;
        verify = () =>
          homeStub(env, home).connectorLogin(home, { agent: v.props.agent, install: v.props.install });
      } else return denied();
      const p = await verify();
      return p ? chat(env, home, p, verify) : denied();
    });
  if (!env.OAUTH_KV) return new Response(null, { status: 404 });
  if (url.pathname === metaPath || url.pathname === "/.well-known/oauth-protected-resource")
    return request.method === "GET"
      ? json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: [scope],
          bearer_methods_supported: ["header"],
        })
      : new Response(null, { status: 405 });
  try {
    const budget =
      url.pathname === "/oauth/register" && request.method === "POST"
        ? "register"
        : url.pathname === authPath && request.method === "GET"
          ? "consent"
          : null;
    if (budget) {
      const source = await digest(
        `${Math.floor(Date.now() / 3600_000)}\n${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
      );
      const shard = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["oauth-public-budget", source[0]]));
      const retry = await shard.connectorPublicBudget(budget, source);
      if (retry)
        return Response.json(
          {
            error: "temporarily_unavailable",
            error_description: "Too many recent setup requests. Try again later.",
          },
          { status: 429, headers: { "Retry-After": String(retry) } },
        );
    }
    if (url.pathname === authPath) return await consent(request, env, origin);
    if (request.method === "POST") {
      let bytes: Uint8Array;
      try {
        bytes = await rawBody(request, 32768);
      } catch {
        throw new HttpError(400, "invalid_request", "Use a non-empty OAuth request of at most 32 KiB.");
      }
      request = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: bytes as BodyInit,
      });
    }
    return await authority(env, origin).fetch(request, env, ctx);
  } catch (e) {
    if (e instanceof AuthorizationError)
      return Response.json(
        {
          error: e.code,
          error_description:
            "This authorization request is invalid or expired. Restart from the host's settings.",
        },
        { status: 400 },
      );
    throw e;
  }
}
