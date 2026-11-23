// Wake an agent with a webhook (ADR 0062). The owner registers an https URL for a board persona;
// when a message is addressed to that persona, the workspace's Durable Object POSTs a small
// notice there, with the owner's optional bearer key in Authorization. The notice never holds
// message text: the agent reads the message through the API with its own key. Pure helpers live here; storage and delivery live in store.ts.
import { HttpError } from "./http";

/** Longest webhook URL accepted, in characters. */
export const MAX_WEBHOOK_URL = 2048;
/** One attempt may take this long, from connect to response headers. */
export const WEBHOOK_TIMEOUT_MS = 5000;
/** A notice body never exceeds this many bytes (it holds ids only). */
/** Ten named files fit; a text-only notice stays a few hundred bytes (ADR 0087). */
export const MAX_NOTICE_BYTES = 16 * 1024;
/** Waits after attempt 1, 2, 3 and 4. Five attempts in all, over about 73 minutes. */
export const WEBHOOK_RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000];
/** Notices waiting per webhook; more are dropped and the drop is recorded. */
export const MAX_PENDING_NOTICES = 50;
/** Webhooks per workspace. */
export const MAX_WEBHOOKS = 100;
/** Notices sent per alarm run; the alarm runs again at once while more are due. */
export const WEBHOOK_BATCH = 20;

export const TIMESTAMP_HEADER = "MSN-Webhook-Timestamp";
export const ID_HEADER = "MSN-Webhook-Id";

/** This Worker's own workers.dev address (the Worker is named "msn" in wrangler.jsonc). */
const OWN_WORKERS_DEV = /^msn\.[a-z0-9-]+\.workers\.dev$/;

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
 * IPv6 literals: only global unicast (2000::/3) outside documentation, 6to4 and Teredo space is
 * allowed. That refuses loopback (::1), unspecified (::), IPv4-mapped (::ffff:…), unique local
 * (fc00::/7), link-local (fe80::/10) and multicast (ff00::/8).
 */
function privateIpv6(host: string): boolean | null {
  if (!host.startsWith("[")) return null;
  const inner = host.slice(1, -1).toLowerCase();
  const [first, second] = inner.split(":");
  if (!first || first.length > 4) return true;
  const word = Number.parseInt(first, 16);
  if (!Number.isFinite(word) || word < 0x2000 || word > 0x3fff) return true;
  // 6to4 (2002::/16) and Teredo (2001::/32) embed IPv4 addresses that may be private.
  if (word === 0x2002) return true;
  if (word === 0x2001 && (!second || Number.parseInt(second, 16) === 0)) return true;
  // Documentation space.
  return word === 0x2001 && Number.parseInt(second, 16) === 0xdb8;
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
export function webhookUrl(value: unknown, selfHosts: string[]): string {
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
      "Put no user name or password in the URL; give a bearer key instead.",
    );
  if (url.port)
    throw new HttpError(
      400,
      "webhook_port_refused",
      "Use the default https port (443); other ports are refused.",
    );
  if (url.hash) throw new HttpError(400, "invalid_webhook", "Remove the #fragment from the URL.");
  // A trailing dot names the same host ("msn.example.com." is "msn.example.com").
  const bare = (host: string) => host.toLowerCase().replace(/\.+$/, "");
  if (
    privateHost(url.hostname) ||
    selfHosts.some((host) => bare(host) === bare(url.hostname)) ||
    OWN_WORKERS_DEV.test(bare(url.hostname))
  )
    throw new HttpError(
      400,
      "webhook_host_refused",
      "The URL must point at a public host: loopback, private, link-local and this server's own address are refused.",
    );
  return url.href;
}

/**
 * What a webhook subscribes to (ADR 0076). Each level includes the one before it:
 * `addressed` (the default) is messages addressed to the persona; `board` adds every other
 * message on the persona's board; `workspace` adds every message on every board.
 */
export const SUBSCRIPTIONS = ["addressed", "board", "workspace"] as const;
export type Subscription = (typeof SUBSCRIPTIONS)[number];

/** Optional `subscribe` on PUT: absent or null means `addressed`. */
export function webhookSubscription(value: unknown): Subscription {
  if (value === undefined || value === null) return "addressed";
  if (typeof value !== "string" || !(SUBSCRIPTIONS as readonly string[]).includes(value))
    throw new HttpError(
      400,
      "invalid_webhook_subscribe",
      "subscribe must be addressed (the default), board or workspace.",
    );
  return value as Subscription;
}

/** A stored value read back; anything unknown is the narrowest level. */
export function storedSubscription(value: unknown): Subscription {
  return value === "board" || value === "workspace" ? value : "addressed";
}

/** The notice body (`msn.webhook.v1`). Ids only: never message text, sender text or keys. */
export type Notice = {
  schema: "msn.webhook.v1";
  /**
   * `message.addressed`: the message names the persona. `message.posted`: another message the
   * webhook subscribes to (`board` or `workspace`). `ping`: a test.
   */
  type: "message.addressed" | "message.posted" | "ping";
  /** This notice's id; the same on every retry, so a receiver can drop repeats. */
  id: string;
  tenant: string;
  /** The board the message is on (for a ping, the persona's board). */
  channel: string;
  /** The persona id the webhook belongs to. */
  persona: string;
  /** The board the persona is on; it differs from `channel` only for a `workspace` webhook. */
  personaChannel: string;
  /** What the webhook subscribes to. */
  subscribe: Subscription;
  /** The addressed message, or null for a ping. */
  messageId: number | null;
  /** The board event (GET …/events) that recorded the message, or null for a ping. */
  eventId: number | null;
  /** Where to read the message with your own key, or null for a ping. */
  messageUrl: string | null;
  createdAt: string;
  /**
   * Files on the message (ADR 0087). Absent when it has none, so a text notice stays the id list.
   * `url` is absolute and still needs the receiver's own key. The name is the sender's and leaves
   * the workspace. The bytes are not included.
   */
  attachments?: {
    index: number;
    id: string;
    name: string;
    mime: string;
    size: number;
    url: string;
    width?: number;
    height?: number;
  }[];
};

function encodedNotice(notice: Notice): string {
  const body = JSON.stringify(notice);
  if (new TextEncoder().encode(body).length > MAX_NOTICE_BYTES) throw new Error("webhook notice too large");
  return body;
}

/** The notice, or the same notice without its file list when that list is what would drop the wake. */
export function noticeBody(notice: Notice): string {
  try {
    return encodedNotice(notice);
  } catch (error) {
    if (!notice.attachments?.length) throw error;
    const { attachments: _attachments, ...rest } = notice;
    return encodedNotice(rest);
  }
}

/** Longest bearer key accepted, in characters. */
export const MAX_BEARER_LENGTH = 1024;

/**
 * Optional `bearer` on PUT: absent or null means none. Otherwise 8 to 1024 visible ASCII
 * characters (no spaces or control characters), so it is always one valid header value.
 */
export function webhookBearer(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[\x21-\x7e]{8,1024}$/.test(value))
    throw new HttpError(
      400,
      "invalid_webhook_bearer",
      `bearer must be 8 to ${MAX_BEARER_LENGTH} visible ASCII characters without spaces; give the key alone, without "Bearer ".`,
    );
  return value;
}

/** Default receivers get the original notice, unchanged. Text-envelope transports are explicit opt-ins. */
export type WakeFormat = "notice" | "text" | "claude-routine";

export function wakeFormat(value: unknown): WakeFormat {
  if (value === undefined || value === "notice") return "notice";
  if (value === "text" || value === "claude-routine") return value;
  throw new HttpError(
    400,
    "invalid_webhook_format",
    "Use notice, text or claude-routine as the webhook format.",
  );
}

/** The extra headers belong ONLY at the documented task trigger, not at arbitrary receiver URLs. */
export function checkWakeTarget(format: WakeFormat, url: string, bearer: string | null): void {
  if (format !== "claude-routine") return;
  if (!/^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9_-]+\/fire$/.test(url))
    throw new HttpError(
      400,
      "invalid_webhook_target",
      "Paste the HTTPS API trigger URL from the Claude Code task.",
    );
  if (!bearer)
    throw new HttpError(
      400,
      "webhook_bearer_required",
      "Use the task's trigger bearer key, not an MSN board key.",
    );
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
 * POSTs one notice, with `Authorization: Bearer KEY` when the webhook has a bearer key. Never
 * follows a redirect, never reads the response body, and gives up after WEBHOOK_TIMEOUT_MS.
 * Never throws.
 */
export async function postNotice(
  url: string,
  bearer: string | null,
  body: string,
  noticeId: string,
  fetcher: typeof fetch,
  now = Date.now(),
  format: WakeFormat = "notice",
): Promise<Attempt> {
  // Recheck at delivery as well as at save. Never reinterpret an unknown stored format.
  try {
    checkWakeTarget(wakeFormat(format), url, bearer);
  } catch {
    return { ok: false, retry: false, httpStatus: null, error: "invalid_wake_configuration" };
  }
  const timestamp = Math.floor(now / 1000);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "msn-webhook/1",
    [ID_HEADER]: noticeId,
    [TIMESTAMP_HEADER]: String(timestamp),
  };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (format === "claude-routine") {
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-beta"] = "experimental-cc-routine-2026-04-01";
  }
  try {
    const response = await fetcher(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      headers,
      body: format === "notice" ? body : JSON.stringify({ text: body }),
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
