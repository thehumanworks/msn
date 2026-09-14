import { DurableObject } from "cloudflare:workers";
import {
  admin,
  bearer,
  body,
  correlationId,
  digest,
  equalHash,
  failure,
  HttpError,
  integer,
  json,
  newToken,
  replyTarget,
  slug,
  text,
} from "./http";

export type Message = {
  id: number;
  tenant: string;
  channel: string;
  username: string;
  text: string;
  createdAt: string;
  /** Opaque correlation fields; absent from JSON when unset. The server never matches on them. */
  replyTo?: number;
  correlationId?: string;
};
/** Optional correlation input on send; `undefined` means "not supplied". */
export type Correlation = { replyTo?: number; correlationId?: string };
type MessageRow = {
  id: number;
  channel: string;
  username: string;
  text: string;
  createdAt: string;
  replyTo: number | null;
  correlationId: string | null;
};
const MESSAGE_COLUMNS = "id, channel, username, text, createdAt, replyTo, correlationId";
type Waiter = { channel: string; wake: () => void };
const MAX_MESSAGES = 100000;
const MAX_CONTENT_BYTES = 128 * 1024 * 1024;
const MAX_CHANNELS = 1000;
const MAX_WAITERS = 128;
const SCHEMA_VERSION = 2;

/** Old clients must keep seeing today's shape: unset correlation fields are omitted, not null. */
function toMessage(row: MessageRow, tenant: string): Message {
  const { replyTo, correlationId, ...rest } = row;
  return {
    ...rest,
    tenant,
    ...(replyTo === null ? {} : { replyTo }),
    ...(correlationId === null ? {} : { correlationId }),
  };
}

/**
 * Idempotency digest input. Sends without correlation fields hash exactly as before this
 * feature, so retries of messages stored under schema version 1 still replay instead of 409.
 */
export function payload(username: string, text: string, correlation: Correlation): string {
  const { replyTo, correlationId } = correlation;
  if (replyTo === undefined && correlationId === undefined) return JSON.stringify([username, text]);
  return JSON.stringify([username, text, replyTo ?? null, correlationId ?? null]);
}

/** One object per tenant. Channel indexes and message writes share one transaction boundary. */
export class MsnDurableObject extends DurableObject<Env> {
  private waiters = new Set<Waiter>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Synchronous constructor migration finishes before any request can enter.
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS tenant (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), token_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS channels (name TEXT PRIMARY KEY, createdAt TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL REFERENCES channels(name),
          username TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL,
          key TEXT, digest TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL,
          replyTo INTEGER, correlationId TEXT,
          UNIQUE(channel, key)
        );
        CREATE INDEX IF NOT EXISTS channel_messages ON messages(channel, deleted, id);
        CREATE TABLE IF NOT EXISTS usage (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), messages INTEGER NOT NULL, bytes INTEGER NOT NULL);
        INSERT OR IGNORE INTO usage VALUES (1, 0, 0);
        CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
      `);
      // schema_version lists every applied version; the highest row is the current schema.
      // A fresh database already has the current CREATE TABLE shape and only needs the marker.
      const version = ctx.storage.sql
        .exec<{ version: number | null }>("SELECT MAX(version) AS version FROM schema_version")
        .one().version;
      if (version === null) {
        ctx.storage.sql.exec("INSERT INTO schema_version VALUES (?)", SCHEMA_VERSION);
      } else if (version < 2) {
        // v1 → v2: opaque correlation fields (issue #4). Existing rows stay unset (NULL).
        ctx.storage.sql.exec("ALTER TABLE messages ADD COLUMN replyTo INTEGER");
        ctx.storage.sql.exec("ALTER TABLE messages ADD COLUMN correlationId TEXT");
        ctx.storage.sql.exec("INSERT INTO schema_version VALUES (2)");
      }
    });
  }

  private authorize(hash: string): void {
    const row = this.ctx.storage.sql
      .exec<{ token_hash: string }>("SELECT token_hash FROM tenant WHERE singleton = 1")
      .toArray()[0];
    if (!row || !equalHash(hash, row.token_hash))
      throw new HttpError(401, "unauthorized", "Unknown tenant or invalid access key.");
  }

  private requireTenant(): void {
    if (!this.ctx.storage.sql.exec("SELECT singleton FROM tenant").toArray().length)
      throw new HttpError(404, "tenant_not_found", "Tenant not found.");
  }

  private requireChannel(channel: string): void {
    if (!this.ctx.storage.sql.exec("SELECT name FROM channels WHERE name = ?", channel).toArray().length) {
      throw new HttpError(
        404,
        "channel_not_found",
        "Channel not found. Create it first, or send a message to create it.",
      );
    }
  }

  private createChannel(channel: string): boolean {
    if (this.ctx.storage.sql.exec("SELECT name FROM channels WHERE name = ?", channel).toArray().length)
      return false;
    const count = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM channels")
      .one().count;
    if (count >= MAX_CHANNELS) throw new HttpError(409, "channel_quota", "Tenant channel limit reached.");
    this.ctx.storage.sql.exec("INSERT INTO channels VALUES (?, ?)", channel, new Date().toISOString());
    return true;
  }

  private page(tenant: string, channel: string, after: number, limit: number) {
    const rows = this.ctx.storage.sql
      .exec<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel = ? AND deleted = 0 AND id > ? ORDER BY id LIMIT ?`,
        channel,
        after,
        limit + 1,
      )
      .toArray();
    const messages: Message[] = rows.slice(0, limit).map((row) => toMessage(row, tenant));
    return { messages, nextCursor: messages.at(-1)?.id ?? after, hasMore: rows.length > limit };
  }

  private poll(
    request: Request,
    hash: string,
    tenant: string,
    channel: string,
    after: number,
    limit: number,
    wait: number,
  ): Promise<Response> | Response {
    const page = this.page(tenant, channel, after, limit);
    if (page.messages.length || !wait) return json(page);
    if (this.waiters.size >= MAX_WAITERS)
      throw new HttpError(429, "too_many_polls", "At most 128 pending polls per tenant; retry with backoff.");
    // No await between SELECT and registration: sends cannot fall into a lost-wakeup gap.
    return new Promise((resolve) => {
      let finished = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        request.signal.removeEventListener("abort", abort);
      };
      const finish = (aborted = false) => {
        if (finished) return;
        try {
          this.authorize(hash); // Rotation revokes already-pending polls, too.
          const next = this.page(tenant, channel, after, limit);
          finished = true;
          cleanup();
          resolve(
            aborted ? json({ error: { code: "poll_aborted", message: "Poll cancelled." } }, 499) : json(next),
          );
        } catch (error) {
          finished = true;
          cleanup();
          resolve(failure(error));
        }
      };
      const waiter: Waiter = {
        channel,
        wake: () => {
          // Future cursors must not get woken by earlier messages.
          try {
            this.authorize(hash);
          } catch {
            finish();
            return;
          }
          if (this.page(tenant, channel, after, limit).messages.length) finish();
        },
      };
      const abort = () => finish(true);
      const timer = setTimeout(finish, wait * 1000);
      this.waiters.add(waiter);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
    });
  }

  private send(
    tenant: string,
    channel: string,
    username: string,
    content: string,
    correlation: Correlation,
    key: string | null,
    hash: string,
  ): Response {
    const result = this.ctx.storage.transactionSync(() => {
      if (key) {
        const old = this.ctx.storage.sql
          .exec<MessageRow & { digest: string; deleted: number }>(
            `SELECT ${MESSAGE_COLUMNS}, digest, deleted FROM messages WHERE channel = ? AND key = ?`,
            channel,
            key,
          )
          .toArray()[0];
        if (old) {
          if (old.digest !== hash)
            throw new HttpError(
              409,
              "idempotency_conflict",
              "This idempotency key was used for different content.",
            );
          if (old.deleted)
            throw new HttpError(
              410,
              "message_deleted",
              "The original message was deleted; retries cannot resurrect it.",
            );
          const { digest: _digest, deleted: _deleted, ...message } = old;
          return { message: toMessage(message, tenant), replayed: true };
        }
      }
      // replyTo is only interpretable within one channel's log; a tombstoned id still counts as
      // "existed here", so a reply racing an admin deletion is not rejected.
      if (
        correlation.replyTo !== undefined &&
        !this.ctx.storage.sql
          .exec("SELECT id FROM messages WHERE channel = ? AND id = ?", channel, correlation.replyTo)
          .toArray().length
      ) {
        throw new HttpError(
          400,
          "invalid_reply_to",
          "replyTo must be the id of an existing message in this channel.",
        );
      }
      const usage = this.ctx.storage.sql
        .exec<{ messages: number; bytes: number }>("SELECT messages, bytes FROM usage")
        .one();
      const bytes = new TextEncoder().encode(username + content).length;
      if (usage.messages >= MAX_MESSAGES || usage.bytes + bytes > MAX_CONTENT_BYTES) {
        throw new HttpError(
          409,
          "storage_quota",
          "Tenant quota reached (100,000 lifetime messages or 128 MiB active content). Contact the administrator.",
        );
      }
      this.createChannel(channel);
      const message = this.ctx.storage.sql
        .exec<MessageRow>(
          `INSERT INTO messages(channel, username, text, createdAt, key, digest, bytes, replyTo, correlationId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${MESSAGE_COLUMNS}`,
          channel,
          username,
          content,
          new Date().toISOString(),
          key,
          hash,
          bytes,
          correlation.replyTo ?? null,
          correlation.correlationId ?? null,
        )
        .one();
      this.ctx.storage.sql.exec(
        "UPDATE usage SET messages = messages + 1, bytes = bytes + ? WHERE singleton = 1",
        bytes,
      );
      return { message: toMessage(message, tenant), replayed: false };
    });
    // transactionSync succeeded; output gates delay network replies until durable commit.
    if (!result.replayed) for (const waiter of this.waiters) if (waiter.channel === channel) waiter.wake();
    return json(result, result.replayed ? 200 : 201);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").slice(1);
      const isAdmin = parts[1] === "admin";
      const tenantIndex = isAdmin ? 3 : 2;
      const tenant = slug(parts[tenantIndex] ?? "");
      const rest = parts.slice(tenantIndex + 1);
      if (isAdmin) {
        await admin(request, this.env);
        if (!rest.length && request.method === "PUT") {
          const token = newToken();
          const hash = await digest(token);
          if (this.ctx.storage.sql.exec("SELECT singleton FROM tenant").toArray().length)
            throw new HttpError(409, "tenant_exists", "Tenant already exists. Rotate its key instead.");
          this.ctx.storage.sql.exec("INSERT INTO tenant VALUES (1, ?)", hash);
          return json({ tenant, token }, 201);
        }
        this.requireTenant();
        if (rest.length === 1 && rest[0] === "token" && request.method === "POST") {
          const token = newToken();
          const hash = await digest(token);
          this.ctx.storage.sql.exec("UPDATE tenant SET token_hash = ? WHERE singleton = 1", hash);
          for (const waiter of this.waiters) waiter.wake();
          return json({ tenant, token });
        }
        if (
          rest.length === 4 &&
          rest[0] === "channels" &&
          rest[2] === "messages" &&
          request.method === "DELETE"
        ) {
          const channel = slug(rest[1]);
          const id = integer(rest[3], 0, Number.MAX_SAFE_INTEGER);
          this.ctx.storage.transactionSync(() => {
            const row = this.ctx.storage.sql
              .exec<{ bytes: number }>(
                "SELECT bytes FROM messages WHERE channel = ? AND id = ? AND deleted = 0",
                channel,
                id,
              )
              .toArray()[0];
            if (!row) throw new HttpError(404, "message_not_found", "Message not found.");
            // Keep only a retry tombstone; content and display identity are removed.
            this.ctx.storage.sql.exec(
              "UPDATE messages SET deleted = 1, username = '', text = '', bytes = 0 WHERE id = ?",
              id,
            );
            this.ctx.storage.sql.exec("UPDATE usage SET bytes = bytes - ? WHERE singleton = 1", row.bytes);
          });
          return new Response(null, { status: 204 });
        }
      } else {
        const hash = await digest(bearer(request));
        // Parse/digest before the final authorization check: rotation cannot race a write.
        const input =
          request.method === "POST" && rest.length === 3 && rest[2] === "messages"
            ? await body(request)
            : null;
        const username = input ? text(input.username, "username", 128) : "";
        const content = input ? text(input.text, "text", 16384) : "";
        const correlation: Correlation = input
          ? { replyTo: replyTarget(input.replyTo), correlationId: correlationId(input.correlationId) }
          : {};
        const payloadHash = input ? await digest(payload(username, content, correlation)) : "";
        this.authorize(hash);
        if (rest[0] === "channels" && rest.length === 1 && request.method === "GET") {
          const after = url.searchParams.get("after") ?? "";
          if (after) slug(after);
          const limit = integer(url.searchParams.get("limit"), 100, 1000);
          if (!limit) throw new HttpError(400, "invalid_query", "limit must be positive.");
          const channels = this.ctx.storage.sql
            .exec<{ name: string; createdAt: string }>(
              "SELECT name, createdAt FROM channels WHERE name > ? ORDER BY name LIMIT ?",
              after,
              limit + 1,
            )
            .toArray();
          return json({
            channels: channels.slice(0, limit),
            nextCursor: channels.slice(0, limit).at(-1)?.name ?? after,
            hasMore: channels.length > limit,
          });
        }
        if (rest[0] === "channels" && rest[1]) {
          const channel = slug(rest[1]);
          if (rest.length === 2 && request.method === "PUT") {
            const created = this.createChannel(channel);
            return json({ channel, created }, created ? 201 : 200);
          }
          if (rest.length === 3 && rest[2] === "messages") {
            if (request.method === "POST") {
              const key = request.headers.get("Idempotency-Key");
              if (key !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(key))
                throw new HttpError(
                  400,
                  "invalid_key",
                  "Idempotency-Key must be 1–128 letters, digits, underscores or hyphens.",
                );
              return this.send(tenant, channel, username, content, correlation, key, payloadHash);
            }
            if (request.method === "GET") {
              this.requireChannel(channel);
              const after = integer(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER);
              const limit = integer(url.searchParams.get("limit"), 100, 100);
              const wait = integer(url.searchParams.get("wait"), 0, 25);
              if (!limit) throw new HttpError(400, "invalid_query", "limit must be positive.");
              return await this.poll(request, hash, tenant, channel, after, limit, wait);
            }
          }
        }
      }
      throw new HttpError(
        404,
        "route_not_found",
        "Unknown endpoint or method. Message deletion is only available under /api/admin/.",
      );
    } catch (error) {
      return failure(error);
    }
  }
}
