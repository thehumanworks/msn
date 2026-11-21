import { DurableObject } from "cloudflare:workers";
import {
  GITHUB_SENDER,
  type GithubNotice,
  MAX_GITHUB_LINKS,
  notice,
  noticeLabels,
  type PullRef,
  pullNumber,
  readDelivery,
  repoName,
  verifySignature,
} from "./github";
import {
  ATTACHMENT_ORPHAN_MS,
  type AttachmentRef,
  addressedTo,
  addressees,
  addressFields,
  admin,
  answerChoice,
  attachmentRefs,
  type Binding,
  bearer,
  binding,
  body,
  type ContentType,
  choiceList,
  contentDisposition,
  contentType,
  correlationId,
  digest,
  equalHash,
  failure,
  HttpError,
  INLINE_MEDIA_TYPES,
  idempotencyKey,
  integer,
  isAddressed,
  json,
  type LabelChange,
  type LabelFilter,
  type Labels,
  labelChange,
  labelFilters,
  MAX_ATTACHMENT_BYTES,
  MAX_LABELS,
  type MessageEdit,
  messageEdit,
  newToken,
  optionalBody,
  labels as parseLabels,
  quoteText,
  REACTIONS,
  type ReactionChange,
  type Reactions,
  rawBody,
  reactionChange,
  recipients,
  replacesTarget,
  replyTarget,
  type ScheduledChange,
  scheduledChange,
  searchMatch,
  sendAtValue,
  sendAtWindow,
  sha256,
  slug,
  snapshotInteger,
  statusChange,
  text,
} from "./http";
import {
  generateVapidKeys,
  needsOwner,
  type PushSubscription,
  parseSubscription,
  sendPush,
  type VapidKeys,
} from "./push";
import {
  SINCE_EVENTS,
  SINCE_LABEL_BATCH,
  SINCE_LABELS,
  SINCE_MESSAGES,
  SINCE_TEXT_CHARS,
  type SinceSource,
  sinceSummary,
} from "./since";
import { MAX_TEMPLATES, type TemplatePersona, templateFromBoard, templateName } from "./templates";
import {
  MAX_PENDING_NOTICES,
  MAX_WEBHOOKS,
  type Notice,
  noticeBody,
  postNotice,
  WEBHOOK_BATCH,
  WEBHOOK_RETRY_DELAYS_MS,
  webhookBearer,
  webhookUrl,
} from "./webhook";

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
  /** The part of the replyTo message this reply quotes (ADR 0059); absent when it quotes nothing. */
  quote?: string;
  correlationId?: string;
  /** The first name the message is addressed to; the only one unless `recipients` is present. */
  to?: string;
  /** Every name, in order, when the message is addressed to several (ADR 0067); else absent. */
  recipients?: string[];
  personaId?: string;
  /** key=value labels (ADR 0032); absent from JSON when the message has none. */
  labels?: Labels;
  /** Files sent with the message (ADR 0035); absent from JSON when it has none. */
  attachments?: Attachment[];
  /** Who reacted, by kind (ADR 0047); absent from JSON when nobody has. */
  reactions?: Reactions;
  /** When the sender last edited the text (ADR 0052); absent from JSON when never edited. */
  editedAt?: string;
  /** A question's buttons (ADR 0065); absent from JSON on other messages. Only `to` answers. */
  choices?: string[];
  /** The choice this reply picks from its replyTo question (ADR 0065). */
  answer?: string;
  /** The first answer to this question (ADR 0065); absent until it is answered. */
  answered?: Answered;
  /**
   * The exact name that may answer this question (ADR 0065), resolved from `to` when it was
   * asked. Clients open the buttons only for this name. Absent on other messages.
   */
  answerer?: string;
  /** The earlier message of the same sender this one replaces (ADR 0068); absent otherwise. */
  replaces?: number;
  /** The newer message that replaces this one (ADR 0068); absent until it is replaced. */
  replacedBy?: number;
};
/** Which reply answered a question, with what, by whom and when (ADR 0065). */
export type Answered = { id: number; choice: string; username: string; answeredAt: string };
/** Attachment metadata on a message; the bytes come from the per-message download route. */
export type Attachment = { index: number; id: string; name: string; mediaType: string; bytes: number };
/** Optional annotation input on send; `undefined` means "not supplied". */
export type Correlation = {
  replyTo?: number;
  quote?: string;
  correlationId?: string;
  to?: string;
  /** Every name when the send names several (ADR 0067); `to` is then the first. */
  recipients?: string[];
  /** A question's buttons (ADR 0065). */
  choices?: string[];
  /** The choice a reply picks from its replyTo question (ADR 0065). */
  answer?: string;
  /** The sender's earlier message this one replaces (ADR 0068). */
  replaces?: number;
};
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
  /** JSON list of every name when a message is addressed to several (ADR 0067), else NULL. */
  recipients: string | null;
  personaId: string | null;
  editedAt: string | null;
  quote: string | null;
  /** JSON list of a question's choices (ADR 0065). */
  choices: string | null;
  answer: string | null;
  /** JSON Answered, set once by the first valid answer (ADR 0065). */
  answered: string | null;
  /** The exact name that may answer a question, resolved when it was asked (ADR 0065). */
  answerer: string | null;
  /** The earlier message this one replaces, and the newer one that replaced this (ADR 0068). */
  replaces: number | null;
  replacedBy: number | null;
};
const MESSAGE_COLUMNS =
  "id, channel, username, text, contentType, createdAt, replyTo, correlationId, recipient, recipients, personaId, editedAt, quote, choices, answer, answered, answerer, replaces, replacedBy";
type TenantRow = {
  token_hash: string;
  bound_username: string | null;
  bound_prefix: string | null;
  channel_scope?: string | null;
  owner_access?: number;
  shared_channel?: number;
  /** Watch-only key (ADR 0039): every request but a read is refused. Never cleared. */
  read_only?: number;
};
type AccessKeyRow = TenantRow & { id: string; createdAt: string };
const KEY_METADATA = "id, bound_username AS username, bound_prefix AS usernamePrefix, createdAt";
/** `end` answers the poll now with its current page (archiving a board, ADR 0046). */
type Waiter = { channel: string; wake: () => void; end: () => void };
/** `channel: null` matches every channel (unscoped tokens polling the whole tenant). */
type EventWaiter = { channel: string | null; wake: () => void; end: () => void };
const MAX_MESSAGES = 100000;
const MAX_CONTENT_BYTES = 128 * 1024 * 1024;
const MAX_CHANNELS = 1000;
const MAX_WAITERS = 128;
const MAX_KEYS = 1000;
const SCHEMA_VERSION = 20;
/** After an alarm run in which a job threw, the next run waits at least this long. */
export const ALARM_FAILURE_BACKOFF_MS = 30_000;
/** Names per reaction kind on one message (ADR 0047). */
export const MAX_REACTORS = 100;
/** Reactions stored per workspace at once (ADR 0047); removing one frees its place. */
export const MAX_REACTIONS = 100000;
/** Scheduled messages waiting per board, and per workspace (ADR 0060). */
export const MAX_SCHEDULED_PER_SENDER = 25;
export const MAX_SCHEDULED_PER_BOARD = 100;
export const MAX_SCHEDULED = 1000;
/** A scheduled message that failed to post is kept this long for its sender to see, then removed. */
export const FAILED_SCHEDULED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Due scheduled messages posted per alarm run; the alarm runs again at once while more are due. */
const SCHEDULED_BATCH = 50;
/** Pinned messages per board (ADR 0038). */
export const MAX_PINS = 10;
/** Unread counts (ADR 0045): boards per request, and messages counted per board before "99+". */
export const UNREAD_BOARDS = 100;
export const UNREAD_CAP = 99;
/** Older messages indexed per backfill step after the v17 migration (ADR 0037). */
export const SEARCH_BACKFILL_BATCH = 500;
/** `kind` search filter values and the content type each one matches. */
const SEARCH_KINDS: Record<string, ContentType | undefined> = Object.assign(Object.create(null), {
  text: "text/plain",
  json: "application/json",
});
/** Lifetime label changes per workspace; each one writes a journal event (ADR 0032). */
const MAX_LABEL_CHANGES = 100000;
/** A runner counts as listening this long after its last event poll ended (ADR 0028). */
export const LISTENING_GRACE_MS = 60_000;
/** `persona_presence.lastListeningAt` is written at most this often per persona while it polls. */
export const PRESENCE_WRITE_INTERVAL_MS = 5 * 60_000;
/** Workflow conclusions that never post a board message (ADR 0036). */
const QUIET_CONCLUSIONS = new Set(["skipped", "neutral"]);
/** Owner devices that receive push notifications (ADR 0029). */
const MAX_PUSH_SUBSCRIPTIONS = 20;
/** How long a timed board mute lasts (ADR 0044). No `for` mutes until unmuted. */
const MUTE_DURATIONS: Record<string, number | undefined> = Object.assign(Object.create(null), {
  "1h": 3600_000,
  "1d": 86400_000,
});
type MuteRow = { channel: string; until: string | null; everything: number };
type InviteRow = {
  id: string;
  code_hash: string;
  creator_hash: string;
  channel: string | null;
  expiresAt: number;
  remaining: number;
  /** Redeeming issues a watch-only key (ADR 0039). */
  watch: number;
};
const MAX_SNAPSHOTS = 1000;
// Exact upper bound: every message can be created and later deleted, every channel and every
// snapshot emits one event. Fail-closed capacity, never reached while other quotas hold.
/** Lifetime message edits per workspace (ADR 0052); each writes one `message.edited` event. */
export const MAX_EDITS = 100000;
/** Edited earlier messages returned by one catch-up page (ADR 0052). */
const CATCHUP_EDITS = 20;
/** Lifetime agent status changes per workspace (ADR 0064); each writes one `status.changed` event. */
export const MAX_STATUS_CHANGES = 100000;
/** Names with a status on one board at a time (ADR 0064). */
export const MAX_STATUSES = 200;
// Status events: every change up to the cap, plus one clear for every row that can still be live
// once the cap is reached (clears are never refused, ADR 0064).
const MAX_EVENTS =
  MAX_MESSAGES * 2 +
  MAX_CHANNELS +
  MAX_SNAPSHOTS +
  MAX_LABEL_CHANGES +
  MAX_EDITS +
  MAX_STATUS_CHANGES +
  MAX_STATUSES * MAX_CHANNELS;
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

export type EventType =
  | "channel.created"
  | "message.created"
  | "message.deleted"
  | "message.labeled"
  | "message.edited"
  | "snapshot.published"
  | "status.changed";
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
/** Event types a client opted in to; older decoders reject types they do not know. */
type EventInclude = { labels: boolean; edits: boolean; statuses?: boolean };
const NO_EXTRA_EVENTS: EventInclude = { labels: false, edits: false, statuses: false };
function toEvent(row: EventRow, tenant: string): CoordinationEvent {
  return { ...row, tenant };
}

/** Resumable processing progress per channel and reader, fenced by generation (ADR 0034). */
type ProcessingRow = {
  reader: string;
  committedThrough: number;
  generation: number;
  holder: string | null;
  claimedAt: string;
  updatedAt: string;
};
const PROCESSING_COLUMNS = "reader, committedThrough, generation, holder, claimedAt, updatedAt";
type ProcessingFence = { reader: string; generation: number };
/** The message's own sender, by persona id or by name (with any `/worker` suffix). */
function receiptFromSender(r: Receipt, username: string, personaId: string | null): boolean {
  return (
    (personaId !== null && r.personaId === personaId) ||
    r.name === username ||
    r.name.startsWith(`${username}/`)
  );
}
/** One reader's explicit commit position (ADR 0040); committedThrough null means never committed. */
type Receipt = {
  name: string;
  reader: string | null;
  personaId: string | null;
  committedThrough: number | null;
  updatedAt: string | null;
};
function toProcessing(row: ProcessingRow) {
  return { ...row };
}
/** The most messages one thread read follows (ADR 0063); a bigger thread is read as the board. */
export const MAX_THREAD = 10_000;
/**
 * Every message in one thread (ADR 0063): the root and every message whose replyTo chain leads
 * to it, at any depth, at most MAX_THREAD + 1 of them. A reply always has a higher id than what it
 * answers. CROSS JOIN pins the join order, so each step looks up replies to known members in
 * the message_replies index instead of scanning every reply on the board. Parameters: root,
 * channel, row limit.
 */
export const THREAD_MEMBERS_SQL = `WITH RECURSIVE thread(id) AS (
    SELECT ? UNION SELECT m.id FROM thread t CROSS JOIN messages m ON m.replyTo = t.id
    WHERE m.channel = ? AND m.id > t.id LIMIT ?
  ) SELECT id FROM thread ORDER BY id`;
/**
 * One thread's members for one request (ADR 0063), built once and grown as messages arrive:
 * ids only increase and a reply's parent is always older, so a new message is a member exactly
 * when the message it answers is. `through` is the newest id already looked at. Deleted
 * (tombstoned) members stay, because they still link their replies to the thread.
 */
type ThreadView = { root: number; ids: Set<number>; sorted: number[]; through: number };
/** Index of the first member id greater than `after`. */
function firstAfter(sorted: number[], after: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] <= after) low = middle + 1;
    else high = middle;
  }
  return low;
}
function processingReader(value: string | undefined): string {
  let reader: string;
  try {
    reader = decodeURIComponent(value ?? "");
  } catch {
    throw new HttpError(400, "invalid_reader", "Reader must be URL-encoded UTF-8.");
  }
  return text(reader, "reader", 128, "invalid_reader");
}
function processingInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new HttpError(400, "invalid_processing", `${field} must be a non-negative integer.`);
  return value;
}
function processingFence(url: URL): ProcessingFence | null {
  const reader = url.searchParams.get("processingReader");
  const generation = url.searchParams.get("generation");
  if (reader === null && generation === null) return null;
  if (reader === null || generation === null)
    throw new HttpError(400, "invalid_query", "processingReader and generation go together.");
  return {
    reader: text(reader, "processingReader", 128, "invalid_reader"),
    generation: integer(generation, 0, Number.MAX_SAFE_INTEGER),
  };
}

/** Old clients must keep seeing today's shape: unset annotations are omitted, not null. */
function toMessage(row: MessageRow, tenant: string): Message {
  const {
    replyTo,
    quote,
    correlationId,
    recipient,
    recipients,
    personaId,
    editedAt,
    choices,
    answer,
    answered,
    answerer,
    replaces,
    replacedBy,
    ...rest
  } = row;
  return {
    ...rest,
    tenant,
    ...(replyTo === null ? {} : { replyTo }),
    ...(quote == null ? {} : { quote }),
    ...(correlationId === null ? {} : { correlationId }),
    ...(recipient === null ? {} : { to: recipient }),
    ...(recipients == null ? {} : { recipients: JSON.parse(recipients) as string[] }),
    ...(personaId == null ? {} : { personaId }),
    ...(editedAt == null ? {} : { editedAt }),
    ...(choices == null ? {} : { choices: JSON.parse(choices) as string[] }),
    ...(answer == null ? {} : { answer }),
    ...(answered == null ? {} : { answered: JSON.parse(answered) as Answered }),
    ...(answerer == null ? {} : { answerer }),
    ...(replaces == null ? {} : { replaces }),
    ...(replacedBy == null ? {} : { replacedBy }),
  };
}

/** A message waiting to post at `sendAt` (ADR 0060). `tokenHash` is the digest of the key that
 * scheduled it, checked again when it posts; it is never returned. */
type ScheduledRow = {
  id: number;
  tenant: string;
  channel: string;
  username: string;
  text: string;
  contentType: ContentType;
  sendAt: string;
  createdAt: string;
  updatedAt: string;
  replyTo: number | null;
  /** The part of the replyTo message this scheduled reply quotes (ADR 0059). */
  quote: string | null;
  correlationId: string | null;
  recipient: string | null;
  recipients: string | null;
  personaId: string | null;
  labels: string | null;
  key: string | null;
  digest: string;
  tokenHash: string;
  notify: number;
  failedAt: string | null;
  error: string | null;
  errorMessage: string | null;
};
export type Scheduled = {
  id: number;
  tenant: string;
  channel: string;
  username: string;
  text: string;
  contentType: ContentType;
  sendAt: string;
  createdAt: string;
  updatedAt: string;
  replyTo?: number;
  quote?: string;
  correlationId?: string;
  to?: string;
  recipients?: string[];
  personaId?: string;
  labels?: Labels;
  /** `pending` until it posts (then it is a message and leaves the list); `failed` if it could not. */
  status: "pending" | "failed";
  failedAt?: string;
  error?: { code: string; message: string };
};
function toScheduled(row: ScheduledRow, tenant: string): Scheduled {
  return {
    id: row.id,
    tenant,
    channel: row.channel,
    username: row.username,
    text: row.text,
    contentType: row.contentType,
    sendAt: row.sendAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.replyTo === null ? {} : { replyTo: row.replyTo }),
    ...(row.quote == null ? {} : { quote: row.quote }),
    ...(row.correlationId === null ? {} : { correlationId: row.correlationId }),
    ...(row.recipient === null ? {} : { to: row.recipient }),
    ...(row.recipients == null ? {} : { recipients: JSON.parse(row.recipients) as string[] }),
    ...(row.personaId === null ? {} : { personaId: row.personaId }),
    ...(row.labels === null ? {} : { labels: JSON.parse(row.labels) as Labels }),
    status: row.failedAt === null ? "pending" : "failed",
    ...(row.failedAt === null
      ? {}
      : { failedAt: row.failedAt, error: { code: row.error ?? "failed", message: row.errorMessage ?? "" } }),
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
  const fields: (string | number | null | string[])[] =
    type === "text/plain" && replyTo === undefined && correlationId === undefined
      ? [username, text]
      : [username, text, type, replyTo ?? null, correlationId ?? null];
  // Several names (ADR 0067) hash as the list, so one name hashes exactly as before.
  if (correlation.recipients !== undefined) fields.push(correlation.recipients);
  else if (to !== undefined) fields.push(to);
  // A quote (ADR 0059) wraps the rest, so every send without one hashes exactly as before.
  let out =
    correlation.quote === undefined
      ? JSON.stringify(fields)
      : JSON.stringify([JSON.stringify(fields), { quote: correlation.quote }]);
  // Choices and answers (ADR 0065) wrap again, only when present, for the same reason.
  if (correlation.choices !== undefined || correlation.answer !== undefined)
    out = JSON.stringify([out, { choices: correlation.choices ?? null, answer: correlation.answer ?? null }]);
  // A replacement (ADR 0068) wraps again, only when present.
  if (correlation.replaces !== undefined) out = JSON.stringify([out, { replaces: correlation.replaces }]);
  return out;
}

/** One object per tenant. Channel indexes and message writes share one transaction boundary. */
export class MsnDurableObject extends DurableObject<Env> {
  private waiters = new Set<Waiter>();
  private eventWaiters = new Set<EventWaiter>();
  /** In-memory only: open listener polls and when the last one ended, per channel/persona key. */
  private listeners = new Map<string, { open: number; lastEnded: number }>();
  /** When `persona_presence` was last written per key; empty after a restart, so the first poll writes. */
  private presenceWritten = new Map<string, number>();

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
        INSERT OR IGNORE INTO usage(singleton, messages, bytes) VALUES (1, 0, 0);
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
        CREATE TABLE IF NOT EXISTS boards (
          channel TEXT PRIMARY KEY, goal TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
          revision INTEGER NOT NULL DEFAULT 1, updatedAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS channel_credentials(channel TEXT PRIMARY KEY, token TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS personas (
          channel TEXT NOT NULL, id TEXT NOT NULL, displayName TEXT NOT NULL, createdAt TEXT NOT NULL,
          PRIMARY KEY(channel,id)
        );
        CREATE TABLE IF NOT EXISTS persona_presence (
          channel TEXT NOT NULL, personaId TEXT NOT NULL, lastListeningAt TEXT NOT NULL,
          PRIMARY KEY(channel, personaId)
        );
        CREATE TABLE IF NOT EXISTS push_keys (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1), publicKey TEXT NOT NULL,
          privateJwk TEXT NOT NULL, subject TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, createdAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS push_mutes (
          person TEXT NOT NULL, channel TEXT NOT NULL, until TEXT, everything INTEGER NOT NULL DEFAULT 0,
          updatedAt TEXT NOT NULL, PRIMARY KEY(person, channel)
        );
        CREATE TABLE IF NOT EXISTS processing_cursors (
          channel TEXT NOT NULL, reader TEXT NOT NULL, committedThrough INTEGER NOT NULL,
          generation INTEGER NOT NULL, holder TEXT, claimedAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
          PRIMARY KEY(channel, reader)
        );
        CREATE TABLE IF NOT EXISTS reactions (
          channel TEXT NOT NULL, messageId INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
          createdAt TEXT NOT NULL, PRIMARY KEY(channel, messageId, kind, name)
        );
        CREATE TABLE IF NOT EXISTS message_labels (
          channel TEXT NOT NULL, messageId INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
          updatedAt TEXT NOT NULL, PRIMARY KEY(channel, messageId, key)
        );
        CREATE INDEX IF NOT EXISTS label_values ON message_labels(channel, key, value, messageId);
        CREATE TABLE IF NOT EXISTS attachments (
          channel TEXT NOT NULL, id TEXT NOT NULL, bytes INTEGER NOT NULL, createdAt TEXT NOT NULL,
          data BLOB NOT NULL, PRIMARY KEY(channel, id)
        );
        CREATE INDEX IF NOT EXISTS attachment_age ON attachments(createdAt);
        CREATE TABLE IF NOT EXISTS message_attachments (
          messageId INTEGER NOT NULL, position INTEGER NOT NULL, channel TEXT NOT NULL,
          attachmentId TEXT NOT NULL, name TEXT NOT NULL, mediaType TEXT NOT NULL,
          PRIMARY KEY(messageId, position)
        );
        CREATE INDEX IF NOT EXISTS attachment_refs ON message_attachments(channel, attachmentId);
        CREATE TABLE IF NOT EXISTS github_hook (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1), secret TEXT NOT NULL, createdAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS github_links (
          repo TEXT NOT NULL, number INTEGER NOT NULL, channel TEXT NOT NULL, anchorId INTEGER NOT NULL,
          headSha TEXT, greenSha TEXT, createdAt TEXT NOT NULL, PRIMARY KEY(repo, number, channel)
        );
        CREATE INDEX IF NOT EXISTS github_link_heads ON github_links(repo, headSha);
        CREATE TABLE IF NOT EXISTS pins (
          channel TEXT NOT NULL, messageId INTEGER NOT NULL, pinnedBy TEXT, pinnedAt TEXT NOT NULL,
          PRIMARY KEY(channel, messageId)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
          text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TABLE IF NOT EXISTS board_templates (
          name TEXT PRIMARY KEY, goal TEXT NOT NULL, personas TEXT NOT NULL, savedFrom TEXT NOT NULL,
          savedBy TEXT, createdAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS search_backfill (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1), indexedThrough INTEGER NOT NULL,
          target INTEGER NOT NULL
        );
        -- Scheduled messages (ADR 0060). A new table that starts empty, so no schema_version step:
        -- safe in any merge order. dueMs is sendAt in epoch ms, for the alarm's due query.
        CREATE TABLE IF NOT EXISTS scheduled_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, channel TEXT NOT NULL, username TEXT NOT NULL,
          text TEXT NOT NULL, contentType TEXT NOT NULL, sendAt TEXT NOT NULL, dueMs INTEGER NOT NULL,
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, replyTo INTEGER, correlationId TEXT,
          recipient TEXT, personaId TEXT, labels TEXT, key TEXT, digest TEXT NOT NULL,
          tokenHash TEXT NOT NULL, notify INTEGER NOT NULL, failedAt TEXT, error TEXT, errorMessage TEXT,
          quote TEXT
        );
        CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled_messages(dueMs) WHERE failedAt IS NULL;
        CREATE INDEX IF NOT EXISTS scheduled_channel ON scheduled_messages(channel, dueMs);
        -- Persona webhooks (ADR 0062). New tables with no version step, so they are safe in any
        -- merge order. The secret column is unused: notices are no longer signed, so it holds ''.
        CREATE TABLE IF NOT EXISTS webhooks (
          channel TEXT NOT NULL, personaId TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
          origin TEXT NOT NULL, createdAt TEXT NOT NULL, createdBy TEXT,
          lastStatus TEXT, lastNoticeId TEXT, lastAttemptAt TEXT, lastHttpStatus INTEGER,
          lastError TEXT, lastDeliveredAt TEXT, PRIMARY KEY(channel, personaId)
        );
        CREATE TABLE IF NOT EXISTS webhook_notices (
          id TEXT PRIMARY KEY, channel TEXT NOT NULL, personaId TEXT NOT NULL, body TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, nextAttemptMs INTEGER NOT NULL, createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS webhook_notices_due ON webhook_notices(nextAttemptMs);
        CREATE INDEX IF NOT EXISTS webhook_notices_hook ON webhook_notices(channel, personaId);
        -- Agent status (ADR 0064): what each name says it is doing, per board. A new table with no
        -- version step, so it is safe in any merge order. seq orders changes across the workspace.
        CREATE TABLE IF NOT EXISTS agent_status (
          channel TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, setAt TEXT NOT NULL,
          seq INTEGER NOT NULL, PRIMARY KEY(channel, name)
        );
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
      for (const [table, column, definition] of [
        ["access_keys", "owner_access", "INTEGER NOT NULL DEFAULT 0"],
        ["access_keys", "shared_channel", "INTEGER NOT NULL DEFAULT 0"],
        // Watch-only invitations and keys (ADR 0039). Additive with a safe default, so this needs
        // no schema_version step: older keys and invitations stay full participants.
        ["access_keys", "read_only", "INTEGER NOT NULL DEFAULT 0"],
        ["invites", "watch", "INTEGER NOT NULL DEFAULT 0"],
        // Archived boards (ADR 0046): NULL is active. Additive, so no schema_version step.
        ["channels", "archivedAt", "TEXT"],
        // Board mutes (ADR 0044): whose device this is. NULL for devices registered earlier, which
        // count as the workspace's own owner. Additive, so no schema_version step.
        ["push_subscriptions", "person", "TEXT"],
        ["messages", "personaId", "TEXT"],
        ["usage", "labelChanges", "INTEGER NOT NULL DEFAULT 0"],
        // Stored reactions (ADR 0047), for the workspace cap. The table is new with it, so 0 is
        // exact for every existing database. Additive, so no schema_version step.
        ["usage", "reactions", "INTEGER NOT NULL DEFAULT 0"],
        // Message edits (ADR 0052): NULL means never edited. editSeq orders edits across the
        // workspace for catch-up; usage.edits counts them for the cap. Additive, so no
        // schema_version step: every existing message reads back unedited.
        ["messages", "editedAt", "TEXT"],
        ["messages", "editSeq", "INTEGER"],
        ["usage", "edits", "INTEGER NOT NULL DEFAULT 0"],
        // Quotes in replies (ADR 0059): NULL quotes nothing. Additive, so no schema_version step.
        ["messages", "quote", "TEXT"],
        // Webhook bearer key (ADR 0062): sent as Authorization on each notice, NULL for none.
        // Additive, so no schema_version step.
        ["webhooks", "bearer", "TEXT"],
        // Agent status changes (ADR 0064), for the workspace cap and as the status sequence. The
        // table is new with it, so 0 is exact. Additive, so no schema_version step.
        ["usage", "statusChanges", "INTEGER NOT NULL DEFAULT 0"],
        // A scheduled reply's quote (ADR 0059/0060), for tables made before quotes existed.
        ["scheduled_messages", "quote", "TEXT"],
        // Questions with buttons (ADR 0065): NULL on every other message. Additive, so no
        // schema_version step and safe in any merge order.
        ["messages", "choices", "TEXT"],
        ["messages", "answer", "TEXT"],
        ["messages", "answered", "TEXT"],
        ["messages", "answerer", "TEXT"],
        // Several names (ADR 0067): a JSON list when a message names more than one, else NULL;
        // `recipient` keeps the first, so older reads and indexes see one name. Additive, no step.
        ["messages", "recipients", "TEXT"],
        ["scheduled_messages", "recipients", "TEXT"],
        // Replace an instruction with a newer one (ADR 0068): NULL on every other message.
        // Additive, so no schema_version step and safe in any merge order.
        ["messages", "replaces", "INTEGER"],
        ["messages", "replacedBy", "INTEGER"],
      ]) {
        if (
          !ctx.storage.sql
            .exec<{ name: string }>(`PRAGMA table_info(${table})`)
            .toArray()
            .some((c) => c.name === column)
        )
          ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
      // Notices are no longer signed (ADR 0062, amended): drop secrets made before that.
      ctx.storage.sql.exec("UPDATE webhooks SET secret = '' WHERE secret <> ''");
      // After the column loop: restored databases gain messages.personaId first. Serves lastActedAt.
      ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS persona_messages ON messages(channel, personaId, id)");
      // After the column loop too. Only edited messages are indexed; serves catch-up's edits.
      ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS message_edits ON messages(channel, editSeq) WHERE editSeq IS NOT NULL",
      );
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
        if (version < 10) ctx.storage.sql.exec("INSERT OR IGNORE INTO schema_version VALUES (10)");
        // v10 → v11: persona listening presence (ADR 0028); table and index are created above.
        if (version < 11) ctx.storage.sql.exec("INSERT OR IGNORE INTO schema_version VALUES (11)");
        // v11 → v12: owner push subscriptions and the workspace's VAPID key (ADR 0029). Both tables
        // are created above and start empty, so push stays off until an owner device subscribes.
        if (version < 12) ctx.storage.sql.exec("INSERT OR IGNORE INTO schema_version VALUES (12)");
        // v12 → v13: key=value message labels (ADR 0032). The table and usage.labelChanges are
        // created above; existing messages start with no labels.
        if (version < 13) ctx.storage.sql.exec("INSERT OR IGNORE INTO schema_version VALUES (13)");
        // v13 → v14: resumable processing cursors (ADR 0034). The table is created above and starts
        // empty; agents that never opt in keep local-only progress.
        if (version < 14) ctx.storage.sql.exec("INSERT OR IGNORE INTO schema_version VALUES (14)");
        // v14 → v15: message attachments (ADR 0035). Both tables are created above and start
        // empty; existing messages have no attachments.
        // v15 → v16: boards follow GitHub pull requests (ADR 0036). Both tables are created above and
        // start empty; nothing arrives until the owner links a pull request and adds the webhook.
        // v14 (ADR 0034) and v15 (ADR 0035) belong to other changes; both only add tables with
        // CREATE TABLE IF NOT EXISTS above, so recording them here is safe in any merge order.
        if (version < 16)
          for (const applied of [14, 15, 16])
            ctx.storage.sql.exec("INSERT OR IGNORE INTO schema_version VALUES (?)", applied);
        // v16 → v17: message search (ADR 0037). The index is created above and empty; every message
        // that exists now is indexed in batches by alarm(), and new sends are indexed as they land.
        if (version < 17) {
          ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO search_backfill(singleton, indexedThrough, target) SELECT 1, 0, COALESCE(MAX(id), 0) FROM messages",
          );
          ctx.storage.sql.exec("INSERT OR IGNORE INTO schema_version VALUES (17)");
        }
        // v17 → v18: owner-pinned messages (ADR 0038). The table is created above and starts empty.
        if (version < 18) ctx.storage.sql.exec("INSERT OR IGNORE INTO schema_version VALUES (18)");
        // v18 → v19: message reactions (ADR 0047). The table is created above and starts empty.
        if (version < 19) ctx.storage.sql.exec("INSERT OR IGNORE INTO schema_version VALUES (19)");
        // v19 → v20: saved board templates (ADR 0051). The table is created above and starts empty.
        if (version < 20) ctx.storage.sql.exec("INSERT OR IGNORE INTO schema_version VALUES (20)");
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
      // After the migrations, which give a v1 database its replyTo column. Only replies are
      // indexed; serves thread reads (ADR 0063). An index, so no version bump.
      ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS message_replies ON messages(channel, replyTo) WHERE replyTo IS NOT NULL",
      );
    });
    ctx.storage.transactionSync(() => this.coverSearchGap());
    if (!this.searchIndexed()) void ctx.storage.setAlarm(Date.now());
  }

  /** True once every message that existed at the v17 migration is in the search index. */
  private searchIndexed(): boolean {
    const state = this.ctx.storage.sql
      .exec<{ indexedThrough: number; target: number }>("SELECT indexedThrough, target FROM search_backfill")
      .toArray()[0];
    return !state || state.indexedThrough >= state.target;
  }

  /**
   * Messages newer than every indexed row and the backfill target were sent while code without
   * search ran (a rollback after v17 shipped). Extends the backfill over them; re-indexing a row
   * that is already indexed is harmless because backfill replaces rows.
   */
  private coverSearchGap(): void {
    const state = this.ctx.storage.sql
      .exec<{ target: number }>("SELECT target FROM search_backfill")
      .toArray()[0];
    const indexed =
      this.ctx.storage.sql
        .exec<{ rowid: number }>("SELECT rowid FROM message_search ORDER BY rowid DESC LIMIT 1")
        .toArray()[0]?.rowid ?? 0;
    const newest =
      this.ctx.storage.sql.exec<{ id: number | null }>("SELECT MAX(id) AS id FROM messages").one().id ?? 0;
    const covered = Math.max(indexed, state?.target ?? 0);
    if (newest <= covered) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO search_backfill(singleton, indexedThrough, target) VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET target = excluded.target,
         indexedThrough = CASE WHEN indexedThrough >= target THEN excluded.indexedThrough ELSE indexedThrough END`,
      covered,
      newest,
    );
  }

  /** Indexes the next batch of pre-v17 messages; returns true when nothing is left (ADR 0037). */
  backfillSearch(batch = SEARCH_BACKFILL_BATCH): boolean {
    return this.ctx.storage.transactionSync(() => {
      const state = this.ctx.storage.sql
        .exec<{ indexedThrough: number; target: number }>(
          "SELECT indexedThrough, target FROM search_backfill",
        )
        .toArray()[0];
      if (!state || state.indexedThrough >= state.target) return true;
      const rows = this.ctx.storage.sql
        .exec<{ id: number; text: string }>(
          "SELECT id, text FROM messages WHERE id > ? AND id <= ? AND deleted = 0 ORDER BY id LIMIT ?",
          state.indexedThrough,
          state.target,
          batch,
        )
        .toArray();
      for (const row of rows) {
        // Replace, never duplicate: a gap backfill can reach rows a send already indexed.
        this.ctx.storage.sql.exec("DELETE FROM message_search WHERE rowid = ?", row.id);
        this.ctx.storage.sql.exec("INSERT INTO message_search(rowid, text) VALUES (?, ?)", row.id, row.text);
      }
      const through = rows.length < batch ? state.target : (rows.at(-1)?.id ?? state.target);
      this.ctx.storage.sql.exec("UPDATE search_backfill SET indexedThrough = ? WHERE singleton = 1", through);
      return through >= state.target;
    });
  }

  /**
   * The object's one alarm serves three jobs: search backfill batches (ADR 0037), scheduled
   * messages (ADR 0060) and webhook notices (ADR 0062). Each run does a backfill batch, posts the
   * scheduled messages that are due, sends the notices that are due, then sets the alarm for the
   * earliest remaining work. Each job catches its own errors, and the alarm is set again whatever
   * happens, so one failing job never stops the others.
   */
  async alarm(): Promise<void> {
    let failed = false;
    try {
      try {
        this.backfillSearch();
      } catch (error) {
        failed = true;
        console.error("alarm: search backfill failed", error);
      }
      try {
        this.postDue();
      } catch (error) {
        failed = true;
        console.error("alarm: scheduled delivery failed", error);
      }
      try {
        await this.sendDueNotices();
      } catch (error) {
        failed = true;
        console.error("alarm: webhook delivery failed", error);
      }
    } finally {
      // A job that keeps failing must not spin the alarm: wait before the next run.
      await this.armAlarm(failed ? ALARM_FAILURE_BACKOFF_MS : 0);
    }
  }

  /**
   * Sets the alarm to now while backfill remains, else to the earliest of: the next scheduled
   * message due (ADR 0060), the time the oldest failed one expires, and the next webhook notice
   * due (ADR 0062). Deletes it when nothing is left, so an idle workspace has no alarm. Every job
   * that adds work calls this. `notBeforeMs` delays the next run after a failed one.
   */
  async armAlarm(notBeforeMs = 0): Promise<void> {
    const times = this.ctx.storage.sql
      .exec<{ due: number | null; failed: string | null; notice: number | null }>(
        `SELECT (SELECT MIN(dueMs) FROM scheduled_messages WHERE failedAt IS NULL) AS due,
           (SELECT MIN(failedAt) FROM scheduled_messages WHERE failedAt IS NOT NULL) AS failed,
           (SELECT MIN(nextAttemptMs) FROM webhook_notices) AS notice`,
      )
      .one();
    const candidates = [
      this.searchIndexed() ? null : Date.now(),
      times.due,
      times.failed === null ? null : Date.parse(times.failed) + FAILED_SCHEDULED_TTL_MS,
      times.notice,
    ].filter((time): time is number => time !== null);
    let next: number | null = candidates.length ? Math.min(...candidates) : null;
    if (next === null) {
      if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (notBeforeMs) next = Math.max(next, Date.now() + notBeforeMs);
    if ((await this.ctx.storage.getAlarm()) !== next) await this.ctx.storage.setAlarm(next);
  }

  /**
   * Posts every scheduled message whose time has come, oldest first (ADR 0060). Each one posts
   * exactly as a send from the key that scheduled it would now: the key must still exist and
   * reach the board, and the board must be active. The message insert and the removal from the
   * schedule commit together. One that cannot post stays listed as failed, with the reason.
   */
  postDue(now = Date.now()): number {
    this.expireFailedScheduled(now);
    const due = this.ctx.storage.sql
      .exec<ScheduledRow>(
        "SELECT * FROM scheduled_messages WHERE failedAt IS NULL AND dueMs <= ? ORDER BY dueMs, id LIMIT ?",
        now,
        SCHEDULED_BATCH,
      )
      .toArray();
    let posted = 0;
    for (const row of due) {
      try {
        let capability: TenantRow;
        try {
          capability = this.authorize(row.tokenHash);
        } catch {
          throw new HttpError(
            403,
            "key_revoked",
            "The key that scheduled this message was revoked or rotated. Change its time with a current key to post it.",
          );
        }
        this.requireScope(capability, row.channel);
        this.requireBoundName(capability, row.username);
        if (row.personaId !== null) {
          const persona = this.ctx.storage.sql
            .exec<{ displayName: string }>(
              "SELECT displayName FROM personas WHERE channel = ? AND id = ?",
              row.channel,
              row.personaId,
            )
            .toArray()[0];
          if (!persona || persona.displayName !== row.username)
            throw new HttpError(
              400,
              "persona_mismatch",
              "The persona that scheduled this message was removed or renamed.",
            );
        }
        const response = this.send(
          row.tenant,
          row.channel,
          row.username,
          row.text,
          row.contentType,
          {
            ...(row.replyTo === null ? {} : { replyTo: row.replyTo }),
            ...(row.quote == null ? {} : { quote: row.quote }),
            ...(row.correlationId === null ? {} : { correlationId: row.correlationId }),
            ...(row.recipient === null ? {} : { to: row.recipient }),
            ...(row.recipients == null ? {} : { recipients: JSON.parse(row.recipients) as string[] }),
          },
          row.key,
          row.digest,
          row.personaId,
          Boolean(row.notify),
          row.labels === null ? undefined : (JSON.parse(row.labels) as Labels),
          [],
          row.id,
        );
        if (response.status < 300) posted++;
      } catch (error) {
        const failure =
          error instanceof HttpError
            ? { code: error.code, message: error.message }
            : { code: "internal_error", message: "The message could not be posted." };
        this.ctx.storage.sql.exec(
          "UPDATE scheduled_messages SET failedAt = ?, error = ?, errorMessage = ? WHERE id = ?",
          new Date().toISOString(),
          failure.code,
          failure.message,
          row.id,
        );
      }
    }
    return posted;
  }

  /** Removes scheduled messages that failed more than `FAILED_SCHEDULED_TTL_MS` ago. */
  private expireFailedScheduled(now = Date.now()): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM scheduled_messages WHERE failedAt IS NOT NULL AND failedAt < ?",
      new Date(now - FAILED_SCHEDULED_TTL_MS).toISOString(),
    );
  }

  async accountSession(tenant: string, username: string) {
    const token = newToken();
    const hash = await digest(token);
    this.ctx.storage.transactionSync(() => {
      if (!this.tenantRow()) {
        this.ctx.storage.sql.exec(
          "INSERT INTO tenant(singleton,token_hash,bound_username,bound_prefix) VALUES(1,?,?,NULL)",
          hash,
          username,
        );
      } else {
        this.requireKeyCapacity();
        this.ctx.storage.sql.exec(
          "INSERT INTO access_keys(id,token_hash,bound_username,createdAt,owner_access) VALUES(?,?,?,?,1)",
          crypto.randomUUID(),
          hash,
          username,
          new Date().toISOString(),
        );
      }
    });
    return { tenant, username, token, owner: true };
  }

  private async boardRoute(
    request: Request,
    tenant: string,
    channel: string,
    rest: string[],
    hash: string,
  ): Promise<Response> {
    const input = request.method === "PUT" || request.method === "POST" ? await body(request) : null;
    const secret =
      rest[0] === "board" && request.method === "PUT" ? text(input?.credential, "credential", 64) : null;
    if (secret && !/^[a-f0-9]{64}$/.test(secret))
      throw new HttpError(400, "invalid_credential", "Use a random 256-bit channel credential.");
    const secretHash = secret ? await digest(secret) : null;
    const capability = this.authorize(hash);
    this.requireScope(capability, channel);
    // Rechecked after the awaits above: an archive that landed meanwhile still wins (ADR 0046).
    if (request.method !== "GET") this.requireActive(channel);
    if (rest.join("/") === "board/connection" && request.method === "GET") {
      if (!capability.owner_access && !capability.shared_channel)
        throw new HttpError(
          403,
          "channel_connection_required",
          "Use the owner or shared channel connection.",
        );
      this.board(channel);
      const row = this.ctx.storage.sql
        .exec<{ token: string }>(
          "SELECT c.token FROM channel_credentials c JOIN access_keys a ON a.channel_scope=c.channel AND a.shared_channel=1 WHERE c.channel=?",
          channel,
        )
        .toArray()[0];
      if (!row)
        throw new HttpError(404, "channel_connection_missing", "Recreate shared access with board create.");
      return json({
        url: new URL(request.url).origin,
        tenant,
        token: row.token,
        channel,
        sharedChannel: true,
      });
    }
    if (rest[0] === "personas") {
      this.board(channel);
      if (rest.length === 1 && request.method === "GET") {
        return json({
          personas: this.roster(channel),
        });
      }
      if (rest.length === 2 && request.method === "PUT") {
        const id = slug(rest[1]);
        const displayName = text(input?.displayName, "displayName", 128);
        if (displayName === GITHUB_SENDER)
          throw new HttpError(
            403,
            "reserved_name",
            "The display name github is reserved for GitHub messages.",
          );
        const existing = this.ctx.storage.sql
          .exec<{ displayName: string }>(
            "SELECT displayName FROM personas WHERE channel=? AND id=?",
            channel,
            id,
          )
          .toArray()[0];
        if (existing && existing.displayName !== displayName)
          throw new HttpError(
            409,
            "persona_conflict",
            "This persona ID already has a different display name.",
          );
        const sameName = this.ctx.storage.sql
          .exec(
            "SELECT id FROM personas WHERE channel=? AND displayName=? AND id<>?",
            channel,
            displayName,
            id,
          )
          .toArray();
        if (sameName.length)
          throw new HttpError(409, "persona_name_conflict", "Choose another display name in this channel.");
        if (!existing)
          this.ctx.storage.sql.exec(
            "INSERT INTO personas VALUES(?,?,?,?)",
            channel,
            id,
            displayName,
            new Date().toISOString(),
          );
        return json({ id, displayName, channel, attribution: "shared-channel" }, existing ? 200 : 201);
      }
    }
    if (rest[0] === "board" && rest.length === 1) {
      if (request.method === "GET") return json({ board: this.board(channel) });
      if (request.method === "PUT" && secretHash) {
        this.requireOwner(capability);
        const goal = text(input?.goal, "goal", 16384);
        const existing = this.ctx.storage.sql
          .exec<{ token_hash: string }>(
            "SELECT token_hash FROM access_keys WHERE channel_scope=? AND shared_channel=1",
            channel,
          )
          .toArray()[0];
        if (existing) {
          if (!equalHash(existing.token_hash, secretHash))
            throw new HttpError(
              409,
              "board_exists",
              "Board already exists. Use its saved channel connection or rotate access explicitly.",
            );
          return json({ board: this.board(channel), sharedChannel: true });
        }
        this.ctx.storage.transactionSync(() => {
          this.requireKeyCapacity();
          this.createChannel(channel);
          this.ctx.storage.sql.exec(
            "INSERT INTO access_keys(id,token_hash,bound_username,bound_prefix,createdAt,channel_scope,shared_channel) VALUES(?,?,NULL,NULL,?,?,1)",
            `board-${channel}`,
            secretHash,
            new Date().toISOString(),
            channel,
          );
          this.ctx.storage.sql.exec(
            "INSERT INTO boards(channel,goal,updatedAt) VALUES(?,?,?) ON CONFLICT(channel) DO NOTHING",
            channel,
            goal,
            new Date().toISOString(),
          );
          this.ctx.storage.sql.exec(
            "INSERT INTO channel_credentials VALUES(?,?) ON CONFLICT(channel) DO UPDATE SET token=excluded.token",
            channel,
            secret,
          );
        });
        this.wakeEvents(channel);
        return json({ board: this.board(channel), sharedChannel: true }, 201);
      }
      if (request.method === "POST") {
        const current = this.board(channel);
        const revision = snapshotInteger(input?.revision, "revision");
        if (current.revision !== revision)
          throw new HttpError(409, "board_revision_conflict", "Read the current board before updating it.");
        const goal = input?.goal === undefined ? current.goal : text(input.goal, "goal", 16384);
        const status = input?.status ?? current.status;
        if (!["active", "paused", "complete", "blocked"].includes(status as string))
          throw new HttpError(400, "invalid_board_status", "Use active, paused, complete or blocked.");
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
            "UPDATE boards SET goal=?,status=?,revision=revision+1,updatedAt=? WHERE channel=?",
            goal,
            status,
            new Date().toISOString(),
            channel,
          );
          // A visible control message wakes existing message/event clients without a new event protocol.
          this.send(
            tenant,
            channel,
            "board",
            JSON.stringify({
              schema: "msn.board.v1",
              goal: goal.length > 1024 ? `${goal.slice(0, 1024)}…` : goal,
              status,
              revision: revision + 1,
            }),
            "application/json",
            {},
            null,
            `board-${revision + 1}`,
            null,
            // Notify the owner only when an agent newly blocks the board, never for their own change.
            !capability.owner_access && current.status !== "blocked",
          );
        });
        return json({ board: this.board(channel) });
      }
    }
    if (rest.join("/") === "board/rotate" && request.method === "POST") {
      this.requireOwner(capability);
      const credential = text(input?.credential, "credential", 64);
      if (!/^[a-f0-9]{64}$/.test(credential))
        throw new HttpError(400, "invalid_credential", "Use a random channel credential.");
      const nextHash = await digest(credential);
      this.requireOwner(this.authorize(hash));
      this.requireActive(channel);
      this.board(channel);
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "UPDATE access_keys SET token_hash=? WHERE channel_scope=? AND shared_channel=1",
          nextHash,
          channel,
        );
        this.ctx.storage.sql.exec(
          "UPDATE channel_credentials SET token=? WHERE channel=?",
          credential,
          channel,
        );
      });
      for (const waiter of this.waiters) waiter.wake();
      for (const waiter of this.eventWaiters) waiter.wake();
      return json({ rotated: true, channel });
    }
    throw new HttpError(404, "route_not_found", "Unknown board operation.");
  }

  /** Personas with listening presence (ADR 0028). Unknown times are null, never omitted. */
  private roster(channel: string) {
    const now = Date.now();
    return this.ctx.storage.sql
      .exec<{
        id: string;
        displayName: string;
        createdAt: string;
        lastListeningAt: string | null;
        lastActedAt: string | null;
        statusText: string | null;
        statusSetAt: string | null;
      }>(
        `SELECT p.id, p.displayName, p.createdAt, pp.lastListeningAt, s.text AS statusText,
           s.setAt AS statusSetAt,
           (SELECT m.createdAt FROM messages m WHERE m.channel=p.channel AND m.personaId=p.id AND m.deleted=0
            ORDER BY m.id DESC LIMIT 1) AS lastActedAt
         FROM personas p LEFT JOIN persona_presence pp ON pp.channel=p.channel AND pp.personaId=p.id
         LEFT JOIN agent_status s ON s.channel=p.channel AND s.name=p.displayName
         WHERE p.channel=? ORDER BY p.createdAt, p.id`,
        channel,
      )
      .toArray()
      .map((row) => {
        const live = this.listeners.get(JSON.stringify([channel, row.id]));
        const seen = live ? (live.open ? now : live.lastEnded) : null;
        const stored = row.lastListeningAt === null ? null : Date.parse(row.lastListeningAt);
        const last = Math.max(seen ?? -1, stored ?? -1);
        return {
          id: row.id,
          displayName: row.displayName,
          createdAt: row.createdAt,
          listening: seen !== null && now - seen < LISTENING_GRACE_MS,
          lastListeningAt: last < 0 ? null : new Date(last).toISOString(),
          lastActedAt: row.lastActedAt,
          // What the agent last said it is doing (ADR 0064); never inferred.
          status: row.statusText === null ? null : { text: row.statusText, setAt: row.statusSetAt as string },
        };
      });
  }

  /**
   * Agent status (ADR 0064). `GET …/statuses` lists every name's status on the board.
   * `PUT …/status {username, text}` sets one (text null clears it); `DELETE …/status?username=`
   * clears one. Names follow the send rules: a bound key sets only its own name, and a board's
   * shared credential only a registered persona. A change writes one metadata-only
   * `status.changed` event; the same text again changes nothing.
   */
  private async statusRoute(
    request: Request,
    url: URL,
    channel: string,
    kind: string,
    hash: string,
  ): Promise<Response> {
    if (kind === "statuses") {
      if (request.method !== "GET")
        throw new HttpError(404, "route_not_found", "Use GET …/statuses, or PUT or DELETE …/status.");
      const capability = this.authorize(hash);
      this.requireScope(capability, channel);
      this.requireChannel(channel);
      return json({ channel, statuses: this.statuses(channel), statusSeq: this.statusSeq() });
    }
    let change: { username: string; text: string | null };
    if (request.method === "PUT") change = statusChange(await body(request));
    else if (request.method === "DELETE")
      change = { username: text(url.searchParams.get("username") ?? undefined, "username", 128), text: null };
    else throw new HttpError(404, "route_not_found", "Use PUT to set a status and DELETE to clear it.");
    const capability = this.authorize(hash);
    // Scope first, so a key for another board learns nothing about this board's personas.
    this.requireScope(capability, channel);
    this.requireChannel(channel);
    // The archive gate ran before the body was read; check again (ADR 0046).
    this.requireActive(channel);
    this.requireBoundName(capability, change.username);
    if (change.username === GITHUB_SENDER)
      throw new HttpError(403, "reserved_name", "The display name github is reserved for GitHub messages.");
    if (
      capability.shared_channel &&
      !this.ctx.storage.sql
        .exec("SELECT 1 FROM personas WHERE channel=? AND displayName=?", channel, change.username)
        .toArray().length
    )
      throw new HttpError(
        400,
        "persona_required",
        `Register this name as a board persona first: PUT …/channels/${channel}/personas/ID with {"displayName":${JSON.stringify(change.username)}} (CLI: msn persona add). Steps: GET /api.`,
      );
    const changed = this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.sql
        .exec<{ text: string }>(
          "SELECT text FROM agent_status WHERE channel = ? AND name = ?",
          channel,
          change.username,
        )
        .toArray()[0];
      if ((current?.text ?? null) === change.text) return false;
      if (current === undefined) {
        const count = this.ctx.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_status WHERE channel = ?", channel)
          .one().n;
        if (count >= MAX_STATUSES)
          throw new HttpError(
            409,
            "status_limit",
            `At most ${MAX_STATUSES} names can have a status on one board. Clear some first.`,
          );
      }
      const used = this.ctx.storage.sql
        .exec<{ statusChanges: number }>("SELECT statusChanges FROM usage")
        .one().statusChanges;
      // The cap stops new text only: a clear always goes through, so no line can outlive the
      // quota. Clears past it are bounded by the live rows, which the event ceiling reserves.
      if (used >= MAX_STATUS_CHANGES && change.text !== null)
        throw new HttpError(
          409,
          "status_quota",
          `This workspace has used all ${MAX_STATUS_CHANGES.toLocaleString("en-US")} status changes. Statuses can still be cleared.`,
        );
      const seq = used + 1;
      this.ctx.storage.sql.exec("UPDATE usage SET statusChanges = ? WHERE singleton = 1", seq);
      if (change.text === null)
        this.ctx.storage.sql.exec(
          "DELETE FROM agent_status WHERE channel = ? AND name = ?",
          channel,
          change.username,
        );
      else
        this.ctx.storage.sql.exec(
          `INSERT INTO agent_status(channel, name, text, setAt, seq) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(channel, name) DO UPDATE SET text = excluded.text, setAt = excluded.setAt, seq = excluded.seq`,
          channel,
          change.username,
          change.text,
          new Date().toISOString(),
          seq,
        );
      // Metadata only: the event names the change's sequence number, never the text.
      this.insertEvent(channel, "status.changed", seq);
      return true;
    });
    if (changed) this.wakeEvents(channel);
    const status = this.statuses(channel).find((row) => row.name === change.username) ?? null;
    return json({ channel, status, changed });
  }

  private statuses(channel: string) {
    return this.ctx.storage.sql
      .exec<{ name: string; text: string; setAt: string; seq: number; personaId: string | null }>(
        `SELECT s.name, s.text, s.setAt, s.seq, p.id AS personaId FROM agent_status s
         LEFT JOIN personas p ON p.channel = s.channel AND p.displayName = s.name
         WHERE s.channel = ? ORDER BY s.setAt DESC, s.name`,
        channel,
      )
      .toArray()
      .map(({ personaId, ...row }) => (personaId === null ? row : { ...row, personaId }));
  }

  /** The workspace's status sequence: the `seq` of the newest change (ADR 0064). */
  private statusSeq(): number {
    return this.ctx.storage.sql.exec<{ statusChanges: number }>("SELECT statusChanges FROM usage").one()
      .statusChanges;
  }

  /** A listener poll started or ended: update memory, and persist at most every few minutes. */
  private touchListener(key: string, channel: string, personaId: string, delta: number) {
    const now = Date.now();
    const entry = this.listeners.get(key) ?? { open: 0, lastEnded: now };
    entry.open = Math.max(0, entry.open + delta);
    entry.lastEnded = now;
    this.listeners.set(key, entry);
    const written = this.presenceWritten.get(key);
    if (written !== undefined && now - written < PRESENCE_WRITE_INTERVAL_MS) return;
    this.presenceWritten.set(key, now);
    this.ctx.storage.sql.exec(
      "INSERT INTO persona_presence VALUES(?,?,?) ON CONFLICT(channel, personaId) DO UPDATE SET lastListeningAt=excluded.lastListeningAt",
      channel,
      personaId,
      new Date(now).toISOString(),
    );
  }

  /** `listener=<personaId>` is accepted only on a board's shared credential, for a registered persona. */
  private listenerPersona(capability: TenantRow, value: string | null): string | null {
    if (value === null) return null;
    const id = slug(value);
    if (!capability.shared_channel || !capability.channel_scope)
      throw new HttpError(400, "listener_requires_board", "Only a board persona can report listening.");
    const known = this.ctx.storage.sql
      .exec("SELECT 1 FROM personas WHERE channel=? AND id=?", capability.channel_scope, id)
      .toArray();
    if (!known.length)
      throw new HttpError(400, "listener_unknown_persona", "Register this persona before listening.");
    return id;
  }

  /** Owner-only device registration for push notifications (ADR 0029). */
  private async pushRoute(request: Request, url: URL, rest: string[], capability: TenantRow) {
    this.requireOwner(capability);
    if (rest[0] === "mutes") return await this.muteRoute(request, rest.slice(1), capability);
    if (!rest.length && request.method === "GET") {
      if (!this.vapidKeys()) {
        const keys = await generateVapidKeys();
        // A concurrent first request may have won; the first stored key stays.
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO push_keys(singleton,publicKey,privateJwk,subject) VALUES(1,?,?,?)",
          keys.publicKey,
          keys.privateJwk,
          url.protocol === "https:" ? url.origin : "mailto:msn@localhost",
        );
      }
      const devices = this.ctx.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM push_subscriptions")
        .one().n;
      return json({ publicKey: this.vapidKeys()?.publicKey, devices });
    }
    if (rest.length === 1 && rest[0] === "subscriptions" && ["PUT", "DELETE"].includes(request.method)) {
      const input = await body(request);
      if (request.method === "DELETE") {
        const endpoint = typeof input?.endpoint === "string" ? input.endpoint : "";
        this.ctx.storage.sql.exec("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
        return new Response(null, { status: 204 });
      }
      const subscription = parseSubscription(input);
      if (!this.vapidKeys())
        throw new HttpError(409, "push_not_ready", "Read the push key with GET push first.");
      this.ctx.storage.transactionSync(() => {
        const known = this.ctx.storage.sql
          .exec("SELECT endpoint FROM push_subscriptions WHERE endpoint = ?", subscription.endpoint)
          .toArray().length;
        const count = this.ctx.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM push_subscriptions")
          .one().n;
        if (!known && count >= MAX_PUSH_SUBSCRIPTIONS)
          throw new HttpError(409, "push_quota", "Turn notifications off on another device first.");
        this.ctx.storage.sql.exec(
          "INSERT INTO push_subscriptions(endpoint,p256dh,auth,createdAt,person) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, person=excluded.person",
          subscription.endpoint,
          subscription.p256dh,
          subscription.auth,
          new Date().toISOString(),
          this.person(capability),
        );
      });
      return json({ subscribed: true }, 201);
    }
    throw new HttpError(404, "route_not_found", "Unknown push operation.");
  }

  /**
   * The person a mute and a device belong to (ADR 0044): the owner credential's account name.
   * An unbound legacy workspace token is the empty name.
   */
  private person(capability: TenantRow): string {
    return capability.bound_username ?? "";
  }

  /** Mutes of one person that have not expired, by board. Expired rows are ignored, not swept. */
  private activeMutes(person: string, now = Date.now()): MuteRow[] {
    return this.ctx.storage.sql
      .exec<MuteRow>(
        "SELECT channel, until, everything FROM push_mutes WHERE person = ? AND (until IS NULL OR until > ?) ORDER BY channel",
        person,
        new Date(now).toISOString(),
      )
      .toArray();
  }

  /** Owner-only, per person: mute one board's notifications forever, for 1h or for 1d (ADR 0044). */
  private async muteRoute(request: Request, rest: string[], capability: TenantRow) {
    const person = this.person(capability);
    const view = (row: MuteRow) => ({
      channel: row.channel,
      until: row.until,
      everything: row.everything === 1,
    });
    if (!rest.length && request.method === "GET") return json({ mutes: this.activeMutes(person).map(view) });
    if (rest.length !== 1 || !["PUT", "DELETE"].includes(request.method))
      throw new HttpError(404, "route_not_found", "Unknown mute operation.");
    const channel = slug(rest[0]);
    if (request.method === "DELETE") {
      this.ctx.storage.sql.exec("DELETE FROM push_mutes WHERE person = ? AND channel = ?", person, channel);
      return new Response(null, { status: 204 });
    }
    const input = await optionalBody(request);
    const span = input.for ?? null;
    if (span !== null && (typeof span !== "string" || MUTE_DURATIONS[span] === undefined))
      throw new HttpError(400, "invalid_mute", "for must be 1h or 1d; leave it out to mute until unmuted.");
    const everything = input.everything ?? false;
    if (typeof everything !== "boolean")
      throw new HttpError(400, "invalid_mute", "everything must be true or false.");
    this.requireChannel(channel);
    const now = Date.now();
    const row: MuteRow = {
      channel,
      until: span === null ? null : new Date(now + (MUTE_DURATIONS[span] as number)).toISOString(),
      everything: everything ? 1 : 0,
    };
    this.ctx.storage.transactionSync(() => {
      // Expired rows of this person go now, so the table only grows with live mutes.
      this.ctx.storage.sql.exec(
        "DELETE FROM push_mutes WHERE person = ? AND until IS NOT NULL AND until <= ?",
        person,
        new Date(now).toISOString(),
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO push_mutes(person,channel,until,everything,updatedAt) VALUES(?,?,?,?,?) ON CONFLICT(person,channel) DO UPDATE SET until=excluded.until, everything=excluded.everything, updatedAt=excluded.updatedAt",
        person,
        channel,
        row.until,
        row.everything,
        new Date(now).toISOString(),
      );
    });
    return json(view(row));
  }

  private vapidKeys(): (VapidKeys & { subject: string }) | undefined {
    return this.ctx.storage.sql
      .exec<VapidKeys & { subject: string }>("SELECT publicKey, privateJwk, subject FROM push_keys")
      .toArray()[0];
  }

  /**
   * The one exact name that may answer a question addressed to `to` (ADR 0065), fixed when it is
   * asked. Known names are the workspace binding, every bound key, the board's personas and the
   * board's senders. Someone holding `to` exactly wins; otherwise the one known name equal to it
   * trimmed and ignoring case; otherwise (none, or several) `to` as written. Names are unique only
   * by exact case, so "Bob" never lets "bob" answer.
   */
  private resolveAnswerer(channel: string, to: string): string {
    const names = new Set<string>();
    const tenant = this.tenantRow();
    if (tenant?.bound_username) names.add(tenant.bound_username);
    const sql = this.ctx.storage.sql;
    for (const { name } of sql
      .exec<{ name: string }>(
        `SELECT bound_username AS name FROM access_keys WHERE bound_username IS NOT NULL
         UNION SELECT displayName AS name FROM personas WHERE channel = ?
         UNION SELECT username AS name FROM messages WHERE channel = ? AND deleted = 0`,
        channel,
        channel,
      )
      .toArray())
      names.add(name);
    if (names.has(to)) return to;
    const fold = (name: string) => name.trim().toLowerCase();
    const folded = [...names].filter((name) => fold(name) === fold(to));
    return folded.length === 1 ? folded[0] : to;
  }

  /** Account names that belong to the owner: the workspace binding and every owner login. */
  private ownerNames(): Set<string> {
    const names = new Set<string>();
    const tenant = this.tenantRow();
    if (tenant?.bound_username) names.add(tenant.bound_username);
    for (const row of this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT DISTINCT bound_username AS name FROM access_keys WHERE owner_access = 1 AND bound_username IS NOT NULL",
      )
      .toArray())
      names.add(row.name);
    return names;
  }

  /** Fire-and-forget: a sender never waits for, or fails because of, a notification. */
  private notifyOwner(message: Message): void {
    const keys = this.vapidKeys();
    if (!keys) return;
    const devices = this.ctx.storage.sql
      .exec<PushSubscription & { person: string | null }>(
        "SELECT endpoint, p256dh, auth, person FROM push_subscriptions",
      )
      .toArray();
    if (!devices.length) return;
    const attention = needsOwner(message, this.ownerNames());
    if (!attention) return;
    // Board mutes (ADR 0044), checked now so nothing runs while idle. A message addressed to the
    // person still reaches them unless they also muted everything.
    const now = Date.now();
    const fallback = this.tenantRow()?.bound_username ?? "";
    const muted = new Map<string, boolean>();
    const silenced = (person: string) => {
      let value = muted.get(person);
      if (value === undefined) {
        const mute = this.ctx.storage.sql
          .exec<{ everything: number }>(
            "SELECT everything FROM push_mutes WHERE person = ? AND channel = ? AND (until IS NULL OR until > ?)",
            person,
            message.channel,
            new Date(now).toISOString(),
          )
          .toArray()[0];
        value = mute !== undefined && (mute.everything === 1 || !addressees(message).includes(person));
        muted.set(person, value);
      }
      return value;
    };
    // At most one push per board, reason and person per cooldown, so a looping or noisy sender
    // cannot flood anyone. A person who muted the board does not start the cooldown, and one
    // person's push does not hold back another's. The board itself still records every message.
    const allowed = new Map<string, boolean>();
    const due = (person: string) => {
      let value = allowed.get(person);
      if (value === undefined) {
        const throttle = JSON.stringify([message.channel, attention.reason, person]);
        const last = this.pushSentAt.get(throttle);
        value = !silenced(person) && (last === undefined || now - last >= this.pushCooldownMs);
        if (value) this.pushSentAt.set(throttle, now);
        allowed.set(person, value);
      }
      return value;
    };
    const subscriptions = devices.filter((device) => due(device.person ?? fallback));
    if (!subscriptions.length) return;
    const payload = {
      schema: "msn.push.v1",
      tenant: message.tenant,
      channel: message.channel,
      messageId: message.id,
      reason: attention.reason,
      title: `#${message.channel}`,
      body: `${message.username}: ${attention.summary}`,
    };
    this.ctx.waitUntil(
      Promise.allSettled(
        subscriptions.map(async ({ endpoint, p256dh, auth }) => {
          const subscription = { endpoint, p256dh, auth };
          const result = await sendPush(keys, subscription, keys.subject, payload, this.pushFetch);
          // The push service says this device unsubscribed; stop sending to it.
          if (result === "gone")
            this.ctx.storage.sql.exec(
              "DELETE FROM push_subscriptions WHERE endpoint = ?",
              subscription.endpoint,
            );
        }),
      ),
    );
  }

  /** Last push time per [board, reason, person]; memory only, so it resets when the object restarts. */
  private pushSentAt = new Map<string, number>();
  /** Replaced in tests. */
  pushCooldownMs = 60_000;
  /** Replaced in tests; production calls the push service directly. */
  pushFetch: typeof fetch = (input, init) => fetch(input, init);

  /** Replaced in tests; production calls the owner's webhook URL directly (ADR 0062). */
  webhookFetch: typeof fetch = (input, init) => fetch(input, init);

  /**
   * Queues a notice when the message is addressed to a board persona with a webhook (ADR 0062).
   * Runs inside the send transaction. A persona's own messages never wake it. Returns true when a
   * notice was queued, so the caller arms the alarm after the commit.
   */
  private queueAddressedNotice(message: Message, eventId: number): boolean {
    const names = addressees(message);
    if (!names.length) return false;
    // An exact name wins; otherwise names match trimmed and ignoring case, as unread counts do
    // ("@Reviewer" wakes "reviewer"). Names are unique only by exact case, so the exact match
    // decides between "Reviewer" and "reviewer", and the folded fallback takes the oldest persona.
    const fold = (name: string) => name.trim().toLowerCase();
    const hooks = this.ctx.storage.sql
      .exec<{ personaId: string; origin: string; displayName: string }>(
        `SELECT w.personaId, w.origin, p.displayName FROM webhooks w JOIN personas p ON p.channel = w.channel AND p.id = w.personaId
         WHERE w.channel = ? ORDER BY p.createdAt, p.id`,
        message.channel,
      )
      .toArray();
    // Each addressed name wakes its persona (ADR 0067); two names that find one persona wake it once.
    const woken = new Map<string, (typeof hooks)[number]>();
    for (const name of names) {
      const hook =
        hooks.find((row) => row.displayName === name) ??
        hooks.find((row) => fold(row.displayName) === fold(name));
      // A persona's own message never wakes it: same persona id, or sent under its exact name.
      if (!hook || message.personaId === hook.personaId || message.username === hook.displayName) continue;
      woken.set(hook.personaId, hook);
    }
    const path = `/api/tenants/${message.tenant}/channels/${message.channel}/messages/${message.id}`;
    let queued = false;
    for (const hook of woken.values())
      queued =
        this.queueNotice(message.channel, hook.personaId, {
          schema: "msn.webhook.v1",
          type: "message.addressed",
          id: crypto.randomUUID(),
          tenant: message.tenant,
          channel: message.channel,
          persona: hook.personaId,
          messageId: message.id,
          eventId,
          messageUrl: `${hook.origin}${path}`,
          createdAt: message.createdAt,
        }) || queued;
    return queued;
  }

  /** Stores one notice, due now. A full backlog drops it and records the drop on the webhook. */
  private queueNotice(channel: string, personaId: string, notice: Notice): boolean {
    const waiting = this.ctx.storage.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM webhook_notices WHERE channel = ? AND personaId = ?",
        channel,
        personaId,
      )
      .one().n;
    if (waiting >= MAX_PENDING_NOTICES) {
      this.ctx.storage.sql.exec(
        "UPDATE webhooks SET lastStatus = 'dropped', lastNoticeId = ?, lastError = 'backlog_full', lastAttemptAt = ? WHERE channel = ? AND personaId = ?",
        notice.id,
        new Date().toISOString(),
        channel,
        personaId,
      );
      return false;
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO webhook_notices(id, channel, personaId, body, attempts, nextAttemptMs, createdAt) VALUES (?, ?, ?, ?, 0, ?, ?)",
      notice.id,
      channel,
      personaId,
      noticeBody(notice),
      Date.now(),
      new Date().toISOString(),
    );
    return true;
  }

  /**
   * Sends every notice that is due, oldest first, at most WEBHOOK_BATCH per run, in parallel.
   * Each row is leased before its attempt (moved to the first retry time), so a run that is cut
   * short retries later instead of losing the notice; a receiver may then see an id twice.
   * Success or a final failure removes the row; a retryable failure waits WEBHOOK_RETRY_DELAYS_MS.
   * The webhook row keeps the last outcome for `GET …/webhook`.
   */
  async sendDueNotices(now = Date.now()): Promise<number> {
    const due = this.ctx.storage.sql
      .exec<{ id: string; channel: string; personaId: string; body: string; attempts: number }>(
        "SELECT id, channel, personaId, body, attempts FROM webhook_notices WHERE nextAttemptMs <= ? ORDER BY nextAttemptMs, createdAt LIMIT ?",
        now,
        WEBHOOK_BATCH,
      )
      .toArray();
    if (!due.length) return 0;
    for (const row of due)
      this.ctx.storage.sql.exec(
        "UPDATE webhook_notices SET nextAttemptMs = ?, attempts = attempts + 1 WHERE id = ?",
        now + WEBHOOK_RETRY_DELAYS_MS[0],
        row.id,
      );
    await Promise.allSettled(
      due.map(async (row) => {
        const hook = this.ctx.storage.sql
          .exec<{ url: string; bearer: string | null }>(
            "SELECT url, bearer FROM webhooks WHERE channel = ? AND personaId = ?",
            row.channel,
            row.personaId,
          )
          .toArray()[0];
        if (!hook) {
          this.ctx.storage.sql.exec("DELETE FROM webhook_notices WHERE id = ?", row.id);
          return;
        }
        const attempt = await postNotice(hook.url, hook.bearer, row.body, row.id, this.webhookFetch);
        const at = new Date().toISOString();
        const attempts = row.attempts + 1;
        const retry = !attempt.ok && attempt.retry && attempts <= WEBHOOK_RETRY_DELAYS_MS.length;
        const outcome = attempt.ok ? "delivered" : retry ? "retrying" : "failed";
        this.ctx.storage.transactionSync(() => {
          if (retry)
            this.ctx.storage.sql.exec(
              "UPDATE webhook_notices SET nextAttemptMs = ? WHERE id = ?",
              Date.now() + WEBHOOK_RETRY_DELAYS_MS[attempts - 1],
              row.id,
            );
          else this.ctx.storage.sql.exec("DELETE FROM webhook_notices WHERE id = ?", row.id);
          // Only if the webhook was not removed or replaced by another URL meanwhile.
          this.ctx.storage.sql.exec(
            `UPDATE webhooks SET lastStatus = ?, lastNoticeId = ?, lastAttemptAt = ?, lastHttpStatus = ?, lastError = ?,
               lastDeliveredAt = CASE WHEN ? THEN ? ELSE lastDeliveredAt END
             WHERE channel = ? AND personaId = ? AND url = ?`,
            outcome,
            row.id,
            at,
            attempt.httpStatus,
            attempt.ok ? null : attempt.error,
            attempt.ok ? 1 : 0,
            at,
            row.channel,
            row.personaId,
            hook.url,
          );
        });
      }),
    );
    return due.length;
  }

  private webhookView(channel: string, personaId: string) {
    const row = this.ctx.storage.sql
      .exec<{
        personaId: string;
        url: string;
        createdAt: string;
        createdBy: string | null;
        bearer: string | null;
        lastStatus: string | null;
        lastNoticeId: string | null;
        lastAttemptAt: string | null;
        lastHttpStatus: number | null;
        lastError: string | null;
        lastDeliveredAt: string | null;
        pending: number;
      }>(
        `SELECT w.*, (SELECT COUNT(*) FROM webhook_notices n WHERE n.channel = w.channel AND n.personaId = w.personaId) AS pending
         FROM webhooks w WHERE w.channel = ? AND w.personaId = ?`,
        channel,
        personaId,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      channel,
      persona: row.personaId,
      url: row.url,
      // Whether notices carry a bearer key; never the key itself.
      bearer: row.bearer !== null,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      pending: row.pending,
      lastDelivery:
        row.lastStatus === null
          ? null
          : {
              status: row.lastStatus,
              noticeId: row.lastNoticeId,
              at: row.lastAttemptAt,
              httpStatus: row.lastHttpStatus,
              error: row.lastError,
              deliveredAt: row.lastDeliveredAt,
            },
    };
  }

  /**
   * Owner only (ADR 0062): `GET …/channels/C/webhooks` lists the board's webhooks;
   * `GET|PUT|DELETE …/personas/ID/webhook` reads, sets or removes one persona's webhook, and
   * `POST …/personas/ID/webhook/test` queues a ping. The bearer key is never returned.
   */
  private async webhookRoute(
    request: Request,
    url: URL,
    channel: string,
    personaId: string | null,
    rest: string[],
    hash: string,
  ): Promise<Response> {
    const input = request.method === "PUT" ? await body(request) : null;
    const capability = this.authorize(hash);
    this.requireScope(capability, channel);
    this.requireOwner(capability);
    this.board(channel);
    if (personaId === null) {
      if (request.method !== "GET") throw new HttpError(404, "route_not_found", "Unknown webhook operation.");
      const ids = this.ctx.storage.sql
        .exec<{ personaId: string }>(
          "SELECT personaId FROM webhooks WHERE channel = ? ORDER BY personaId",
          channel,
        )
        .toArray();
      return json({ webhooks: ids.map((row) => this.webhookView(channel, row.personaId)) });
    }
    const persona = this.ctx.storage.sql
      .exec("SELECT 1 FROM personas WHERE channel = ? AND id = ?", channel, personaId)
      .toArray();
    if (!persona.length)
      throw new HttpError(404, "persona_not_found", "Register the persona on this board first.");
    if (rest.length === 0 && request.method === "GET") {
      const view = this.webhookView(channel, personaId);
      if (!view) throw new HttpError(404, "webhook_not_found", "This persona has no webhook.");
      return json({ webhook: view });
    }
    if (rest.length === 0 && request.method === "PUT") {
      for (const field of Object.keys(input ?? {}))
        if (!["url", "bearer"].includes(field))
          throw new HttpError(400, "invalid_webhook", `Unknown field ${field}; use url and bearer.`);
      const target = webhookUrl(input?.url, this.selfHosts(url));
      const bearer = webhookBearer(input?.bearer);
      const replaced = this.ctx.storage.transactionSync(() => {
        const existing = this.ctx.storage.sql
          .exec("SELECT 1 FROM webhooks WHERE channel = ? AND personaId = ?", channel, personaId)
          .toArray().length;
        if (!existing) {
          const count = this.ctx.storage.sql
            .exec<{ n: number }>("SELECT COUNT(*) AS n FROM webhooks")
            .one().n;
          if (count >= MAX_WEBHOOKS)
            throw new HttpError(
              409,
              "webhook_quota",
              `A workspace can have at most ${MAX_WEBHOOKS} webhooks.`,
            );
        }
        // A new URL or key starts a fresh record; waiting notices go to the new URL.
        this.ctx.storage.sql.exec(
          `INSERT INTO webhooks(channel, personaId, url, secret, bearer, origin, createdAt, createdBy) VALUES (?, ?, ?, '', ?, ?, ?, ?)
           ON CONFLICT(channel, personaId) DO UPDATE SET url = excluded.url, secret = '', bearer = excluded.bearer, origin = excluded.origin,
             createdAt = excluded.createdAt, createdBy = excluded.createdBy, lastStatus = NULL, lastNoticeId = NULL,
             lastAttemptAt = NULL, lastHttpStatus = NULL, lastError = NULL, lastDeliveredAt = NULL`,
          channel,
          personaId,
          target,
          bearer,
          url.origin,
          new Date().toISOString(),
          capability.bound_username,
        );
        return existing > 0;
      });
      // The bearer key was the owner's to begin with and is never echoed back.
      return json({ webhook: this.webhookView(channel, personaId) }, replaced ? 200 : 201);
    }
    if (rest.length === 0 && request.method === "DELETE") {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "DELETE FROM webhooks WHERE channel = ? AND personaId = ?",
          channel,
          personaId,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM webhook_notices WHERE channel = ? AND personaId = ?",
          channel,
          personaId,
        );
      });
      await this.armAlarm();
      return new Response(null, { status: 204 });
    }
    if (rest.length === 1 && rest[0] === "test" && request.method === "POST") {
      const hook = this.webhookView(channel, personaId);
      if (!hook) throw new HttpError(404, "webhook_not_found", "This persona has no webhook.");
      const id = crypto.randomUUID();
      const queued = this.ctx.storage.transactionSync(() =>
        this.queueNotice(channel, personaId, {
          schema: "msn.webhook.v1",
          type: "ping",
          id,
          tenant: this.tenantName(url),
          channel,
          persona: personaId,
          messageId: null,
          eventId: null,
          messageUrl: null,
          createdAt: new Date().toISOString(),
        }),
      );
      if (!queued)
        throw new HttpError(
          409,
          "webhook_backlog_full",
          "Too many notices are waiting; try again after they are sent.",
        );
      await this.armAlarm();
      return json({ queued: true, noticeId: id }, 202);
    }
    throw new HttpError(404, "route_not_found", "Unknown webhook operation.");
  }

  /**
   * Hosts that reach this app: the request's own host, plus WEBHOOK_SELF_HOSTS (comma-separated,
   * optional) for its other names, such as its workers.dev address.
   */
  private selfHosts(url: URL): string[] {
    const extra = (this.env as Env & { WEBHOOK_SELF_HOSTS?: string }).WEBHOOK_SELF_HOSTS ?? "";
    return [url.hostname, ...extra.split(",")].map((host) => host.trim()).filter(Boolean);
  }

  /** The tenant slug from a tenant route URL (`/api/tenants/T/…`). */
  private tenantName(url: URL): string {
    return slug(url.pathname.split("/")[3] ?? "");
  }

  private githubSecret(): string | undefined {
    return this.ctx.storage.sql
      .exec<{ secret: string }>("SELECT secret FROM github_hook WHERE singleton = 1")
      .toArray()[0]?.secret;
  }

  /** Owner only: the webhook address and secret to paste into GitHub, and the followed pulls. */
  private githubRoute(request: Request, url: URL, tenant: string, rest: string[], capability: TenantRow) {
    this.requireOwner(capability);
    // The secret is shown once: on the POST that creates or replaces it, never on a read.
    const create = rest.length === 1 && rest[0] === "secret" && request.method === "POST";
    if (!(create || (!rest.length && request.method === "GET")))
      throw new HttpError(404, "route_not_found", "Unknown GitHub operation.");
    let secret: string | undefined;
    if (create) {
      secret = newToken();
      this.ctx.storage.sql.exec(
        "INSERT INTO github_hook(singleton, secret, createdAt) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET secret = excluded.secret, createdAt = excluded.createdAt",
        secret,
        new Date().toISOString(),
      );
    }
    const links = this.ctx.storage.sql
      .exec<{ repo: string; number: number; channel: string; anchorId: number; createdAt: string }>(
        "SELECT repo, number, channel, anchorId, createdAt FROM github_links ORDER BY channel, repo, number",
      )
      .toArray();
    return json({
      webhookUrl: `${url.origin}/api/github/hooks/${tenant}`,
      configured: Boolean(this.githubSecret()),
      ...(secret ? { secret } : {}),
      contentType: "application/json",
      events: [
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
        "issue_comment",
        "workflow_run",
      ],
      links,
    });
  }

  /** Owner only: `PUT|DELETE …/channels/:c/github/pulls/:owner/:repo/:number`. */
  private async githubLinkRoute(
    request: Request,
    tenant: string,
    channel: string,
    rest: string[],
    capability: TenantRow,
  ): Promise<Response> {
    this.requireOwner(capability);
    if (rest.length !== 4 || rest[0] !== "pulls" || !["PUT", "DELETE"].includes(request.method))
      throw new HttpError(404, "route_not_found", "Unknown GitHub link operation.");
    const pull: PullRef = { repo: repoName(rest[1], rest[2]), number: pullNumber(rest[3]) };
    if (request.method === "DELETE") {
      this.ctx.storage.sql.exec(
        "DELETE FROM github_links WHERE repo = ? AND number = ? AND channel = ?",
        pull.repo,
        pull.number,
        channel,
      );
      return new Response(null, { status: 204 });
    }
    this.requireChannel(channel);
    const existing = this.githubLink(pull, channel);
    if (existing) return json({ link: existing, created: false });
    const count = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM github_links").one().n;
    if (count >= MAX_GITHUB_LINKS)
      throw new HttpError(409, "github_link_quota", "Unlink a pull request first (200 per workspace).");
    // The anchor message starts the board's thread for this pull request: every later GitHub
    // message replies to it, and it carries the same labels so agents can find it.
    const ref = `${pull.repo}#${pull.number}`;
    const text = `Following ${ref}. Reviews, comments and check results appear here as replies.\n\nhttps://github.com/${pull.repo}/pull/${pull.number}`;
    const labels = { "github.pr": ref, "github.event": "link", "github.state": "following" };
    const key = `github:link:${ref}:${crypto.randomUUID()}`;
    const sent = this.send(
      tenant,
      channel,
      GITHUB_SENDER,
      text,
      "text/plain",
      {},
      key,
      await digest(JSON.stringify([payload(GITHUB_SENDER, text, "text/plain", {}), labels])),
      null,
      false,
      labels,
    );
    const { message } = await sent.json<{ message: Message }>();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO github_links(repo, number, channel, anchorId, headSha, createdAt) VALUES (?, ?, ?, ?, NULL, ?)",
      pull.repo,
      pull.number,
      channel,
      message.id,
      new Date().toISOString(),
    );
    return json({ link: this.githubLink(pull, channel), created: true }, 201);
  }

  private githubLink(pull: PullRef, channel: string) {
    return this.ctx.storage.sql
      .exec<{ repo: string; number: number; channel: string; anchorId: number; createdAt: string }>(
        "SELECT repo, number, channel, anchorId, createdAt FROM github_links WHERE repo = ? AND number = ? AND channel = ?",
        pull.repo,
        pull.number,
        channel,
      )
      .toArray()[0];
  }

  /**
   * `POST /api/github/hooks/:tenant` from GitHub. No bearer: the HMAC signature with this
   * workspace's secret is the only credential. Each delivery becomes at most one message per
   * linked board, keyed by GitHub's delivery id so redeliveries replay instead of duplicating.
   */
  private async githubDelivery(request: Request, tenant: string): Promise<Response> {
    const bytes = await readDelivery(request);
    const secret = this.tenantRow() ? this.githubSecret() : undefined;
    // An unknown workspace, one without a webhook secret and a wrong signature look the same.
    if (!secret || !(await verifySignature(secret, bytes, request.headers.get("X-Hub-Signature-256"))))
      throw new HttpError(401, "invalid_signature", "The GitHub signature does not match this workspace.");
    const event = request.headers.get("X-GitHub-Event") ?? "";
    const delivery = request.headers.get("X-GitHub-Delivery") ?? "";
    if (!/^[a-z_]{1,64}$/.test(event))
      throw new HttpError(400, "invalid_event", "X-GitHub-Event is required.");
    if (event === "ping") return json({ ok: true, pong: true });
    if (!/^[A-Za-z0-9-]{1,64}$/.test(delivery))
      throw new HttpError(400, "invalid_delivery", "X-GitHub-Delivery is required.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch {
      throw new HttpError(400, "invalid_json", "Set the webhook content type to application/json.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new HttpError(400, "invalid_json", "Set the webhook content type to application/json.");
    const item = notice(event, parsed as Record<string, unknown>);
    if (!item) return json({ posted: 0, ignored: true }, 202);
    const targets = this.githubTargets(item);
    let posted = 0;
    let skipped = 0;
    const failed: { channel: string; code: string }[] = [];
    for (const target of targets) {
      const pull = { repo: target.repo, number: target.number };
      // Archived boards take no new messages, GitHub's included (ADR 0046).
      if (this.archivedAt(target.channel)) {
        skipped++;
        continue;
      }
      // Workflow runs: every failure, but only the first success per head commit and board, so a
      // busy CI cannot fill the board (ADR 0036).
      if (item.event === "workflow" && item.state !== "success" && QUIET_CONCLUSIONS.has(item.state)) {
        skipped++;
        continue;
      }
      if (item.event === "workflow" && item.state === "success" && item.headSha === target.greenSha) {
        skipped++;
        continue;
      }
      const text = item.text(pull);
      const labels = noticeLabels(item, pull);
      const correlation = { replyTo: target.anchorId };
      try {
        const response = this.send(
          tenant,
          target.channel,
          GITHUB_SENDER,
          text,
          "text/plain",
          correlation,
          `github:${delivery}:${pull.number}`,
          await digest(JSON.stringify([payload(GITHUB_SENDER, text, "text/plain", correlation), labels])),
          null,
          true,
          labels,
        );
        // Only a delivery that posted something moves the link's commits, so a late redelivery
        // of an older push cannot roll the head back.
        if (response.status !== 201) continue;
        posted++;
        if (item.newHead)
          this.ctx.storage.sql.exec(
            "UPDATE github_links SET headSha = ? WHERE repo = ? AND number = ? AND channel = ?",
            item.newHead.sha,
            target.repo,
            target.number,
            target.channel,
          );
        if (item.event === "workflow" && item.state === "success")
          this.ctx.storage.sql.exec(
            "UPDATE github_links SET greenSha = ? WHERE repo = ? AND number = ? AND channel = ?",
            item.headSha ?? null,
            target.repo,
            target.number,
            target.channel,
          );
      } catch (error) {
        // A redelivery of a message an admin deleted is already handled; nothing to post again.
        if (error instanceof HttpError && error.code === "message_deleted") continue;
        // One board's quota must not block the others, or every redelivery fails the same way.
        failed.push({
          channel: target.channel,
          code: error instanceof HttpError ? error.code : "internal_error",
        });
      }
    }
    return json(
      {
        posted,
        matched: targets.length,
        ...(skipped ? { skipped } : {}),
        ...(failed.length ? { failed } : {}),
      },
      targets.length ? 200 : 202,
    );
  }

  /** Linked boards for a delivery: by pull number, or by head commit for fork workflow runs. */
  private githubTargets(item: GithubNotice) {
    type Target = {
      repo: string;
      number: number;
      channel: string;
      anchorId: number;
      greenSha: string | null;
    };
    const found = new Map<string, Target>();
    const add = (rows: Target[]) => {
      for (const row of rows) found.set(JSON.stringify([row.channel, row.number]), row);
    };
    for (const pull of item.pulls)
      add(
        this.ctx.storage.sql
          .exec<Target>(
            "SELECT repo, number, channel, anchorId, greenSha FROM github_links WHERE repo = ? AND number = ?",
            pull.repo,
            pull.number,
          )
          .toArray(),
      );
    if (item.event === "workflow" && !item.pulls.length && item.headSha)
      add(
        this.ctx.storage.sql
          .exec<Target>(
            "SELECT repo, number, channel, anchorId, greenSha FROM github_links WHERE repo = ? AND headSha = ?",
            item.repo,
            item.headSha,
          )
          .toArray(),
      );
    return [...found.values()].sort((a, b) => a.channel.localeCompare(b.channel) || a.number - b.number);
  }

  /**
   * Saved board templates (ADR 0051). They belong to the workspace: every owner connection of this
   * workspace lists, saves, uses and deletes the same set. Shared board keys, invited members and
   * watch-only keys get 403, because only the owner creates boards.
   */
  private async templateRoute(request: Request, rest: string[], hash: string): Promise<Response> {
    const input = request.method === "PUT" ? await body(request) : null;
    const capability = this.authorize(hash);
    this.requireOwner(capability);
    if (!rest.length && request.method === "GET")
      return json({ templates: this.savedTemplates(), max: MAX_TEMPLATES });
    if (rest.length !== 1) throw new HttpError(404, "route_not_found", "Unknown API endpoint.");
    const name = templateName(rest[0]);
    if (request.method === "DELETE") {
      const deleted = this.ctx.storage.sql
        .exec("DELETE FROM board_templates WHERE name = ? RETURNING name", name)
        .toArray();
      if (!deleted.length) throw new HttpError(404, "template_not_found", `No saved template named ${name}.`);
      return new Response(null, { status: 204 });
    }
    if (request.method !== "PUT") throw new HttpError(404, "route_not_found", "Unknown API endpoint.");
    const channel = slug(text(input?.channel, "channel", 64, "invalid_template"));
    if (input?.replace !== undefined && typeof input.replace !== "boolean")
      throw new HttpError(400, "invalid_template", "replace must be true or false.");
    const saved = templateFromBoard(this.board(channel).goal, this.roster(channel));
    const created = this.ctx.storage.transactionSync(() => {
      const exists = this.ctx.storage.sql
        .exec("SELECT name FROM board_templates WHERE name = ?", name)
        .toArray().length;
      if (exists && input?.replace !== true)
        throw new HttpError(
          409,
          "template_exists",
          `A saved template is already named ${name}. Choose another name, or replace it.`,
        );
      const count = this.ctx.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM board_templates")
        .one().n;
      if (!exists && count >= MAX_TEMPLATES)
        throw new HttpError(
          409,
          "template_limit",
          `A workspace keeps at most ${MAX_TEMPLATES} saved templates. Delete one first.`,
        );
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO board_templates(name, goal, personas, savedFrom, savedBy, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        name,
        saved.goal,
        JSON.stringify(saved.personas),
        channel,
        capability.bound_username,
        new Date().toISOString(),
      );
      return !exists;
    });
    const template = this.savedTemplates().find((t) => t.id === name);
    return json({ template }, created ? 201 : 200);
  }

  /** Saved templates in the same shape as public/board-templates.json, plus where each came from. */
  private savedTemplates() {
    return this.ctx.storage.sql
      .exec<{
        name: string;
        goal: string;
        personas: string;
        savedFrom: string;
        savedBy: string | null;
        createdAt: string;
      }>("SELECT * FROM board_templates ORDER BY name")
      .toArray()
      .map((row) => ({
        id: row.name,
        title: row.name,
        summary: `Saved from board ${row.savedFrom}.`,
        goal: row.goal,
        personas: JSON.parse(row.personas) as TemplatePersona[],
        own: true,
        savedFrom: row.savedFrom,
        ...(row.savedBy ? { savedBy: row.savedBy } : {}),
        createdAt: row.createdAt,
      }));
  }

  private requireOwner(capability: TenantRow) {
    if (!capability.owner_access)
      throw new HttpError(403, "owner_required", "Use the human account connection for this operation.");
  }

  private board(channel: string) {
    const row = this.ctx.storage.sql
      .exec<{ channel: string; goal: string; status: string; revision: number; updatedAt: string }>(
        "SELECT * FROM boards WHERE channel=?",
        channel,
      )
      .toArray()[0];
    if (!row) throw new HttpError(404, "board_not_found", "Create this message board first.");
    const archivedAt = this.archivedAt(channel);
    return archivedAt ? { ...row, archivedAt } : row;
  }

  /** When the board was archived (ADR 0046), or null while it is active or does not exist. */
  private archivedAt(channel: string): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ archivedAt: string | null }>("SELECT archivedAt FROM channels WHERE name = ?", channel)
        .toArray()[0]?.archivedAt ?? null
    );
  }

  /** Archived boards refuse every write (ADR 0046). Reads, search and export keep working. */
  private requireActive(channel: string): void {
    if (this.archivedAt(channel))
      throw new HttpError(
        409,
        "board_archived",
        `Board ${channel} is archived and read-only: nothing new can be posted or changed. Do not retry; the board owner can run msn board unarchive ${channel}.`,
        { channel },
      );
  }

  /** PUT archives, DELETE unarchives. Owner only; idempotent; nothing is deleted (ADR 0046). */
  private archiveRoute(request: Request, channel: string, capability: TenantRow): Response {
    this.requireOwner(capability);
    this.requireChannel(channel);
    if (request.method !== "PUT" && request.method !== "DELETE")
      throw new HttpError(404, "route_not_found", "Use PUT to archive a board and DELETE to unarchive it.");
    const archive = request.method === "PUT";
    const before = this.archivedAt(channel);
    if (archive && !before)
      this.ctx.storage.sql.exec(
        "UPDATE channels SET archivedAt = ? WHERE name = ?",
        new Date().toISOString(),
        channel,
      );
    if (!archive && before)
      this.ctx.storage.sql.exec("UPDATE channels SET archivedAt = NULL WHERE name = ?", channel);
    // Pending long polls on this board answer now, carrying archived: true, so listeners end
    // cleanly instead of waiting out their timeout.
    if (archive && !before) {
      for (const waiter of this.waiters) if (waiter.channel === channel) waiter.end();
      for (const waiter of this.eventWaiters) if (waiter.channel === channel) waiter.end();
    }
    const archivedAt = this.archivedAt(channel);
    return json({ channel, archived: Boolean(archivedAt), ...(archivedAt ? { archivedAt } : {}) });
  }

  private tenantRow(): TenantRow | undefined {
    return this.ctx.storage.sql
      .exec<TenantRow>("SELECT token_hash, bound_username, bound_prefix FROM tenant WHERE singleton = 1")
      .toArray()[0];
  }

  private authorize(hash: string): TenantRow {
    const row = this.tenantRow();
    if (row && equalHash(hash, row.token_hash)) return { ...row, owner_access: 1 };
    const key = this.ctx.storage.sql
      .exec<AccessKeyRow>("SELECT * FROM access_keys WHERE token_hash = ?", hash)
      .toArray()[0];
    if (row && key) return key;
    throw new HttpError(401, "unauthorized", "Unknown tenant or invalid access key.");
  }

  /** Never throws: unknown keys fall through to the route's own authorization. */
  private watchOnly(hash: string): boolean {
    return Boolean(
      this.ctx.storage.sql
        .exec<{ read_only: number }>("SELECT read_only FROM access_keys WHERE token_hash = ?", hash)
        .toArray()[0]?.read_only,
    );
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
      ...(row.owner_access ? { owner: true } : {}),
      ...(row.shared_channel ? { sharedChannel: true } : {}),
      ...(row.read_only ? { watchOnly: true } : {}),
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
    this.ctx.storage.sql.exec(
      "INSERT INTO channels (name, createdAt) VALUES (?, ?)",
      channel,
      new Date().toISOString(),
    );
    this.insertEvent(channel, "channel.created", null);
    return true;
  }

  /**
   * Always called from inside the caller's own `transactionSync`, so the event row commits or
   * rolls back atomically with the canonical mutation it describes. Capacity failure throws,
   * which aborts that whole transaction: no mutation is ever recorded without its event.
   */
  private insertEvent(channel: string, type: EventType, resourceId: number | null): number {
    // This journal is append-only. Bound its allocated sequence with an indexed rowid lookup,
    // rather than counting the entire retained journal on every write. Gaps consume capacity
    // conservatively; no mutation can bypass the ceiling or silently discard retained events.
    const allocated = this.ctx.storage.sql
      .exec<{ allocated: number }>("SELECT COALESCE(MAX(id), 0) AS allocated FROM events")
      .one().allocated;
    if (allocated >= MAX_EVENTS)
      throw new HttpError(409, "event_quota", "Event journal capacity reached. Contact the administrator.");
    return this.ctx.storage.sql
      .exec<{ id: number }>(
        "INSERT INTO events (channel, type, resourceId, historyRevision, createdAt) VALUES (?, ?, ?, ?, ?) RETURNING id",
        channel,
        type,
        resourceId,
        this.historyRevision(channel),
        new Date().toISOString(),
      )
      .one().id;
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

  /**
   * `include` opts in to `message.labeled` (ADR 0032) and `message.edited` (ADR 0052) events.
   * Clients built before them reject unknown event types, so they never receive one unless they ask.
   */
  private eventsPage(
    tenant: string,
    channel: string | null,
    after: number,
    limit: number,
    include: EventInclude = NO_EXTRA_EVENTS,
  ) {
    const hidden = [
      ...(include.labels ? [] : ["'message.labeled'"]),
      ...(include.edits ? [] : ["'message.edited'"]),
      ...(include.statuses ? [] : ["'status.changed'"]),
    ];
    const types = hidden.length ? ` AND type NOT IN (${hidden.join(", ")})` : "";
    const rows = (
      channel === null
        ? this.ctx.storage.sql.exec<EventRow>(
            `SELECT ${EVENT_COLUMNS} FROM events WHERE id > ?${types} ORDER BY id LIMIT ?`,
            after,
            limit + 1,
          )
        : this.ctx.storage.sql.exec<EventRow>(
            `SELECT ${EVENT_COLUMNS} FROM events WHERE channel = ? AND id > ?${types} ORDER BY id LIMIT ?`,
            channel,
            after,
            limit + 1,
          )
    ).toArray();
    const events: CoordinationEvent[] = rows.slice(0, limit).map((row) => toEvent(row, tenant));
    return {
      events,
      nextCursor: events.at(-1)?.id ?? after,
      hasMore: rows.length > limit,
    };
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
    listener: string | null = null,
    include: EventInclude = NO_EXTRA_EVENTS,
  ): Promise<Response> | Response {
    const page = this.eventsPage(tenant, channel, after, limit, include);
    // A catch-up read (wait=0) is not listening; a long poll that returns at once still is.
    const key = listener && channel && wait ? JSON.stringify([channel, listener]) : null;
    if (key && channel && listener && page.events.length) this.touchListener(key, channel, listener, 0);
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
        if (key && channel && listener) this.touchListener(key, channel, listener, -1);
      };
      const finish = (aborted = false) => {
        if (finished) return;
        try {
          this.authorize(hash); // Rotation and revocation abort already-pending polls, too.
          const next = this.eventsPage(tenant, channel, after, limit, include);
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
        end: () => finish(),
        wake: () => {
          // Future cursors must not get woken by earlier events.
          try {
            this.authorize(hash);
          } catch {
            finish();
            return;
          }
          if (this.eventsPage(tenant, channel, after, limit, include).events.length) finish();
        },
      };
      const abort = () => finish(true);
      const timer = setTimeout(finish, wait * 1000);
      this.eventWaiters.add(waiter);
      if (key && channel && listener) this.touchListener(key, channel, listener, 1);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
    });
  }

  /**
   * The root of the thread holding message `id` (ADR 0063): follow replyTo up until a message
   * answers nothing. A tombstoned message still counts, as it does for replyTo (ADR 0003).
   */
  private threadRoot(channel: string, id: number): number {
    const row = this.ctx.storage.sql
      .exec<{ id: number }>(
        `WITH RECURSIVE up(id, replyTo, depth) AS (
           SELECT id, replyTo, 0 FROM messages WHERE channel = ? AND id = ?
           UNION ALL
           SELECT m.id, m.replyTo, up.depth + 1 FROM messages m JOIN up ON m.id = up.replyTo
           WHERE m.channel = ? AND m.id < up.id
         )
         SELECT id FROM up ORDER BY depth DESC LIMIT 1`,
        channel,
        id,
        channel,
      )
      .toArray()[0];
    if (!row)
      throw new HttpError(
        404,
        "message_not_found",
        `No message #${id} on this board; thread needs the id of a message in the thread.`,
      );
    return row.id;
  }

  /** The members of the thread rooted at `root` (ADR 0063); refuses threads over MAX_THREAD. */
  private threadView(channel: string, root: number): ThreadView {
    const through =
      this.ctx.storage.sql.exec<{ id: number | null }>("SELECT MAX(id) AS id FROM messages").one().id ?? 0;
    const sorted = this.ctx.storage.sql
      .exec<{ id: number }>(THREAD_MEMBERS_SQL, root, channel, MAX_THREAD + 1)
      .toArray()
      .map((row) => row.id);
    if (sorted.length > MAX_THREAD)
      throw new HttpError(
        400,
        "thread_too_large",
        `Thread #${root} has more than ${MAX_THREAD.toLocaleString("en-US")} messages; read the board without thread instead.`,
      );
    return { root, ids: new Set(sorted), sorted, through };
  }

  /** Adds messages sent since the view was built or last grown; reads only the new rows. */
  private growThread(channel: string, view: ThreadView): void {
    const rows = this.ctx.storage.sql
      .exec<{ id: number; replyTo: number | null }>(
        "SELECT id, replyTo FROM messages WHERE id > ? AND channel = ? ORDER BY id",
        view.through,
        channel,
      )
      .toArray();
    for (const row of rows) {
      view.through = row.id;
      if (row.replyTo !== null && view.ids.has(row.replyTo)) {
        view.ids.add(row.id);
        view.sorted.push(row.id);
      }
    }
  }

  /**
   * A page of one thread (ADR 0063): its members after `after`, oldest first, fetched by id in
   * small batches, so the cost follows the thread rows read, not the board.
   */
  private threadPage(
    tenant: string,
    channel: string,
    view: ThreadView,
    after: number,
    limit: number,
    filters: LabelFilter[],
    before: number,
  ) {
    const exists = (filter: LabelFilter) =>
      ` AND EXISTS (SELECT 1 FROM message_labels l WHERE l.channel = messages.channel AND l.messageId = messages.id AND l.key = ?${
        filter.values ? ` AND l.value IN (${filter.values.map(() => "?").join(", ")})` : ""
      })`;
    const labelParams = filters.flatMap((filter) => [filter.key, ...(filter.values ?? [])]);
    // Durable Object SQL takes at most 100 bound parameters per statement.
    const batch = Math.max(10, 99 - 1 - labelParams.length);
    const rows: MessageRow[] = [];
    for (let index = firstAfter(view.sorted, after); index < view.sorted.length && rows.length <= limit; ) {
      const ids: number[] = [];
      while (ids.length < batch && index < view.sorted.length && view.sorted[index] < before)
        ids.push(view.sorted[index++]);
      if (!ids.length) break;
      rows.push(
        ...this.ctx.storage.sql
          .exec<MessageRow>(
            `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel = ? AND deleted = 0 AND id IN (${ids
              .map(() => "?")
              .join(", ")})${filters.map(exists).join("")} ORDER BY id`,
            channel,
            ...ids,
            ...labelParams,
          )
          .toArray(),
      );
      if (ids.length < batch) break;
    }
    const messages = this.withSparse(
      channel,
      rows.slice(0, limit).map((row) => toMessage(row, tenant)),
    );
    return { messages, nextCursor: messages.at(-1)?.id ?? after, hasMore: rows.length > limit };
  }

  private page(
    tenant: string,
    channel: string,
    after: number,
    limit: number,
    filters: LabelFilter[] = [],
    before = Number.MAX_SAFE_INTEGER,
    thread: ThreadView | null = null,
  ) {
    if (thread) return this.threadPage(tenant, channel, thread, after, limit, filters, before);
    const exists = (filter: LabelFilter) =>
      `EXISTS (SELECT 1 FROM message_labels l WHERE l.channel = messages.channel AND l.messageId = messages.id AND l.key = ?${
        filter.values ? ` AND l.value IN (${filter.values.map(() => "?").join(", ")})` : ""
      })`;
    const params = (filter: LabelFilter) => [filter.key, ...(filter.values ?? [])];
    let rows: MessageRow[];
    if (!filters.length) {
      rows = this.ctx.storage.sql
        .exec<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel = ? AND deleted = 0 AND id > ? AND id < ? ORDER BY id LIMIT ?`,
          channel,
          after,
          before,
          limit + 1,
        )
        .toArray();
    } else {
      // Drive the scan from the label_values index, so its cost follows how many messages carry
      // the label, not how long the channel is. A key=value filter is the most selective driver.
      const driverIndex = Math.max(
        0,
        filters.findIndex((filter) => filter.values),
      );
      const driver = filters[driverIndex];
      const rest = filters.filter((_, index) => index !== driverIndex);
      const columns = MESSAGE_COLUMNS.split(", ")
        .map((column) => `messages.${column}`)
        .join(", ");
      rows = this.ctx.storage.sql
        .exec<MessageRow>(
          `SELECT ${columns} FROM message_labels d INDEXED BY label_values JOIN messages ON messages.id = d.messageId
           WHERE d.channel = ? AND d.key = ?${driver.values ? ` AND d.value IN (${driver.values.map(() => "?").join(", ")})` : ""}
           AND d.messageId > ? AND d.messageId < ? AND messages.channel = d.channel AND messages.deleted = 0${rest
             .map((filter) => ` AND ${exists(filter)}`)
             .join("")}
           ORDER BY d.messageId LIMIT ?`,
          channel,
          ...params(driver),
          after,
          before,
          ...rest.flatMap(params),
          limit + 1,
        )
        .toArray();
    }
    const messages = this.withLabels(
      channel,
      rows.slice(0, limit).map((row) => toMessage(row, tenant)),
    );
    return { messages, nextCursor: messages.at(-1)?.id ?? after, hasMore: rows.length > limit };
  }

  /** Adds each message's current labels; one range query per page. */
  /** Every message output carries its labels (ADR 0032), attachments (ADR 0035) and reactions (ADR 0047). */
  private withLabels(channel: string, messages: Message[]): Message[] {
    return this.withReactions(channel, this.withAttachments(channel, this.labelsOnly(channel, messages)));
  }

  /** Who reacted to these messages, by message id. Kinds in REACTIONS order. */
  private reactionsOf(channel: string, ids: number[]) {
    const rows = this.ctx.storage.sql
      .exec<{ messageId: number; kind: string; name: string }>(
        `SELECT messageId, kind, name FROM reactions WHERE channel = ? AND messageId IN (${ids
          .map(() => "?")
          .join(", ")}) ORDER BY messageId, createdAt, name`,
        channel,
        ...ids,
      )
      .toArray();
    return this.groupReactions(rows);
  }

  private groupReactions(rows: { messageId: number; kind: string; name: string }[]) {
    const byId = new Map<number, Reactions>();
    for (const row of rows) {
      const kinds = byId.get(row.messageId) ?? {};
      const kind = row.kind as keyof Reactions;
      kinds[kind] = [...(kinds[kind] ?? []), row.name];
      byId.set(row.messageId, kinds);
    }
    for (const [id, kinds] of byId)
      byId.set(id, Object.fromEntries(REACTIONS.filter((k) => kinds[k]).map((k) => [k, kinds[k]])));
    return byId;
  }

  /** Who reacted to messages with ids in (after, before), by message id. Kinds in REACTIONS order. */
  private reactionsIn(channel: string, after: number, before: number, limit = Number.MAX_SAFE_INTEGER) {
    const rows = this.ctx.storage.sql
      .exec<{ messageId: number; kind: string; name: string }>(
        `SELECT r.messageId, r.kind, r.name FROM reactions r
         WHERE r.channel = ? AND r.messageId > ? AND r.messageId < ?
           AND r.messageId IN (SELECT r2.messageId FROM reactions r2 WHERE r2.channel = r.channel
             AND r2.messageId > ? AND r2.messageId < ? GROUP BY r2.messageId ORDER BY r2.messageId LIMIT ?)
         ORDER BY r.messageId, r.createdAt, r.name`,
        channel,
        after,
        before,
        after,
        before,
        limit,
      )
      .toArray();
    return this.groupReactions(rows);
  }

  /**
   * Adds reactions; messages nobody reacted to keep their shape. Pages read one id range; `sparse`
   * ids that can be far apart (search matches) read by id instead, so the gaps cost nothing.
   */
  private withReactions(channel: string, messages: Message[], sparse = false): Message[] {
    if (!messages.length) return messages;
    const ids = messages.map((message) => message.id);
    const found = sparse
      ? this.reactionsOf(channel, ids)
      : this.reactionsIn(channel, Math.min(...ids) - 1, Math.max(...ids) + 1);
    for (const message of messages) {
      const reactions = found.get(message.id);
      if (reactions) message.reactions = reactions;
    }
    return messages;
  }

  /**
   * Adds or removes one reaction (ADR 0047). Idempotent either way: `changed` says whether it did
   * anything. Reacting writes no message and no event, so ids, cursors and unread counts never move.
   */
  private react(tenant: string, channel: string, id: number, change: ReactionChange): Response {
    const changed = this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<{ deleted: number }>("SELECT deleted FROM messages WHERE channel = ? AND id = ?", channel, id)
        .toArray()[0];
      if (!row) throw new HttpError(404, "message_not_found", "Message not found.");
      if (row.deleted) throw new HttpError(410, "message_deleted", "This message was deleted.");
      if (change.remove) {
        const removed = this.ctx.storage.sql.exec(
          "DELETE FROM reactions WHERE channel = ? AND messageId = ? AND kind = ? AND name = ?",
          channel,
          id,
          change.kind,
          change.username,
        ).rowsWritten;
        if (removed)
          this.ctx.storage.sql.exec(
            "UPDATE usage SET reactions = MAX(0, reactions - ?) WHERE singleton = 1",
            removed,
          );
        return removed > 0;
      }
      if (
        this.ctx.storage.sql
          .exec(
            "SELECT 1 FROM reactions WHERE channel = ? AND messageId = ? AND kind = ? AND name = ?",
            channel,
            id,
            change.kind,
            change.username,
          )
          .toArray().length
      )
        return false;
      const count = this.ctx.storage.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM reactions WHERE channel = ? AND messageId = ? AND kind = ?",
          channel,
          id,
          change.kind,
        )
        .one().n;
      if (count >= MAX_REACTORS)
        throw new HttpError(
          409,
          "reaction_limit",
          `At most ${MAX_REACTORS} names can react with ${change.kind} to one message.`,
        );
      if (
        this.ctx.storage.sql.exec<{ reactions: number }>("SELECT reactions FROM usage").one().reactions >=
        MAX_REACTIONS
      )
        throw new HttpError(
          409,
          "reaction_limit",
          `This workspace holds the most reactions it can (${MAX_REACTIONS.toLocaleString("en-US")}). Remove some first.`,
        );
      this.ctx.storage.sql.exec("UPDATE usage SET reactions = reactions + 1 WHERE singleton = 1");
      this.ctx.storage.sql.exec(
        "INSERT INTO reactions(channel, messageId, kind, name, createdAt) VALUES (?, ?, ?, ?, ?)",
        channel,
        id,
        change.kind,
        change.username,
        new Date().toISOString(),
      );
      return true;
    });
    const row = this.ctx.storage.sql
      .exec<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel = ? AND id = ?`, channel, id)
      .one();
    return json({ message: this.withLabels(channel, [toMessage(row, tenant)])[0], changed });
  }

  /**
   * Replaces a message's text (ADR 0052). Only its sender may: the name must be the message's
   * author, a bound key edits only as its name, and a board's shared credential only as the persona
   * that sent it. The id, createdAt and everything keyed by id stay, so order, read and processing
   * cursors, receipts, unread counts and since-you-left never move. Writes one `message.edited`
   * event, which the events feed returns only to clients that ask for it.
   */
  private editMessage(
    tenant: string,
    channel: string,
    id: number,
    edit: MessageEdit,
    capability: TenantRow,
  ): Response {
    this.requireBoundName(capability, edit.username);
    const result = this.ctx.storage.transactionSync(() => {
      // Rechecked inside the write: an archive that lands while the body was read still wins.
      this.requireActive(channel);
      const row = this.ctx.storage.sql
        .exec<MessageRow & { deleted: number; bytes: number }>(
          `SELECT ${MESSAGE_COLUMNS}, deleted, bytes FROM messages WHERE channel = ? AND id = ?`,
          channel,
          id,
        )
        .toArray()[0];
      if (!row) throw new HttpError(404, "message_not_found", "Message not found.");
      if (row.deleted) throw new HttpError(410, "message_deleted", "This message was deleted.");
      // GitHub notices (ADR 0036) mirror GitHub; nobody here wrote them.
      if (row.username === GITHUB_SENDER)
        throw new HttpError(403, "github_message", "Messages from GitHub cannot be edited.");
      if (row.username !== edit.username)
        throw new HttpError(403, "not_sender", "Only the sender can edit a message.");
      if (capability.shared_channel) {
        const persona = this.ctx.storage.sql
          .exec<{ id: string }>(
            "SELECT id FROM personas WHERE channel = ? AND displayName = ?",
            channel,
            edit.username,
          )
          .toArray()[0];
        if (!persona)
          throw new HttpError(
            400,
            "persona_required",
            "Register your persona with msn persona add before editing.",
          );
        if (row.personaId !== null && row.personaId !== persona.id)
          throw new HttpError(403, "not_sender", "Only the sender can edit a message.");
      }
      // JSON payloads stay JSON (ADR 0004); the content type never changes on an edit.
      contentType(row.contentType, edit.text);
      // Two editors on one message: the later save names the version it started from.
      if (edit.ifEditedAt !== undefined && edit.ifEditedAt !== row.editedAt)
        throw new HttpError(
          409,
          "edit_conflict",
          "This message changed since you started editing. Reload it and edit again.",
        );
      const { deleted: _deleted, bytes: oldBytes, ...current } = row;
      // An answered question and an answer are a record of a decision (ADR 0065): changing the
      // question's words after the fact, or the answer's, would change what was decided.
      if (row.text !== edit.text && (row.answered != null || row.answer != null))
        throw new HttpError(
          409,
          "answered_locked",
          row.answer != null
            ? "An answer to a question cannot be edited. Reply again to add to it."
            : "This question was answered, so its text cannot change. Ask a new question instead.",
        );
      if (row.text === edit.text)
        return { message: this.withLabels(channel, [toMessage(current, tenant)])[0], changed: false };
      const usage = this.ctx.storage.sql
        .exec<{ bytes: number; edits: number }>("SELECT bytes, edits FROM usage")
        .one();
      if (usage.edits >= MAX_EDITS)
        throw new HttpError(
          409,
          "edit_quota",
          "Edit limit reached (100,000 lifetime edits). Contact the administrator.",
        );
      // A quote is part of the stored content (ADR 0059); an edit keeps it.
      const bytes = new TextEncoder().encode(
        row.username + edit.text + (row.quote ?? "") + (row.choices ?? "") + (row.answer ?? ""),
      ).length;
      if (usage.bytes - oldBytes + bytes > MAX_CONTENT_BYTES)
        throw new HttpError(
          409,
          "storage_quota",
          "Tenant quota reached (100,000 lifetime messages or 128 MiB active content). Contact the administrator.",
        );
      const seq = usage.edits + 1;
      const updated = this.ctx.storage.sql
        .exec<MessageRow>(
          `UPDATE messages SET text = ?, bytes = ?, editedAt = ?, editSeq = ? WHERE id = ? RETURNING ${MESSAGE_COLUMNS}`,
          edit.text,
          bytes,
          new Date().toISOString(),
          seq,
          id,
        )
        .one();
      this.ctx.storage.sql.exec(
        "UPDATE usage SET bytes = bytes - ? + ?, edits = ? WHERE singleton = 1",
        oldBytes,
        bytes,
        seq,
      );
      // Search finds the new words and stops finding the old ones (ADR 0037).
      this.ctx.storage.sql.exec("DELETE FROM message_search WHERE rowid = ?", id);
      this.ctx.storage.sql.exec("INSERT INTO message_search(rowid, text) VALUES (?, ?)", id, edit.text);
      this.insertEvent(channel, "message.edited", id);
      return { message: this.withLabels(channel, [toMessage(updated, tenant)])[0], changed: true };
    });
    // An edit adds nothing after anyone's cursor. Message polls recheck, and only those that asked
    // for edits (editsAfter) answer; the rest keep waiting.
    if (result.changed) {
      this.wakeEvents(channel);
      for (const waiter of this.waiters) if (waiter.channel === channel) waiter.wake();
    }
    return json(result);
  }

  /**
   * `GET …/edits?after=N` (ADR 0052): messages edited after edit cursor N, oldest edit first, 100
   * per page, so a client refreshes the messages it shows. Without `after` it only returns the
   * board's current editCursor to start from.
   */
  private editPage(tenant: string, channel: string, params: URLSearchParams): Response {
    for (const name of params.keys())
      if (name !== "after") throw new HttpError(400, "invalid_query", `Unknown parameter ${name}.`);
    if (!params.has("after"))
      return json({ edits: [], editCursor: this.editCursor(channel), hasMore: false });
    const after = integer(params.get("after"), 0, Number.MAX_SAFE_INTEGER);
    const page = this.editedSince(tenant, channel, after, Number.MAX_SAFE_INTEGER, 100);
    return json({
      edits: page.messages,
      editCursor: page.hasMore ? (page.seqs.at(-1) ?? after) : Math.max(this.editCursor(channel), after),
      hasMore: page.hasMore,
    });
  }

  /** Board-wide edit cursor: the newest edit sequence among this board's messages (ADR 0052). */
  private editCursor(channel: string): number {
    return (
      this.ctx.storage.sql
        .exec<{ seq: number | null }>(
          "SELECT MAX(editSeq) AS seq FROM messages WHERE channel = ? AND editSeq IS NOT NULL",
          channel,
        )
        .one().seq ?? 0
    );
  }

  /**
   * `editsAfter` on a catch-up or message page (ADR 0052): the reader's edit cursor, `latest` for
   * the board's current one (a new reader starts there and gets no old edits), or null when not
   * asked.
   */
  private editsAfterParam(url: URL, channel: string): number | null {
    if (!url.searchParams.has("editsAfter")) return null;
    const raw = url.searchParams.get("editsAfter");
    if (raw === "latest") return this.editCursor(channel);
    return integer(raw, 0, Number.MAX_SAFE_INTEGER);
  }

  /** Earlier messages (id ≤ through) edited after `editsAfter`, oldest edit first (ADR 0052). */
  private editedSince(
    tenant: string,
    channel: string,
    editsAfter: number,
    through: number,
    limit: number,
    thread: ThreadView | null = null,
  ) {
    const read = (from: number, count: number) =>
      this.ctx.storage.sql
        .exec<MessageRow & { editSeq: number }>(
          `SELECT ${MESSAGE_COLUMNS}, editSeq FROM messages INDEXED BY message_edits
           WHERE channel = ? AND editSeq IS NOT NULL AND editSeq > ? AND id <= ? AND deleted = 0
           ORDER BY editSeq LIMIT ?`,
          channel,
          from,
          through,
          count,
        )
        .toArray();
    let rows: (MessageRow & { editSeq: number })[];
    if (!thread) rows = read(editsAfter, limit + 1);
    else {
      // A thread read (ADR 0063) keeps only its members' edits, scanning edits in batches.
      rows = [];
      for (let from = editsAfter; rows.length <= limit; ) {
        const found = read(from, 200);
        rows.push(...found.filter((row) => thread.ids.has(row.id)));
        if (found.length < 200) break;
        from = found[found.length - 1].editSeq;
      }
    }
    const page = rows.slice(0, limit);
    return {
      messages: this.withSparse(
        channel,
        page.map(({ editSeq: _seq, ...row }) => toMessage(row, tenant)),
      ),
      seqs: page.map((row) => row.editSeq),
      hasMore: rows.length > limit,
    };
  }

  /**
   * `GET …/reactions?after=&before=`: current reactions for messages in that id range, so a client
   * can refresh the messages it shows without re-reading them. At most 500 messages per page.
   */
  private reactionPage(channel: string, params: URLSearchParams): Response {
    const after = integer(params.get("after"), 0, Number.MAX_SAFE_INTEGER);
    const before = integer(params.get("before"), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const limit = 500;
    const found = this.reactionsIn(channel, after, before, limit + 1);
    const entries = [...found].slice(0, limit).map(([id, reactions]) => ({ id, reactions }));
    return json({
      reactions: entries,
      hasMore: found.size > limit,
      ...(found.size > limit ? { nextAfter: entries.at(-1)?.id } : {}),
    });
  }

  /**
   * withLabels for messages that can be far apart in any order (search matches, catch-up edits):
   * labels and reactions by id; attachments (ADR 0035) by id range, which works in any order.
   */
  private withSparse(channel: string, messages: Message[]): Message[] {
    if (messages.length) {
      const byId = new Map(messages.map((message) => [message.id, message]));
      for (const row of this.ctx.storage.sql
        .exec<{ messageId: number; key: string; value: string }>(
          `SELECT messageId, key, value FROM message_labels WHERE channel = ? AND messageId IN (${messages
            .map(() => "?")
            .join(", ")}) ORDER BY messageId, key`,
          channel,
          ...byId.keys(),
        )
        .toArray()) {
        const message = byId.get(row.messageId);
        if (message) message.labels = { ...message.labels, [row.key]: row.value };
      }
    }
    return this.withReactions(channel, this.withAttachments(channel, messages), true);
  }

  private labelsOnly(channel: string, messages: Message[]): Message[] {
    if (!messages.length) return messages;
    const byId = new Map(messages.map((message) => [message.id, message]));
    const rows = this.ctx.storage.sql
      .exec<{ messageId: number; key: string; value: string }>(
        "SELECT messageId, key, value FROM message_labels WHERE channel = ? AND messageId BETWEEN ? AND ? ORDER BY messageId, key",
        channel,
        messages[0].id,
        messages[messages.length - 1].id,
      )
      .toArray();
    for (const row of rows) {
      const message = byId.get(row.messageId);
      if (message) message.labels = { ...message.labels, [row.key]: row.value };
    }
    return messages;
  }

  /** A Map, not an object: keys such as "constructor" must not match inherited properties. */
  private currentLabels(channel: string, id: number): Map<string, string> {
    return new Map(
      this.ctx.storage.sql
        .exec<{ key: string; value: string }>(
          "SELECT key, value FROM message_labels WHERE channel = ? AND messageId = ? ORDER BY key",
          channel,
          id,
        )
        .toArray()
        .map((row) => [row.key, row.value]),
    );
  }

  /**
   * Applies one label change atomically. A failed `if` condition changes nothing and returns 409
   * label_conflict with the current labels, so a caller can claim a message with compare-and-set.
   */
  private relabel(tenant: string, channel: string, id: number, change: LabelChange): Response {
    const result = this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<MessageRow & { deleted: number }>(
          `SELECT ${MESSAGE_COLUMNS}, deleted FROM messages WHERE channel = ? AND id = ?`,
          channel,
          id,
        )
        .toArray()[0];
      if (!row) throw new HttpError(404, "message_not_found", "Message not found.");
      if (row.deleted) throw new HttpError(410, "message_deleted", "This message was deleted.");
      const current = this.currentLabels(channel, id);
      for (const [key, expected] of change.condition)
        if ((current.get(key) ?? null) !== expected) return { conflict: Object.fromEntries(current) };
      const next = new Map([...current, ...change.set]);
      for (const key of change.unset) next.delete(key);
      if (next.size > MAX_LABELS)
        throw new HttpError(400, "label_limit", `A message can carry at most ${MAX_LABELS} labels.`);
      const changed =
        change.unset.some((key) => current.has(key)) ||
        [...change.set].some(([key, value]) => current.get(key) !== value);
      if (changed) {
        const usage = this.ctx.storage.sql
          .exec<{ labelChanges: number }>("SELECT labelChanges FROM usage")
          .one();
        if (usage.labelChanges >= MAX_LABEL_CHANGES)
          throw new HttpError(
            409,
            "label_quota",
            "Label change limit reached (100,000 lifetime changes). Contact the administrator.",
          );
        const now = new Date().toISOString();
        for (const key of change.unset)
          this.ctx.storage.sql.exec(
            "DELETE FROM message_labels WHERE channel = ? AND messageId = ? AND key = ?",
            channel,
            id,
            key,
          );
        for (const [key, value] of change.set)
          if (current.get(key) !== value)
            this.ctx.storage.sql.exec(
              "INSERT INTO message_labels(channel, messageId, key, value, updatedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel, messageId, key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt",
              channel,
              id,
              key,
              value,
              now,
            );
        this.ctx.storage.sql.exec("UPDATE usage SET labelChanges = labelChanges + 1 WHERE singleton = 1");
        this.insertEvent(channel, "message.labeled", id);
      }
      const { deleted: _deleted, ...message } = row;
      return { message: this.withLabels(channel, [toMessage(message, tenant)])[0], changed };
    });
    if ("conflict" in result)
      return json(
        {
          error: { code: "label_conflict", message: "The if condition did not match; nothing changed." },
          labels: result.conflict,
        },
        409,
      );
    if (result.changed) {
      // Filtered message polls may now match an older message; recheck them all for this channel.
      for (const waiter of this.waiters) if (waiter.channel === channel) waiter.wake();
      this.wakeEvents(channel);
    }
    return json(result);
  }

  private poll(
    request: Request,
    hash: string,
    tenant: string,
    channel: string,
    after: number,
    limit: number,
    wait: number,
    filters: LabelFilter[] = [],
    before = Number.MAX_SAFE_INTEGER,
    fence: ProcessingFence | null = null,
    editsAfter: number | null = null,
    thread: ThreadView | null = null,
  ): Promise<Response> | Response {
    // Edits to messages at or before `after` since the reader's edit cursor (ADR 0052). Opt-in,
    // so older clients keep today's page shape. They end a wait like a new message does.
    const edits = () => {
      if (editsAfter === null) return null;
      const found = this.editedSince(tenant, channel, editsAfter, after, CATCHUP_EDITS, thread);
      return {
        edited: found.messages,
        editCursor: found.hasMore
          ? (found.seqs.at(-1) ?? editsAfter)
          : Math.max(this.editCursor(channel), editsAfter),
        editsHasMore: found.hasMore,
      };
    };
    const ready = (page: ReturnType<typeof this.page>, edited: ReturnType<typeof edits>) =>
      page.messages.length > 0 || (edited?.edited.length ?? 0) > 0;
    const respond = (page: ReturnType<typeof this.page>, edited: ReturnType<typeof edits>) => {
      // Archived boards say so on every page, so a waiting client can stop instead of polling
      // forever for messages that cannot arrive (ADR 0046). Absent on active boards.
      const archived = this.archivedAt(channel) ? { archived: true } : {};
      // A thread read names the root it followed, so a reply id given as thread=ID is explained.
      const scope = thread === null ? {} : { thread: thread.root };
      if (!fence) return json({ ...page, ...scope, ...archived, ...(edited ?? {}) });
      // Recheck at reply time: a takeover during a long poll fences this reply, too.
      this.requireGeneration(channel, fence.reader, fence.generation);
      return json({
        ...page,
        ...archived,
        ...(edited ?? {}),
        committedThrough: after,
        generation: fence.generation,
      });
    };
    const page = this.page(tenant, channel, after, limit, filters, before, thread);
    const edited = edits();
    if (ready(page, edited) || !wait) return respond(page, edited);
    // A thread wait (ADR 0063) first adds the new messages to its members, and reads a page only
    // when a member is newer than its cursor, so a send outside the thread costs one small read.
    const check = () => {
      if (thread) {
        this.growThread(channel, thread);
        const next = firstAfter(thread.sorted, after);
        if ((thread.sorted[next] ?? Number.MAX_SAFE_INTEGER) >= before && editsAfter === null) return null;
      }
      const next = this.page(tenant, channel, after, limit, filters, before, thread);
      const nextEdits = edits();
      return ready(next, nextEdits) ? ([next, nextEdits] as const) : null;
    };
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
      const finish = (aborted = false, found: NonNullable<ReturnType<typeof check>> | null = null) => {
        if (finished) return;
        try {
          this.authorize(hash); // Rotation revokes already-pending polls, too.
          if (thread && !found) this.growThread(channel, thread);
          // A wake that already read the ready page answers with it instead of reading it again.
          const [next, nextEdits] = found ?? [
            this.page(tenant, channel, after, limit, filters, before, thread),
            edits(),
          ];
          finished = true;
          cleanup();
          resolve(
            aborted
              ? json({ error: { code: "poll_aborted", message: "Poll cancelled." } }, 499)
              : respond(next, nextEdits),
          );
        } catch (error) {
          finished = true;
          cleanup();
          resolve(failure(error));
        }
      };
      const waiter: Waiter = {
        channel,
        end: () => finish(),
        wake: () => {
          // Future cursors must not get woken by earlier messages.
          try {
            this.authorize(hash);
          } catch {
            finish();
            return;
          }
          const found = check();
          if (found) finish(false, found);
        },
      };
      const abort = () => finish(true);
      const timer = setTimeout(finish, wait * 1000);
      this.waiters.add(waiter);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
    });
  }

  /**
   * `POST …/messages` with `sendAt` (ADR 0060): stores the message to post at that time instead of
   * now. Every check a send makes on the sender ran before this; the board must be active now and
   * again when it posts. An Idempotency-Key replays the scheduled message (or the message it
   * became) and is kept on the message when it posts.
   */
  private async schedule(
    tenant: string,
    channel: string,
    message: {
      username: string;
      text: string;
      type: ContentType;
      correlation: Correlation;
      personaId: string | null;
      labels: Labels | undefined;
      sendAt: string;
    },
    key: string | null,
    payloadHash: string,
    hash: string,
    capability: TenantRow,
  ): Promise<Response> {
    const result = this.ctx.storage.transactionSync(() => {
      this.requireActive(channel);
      if (key) {
        const waiting = this.ctx.storage.sql
          .exec<ScheduledRow>("SELECT * FROM scheduled_messages WHERE channel = ? AND key = ?", channel, key)
          .toArray()[0];
        const posted = this.ctx.storage.sql
          .exec<MessageRow & { digest: string; deleted: number }>(
            `SELECT ${MESSAGE_COLUMNS}, digest, deleted FROM messages WHERE channel = ? AND key = ?`,
            channel,
            key,
          )
          .toArray()[0];
        const digestOf = waiting?.digest ?? posted?.digest;
        if (digestOf !== undefined && digestOf !== payloadHash)
          throw new HttpError(
            409,
            "idempotency_conflict",
            "This idempotency key was used for different content.",
          );
        if (waiting)
          return { body: { scheduled: toScheduled(waiting, tenant), replayed: true }, status: 200 };
        if (posted) {
          if (posted.deleted)
            throw new HttpError(
              410,
              "message_deleted",
              "The original message was deleted; retries cannot resurrect it.",
            );
          const { digest: _digest, deleted: _deleted, ...row } = posted;
          return {
            body: { message: this.withLabels(channel, [toMessage(row, tenant)])[0], replayed: true },
            status: 200,
          };
        }
      }
      // Only a new schedule needs a future time; a retry above replays whenever it arrives.
      sendAtWindow(message.sendAt);
      if (
        message.correlation.replyTo !== undefined &&
        !this.ctx.storage.sql
          .exec("SELECT id FROM messages WHERE channel = ? AND id = ?", channel, message.correlation.replyTo)
          .toArray().length
      )
        throw new HttpError(
          400,
          "invalid_reply_to",
          "replyTo must be the id of an existing message in this channel.",
        );
      this.expireFailedScheduled();
      // The sender and board caps count waiting messages only, so failed ones never block new
      // ones; the workspace cap counts both, and failed ones expire after 7 days.
      const counts = this.ctx.storage.sql
        .exec<{ sender: number; board: number; all: number }>(
          `SELECT COUNT(*) AS "all",
             COALESCE(SUM(channel = ? AND failedAt IS NULL), 0) AS board,
             COALESCE(SUM(channel = ? AND username = ? AND failedAt IS NULL), 0) AS sender
           FROM scheduled_messages`,
          channel,
          channel,
          message.username,
        )
        .one();
      if (
        counts.sender >= MAX_SCHEDULED_PER_SENDER ||
        counts.board >= MAX_SCHEDULED_PER_BOARD ||
        counts.all >= MAX_SCHEDULED
      )
        throw new HttpError(
          409,
          "scheduled_quota",
          `Too many scheduled messages (${MAX_SCHEDULED_PER_SENDER} per sender and ${MAX_SCHEDULED_PER_BOARD} per board waiting, ${MAX_SCHEDULED} per workspace). Cancel one or wait for one to post.`,
        );
      this.createChannel(channel);
      const now = new Date().toISOString();
      const row = this.ctx.storage.sql
        .exec<ScheduledRow>(
          `INSERT INTO scheduled_messages(tenant, channel, username, text, contentType, sendAt, dueMs, createdAt,
             updatedAt, replyTo, correlationId, recipient, personaId, labels, key, digest, tokenHash, notify, quote, recipients)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          tenant,
          channel,
          message.username,
          message.text,
          message.type,
          message.sendAt,
          Date.parse(message.sendAt),
          now,
          now,
          message.correlation.replyTo ?? null,
          message.correlation.correlationId ?? null,
          message.correlation.to ?? null,
          message.personaId,
          message.labels && Object.keys(message.labels).length ? JSON.stringify(message.labels) : null,
          key,
          payloadHash,
          hash,
          // The owner's own messages never notify the owner, as for a send.
          capability.owner_access ? 0 : 1,
          message.correlation.quote ?? null,
          message.correlation.recipients ? JSON.stringify(message.correlation.recipients) : null,
        )
        .one();
      return { body: { scheduled: toScheduled(row, tenant), replayed: false }, status: 201 };
    });
    await this.armAlarm();
    return json(result.body, result.status);
  }

  /**
   * `…/channels/:channel/scheduled` (ADR 0060). GET lists the board's waiting and failed scheduled
   * messages, soonest first; anyone who can read the board sees them. PATCH `…/:id` changes the text
   * or time (sender only); a new time retries a failed one. DELETE `…/:id?username=NAME` cancels
   * (sender, or the workspace owner).
   */
  private async scheduledRoute(
    request: Request,
    url: URL,
    tenant: string,
    channel: string,
    rest: string[],
    change: ScheduledChange | null,
    capability: TenantRow,
    hash: string,
  ): Promise<Response> {
    if (!rest.length && request.method === "GET") {
      const rows = this.ctx.storage.sql
        .exec<ScheduledRow>(
          "SELECT * FROM scheduled_messages WHERE channel = ? AND (failedAt IS NULL OR failedAt >= ?) ORDER BY dueMs, id",
          channel,
          new Date(Date.now() - FAILED_SCHEDULED_TTL_MS).toISOString(),
        )
        .toArray();
      return json({ channel, scheduled: rows.map((row) => toScheduled(row, tenant)) });
    }
    if (rest.length !== 1 || (request.method !== "PATCH" && request.method !== "DELETE"))
      throw new HttpError(
        404,
        "route_not_found",
        "Use GET …/scheduled to list, PATCH …/scheduled/ID to change and DELETE …/scheduled/ID?username=NAME to cancel.",
      );
    const id = messageId(rest[0]);
    const username =
      change?.username ??
      text(url.searchParams.get("username") ?? undefined, "username", 128, "invalid_scheduled");
    const owner = Boolean(capability.owner_access);
    // Cancelling is the owner's moderation too; changing someone else's words is not.
    if (!(request.method === "DELETE" && owner)) this.requireBoundName(capability, username);
    const result = this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<ScheduledRow>("SELECT * FROM scheduled_messages WHERE channel = ? AND id = ?", channel, id)
        .toArray()[0];
      if (!row)
        throw new HttpError(
          404,
          "scheduled_not_found",
          "No such scheduled message. It may have posted already (look for it on the board) or been cancelled.",
        );
      const sender = row.username === username;
      if (!sender && !(request.method === "DELETE" && owner))
        throw new HttpError(403, "not_sender", "Only the sender can change or cancel a scheduled message.");
      if (sender && capability.shared_channel) {
        const persona = this.ctx.storage.sql
          .exec<{ id: string }>(
            "SELECT id FROM personas WHERE channel = ? AND displayName = ?",
            channel,
            username,
          )
          .toArray()[0];
        if (!persona)
          throw new HttpError(400, "persona_required", "Register your persona with msn persona add first.");
        if (row.personaId !== null && row.personaId !== persona.id)
          throw new HttpError(403, "not_sender", "Only the sender can change or cancel a scheduled message.");
      }
      if (request.method === "DELETE") {
        this.ctx.storage.sql.exec("DELETE FROM scheduled_messages WHERE id = ?", id);
        return null;
      }
      this.requireActive(channel);
      const update = change as ScheduledChange;
      // JSON payloads stay JSON (ADR 0004); the content type never changes.
      if (update.text !== undefined) contentType(row.contentType, update.text);
      const sendAt = update.sendAt ?? row.sendAt;
      // A failed message retries only at a new time; changing its text alone keeps it failed.
      const retry = update.sendAt !== undefined;
      return this.ctx.storage.sql
        .exec<ScheduledRow>(
          `UPDATE scheduled_messages SET text = ?, sendAt = ?, dueMs = ?, updatedAt = ?, tokenHash = ?, notify = ?,
             failedAt = CASE WHEN ? THEN NULL ELSE failedAt END,
             error = CASE WHEN ? THEN NULL ELSE error END,
             errorMessage = CASE WHEN ? THEN NULL ELSE errorMessage END
           WHERE id = ? RETURNING *`,
          update.text ?? row.text,
          sendAt,
          Date.parse(sendAt),
          new Date().toISOString(),
          // The key that changed it is the one checked when it posts, so a sender whose old key was
          // rotated can post it again with a current key.
          hash,
          capability.owner_access ? 0 : 1,
          retry ? 1 : 0,
          retry ? 1 : 0,
          retry ? 1 : 0,
          id,
        )
        .one();
    });
    await this.armAlarm();
    if (!result) return new Response(null, { status: 204 });
    return json({ scheduled: toScheduled(result, tenant) });
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
    personaId: string | null = null,
    notify = true,
    labels: Labels | undefined = undefined,
    attachments: AttachmentRef[] = [],
    scheduledId: number | null = null,
  ): Response {
    const result = this.ctx.storage.transactionSync(() => {
      // Rechecked inside the write: an archive that lands while a send awaits its body still wins.
      this.requireActive(channel);
      // A scheduled message leaves the schedule in the same write that posts it (ADR 0060). A
      // failure below rolls both back, so it is never posted twice or lost.
      if (scheduledId !== null)
        this.ctx.storage.sql.exec("DELETE FROM scheduled_messages WHERE id = ?", scheduledId);
      if (key) {
        // A key that is waiting on the schedule belongs to that message (ADR 0060). Posting under
        // it now would make the scheduled one fail later as a duplicate.
        if (
          scheduledId === null &&
          this.ctx.storage.sql
            .exec("SELECT id FROM scheduled_messages WHERE channel = ? AND key = ?", channel, key)
            .toArray().length
        )
          throw new HttpError(
            409,
            "idempotency_conflict",
            "This idempotency key belongs to a scheduled message. Retry with its sendAt, or use a new key.",
          );
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
          return { message: this.withLabels(channel, [toMessage(message, tenant)])[0], replayed: true };
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
      // An answer (ADR 0065) must pick one of its question's choices, come from the one name the
      // question is addressed to, and be the first. Checked inside the write, so two taps that
      // race still leave exactly one answer.
      let question: { id: number; choices: string[] } | null = null;
      if (correlation.answer !== undefined) {
        const row = this.ctx.storage.sql
          .exec<{
            choices: string | null;
            recipient: string | null;
            answered: string | null;
            answerer: string | null;
          }>(
            "SELECT choices, recipient, answered, answerer FROM messages WHERE channel = ? AND id = ? AND deleted = 0",
            channel,
            correlation.replyTo,
          )
          .toArray()[0];
        if (!row?.choices)
          throw new HttpError(400, "not_a_question", "answer needs replyTo to name a question with choices.");
        const choices = JSON.parse(row.choices) as string[];
        if (!choices.includes(correlation.answer))
          throw new HttpError(
            400,
            "invalid_answer",
            `answer must be one of the question's choices: ${choices.map((c) => JSON.stringify(c)).join(", ")}.`,
          );
        // The answerer was resolved when the question was asked, so only that exact name answers;
        // a case variant of it is someone else. A question stored without one folds `to`.
        if (row.answerer !== null ? username !== row.answerer : !addressedTo(username, row.recipient))
          throw new HttpError(
            403,
            "not_addressed",
            `Only ${JSON.stringify(row.answerer ?? row.recipient)} can answer this question.`,
          );
        if (row.answered) {
          const first = JSON.parse(row.answered) as Answered;
          throw new HttpError(
            409,
            "already_answered",
            `This question was already answered with ${JSON.stringify(first.choice)} in message ${first.id}.`,
          );
        }
        question = { id: correlation.replyTo as number, choices };
      }
      // A replacement (ADR 0068) names an earlier message by the same sender that nothing has
      // replaced yet. Checked inside the write, so two replacements that race leave exactly one.
      if (correlation.replaces !== undefined) {
        const old = this.ctx.storage.sql
          .exec<{ username: string; personaId: string | null; deleted: number; replacedBy: number | null }>(
            "SELECT username, personaId, deleted, replacedBy FROM messages WHERE channel = ? AND id = ?",
            channel,
            correlation.replaces,
          )
          .toArray()[0];
        if (!old)
          throw new HttpError(
            400,
            "invalid_replaces",
            "replaces must be the id of an existing message in this channel.",
          );
        if (old.deleted) throw new HttpError(410, "message_deleted", "The message to replace was deleted.");
        if (old.username === GITHUB_SENDER)
          throw new HttpError(403, "github_message", "Messages from GitHub cannot be replaced.");
        // Only the sender replaces, as only the sender edits (ADR 0052): on a shared board, only the
        // persona that sent it.
        if (
          old.username !== username ||
          (old.personaId !== null && personaId !== null && old.personaId !== personaId)
        )
          throw new HttpError(403, "not_sender", "Only the sender can replace a message.");
        if (old.replacedBy !== null)
          throw new HttpError(
            409,
            "already_replaced",
            `Message ${correlation.replaces} was already replaced by message ${old.replacedBy}. Replace that one instead.`,
          );
      }
      const usage = this.ctx.storage.sql
        .exec<{ messages: number; bytes: number }>("SELECT messages, bytes FROM usage")
        .one();
      // Every referenced file must already be uploaded to this channel; the upload counted its bytes.
      for (const ref of attachments)
        if (
          !this.ctx.storage.sql
            .exec("SELECT 1 FROM attachments WHERE channel = ? AND id = ?", channel, ref.id)
            .toArray().length
        )
          throw new HttpError(
            400,
            "attachment_not_found",
            "Upload each attachment to this channel first; unused uploads expire after 24 hours.",
          );
      const choices = correlation.choices === undefined ? null : JSON.stringify(correlation.choices);
      const bytes = new TextEncoder().encode(
        username + content + (correlation.quote ?? "") + (choices ?? "") + (correlation.answer ?? ""),
      ).length;
      if (usage.messages >= MAX_MESSAGES || usage.bytes + bytes > MAX_CONTENT_BYTES) {
        throw new HttpError(
          409,
          "storage_quota",
          "Tenant quota reached (100,000 lifetime messages or 128 MiB active content). Contact the administrator.",
        );
      }
      this.createChannel(channel);
      const answerer =
        correlation.choices === undefined ? null : this.resolveAnswerer(channel, correlation.to as string);
      const message = this.ctx.storage.sql
        .exec<MessageRow>(
          `INSERT INTO messages(channel, username, text, contentType, createdAt, key, digest, bytes, replyTo, correlationId, recipient, recipients, personaId, quote, choices, answer, answerer, replaces) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${MESSAGE_COLUMNS}`,
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
          correlation.recipients ? JSON.stringify(correlation.recipients) : null,
          personaId,
          correlation.quote ?? null,
          choices,
          correlation.answer ?? null,
          answerer,
          correlation.replaces ?? null,
        )
        .one();
      if (correlation.replaces !== undefined)
        this.ctx.storage.sql.exec(
          "UPDATE messages SET replacedBy = ? WHERE id = ?",
          message.id,
          correlation.replaces,
        );
      if (question)
        this.ctx.storage.sql.exec(
          "UPDATE messages SET answered = ? WHERE id = ?",
          JSON.stringify({
            id: message.id,
            choice: correlation.answer as string,
            username,
            answeredAt: message.createdAt,
          } satisfies Answered),
          question.id,
        );
      this.ctx.storage.sql.exec(
        "UPDATE usage SET messages = messages + 1, bytes = bytes + ? WHERE singleton = 1",
        bytes,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO message_search(rowid, text) VALUES (?, ?)",
        message.id,
        message.text,
      );
      for (const [label, value] of Object.entries(labels ?? {}))
        this.ctx.storage.sql.exec(
          "INSERT INTO message_labels(channel, messageId, key, value, updatedAt) VALUES (?, ?, ?, ?, ?)",
          channel,
          message.id,
          label,
          value,
          message.createdAt,
        );
      for (const [position, ref] of attachments.entries())
        this.ctx.storage.sql.exec(
          "INSERT INTO message_attachments(messageId, position, channel, attachmentId, name, mediaType) VALUES (?, ?, ?, ?, ?, ?)",
          message.id,
          position,
          channel,
          ref.id,
          ref.name,
          ref.mediaType,
        );
      const eventId = this.insertEvent(channel, "message.created", message.id);
      const created = this.withLabels(channel, [toMessage(message, tenant)])[0];
      // Same transaction as the message: a notice exists exactly when its message does.
      const woke = this.queueAddressedNotice(created, eventId);
      return { message: created, replayed: false, woke };
    });
    // transactionSync succeeded; output gates delay network replies until durable commit.
    if (!result.replayed) {
      for (const waiter of this.waiters) if (waiter.channel === channel) waiter.wake();
      this.wakeEvents(channel);
      if (notify) this.notifyOwner(result.message);
      // A webhook notice goes out from the alarm, never from this request (ADR 0062).
      if (result.woke) this.ctx.waitUntil(this.armAlarm());
    }
    return json({ message: result.message, replayed: result.replayed }, result.replayed ? 200 : 201);
  }

  /** Adds attachment metadata to a page of same-channel messages with one range query. */
  private withAttachments(channel: string, messages: Message[]): Message[] {
    if (!messages.length) return messages;
    const rows = this.ctx.storage.sql
      .exec<{
        messageId: number;
        position: number;
        id: string;
        name: string;
        mediaType: string;
        bytes: number;
      }>(
        `SELECT r.messageId, r.position, r.attachmentId AS id, r.name, r.mediaType, a.bytes
         FROM message_attachments r JOIN attachments a ON a.channel = r.channel AND a.id = r.attachmentId
         WHERE r.channel = ? AND r.messageId BETWEEN ? AND ? ORDER BY r.messageId, r.position`,
        channel,
        Math.min(...messages.map((m) => m.id)),
        Math.max(...messages.map((m) => m.id)),
      )
      .toArray();
    if (!rows.length) return messages;
    const byMessage = new Map<number, Attachment[]>();
    for (const { messageId, position, ...file } of rows) {
      const list = byMessage.get(messageId) ?? [];
      list.push({ index: position, ...file });
      byMessage.set(messageId, list);
    }
    return messages.map((m) => (byMessage.has(m.id) ? { ...m, attachments: byMessage.get(m.id) } : m));
  }

  /**
   * Stores one file under its SHA-256 (ADR 0035). The same bytes in the same channel are stored
   * once, so a retried upload returns the same id and costs nothing. Counted in the content quota.
   */
  private async upload(channel: string, request: Request): Promise<Response> {
    const data = await rawBody(request, MAX_ATTACHMENT_BYTES);
    const id = await sha256(data);
    const result = this.ctx.storage.transactionSync(() => {
      this.requireActive(channel); // After the awaits: an archive meanwhile still wins (ADR 0046).
      const now = Date.now();
      this.dropOrphans(now);
      const existing = this.ctx.storage.sql
        .exec<{ bytes: number }>("SELECT bytes FROM attachments WHERE channel = ? AND id = ?", channel, id)
        .toArray()[0];
      if (existing) {
        // Refresh the clock so a retry just before expiry keeps the upload for a full window.
        this.ctx.storage.sql.exec(
          "UPDATE attachments SET createdAt = ? WHERE channel = ? AND id = ?",
          new Date(now).toISOString(),
          channel,
          id,
        );
        return { created: false };
      }
      const usage = this.ctx.storage.sql.exec<{ bytes: number }>("SELECT bytes FROM usage").one();
      if (usage.bytes + data.byteLength > MAX_CONTENT_BYTES)
        throw new HttpError(
          409,
          "storage_quota",
          "Tenant quota reached (128 MiB active content, attachments included). Contact the administrator.",
        );
      this.ctx.storage.sql.exec(
        "INSERT INTO attachments(channel, id, data, bytes, createdAt) VALUES (?, ?, ?, ?, ?)",
        channel,
        id,
        data,
        data.byteLength,
        new Date(now).toISOString(),
      );
      this.ctx.storage.sql.exec("UPDATE usage SET bytes = bytes + ? WHERE singleton = 1", data.byteLength);
      return { created: true };
    });
    return json({ attachment: { id, bytes: data.byteLength } }, result.created ? 201 : 200);
  }

  /** Serves one file of a live message. Only common image types render inline. */
  private download(channel: string, message: number, index: number): Response {
    const row = this.ctx.storage.sql
      .exec<{ deleted: number; name: string | null; mediaType: string | null; data: ArrayBuffer | null }>(
        `SELECT m.deleted, r.name, r.mediaType, a.data FROM messages m
         LEFT JOIN message_attachments r ON r.messageId = m.id AND r.position = ?
         LEFT JOIN attachments a ON a.channel = r.channel AND a.id = r.attachmentId
         WHERE m.channel = ? AND m.id = ?`,
        index,
        channel,
        message,
      )
      .toArray()[0];
    if (!row) throw new HttpError(404, "message_not_found", "Message not found.");
    if (row.deleted) throw new HttpError(410, "message_deleted", "This message was deleted.");
    if (!row.data || !row.name || !row.mediaType)
      throw new HttpError(404, "attachment_not_found", "This message has no attachment at that index.");
    const inline = INLINE_MEDIA_TYPES.includes(row.mediaType);
    return new Response(row.data, {
      headers: {
        "Content-Type": row.mediaType,
        "Content-Disposition": contentDisposition(inline, row.name),
        "Cache-Control": "no-store",
      },
    });
  }

  /** Deletes uploads no message references once they are older than the orphan window. */
  private dropOrphans(now: number): void {
    const cutoff = new Date(now - ATTACHMENT_ORPHAN_MS).toISOString();
    const freed = this.ctx.storage.sql
      .exec<{ bytes: number }>(
        `DELETE FROM attachments WHERE createdAt < ? AND NOT EXISTS (
           SELECT 1 FROM message_attachments r WHERE r.channel = attachments.channel AND r.attachmentId = attachments.id
         ) RETURNING bytes`,
        cutoff,
      )
      .toArray()
      .reduce((sum, row) => sum + row.bytes, 0);
    if (freed) this.ctx.storage.sql.exec("UPDATE usage SET bytes = bytes - ? WHERE singleton = 1", freed);
  }

  /**
   * Redaction: removes a deleted message's file references and, at once, every file in the channel
   * that no live reference still needs. Returns the bytes freed for the caller's usage update.
   */
  private dropAttachments(channel: string, message: number): number {
    const ids = this.ctx.storage.sql
      .exec<{ attachmentId: string }>(
        "DELETE FROM message_attachments WHERE messageId = ? RETURNING attachmentId",
        message,
      )
      .toArray()
      .map((row) => row.attachmentId);
    let freed = 0;
    for (const id of new Set(ids)) {
      if (
        this.ctx.storage.sql
          .exec(
            "SELECT 1 FROM message_attachments WHERE channel = ? AND attachmentId = ? LIMIT 1",
            channel,
            id,
          )
          .toArray().length
      )
        continue;
      freed += this.ctx.storage.sql
        .exec<{ bytes: number }>(
          "DELETE FROM attachments WHERE channel = ? AND id = ? RETURNING bytes",
          channel,
          id,
        )
        .toArray()
        .reduce((sum, row) => sum + row.bytes, 0);
    }
    return freed;
  }

  private historyRevision(channel: string): number {
    return (
      this.ctx.storage.sql
        .exec<{ revision: number }>("SELECT revision FROM channel_history WHERE channel = ?", channel)
        .toArray()[0]?.revision ?? 0
    );
  }

  /** Pinned messages in message order, each with when and by whom it was pinned (ADR 0038). */
  private pinned(tenant: string, channel: string): Message[] {
    const columns = MESSAGE_COLUMNS.split(", ")
      .map((column) => `m.${column}`)
      .join(", ");
    const rows = this.ctx.storage.sql
      .exec<MessageRow & { pinnedAt: string; pinnedBy: string | null }>(
        `SELECT ${columns}, p.pinnedAt, p.pinnedBy FROM pins p JOIN messages m ON m.id = p.messageId
         WHERE p.channel = ? AND m.channel = p.channel AND m.deleted = 0 ORDER BY m.id`,
        channel,
      )
      .toArray();
    const pins = new Map(rows.map((row) => [row.id, { pinnedAt: row.pinnedAt, pinnedBy: row.pinnedBy }]));
    // withLabels reads one id range; pins can be far apart, so decorate each message on its own.
    return rows.map(({ pinnedAt: _a, pinnedBy: _b, ...row }) => {
      const message = this.withLabels(channel, [toMessage(row, tenant)])[0];
      const pin = pins.get(row.id);
      return Object.assign(message, {
        pinnedAt: pin?.pinnedAt,
        ...(pin?.pinnedBy ? { pinnedBy: pin.pinnedBy } : {}),
      });
    });
  }

  /**
   * `GET …/pins` lists a board's pinned messages for anyone who can read it. `PUT|DELETE
   * …/pins/:id` are owner only. Pinning never sends a message, so message ids and cursors stay.
   */
  private pinRoute(
    request: Request,
    tenant: string,
    channel: string,
    rest: string[],
    capability: TenantRow,
  ): Response {
    this.requireChannel(channel);
    if (!rest.length && request.method === "GET")
      return json({ pins: this.pinned(tenant, channel), limit: MAX_PINS });
    if (rest.length !== 1 || !["PUT", "DELETE"].includes(request.method))
      throw new HttpError(404, "route_not_found", "Unknown pin operation.");
    this.requireOwner(capability);
    this.requireActive(channel);
    const id = messageId(rest[0]);
    if (request.method === "DELETE") {
      this.ctx.storage.sql.exec("DELETE FROM pins WHERE channel = ? AND messageId = ?", channel, id);
      return new Response(null, { status: 204 });
    }
    const created = this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<{ deleted: number }>("SELECT deleted FROM messages WHERE channel = ? AND id = ?", channel, id)
        .toArray()[0];
      if (!row) throw new HttpError(404, "message_not_found", "Message not found.");
      if (row.deleted) throw new HttpError(410, "message_deleted", "This message was deleted.");
      if (
        this.ctx.storage.sql
          .exec("SELECT 1 FROM pins WHERE channel = ? AND messageId = ?", channel, id)
          .toArray().length
      )
        return false;
      const count = this.ctx.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM pins WHERE channel = ?", channel)
        .one().n;
      if (count >= MAX_PINS)
        throw new HttpError(
          409,
          "pin_limit",
          `A board can have at most ${MAX_PINS} pinned messages. Unpin one first.`,
        );
      this.ctx.storage.sql.exec(
        "INSERT INTO pins(channel, messageId, pinnedBy, pinnedAt) VALUES (?, ?, ?, ?)",
        channel,
        id,
        capability.bound_username ?? null,
        new Date().toISOString(),
      );
      return true;
    });
    const pin = this.pinned(tenant, channel).find((message) => message.id === id);
    return json({ pin, created }, created ? 201 : 200);
  }

  /**
   * Newest-first search of one channel (ADR 0037). `q` drives the FTS5 index, so its cost follows
   * how many messages in the workspace match; `from`, `kind` and `label` narrow it. Without `q`
   * the channel's own index is scanned newest first. `before` pages to older matches.
   */
  private search(tenant: string, channel: string, params: URLSearchParams): Response {
    for (const name of params.keys())
      if (!["q", "from", "kind", "label", "before", "limit"].includes(name))
        throw new HttpError(400, "invalid_query", `Unknown search parameter ${name}.`);
    const q = params.get("q") ?? "";
    const match = searchMatch(q);
    if (q.trim() && !match) throw new HttpError(400, "invalid_query", "q has no words to search for.");
    const from = params.has("from") ? text(params.get("from"), "from", 128) : null;
    const kindParam = params.get("kind");
    const kind = kindParam === null ? null : SEARCH_KINDS[kindParam];
    if (kind === undefined) throw new HttpError(400, "invalid_query", "kind must be text or json.");
    const filters = labelFilters(params);
    if (!match && from === null && kind === null && !filters.length)
      throw new HttpError(400, "invalid_query", "Search needs q, from, kind or label.");
    const before = params.has("before")
      ? integer(params.get("before"), 0, Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    const limit = integer(params.get("limit"), 20, 100);
    if (!limit) throw new HttpError(400, "invalid_query", "limit must be positive.");
    const columns = MESSAGE_COLUMNS.split(", ")
      .map((column) => `m.${column}`)
      .join(", ");
    const where: string[] = ["m.channel = ?", "m.deleted = 0", "m.id < ?"];
    const bindings: unknown[] = [channel, before];
    if (from !== null) {
      where.push("m.username = ?");
      bindings.push(from);
    }
    if (kind !== null) {
      where.push("m.contentType = ?");
      bindings.push(kind);
    }
    for (const filter of filters) {
      where.push(
        `EXISTS (SELECT 1 FROM message_labels l WHERE l.channel = m.channel AND l.messageId = m.id AND l.key = ?${
          filter.values ? ` AND l.value IN (${filter.values.map(() => "?").join(", ")})` : ""
        })`,
      );
      bindings.push(filter.key, ...(filter.values ?? []));
    }
    const rows = match
      ? this.ctx.storage.sql
          .exec<MessageRow>(
            `SELECT ${columns} FROM message_search s JOIN messages m ON m.id = s.rowid
             WHERE message_search MATCH ? AND s.rowid < ? AND ${where.join(" AND ")}
             ORDER BY s.rowid DESC LIMIT ?`,
            match,
            before,
            ...bindings,
            limit + 1,
          )
          .toArray()
      : this.ctx.storage.sql
          .exec<MessageRow>(
            `SELECT ${columns} FROM messages m WHERE ${where.join(" AND ")} ORDER BY m.id DESC LIMIT ?`,
            ...bindings,
            limit + 1,
          )
          .toArray();
    const messages = rows.slice(0, limit).map((row) => toMessage(row, tenant));
    return json({
      messages: this.withSparse(channel, messages),
      hasMore: rows.length > limit,
      ...(rows.length > limit ? { nextBefore: messages.at(-1)?.id } : {}),
      complete: this.searchIndexed(),
    });
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
    return json({
      message: this.withLabels(channel, [toMessage(message, tenant)])[0],
      historyRevision: this.historyRevision(channel),
    });
  }

  /**
   * Processed-by receipts (ADR 0040), read only from explicit resumable commits in
   * `processing_cursors` (ADR 0034). A reader has processed message N when its committedThrough
   * is at least N. A board persona with no committed reader is listed with committedThrough null.
   * Nothing here is inferred from presence, polling or silence.
   */
  private receipts(channel: string): Receipt[] {
    const personas = this.ctx.storage.sql
      .exec<{ id: string; displayName: string }>(
        "SELECT id, displayName FROM personas WHERE channel = ? ORDER BY createdAt, id",
        channel,
      )
      .toArray();
    const cursors = this.ctx.storage.sql
      .exec<{ reader: string; committedThrough: number; updatedAt: string }>(
        "SELECT reader, committedThrough, updatedAt FROM processing_cursors WHERE channel = ? ORDER BY reader",
        channel,
      )
      .toArray();
    // A persona owns its id or display name as a reader, and `<that>/<worker>` for concurrent
    // consumers (ADR 0034). The worker suffix stays in the shown name.
    const owner = (reader: string) => {
      for (const persona of personas)
        for (const prefix of [persona.id, persona.displayName])
          if (reader === prefix || reader.startsWith(`${prefix}/`))
            return { persona, suffix: reader.slice(prefix.length) };
      return null;
    };
    const byPersona = new Map<string, Receipt[]>();
    const others: Receipt[] = [];
    for (const cursor of cursors) {
      const match = owner(cursor.reader);
      const receipt: Receipt = {
        name: match ? match.persona.displayName + match.suffix : cursor.reader,
        reader: cursor.reader,
        personaId: match?.persona.id ?? null,
        committedThrough: cursor.committedThrough,
        updatedAt: cursor.updatedAt,
      };
      if (!match) others.push(receipt);
      else byPersona.set(match.persona.id, [...(byPersona.get(match.persona.id) ?? []), receipt]);
    }
    const result: Receipt[] = [];
    for (const persona of personas)
      result.push(
        ...(byPersona.get(persona.id) ?? [
          {
            name: persona.displayName,
            reader: null,
            personaId: persona.id,
            committedThrough: null,
            updatedAt: null,
          },
        ]),
      );
    return [...result, ...others];
  }

  /**
   * One message's split. `processed` and `notYet` hold only readers with a server cursor, so
   * "not yet" always means "has committed, but not this far". Personas that never committed are
   * listed apart in `noServerCommit`: their progress is unknown, not behind (ADR 0040). The
   * sender's own readers are left out of all three.
   */
  private messageReceipts(channel: string, id: number): Response {
    const row = this.ctx.storage.sql
      .exec<{ deleted: number; username: string; personaId: string | null }>(
        "SELECT deleted, username, personaId FROM messages WHERE channel = ? AND id = ?",
        channel,
        id,
      )
      .toArray()[0];
    if (!row) throw new HttpError(404, "message_not_found", "Message not found.");
    if (row.deleted) throw new HttpError(410, "message_deleted", "This message was deleted.");
    const receipts = this.receipts(channel).filter((r) => !receiptFromSender(r, row.username, row.personaId));
    const committed = receipts.filter((r) => r.committedThrough !== null);
    const done = (r: Receipt) => (r.committedThrough ?? -1) >= id;
    return json({
      channel,
      messageId: id,
      processed: committed.filter(done),
      notYet: committed.filter((r) => !done(r)),
      noServerCommit: receipts.filter((r) => r.committedThrough === null),
    });
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
    // Pinned messages lead the first page only (ADR 0038), like the snapshot; a continuation
    // already had them. They never move nextCursor.
    const pinned = url.searchParams.has("after") ? null : this.pinned(tenant, channel);
    // Edits to messages the reader already has (ADR 0052), opt-in with the edit cursor from the
    // previous page so older clients keep today's shape. Messages after the cursor carry their
    // current text anyway.
    const editsAfter = this.editsAfterParam(url, channel);
    const edits =
      editsAfter === null ? null : this.editedSince(tenant, channel, editsAfter, after, CATCHUP_EDITS);
    const boardEdits = editsAfter === null ? 0 : this.editCursor(channel);
    const editFields = (shown: number) =>
      edits
        ? {
            edited: edits.messages.slice(0, shown),
            editCursor:
              shown < edits.messages.length || edits.hasMore
                ? (edits.seqs[shown - 1] ?? editsAfter ?? 0)
                : Math.max(boardEdits, editsAfter ?? 0),
            editsHasMore: shown < edits.messages.length || edits.hasMore,
          }
        : {};
    const result: Record<string, unknown> & {
      messages: Message[];
      nextCursor: number;
      hasMore: boolean;
      incomplete: boolean;
      byteLimitReached: boolean;
      pinned?: Message[];
      pinnedOmitted?: number;
      edited?: Message[];
    } = {
      ...(pinned ? { pinned, pinnedOmitted: 0 } : {}),
      ...editFields(edits?.messages.length ?? 0),
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
    // Pins are best effort: the checkpoint and first pending message must fit, pins need not.
    const minimum = {
      ...result,
      ...(pinned ? { pinned: [], pinnedOmitted: pinned.length } : {}),
      ...editFields(0),
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
    const pinSizes = (pinned ?? []).map((message) => encoder.encode(JSON.stringify(message)).length);
    let pinBytes = pinSizes.reduce((sum, bytes) => sum + bytes, 0);
    const editSizes = (edits?.messages ?? []).map(
      (message) => encoder.encode(JSON.stringify(message)).length,
    );
    let editBytes = editSizes.reduce((sum, bytes) => sum + bytes, 0);
    const size = () =>
      encoder.encode(
        JSON.stringify({
          ...result,
          ...(pinned ? { pinned: [] } : {}),
          ...(edits ? { edited: [] } : {}),
          messages: [],
        }),
      ).length +
      contentBytes +
      Math.max(0, result.messages.length - 1) +
      pinBytes +
      Math.max(0, (result.pinned?.length ?? 0) - 1) +
      editBytes +
      Math.max(0, (result.edited?.length ?? 0) - 1);
    const dropMessage = () => {
      result.messages.pop();
      contentBytes -= messageSizes.pop() ?? 0;
      result.nextCursor = result.messages.at(-1)?.id ?? after;
      result.hasMore = result.incomplete = result.byteLimitReached = true;
    };
    // Shed tail messages first (they stay readable with after=nextCursor), down to one; then the
    // newest edits (they stay readable with editsAfter=editCursor); then the newest pins; then the
    // last message.
    while (size() > maxBytes && result.messages.length > 1) dropMessage();
    while (size() > maxBytes && result.edited?.length) {
      editBytes -= editSizes[result.edited.length - 1] ?? 0;
      Object.assign(result, editFields(result.edited.length - 1));
      result.byteLimitReached = true;
    }
    while (size() > maxBytes && result.pinned?.length) {
      result.pinned.pop();
      pinBytes -= pinSizes.pop() ?? 0;
      result.pinnedOmitted = (result.pinnedOmitted ?? 0) + 1;
      result.byteLimitReached = true;
    }
    while (size() > maxBytes && result.messages.length) dropMessage();
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

  /** Current processing cursor row, or null when the reader was never claimed (ADR 0034). */
  private processingRow(channel: string, reader: string): ProcessingRow | null {
    return (
      this.ctx.storage.sql
        .exec<ProcessingRow>(
          `SELECT ${PROCESSING_COLUMNS} FROM processing_cursors WHERE channel = ? AND reader = ?`,
          channel,
          reader,
        )
        .toArray()[0] ?? null
    );
  }

  /**
   * The fence (ADR 0034). Synchronous, so callers run it in the same storage turn as the read or
   * write it guards: once a takeover commits, no request carrying an older generation succeeds.
   */
  private requireGeneration(channel: string, reader: string, generation: number): ProcessingRow {
    const row = this.processingRow(channel, reader);
    if (!row)
      throw new HttpError(
        404,
        "processing_not_claimed",
        "This reader has no resumable progress on this channel. Claim it first.",
      );
    if (row.generation !== generation)
      throw new HttpError(
        409,
        "processing_fenced",
        `Generation ${generation} was taken over; generation ${row.generation} now holds this reader. Stop processing.`,
      );
    return row;
  }

  private async processingRoute(
    request: Request,
    channel: string,
    rest: string[],
    capability: TenantRow,
  ): Promise<Response> {
    this.requireChannel(channel);
    const reader = processingReader(rest[0]);
    if (rest.length === 1 && request.method === "GET") {
      const row = this.processingRow(channel, reader);
      return json(row ? toProcessing(row) : { reader, generation: 0, committedThrough: 0, holder: null });
    }
    if (rest.length !== 2 || request.method !== "POST")
      throw new HttpError(404, "route_not_found", "Unknown processing operation.");
    // A key bound to a name may only claim, take over or commit that name's readers, as with
    // sends: the name itself or `name/<worker>` (for `--reader` on concurrent consumers). Prefix
    // keys already allow any suffix. Unbound and shared board keys stay cooperative (ADR 0026).
    const bound = capability.bound_username;
    if (bound === null || bound === undefined || !reader.startsWith(`${bound}/`))
      this.requireBoundName(capability, reader);
    const input = await body(request);
    this.requireActive(channel); // After the await: an archive meanwhile still wins (ADR 0046).
    if (rest[1] === "claim") {
      const expected = processingInteger(input.expectGeneration, "expectGeneration");
      const holder =
        input.holder === undefined || input.holder === null ? null : text(input.holder, "holder", 128);
      const start =
        input.committedThrough === undefined
          ? 0
          : processingInteger(input.committedThrough, "committedThrough");
      const row = this.ctx.storage.transactionSync(() => {
        const current = this.processingRow(channel, reader);
        const generation = current?.generation ?? 0;
        if (generation !== expected)
          throw new HttpError(
            409,
            generation && !expected ? "processing_held" : "processing_generation_mismatch",
            generation && !expected
              ? `Generation ${generation} holds this reader. Take over explicitly only if that agent is gone.`
              : `expectGeneration is ${expected} but generation ${generation} holds this reader. Read it again.`,
            { generation, holder: current?.holder ?? null, committedThrough: current?.committedThrough ?? 0 },
          );
        // A first claim may carry local progress forward; a takeover always keeps the server's.
        if (current && input.committedThrough !== undefined)
          throw new HttpError(
            400,
            "invalid_processing",
            "committedThrough is only accepted on a first claim.",
          );
        if (start > this.headCursor(channel))
          throw new HttpError(400, "invalid_cursor", "committedThrough exceeds this channel's current head.");
        const now = new Date().toISOString();
        return this.ctx.storage.sql
          .exec<ProcessingRow>(
            `INSERT INTO processing_cursors(channel, reader, committedThrough, generation, holder, claimedAt, updatedAt)
             VALUES (?, ?, ?, 1, ?, ?, ?)
             ON CONFLICT(channel, reader) DO UPDATE SET generation = generation + 1, holder = excluded.holder,
               claimedAt = excluded.claimedAt, updatedAt = excluded.updatedAt
             RETURNING ${PROCESSING_COLUMNS}`,
            channel,
            reader,
            start,
            holder,
            now,
            now,
          )
          .one();
      });
      return json({ ...toProcessing(row), previousGeneration: expected }, expected ? 200 : 201);
    }
    if (rest[1] === "commit") {
      const generation = processingInteger(input.generation, "generation");
      const through = processingInteger(input.through, "through");
      const row = this.ctx.storage.transactionSync(() => {
        // Fence check and write share one transaction: a superseded generation cannot commit.
        const current = this.requireGeneration(channel, reader, generation);
        if (through < current.committedThrough)
          throw new HttpError(409, "commit_behind", "through is behind committedThrough.", {
            committedThrough: current.committedThrough,
          });
        if (through > this.headCursor(channel))
          throw new HttpError(400, "invalid_cursor", "through exceeds this channel's current head.");
        return this.ctx.storage.sql
          .exec<ProcessingRow>(
            `UPDATE processing_cursors SET committedThrough = ?, updatedAt = ? WHERE channel = ? AND reader = ?
             RETURNING ${PROCESSING_COLUMNS}`,
            through,
            new Date().toISOString(),
            channel,
            reader,
          )
          .one();
      });
      return json(toProcessing(row));
    }
    throw new HttpError(404, "route_not_found", "Unknown processing operation.");
  }

  /**
   * "Since you last looked" for one reader (ADR 0061). Starts at the reader's server processing
   * commit when it has one, else at `after` (the caller's own read cursor), else at the start of
   * the board. Reads at most SINCE_MESSAGES + 1 messages and SINCE_EVENTS events, and writes
   * nothing: no cursor, receipt or event moves.
   */
  private since(channel: string, params: URLSearchParams, capability: TenantRow) {
    const named = params.get("reader") ?? capability.bound_username ?? null;
    if (named === null)
      throw new HttpError(400, "invalid_reader", "Name the reader: ?reader=NAME (the agent's display name).");
    const reader = text(named, "reader", 128, "invalid_reader");
    // The same rule as processing claims and commits (ADR 0034): a key bound to a name reads only
    // that name's summaries (the name or `name/<worker>`). Unbound and shared board keys stay
    // cooperative (ADR 0026).
    const bound = capability.bound_username;
    if (bound === null || bound === undefined || !reader.startsWith(`${bound}/`))
      this.requireBoundName(capability, reader);
    // Who "you" are in the rows: a board persona owns its id or display name as a reader, plus
    // `<that>/<worker>`, as receipts read it (ADR 0040); any other `name/<worker>` reader is `name`.
    const personas = this.ctx.storage.sql
      .exec<{ id: string; displayName: string }>(
        "SELECT id, displayName FROM personas WHERE channel = ?",
        channel,
      )
      .toArray();
    const persona = personas.find((row) =>
      [row.id, row.displayName].some((prefix) => reader === prefix || reader.startsWith(`${prefix}/`)),
    );
    const name =
      persona?.displayName ?? (reader.includes("/") ? reader.slice(0, reader.indexOf("/")) : reader);
    const head = this.headCursor(channel);
    const requested = params.has("after") ? integer(params.get("after"), 0, Number.MAX_SAFE_INTEGER) : null;
    if (requested !== null && requested > head)
      throw new HttpError(400, "invalid_cursor", "after exceeds this channel's current head.");
    const processing = this.processingRow(channel, reader);
    const [source, after]: [SinceSource, number] = processing
      ? ["processing", processing.committedThrough]
      : requested !== null
        ? ["after", requested]
        : ["start", 0];
    // Only what the rows read. JSON payloads (task, board and job events) come whole; plain text
    // is only ever shown as a 120-character excerpt, so a long message is cut in SQL.
    const rows = this.ctx.storage.sql
      .exec<{
        id: number;
        username: string;
        text: string;
        contentType: string;
        recipient: string | null;
        recipients: string | null;
        personaId: string | null;
      }>(
        `SELECT id, username, contentType, recipient, recipients, personaId,
           CASE WHEN contentType = 'application/json' THEN text ELSE substr(text, 1, ?) END AS text
         FROM messages WHERE channel = ? AND deleted = 0 AND id > ? ORDER BY id LIMIT ?`,
        SINCE_TEXT_CHARS,
        channel,
        after,
        SINCE_MESSAGES + 1,
      )
      .toArray();
    const messages = rows.slice(0, SINCE_MESSAGES).map((row) => ({
      id: row.id,
      username: row.username,
      text: row.text,
      contentType: row.contentType,
      ...(row.recipient === null ? {} : { to: row.recipient }),
      ...(row.recipients == null ? {} : { recipients: JSON.parse(row.recipients) as string[] }),
      ...(row.personaId === null ? {} : { personaId: row.personaId }),
    }));
    // Label changes: walk the newest channel events back to this reader's starting point. The
    // journal stores which message changed, not who changed it or which key, so each row shows
    // the message's labels as they are now.
    const events = this.ctx.storage.sql
      .exec<{ type: string; resourceId: number | null }>(
        // Only the two types this walk reads, so status changes (ADR 0064) and edits cannot crowd
        // label changes out of the window.
        "SELECT type, resourceId FROM events WHERE channel = ? AND type IN ('message.created', 'message.labeled') ORDER BY id DESC LIMIT ?",
        channel,
        SINCE_EVENTS,
      )
      .toArray();
    const changed = new Map<number, number>();
    let reached = events.length < SINCE_EVENTS;
    for (const event of events) {
      if (event.type === "message.created" && event.resourceId !== null && event.resourceId <= after) {
        reached = true;
        break;
      }
      if (event.type === "message.labeled" && event.resourceId !== null)
        changed.set(event.resourceId, (changed.get(event.resourceId) ?? 0) + 1);
    }
    // Every relabeled message is counted, but only the SINCE_LABELS most changed are looked up,
    // so the IN lists stay far below the Durable Object's 100 bound parameters.
    const ranked = [...changed.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const live = new Map<number, string>();
    let queried = 0;
    // Deleted messages drop out; read ranked ids in small batches until enough live ones are found.
    for (let start = 0; start < ranked.length && live.size < SINCE_LABELS; start += SINCE_LABEL_BATCH) {
      const batch = ranked.slice(start, start + SINCE_LABEL_BATCH).map(([id]) => id);
      queried += batch.length;
      for (const row of this.ctx.storage.sql
        .exec<{ id: number; username: string }>(
          `SELECT id, username FROM messages WHERE channel = ? AND deleted = 0 AND id IN (${batch.map(() => "?").join(", ")})`,
          channel,
          ...batch,
        )
        .toArray())
        live.set(row.id, row.username);
    }
    const shown = ranked.filter(([id]) => live.has(id)).slice(0, SINCE_LABELS);
    const current = new Map<number, Record<string, string>>();
    if (shown.length)
      for (const row of this.ctx.storage.sql
        .exec<{ messageId: number; key: string; value: string }>(
          `SELECT messageId, key, value FROM message_labels WHERE channel = ? AND messageId IN (${shown
            .map(() => "?")
            .join(", ")}) ORDER BY messageId, key`,
          channel,
          ...shown.map(([id]) => id),
        )
        .toArray())
        current.set(row.messageId, { ...(current.get(row.messageId) ?? {}), [row.key]: row.value });
    return sinceSummary({
      channel,
      reader,
      name,
      personaId: persona?.id ?? null,
      source,
      after,
      head,
      messages,
      truncated: rows.length > SINCE_MESSAGES,
      labels: shown.map(([id, changes]) => ({
        id,
        username: live.get(id) ?? "",
        changes,
        labels: current.get(id) ?? {},
      })),
      // Relabeled messages beyond the shown ones, less those found deleted. Ids past the batches
      // read are not checked, so a deleted one among them still counts.
      labelsHidden: ranked.length - shown.length - (queried - live.size),
      labelChanges: [...changed.values()].reduce((total, n) => total + n, 0),
      labelsTruncated: !reached,
    });
  }

  private headCursor(channel: string): number {
    return this.ctx.storage.sql
      .exec<{ head: number }>("SELECT COALESCE(MAX(id), 0) AS head FROM messages WHERE channel = ?", channel)
      .one().head;
  }

  /**
   * Unread counts (ADR 0045). The reader sends the read marks it already keeps on its device as
   * repeated `mark=<channel>:<id>`; the server keeps no read state. Each board reads at most
   * UNREAD_CAP + 1 rows from the channel_messages index, so a request is bounded by
   * UNREAD_BOARDS × (UNREAD_CAP + 1) index rows whatever the history size.
   */
  private unreadCounts(url: URL, capability: TenantRow) {
    const me = url.searchParams.get("me") ?? "";
    if (me.length > 128) throw new HttpError(400, "invalid_query", "me must be at most 128 characters.");
    const marks = url.searchParams.getAll("mark");
    if (!marks.length || marks.length > UNREAD_BOARDS)
      throw new HttpError(400, "invalid_query", `Send 1–${UNREAD_BOARDS} mark=<channel>:<id> pairs.`);
    const seen = new Set<string>();
    const pairs = marks.map((value) => {
      const split = value.lastIndexOf(":");
      const channel = slug(split > 0 ? value.slice(0, split) : "");
      const after = Number(value.slice(split + 1));
      if (split < 0 || !/^\d{1,16}$/.test(value.slice(split + 1)) || !Number.isSafeInteger(after))
        throw new HttpError(400, "invalid_query", "Each mark must be <channel>:<message id>.");
      if (seen.has(channel)) throw new HttpError(400, "invalid_query", "Each channel may appear once.");
      seen.add(channel);
      this.requireScope(capability, channel);
      return { channel, after };
    });
    const self = me.trim().toLowerCase();
    const unread = pairs.map(({ channel, after }) => {
      const rows = this.ctx.storage.sql
        .exec<{ username: string; recipient: string | null; recipients: string | null }>(
          "SELECT username, recipient, recipients FROM messages WHERE channel = ? AND deleted = 0 AND id > ? ORDER BY id LIMIT ?",
          channel,
          after,
          UNREAD_CAP + 1,
        )
        .toArray();
      const capped = rows.length > UNREAD_CAP;
      // Your own messages are not news, as in "since you last looked" (ADR 0033).
      const others = rows.slice(0, UNREAD_CAP).filter((row) => row.username !== me);
      const toYou = self
        ? others.filter((row) =>
            isAddressed(me, {
              to: row.recipient,
              recipients: row.recipients === null ? null : (JSON.parse(row.recipients) as string[]),
            }),
          ).length
        : 0;
      return { channel, after, count: others.length, toYou, ...(capped ? { capped: true } : {}) };
    });
    return { unread, cap: UNREAD_CAP };
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

  private async provision(
    tenant: string,
    bind: Binding,
    channel?: string,
    credential?: string,
  ): Promise<Response> {
    const token = credential ?? newToken();
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new HttpError(400, "invalid_credential", "Use a random 256-bit credential.");
    const hash = await digest(token);
    return this.ctx.storage.transactionSync(() => {
      if (credential && this.tenantRow()?.token_hash === hash)
        return json(
          this.identity(
            tenant,
            { bound_username: bind.username, bound_prefix: bind.prefix, owner_access: 1 },
            token,
          ),
        );
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
    if (this.authorize(hash).shared_channel)
      throw new HttpError(
        400,
        "shared_channel_invitation",
        "Share the channel connection with msn connection-export; add personas without new keys.",
      );
    const maxUses = input.maxUses === undefined ? 25 : snapshotInteger(input.maxUses, "maxUses");
    const expiresIn = input.expiresIn === undefined ? 86400 : snapshotInteger(input.expiresIn, "expiresIn");
    if (input.watch !== undefined && typeof input.watch !== "boolean")
      throw new HttpError(400, "invalid_invite", "watch must be true or false.");
    const watch = input.watch === true;
    if (maxUses < 1 || maxUses > 100 || expiresIn < 60 || expiresIn > 604800)
      throw new HttpError(400, "invalid_invite", "Use 1–100 recipients and an expiry of 60–604800 seconds.");
    const code = newToken();
    const codeHash = await digest(code);
    const capability = this.authorize(hash); // Final check after every await.
    this.requireScope(capability, channel);
    if (channel) this.requireChannel(channel);
    if (channel) this.requireActive(channel);
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
      "INSERT INTO invites (id, code_hash, creator_hash, channel, expiresAt, remaining, watch) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      codeHash,
      hash,
      channel,
      expiresAt,
      maxUses,
      watch ? 1 : 0,
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
        ...(watch ? { watch: true } : {}),
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
      // An invitation to an archived board waits: unarchiving makes the same code work again.
      if (invite.channel) this.requireActive(invite.channel);
      this.requireKeyCapacity();
      const id = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        "INSERT INTO access_keys (id, token_hash, bound_username, bound_prefix, createdAt, channel_scope, read_only) VALUES (?, ?, ?, NULL, ?, ?, ?)",
        id,
        hash,
        username,
        new Date().toISOString(),
        invite.channel,
        invite.watch ? 1 : 0,
      );
      this.ctx.storage.sql.exec("UPDATE invites SET remaining = remaining - 1 WHERE id = ?", invite.id);
      return json(
        {
          ...this.identity(
            tenant,
            {
              bound_username: username,
              bound_prefix: null,
              channel_scope: invite.channel,
              read_only: invite.watch,
            },
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
      const hook = /^\/api\/github\/hooks\/([^/]+)$/.exec(url.pathname);
      if (hook && request.method === "POST") return await this.githubDelivery(request, slug(hook[1]));
      const parts = url.pathname.split("/").slice(1);
      const isAdmin = parts[1] === "admin";
      const tenantIndex = isAdmin ? 3 : 2;
      const tenant = slug(parts[tenantIndex] ?? "");
      const rest = parts.slice(tenantIndex + 1);
      if (!isAdmin && !rest.length && request.method === "PUT") {
        if (tenant.startsWith("account-"))
          throw new HttpError(403, "reserved_account", "This account requires Cloudflare login.");
        const input = await body(request);
        const username = text(input.username, "username", 128);
        const channel = input.channel === undefined ? "general" : slug(text(input.channel, "channel", 64));
        return await this.provision(
          tenant,
          { username, prefix: null },
          channel,
          input.credential === undefined ? undefined : text(input.credential, "credential", 64),
        );
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
            // Owner devices subscribed under the old credentials stop receiving notifications.
            this.ctx.storage.sql.exec("DELETE FROM push_subscriptions");
            // Rotation is the reset after a leaked owner key: mutes it may have left go too (ADR 0044).
            this.ctx.storage.sql.exec("DELETE FROM push_mutes");
            // The webhook secret was readable with the old owner credential; GitHub deliveries
            // fail until the owner copies the new one (links stay).
            this.ctx.storage.sql.exec("DELETE FROM github_hook");
            // Persona webhooks (ADR 0062) were set with owner credentials; a leaked owner key could
            // have pointed one at its own URL to keep learning about new messages. They go too.
            this.ctx.storage.sql.exec("DELETE FROM webhooks");
            this.ctx.storage.sql.exec("DELETE FROM webhook_notices");
          });
          this.wakeAllWaiters();
          return json(this.identity(tenant, this.authorize(hash), token));
        }
        if (rest[0] === "keys") {
          if (rest.length === 1 && request.method === "GET") {
            return json({
              keys: this.ctx.storage.sql
                .exec(`SELECT ${KEY_METADATA}, channel_scope, read_only FROM access_keys ORDER BY id`)
                .toArray()
                .map(({ channel_scope, read_only, ...key }) => ({
                  ...key,
                  ...(channel_scope ? { channel: channel_scope } : {}),
                  ...(read_only ? { watchOnly: true } : {}),
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
              "UPDATE messages SET deleted = 1, username = '', text = '', recipient = NULL, recipients = NULL, quote = NULL, choices = NULL, answer = NULL, answered = NULL, answerer = NULL, replaces = NULL, replacedBy = NULL, bytes = 0 WHERE id = ?",
              id,
            );
            // Deleting a replacement makes the message it replaced current again (ADR 0068).
            this.ctx.storage.sql.exec(
              "UPDATE messages SET replacedBy = NULL WHERE channel = ? AND replacedBy = ?",
              channel,
              id,
            );
            // Deleting a question's answer reopens the question (ADR 0065): its record named the
            // answerer, and the answer no longer exists to point at.
            this.ctx.storage.sql.exec(
              "UPDATE messages SET answered = NULL WHERE channel = ? AND answered IS NOT NULL AND json_extract(answered, '$.id') = ?",
              channel,
              id,
            );
            this.ctx.storage.sql.exec(
              "DELETE FROM message_labels WHERE channel = ? AND messageId = ?",
              channel,
              id,
            );
            this.ctx.storage.sql.exec("DELETE FROM pins WHERE channel = ? AND messageId = ?", channel, id);
            const reactionsDropped = this.ctx.storage.sql.exec(
              "DELETE FROM reactions WHERE channel = ? AND messageId = ?",
              channel,
              id,
            ).rowsWritten;
            if (reactionsDropped)
              this.ctx.storage.sql.exec(
                "UPDATE usage SET reactions = MAX(0, reactions - ?) WHERE singleton = 1",
                reactionsDropped,
              );
            // Deleted text must not stay findable (ADR 0037).
            this.ctx.storage.sql.exec("DELETE FROM message_search WHERE rowid = ?", id);
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
              row.bytes + snapshotBytes + this.dropAttachments(channel, id),
            );
            // After the revision bump, so this event's historyRevision is the post-deletion value.
            this.insertEvent(channel, "message.deleted", id);
          });
          this.wakeEvents(channel);
          return new Response(null, { status: 204 });
        }
      } else {
        const hash = await digest(bearer(request));
        // Watch-only keys (ADR 0039) read and never write. One gate in front of every route, so a
        // write route added later is refused by default. GET routes never change board content.
        if (request.method !== "GET" && this.watchOnly(hash))
          throw new HttpError(
            403,
            "watch_only",
            "This access key can watch the board but not post or change anything.",
          );
        // Archived boards (ADR 0046) refuse every write under their path, archive itself aside. One
        // gate in front of the board routes, like watch-only above, so a later write route is refused
        // by default. Authorization runs first, so a stranger cannot learn that a board is archived.
        if (request.method !== "GET" && rest[0] === "channels" && rest[1]) {
          const channel = slug(rest[1]);
          if (rest.length === 3 && rest[2] === "archive") {
            const capability = this.authorize(hash);
            this.requireScope(capability, channel);
            return this.archiveRoute(request, channel, capability);
          }
          // Cancelling a scheduled message changes nothing on the board, so it works on an archived
          // board too (ADR 0060); otherwise a message that failed there could never be cleared.
          const cancelScheduled = rest.length === 4 && rest[2] === "scheduled" && request.method === "DELETE";
          if (this.archivedAt(channel) && !cancelScheduled) {
            this.requireScope(this.authorize(hash), channel);
            this.requireActive(channel);
          }
        }
        if (rest.length === 1 && rest[0] === "invites" && request.method === "POST")
          return await this.createInvite(request, tenant, hash);
        if (rest[0] === "templates") return await this.templateRoute(request, rest.slice(1), hash);
        if (rest[0] === "channels" && rest[1] && rest[2] === "webhooks" && rest.length === 3)
          return await this.webhookRoute(request, url, slug(rest[1]), null, [], hash);
        if (rest[0] === "channels" && rest[1] && rest[2] === "personas" && rest[4] === "webhook")
          return await this.webhookRoute(request, url, slug(rest[1]), slug(rest[3]), rest.slice(5), hash);
        if (
          rest[0] === "channels" &&
          rest[1] &&
          ["status", "statuses"].includes(rest[2]) &&
          rest.length === 3
        )
          return await this.statusRoute(request, url, slug(rest[1]), rest[2], hash);
        if (rest[0] === "channels" && rest[1] && ["board", "personas"].includes(rest[2]))
          return await this.boardRoute(request, tenant, slug(rest[1]), rest.slice(2), hash);
        // Parse/digest before the final authorization check: rotation cannot race a write.
        const input =
          request.method === "POST" && rest.length === 3 && rest[2] === "messages"
            ? await body(request)
            : null;
        const username = input ? text(input.username, "username", 128) : "";
        let personaId = input?.personaId === undefined ? null : slug(text(input.personaId, "personaId", 64));
        // An answer (ADR 0065) may leave out text: the reply then reads as the choice itself.
        const content = input
          ? text(
              input.text === undefined && typeof input.answer === "string" ? input.answer.trim() : input.text,
              "text",
              16384,
            )
          : "";
        const type = input ? contentType(input.contentType, content) : "text/plain";
        const correlation: Correlation = input
          ? {
              replyTo: replyTarget(input.replyTo),
              quote: quoteText(input.quote, input.replyTo),
              correlationId: correlationId(input.correlationId),
              ...addressFields(recipients(input.to)),
              choices: choiceList(input.choices, input.to),
              answer: answerChoice(input.answer, input.replyTo, input.choices),
              replaces: replacesTarget(input.replaces, input.answer),
            }
          : {};
        const sendLabels = input ? parseLabels(input.labels) : undefined;
        const base = input
          ? personaId
            ? JSON.stringify([payload(username, content, type, correlation), personaId])
            : payload(username, content, type, correlation)
          : "";
        const files = input ? attachmentRefs(input.attachments) : [];
        // `sendAt` schedules the send instead (ADR 0060). Uploads expire unused after 24 hours, so a
        // scheduled message cannot carry files.
        // The time window is checked after the idempotency lookup, so a late retry still replays.
        const sendAt =
          input?.sendAt === undefined || input.sendAt === null ? null : sendAtValue(input.sendAt);
        // A question or an answer is about now (ADR 0065): a later post could find the question
        // answered or the answer stale, so neither can be scheduled.
        if (sendAt && (correlation.choices !== undefined || correlation.answer !== undefined))
          throw new HttpError(
            400,
            "invalid_send_at",
            "A question with choices, or an answer to one, cannot be scheduled. Send it now.",
          );
        // A replacement (ADR 0068) is about the message as it stands now; a later post could find
        // it already replaced.
        if (sendAt && correlation.replaces !== undefined)
          throw new HttpError(
            400,
            "invalid_send_at",
            "A replacement cannot be scheduled. Send it now, or schedule a new message.",
          );
        if (sendAt && files.length)
          throw new HttpError(
            400,
            "invalid_send_at",
            "A scheduled message cannot carry attachments. Send the files now, or schedule the text alone.",
          );
        // Sends without labels or files hash exactly as before ADR 0032, so older retries still replay.
        let hashInput = sendLabels ? JSON.stringify([base, sendLabels]) : base;
        if (files.length) hashInput = JSON.stringify([hashInput, files]);
        if (sendAt) hashInput = JSON.stringify([hashInput, { sendAt }]);
        const payloadHash = input ? await digest(hashInput) : "";
        const change =
          request.method === "POST" && rest.length === 5 && rest[2] === "messages" && rest[4] === "labels"
            ? labelChange(await body(request))
            : null;
        const reaction =
          request.method === "POST" && rest.length === 5 && rest[2] === "messages" && rest[4] === "reactions"
            ? reactionChange(await body(request))
            : null;
        const edit =
          request.method === "PATCH" && rest.length === 4 && rest[0] === "channels" && rest[2] === "messages"
            ? messageEdit(await body(request))
            : null;
        const reschedule =
          request.method === "PATCH" && rest.length === 4 && rest[0] === "channels" && rest[2] === "scheduled"
            ? scheduledChange(await body(request))
            : null;
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
        // The entrance gate ran before the awaits above; check again so a label, snapshot or send
        // whose body was still being read when the board was archived is refused too (ADR 0046).
        if (
          request.method !== "GET" &&
          rest[0] === "channels" &&
          rest[1] &&
          !(rest.length === 4 && rest[2] === "scheduled" && request.method === "DELETE")
        )
          this.requireActive(slug(rest[1]));
        if (input && capability.shared_channel && !personaId) {
          const persona = this.ctx.storage.sql
            .exec<{ id: string }>(
              "SELECT id FROM personas WHERE channel=? AND displayName=?",
              rest[1],
              username,
            )
            .toArray()[0];
          if (!persona)
            throw new HttpError(
              400,
              "persona_required",
              `Register this name as a board persona first: PUT /api/tenants/${tenant}/channels/${rest[1]}/personas/ID with {"displayName":${JSON.stringify(username)}} (CLI: msn persona add). Steps: GET /api.`,
            );
          personaId = persona.id;
        }
        // Bound-name check precedes any transaction: a rejected send stores nothing and wakes nobody.
        if (input) this.requireBoundName(capability, username);
        // A reaction names its sender like a send does (ADR 0047): a bound key reacts only as its
        // name, and a board's shared credential only as one of the board's registered personas.
        if (reaction) {
          // Scope first, so a key for another board learns nothing about this board's personas.
          this.requireScope(capability, slug(rest[1]));
          this.requireBoundName(capability, reaction.username);
          // Like sends, only signed GitHub deliveries speak as `github` (ADR 0036).
          if (reaction.username === GITHUB_SENDER)
            throw new HttpError(
              403,
              "reserved_name",
              "The display name github is reserved for GitHub messages.",
            );
          if (
            capability.shared_channel &&
            !this.ctx.storage.sql
              .exec("SELECT 1 FROM personas WHERE channel=? AND displayName=?", rest[1], reaction.username)
              .toArray().length
          )
            throw new HttpError(
              400,
              "persona_required",
              `Register this name as a board persona first: PUT /api/tenants/${tenant}/channels/${rest[1]}/personas/ID with {"displayName":${JSON.stringify(reaction.username)}} (CLI: msn persona add). Steps: GET /api.`,
            );
        }
        // Only signed GitHub deliveries post as `github` (ADR 0036).
        if (input && username === GITHUB_SENDER)
          throw new HttpError(
            403,
            "reserved_name",
            "The display name github is reserved for GitHub messages.",
          );
        if (input && personaId) {
          const persona = this.ctx.storage.sql
            .exec<{ displayName: string }>(
              "SELECT displayName FROM personas WHERE channel=? AND id=?",
              rest[1],
              personaId,
            )
            .toArray()[0];
          if (!persona || persona.displayName !== username)
            throw new HttpError(400, "persona_mismatch", "Register this persona and use its display name.");
        }
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
        if (rest[0] === "push") return await this.pushRoute(request, url, rest.slice(1), capability);
        if (rest[0] === "github") return this.githubRoute(request, url, tenant, rest.slice(1), capability);
        if (rest[0] === "channels" && rest[2] === "github")
          return await this.githubLinkRoute(request, tenant, slug(rest[1]), rest.slice(3), capability);
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
          const listener = this.listenerPersona(capability, url.searchParams.get("listener"));
          // `include=labels,edits` (comma-separated or repeated) opts in to the newer event types.
          const include = url.searchParams
            .getAll("include")
            .flatMap((value) => value.split(","))
            .filter(Boolean);
          if (include.some((value) => !["labels", "edits", "statuses"].includes(value)))
            throw new HttpError(400, "invalid_query", "include accepts labels, edits and statuses.");
          return await this.eventPoll(request, hash, tenant, effectiveChannel, after, limit, wait, listener, {
            labels: include.includes("labels"),
            edits: include.includes("edits"),
            statuses: include.includes("statuses"),
          });
        }
        if (rest.length === 1 && rest[0] === "unread" && request.method === "GET")
          return json(this.unreadCounts(url, capability));
        if (rest[0] === "channels" && rest.length === 1 && request.method === "GET") {
          const after = url.searchParams.get("after") ?? "";
          if (after) slug(after);
          const limit = integer(url.searchParams.get("limit"), 100, 1000);
          if (!limit) throw new HttpError(400, "invalid_query", "limit must be positive.");
          // Archived boards (ADR 0046) leave the default list; include=archived lists them too.
          const include = url.searchParams.get("include");
          if (include !== null && include !== "archived")
            throw new HttpError(400, "invalid_query", "include accepts only archived.");
          const channels = this.ctx.storage.sql
            .exec<{ name: string; createdAt: string; archivedAt: string | null }>(
              `SELECT c.name, c.createdAt, c.archivedAt, COUNT(m.id) AS messageCount,
               MAX(m.createdAt) AS lastActivityAt, COUNT(DISTINCT m.username) AS participantCount
               FROM channels c LEFT JOIN messages m ON m.channel = c.name AND m.deleted = 0
               WHERE c.name > ? AND (? IS NULL OR c.name = ?) AND (? OR c.archivedAt IS NULL)
               GROUP BY c.name ORDER BY c.name LIMIT ?`,
              after,
              capability.channel_scope ?? null,
              capability.channel_scope ?? null,
              include === "archived" ? 1 : 0,
              limit + 1,
            )
            .toArray()
            .map(({ archivedAt, ...row }) => (archivedAt ? { ...row, archivedAt } : row));
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
          if (rest[2] === "pins") return this.pinRoute(request, tenant, channel, rest.slice(3), capability);
          if (rest[2] === "processing")
            return await this.processingRoute(request, channel, rest.slice(3), capability);
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
          if (rest.length === 3 && rest[2] === "attachments" && request.method === "POST") {
            this.requireChannel(channel);
            return await this.upload(channel, request);
          }
          if (
            rest.length === 6 &&
            rest[2] === "messages" &&
            rest[4] === "attachments" &&
            request.method === "GET"
          ) {
            this.requireChannel(channel);
            return this.download(channel, messageId(rest[3]), integer(rest[5], 0, 1000));
          }
          if (change) {
            this.requireChannel(channel);
            return this.relabel(tenant, channel, messageId(rest[3]), change);
          }
          if (reaction) {
            this.requireChannel(channel);
            return this.react(tenant, channel, messageId(rest[3]), reaction);
          }
          if (edit) {
            this.requireChannel(channel);
            return this.editMessage(tenant, channel, messageId(rest[3]), edit, capability);
          }
          if (rest[2] === "scheduled")
            return await this.scheduledRoute(
              request,
              url,
              tenant,
              channel,
              rest.slice(3),
              reschedule,
              capability,
              hash,
            );
          if (rest.length === 3 && rest[2] === "edits" && request.method === "GET") {
            this.requireChannel(channel);
            return this.editPage(tenant, channel, url.searchParams);
          }
          if (rest.length === 3 && rest[2] === "reactions" && request.method === "GET") {
            this.requireChannel(channel);
            return this.reactionPage(channel, url.searchParams);
          }
          if (rest.length === 3 && rest[2] === "search" && request.method === "GET") {
            this.requireChannel(channel);
            return this.search(tenant, channel, url.searchParams);
          }
          if (rest.length === 4 && rest[2] === "messages" && request.method === "GET") {
            this.requireChannel(channel);
            return this.showMessage(tenant, channel, messageId(rest[3]));
          }
          if (rest.length === 3 && rest[2] === "since" && request.method === "GET") {
            this.requireChannel(channel);
            return json(this.since(channel, url.searchParams, capability));
          }
          if (rest.length === 3 && rest[2] === "receipts" && request.method === "GET") {
            this.requireChannel(channel);
            return json({ channel, receipts: this.receipts(channel) });
          }
          if (
            rest.length === 5 &&
            rest[2] === "messages" &&
            rest[4] === "receipts" &&
            request.method === "GET"
          ) {
            this.requireChannel(channel);
            return this.messageReceipts(channel, messageId(rest[3]));
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
              if (sendAt)
                return await this.schedule(
                  tenant,
                  channel,
                  { username, text: content, type, correlation, personaId, labels: sendLabels, sendAt },
                  key,
                  payloadHash,
                  hash,
                  capability,
                );
              return this.send(
                tenant,
                channel,
                username,
                content,
                type,
                correlation,
                key,
                payloadHash,
                personaId,
                // The owner's own messages never notify the owner.
                !capability.owner_access,
                sendLabels,
                files,
              );
            }
            if (request.method === "GET") {
              this.requireChannel(channel);
              const limit = integer(url.searchParams.get("limit"), 100, 100);
              const wait = integer(url.searchParams.get("wait"), 0, 25);
              if (!limit) throw new HttpError(400, "invalid_query", "limit must be positive.");
              const fence = processingFence(url);
              if (fence) {
                // Resumable peek (ADR 0034): the server's committedThrough is the start, and a
                // superseded generation is refused before and after any wait.
                if (
                  ["after", "before", "thread"].some((name) => url.searchParams.has(name)) ||
                  labelFilters(url.searchParams).length
                )
                  throw new HttpError(
                    400,
                    "invalid_query",
                    "after, before, thread and label filters cannot be combined with processingReader.",
                  );
                const after = this.requireGeneration(
                  channel,
                  fence.reader,
                  fence.generation,
                ).committedThrough;
                return await this.poll(
                  request,
                  hash,
                  tenant,
                  channel,
                  after,
                  limit,
                  wait,
                  [],
                  Number.MAX_SAFE_INTEGER,
                  fence,
                  this.editsAfterParam(url, channel),
                );
              }
              const after = integer(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER);
              const filters = labelFilters(url.searchParams);
              // Exclusive upper bound: after=41&before=43 waits on message 42 alone.
              const before = url.searchParams.has("before")
                ? integer(url.searchParams.get("before"), 0, Number.MAX_SAFE_INTEGER)
                : Number.MAX_SAFE_INTEGER;
              // thread=ID (ADR 0063): only that thread's root and replies; a reply id means its thread.
              const thread = url.searchParams.has("thread")
                ? this.threadView(
                    channel,
                    this.threadRoot(channel, messageId(url.searchParams.get("thread") ?? "")),
                  )
                : null;
              return await this.poll(
                request,
                hash,
                tenant,
                channel,
                after,
                limit,
                wait,
                filters,
                before,
                null,
                this.editsAfterParam(url, channel),
                thread,
              );
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
