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

/** Optional `replyTo` body field: absent/null means unset; otherwise a positive safe integer id. */
export function replyTarget(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new HttpError(400, "invalid_reply_to", "replyTo must be a positive integer message id.");
  }
  return value;
}

/** Optional `correlationId` body field: absent/null means unset; otherwise opaque text ≤ 128 bytes. */
export function correlationId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, "correlationId", 128);
}

/** Optional `to` body field: absent/null means unset; otherwise an opaque username label. */
export function recipient(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, "to", 128);
}

export const CONTENT_TYPES = ["text/plain", "application/json"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/** Optional payload typing: omitted means text/plain; application/json requires `text` to parse as JSON. */
export function contentType(value: unknown, content: string): ContentType {
  if (value === undefined) return "text/plain";
  if (!CONTENT_TYPES.includes(value as ContentType)) {
    throw new HttpError(400, "invalid_content_type", "contentType must be text/plain or application/json.");
  }
  if (value === "application/json") {
    try {
      JSON.parse(content);
    } catch {
      throw new HttpError(
        400,
        "invalid_message",
        "text must be valid JSON when contentType is application/json.",
      );
    }
  }
  return value as ContentType;
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

/** Snapshot preconditions are mandatory JSON numbers; strings and unsafe integers are rejected. */
export function snapshotInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new HttpError(400, "invalid_snapshot", `${field} must be a nonnegative safe integer.`);
  return value;
}

export function idempotencyKey(request: Request, required = false): string | null {
  const key = request.headers.get("Idempotency-Key");
  if ((required && key === null) || (key !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(key)))
    throw new HttpError(
      400,
      "invalid_key",
      "Idempotency-Key must be 1–128 letters, digits, underscores or hyphens.",
    );
  return key;
}

/** key=value message labels (ADR 0032). One value per key. */
export type Labels = Record<string, string>;
export const MAX_LABELS = 16;
const LABEL_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export function labelKey(value: unknown): string {
  if (typeof value !== "string" || !LABEL_KEY.test(value))
    throw new HttpError(
      400,
      "invalid_label",
      "Label keys are 1–64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit.",
    );
  return value;
}

export function labelValue(value: unknown, key: string): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    new TextEncoder().encode(value).length > 256 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we reject.
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    throw new HttpError(
      400,
      "invalid_label",
      `Label ${key} needs a value of 1–256 UTF-8 bytes without control characters such as newlines.`,
    );
  return value;
}

function labelObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "invalid_label", `${field} must be an object of key: value labels.`);
  return value as Record<string, unknown>;
}

/** Optional `labels` on send: absent/null means none; otherwise at most 16 key: value pairs. */
export function labels(value: unknown): Labels | undefined {
  if (value === undefined || value === null) return undefined;
  const entries = Object.entries(labelObject(value, "labels"));
  if (entries.length > MAX_LABELS)
    throw new HttpError(400, "label_limit", `A message can carry at most ${MAX_LABELS} labels.`);
  if (!entries.length) return undefined;
  const result: Labels = {};
  for (const [key, raw] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    result[labelKey(key)] = labelValue(raw, key);
  return result;
}

/** Body of POST …/messages/{id}/labels: what to set, what to remove, and an optional precondition. */
export type LabelChange = {
  set: Map<string, string>;
  unset: string[];
  condition: Map<string, string | null>;
};

export function labelChange(input: Record<string, unknown>): LabelChange {
  for (const field of Object.keys(input))
    if (!["set", "unset", "if"].includes(field))
      throw new HttpError(400, "invalid_label", `Unknown field ${field}; use set, unset and if.`);
  // Maps, not objects: a key such as "constructor" must never match an inherited property.
  const set = new Map<string, string>();
  for (const [key, raw] of Object.entries(input.set === undefined ? {} : labelObject(input.set, "set")))
    set.set(labelKey(key), labelValue(raw, key));
  if (input.unset !== undefined && !Array.isArray(input.unset))
    throw new HttpError(400, "invalid_label", "unset must be an array of label keys.");
  const unset = [...new Set(((input.unset as unknown[] | undefined) ?? []).map(labelKey))];
  if (unset.some((key) => set.has(key)))
    throw new HttpError(400, "invalid_label", "A key cannot be both set and unset in one change.");
  if (!set.size && !unset.length)
    throw new HttpError(400, "invalid_label", "Set or unset at least one label.");
  if (set.size + unset.length > MAX_LABELS * 2)
    throw new HttpError(400, "label_limit", "Too many labels in one change.");
  const condition = new Map<string, string | null>();
  for (const [key, raw] of Object.entries(input.if === undefined ? {} : labelObject(input.if, "if")))
    condition.set(labelKey(key), raw === null ? null : labelValue(raw, key));
  if (condition.size > MAX_LABELS)
    throw new HttpError(400, "label_limit", `A condition can test at most ${MAX_LABELS} labels.`);
  return { set, unset, condition };
}

/** One `label` query filter: a key, optionally restricted to one of several values. */
export type LabelFilter = { key: string; values: string[] | null };

/** `?label=state`, `?label=state=open` or `?label=state=open|draft`; repeated filters must all match. */
export function labelFilters(params: URLSearchParams): LabelFilter[] {
  const raw = params.getAll("label");
  if (raw.length > 8) throw new HttpError(400, "invalid_query", "Use at most 8 label filters.");
  return raw.map((filter) => {
    const split = filter.indexOf("=");
    const key = labelKey(split < 0 ? filter : filter.slice(0, split));
    if (split < 0) return { key, values: null };
    const values = filter.slice(split + 1).split("|");
    if (values.length > 8)
      throw new HttpError(400, "invalid_query", "Use at most 8 values per label filter.");
    return { key, values: values.map((value) => labelValue(value, key)) };
  });
}

/** Attachments (ADR 0035): small files stored in the workspace's own SQLite, never a new binding. */
export const MAX_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
/** An uploaded file that no message references after this long is deleted on a later upload. */
export const ATTACHMENT_ORPHAN_MS = 24 * 60 * 60 * 1000;
/** Images a browser may render inline; every other type is served as a download. */
export const INLINE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export type AttachmentRef = { id: string; name: string; mediaType: string };

/** Reads a raw request body of at most `maxBytes`; an empty body is rejected. */
export async function rawBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > maxBytes)
    throw new HttpError(413, "attachment_too_large", `An attachment cannot exceed ${maxBytes} bytes.`);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new HttpError(413, "attachment_too_large", `An attachment cannot exceed ${maxBytes} bytes.`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (!size) throw new HttpError(400, "invalid_attachment", "An attachment needs a non-empty body.");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function attachmentId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw new HttpError(
      400,
      "invalid_attachment",
      "Attachment id must be the 64-hex SHA-256 the upload returned.",
    );
  return value;
}

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const EXTENSION_TYPES: Record<string, string> = {
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  diff: "text/x-diff",
  patch: "text/x-diff",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

/** A display file name: no path separators or control characters, at most 255 UTF-8 bytes. */
export function attachmentName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value === "." ||
    value === ".." ||
    [...value].some(
      (c) =>
        c === "/" ||
        c === "\\" ||
        c.charCodeAt(0) < 0x20 ||
        (c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f) ||
        // Bidirectional overrides can make "gpj.exe" read as "exe.jpg".
        (c.charCodeAt(0) >= 0x202a && c.charCodeAt(0) <= 0x202e) ||
        (c.charCodeAt(0) >= 0x2066 && c.charCodeAt(0) <= 0x2069),
    ) ||
    new TextEncoder().encode(value).length > 255
  )
    throw new HttpError(
      400,
      "invalid_attachment",
      "Attachment name must be a file name of at most 255 UTF-8 bytes, without slashes, control or bidirectional override characters.",
    );
  return value;
}

/** Omitted means a guess from the name's extension, else application/octet-stream. */
export function mediaType(value: unknown, name: string): string {
  if (value === undefined || value === null) {
    const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1].toLowerCase() ?? "";
    return EXTENSION_TYPES[extension] ?? "application/octet-stream";
  }
  if (typeof value !== "string" || !MEDIA_TYPE.test(value))
    throw new HttpError(
      400,
      "invalid_attachment",
      "mediaType must be a lowercase type/subtype such as text/plain.",
    );
  return value;
}

/** Optional `attachments` send field: absent/null means none; otherwise 1–4 distinct references. */
export function attachmentRefs(value: unknown): AttachmentRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.length || value.length > MAX_ATTACHMENTS_PER_MESSAGE)
    throw new HttpError(
      400,
      "invalid_attachment",
      `attachments must be a list of 1 to ${MAX_ATTACHMENTS_PER_MESSAGE} uploaded files.`,
    );
  const refs = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new HttpError(400, "invalid_attachment", "Each attachment is an object with id and name.");
    const { id, name, mediaType: type, ...extra } = item as Record<string, unknown>;
    if (Object.keys(extra).length)
      throw new HttpError(400, "invalid_attachment", "An attachment takes only id, name and mediaType.");
    const fileName = attachmentName(name);
    return { id: attachmentId(id), name: fileName, mediaType: mediaType(type, fileName) };
  });
  if (new Set(refs.map((ref) => ref.name)).size !== refs.length)
    throw new HttpError(400, "invalid_attachment", "Attachment names must be distinct within a message.");
  return refs;
}

/** RFC 6266 filename for Content-Disposition: an ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(inline: boolean, name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  // RFC 5987 attr-chars exclude ' ( ) *, which encodeURIComponent leaves as they are.
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
