// Web Push for owner notifications (ADR 0029): VAPID (RFC 8292) and aes128gcm payload
// encryption (RFC 8291, RFC 8188), using only WebCrypto. No third-party SDK.
import { HttpError } from "./http";

/** Push services the Worker may call. The owner supplies the URL, so it is never arbitrary. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

export type PushSubscription = { endpoint: string; p256dh: string; auth: string };
export type VapidKeys = { publicKey: string; privateJwk: string };

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const encoder = new TextEncoder();

/** Validate an owner-supplied browser subscription before it is stored. */
export function parseSubscription(input: unknown): PushSubscription {
  const value = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = value?.endpoint;
  if (typeof endpoint !== "string" || endpoint.length > 2048)
    throw new HttpError(400, "invalid_subscription", "Send the browser's push subscription.");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new HttpError(400, "invalid_subscription", "Send the browser's push subscription.");
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !PUSH_HOSTS.some((h) => h.test(url.hostname))
  )
    throw new HttpError(400, "push_service_unsupported", "This push service is not supported.");
  const p256dh = value?.keys?.p256dh;
  const auth = value?.keys?.auth;
  let ok = typeof p256dh === "string" && typeof auth === "string";
  if (ok) {
    try {
      const key = fromBase64url(p256dh as string);
      ok = key.length === 65 && key[0] === 4 && fromBase64url(auth as string).length === 16;
    } catch {
      ok = false;
    }
  }
  if (!ok) throw new HttpError(400, "invalid_subscription", "Send the browser's push subscription.");
  return { endpoint: url.href, p256dh: p256dh as string, auth: auth as string };
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: base64url(raw), privateJwk: JSON.stringify(jwk) };
}

/** `Authorization` header value for one push service origin (RFC 8292). */
export async function vapidAuthorization(
  keys: VapidKeys,
  endpoint: string,
  subject: string,
  now = Date.now(),
): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 3600,
        sub: subject,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(keys.privateJwk),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${claims}`)),
  );
  return `vapid t=${header}.${claims}.${base64url(signature)}, k=${keys.publicKey}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8),
  );
}

/** One aes128gcm record for the subscription's keys (RFC 8291 section 3.4). */
export async function encryptPayload(
  subscription: Pick<PushSubscription, "p256dh" | "auth">,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const uaPublic = fromBase64url(subscription.p256dh);
  const authSecret = fromBase64url(subscription.auth);
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      // workerd types spell the WebCrypto `public` member as `$public`; the runtime reads `public`.
      { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      local.privateKey,
      256,
    ),
  );
  const ikm = await hkdf(
    authSecret,
    shared,
    concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // A single record ends with the 0x02 delimiter and no padding.
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))),
  );
  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

export type PushResult = "sent" | "gone" | "failed";

export async function sendPush(
  keys: VapidKeys,
  subscription: PushSubscription,
  subject: string,
  payload: unknown,
  fetcher: typeof fetch = fetch,
): Promise<PushResult> {
  const body = await encryptPayload(subscription, encoder.encode(JSON.stringify(payload)));
  try {
    const response = await fetcher(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(keys, subscription.endpoint, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: "high",
      },
      body,
    });
    await response.body?.cancel();
    if (response.status === 404 || response.status === 410) return "gone";
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

export type Attention = {
  reason: "board_blocked" | "task_blocked" | "question" | "job_failed";
  summary: string;
};

function excerpt(value: string, limit = 140): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * Does this new message mean an agent needs the owner? Pure; only reads the message itself.
 * Message text is untrusted: it only ever becomes notification text, never markup or a URL.
 */
export function needsOwner(
  message: { username: string; text: string; contentType: string; to?: string },
  owners: Set<string>,
): Attention | null {
  if (owners.has(message.username)) return null;
  if (message.contentType === "application/json") {
    let data: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(message.text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
    } catch {}
    if (data?.schema === "msn.board.v1" && data.status === "blocked")
      return {
        reason: "board_blocked",
        summary: `Board blocked${typeof data.goal === "string" ? `: ${excerpt(data.goal)}` : ""}`,
      };
    if (data?.schema === "msn.task.v1" && data.action === "block")
      return {
        reason: "task_blocked",
        summary: `${typeof data.task === "string" ? `Task ${excerpt(data.task, 64)}` : "Task"} blocked${
          typeof data.reason === "string" ? `: ${excerpt(data.reason)}` : ""
        }`,
      };
    if (data?.schema === "msn.host.status.v1" && data.status === "failed")
      return {
        reason: "job_failed",
        summary: `A job failed${typeof data.reason === "string" ? `: ${excerpt(data.reason, 64)}` : ""}`,
      };
  }
  if (message.to !== undefined && owners.has(message.to))
    return { reason: "question", summary: excerpt(message.text) };
  return null;
}
