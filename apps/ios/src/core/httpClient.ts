import { ApiError, InsecureOriginError, NetworkError, ProtocolError, isAbortError } from "./errors.ts";
import type { ApiErrorBody } from "./types.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * HTTPS is required for every origin except an explicit localhost/127.0.0.1/[::1] development
 * server (matching the contract's "HTTPS except explicit localhost development"). Callers should
 * run this at onboarding time (before a session is ever persisted) and again defensively whenever
 * a client is constructed.
 */
export function validateOrigin(rawOrigin: string): URL {
  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw new InsecureOriginError("Enter a valid bare server origin.");
  }
  const isLocalhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new InsecureOriginError(
      "Use an https:// origin (http:// is only allowed for localhost development).",
    );
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.username || url.password || url.search || url.hash) {
    throw new InsecureOriginError("The origin must not include credentials, a path, query or fragment.");
  }
  return url;
}

/** 100 messages of 16 KiB each is ~1.6 MiB of text; 8 MiB leaves headroom for JSON escaping. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 20_000;

export type RequestLimits = { timeoutMs?: number; maxBytes?: number };

export type RequestOptions = RequestLimits & {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

/**
 * Every request stays on the configured origin. Expo SDK57's native fetch implements redirect
 * refusal in ios/Fetch/NativeResponse.swift (URLSession completionHandler(nil) for manual/error).
 * Import expo/fetch explicitly: EXPO_PUBLIC_USE_RN_FETCH can otherwise switch the global fetch
 * to React Native's older transport, where redirect:manual is unsupported. Lazy loading keeps
 * injected Node transport tests independent of native module initialization.
 * Never fall back to follow mode: checking response.url after following is too late to protect
 * the bearer credential. This applies to both authenticated and public onboarding requests.
 */
export class SecureFetcher {
  readonly origin: URL;
  private readonly fetchImpl: FetchLike;

  constructor(origin: string, fetchImpl?: FetchLike) {
    this.origin = validateOrigin(origin);
    this.fetchImpl = fetchImpl ?? (async (input, init) => {
      const { fetch: nativeFetch } = await import("expo/fetch");
      return nativeFetch(input, init) as unknown as Promise<Response>;
    });
  }

  async fetchJson<T>(url: string, init: RequestInit, limits: RequestLimits = {}): Promise<T> {
    const controller = new AbortController();
    const parent = init.signal ?? undefined;
    let timedOut = false;
    const forwardAbort = () => controller.abort();
    if (parent?.aborted) controller.abort();
    else parent?.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limits.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await this.fetchNoRedirect(url, { ...init, signal: controller.signal });
      if (response.status === 204) return undefined as T;
      const text = await readBoundedText(response, limits.maxBytes ?? MAX_RESPONSE_BYTES);
      let data: unknown;
      try {
        data = text ? (JSON.parse(text) as unknown) : undefined;
      } catch {
        if (response.ok) throw new ProtocolError("The server returned a response that is not valid JSON.");
        data = undefined;
      }
      if (!response.ok) {
        const body = data as ApiErrorBody | undefined;
        throw new ApiError(
          response.status,
          typeof body?.error?.code === "string" ? body.error.code : "unknown_error",
          typeof body?.error?.message === "string"
            ? body.error.message
            : response.statusText || "Request failed.",
        );
      }
      return data as T;
    } catch (error) {
      if (timedOut && !parent?.aborted) throw new NetworkError("The request timed out.");
      if (
        error instanceof ApiError ||
        error instanceof NetworkError ||
        error instanceof InsecureOriginError ||
        error instanceof ProtocolError ||
        isAbortError(error)
      )
        throw error;
      throw new NetworkError("The response could not be read.");
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", forwardAbort);
    }
  }

  private async fetchNoRedirect(url: string, init: RequestInit): Promise<Response> {
    const target = validateTarget(url, this.origin.origin);
    try {
      const response = await this.fetchImpl(target, { ...init, redirect: "manual", credentials: "omit" });
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        throw new InsecureOriginError("The server attempted a redirect; refusing to follow it.");
      }
      // Defense in depth for an injected/custom transport. The native transport never follows.
      if (response.url && new URL(response.url).origin !== this.origin.origin) {
        throw new InsecureOriginError("The transport returned a foreign response.");
      }
      return response;
    } catch (error) {
      if (error instanceof InsecureOriginError || isAbortError(error)) throw error;
      throw new NetworkError("Network request failed. No redirect retry was attempted.");
    }
  }

}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProtocolError("The server response exceeds the size budget.");
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxBytes) throw new ProtocolError("The server response exceeds the size budget.");
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ProtocolError("The server response exceeds the size budget.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function validateTarget(raw: string, origin: string): string {
  let target: URL;
  try { target = new URL(raw); } catch { throw new InsecureOriginError("Invalid request URL."); }
  if (target.origin !== origin || target.username || target.password || target.hash) {
    throw new InsecureOriginError("Refusing a request outside the configured origin.");
  }
  return target.toString();
}

function buildUrl(base: string, path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(base + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Authenticated client, scoped to one tenant + bearer token. */
export class HttpClient {
  private readonly fetcher: SecureFetcher;
  private readonly base: string;
  private readonly token: string;

  constructor(origin: string, tenant: string, token: string, fetchImpl?: FetchLike) {
    this.fetcher = new SecureFetcher(origin, fetchImpl);
    this.base = `${this.fetcher.origin.origin}/api/tenants/${encodeURIComponent(tenant)}`;
    this.token = token;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    return this.fetcher.fetchJson<T>(buildUrl(this.base, path, options.query), {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    }, { timeoutMs: options.timeoutMs, maxBytes: options.maxBytes });
  }
}

/** Pre-auth call: self-service workspace creation and invite redemption take no bearer token. */
export async function publicRequest<T>(
  origin: string,
  tenant: string,
  path: string,
  options: { method: "PUT" | "POST"; body?: unknown; fetchImpl?: FetchLike } ,
): Promise<T> {
  const fetcher = new SecureFetcher(origin, options.fetchImpl);
  const base = `${fetcher.origin.origin}/api/tenants/${encodeURIComponent(tenant)}`;
  return fetcher.fetchJson<T>(buildUrl(base, path), {
    method: options.method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options.body ?? {}),
  });
}
