import { env, exports } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import { accessLoginUrl, verifyAccessAccount } from "../src/account";

it("browser login uses the protected hostname and drops caller-supplied redirect parameters", async () => {
  const config = await exports.default.fetch("https://msn.test/api/account/config");
  expect(await config.json()).toMatchObject({ cloudflareAccess: true, loginUrl: env.ACCESS_LOGIN_URL });
  const response = await exports.default.fetch("https://msn.test/login?redirect=https://foreign.test", {
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe(env.ACCESS_LOGIN_URL);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

it("missing Access authentication has actionable errors and API login never redirects", async () => {
  for (const [url, method] of [
    [env.ACCESS_LOGIN_URL, "GET"],
    ["https://msn.test/api/account/login", "POST"],
  ]) {
    const response = await exports.default.fetch(url, {
      method,
      headers: { "Cf-Access-Authenticated-User-Email": "spoofed@example.com" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.json()).toMatchObject({
      error: {
        code: "login_required",
        message: expect.stringContaining("Cloudflare Access did not authenticate"),
      },
    });
  }
});

it("login destination must be an HTTPS login URL without credentials or extra URL components", () => {
  expect(accessLoginUrl({})).toBe("/login");
  for (const url of [
    "http://msn.test/login",
    "https://user:password@msn.test/login",
    "https://msn.test/elsewhere",
    "https://msn.test/login?redirect=elsewhere",
    "https://msn.test/login#fragment",
  ])
    expect(() => accessLoginUrl({ ACCESS_LOGIN_URL: url })).toThrow("Invalid Cloudflare Access login URL");
});

it("Access login verifies signature, issuer, audience and expiry; account follows the subject", async () => {
  const key = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(key.publicKey)), kid: "test" }] });
  const issuer = "https://team.cloudflareaccess.com";
  const sign = (email: string, options: { aud?: string; iss?: string; exp?: number } = {}) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setSubject("stable-subject")
      .setIssuer(options.iss ?? issuer)
      .setAudience(options.aud ?? "app")
      .setIssuedAt()
      .setExpirationTime(options.exp ?? Math.floor(Date.now() / 1000) + 60)
      .sign(key.privateKey);
  const first = await verifyAccessAccount(await sign("one@example.com"), issuer, "app", jwks);
  const renamed = await verifyAccessAccount(await sign("two@example.com"), issuer, "app", jwks);
  expect(first.tenant).toBe(renamed.tenant);
  for (const options of [{ aud: "foreign" }, { iss: "https://other.cloudflareaccess.com" }, { exp: 1 }])
    await expect(
      verifyAccessAccount(await sign("one@example.com", options), issuer, "app", jwks),
    ).rejects.toMatchObject({ status: 401 });
  const foreign = await generateKeyPair("RS256");
  const forged = await new SignJWT({ email: "one@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setSubject("stable-subject")
    .setIssuer(issuer)
    .setAudience("app")
    .setIssuedAt()
    .setExpirationTime("1m")
    .sign(foreign.privateKey);
  await expect(verifyAccessAccount(forged, issuer, "app", jwks)).rejects.toMatchObject({ status: 401 });
});
