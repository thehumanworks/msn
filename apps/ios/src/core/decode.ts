import { ProtocolError } from "./errors.ts";
import type {
  AgentStatus,
  Answered,
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
  SearchPage,
  Snapshot,
  PinnedMessage,
  Claim,
  Delivery,
  Reactions,
} from "./types.ts";
import { REACTION_KINDS } from "./types.ts";
import { decodeClaim } from "./claims.ts";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EVENT_TYPES: ReadonlySet<string> = new Set([
  "channel.created",
  "message.created",
  "message.deleted",
  "snapshot.published",
  "status.changed",
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
  if (m.agentUserId != null && typeof m.agentUserId !== "string") bad("message");
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
  if (typeof m.agentUserId === "string" && m.agentUserId) message.agentUserId = m.agentUserId;
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
  // Several names (ADR 0067). A malformed list is dropped: `to` still names the first.
  if (Array.isArray(m.recipients) && m.recipients.length > 1 && m.recipients.every((n) => typeof n === "string"))
    message.recipients = m.recipients as string[];
  if (m.reactions !== undefined) {
    const reactions = decodeReactions(m.reactions);
    if (Object.keys(reactions).length) message.reactions = reactions;
  }
  if (m.editedAt !== undefined) {
    if (typeof m.editedAt !== "string") bad("message");
    message.editedAt = m.editedAt;
  }
  // Questions with buttons (ADR 0065).
  if (m.choices !== undefined) {
    if (!Array.isArray(m.choices) || m.choices.length < 2 || m.choices.some((c) => typeof c !== "string"))
      bad("message");
    message.choices = m.choices as string[];
  }
  if (m.answer !== undefined) {
    if (typeof m.answer !== "string") bad("message");
    message.answer = m.answer;
  }
  if (m.answered !== undefined) message.answered = decodeAnswered(m.answered);
  if (m.answerer !== undefined) {
    if (typeof m.answerer !== "string") bad("message");
    message.answerer = m.answerer;
  }
  // Replace an instruction (ADR 0068).
  if (m.replaces !== undefined) {
    if (!safeInt(m.replaces, 1)) bad("message");
    message.replaces = m.replaces;
  }
  if (m.replacedBy !== undefined) {
    if (!safeInt(m.replacedBy, 1)) bad("message");
    message.replacedBy = m.replacedBy;
  }
  // Take a request (ADR 0075). A malformed claim is dropped: the message still reads.
  const claim = decodeClaim(m.claim);
  if (claim) message.claim = claim;
  const delivery = decodeDelivery(m.delivery);
  if (delivery) message.delivery = delivery;
  return message;
}

/** Delivery rows (ADR 0082). A malformed list is dropped; the message still reads. */
function decodeDelivery(raw: unknown): Delivery[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rows: Delivery[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.name !== "string") continue;
    if (row.deliveredAt !== null && typeof row.deliveredAt !== "string") continue;
    if (row.readAt !== null && typeof row.readAt !== "string") continue;
    rows.push({
      name: row.name,
      deliveredAt: (row.deliveredAt as string | null) ?? null,
      readAt: (row.readAt as string | null) ?? null,
    });
  }
  return rows.length ? rows : undefined;
}

/** A question's answer record (ADR 0065). */
export function decodeAnswered(raw: unknown): Answered {
  const a = obj(raw, "answered");
  if (
    !safeInt(a.id, 1) ||
    typeof a.choice !== "string" ||
    typeof a.username !== "string" ||
    typeof a.answeredAt !== "string"
  )
    bad("answered");
  return { id: a.id, choice: a.choice, username: a.username, answeredAt: a.answeredAt };
}

/** Reactions (ADR 0047): known kinds only, each a list of names. A kind added later is ignored. */
export function decodeReactions(raw: unknown): Reactions {
  const r = obj(raw, "reactions");
  const reactions: Reactions = {};
  for (const kind of REACTION_KINDS) {
    const names = r[kind];
    if (names === undefined) continue;
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) bad("reactions");
    if (names.length) reactions[kind] = names as string[];
  }
  return reactions;
}

/** GET …/reactions: current reactions by message id, and where the next page starts. */
export function decodeReactionPage(raw: unknown): {
  reactions: Map<number, Reactions>;
  /** Who holds which message (ADR 0075); null when the server sent no list. */
  claims: Map<number, Claim> | null;
  nextAfter: number | null;
} {
  const page = obj(raw, "reaction page");
  if (!Array.isArray(page.reactions) || typeof page.hasMore !== "boolean") bad("reaction page");
  const reactions = new Map<number, Reactions>();
  for (const item of page.reactions as unknown[]) {
    const entry = obj(item, "reaction page");
    if (!safeInt(entry.id, 1)) bad("reaction page");
    reactions.set(entry.id, decodeReactions(entry.reactions));
  }
  if (page.hasMore && !safeInt(page.nextAfter, 1)) bad("reaction page");
  let claims: Map<number, Claim> | null = null;
  if (Array.isArray(page.claims)) {
    claims = new Map();
    for (const item of page.claims as unknown[]) {
      const entry = obj(item, "reaction page");
      if (!safeInt(entry.id, 1)) bad("reaction page");
      const claim = decodeClaim(entry.claim);
      // An entry that cannot be read says nothing about who holds the message. Report no list,
      // so the caller keeps what it shows instead of clearing a claim that may still stand.
      if (!claim) {
        claims = null;
        break;
      }
      claims.set(entry.id, claim);
    }
  }
  return { reactions, claims, nextAfter: page.hasMore ? (page.nextAfter as number) : null };
}

/** GET …/edits (ADR 0052): edited messages, oldest edit first, and the cursor to ask from next. */
export function decodeEditPage(raw: unknown): { edits: Message[]; editCursor: number; hasMore: boolean } {
  const page = obj(raw, "edit page");
  if (!Array.isArray(page.edits) || !safeInt(page.editCursor, 0) || typeof page.hasMore !== "boolean")
    bad("edit page");
  return {
    edits: (page.edits as unknown[]).map(decodeMessage),
    editCursor: page.editCursor as number,
    hasMore: page.hasMore as boolean,
  };
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
  const result: MessagePage = { messages, nextCursor: page.nextCursor, hasMore: page.hasMore };
  if (page.acks !== undefined) {
    if (!Array.isArray(page.acks) || !safeInt(page.ackCursor, 0) || typeof page.acksHasMore !== "boolean")
      bad("message page");
    result.acks = (page.acks as unknown[]).map(decodeMessage);
    result.ackCursor = page.ackCursor as number;
    result.acksHasMore = page.acksHasMore as boolean;
  }
  return result;
}

/** Search pages run newest first and must hold only the asked channel's messages. */
export function decodeSearchPage(raw: unknown, channel: string): SearchPage {
  const page = obj(raw, "search page");
  if (!Array.isArray(page.messages) || typeof page.hasMore !== "boolean") bad("search page");
  let previous = Number.MAX_SAFE_INTEGER + 1;
  const messages = (page.messages as unknown[]).map((item) => {
    const message = decodeMessage(item);
    if (message.channel !== channel || message.id >= previous) bad("search order");
    previous = message.id;
    return message;
  });
  const result: SearchPage = { messages, hasMore: page.hasMore, complete: page.complete !== false };
  if (page.hasMore) {
    if (!safeInt(page.nextBefore, 1)) bad("search cursor");
    result.nextBefore = page.nextBefore;
  }
  return result;
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

/** Agent statuses (ADR 0064): `{statuses:[{name,text,setAt}]}`, at most 200 per board. */
export function decodeStatuses(raw: unknown): AgentStatus[] {
  const body = obj(raw, "status list");
  if (!Array.isArray(body.statuses) || body.statuses.length > 200) bad("status list");
  return body.statuses.map((item) => {
    const s = obj(item, "status");
    if (typeof s.name !== "string" || !s.name) bad("status");
    if (typeof s.text !== "string" || !s.text) bad("status");
    if (typeof s.setAt !== "string" || Number.isNaN(Date.parse(s.setAt))) bad("status");
    return { name: s.name, text: s.text, setAt: s.setAt };
  });
}

/** Pinned messages (ADR 0038): same tenant and channel as the stream, in message order. */
export function decodePins(raw: unknown, tenant: string, channel: string): PinnedMessage[] {
  if (!Array.isArray(raw)) bad("pinned messages");
  let previous = 0;
  return raw.map((item) => {
    const message = decodeMessage(item);
    const pin = item as Record<string, unknown>;
    if (message.tenant !== tenant || message.channel !== channel || message.id <= previous)
      bad("pinned messages");
    if (typeof pin.pinnedAt !== "string") bad("pinned messages");
    if (pin.pinnedBy !== undefined && typeof pin.pinnedBy !== "string") bad("pinned messages");
    previous = message.id;
    return {
      ...message,
      pinnedAt: pin.pinnedAt,
      ...(typeof pin.pinnedBy === "string" ? { pinnedBy: pin.pinnedBy } : {}),
    };
  });
}

export function decodeCatchup(
  raw: unknown,
  after: number | undefined,
  stream?: { tenant: string; channel: string },
): CatchupResult {
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
  let pinned: PinnedMessage[] | undefined;
  if (c.pinned !== undefined) {
    // Pins lead only a first page, and must belong to the requested stream.
    if (after !== undefined || !stream) bad("catchup");
    pinned = decodePins(c.pinned, stream.tenant, stream.channel);
  }
  return {
    ...(pinned ? { pinned, pinnedOmitted: safeInt(c.pinnedOmitted, 0) ? c.pinnedOmitted : 0 } : {}),
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
      archivedAt: typeof c.archivedAt === "string" ? c.archivedAt : null,
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
  if (i.owner === true) identity.owner = true;
  if (i.watchOnly !== undefined && typeof i.watchOnly !== "boolean") bad("identity");
  if (i.watchOnly === true) identity.watchOnly = true;
  return identity;
}

export function decodeSendResult(raw: unknown): { message: Message; replayed: boolean } {
  const r = obj(raw, "send result");
  if (typeof r.replayed !== "boolean") bad("send result");
  return { message: decodeMessage(r.message), replayed: r.replayed };
}
