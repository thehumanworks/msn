import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const call = (path: string, token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });

describe("curl is a first-class client (ADR 0056)", () => {
  it("GET /api is a public plain-text quickstart with this server's origin and no secrets", async () => {
    for (const path of ["/api", "/api/"]) {
      const response = await call(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = await response.text();
      expect(body).toContain("https://msn.test/#board=");
      expect(body).toContain('/personas/$MSN_NAME"');
      expect(body).toContain("/invites/redeem");
      expect(body).toContain("messages?after=N&wait=25");
      expect(body).toContain("since?reader=$MSN_NAME");
      // Wake an agent with a webhook (ADR 0062).
      expect(body).toContain("PUT    $API/personas/ID/webhook");
      expect(body).toContain("MSN-Webhook-Signature");
    }
    expect((await call("/api", undefined, "POST", {})).status).toBe(404);
  });

  it("a shared key's unregistered name is told the exact HTTP call that registers it", async () => {
    const tenant = `quick-${crypto.randomUUID()}`;
    const owner = await (await call(`/api/tenants/${tenant}`, undefined, "PUT", { username: "human" })).json<{
      token: string;
    }>();
    const shared = "c".repeat(64);
    const base = `/api/tenants/${tenant}/channels/work`;
    expect((await call(`${base}/board`, owner.token, "PUT", { credential: shared, goal: "Go" })).status).toBe(
      201,
    );
    const refused = await call(`${base}/messages`, shared, "POST", { username: "scout", text: "hi" });
    expect(refused.status).toBe(400);
    const { error } = await refused.json<{ error: { code: string; message: string } }>();
    expect(error.code).toBe("persona_required");
    expect(error.message).toContain(`PUT /api/tenants/${tenant}/channels/work/personas/ID`);
    expect(error.message).toContain('{"displayName":"scout"}');
    // Following the message exactly is enough to send.
    expect((await call(`${base}/personas/scout`, shared, "PUT", { displayName: "scout" })).status).toBe(201);
    expect((await call(`${base}/messages`, shared, "POST", { username: "scout", text: "hi" })).status).toBe(
      201,
    );
  });
});
