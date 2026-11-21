/**
 * Wire types for the msn HTTP contract. Kept in sync by hand with:
 *  - src/http.ts / src/store.ts (existing REST endpoints)
 *  - the events API contract described in docs/adr/0019-ios-client.md
 * Unset optional annotation fields are OMITTED by the server, never null.
 */

export type ContentType = "text/plain" | "application/json";

export type ApiErrorBody = {
  error: { code: string; message: string };
};

/** Message reactions (ADR 0047), in display order: ✓ done, 👀 seen, 👍 yes, ✗ no. */
export const REACTION_KINDS = ["done", "seen", "yes", "no"] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];
/** Who reacted with each kind, in the order they reacted. Kinds nobody used are absent. */
export type Reactions = Partial<Record<ReactionKind, string[]>>;

export type Message = {
  id: number;
  tenant: string;
  channel: string;
  username: string;
  text: string;
  contentType: ContentType;
  createdAt: string;
  replyTo?: number;
  correlationId?: string;
  /** The first name the message is addressed to. */
  to?: string;
  /** Every name, in order, when it is addressed to several (ADR 0067). */
  recipients?: string[];
  reactions?: Reactions;
  /** When the sender last edited the text (ADR 0052); absent when never edited. */
  editedAt?: string;
  /** A question's buttons (ADR 0065); only `to` may answer. */
  choices?: string[];
  /** The choice this reply picks from its replyTo question (ADR 0065). */
  answer?: string;
  /** The question's first answer (ADR 0065); absent until answered. */
  answered?: Answered;
  /** The exact name that may answer, resolved by the server when the question was asked. */
  answerer?: string;
  /** Your earlier message this one replaces (ADR 0068). */
  replaces?: number;
  /** The newer message that replaced this one (ADR 0068); absent until replaced. */
  replacedBy?: number;
};

/** Which reply answered a question, with what, by whom and when (ADR 0065). */
export type Answered = { id: number; choice: string; username: string; answeredAt: string };

/** One page of message search (ADR 0037), newest first. */
export type SearchPage = {
  messages: Message[];
  hasMore: boolean;
  /** Pass as `before` for older matches; present only when hasMore is true. */
  nextBefore?: number;
  /** False while the server is still indexing messages older than search. */
  complete: boolean;
};

export type MessagePage = {
  messages: Message[];
  nextCursor: number;
  hasMore: boolean;
};

export type Snapshot = {
  tenant: string;
  channel: string;
  version: number;
  username: string;
  text: string;
  coversThrough: number;
  historyRevision: number;
  createdAt: string;
  invalidated: boolean;
};

/** A pinned message (ADR 0038): the message plus when and by whom it was pinned. */
export type PinnedMessage = Message & { pinnedAt: string; pinnedBy?: string };

export type CatchupResult = {
  /** The board owner's pinned messages; only on a first page (no `after`). */
  pinned?: PinnedMessage[];
  pinnedOmitted?: number;
  snapshot: Snapshot | null;
  snapshotVersion: number;
  historyRevision: number;
  messages: Message[];
  nextCursor: number;
  hasMore: boolean;
  incomplete: boolean;
  headCursor: number;
  pendingMessages: number;
  pendingBytes: number;
  snapshotPendingMessages: number;
  snapshotPendingBytes: number;
  snapshotDue: boolean;
  snapshotDueReasons: string[];
  snapshotPolicy: { messageThreshold: number; byteThreshold: number; maxAgeSeconds: number };
  byteLimitReached: boolean;
};

export type ChannelSummary = {
  name: string;
  createdAt: string;
  messageCount: number;
  participantCount: number;
  lastActivityAt: string | null;
  /** Set on an archived board (ADR 0046): read only, listed only with include=archived. */
  archivedAt: string | null;
};

export type ChannelListResult = {
  channels: ChannelSummary[];
  nextCursor: string;
  hasMore: boolean;
};

export type Identity = {
  tenant: string;
  token?: string;
  username: string | null;
  usernamePrefix: string | null;
  channel?: string;
  initialChannel?: string;
  keyId?: string;
  /** The workspace owner's key: may mute boards (ADR 0044). */
  owner?: boolean;
};

/** GET /api/tenants/:tenant/events — metadata only, no message text/tokens/usernames. */
export type CoordinationEventType =
  | "channel.created"
  | "message.created"
  | "message.deleted"
  | "snapshot.published"
  /** An agent status changed (ADR 0064); resourceId is the change's sequence number. */
  | "status.changed";

/** What a name says it is doing on a board (ADR 0064): only what it said, never inferred. */
export type AgentStatus = { name: string; text: string; setAt: string };

export type CoordinationEvent = {
  id: number;
  tenant: string;
  channel: string;
  type: CoordinationEventType;
  resourceId: number | null;
  historyRevision: number;
  createdAt: string;
};

export type EventPage = {
  events: CoordinationEvent[];
  nextCursor: number;
  hasMore: boolean;
};

/**
 * msn.task.v1 task-activity envelope (ADR 0010). This is a raw, unauthoritative
 * log entry — NOT the effective/asserted state computed by cli/src/tasks.rs.
 */
export type TaskAction = "open" | "claim" | "assign" | "block" | "ready" | "close" | "cancel";

export type TaskEventBody = {
  schema: "msn.task.v1";
  task: string;
  action: TaskAction;
  title?: string;
  reviewer?: string;
  owner?: string;
  dependsOn?: string[];
  acceptance?: string;
  reason?: string;
  evidence?: number[];
};

/** One row in the read-only task activity timeline: the raw event plus its outer message context. */
export type TaskActivityEntry = {
  messageId: number;
  createdAt: string;
  actor: string;
  body: TaskEventBody;
};
