/**
 * Sign in with Cloudflare Access (ADR 0079). The server's /login is protected by Access, so the
 * system sign-in sheet opens it with the person's usual Safari session, passkeys and identity
 * provider. The server answers on `msn://login` with a single-use code, never a key, and the app
 * exchanges that code for an account key by proving it holds the verifier behind the challenge it
 * sent. A code that leaks, or a sign-in someone else started, is useless without that verifier.
 */
import { SecureFetcher, type FetchLike, validateOrigin } from "../../../ios/src/core/httpClient.ts";
import type { RandomBytes } from "./persona.ts";

/** The scheme and host the server sends the code to; the sign-in sheet listens for exactly this. */
export const CALLBACK = "msn://login";

export type AuthSession = (url: string, callback: string) => Promise<{ type: string; url?: string }>;

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

/** Whether this server offers Cloudflare sign-in. Any failure reads as no, so the button hides. */
export async function offersCloudflare(server: string, fetchImpl?: FetchLike): Promise<boolean> {
  try {
    const fetcher = new SecureFetcher(validateOrigin(server.trim()).origin, fetchImpl);
    const config = await fetcher.fetchJson<{ cloudflareAccess?: unknown }>(
      `${fetcher.origin.origin}/api/account/config`,
      { method: "GET" },
      { timeoutMs: 5_000, maxBytes: 4 * 1024 },
    );
    return config.cloudflareAccess === true;
  } catch {
    return false;
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads the server's answer on the callback URL: the account it signed in and the code. */
export function parseCallback(raw: string): { account: string; code: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // `new URL("msn://login?…")` keeps "login" as the host on Hermes and in Node.
  if (url.protocol !== "msn:" || url.host !== "login") return null;
  const account = url.searchParams.get("account") ?? "";
  const code = url.searchParams.get("code") ?? "";
  return ACCOUNT.test(account) && HEX64.test(code) ? { account, code } : null;
}

export async function signInWithCloudflare(server: string, deps: CloudflareDeps): Promise<CloudflareResult> {
  try {
    const origin = validateOrigin(server.trim()).origin;
    const verifier = hex(deps.randomBytes(32));
    const challenge = (await deps.sha256Hex(verifier)).toLowerCase();
    if (!HEX64.test(challenge)) return { error: "Could not start the sign-in." };

    const session = await deps.openAuthSession(`${origin}/login?app=${challenge}`, CALLBACK);
    if (session.type !== "success" || !session.url) return { cancelled: true };
    const callback = parseCallback(session.url);
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
