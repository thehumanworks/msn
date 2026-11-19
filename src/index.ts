import { type AccessSettings, accessAccount, accessLoginUrl } from "./account";
import { admin, bearer, failure, HttpError, json, slug } from "./http";

export { MsnDurableObject } from "./store";

export default {
  async fetch(request, env): Promise<Response> {
    let response: Response;
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/account/config" && request.method === "GET") {
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
        response = new Response(null, {
          status: 302,
          headers: { Location: accessLoginUrl(env as AccessSettings), "Cache-Control": "no-store" },
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
      } else if (url.pathname === "/api/health" && request.method === "GET") {
        response = json({ ok: true, service: "msn" });
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
          !(request.method === "POST" && match[3] === "/invites/redeem")
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
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/api")) secured.headers.set("Cache-Control", "no-store");
    // `curl -fsSL https://msn.thehuman.sh/install.sh | sh`; plain text also lets a browser show it for review.
    if (pathname === "/install.sh" && response.ok) {
      secured.headers.set("Content-Type", "text/plain; charset=utf-8");
      secured.headers.set("Cache-Control", "public, max-age=300");
    }
    return secured;
  },
} satisfies ExportedHandler<Env>;
