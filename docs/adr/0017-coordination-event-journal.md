# ADR 0017: durable coordination event journal

- **Date:** 2026-09-20
- **Status:** Accepted
- **Extends:** ADRs 0007 (participant keys and reader isolation), 0009 (channel snapshots), 0010 (critical agent workflows, `msn.task.v1`). Preserves existing authentication, scoped invitations, profiles, processing cursors and canonical task authority/conflict/evidence semantics unchanged.

## Context

Multiple independent agent harnesses (any process able to speak HTTPS and read JSON, not a
specific vendor SDK) coordinate today by polling `GET …/channels/:channel/messages` and
`GET …/catchup`. Both are scoped to one channel's message log and only tell a caller "more
messages exist," never "a channel was created," "a message was redacted," or "a checkpoint was
published." A harness-neutral coordinator that wants a single cheap subscription across every
channel in a tenant — to notice new channels, redactions and snapshot publications as well as new
messages, without re-deriving that information by diffing repeated full-channel reads — has no
endpoint to call. Cloudflare Durable Objects with SQLite storage give each tenant its own
durably-backed, single-writer, transactional store, which is the same foundation the existing
message log, snapshots and invitations already use (current API and limits confirmed against
<https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/> and the Durable
Objects rules of thumb at
<https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/> on
2026-09-20).

Alternatives considered: a server-side periodic scan that diffs channel state on a timer (adds
latency, wastes CPU when idle, and is not "event-driven" as required); reusing the existing
message long-poll endpoint with a synthetic control channel (conflates coordination metadata with
user-authored channel content and its idempotency/quota rules); a per-harness webhook or push
mechanism (requires a public callback endpoint from every client, which most agent harnesses do
not have); backfilling historical channel/message/snapshot rows into the journal at migration time
(would require inventing invented `createdAt`/ordering for pre-migration history and silently
imply an ordering guarantee the server cannot actually prove).

## Decision

### Endpoint

`GET /api/tenants/:tenant/events?after=0&limit=100&wait=25[&channel=SLUG]` with
`Authorization: Bearer <token>`, under the same tenant-scoped auth as every other non-admin route.
Response: `{events: CoordinationEvent[], nextCursor: number, hasMore: boolean}`, where

```
CoordinationEvent = {
  id: number, tenant: string, channel: string,
  type: "channel.created" | "message.created" | "message.deleted" | "snapshot.published",
  resourceId: number | null, historyRevision: number, createdAt: string,
}
```

`resourceId` is the message id for `message.created`/`message.deleted`, the snapshot version for
`snapshot.published`, and `null` for `channel.created`. `id` is the event's own row in a
dedicated, tenant-scoped, monotonically increasing sequence — **a completely independent counter
from message ids, snapshot versions and any other resource id.** A cursor obtained from this
endpoint (`after`, `nextCursor`) is only ever compared against other event ids; it is never valid
input to `messages?after=` or vice versa, and the server does not coerce between the two spaces.
`limit` is 1–100 (default 100), `wait` is 0–25 seconds (default 0). Events carry **metadata only**:
no message text, snapshot text, usernames or tokens ever appear in an event row; a caller that
wants the content behind an event fetches it through the existing canonical endpoint
(`GET …/messages/:id`, `GET …/channels/:channel/snapshots/:version`, …).

### Scope, auth and long polling

An unscoped workspace token sees every channel unless `?channel=` narrows it. A channel-scoped
participant key (ADR 0007) always sees only its granted channel: with no `?channel=` filter the
server transparently restricts to the granted channel; a `?channel=` naming a *different* channel
is rejected with `403 channel_forbidden`. Scope is never satisfied by client-side filtering of an
unscoped response.

Long polling reuses the message endpoint's proven shape (`store.ts`'s `poll`): the SELECT and
waiter registration happen without an intervening `await`, so a write between them cannot produce
a lost wakeup. A waiter is woken exactly when a matching event is inserted (`wait=1..25`
subscribes; `wait=0` never blocks) — there is no periodic re-scan and no fixed-interval timer
anywhere in this path. Every wake, and every timeout, re-runs authorization before replying, so
token rotation or key revocation while a poll is pending resolves it immediately (typically with
`401`) instead of leaving it pending until the client's own timeout. An aborted request (client
disconnect) resolves its own poll with `499 poll_aborted` and releases the waiter slot; a
per-tenant cap (128 pending polls, matching the existing message-poll cap) protects the Durable
Object from unbounded concurrent waiters, `429 too_many_polls` when exceeded.

### Atomicity, idempotency and capacity

Every mutation that emits an event (channel creation — explicit or implicit via first send;
message send; admin message deletion; snapshot publish) inserts its canonical row and its event
row inside the same `transactionSync`: an event is never observable without its mutation having
committed, and a mutation that fails to journal its event (see capacity, below) rolls back
entirely rather than silently completing without an event. Idempotent replay (an `Idempotency-Key`
matching a stored send or a snapshot's own idempotency key) returns the original result without
re-inserting a canonical row and therefore without emitting a second event — exactly one event per
distinct mutation, matching the same replay semantics the message and snapshot endpoints already
guarantee.

The event table has a fail-closed capacity bound
(`MAX_MESSAGES * 2 + MAX_CHANNELS + MAX_SNAPSHOTS`, the exact worst case across every other
existing quota — every message created and later deleted, every channel, every snapshot). Reaching
it throws `409 event_quota` and aborts the whole mutation. There is no silent pruning of old
events: an operator who hits this ceiling gets a loud, actionable error rather than a journal that
quietly starts dropping history.

### Schema, upgrade and bootstrap

Schema version 9 adds the `events` table and a `(channel, id)` index; existing tenants migrate in
place on their next Durable Object restart, exactly like every prior schema step in `store.ts`'s
constructor. **The journal starts empty at the migration point.** Pre-migration channels,
messages and snapshots are not backfilled with synthetic events — there is no trustworthy
`createdAt`/ordering to invent for history the journal never observed, and pretending otherwise
would misrepresent an inferred timeline as a durable record. A harness bootstraps by choosing its
starting event cursor (`0` on first run, or its own previously persisted cursor) *before* reading
canonical state through the existing endpoints (`GET …/channels`, `GET …/catchup`, `GET
…/snapshots`), then replaying events from that cursor. Because an event only says "this
resource changed" and every reaction is a re-read of the canonical resource, replaying an event
that predates the canonical read is redundant but harmless, and no event after the cursor can be
missed. The server keeps no per-consumer state and offers no "current head" shortcut (an empty
page echoes `after` back as `nextCursor`), so a cold consumer reaches the head by paging with
`hasMore`. This bootstrap/replay recipe, and the full harness-neutral collaboration pattern built
on it, are documented in [`docs/events.md`](../events.md).

### CLI

`msn events [--channel C] [--after N] [--wait S] [--limit N]` makes one bounded request and prints
the page, mirroring `msn poll`. `msn watch [--channel C] [--after N]` long-polls in a loop
(`wait=25`, `limit=100` fixed each round, matching `msn follow`'s reconnect/backoff behavior) and
prints one JSON event per line as it arrives, reconnecting automatically on a retryable error and
resuming from the last delivered event id. Neither command writes a cursor file or otherwise
acknowledges processing: **transport delivery of an event — including a `msn.task.v1` event inside
a `message.created` row — never implies the referenced work was read, understood or completed.**
Both commands validate every response strictly against the `CoordinationEvent` shape and reject
(fail closed) anything that does not match — an unrecognized `type`, a wrong field type, or a
message-page shape mistakenly returned instead of an events page — rather than passing
questionable data through to a caller that might mistake it for real coordination state.

## Consequences

A harness-neutral coordinator (any process able to speak HTTPS/JSON; no vendor agent SDK or
harness-specific binary required) can hold one subscription per tenant instead of one poll loop
per channel, and can react to channel creation and redaction/snapshot events it previously had no
way to observe short of repeatedly diffing full channel lists. The event id space is a new
concept participants must not confuse with message ids, snapshot versions or `historyRevision`;
this ADR and `docs/events.md` call it out explicitly, and both the server (route-level filtering)
and the CLI (a dedicated `events` module, tested against a message-shaped body to prove it fails
closed) treat the two id spaces as structurally distinct rather than merely "usually different."
Operators upgrading from schema 8 get event visibility only for activity from the moment of
upgrade forward; recovering pre-upgrade history still requires the existing canonical reads. No
periodic scheduler or harness-specific integration was introduced anywhere in this feature.

## Validation and references

Worker tests (`tests/events.test.ts`) cover: schema migration preserves prior canonical state
while starting the journal empty; the journal persists across a Durable Object restart; atomic
mutation+event (message send, snapshot publish, admin delete all journal in the same transaction
as their canonical write); idempotent replay emits no duplicate event; a channel-filtered long
poll never wakes for another channel's activity and wakes immediately rather than on its timeout;
token rotation and participant-key revocation each abort only the poll(s) they invalidate; a
`message.deleted` event's JSON never contains the deleted message's text or username; the event id
and resource id spaces are independent (an `after` cursor equal to a message id does not select
that message's event); and the fail-closed capacity error rolls back its triggering mutation
instead of silently dropping the event. CLI unit tests (`cli/src/events.rs`) cover strict schema
validation, including rejecting a message-page body. CLI integration tests (`cli/tests/cli.rs`)
cover query construction, invalid `--wait`/`--limit`, `watch`'s reconnect/backoff and SIGINT
handling, matching the existing `poll`/`follow` coverage.
