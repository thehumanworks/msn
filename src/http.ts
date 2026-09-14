export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export function failure(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  // Do not log request bodies, bearer credentials, or database errors containing data.
  console.error("Unexpected messaging service failure");
  return json(
    {
      error: {
        code: "internal_error",
        message: "Temporary service failure; retry safely with the same idempotency key.",
      },
    },
    500,
  );
}

export function slug(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new HttpError(
      400,
      "invalid_identifier",
      "Tenant and channel must be 1–64 lowercase letters, digits, hyphens or underscores.",
    );
  }
  return value;
}

export function integer(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw new HttpError(400, "invalid_query", `Expected an integer from 0 to ${max}.`);
  }
  return Number(value);
}

export function bearer(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.get("Authorization") ?? "");
  if (!match) throw new HttpError(401, "unauthorized", "A valid bearer access key is required.");
  return match[1];
}

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function equalHash(a: string, b: string): boolean {
  return crypto.subtle.timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b));
}

export async function admin(request: Request, env: Env): Promise<void> {
  if (!env.ADMIN_TOKEN)
    throw new HttpError(
      503,
      "admin_unconfigured",
      "Administration is disabled until an admin secret is configured.",
    );
  if (!equalHash(await digest(bearer(request)), await digest(env.ADMIN_TOKEN))) {
    throw new HttpError(403, "forbidden", "Administrator access required.");
  }
}

export function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") {
    throw new HttpError(415, "json_required", "Use Content-Type: application/json.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_json", "A JSON object is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) {
        await reader.cancel();
        throw new HttpError(413, "body_too_large", "JSON request body cannot exceed 32 KiB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new HttpError(400, "invalid_json", "A valid UTF-8 JSON object is required.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_json", "A JSON object is required.");
  }
  return parsed as Record<string, unknown>;
}

/** Admin routes take an optional JSON body: no Content-Type means "no fields", not an error. */
export async function optionalBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.has("Content-Type")) return {};
  return body(request);
}

export function text(value: unknown, field: string, maxBytes: number, code = "invalid_message"): string {
  if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).length > maxBytes) {
    throw new HttpError(400, code, `${field} must be non-blank text, at most ${maxBytes} UTF-8 bytes.`);
  }
  return value;
}

/** A token is bound to exactly one display name, to a name prefix, or to nothing. */
export type Binding = { username: string | null; prefix: string | null };

/**
 * Reads `username` / `usernamePrefix` from an admin body. Returns undefined when neither key is
 * present (provision: unbound; rotate: keep). An explicit null on either key clears the bind.
 */
export function binding(input: Record<string, unknown>): Binding | undefined {
  if (!("username" in input) && !("usernamePrefix" in input)) return undefined;
  const { username, usernamePrefix } = input;
  if (typeof username === "string" && typeof usernamePrefix === "string") {
    throw new HttpError(400, "invalid_binding", "Use either username or usernamePrefix, not both.");
  }
  if (typeof username === "string")
    return { username: text(username, "username", 128, "invalid_binding"), prefix: null };
  if (typeof usernamePrefix === "string") {
    return { username: null, prefix: text(usernamePrefix, "usernamePrefix", 128, "invalid_binding") };
  }
  if ((username ?? null) === null && (usernamePrefix ?? null) === null)
    return { username: null, prefix: null };
  throw new HttpError(400, "invalid_binding", "username and usernamePrefix must be strings or null.");
}
