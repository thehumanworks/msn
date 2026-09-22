import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { digest, HttpError, text } from "./http";

export type AccessSettings = {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_LOGIN_URL?: string;
};
const issuers = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function accessLoginUrl(env: AccessSettings): string {
  if (!env.ACCESS_LOGIN_URL) return "/login";
  try {
    const url = new URL(env.ACCESS_LOGIN_URL);
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/login" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("invalid login URL");
    return url.href;
  } catch {
    throw new HttpError(503, "access_configuration_invalid", "Invalid Cloudflare Access login URL.");
  }
}

/** Access is optional. Never trust an email header or an unsigned JWT. */
export async function accessAccount(request: Request, env: AccessSettings) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)
    throw new HttpError(
      503,
      "access_not_configured",
      "Cloudflare login is not configured. Use an account connection file or create an account with the CLI.",
    );
  const domain = env.ACCESS_TEAM_DOMAIN;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain))
    throw new HttpError(503, "access_configuration_invalid", "Invalid Cloudflare Access team domain.");
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion)
    throw new HttpError(
      401,
      "login_required",
      "Cloudflare Access did not authenticate this request. Open the configured sign-in URL and check that its hostname and /login path are protected by an Access Allow policy.",
    );
  const issuer = `https://${domain}`;
  let jwks = issuers.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
    issuers.set(issuer, jwks);
  }
  return verifyAccessAccount(assertion, issuer, env.ACCESS_AUD, jwks);
}

export async function verifyAccessAccount(
  assertion: string,
  issuer: string,
  audience: string,
  jwks: JWTVerifyGetKey,
) {
  try {
    const { payload } = await jwtVerify(assertion, jwks, {
      issuer,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat"],
    });
    // The stable subject, not a mutable email address, owns the account directory.
    const subject = text(payload.sub, "subject", 256);
    const username = text(payload.email, "email", 128);
    return { tenant: `account-${(await digest(`${issuer}\n${subject}`)).slice(0, 48)}`, username };
  } catch {
    throw new HttpError(401, "invalid_access_token", "Cloudflare login expired or could not be verified.");
  }
}
