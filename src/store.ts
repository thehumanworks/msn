import { DurableObject } from "cloudflare:workers";
import {
  admin,
  type Binding,
  bearer,
  binding,
  body,
  type ContentType,
  contentType,
  correlationId,
  digest,
  equalHash,
  failure,
  HttpError,
  idempotencyKey,
  integer,
  json,
  newToken,
  optionalBody,
  recipient,
  replyTarget,
  slug,
  snapshotInteger,
  text,
} from "./http";

export type Message = {
  id: number;
  tenant: string;
  channel: string;
  username: string;
  text: string;
  contentType: ContentType;
  createdAt: string;
  /** Opaque annotations; absent from JSON when unset. The server never matches on them. */
  replyTo?: number;
  correlationId?: string;
  to?: string;
};
/** Optional annotation input on send; `undefined` means "not supplied". */
export type Correlation = { replyTo?: number; correlationId?: string; to?: string };
type MessageRow = {
  id: number;
  channel: string;
  username: string;
  text: string;
  contentType: ContentType;
  createdAt: string;
  replyTo: number | null;
  correlationId: string | null;
  recipient: string | null;
};
const MESSAGE_COLUMNS =
  "id, channel, username, text, contentType, createdAt, replyTo, correlationId, recipient";
type TenantRow = {
  token_hash: string;
  bound_username: string | null;
  bound_prefix: string | null;
  channel_scope?: string | null;
};
type AccessKeyRow = TenantRow & { id: string; createdAt: string };
const KEY_METADATA = "id, bound_username AS username, bound_prefix AS usernamePrefix, createdAt";
type Waiter = { channel: string; wake: () => void };
/** `channel: null` matches every channel (unscoped tokens polling the whole tenant). */
type EventWaiter = { channel: string | null; wake: () => void };
const MAX_MESSAGES = 100000;
const MAX_CONTENT_BYTES = 128 * 1024 * 1024;
const MAX_CHANNELS = 1000;
const MAX_WAITERS = 128;
const MAX_KEYS = 1000;
const SCHEMA_VERSION = 9;
type InviteRow = {
  id: string;
  code_hash: string;
  creator_hash: string;
  channel: string | null;
  expiresAt: number;
  remaining: number;
};
const MAX_SNAPSHOTS = 1000;
// Exact upper bound: every message can be created and later deleted, every channel and every
// snapshot emits one event. Fail-closed capacity, never reached while other quotas hold.
const MAX_EVENTS = MAX_MESSAGES * 2 + MAX_CHANNELS + MAX_SNAPSHOTS;
const SNAPSHOT_COLUMNS =
  "channel, version, username, text, coversThrough, historyRevision, createdAt, invalidated";
type SnapshotRow = {
  channel: string;
  version: number;
  username: string;
  text: string;
  coversThrough: number;
  historyRevision: number;
  createdAt: string;
  invalidated: number;
};
function toSnapshot(row: SnapshotRow, tenant: string) {
  const { invalidated, ...snapshot } = row;
  return { ...snapshot, tenant, invalidated: Boolean(invalidated) };
}

export type EventType = "channel.created" | "message.created" | "message.deleted" | "snapshot.published";
export type CoordinationEvent = {
  id: number;
  tenant: string;
  channel: string;
  type: EventType;
  resourceId: number | null;
  historyRevision: number;
  createdAt: string;
};
type EventRow = {
  id: number;
  channel: string;
  type: EventType;
  resourceId: number | null;
  historyRevision: number;
  createdAt: string;
};
const EVENT_COLUMNS = "id, channel, type, resourceId, historyRevision, createdAt";
function toEvent(row: EventRow, tenant: string): CoordinationEvent {
  return { ...row, tenant };
}

/** Old clients must keep seeing today's shape: unset annotations are omitted, not null. */
function toMessage(row: MessageRow, tenant: string): Message {
  const { replyTo, correlationId, recipient, ...rest } = row;
  return {
    ...rest,
    tenant,
    ...(replyTo === null ? {} : { replyTo }),
    ...(correlationId === null ? {} : { correlationId }),
    ...(recipient === null ? {} : { to: recipient }),
  };
}

/** Path ids are positive safe canonical integers; 0 and leading zeros are rejected. */
function messageId(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new HttpError(400, "invalid_query", "Message id must be a positive safe integer.");
  }
  return Number(value);
}

/**
 * Idempotency digest input. A plain text/plain send without correlation fields hashes exactly as
 * it did before either feature, so retries of messages stored under schema version 1 still replay
 * instead of 409. Any typed or annotated send hashes over every field that distinguishes it.
 */
export function payload(username: string, text: string, type: ContentType, correlation: Correlation): string {
  const { replyTo, correlationId, to } = correlation;
  const fields =
    type === "text/plain" && replyTo === undefined && correlationId === undefined
      ? [username, text]
      : [username, text, type, replyTo ?? null, correlationId ?? null];
  if (to !== undefined) fields.push(to);
  return JSON.stringify(fields);
}

/** One object per tenant. Channel indexes and message writes share one transaction boundary. */
export class MsnDurableObject extends DurableObject<Env> {
  private waiters = new Set<Waiter>();
  private eventWaiters = new Set<EventWaiter>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Synchronous constructor migration finishes before any request can enter.
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS tenant (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1), token_hash TEXT NOT NULL,
          bound_username TEXT, bound_prefix TEXT
        );
        CREATE TABLE IF NOT EXISTS access_keys (
          id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
          bound_username TEXT, bound_prefix TEXT, createdAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS channels (name TEXT PRIMARY KEY, createdAt TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL REFERENCES channels(name),
          username TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL,
          key TEXT, digest TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL,
          replyTo INTEGER, correlationId TEXT, recipient TEXT,
          contentType TEXT NOT NULL DEFAULT 'text/plain',
          UNIQUE(channel, key)
        );
        CREATE INDEX IF NOT EXISTS channel_messages ON messages(channel, deleted, id);
        CREATE TABLE IF NOT EXISTS usage (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), messages INTEGER NOT NULL, bytes INTEGER NOT NULL);
        INSERT OR IGNORE INTO usage VALUES (1, 0, 0);
        CREATE TABLE IF NOT EXISTS channel_history (
          channel TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS snapshots (
          channel TEXT NOT NULL, version INTEGER NOT NULL, username TEXT NOT NULL, text TEXT NOT NULL,
          coversThrough INTEGER NOT NULL, historyRevision INTEGER NOT NULL, createdAt TEXT NOT NULL,
          key TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL,
          invalidated INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(channel, version), UNIQUE(channel, key)
        );
        CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS invites (
          id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, creator_hash TEXT NOT NULL,
          channel TEXT, expiresAt INTEGER NOT NULL, remaining INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, type TEXT NOT NULL,
          resourceId INTEGER, historyRevision INTEGER NOT NULL, createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_channel ON events(channel, id);
      `);
      // schema_version lists every applied version; the highest row is the current schema. A fresh
      // database already has the current CREATE TABLE shape, so it records the history and stops.
      const version = ctx.storage.sql
        .exec<{ version: number | null }>("SELECT MAX(version) AS version FROM schema_version")
        .one().version;
      // Inspect columns so constructor migrations also handle restored pre-v8 databases.
      if (
        !ctx.storage.sql
          .exec<{ name: string }>("PRAGMA table_info(access_keys)")
          .toArray()
          .some((column) => column.name === "channel_scope")
      )
        ctx.storage.sql.exec("ALTER TABLE access_keys ADD COLUMN channel_scope TEXT");
      if (version === null) {
        for (let applied = 1; applied <= SCHEMA_VERSION; applied++)
          ctx.storage.sql.exec("INSERT INTO schema_version VALUES (?)", applied);
      } else {
        if (version < 2) {
          // v1 → v2: opaque correlation fields (ADR 0003). Existing rows stay unset (NULL).
          ctx.storage.sql.exec("ALTER TABLE messages ADD COLUMN replyTo INTEGER");
          ctx.storage.sql.exec("ALTER TABLE messages ADD COLUMN correlationId TEXT");
          ctx.storage.sql.exec("INSERT INTO schema_version VALUES (2)");
        }
        if (version < 3) {
          // v2 → v3: optional payload typing (ADR 0004). Existing rows read back as text/plain.
          ctx.storage.sql.exec(
            "ALTER TABLE messages ADD COLUMN contentType TEXT NOT NULL DEFAULT 'text/plain'",
          );
          ctx.storage.sql.exec("INSERT INTO schema_version VALUES (3)");
        }
        if (version < 4) {
          // v3 → v4: a token may be bound to one display name or a name prefix (ADR 0005).
          // Existing tenants stay unbound (NULL).
          ctx.storage.sql.exec("ALTER TABLE tenant ADD COLUMN bound_username TEXT");
          ctx.storage.sql.exec("ALTER TABLE tenant ADD COLUMN bound_prefix TEXT");
          ctx.storage.sql.exec("INSERT INTO schema_version VALUES (4)");
        }
        // v4 → v5 is additive: legacy workspace keys and messages are untouched.
        if (version < 5) ctx.storage.sql.exec("INSERT INTO schema_version VALUES (5)");
        if (version < 6) {
          // v5 → v6: optional recipient display label. Existing history stays unaddressed (NULL).
          ctx.storage.sql.exec("ALTER TABLE messages ADD COLUMN recipient TEXT");
          ctx.storage.sql.exec("INSERT INTO schema_version VALUES (6)");
        }
        if (version < 7) ctx.storage.sql.exec("INSERT INTO schema_version VALUES (7)");
        if (version < 8) ctx.storage.sql.exec("INSERT INTO schema_version VALUES (8)");
        if (version < 9) {
          // v8 → v9: durable coordination event journal (ADR 0017). It starts empty at the
          // migration point; pre-existing messages/channels/snapshots are not backfilled.
          ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS events (
              id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, type TEXT NOT NULL,
              resourceId INTEGER, historyRevision INTEGER NOT NULL, createdAt TEXT NOT NULL
            );
          `);
          ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS events_channel ON events(channel, id)");
          ctx.storage.sql.exec("INSERT INTO schema_version VALUES (9)");
        }
      }
    });
  }

  private tenantRow(): TenantRow | undefined {
    return this.ctx.storage.sql
      .exec<TenantRow>("SELECT token_hash, bound_username, bound_prefix FROM tenant WHERE singleton = 1")
      .toArray()[0];
  }

  private authorize(hash: string): TenantRow {
    const row = this.tenantRow();
    if (row && equalHash(hash, row.token_hash)) return row;
    const key = this.ctx.storage.sql
      .exec<AccessKeyRow>("SELECT * FROM access_keys WHERE token_hash = ?", hash)
      .toArray()[0];
    if (row && key) return key;
    throw new HttpError(401, "unauthorized", "Unknown tenant or invalid access key.");
  }

  /** A bound capability may only send as its bound name (or under its bound prefix). */
  private requireBoundName(row: TenantRow, username: string): void {
    if (row.bound_username !== null && username !== row.bound_username) {
      throw new HttpError(403, "username_bound", `This access key may only send as "${row.bound_username}".`);
    }
    if (row.bound_prefix !== null && !username.startsWith(row.bound_prefix)) {
      throw new HttpError(
        403,
        "username_bound",
        `This access key may only send as a name starting with "${row.bound_prefix}".`,
      );
    }
  }

  private identity(tenant: string, row: Omit<TenantRow, "token_hash">, token?: string) {
    return {
      tenant,
      ...(token === undefined ? {} : { token }),
      username: row.bound_username,
      usernamePrefix: row.bound_prefix,
      ...(row.channel_scope ? { channel: row.channel_scope } : {}),
    };
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
    this.insertEvent(channel, "channel.created", null);
    return true;
  }

  /**
   * Always called from inside the caller's own `transactionSync`, so the event row commits or
   * rolls back atomically with the canonical mutation it describes. Capacity failure throws,
   * which aborts that whole transaction: no mutation is ever recorded without its event.
   */
  private insertEvent(channel: string, type: EventType, resourceId: number | null): void {
    // This journal is append-only. Bound its allocated sequence with an indexed rowid lookup,
    // rather than counting the entire retained journal on every write. Gaps consume capacity
    // conservatively; no mutation can bypass the ceiling or silently discard retained events.
    const allocated = this.ctx.storage.sql
      .exec<{ allocated: number }>("SELECT COALESCE(MAX(id), 0) AS allocated FROM events")
      .one().allocated;
    if (allocated >= MAX_EVENTS)
      throw new HttpError(409, "event_quota", "Event journal capacity reached. Contact the administrator.");
    this.ctx.storage.sql.exec(
      "INSERT INTO events (channel, type, resourceId, historyRevision, createdAt) VALUES (?, ?, ?, ?, ?)",
      channel,
      type,
      resourceId,
      this.historyRevision(channel),
      new Date().toISOString(),
    );
  }

  /** Wakes pending event polls for this channel, plus unscoped polls watching every channel. */
  private wakeEvents(channel: string): void {
    for (const waiter of this.eventWaiters)
      if (waiter.channel === null || waiter.channel === channel) waiter.wake();
  }

  /** Rotation and key revocation must recheck every pending poll of both kinds, not just message polls. */
  private wakeAllWaiters(): void {
    for (const waiter of this.waiters) waiter.wake();
    for (const waiter of this.eventWaiters) waiter.wake();
  }

  private eventsPage(tenant: string, channel: string | null, after: number, limit: number) {
    const rows = (
      channel === null
        ? this.ctx.storage.sql.exec<EventRow>(
            `SELECT ${EVENT_COLUMNS} FROM events WHERE id > ? ORDER BY id LIMIT ?`,
            after,
            limit + 1,
          )
        : this.ctx.storage.sql.exec<EventRow>(
            `SELECT ${EVENT_COLUMNS} FROM events WHERE channel = ? AND id > ? ORDER BY id LIMIT ?`,
            channel,
            after,
            limit + 1,
          )
    ).toArray();
    const events: CoordinationEvent[] = rows.slice(0, limit).map((row) => toEvent(row, tenant));
    return { events, nextCursor: events.at(-1)?.id ?? after, hasMore: rows.length > limit };
  }

  /** Same shape as `poll`, but over the event journal; a distinct id space from message ids. */
  private eventPoll(
    request: Request,
    hash: string,
    tenant: string,
    channel: string | null,
    after: number,
    limit: number,
    wait: number,
  ): Promise<Response> | Response {
    const page = this.eventsPage(tenant, channel, after, limit);
    if (page.events.length || !wait) return json(page);
    if (this.eventWaiters.size >= MAX_WAITERS)
      throw new HttpError(
        429,
        "too_many_polls",
        "At most 128 pending event polls per tenant; retry with backoff.",
      );
    // No await between SELECT and registration: new events cannot fall into a lost-wakeup gap.
    return new Promise((resolve) => {
      let finished = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.eventWaiters.delete(waiter);
        request.signal.removeEventListener("abort", abort);
      };
      const finish = (aborted = false) => {
        if (finished) return;
        try {
          this.authorize(hash); // Rotation and revocation abort already-pending polls, too.
          const next = this.eventsPage(tenant, channel, after, limit);
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
      const waiter: EventWaiter = {
        channel,
        wake: () => {
          // Future cursors must not get woken by earlier events.
          try {
            this.authorize(hash);
          } catch {
            finish();
            return;
          }
          if (this.eventsPage(tenant, channel, after, limit).events.length) finish();
        },
      };
      const abort = () => finish(true);
      const timer = setTimeout(finish, wait * 1000);
      this.eventWaiters.add(waiter);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
    });
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
    type: ContentType,
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
          `INSERT INTO messages(channel, username, text, contentType, createdAt, key, digest, bytes, replyTo, correlationId, recipient) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${MESSAGE_COLUMNS}`,
          channel,
          username,
          content,
          type,
          new Date().toISOString(),
          key,
          hash,
          bytes,
          correlation.replyTo ?? null,
          correlation.correlationId ?? null,
          correlation.to ?? null,
        )
        .one();
      this.ctx.storage.sql.exec(
        "UPDATE usage SET messages = messages + 1, bytes = bytes + ? WHERE singleton = 1",
        bytes,
      );
      this.insertEvent(channel, "message.created", message.id);
      return { message: toMessage(message, tenant), replayed: false };
    });
    // transactionSync succeeded; output gates delay network replies until durable commit.
    if (!result.replayed) {
      for (const waiter of this.waiters) if (waiter.channel === channel) waiter.wake();
      this.wakeEvents(channel);
    }
    return json(result, result.replayed ? 200 : 201);
  }

  private historyRevision(channel: string): number {
    return (
      this.ctx.storage.sql
        .exec<{ revision: number }>("SELECT revision FROM channel_history WHERE channel = ?", channel)
        .toArray()[0]?.revision ?? 0
    );
  }

  /** Same-channel live row only; tombstones and other channels do not leak bodies. */
  private showMessage(tenant: string, channel: string, id: number): Response {
    const row = this.ctx.storage.sql
      .exec<MessageRow & { deleted: number }>(
        `SELECT ${MESSAGE_COLUMNS}, deleted FROM messages WHERE channel = ? AND id = ?`,
        channel,
        id,
      )
      .toArray()[0];
    if (!row) throw new HttpError(404, "message_not_found", "Message not found.");
    if (row.deleted) throw new HttpError(410, "message_deleted", "This message was deleted.");
    const { deleted: _deleted, ...message } = row;
    return json({ message: toMessage(message, tenant), historyRevision: this.historyRevision(channel) });
  }

  private latestSnapshot(channel: string): SnapshotRow | undefined {
    return this.ctx.storage.sql
      .exec<SnapshotRow>(
        `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE channel = ? ORDER BY version DESC LIMIT 1`,
        channel,
      )
      .toArray()[0];
  }

  private publishSnapshot(
    tenant: string,
    channel: string,
    username: string,
    content: string,
    coversThrough: number,
    baseVersion: number,
    historyRevision: number,
    key: string,
    hash: string,
  ): Response {
    const result = this.ctx.storage.transactionSync(() => {
      this.requireChannel(channel);
      const old = this.ctx.storage.sql
        .exec<SnapshotRow & { digest: string }>(
          `SELECT ${SNAPSHOT_COLUMNS}, digest FROM snapshots WHERE channel = ? AND key = ?`,
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
        if (old.invalidated)
          throw new HttpError(
            410,
            "snapshot_invalidated",
            "This snapshot was invalidated by redaction; retries cannot restore it.",
          );
        const { digest: _digest, ...row } = old;
        return { snapshot: toSnapshot(row, tenant), replayed: true };
      }
      const latest = this.latestSnapshot(channel);
      if (baseVersion !== (latest?.version ?? 0))
        throw new HttpError(
          409,
          "snapshot_conflict",
          "baseVersion is stale; read current snapshot state and reconcile.",
        );
      if (historyRevision !== this.historyRevision(channel))
        throw new HttpError(
          409,
          "history_conflict",
          "History changed through redaction; reread before publishing a snapshot.",
        );
      if (
        (latest && coversThrough < latest.coversThrough) ||
        (coversThrough > 0 &&
          !this.ctx.storage.sql
            .exec("SELECT id FROM messages WHERE channel = ? AND id = ?", channel, coversThrough)
            .toArray().length)
      )
        throw new HttpError(
          400,
          "invalid_coverage",
          "coversThrough must be a channel message id and cannot regress.",
        );
      const count = this.ctx.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM snapshots")
        .one().count;
      const bytes = new TextEncoder().encode(username + content).length;
      const used = this.ctx.storage.sql.exec<{ bytes: number }>("SELECT bytes FROM usage").one().bytes;
      if (count >= MAX_SNAPSHOTS || used + bytes > MAX_CONTENT_BYTES)
        throw new HttpError(
          409,
          "storage_quota",
          "Snapshot quota reached (1,000 lifetime snapshots or 128 MiB active content per tenant).",
        );
      const row = this.ctx.storage.sql
        .exec<SnapshotRow>(
          `INSERT INTO snapshots(channel, version, username, text, coversThrough, historyRevision, createdAt, key, digest, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${SNAPSHOT_COLUMNS}`,
          channel,
          baseVersion + 1,
          username,
          content,
          coversThrough,
          historyRevision,
          new Date().toISOString(),
          key,
          hash,
          bytes,
        )
        .one();
      this.ctx.storage.sql.exec("UPDATE usage SET bytes = bytes + ? WHERE singleton = 1", bytes);
      this.insertEvent(channel, "snapshot.published", row.version);
      return { snapshot: toSnapshot(row, tenant), replayed: false };
    });
    if (!result.replayed) this.wakeEvents(channel);
    return json(result, result.replayed ? 200 : 201);
  }

  /** All reads stay synchronous: checkpoint, head and tail describe one consistent storage view. */
  private catchup(tenant: string, channel: string, url: URL): Response {
    this.requireChannel(channel);
    const limit = integer(url.searchParams.get("limit"), 20, 100);
    const maxBytes = integer(url.searchParams.get("maxBytes"), 32768, 262144);
    if (!limit || maxBytes < 1024)
      throw new HttpError(400, "invalid_query", "limit must be positive and maxBytes must be at least 1024.");
    const latest = this.latestSnapshot(channel);
    const usable = latest && !latest.invalidated ? latest : null;
    // An explicit continuation cursor must never be advanced by a newer checkpoint.
    const snapshot = url.searchParams.has("after") ? null : usable;
    const after = url.searchParams.has("after")
      ? integer(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER)
      : (snapshot?.coversThrough ?? 0);
    const headCursor = this.ctx.storage.sql
      .exec<{ head: number }>("SELECT COALESCE(MAX(id), 0) AS head FROM messages WHERE channel = ?", channel)
      .one().head;
    if (after > headCursor)
      throw new HttpError(400, "invalid_cursor", "after exceeds this channel's current head.");
    const pendingMessages = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM messages WHERE channel = ? AND deleted = 0 AND id > ?",
        channel,
        after,
      )
      .one().count;
    const pendingBytes = this.ctx.storage.sql
      .exec<{ bytes: number }>(
        "SELECT COALESCE(SUM(bytes), 0) AS bytes FROM messages WHERE channel = ? AND deleted = 0 AND id > ?",
        channel,
        after,
      )
      .one().bytes;
    const snapshotPending = this.ctx.storage.sql
      .exec<{ count: number; bytes: number }>(
        "SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM messages WHERE channel = ? AND deleted = 0 AND id > ?",
        channel,
        usable?.coversThrough ?? 0,
      )
      .one();
    const sinceSnapshot = snapshotPending.count;
    const messages = this.page(tenant, channel, after, limit).messages;
    const snapshotDueReasons = [
      ...(!usable ? ["no_snapshot"] : []),
      ...(snapshotPending.bytes >= 16384 ? ["byte_threshold"] : []),
      ...(sinceSnapshot >= 20 ? ["message_threshold"] : []),
      ...(usable && sinceSnapshot > 0 && Date.now() - Date.parse(usable.createdAt) >= 86400000
        ? ["age_threshold"]
        : []),
    ];
    const result = {
      snapshot: snapshot ? toSnapshot(snapshot, tenant) : null,
      snapshotVersion: latest?.version ?? 0,
      historyRevision: this.historyRevision(channel),
      messages,
      nextCursor: messages.at(-1)?.id ?? after,
      hasMore: pendingMessages > messages.length,
      incomplete: pendingMessages > messages.length,
      headCursor,
      pendingMessages,
      pendingBytes,
      snapshotPendingMessages: snapshotPending.count,
      snapshotPendingBytes: snapshotPending.bytes,
      snapshotDue: snapshotDueReasons.length > 0,
      snapshotDueReasons,
      snapshotPolicy: { messageThreshold: 20, byteThreshold: 16384, maxAgeSeconds: 86400 },
      byteLimitReached: false,
    };
    const minimum = {
      ...result,
      messages: messages.slice(0, 1),
      nextCursor: messages[0]?.id ?? after,
      hasMore: pendingMessages > 1,
      incomplete: pendingMessages > 1,
      byteLimitReached: false,
    };
    const requiredBytes = new TextEncoder().encode(JSON.stringify(minimum)).length;
    // Encode each row once; repeated shrinking must not reserialize a megabyte-sized tail.
    const encoder = new TextEncoder();
    const messageSizes = messages.map((message) => encoder.encode(JSON.stringify(message)).length);
    let contentBytes = messageSizes.reduce((sum, bytes) => sum + bytes, 0);
    const size = () =>
      encoder.encode(JSON.stringify({ ...result, messages: [] })).length +
      contentBytes +
      Math.max(0, result.messages.length - 1);
    while (size() > maxBytes && result.messages.length) {
      result.messages.pop();
      contentBytes -= messageSizes.pop() ?? 0;
      result.nextCursor = result.messages.at(-1)?.id ?? after;
      result.hasMore = result.incomplete = result.byteLimitReached = true;
    }
    if (size() > maxBytes || (pendingMessages > 0 && result.messages.length === 0))
      return json(
        {
          error: {
            code: "catchup_budget_too_small",
            message: `Increase maxBytes to at least ${requiredBytes} to fit the checkpoint and first pending message (maximum 262144).`,
            requiredBytes,
          },
        },
        413,
      );
    return json(result);
  }

  private requireScope(capability: TenantRow, channel: string | null): void {
    if (capability.channel_scope && capability.channel_scope !== channel)
      throw new HttpError(
        403,
        "channel_forbidden",
        "This access key only grants access to its invited channel.",
      );
  }

  private requireKeyCapacity(): void {
    if (
      this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM access_keys").one().count >=
      MAX_KEYS
    )
      throw new HttpError(409, "key_quota", "Tenant participant key limit reached (1,000).");
  }

  private async provision(tenant: string, bind: Binding, channel?: string): Promise<Response> {
    const token = newToken();
    const hash = await digest(token);
    return this.ctx.storage.transactionSync(() => {
      if (this.tenantRow())
        throw new HttpError(
          409,
          "tenant_exists",
          "Workspace already exists. Connect with an access key or invitation.",
        );
      this.ctx.storage.sql.exec(
        "INSERT INTO tenant (singleton, token_hash, bound_username, bound_prefix) VALUES (1, ?, ?, ?)",
        hash,
        bind.username,
        bind.prefix,
      );
      if (channel) this.createChannel(channel);
      return json(
        {
          ...this.identity(tenant, { bound_username: bind.username, bound_prefix: bind.prefix }, token),
          ...(channel ? { initialChannel: channel } : {}),
        },
        201,
      );
    });
  }

  private async createInvite(request: Request, tenant: string, hash: string): Promise<Response> {
    const input = await body(request);
    const channel = input.channel == null ? null : slug(text(input.channel, "channel", 64));
    const maxUses = input.maxUses === undefined ? 25 : snapshotInteger(input.maxUses, "maxUses");
    const expiresIn = input.expiresIn === undefined ? 86400 : snapshotInteger(input.expiresIn, "expiresIn");
    if (maxUses < 1 || maxUses > 100 || expiresIn < 60 || expiresIn > 604800)
      throw new HttpError(400, "invalid_invite", "Use 1–100 recipients and an expiry of 60–604800 seconds.");
    const code = newToken();
    const codeHash = await digest(code);
    const capability = this.authorize(hash); // Final check after every await.
    this.requireScope(capability, channel);
    if (channel) this.requireChannel(channel);
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM invites WHERE expiresAt <= ? OR remaining = 0", now);
    if (
      this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM invites").one().count >=
      1000
    )
      throw new HttpError(409, "invite_quota", "Workspace invitation limit reached.");
    const id = crypto.randomUUID();
    const expiresAt = now + expiresIn * 1000;
    this.ctx.storage.sql.exec(
      "INSERT INTO invites VALUES (?, ?, ?, ?, ?, ?)",
      id,
      codeHash,
      hash,
      channel,
      expiresAt,
      maxUses,
    );
    const accessCode = `${tenant}.${code}`;
    return json(
      {
        id,
        tenant,
        channel,
        code: accessCode,
        url: `${new URL(request.url).origin}/#invite=${accessCode}`,
        expiresAt: new Date(expiresAt).toISOString(),
        maxUses,
      },
      201,
    );
  }

  private async redeemInvite(request: Request, tenant: string): Promise<Response> {
    const input = await body(request);
    const username = text(input.username, "username", 128);
    const code = text(input.code, "code", 256);
    if (!new RegExp(`^${tenant}\\.[a-f0-9]{64}$`).test(code))
      throw new HttpError(400, "invalid_invite", "Use the invitation code for this workspace.");
    const codeHash = await digest(code.slice(tenant.length + 1));
    const token = newToken();
    const hash = await digest(token);
    return this.ctx.storage.transactionSync(() => {
      const invite = this.ctx.storage.sql
        .exec<InviteRow>("SELECT * FROM invites WHERE code_hash = ?", codeHash)
        .toArray()[0];
      if (!invite || invite.expiresAt <= Date.now() || !invite.remaining)
        throw new HttpError(
          410,
          "invite_unavailable",
          "Invitation expired, revoked or fully used. Ask for a new invitation.",
        );
      try {
        this.requireScope(this.authorize(invite.creator_hash), invite.channel);
      } catch {
        throw new HttpError(
          410,
          "invite_unavailable",
          "The inviter no longer has access. Ask for a new invitation.",
        );
      }
      this.requireKeyCapacity();
      const id = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        "INSERT INTO access_keys (id, token_hash, bound_username, bound_prefix, createdAt, channel_scope) VALUES (?, ?, ?, NULL, ?, ?)",
        id,
        hash,
        username,
        new Date().toISOString(),
        invite.channel,
      );
      this.ctx.storage.sql.exec("UPDATE invites SET remaining = remaining - 1 WHERE id = ?", invite.id);
      return json(
        {
          ...this.identity(
            tenant,
            { bound_username: username, bound_prefix: null, channel_scope: invite.channel },
            token,
          ),
          keyId: id,
        },
        201,
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").slice(1);
      const isAdmin = parts[1] === "admin";
      const tenantIndex = isAdmin ? 3 : 2;
      const tenant = slug(parts[tenantIndex] ?? "");
      const rest = parts.slice(tenantIndex + 1);
      if (!isAdmin && !rest.length && request.method === "PUT") {
        const input = await body(request);
        const username = text(input.username, "username", 128);
        const channel = input.channel === undefined ? "general" : slug(text(input.channel, "channel", 64));
        return await this.provision(tenant, { username, prefix: null }, channel);
      }
      if (!isAdmin && rest.join("/") === "invites/redeem" && request.method === "POST")
        return await this.redeemInvite(request, tenant);
      if (isAdmin) {
        await admin(request, this.env);
        if (!rest.length && request.method === "PUT") {
          const bind: Binding = binding(await optionalBody(request)) ?? { username: null, prefix: null };
          return await this.provision(tenant, bind);
        }
        this.requireTenant();
        if (rest.length === 1 && rest[0] === "token" && request.method === "POST") {
          // No body keeps the current bind; an explicit null clears it; a string rebinds (ADR 0002).
          const bind = binding(await optionalBody(request));
          const token = newToken();
          const hash = await digest(token);
          this.ctx.storage.transactionSync(() => {
            if (bind) {
              this.ctx.storage.sql.exec(
                "UPDATE tenant SET token_hash = ?, bound_username = ?, bound_prefix = ? WHERE singleton = 1",
                hash,
                bind.username,
                bind.prefix,
              );
            } else {
              this.ctx.storage.sql.exec("UPDATE tenant SET token_hash = ? WHERE singleton = 1", hash);
            }
            // Rotation remains a workspace-wide emergency reset, not a partial revocation.
            this.ctx.storage.sql.exec("DELETE FROM access_keys");
            this.ctx.storage.sql.exec("DELETE FROM invites");
          });
          this.wakeAllWaiters();
          return json(this.identity(tenant, this.authorize(hash), token));
        }
        if (rest[0] === "keys") {
          if (rest.length === 1 && request.method === "GET") {
            return json({
              keys: this.ctx.storage.sql
                .exec(`SELECT ${KEY_METADATA}, channel_scope FROM access_keys ORDER BY id`)
                .toArray()
                .map(({ channel_scope, ...key }) => ({
                  ...key,
                  ...(channel_scope ? { channel: channel_scope } : {}),
                })),
            });
          }
          if (rest.length === 2) {
            const id = slug(rest[1]);
            if (request.method === "PUT") {
              const bind = binding(await body(request));
              if (!bind || (bind.username === null && bind.prefix === null))
                throw new HttpError(
                  400,
                  "invalid_binding",
                  "Participant keys require username or usernamePrefix.",
                );
              const token = newToken();
              const hash = await digest(token);
              const metadata = this.ctx.storage.transactionSync(() => {
                if (this.ctx.storage.sql.exec("SELECT id FROM access_keys WHERE id = ?", id).toArray().length)
                  throw new HttpError(
                    409,
                    "key_exists",
                    "Key already exists. Revoke it before issuing a replacement.",
                  );
                this.requireKeyCapacity();
                return this.ctx.storage.sql
                  .exec(
                    `INSERT INTO access_keys (id, token_hash, bound_username, bound_prefix, createdAt) VALUES (?, ?, ?, ?, ?) RETURNING ${KEY_METADATA}`,
                    id,
                    hash,
                    bind.username,
                    bind.prefix,
                    new Date().toISOString(),
                  )
                  .one();
              });
              return json({ ...metadata, token }, 201);
            }
            if (request.method === "DELETE") {
              const deleted = this.ctx.storage.sql
                .exec("DELETE FROM access_keys WHERE id = ? RETURNING id", id)
                .toArray();
              if (!deleted.length) throw new HttpError(404, "key_not_found", "Participant key not found.");
              // Recheck every pending poll; other participants retain their waiters and access.
              this.wakeAllWaiters();
              return new Response(null, { status: 204 });
            }
          }
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
              "UPDATE messages SET deleted = 1, username = '', text = '', recipient = NULL, bytes = 0 WHERE id = ?",
              id,
            );
            const snapshotBytes = this.ctx.storage.sql
              .exec<{ bytes: number }>(
                "SELECT COALESCE(SUM(bytes), 0) AS bytes FROM snapshots WHERE channel = ?",
                channel,
              )
              .one().bytes;
            // Summaries may quote earlier summaries or messages beyond claimed coverage. Scrub all.
            this.ctx.storage.sql.exec(
              "UPDATE snapshots SET text = '', username = '', bytes = 0, invalidated = 1 WHERE channel = ?",
              channel,
            );
            this.ctx.storage.sql.exec(
              "INSERT INTO channel_history(channel, revision) VALUES (?, 1) ON CONFLICT(channel) DO UPDATE SET revision = revision + 1",
              channel,
            );
            this.ctx.storage.sql.exec(
              "UPDATE usage SET bytes = bytes - ? WHERE singleton = 1",
              row.bytes + snapshotBytes,
            );
            // After the revision bump, so this event's historyRevision is the post-deletion value.
            this.insertEvent(channel, "message.deleted", id);
          });
          this.wakeEvents(channel);
          return new Response(null, { status: 204 });
        }
      } else {
        const hash = await digest(bearer(request));
        if (rest.length === 1 && rest[0] === "invites" && request.method === "POST")
          return await this.createInvite(request, tenant, hash);
        // Parse/digest before the final authorization check: rotation cannot race a write.
        const input =
          request.method === "POST" && rest.length === 3 && rest[2] === "messages"
            ? await body(request)
            : null;
        const username = input ? text(input.username, "username", 128) : "";
        const content = input ? text(input.text, "text", 16384) : "";
        const type = input ? contentType(input.contentType, content) : "text/plain";
        const correlation: Correlation = input
          ? {
              replyTo: replyTarget(input.replyTo),
              correlationId: correlationId(input.correlationId),
              to: recipient(input.to),
            }
          : {};
        const payloadHash = input ? await digest(payload(username, content, type, correlation)) : "";
        const snapshotInput =
          request.method === "POST" && rest.length === 3 && rest[2] === "snapshots"
            ? await body(request)
            : null;
        const snapshotData = snapshotInput
          ? {
              username: text(snapshotInput.username, "username", 128),
              text: text(snapshotInput.text, "text", 16384, "invalid_snapshot"),
              coversThrough: snapshotInteger(snapshotInput.coversThrough, "coversThrough"),
              baseVersion: snapshotInteger(snapshotInput.baseVersion, "baseVersion"),
              historyRevision: snapshotInteger(snapshotInput.historyRevision, "historyRevision"),
            }
          : null;
        const snapshotHash = snapshotData ? await digest(JSON.stringify(snapshotData)) : "";
        const capability = this.authorize(hash);
        // Bound-name check precedes any transaction: a rejected send stores nothing and wakes nobody.
        if (input) this.requireBoundName(capability, username);
        if (!rest.length && request.method === "GET") return json(this.identity(tenant, capability));
        if (rest[0] === "invites" && rest.length === 2 && request.method === "DELETE") {
          const deleted = this.ctx.storage.sql
            .exec("DELETE FROM invites WHERE id = ? AND creator_hash = ? RETURNING id", rest[1], hash)
            .toArray();
          if (!deleted.length)
            throw new HttpError(
              404,
              "invite_not_found",
              "Invitation not found or belongs to another participant.",
            );
          return new Response(null, { status: 204 });
        }
        if (rest.length === 1 && rest[0] === "events" && request.method === "GET") {
          const channelParam = url.searchParams.get("channel");
          const channel = channelParam === null ? null : slug(channelParam);
          // A scoped key sees only its granted channel: silently filtered without a query
          // parameter, and rejected outright when the query names a different channel.
          // `channel_scope` may be `undefined` (unselected column) or `null` (unscoped token);
          // both mean "no scope", matching requireScope's truthy check elsewhere in this file.
          if (capability.channel_scope && channel !== null && channel !== capability.channel_scope) {
            throw new HttpError(
              403,
              "channel_forbidden",
              "This access key only grants access to its invited channel.",
            );
          }
          const effectiveChannel = capability.channel_scope || channel;
          const after = integer(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER);
          const limit = integer(url.searchParams.get("limit"), 100, 100);
          const wait = integer(url.searchParams.get("wait"), 0, 25);
          if (!limit) throw new HttpError(400, "invalid_query", "limit must be positive.");
          return await this.eventPoll(request, hash, tenant, effectiveChannel, after, limit, wait);
        }
        if (rest[0] === "channels" && rest.length === 1 && request.method === "GET") {
          const after = url.searchParams.get("after") ?? "";
          if (after) slug(after);
          const limit = integer(url.searchParams.get("limit"), 100, 1000);
          if (!limit) throw new HttpError(400, "invalid_query", "limit must be positive.");
          const channels = this.ctx.storage.sql
            .exec<{ name: string; createdAt: string }>(
              `SELECT c.name, c.createdAt, COUNT(m.id) AS messageCount, MAX(m.createdAt) AS lastActivityAt,
               COUNT(DISTINCT m.username) AS participantCount
               FROM channels c LEFT JOIN messages m ON m.channel = c.name AND m.deleted = 0
               WHERE c.name > ? AND (? IS NULL OR c.name = ?) GROUP BY c.name ORDER BY c.name LIMIT ?`,
              after,
              capability.channel_scope ?? null,
              capability.channel_scope ?? null,
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
          this.requireScope(capability, channel);
          if (rest.length === 2 && request.method === "PUT") {
            const created = this.ctx.storage.transactionSync(() => this.createChannel(channel));
            if (created) this.wakeEvents(channel);
            return json({ channel, created }, created ? 201 : 200);
          }
          if (rest.length === 3 && rest[2] === "catchup" && request.method === "GET")
            return this.catchup(tenant, channel, url);
          if (rest[2] === "snapshots") {
            this.requireChannel(channel);
            if (rest.length === 3 && request.method === "POST" && snapshotData) {
              this.requireBoundName(capability, snapshotData.username);
              const key = idempotencyKey(request, true) as string;
              return this.publishSnapshot(
                tenant,
                channel,
                snapshotData.username,
                snapshotData.text,
                snapshotData.coversThrough,
                snapshotData.baseVersion,
                snapshotData.historyRevision,
                key,
                snapshotHash,
              );
            }
            if (rest.length === 3 && request.method === "GET") {
              const after = integer(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER);
              const limit = integer(url.searchParams.get("limit"), 20, 100);
              if (!limit) throw new HttpError(400, "invalid_query", "limit must be positive.");
              const rows = this.ctx.storage.sql
                .exec<Omit<SnapshotRow, "text">>(
                  "SELECT channel, version, username, coversThrough, historyRevision, createdAt, invalidated FROM snapshots WHERE channel = ? AND version > ? ORDER BY version LIMIT ?",
                  channel,
                  after,
                  limit + 1,
                )
                .toArray();
              const snapshots = rows
                .slice(0, limit)
                .map(({ invalidated, ...row }) => ({ ...row, tenant, invalidated: Boolean(invalidated) }));
              return json({
                snapshots,
                nextCursor: snapshots.at(-1)?.version ?? after,
                hasMore: rows.length > limit,
                snapshotVersion: this.latestSnapshot(channel)?.version ?? 0,
                historyRevision: this.historyRevision(channel),
              });
            }
            if (rest.length === 4 && request.method === "GET") {
              const version = integer(rest[3], 0, Number.MAX_SAFE_INTEGER);
              const row = this.ctx.storage.sql
                .exec<SnapshotRow>(
                  `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE channel = ? AND version = ?`,
                  channel,
                  version,
                )
                .toArray()[0];
              if (!row) throw new HttpError(404, "snapshot_not_found", "Snapshot not found.");
              if (row.invalidated)
                throw new HttpError(
                  410,
                  "snapshot_invalidated",
                  "Snapshot invalidated by history redaction.",
                );
              return json({
                snapshot: toSnapshot(row, tenant),
                historyRevision: this.historyRevision(channel),
              });
            }
          }
          if (rest.length === 4 && rest[2] === "messages" && request.method === "GET") {
            this.requireChannel(channel);
            return this.showMessage(tenant, channel, messageId(rest[3]));
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
              return this.send(tenant, channel, username, content, type, correlation, key, payloadHash);
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
