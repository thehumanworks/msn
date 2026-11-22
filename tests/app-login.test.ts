import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digest } from "../src/http";

// Native app sign-in (ADR 0079): Access verifies the person on /login?app=CHALLENGE, the app's
// sign-in sheet catches a one-time code on the https callback, and exchanges it with its verifier
// for an account key.

afterEach(() => vi.restoreAllMocks());

/** Signs Access assertions with a key the Worker fetches as the team's certs. */
async function accessIssuer() {
  const key = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(key.publicKey)), kid: "app-login-test", alg: "RS256", use: "sig" };
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    return realFetch(input, init);
  });
  return (subject: string, email: string) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256", kid: "app-login-test" })
      .setSubject(subject)
      .setIssuer(issuer)
      .setAudience(env.ACCESS_AUD)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .sign(key.privateKey);
}

const tenant = `account-${"a".repeat(48)}`;
const stub = () => env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant]));
const hex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

async function start(verifier: string): Promise<string> {
  const result = await stub().startAppLogin("tomas@example.com", await digest(verifier));
  if (!("code" in result)) throw new Error("expected a code");
  return result.code;
}

async function exchange(input: Record<string, unknown>, headers: Record<string, string> = {}) {
  return exports.default.fetch("https://msn.test/api/account/app-login", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(input),
  });
}

describe("app sign-in", () => {
  it("exchanges a code once, with the right verifier, for a working owner key", async () => {
    const verifier = hex();
    const code = await start(verifier);
    const response = await exchange({ account: tenant, code, verifier });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const connection = await response.json<{
      url: string;
      tenant: string;
      username: string;
      token: string;
      owner: boolean;
    }>();
    expect(connection).toMatchObject({
      url: "https://msn.test",
      tenant,
      username: "tomas@example.com",
      owner: true,
    });
    const channels = await exports.default.fetch(`https://msn.test/api/tenants/${tenant}/channels`, {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    expect(channels.status).toBe(200);
    const again = await exchange({ account: tenant, code, verifier });
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ error: { code: "invalid_app_login" } });
  });

  it("a wrong verifier of any shape spends the code, so whoever sees a code cannot use it", async () => {
    for (const wrong of [hex(), "not-hex", ""]) {
      const verifier = hex();
      const code = await start(verifier);
      expect((await exchange({ account: tenant, code, verifier: wrong })).status).toBe(401);
      expect((await exchange({ account: tenant, code, verifier })).status).toBe(401);
    }
  });

  it("two exchanges of one code at once yield exactly one key", async () => {
    const verifier = hex();
    const code = await start(verifier);
    const answers = await Promise.all([
      exchange({ account: tenant, code, verifier }),
      exchange({ account: tenant, code, verifier }),
      exchange({ account: tenant, code, verifier }),
    ]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 401, 401]);
  });

  it("a signed-in owner's /login?app= returns the code on the https callback, never a custom scheme", async () => {
    const sign = await accessIssuer();
    const verifier = hex();
    const response = await exports.default.fetch(`${env.ACCESS_LOGIN_URL}?app=${await digest(verifier)}`, {
      redirect: "manual",
      headers: { "Cf-Access-Jwt-Assertion": await sign("app-login-subject", "owner@example.com") },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin).toBe(new URL(env.ACCESS_LOGIN_URL).origin);
    expect(location.pathname).toBe("/app/signed-in");
    const account = location.searchParams.get("account") ?? "";
    expect(account).toMatch(/^account-[a-f0-9]{48}$/);
    const code = location.searchParams.get("code") ?? "";
    const redeemed = await exports.default.fetch(
      `${new URL(env.ACCESS_LOGIN_URL).origin}/api/account/app-login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, code, verifier }),
      },
    );
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toMatchObject({
      tenant: account,
      username: "owner@example.com",
      owner: true,
    });
  });

  it("names the associated app for https callbacks, outside Access, and the callback page echoes nothing", async () => {
    const association = await exports.default.fetch(
      "https://msn.test/.well-known/apple-app-site-association",
      {
        redirect: "manual",
      },
    );
    expect(association.status).toBe(200);
    expect(association.headers.get("Content-Type")).toContain("application/json");
    expect(await association.json()).toEqual({ webcredentials: { apps: [env.APPLE_APP_IDS] } });
    const code = hex();
    const page = await exports.default.fetch(`https://msn.test/app/signed-in?account=${tenant}&code=${code}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).not.toContain(code);
    expect(html).not.toContain(tenant);
  });

  it("refuses malformed input, another account's code and cross-origin callers", async () => {
    const verifier = hex();
    const code = await start(verifier);
    for (const input of [
      { account: "workspace", code, verifier },
      { account: `account-${"b".repeat(48)}`, code, verifier },
      { account: tenant, code: "short", verifier },
      { account: tenant, code, verifier: "not-hex" },
      { account: tenant },
    ])
      expect((await exchange(input)).status).toBe(401);
    expect(
      (await exchange({ account: tenant, code, verifier }, { Origin: "https://foreign.test" })).status,
    ).toBe(403);
  });

  it("codes expire after two minutes", async () => {
    const verifier = hex();
    const code = await start(verifier);
    const hash = await digest(code);
    await runInDurableObject(stub(), (_, state) => {
      state.storage.sql.exec("UPDATE app_logins SET expiresMs = ? WHERE code_hash = ?", Date.now() - 1, hash);
    });
    expect((await exchange({ account: tenant, code, verifier })).status).toBe(401);
  });

  it("starting needs a SHA-256 hex challenge and caps unexchanged sign-ins", async () => {
    expect(await stub().startAppLogin("tomas@example.com", "nope")).toMatchObject({
      refused: { status: 400, code: "invalid_app_login" },
    });
    const other = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", `account-${"c".repeat(48)}`]));
    for (let i = 0; i < 20; i++) await other.startAppLogin("tomas@example.com", hex());
    expect(await other.startAppLogin("tomas@example.com", hex())).toMatchObject({
      refused: { status: 429, code: "app_login_quota" },
    });
  });

  it("/login?app= needs Cloudflare Access and a well-formed challenge", async () => {
    const login = env.ACCESS_LOGIN_URL;
    const missing = await exports.default.fetch(`${login}?app=${hex()}`, { redirect: "manual" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("Location")).toBeNull();
    expect(await missing.json()).toMatchObject({ error: { code: "login_required" } });
    const forged = await exports.default.fetch(`${login}?app=${hex()}`, {
      redirect: "manual",
      headers: {
        "Cf-Access-Jwt-Assertion": "e30.e30.",
        "Cf-Access-Authenticated-User-Email": "x@example.com",
      },
    });
    expect(forged.status).toBe(401);
    expect(forged.headers.get("Location")).toBeNull();
    const bad = await exports.default.fetch(`${login}?app=nope`, { redirect: "manual" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_app_login" } });
  });

  it("the hop to the configured login host keeps a valid challenge and drops everything else", async () => {
    const challenge = hex();
    const kept = await exports.default.fetch(
      `https://msn.test/login?app=${challenge}&redirect=https://foreign.test`,
      {
        redirect: "manual",
      },
    );
    expect(kept.status).toBe(302);
    expect(kept.headers.get("Location")).toBe(`${env.ACCESS_LOGIN_URL}?app=${challenge}`);
    const dropped = await exports.default.fetch("https://msn.test/login?app=https://foreign.test", {
      redirect: "manual",
    });
    expect(dropped.headers.get("Location")).toBe(env.ACCESS_LOGIN_URL);
  });
});
