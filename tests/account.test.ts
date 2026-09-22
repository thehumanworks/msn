import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import { verifyAccessAccount } from "../src/account";

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
