import { type AccessSettings, accessAccount, accessLoginUrl } from "./account";
import { connector, connectorPath } from "./agent-connector";
import { admin, bearer, body, failure, HttpError, json, slug } from "./http";
import { quickstart } from "./quickstart";

import type { Refusal } from "./store";

export { MsnDurableObject } from "./store";

/**
 * Where a native app's sign-in sheet returns (ADR 0079): an https path on this server, not a
 * custom scheme. iOS hands it only to an app this server names in its apple-app-site-association
 * file, so no other app can start a sign-in and collect the code.
 */
const APP_LOGIN_CALLBACK_PATH = "/app/signed-in";

/** The page behind the callback path, for a browser that lands there outside the app's sheet. */
const APP_SIGNED_IN_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MSN</title><p>Sign-in finished. If this page stays open, close it and sign in again from the MSN app.</p>`;

/** Turns a refusal returned over Durable Object RPC back into the HTTP error it stands for. */
function accepted<R extends object>(result: R): Exclude<R, { refused: unknown }> {
  if ("refused" in result) {
    const { status, code, message } = (result as unknown as Refusal).refused;
    throw new HttpError(status, code, message);
  }
  return result as Exclude<R, { refused: unknown }>;
}

function appChallenge(url: URL): string | null {
  const challenge = url.searchParams.get("app");
  return challenge && /^[a-f0-9]{64}$/.test(challenge) ? challenge : null;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    let response: Response;
    try {
      const url = new URL(request.url);
      if (connectorPath(url.pathname)) {
        const canonical = env.MCP_ORIGIN;
        response = await connector(request, env, ctx, canonical);
      } else if (url.pathname === "/.well-known/apple-app-site-association" && request.method === "GET") {
        // The apps allowed to receive the sign-in callback (ADR 0079), as TEAMID.bundle ids.
        const apps = String(env.APPLE_APP_IDS ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter((id) => /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/.test(id));
        if (!apps.length)
          throw new HttpError(404, "route_not_found", "No apps are associated with this server.");
        response = json({ webcredentials: { apps } });
      } else if (url.pathname === APP_LOGIN_CALLBACK_PATH && request.method === "GET") {
        response = new Response(APP_SIGNED_IN_PAGE, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      } else if (url.pathname === "/api/account/config" && request.method === "GET") {
        const access = env as Env & AccessSettings;
        response = json({
          cloudflareAccess: Boolean(access.ACCESS_TEAM_DOMAIN && access.ACCESS_AUD),
          loginUrl: accessLoginUrl(access),
        });
      } else if (
        url.pathname === "/login" &&
        request.method === "GET" &&
        new URL(accessLoginUrl(env as AccessSettings), url).origin !== url.origin
      ) {
        // Only a well-formed app challenge survives the hop; other parameters are dropped.
        const target = new URL(accessLoginUrl(env as AccessSettings), url);
        const challenge = appChallenge(url);
        if (challenge) target.searchParams.set("app", challenge);
        response = new Response(null, {
          status: 302,
          headers: { Location: target.href, "Cache-Control": "no-store" },
        });
      } else if (url.pathname === "/login" && request.method === "GET" && url.searchParams.has("app")) {
        // Native app sign-in (ADR 0079): Access has verified the person; the app's sign-in sheet
        // catches the one-time code on the https callback and exchanges it, with its verifier, for a key.
        const challenge = appChallenge(url);
        if (!challenge)
          throw new HttpError(400, "invalid_app_login", "Use a SHA-256 hex challenge for app sign-in.");
        const account = await accessAccount(request, env as Env & AccessSettings);
        const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", account.tenant]));
        const { code } = accepted(await stub.startAppLogin(account.username, challenge));
        // The code rides in the fragment, which browsers never send, so it stays out of request logs.
        const callback = new URL(APP_LOGIN_CALLBACK_PATH, url.origin);
        callback.hash = new URLSearchParams({ account: account.tenant, code }).toString();
        response = new Response(null, {
          status: 303,
          headers: { Location: callback.href, "Cache-Control": "no-store" },
        });
      } else if (url.pathname === "/api/account/app-login" && request.method === "POST") {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin)
          throw new HttpError(403, "origin_forbidden", "Use a same-origin login.");
        const input = await body(request);
        const tenant = typeof input.account === "string" ? input.account : "";
        if (!/^account-[a-f0-9]{48}$/.test(tenant))
          throw new HttpError(
            401,
            "invalid_app_login",
            "This sign-in expired or was already used. Sign in again.",
          );
        const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant]));
        response = json({
          url: url.origin,
          ...accepted(
            await stub.redeemAppLogin(tenant, String(input.code ?? ""), String(input.verifier ?? "")),
          ),
        });
      } else if (
        (url.pathname === "/api/account/login" && request.method === "POST") ||
        (url.pathname === "/login" && request.method === "GET")
      ) {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin)
          throw new HttpError(403, "origin_forbidden", "Use a same-origin login.");
        const account = await accessAccount(request, env as Env & AccessSettings);
        const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", account.tenant]));
        const connection = {
          url: url.origin,
          ...(await stub.accountSession(account.tenant, account.username)),
        };
        response =
          url.pathname === "/login"
            ? new Response(null, {
                status: 303,
                headers: {
                  Location: `/#account=${encodeURIComponent(JSON.stringify(connection))}`,
                  "Cache-Control": "no-store",
                },
              })
            : json(connection);
      } else if ((url.pathname === "/api" || url.pathname === "/api/") && request.method === "GET") {
        // Public curl quickstart (ADR 0056): plain text, no secrets, so `curl ORIGIN/api` explains itself.
        response = new Response(quickstart(url.origin), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      } else if (url.pathname === "/api/health" && request.method === "GET") {
        response = json({ ok: true, service: "msn" });
      } else if (url.pathname.startsWith("/api/github/hooks/") && request.method === "POST") {
        // GitHub webhook deliveries (ADR 0036). No bearer and no Origin: the Durable Object checks
        // the HMAC signature against the workspace's own webhook secret before reading anything.
        const match = /^\/api\/github\/hooks\/([^/]+)$/.exec(url.pathname);
        if (!match) throw new HttpError(404, "route_not_found", "Unknown API endpoint.");
        const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", slug(match[1])]));
        response = await stub.fetch(request);
      } else if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        // Browser clients are same-origin; no cookie auth and no permissive CORS.
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin)
          throw new HttpError(403, "origin_forbidden", "Use a same-origin browser client.");
        const match = /^\/api\/(admin\/)?tenants\/([^/]+)(\/.*)?$/.exec(url.pathname);
        if (!match) throw new HttpError(404, "route_not_found", "Unknown API endpoint.");
        const tenant = slug(match[2]);
        if (match[1]) await admin(request, env);
        else if (
          !(request.method === "PUT" && !match[3]) &&
          !(request.method === "POST" && match[3] === "/invites/redeem") &&
          // Both exp and sig, and no Authorization header: the signature is the credential.
          // A bearer is still checked when it is sent, including next to an expired signature.
          !(
            request.method === "GET" &&
            /\/messages\/[1-9]\d*\/attachments\/\d+$/.test(match[3] ?? "") &&
            url.searchParams.has("sig") &&
            url.searchParams.has("exp") &&
            !request.headers.has("Authorization")
          )
        )
          bearer(request);
        const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant]));
        response = await stub.fetch(request);
      } else {
        response = await env.ASSETS.fetch(request);
      }
    } catch (error) {
      response = failure(error);
    }
    const secured = new Response(response.body, response);
    secured.headers.set("X-Content-Type-Options", "nosniff");
    secured.headers.set("Referrer-Policy", "no-referrer");
    secured.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/api") || connectorPath(pathname))
      secured.headers.set("Cache-Control", "no-store");
    // `curl -fsSL https://msn.thehuman.sh/install.sh | sh`; plain text also lets a browser show it for review.
    if (pathname === "/install.sh" && response.ok) {
      secured.headers.set("Content-Type", "text/plain; charset=utf-8");
      secured.headers.set("Cache-Control", "public, max-age=300");
    }
    return secured;
  },
} satisfies ExportedHandler<Env>;
