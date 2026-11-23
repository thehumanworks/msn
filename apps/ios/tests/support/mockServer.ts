import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * In-memory stand-in for the Worker implementing the documented HTTP and events contract closely
 * enough to exercise the app's core end to end. It is a fixture, not a conformance suite: the real
 * Worker lives in the coordination branch and is exercised by tests/real-worker.integration.ts.
 */

export const TEST_TOKEN = "a".repeat(64);
export const SCOPED_TOKEN = "b".repeat(64);
const SCOPED_CHANNEL = "scoped";

type EventType = "channel.created" | "message.created" | "message.deleted" | "snapshot.published" | "status.changed";
export type MockEvent = {
  id: number;
  tenant: string;
  channel: string;
  type: EventType;
  resourceId: number | null;
  historyRevision: number;
  createdAt: string;
};

type StoredMessage = {
  id: number;
  channel: string;
  username: string;
  text: string;
  contentType: string;
  createdAt: string;
  key: string | null;
  digest: string;
  deleted: boolean;
  to?: string;
  recipients?: string[];
  replyTo?: number;
  /** Edits (ADR 0052): when, and the edit's place in the workspace's edit order. */
  editedAt?: string;
  editSeq?: number;
  /** Questions with buttons (ADR 0065). */
  choices?: string[];
  answer?: string;
  answered?: { id: number; choice: string; username: string; answeredAt: string };
  /** Replace an instruction (ADR 0068). */
  replaces?: number;
  replacedBy?: number;
};

type StoredSnapshot = { channel: string; version: number; text: string; coversThrough: number; invalidated: boolean };

export type MockServerHandle = {
  url: string;
  close: () => Promise<void>;
  messages: StoredMessage[];
  events: MockEvent[];
  requests: Array<{ method: string; path: string; query: string }>;
  /** Insert a message as another participant (emits message.created). */
  post: (channel: string, username: string, text: string, contentType?: string) => StoredMessage;
  /** Ask `to` a question with buttons (ADR 0065). */
  ask: (channel: string, username: string, text: string, to: string, choices: string[]) => StoredMessage;
  /** Answer a question as `username`, as another device would. */
  answer: (channel: string, username: string, question: number, choice: string) => StoredMessage;
  /** Redact a message (emits message.deleted, invalidates snapshots). */
  remove: (id: number) => void;
  publishSnapshot: (channel: string, text: string) => StoredSnapshot;
  createChannel: (channel: string) => void;
  /** Scheduled messages (ADR 0060); `deliverScheduled` posts every pending one now. */
  scheduled: Array<Record<string, unknown>>;
  deliverScheduled: () => void;
  /** Edit a stored message as its sender would (ADR 0052); sends no message or event. */
  editText: (id: number, text: string) => void;
  /** Reactions by message id (ADR 0047). Like the Worker, reacting sends no message or event. */
  reactions: Map<number, Record<string, string[]>>;
  /** Who holds which message (ADR 0075). Like the Worker, claiming sends no message or event. */
  claims: Map<number, { username: string; claimedAt: string }>;
  /** False makes GET …/reactions answer like a Worker from before ADR 0075: no `claims` list. */
  listsClaims: boolean;
  /** Set (or with null clear) a name's status (ADR 0064); emits status.changed like the Worker. */
  setStatus: (channel: string, name: string, text: string | null) => void;
  /** Pin or unpin a message (ADR 0038). Like the Worker, this sends no message or event. */
  setPin: (id: number, pinned: boolean) => void;
  /** Write a board's brief as its owner on another device (ADR 0074); posts the board notice. */
  setBrief: (channel: string, text: string) => void;
  /** Make the token stop working, waking any pending event poll (like rotation/revocation). */
  revoke: (token?: string) => void;
  /** Number of event polls currently held open. */
  pendingPolls: () => number;
  /** Fail the next N requests matching the predicate with the given status (or drop the connection). */
  fail: (match: (path: string, method: string) => boolean, times: number, status: number | "drop") => void;
  /** Hold the response to the next matching request until released. */
  hold: (match: (path: string, method: string) => boolean) => { release: () => void };
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

export async function startMockServer(): Promise<MockServerHandle> {
  const messages: StoredMessage[] = [];
  const events: MockEvent[] = [];
  const snapshots: StoredSnapshot[] = [];
  const pins = new Set<number>();
  const statuses = new Map<string, Map<string, { text: string; setAt: string; seq: number }>>();
  let statusSeq = 0;
  /** Board briefs (ADR 0074): every version per channel; the last is current, "" means removed. */
  const briefs = new Map<string, string[]>();
  const briefBody = (channel: string) => {
    const versions = briefs.get(channel) ?? [];
    const text = versions.at(-1) ?? "";
    return {
      channel,
      brief: text
        ? { version: versions.length, text, bytes: Buffer.byteLength(text), updatedAt: "2026-11-21T17:00:00.000Z", updatedBy: "owner" }
        : null,
      currentVersion: versions.length,
    };
  };
  const reactions = new Map<number, Record<string, string[]>>();
  const claims = new Map<number, { username: string; claimedAt: string }>();
  let listsClaims = true;
  let edits = 0;
  const scheduled: Array<Record<string, unknown>> = [];
  let scheduledSeq = 0;
  const editText = (id: number, text: string) => {
    const message = messages.find((m) => m.id === id);
    if (!message) return;
    message.text = text;
    message.editedAt = new Date().toISOString();
    message.editSeq = ++edits;
  };
  const pinnedRows = (channel: string) =>
    messages
      .filter((m) => m.channel === channel && !m.deleted && pins.has(m.id))
      .map((m) => ({ ...toMessage(m), pinnedAt: "2026-11-19T00:00:00.000Z", pinnedBy: "owner" }));
  const channels = new Map<string, string>();
  /** Archived boards (ADR 0046): hidden unless include=archived; every write is refused with 409. */
  const archived = new Map<string, string>();
  const requests: MockServerHandle["requests"] = [];
  const validTokens = new Set([TEST_TOKEN, SCOPED_TOKEN]);
  const waiters = new Set<{ wake: () => void }>();
  const failures: Array<{ match: (p: string, m: string) => boolean; times: number; status: number | "drop" }> = [];
  const holds: Array<{ match: (p: string, m: string) => boolean; gate: Promise<void> }> = [];
  let tenantName = "acme";
  let messageId = 0;
  let eventId = 0;
  const revision = new Map<string, number>();

  /** Like the Worker: a new version, announced by a board message that carries no text. */
  function writeBrief(channel: string, text: string): void {
    const versions = briefs.get(channel) ?? [];
    versions.push(text.trim() ? text : "");
    briefs.set(channel, versions);
    insert(
      channel,
      "board",
      JSON.stringify({ schema: "msn.brief.v1", version: versions.length, cleared: !text.trim() }),
      "application/json",
      null,
      "",
    );
  }

  function appendEvent(channel: string, type: EventType, resourceId: number | null): void {
    eventId += 1;
    events.push({
      id: eventId,
      tenant: tenantName,
      channel,
      type,
      resourceId,
      historyRevision: revision.get(channel) ?? 0,
      createdAt: new Date().toISOString(),
    });
    for (const waiter of [...waiters]) waiter.wake();
  }

  function ensureChannel(channel: string): boolean {
    if (channels.has(channel)) return false;
    channels.set(channel, new Date().toISOString());
    appendEvent(channel, "channel.created", null);
    return true;
  }

  function toMessage(m: StoredMessage) {
    return {
      id: m.id,
      tenant: tenantName,
      channel: m.channel,
      username: m.username,
      text: m.text,
      contentType: m.contentType,
      createdAt: m.createdAt,
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      ...(m.to ? { to: m.to } : {}),
      ...(m.recipients ? { recipients: m.recipients } : {}),
      ...(reactions.has(m.id) ? { reactions: reactions.get(m.id) } : {}),
      ...(claims.has(m.id) ? { claim: claims.get(m.id) } : {}),
      ...(m.editedAt ? { editedAt: m.editedAt } : {}),
      ...(m.choices ? { choices: m.choices } : {}),
      ...(m.answer ? { answer: m.answer } : {}),
      ...(m.answered ? { answered: m.answered } : {}),
      ...(m.replaces ? { replaces: m.replaces } : {}),
      ...(m.replacedBy ? { replacedBy: m.replacedBy } : {}),
    };
  }

  function insert(channel: string, username: string, text: string, contentType: string, key: string | null, digest: string, extra: { to?: string; recipients?: string[]; replyTo?: number; choices?: string[]; answer?: string; replaces?: number } = {}): StoredMessage {
    ensureChannel(channel);
    messageId += 1;
    const stored: StoredMessage = {
      id: messageId,
      channel,
      username,
      text,
      contentType,
      createdAt: new Date().toISOString(),
      key,
      digest,
      deleted: false,
      ...extra,
    };
    messages.push(stored);
    appendEvent(channel, "message.created", stored.id);
    return stored;
  }

  function live(channel: string, after: number): StoredMessage[] {
    return messages.filter((m) => m.channel === channel && !m.deleted && m.id > after);
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent) json(res, 500, { error: { code: "internal_error", message: String(error) } });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const method = req.method ?? "GET";
    requests.push({ method, path: url.pathname, query: url.search });

    const failure = failures.find((f) => f.times > 0 && f.match(url.pathname, method));
    if (failure) {
      failure.times -= 1;
      if (failure.status === "drop") return void req.socket.destroy();
      return json(res, failure.status, { error: { code: "injected", message: "Injected failure." } });
    }
    const hold = holds.find((h) => h.match(url.pathname, method));
    if (hold) {
      holds.splice(holds.indexOf(hold), 1);
      await hold.gate;
    }

    if (url.pathname.endsWith("/redirect-away")) {
      res.writeHead(302, { Location: `${url.searchParams.get("to")}/api/tenants/other` });
      return void res.end();
    }

    const match = /^\/api\/tenants\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) return json(res, 404, { error: { code: "route_not_found", message: "no" } });
    tenantName = match[1];
    const tenant = tenantName;
    const rest = (match[2] ?? "").split("/").filter(Boolean);

    if (!rest.length && method === "PUT") {
      const body = await readBody(req);
      if (body.channel) ensureChannel(String(body.channel));
      return json(res, 201, {
        tenant,
        token: TEST_TOKEN,
        username: body.username,
        usernamePrefix: null,
        ...(body.channel ? { initialChannel: body.channel } : {}),
      });
    }
    if (rest.join("/") === "invites/redeem" && method === "POST") {
      const body = await readBody(req);
      ensureChannel(SCOPED_CHANNEL);
      return json(res, 201, {
        tenant,
        token: SCOPED_TOKEN,
        username: body.username,
        usernamePrefix: null,
        channel: SCOPED_CHANNEL,
        keyId: "key-1",
      });
    }

    const auth = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (!validTokens.has(auth)) {
      return json(res, 401, { error: { code: "unauthorized", message: "Unknown tenant or invalid access key." } });
    }
    const scope = auth === SCOPED_TOKEN ? SCOPED_CHANNEL : null;
    const forbidden = (channel: string) => scope !== null && scope !== channel;

    if (!rest.length && method === "GET") {
      return json(res, 200, { tenant, username: null, usernamePrefix: null, ...(scope ? { channel: scope } : {}) });
    }

    if (rest[0] === "channels" && rest.length === 1 && method === "GET") {
      const list = [...channels.entries()]
        .filter(([name]) => scope === null || name === scope)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, createdAt]) => ({
          name,
          createdAt,
          messageCount: live(name, 0).length,
          participantCount: new Set(live(name, 0).map((m) => m.username)).size,
          lastActivityAt: live(name, 0).at(-1)?.createdAt ?? null,
          ...(archived.has(name) ? { archivedAt: archived.get(name) } : {}),
        }))
        .filter((c) => url.searchParams.get("include") === "archived" || !archived.has(c.name));
      const after = url.searchParams.get("after") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const page = list.filter((c) => c.name > after);
      const shown = page.slice(0, limit);
      return json(res, 200, { channels: shown, nextCursor: shown.at(-1)?.name ?? after, hasMore: page.length > limit });
    }

    if (rest[0] === "channels" && rest[1]) {
      const channel = rest[1];
      if (forbidden(channel)) return json(res, 403, { error: { code: "channel_forbidden", message: "Not granted." } });
      if (rest.length === 3 && rest[2] === "archive" && (method === "PUT" || method === "DELETE")) {
        if (scope !== null) return json(res, 403, { error: { code: "owner_required", message: "Owner only." } });
        if (method === "PUT") archived.set(channel, archived.get(channel) ?? new Date().toISOString());
        else archived.delete(channel);
        return json(res, 200, { channel, archived: archived.has(channel) });
      }
      if (method !== "GET" && archived.has(channel))
        return json(res, 409, { error: { code: "board_archived", message: `Board ${channel} is archived and read-only.` } });
      if (rest.length === 2 && method === "PUT") {
        const created = ensureChannel(channel);
        return json(res, created ? 201 : 200, { channel, created });
      }
      if (!channels.has(channel) && !(rest[2] === "messages" && method === "POST")) {
        return json(res, 404, { error: { code: "channel_not_found", message: "Channel not found." } });
      }
      if (rest[2] === "messages" && rest.length === 3) {
        if (method === "POST") {
          const body = await readBody(req);
          if (body.sendAt !== undefined) {
            const row = {
              id: ++scheduledSeq,
              channel,
              username: body.username,
              text: body.text,
              sendAt: body.sendAt,
              status: "pending",
              ...(body.to ? { to: body.to } : {}),
              ...(body.replyTo ? { replyTo: body.replyTo } : {}),
            };
            scheduled.push(row);
            return json(res, 201, { scheduled: row, replayed: false });
          }
          const key = (req.headers["idempotency-key"] as string | undefined) ?? null;
          const digest = JSON.stringify([body.username, body.text, body.to ?? null, body.replyTo ?? null]);
          const existing = key ? messages.find((m) => m.channel === channel && m.key === key) : undefined;
          if (existing) {
            if (existing.digest !== digest) {
              return json(res, 409, { error: { code: "idempotency_conflict", message: "Key used for different content." } });
            }
            return json(res, 200, { message: toMessage(existing), replayed: true });
          }
          // Answers (ADR 0065): only the addressed name, only a listed choice, only once.
          const question =
            body.answer !== undefined ? messages.find((m) => m.id === Number(body.replyTo) && m.channel === channel) : undefined;
          if (body.answer !== undefined) {
            if (!question?.choices?.includes(String(body.answer)))
              return json(res, 400, { error: { code: "invalid_answer", message: "Not one of the choices." } });
            if (question.to !== body.username)
              return json(res, 403, { error: { code: "not_addressed", message: `Only "${question.to}" can answer this question.` } });
            if (question.answered)
              return json(res, 409, { error: { code: "already_answered", message: "This question was already answered." } });
          }
          const stored = insert(channel, String(body.username), String(body.text), String(body.contentType ?? "text/plain"), key, digest, {
            ...(Array.isArray(body.to) ? { to: String(body.to[0]), recipients: body.to.map(String) } : body.to ? { to: String(body.to) } : {}),
            ...(body.replyTo ? { replyTo: Number(body.replyTo) } : {}),
            ...(Array.isArray(body.choices) ? { choices: body.choices.map(String) } : {}),
            ...(body.answer !== undefined ? { answer: String(body.answer) } : {}),
            ...(body.replaces !== undefined ? { replaces: Number(body.replaces) } : {}),
          });
          const replaced = stored.replaces ? messages.find((m) => m.id === stored.replaces) : undefined;
          if (replaced) replaced.replacedBy = stored.id;
          if (question)
            question.answered = { id: stored.id, choice: String(body.answer), username: stored.username, answeredAt: stored.createdAt };
          return json(res, 201, { message: toMessage(stored), replayed: false });
        }
        if (method === "GET") {
          const after = Number(url.searchParams.get("after") ?? "0");
          const limit = Number(url.searchParams.get("limit") ?? "100");
          const rows = live(channel, after);
          const shown = rows.slice(0, limit);
          return json(res, 200, {
            messages: shown.map(toMessage),
            nextCursor: shown.at(-1)?.id ?? after,
            hasMore: rows.length > limit,
          });
        }
      }
      if (rest[2] === "scheduled" && rest.length === 3 && method === "GET")
        return json(res, 200, { channel, scheduled: scheduled.filter((s) => s.channel === channel) });
      if (rest[2] === "scheduled" && rest.length === 4 && (method === "PATCH" || method === "DELETE")) {
        const index = scheduled.findIndex((s) => s.id === Number(rest[3]) && s.channel === channel);
        if (index < 0) return json(res, 404, { error: { code: "scheduled_not_found", message: "Gone." } });
        if (method === "DELETE") {
          scheduled.splice(index, 1);
          res.writeHead(204);
          res.end();
          return;
        }
        const body = await readBody(req);
        if (scheduled[index].username !== body.username)
          return json(res, 403, { error: { code: "not_sender", message: "Only the sender can change it." } });
        if (body.text !== undefined) scheduled[index].text = body.text;
        if (body.sendAt !== undefined) Object.assign(scheduled[index], { sendAt: body.sendAt, status: "pending" });
        return json(res, 200, { scheduled: scheduled[index] });
      }
      if (rest[2] === "edits" && rest.length === 3 && method === "GET") {
        const after = Number(url.searchParams.get("after") ?? 0);
        const rows = messages
          .filter((m) => m.channel === channel && !m.deleted && (m.editSeq ?? 0) > after)
          .sort((a, b) => (a.editSeq ?? 0) - (b.editSeq ?? 0));
        const cursor = Math.max(after, ...rows.map((m) => m.editSeq ?? 0));
        return json(res, 200, { edits: rows.map(toMessage), editCursor: cursor, hasMore: false });
      }
      if (rest[2] === "messages" && rest.length === 4 && method === "GET") {
        const message = messages.find((m) => m.id === Number(rest[3]) && m.channel === channel && !m.deleted);
        if (!message) return json(res, 404, { error: { code: "message_not_found", message: "Message not found." } });
        return json(res, 200, { message: toMessage(message), historyRevision: revision.get(channel) ?? 0 });
      }
      if (rest[2] === "messages" && rest.length === 4 && method === "PATCH") {
        const body = await readBody(req);
        const message = messages.find((m) => m.id === Number(rest[3]) && m.channel === channel && !m.deleted);
        if (!message) return json(res, 404, { error: { code: "message_not_found", message: "Message not found." } });
        if (message.username !== body.username)
          return json(res, 403, { error: { code: "not_sender", message: "Only the sender can edit a message." } });
        editText(message.id, String(body.text));
        return json(res, 200, { message: toMessage(message), changed: true });
      }
      if (rest[2] === "reactions" && rest.length === 3 && method === "GET") {
        const after = Number(url.searchParams.get("after") ?? 0);
        const rows = [...reactions]
          .filter(([id]) => id > after && messages.some((m) => m.id === id && m.channel === channel && !m.deleted))
          .sort(([a], [b]) => a - b)
          .map(([id, value]) => ({ id, reactions: value }));
        const held = [...claims]
          .filter(([id]) => id > after && messages.some((m) => m.id === id && m.channel === channel && !m.deleted))
          .sort(([a], [b]) => a - b)
          .map(([id, claim]) => ({ id, claim }));
        return json(res, 200, { reactions: rows, ...(listsClaims ? { claims: held } : {}), hasMore: false });
      }
      if (rest[2] === "messages" && rest[4] === "ack" && rest.length === 5 && method === "POST") {
        const message = messages.find((m) => m.id === Number(rest[3]) && m.channel === channel && !m.deleted);
        if (!message) return json(res, 404, { error: { code: "message_not_found", message: "Message not found." } });
        return json(res, 200, { message: toMessage(message), changed: true });
      }
      if (rest[2] === "messages" && rest[4] === "claim" && rest.length === 5 && method === "POST") {
        const body = await readBody(req);
        const id = Number(rest[3]);
        const message = messages.find((m) => m.id === id && m.channel === channel && !m.deleted);
        if (!message) return json(res, 404, { error: { code: "message_not_found", message: "Message not found." } });
        const holder = claims.get(id)?.username;
        if (body.release === true) {
          if (holder !== undefined && holder !== body.username && scope !== null)
            return json(res, 403, { error: { code: "not_holder", message: `Message ${id} is taken by "${holder}".` } });
          claims.delete(id);
        } else if (holder !== undefined && holder !== body.username) {
          return json(res, 409, {
            error: { code: "already_claimed", message: `Message ${id} is already taken by "${holder}".` },
          });
        } else if (holder === undefined) claims.set(id, { username: String(body.username), claimedAt: new Date().toISOString() });
        return json(res, 200, { message: toMessage(message), changed: true });
      }
      if (rest[2] === "messages" && rest[4] === "reactions" && rest.length === 5 && method === "POST") {
        const body = await readBody(req);
        const id = Number(rest[3]);
        const message = messages.find((m) => m.id === id && m.channel === channel && !m.deleted);
        if (!message) return json(res, 404, { error: { code: "message_not_found", message: "Message not found." } });
        const kind = String(body.kind);
        const current = { ...(reactions.get(id) ?? {}) };
        const names = (current[kind] ?? []).filter((name) => name !== body.username);
        if (body.remove !== true) names.push(String(body.username));
        if (names.length) current[kind] = names;
        else delete current[kind];
        if (Object.keys(current).length) reactions.set(id, current);
        else reactions.delete(id);
        return json(res, 200, { message: toMessage(message), changed: true });
      }
      if (rest[2] === "statuses" && rest.length === 3 && method === "GET") {
        const rows = [...(statuses.get(channel) ?? new Map()).entries()]
          .map(([name, value]) => ({ name, ...value }))
          .sort((a, b) => b.seq - a.seq);
        return json(res, 200, { channel, statuses: rows, statusSeq });
      }
      if (rest[2] === "brief" && rest.length === 3 && method === "GET") return json(res, 200, briefBody(channel));
      if (rest[2] === "brief" && rest.length === 3 && method === "PUT") {
        const body = await readBody(req);
        const versions = briefs.get(channel) ?? [];
        if (body.baseVersion !== versions.length)
          return json(res, 409, { error: { code: "brief_conflict", message: "Read the brief again." } });
        writeBrief(channel, String(body.text));
        return json(res, 201, { ...briefBody(channel), changed: true });
      }
      if (rest[2] === "pins" && rest.length === 3 && method === "GET") {
        return json(res, 200, { pins: pinnedRows(channel), limit: 10 });
      }
      if (rest[2] === "search" && rest.length === 3 && method === "GET") {
        // A plain substring match is enough to exercise the client; the Worker tests cover FTS5.
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const from = url.searchParams.get("from");
        const before = Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
        const limit = Number(url.searchParams.get("limit") ?? "20");
        const rows = live(channel, 0)
          .filter((m) => m.id < before && (!q || m.text.toLowerCase().includes(q)) && (!from || m.username === from))
          .reverse();
        const shown = rows.slice(0, limit);
        const hasMore = rows.length > limit;
        return json(res, 200, {
          messages: shown.map(toMessage),
          hasMore,
          ...(hasMore ? { nextBefore: shown.at(-1)!.id } : {}),
          complete: true,
        });
      }
      if (rest[2] === "catchup" && method === "GET") {
        const latest = snapshots.filter((s) => s.channel === channel && !s.invalidated).at(-1) ?? null;
        const explicitAfter = url.searchParams.get("after");
        const base = explicitAfter !== null ? Number(explicitAfter) : (latest?.coversThrough ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? "20");
        const head = messages.filter((m) => m.channel === channel).at(-1)?.id ?? 0;
        if (base > head) return json(res, 400, { error: { code: "invalid_cursor", message: "after exceeds head." } });
        const rows = live(channel, base);
        const shown = rows.slice(0, limit);
        return json(res, 200, {
          ...(explicitAfter === null ? { pinned: pinnedRows(channel), pinnedOmitted: 0 } : {}),
          snapshot:
            explicitAfter === null && latest
              ? { tenant, channel, version: latest.version, username: "asha", text: latest.text, coversThrough: latest.coversThrough, historyRevision: revision.get(channel) ?? 0, createdAt: new Date().toISOString(), invalidated: false }
              : null,
          snapshotVersion: snapshots.filter((s) => s.channel === channel).at(-1)?.version ?? 0,
          historyRevision: revision.get(channel) ?? 0,
          messages: shown.map(toMessage),
          nextCursor: shown.at(-1)?.id ?? base,
          hasMore: rows.length > limit,
          incomplete: rows.length > limit,
          headCursor: head,
          pendingMessages: rows.length,
          pendingBytes: 0,
          snapshotPendingMessages: rows.length,
          snapshotPendingBytes: 0,
          snapshotDue: !latest,
          snapshotDueReasons: latest ? [] : ["no_snapshot"],
          snapshotPolicy: { messageThreshold: 20, byteThreshold: 16384, maxAgeSeconds: 86400 },
          byteLimitReached: false,
        });
      }
      if (rest[2] === "snapshots" && rest.length === 4 && method === "GET") {
        const snapshot = snapshots.find((s) => s.channel === channel && s.version === Number(rest[3]));
        if (!snapshot) return json(res, 404, { error: { code: "snapshot_not_found", message: "Snapshot not found." } });
        if (snapshot.invalidated) return json(res, 410, { error: { code: "snapshot_invalidated", message: "Invalidated." } });
        return json(res, 200, {
          snapshot: { tenant, channel, version: snapshot.version, username: "asha", text: snapshot.text, coversThrough: snapshot.coversThrough, historyRevision: revision.get(channel) ?? 0, createdAt: new Date().toISOString(), invalidated: false },
          historyRevision: revision.get(channel) ?? 0,
        });
      }
    }

    // Unread counts (ADR 0045): the reader's own marks in, bounded counts out, nothing stored.
    if (rest[0] === "unread" && rest.length === 1 && method === "GET") {
      const me = url.searchParams.get("me") ?? "";
      const unread = url.searchParams.getAll("mark").map((value) => {
        const split = value.lastIndexOf(":");
        const channel = value.slice(0, split);
        const after = Number(value.slice(split + 1));
        const rows = live(channel, after).slice(0, 100);
        const others = rows.slice(0, 99).filter((m) => m.username !== me);
        const self = me.trim().toLowerCase();
        return {
          channel,
          after,
          count: others.length,
          toYou: others.filter((m) => m.to?.trim().toLowerCase() === self).length,
          ...(rows.length > 99 ? { capped: true } : {}),
        };
      });
      if (unread.some((u) => forbidden(u.channel)))
        return json(res, 403, { error: { code: "channel_forbidden", message: "Not granted." } });
      return json(res, 200, { unread, cap: 99 });
    }

    if (rest[0] === "events" && rest.length === 1 && method === "GET") {
      const filter = url.searchParams.get("channel");
      if (scope && filter && filter !== scope) return json(res, 403, { error: { code: "channel_forbidden", message: "Conflicting filter." } });
      const effective = scope ?? filter;
      const after = Number(url.searchParams.get("after") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const wait = Number(url.searchParams.get("wait") ?? "0");
      // Like the Worker, status.changed is only listed for include=statuses (ADR 0064).
      const statusesToo = url.searchParams.getAll("include").some((v) => v.split(",").includes("statuses"));
      const page = () =>
        events.filter(
          (e) =>
            e.id > after &&
            (!effective || e.channel === effective) &&
            (statusesToo || e.type !== "status.changed"),
        );
      const respond = () => {
        if (!validTokens.has(auth)) {
          return json(res, 401, { error: { code: "unauthorized", message: "Unknown tenant or invalid access key." } });
        }
        const rows = page();
        const shown = rows.slice(0, limit);
        json(res, 200, { events: shown, nextCursor: shown.at(-1)?.id ?? after, hasMore: rows.length > limit });
      };
      if (page().length || !wait) return respond();
      await new Promise<void>((resolve) => {
        const waiter = { wake: () => finish() };
        const timer = setTimeout(() => finish(), Math.min(wait * 1000, 400));
        const finish = () => {
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve();
        };
        waiters.add(waiter);
        req.on("close", finish);
      });
      if (!res.destroyed) respond();
      return;
    }

    json(res, 404, { error: { code: "route_not_found", message: "no route" } });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    messages,
    events,
    requests,
    reactions,
    claims,
    get listsClaims() {
      return listsClaims;
    },
    set listsClaims(value: boolean) {
      listsClaims = value;
    },
    editText: (id, text) => editText(id, text),
    setStatus: (channel, name, text) => {
      statusSeq += 1;
      const board = statuses.get(channel) ?? new Map();
      if (text === null) board.delete(name);
      else board.set(name, { text, setAt: new Date().toISOString(), seq: statusSeq });
      statuses.set(channel, board);
      appendEvent(channel, "status.changed", statusSeq);
    },
    scheduled,
    deliverScheduled: () => {
      for (const row of scheduled.splice(0))
        insert(String(row.channel), String(row.username), String(row.text), "text/plain", null, "", {});
    },
    setBrief: (channel, text) => writeBrief(channel, text),
    setPin: (id, pinned) => {
      if (pinned) pins.add(id);
      else pins.delete(id);
    },
    post: (channel, username, text, contentType = "text/plain") => insert(channel, username, text, contentType, null, ""),
    ask: (channel, username, text, to, choices) => insert(channel, username, text, "text/plain", null, "", { to, choices }),
    answer: (channel, username, question, choice) => {
      const stored = insert(channel, username, choice, "text/plain", null, "", { replyTo: question, answer: choice });
      const asked = messages.find((m) => m.id === question);
      if (asked && !asked.answered)
        asked.answered = { id: stored.id, choice, username, answeredAt: stored.createdAt };
      return stored;
    },
    remove: (id) => {
      const message = messages.find((m) => m.id === id);
      if (!message) return;
      message.deleted = true;
      message.text = "";
      message.username = "";
      // Deleting an answer reopens its question (ADR 0065).
      for (const asked of messages) if (asked.answered?.id === id) asked.answered = undefined;
      // Deleting a replacement links what it replaced to its own replacement, if any (ADR 0068).
      for (const old of messages) if (old.replacedBy === id) old.replacedBy = message.replacedBy;
      message.replaces = undefined;
      message.replacedBy = undefined;
      revision.set(message.channel, (revision.get(message.channel) ?? 0) + 1);
      for (const s of snapshots) if (s.channel === message.channel) s.invalidated = true;
      appendEvent(message.channel, "message.deleted", id);
    },
    publishSnapshot: (channel, text) => {
      const snapshot: StoredSnapshot = {
        channel,
        version: snapshots.filter((s) => s.channel === channel).length + 1,
        text,
        coversThrough: messages.filter((m) => m.channel === channel).at(-1)?.id ?? 0,
        invalidated: false,
      };
      snapshots.push(snapshot);
      appendEvent(channel, "snapshot.published", snapshot.version);
      return snapshot;
    },
    createChannel: (channel) => void ensureChannel(channel),
    revoke: (token) => {
      if (token) validTokens.delete(token);
      else validTokens.clear();
      for (const waiter of [...waiters]) waiter.wake();
    },
    pendingPolls: () => waiters.size,
    fail: (match, times, status) => void failures.push({ match, times, status }),
    hold: (match) => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      holds.push({ match, gate });
      return { release };
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
