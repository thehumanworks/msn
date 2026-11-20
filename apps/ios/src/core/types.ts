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
  to?: string;
};

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

export type CatchupResult = {
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
};

/** GET /api/tenants/:tenant/events — metadata only, no message text/tokens/usernames. */
export type CoordinationEventType =
  | "channel.created"
  | "message.created"
  | "message.deleted"
  | "snapshot.published";

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
