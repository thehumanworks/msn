// Wake an agent with a webhook (ADR 0062). The owner registers an https URL for a board persona;
// when a message is addressed to that persona, the workspace's Durable Object POSTs a small
// signed notice there. The notice never holds message text or a key: the agent reads the message
// through the API with its own key. Pure helpers live here; storage and delivery live in store.ts.
import { HttpError } from "./http";

/** Longest webhook URL accepted, in characters. */
export const MAX_WEBHOOK_URL = 2048;
/** One attempt may take this long, from connect to response headers. */
export const WEBHOOK_TIMEOUT_MS = 5000;
/** A notice body never exceeds this many bytes (it holds ids only). */
export const MAX_NOTICE_BYTES = 1024;
/** Waits after attempt 1, 2, 3 and 4. Five attempts in all, over about 73 minutes. */
export const WEBHOOK_RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000];
/** Notices waiting per webhook; more are dropped and the drop is recorded. */
export const MAX_PENDING_NOTICES = 50;
/** Webhooks per workspace. */
export const MAX_WEBHOOKS = 100;
/** Notices sent per alarm run; the alarm runs again at once while more are due. */
export const WEBHOOK_BATCH = 20;

export const SIGNATURE_HEADER = "MSN-Webhook-Signature";
export const TIMESTAMP_HEADER = "MSN-Webhook-Timestamp";
export const ID_HEADER = "MSN-Webhook-Id";

/** Host names that never point at the public internet. */
const PRIVATE_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".corp",
  ".private",
  ".home.arpa",
  ".test",
  ".invalid",
  ".example",
  ".onion",
];

function privateIpv4(host: string): boolean | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // IETF protocol assignments and TEST-NET-1 (192.0.2.0/24)
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51) || // TEST-NET-2
    (a === 203 && b === 0) || // TEST-NET-3
    a >= 224 // multicast, reserved and broadcast
  );
}

/**
 * IPv6 literals: only global unicast (2000::/3) outside documentation space is allowed. That
 * refuses loopback (::1), unspecified (::), IPv4-mapped (::ffff:…), unique local (fc00::/7),
 * link-local (fe80::/10) and multicast (ff00::/8).
 */
function privateIpv6(host: string): boolean | null {
  if (!host.startsWith("[")) return null;
  const inner = host.slice(1, -1).toLowerCase();
  const first = inner.split(":")[0];
  if (!first) return true;
  const word = Number.parseInt(first, 16);
  if (!Number.isFinite(word) || first.length > 4) return true;
  if (word < 0x2000 || word > 0x3fff) return true;
  return inner.startsWith("2001:db8:") || inner.startsWith("2001:0db8:");
}

/** True when the URL's host is loopback, private, link-local or otherwise not public. */
export function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const v4 = privateIpv4(host);
  if (v4 !== null) return v4;
  const v6 = privateIpv6(host);
  if (v6 !== null) return v6;
  if (!host.includes(".")) return true; // single-label names such as "localhost" or "intranet"
  return host === "localhost" || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Validates an owner-supplied webhook URL. https only, on the default port, with no user name,
 * password or fragment, and a public host that is not this server. Returns the normalized URL.
 */
export function webhookUrl(value: unknown, selfHost: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_WEBHOOK_URL)
    throw new HttpError(
      400,
      "invalid_webhook",
      `url must be an https URL of at most ${MAX_WEBHOOK_URL} characters.`,
    );
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new HttpError(400, "invalid_webhook", "url must be an absolute https URL.");
  }
  if (url.protocol !== "https:")
    throw new HttpError(400, "webhook_https_required", "Webhooks use https only.");
  if (url.username || url.password)
    throw new HttpError(
      400,
      "invalid_webhook",
      "Put no user name or password in the URL; notices are signed instead.",
    );
  if (url.port)
    throw new HttpError(
      400,
      "webhook_port_refused",
      "Use the default https port (443); other ports are refused.",
    );
  if (url.hash) throw new HttpError(400, "invalid_webhook", "Remove the #fragment from the URL.");
  if (privateHost(url.hostname) || url.hostname.toLowerCase() === selfHost.toLowerCase())
    throw new HttpError(
      400,
      "webhook_host_refused",
      "The URL must point at a public host: loopback, private, link-local and this server's own address are refused.",
    );
  return url.href;
}

/** A new signing secret: `whsec_` and 64 hex characters. The whole string is the HMAC key. */
export function newWebhookSecret(): string {
  return `whsec_${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Hex HMAC-SHA256 of `${timestamp}.${body}` with the secret's UTF-8 bytes as the key. */
export async function signNotice(secret: string, timestamp: number, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The notice body (`msn.webhook.v1`). Ids only: never message text, sender text or keys. */
export type Notice = {
  schema: "msn.webhook.v1";
  type: "message.addressed" | "ping";
  /** This notice's id; the same on every retry, so a receiver can drop repeats. */
  id: string;
  tenant: string;
  channel: string;
  /** The persona id the message is addressed to. */
  persona: string;
  /** The addressed message, or null for a ping. */
  messageId: number | null;
  /** The board event (GET …/events) that recorded the message, or null for a ping. */
  eventId: number | null;
  /** Where to read the message with your own key, or null for a ping. */
  messageUrl: string | null;
  createdAt: string;
};

export function noticeBody(notice: Notice): string {
  const body = JSON.stringify(notice);
  // Ids and short names only, so this never trips; it guards against a future field growing.
  if (new TextEncoder().encode(body).length > MAX_NOTICE_BYTES) throw new Error("webhook notice too large");
  return body;
}

/** One attempt's outcome. `retry` means a later attempt may succeed. */
export type Attempt =
  | { ok: true; httpStatus: number }
  | { ok: false; retry: boolean; httpStatus: number | null; error: string };

/** Which answers are worth retrying: no answer, a timeout, 408, 425, 429 and 5xx. */
export function retryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * POSTs one signed notice. Never follows a redirect, never reads the response body, and gives up
 * after WEBHOOK_TIMEOUT_MS. Never throws.
 */
export async function postNotice(
  url: string,
  secret: string,
  body: string,
  noticeId: string,
  fetcher: typeof fetch,
  now = Date.now(),
): Promise<Attempt> {
  const timestamp = Math.floor(now / 1000);
  try {
    const response = await fetcher(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "msn-webhook/1",
        [ID_HEADER]: noticeId,
        [TIMESTAMP_HEADER]: String(timestamp),
        [SIGNATURE_HEADER]: `v1=${await signNotice(secret, timestamp, body)}`,
      },
      body,
    });
    // The receiver's answer is never read: only its status counts.
    await response.body?.cancel().catch(() => {});
    if (response.status >= 200 && response.status < 300) return { ok: true, httpStatus: response.status };
    if (response.status >= 300 && response.status < 400)
      return { ok: false, retry: false, httpStatus: response.status, error: "redirect_refused" };
    return {
      ok: false,
      retry: retryable(response.status),
      httpStatus: response.status,
      error: `http_${response.status}`,
    };
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return { ok: false, retry: true, httpStatus: null, error: timedOut ? "timeout" : "network_error" };
  }
}
