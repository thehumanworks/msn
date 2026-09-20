import { ProtocolError } from "./errors.ts";
import type {
  CatchupResult,
  ChannelListResult,
  ChannelSummary,
  ContentType,
  CoordinationEvent,
  CoordinationEventType,
  EventPage,
  Identity,
  Message,
  MessagePage,
  Snapshot,
} from "./types.ts";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EVENT_TYPES: ReadonlySet<string> = new Set([
  "channel.created",
  "message.created",
  "message.deleted",
  "snapshot.published",
]);

function bad(what: string): never {
  throw new ProtocolError(`The server sent an invalid ${what}.`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInt(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function obj(value: unknown, what: string): Record<string, unknown> {
  return isObject(value) ? value : bad(what);
}

export type EventExpectations = {
  tenant: string;
  after: number;
  limit: number;
  /** Set for a channel-scoped key or an explicit channel filter: every event must match it. */
  channel?: string;
};

/**
 * Strict decoder for GET /events. Any violation throws ProtocolError, so the caller advances no
 * cursor and processes no event from an invalid feed. Ordering is strictly increasing and
 * strictly after the request cursor; nextCursor must equal the last id (or the request cursor
 * for an empty page) so a server bug can never make the client skip or loop.
 */
export function decodeEventPage(raw: unknown, expected: EventExpectations): EventPage {
  const page = obj(raw, "event page");
  if (!Array.isArray(page.events)) bad("event page");
  if (typeof page.hasMore !== "boolean") bad("event page");
  if (!safeInt(page.nextCursor, 0)) bad("event cursor");
  if (page.events.length > expected.limit) bad("event page size");
  const events: CoordinationEvent[] = [];
  let previous = expected.after;
  for (const item of page.events) {
    const e = obj(item, "event");
    if (!safeInt(e.id, 1) || e.id <= previous) bad("event order");
    if (e.tenant !== expected.tenant) bad("event tenant");
    if (typeof e.channel !== "string" || !SLUG.test(e.channel)) bad("event channel");
    if (expected.channel !== undefined && e.channel !== expected.channel) bad("event scope");
    if (typeof e.type !== "string" || !EVENT_TYPES.has(e.type)) bad("event type");
    if (e.type === "channel.created") {
      if (e.resourceId !== null) bad("event resource");
    } else if (!safeInt(e.resourceId, 1)) bad("event resource");
    if (!safeInt(e.historyRevision, 0)) bad("event revision");
    if (typeof e.createdAt !== "string" || Number.isNaN(Date.parse(e.createdAt))) bad("event time");
    previous = e.id;
    events.push({
      id: e.id,
      tenant: e.tenant,
      channel: e.channel,
      type: e.type as CoordinationEventType,
      resourceId: e.resourceId as number | null,
      historyRevision: e.historyRevision,
      createdAt: e.createdAt,
    });
  }
  if (page.nextCursor !== previous) bad("event cursor");
  if (page.hasMore && events.length === 0) bad("event page");
  return { events, nextCursor: page.nextCursor, hasMore: page.hasMore };
}

export function decodeMessage(raw: unknown): Message {
  const m = obj(raw, "message");
  if (!safeInt(m.id, 1)) bad("message");
  if (typeof m.tenant !== "string" || typeof m.channel !== "string" || !SLUG.test(m.channel)) bad("message");
  if (typeof m.username !== "string" || typeof m.text !== "string" || typeof m.createdAt !== "string")
    bad("message");
  if (m.contentType !== "text/plain" && m.contentType !== "application/json") bad("message");
  const message: Message = {
    id: m.id,
    tenant: m.tenant,
    channel: m.channel,
    username: m.username,
    text: m.text,
    contentType: m.contentType as ContentType,
    createdAt: m.createdAt,
  };
  if (m.replyTo !== undefined) {
    if (!safeInt(m.replyTo, 1)) bad("message");
    message.replyTo = m.replyTo;
  }
  if (m.correlationId !== undefined) {
    if (typeof m.correlationId !== "string") bad("message");
    message.correlationId = m.correlationId;
  }
  if (m.to !== undefined) {
    if (typeof m.to !== "string") bad("message");
    message.to = m.to;
  }
  return message;
}

/** Messages must be strictly increasing and strictly after `after`, matching the cursor rules. */
function decodeMessages(raw: unknown, after: number): Message[] {
  if (!Array.isArray(raw)) bad("message list");
  let previous = after;
  return raw.map((item) => {
    const message = decodeMessage(item);
    if (message.id <= previous) bad("message order");
    previous = message.id;
    return message;
  });
}

export function decodeMessagePage(raw: unknown, after: number): MessagePage {
  const page = obj(raw, "message page");
  const messages = decodeMessages(page.messages, after);
  if (typeof page.hasMore !== "boolean" || !safeInt(page.nextCursor, 0)) bad("message page");
  if (page.nextCursor !== (messages.at(-1)?.id ?? after)) bad("message cursor");
  return { messages, nextCursor: page.nextCursor, hasMore: page.hasMore };
}

export function decodeSnapshot(raw: unknown): Snapshot {
  const s = obj(raw, "snapshot");
  if (
    !safeInt(s.version, 1) ||
    !safeInt(s.coversThrough, 0) ||
    !safeInt(s.historyRevision, 0) ||
    typeof s.channel !== "string" ||
    typeof s.tenant !== "string" ||
    typeof s.username !== "string" ||
    typeof s.text !== "string" ||
    typeof s.createdAt !== "string" ||
    typeof s.invalidated !== "boolean"
  )
    bad("snapshot");
  return {
    tenant: s.tenant as string,
    channel: s.channel as string,
    version: s.version as number,
    username: s.username as string,
    text: s.text as string,
    coversThrough: s.coversThrough as number,
    historyRevision: s.historyRevision as number,
    createdAt: s.createdAt as string,
    invalidated: s.invalidated as boolean,
  };
}

export function decodeCatchup(raw: unknown, after: number | undefined): CatchupResult {
  const c = obj(raw, "catchup");
  const snapshot = c.snapshot === null ? null : decodeSnapshot(c.snapshot);
  const base = snapshot?.coversThrough ?? after ?? 0;
  const messages = decodeMessages(c.messages, base);
  if (
    !safeInt(c.snapshotVersion, 0) ||
    !safeInt(c.historyRevision, 0) ||
    !safeInt(c.nextCursor, 0) ||
    !safeInt(c.headCursor, 0) ||
    !safeInt(c.pendingMessages, 0) ||
    !safeInt(c.pendingBytes, 0) ||
    typeof c.hasMore !== "boolean" ||
    typeof c.incomplete !== "boolean" ||
    typeof c.snapshotDue !== "boolean" ||
    !Array.isArray(c.snapshotDueReasons) ||
    !c.snapshotDueReasons.every((r) => typeof r === "string")
  )
    bad("catchup");
  return {
    snapshot,
    snapshotVersion: c.snapshotVersion,
    historyRevision: c.historyRevision,
    messages,
    nextCursor: c.nextCursor,
    hasMore: c.hasMore,
    incomplete: c.incomplete,
    headCursor: c.headCursor,
    pendingMessages: c.pendingMessages,
    pendingBytes: c.pendingBytes,
    snapshotPendingMessages: safeInt(c.snapshotPendingMessages, 0) ? c.snapshotPendingMessages : 0,
    snapshotPendingBytes: safeInt(c.snapshotPendingBytes, 0) ? c.snapshotPendingBytes : 0,
    snapshotDue: c.snapshotDue,
    snapshotDueReasons: c.snapshotDueReasons as string[],
    snapshotPolicy: (isObject(c.snapshotPolicy) ? c.snapshotPolicy : {}) as CatchupResult["snapshotPolicy"],
    byteLimitReached: c.byteLimitReached === true,
  };
}

export function decodeChannelList(raw: unknown): ChannelListResult {
  const r = obj(raw, "channel list");
  if (!Array.isArray(r.channels) || typeof r.hasMore !== "boolean" || typeof r.nextCursor !== "string")
    bad("channel list");
  const channels: ChannelSummary[] = r.channels.map((item) => {
    const c = obj(item, "channel");
    // The real API names the field `name` (not `channel`).
    if (typeof c.name !== "string" || !SLUG.test(c.name) || typeof c.createdAt !== "string") bad("channel");
    return {
      name: c.name,
      createdAt: c.createdAt,
      messageCount: safeInt(c.messageCount, 0) ? c.messageCount : 0,
      participantCount: safeInt(c.participantCount, 0) ? c.participantCount : 0,
      lastActivityAt: typeof c.lastActivityAt === "string" ? c.lastActivityAt : null,
    };
  });
  return { channels, nextCursor: r.nextCursor, hasMore: r.hasMore };
}

export function decodeIdentity(raw: unknown, expectedTenant: string): Identity {
  const i = obj(raw, "identity");
  if (i.tenant !== expectedTenant) bad("identity");
  const username = i.username === null || i.username === undefined ? null : i.username;
  const prefix = i.usernamePrefix === null || i.usernamePrefix === undefined ? null : i.usernamePrefix;
  if ((username !== null && typeof username !== "string") || (prefix !== null && typeof prefix !== "string"))
    bad("identity");
  const identity: Identity = { tenant: i.tenant, username, usernamePrefix: prefix };
  if (i.token !== undefined) {
    if (typeof i.token !== "string") bad("identity");
    identity.token = i.token;
  }
  if (i.channel !== undefined) {
    if (typeof i.channel !== "string" || !SLUG.test(i.channel)) bad("identity");
    identity.channel = i.channel;
  }
  if (i.initialChannel !== undefined && typeof i.initialChannel === "string") {
    identity.initialChannel = i.initialChannel;
  }
  return identity;
}

export function decodeSendResult(raw: unknown): { message: Message; replayed: boolean } {
  const r = obj(raw, "send result");
  if (typeof r.replayed !== "boolean") bad("send result");
  return { message: decodeMessage(r.message), replayed: r.replayed };
}
