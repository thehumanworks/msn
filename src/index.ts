import { admin, bearer, failure, HttpError, json, slug } from "./http";

export { MsnDurableObject } from "./store";

export default {
  async fetch(request, env): Promise<Response> {
    let response: Response;
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/health" && request.method === "GET") {
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
    if (new URL(request.url).pathname.startsWith("/api")) secured.headers.set("Cache-Control", "no-store");
    return secured;
  },
} satisfies ExportedHandler<Env>;
