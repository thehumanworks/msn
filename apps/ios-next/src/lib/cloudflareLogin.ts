/**
 * Sign in with Cloudflare Access (ADR 0079). The server's /login is protected by Access, so the
 * system sign-in sheet opens it with the person's usual Safari session, passkeys and identity
 * provider. The server answers with a single-use code, never a key, on an https callback at its
 * own origin. iOS completes the sheet on that URL only for an app the server names in its
 * apple-app-site-association file and that carries the matching Associated Domains entitlement,
 * so another app cannot start a sign-in with its own challenge and collect the code. The app then
 * exchanges the code for an account key by proving it holds the verifier behind its challenge, so
 * a code copied out of this app's own sign-in is useless too.
 */
import { SecureFetcher, type FetchLike, validateOrigin } from "../../../ios/src/core/httpClient.ts";
import type { RandomBytes } from "./persona.ts";

/**
 * Servers this app can complete a sign-in with: they must match the `webcredentials:` entries in
 * app.json's `ios.associatedDomains`, because iOS refuses an https callback on any other host.
 */
export const SIGN_IN_HOSTS: readonly string[] = ["msn.thehuman.sh"];

/** The path the server sends the code to; the sign-in sheet listens for exactly this. */
export const CALLBACK_PATH = "/app/signed-in";

export type AuthSession = (
  url: string,
  callback: string,
  options: { preferUniversalLinks: true },
) => Promise<{ type: string; url?: string }>;

export type CloudflareDeps = {
  fetchImpl?: FetchLike;
  randomBytes: RandomBytes;
  sha256Hex: (text: string) => Promise<string>;
  openAuthSession: AuthSession;
};

export type CloudflareAccount = { origin: string; tenant: string; username: string; token: string };
export type CloudflareResult = { account: CloudflareAccount } | { cancelled: true } | { error: string };

const HEX64 = /^[a-f0-9]{64}$/;
const ACCOUNT = /^account-[a-f0-9]{48}$/;
const LIMITS = { timeoutMs: 15_000, maxBytes: 64 * 1024 };

/** The server's origin, when this app can sign in to it with Cloudflare; otherwise null. */
function signInOrigin(server: string): string | null {
  try {
    const origin = validateOrigin(server.trim()).origin;
    const url = new URL(origin);
    return url.protocol === "https:" && SIGN_IN_HOSTS.includes(url.hostname) ? origin : null;
  } catch {
    return null;
  }
}

/**
 * Whether this server offers Cloudflare sign-in to this app: one of its associated hosts, with
 * Access configured and its sign-in page on the same origin. Any failure reads as no, so the
 * button hides.
 */
export async function offersCloudflare(server: string, fetchImpl?: FetchLike): Promise<boolean> {
  const origin = signInOrigin(server);
  if (!origin) return false;
  try {
    const fetcher = new SecureFetcher(origin, fetchImpl);
    const config = await fetcher.fetchJson<{ cloudflareAccess?: unknown; loginUrl?: unknown }>(
      `${origin}/api/account/config`,
      { method: "GET" },
      { timeoutMs: 5_000, maxBytes: 4 * 1024 },
    );
    return (
      config.cloudflareAccess === true &&
      typeof config.loginUrl === "string" &&
      new URL(config.loginUrl, origin).href === `${origin}/login`
    );
  } catch {
    return false;
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads the server's answer on the callback URL: the account it signed in and the code. */
export function parseCallback(raw: string, origin: string): { account: string; code: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.pathname !== CALLBACK_PATH || url.search) return null;
  // The server puts the answer in the fragment, so the code never reaches a request log.
  const answer = new URLSearchParams(url.hash.slice(1));
  const account = answer.get("account") ?? "";
  const code = answer.get("code") ?? "";
  return ACCOUNT.test(account) && HEX64.test(code) ? { account, code } : null;
}

export async function signInWithCloudflare(server: string, deps: CloudflareDeps): Promise<CloudflareResult> {
  try {
    const origin = signInOrigin(server);
    if (!origin) return { error: "Cloudflare sign-in works only with msn.thehuman.sh in this app." };
    const verifier = hex(deps.randomBytes(32));
    const challenge = (await deps.sha256Hex(verifier)).toLowerCase();
    if (!HEX64.test(challenge)) return { error: "Could not start the sign-in." };

    const session = await deps.openAuthSession(`${origin}/login?app=${challenge}`, `${origin}${CALLBACK_PATH}`, {
      preferUniversalLinks: true,
    });
    if (session.type !== "success" || !session.url) return { cancelled: true };
    const callback = parseCallback(session.url, origin);
    if (!callback) return { error: "Cloudflare sign-in did not return to the app. Try again." };

    const fetcher = new SecureFetcher(origin, deps.fetchImpl);
    const connection = await fetcher.fetchJson<{ url?: unknown; tenant?: unknown; username?: unknown; token?: unknown }>(
      `${origin}/api/account/app-login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: callback.account, code: callback.code, verifier }),
      },
      LIMITS,
    );
    // The key must be for the server and account this sign-in started with, and nothing else.
    if (
      connection.url !== origin ||
      connection.tenant !== callback.account ||
      typeof connection.username !== "string" ||
      typeof connection.token !== "string"
    )
      return { error: "The server's sign-in answer did not match this sign-in." };
    return {
      account: { origin, tenant: connection.tenant, username: connection.username, token: connection.token },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Cloudflare sign-in failed." };
  }
}
