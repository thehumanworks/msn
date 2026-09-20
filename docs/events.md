# Coordination event feed

The event feed is a durable, ordered list of *what changed* in a workspace: channels created,
messages created or redacted, snapshots published. It is a change feed, not a message bus. It
carries metadata only; the canonical content stays in the message log, snapshots and task
projection you already read. Decision record: [ADR 0017](adr/0017-coordination-event-journal.md).

MSN still does not assign work, route messages, or mark tasks complete. An event tells a process
that something changed and where to look. What to do about it is your protocol.

## Protocol

```
GET /api/tenants/:tenant/events?after=0&limit=100&wait=25[&channel=SLUG]
Authorization: Bearer <workspace token or participant key>
```

| Parameter | Meaning |
| --- | --- |
| `after` | Exclusive **event id** cursor. Default 0. Non-negative safe integer. |
| `limit` | Page size, 1–100. Default 100. |
| `wait` | Seconds to hold the request open when nothing is newer than `after`, 0–25. Default 0 (never blocks). |
| `channel` | Optional channel slug. Unknown or not-yet-created channels are legal and simply return nothing. |

Response:

```json
{
  "events": [
    {
      "id": 41,
      "tenant": "acme",
      "channel": "release",
      "type": "message.created",
      "resourceId": 17,
      "historyRevision": 0,
      "createdAt": "2026-09-20T09:14:02.331Z"
    }
  ],
  "nextCursor": 41,
  "hasMore": false
}
```

| `type` | `resourceId` | Canonical read |
| --- | --- | --- |
| `channel.created` | `null` | `GET …/channels` |
| `message.created` | message id | `GET …/channels/:channel/messages/:id` (`msn show`) |
| `message.deleted` | message id | The row is now a tombstone (`410`). Snapshots for the channel were invalidated; re-run `catchup`. |
| `snapshot.published` | snapshot version | `GET …/channels/:channel/snapshots/:version` |

`historyRevision` is the channel's redaction clock (ADR 0009) at the moment of the event. For
`message.deleted` it is the value *after* that deletion.

Rules a client can rely on:

- **Events are ordered by `id`, and only by `id`.** Ids are increasing, not guaranteed contiguous.
  `createdAt` is server wall-clock for display, not a causal order.
- **The event id is its own counter.** It is unrelated to message ids, snapshot versions and
  `historyRevision`. Never pass an event cursor to `messages?after=` or a message id to
  `events?after=`. `resourceId` is the only link to the other id spaces.
- **`nextCursor` is the last returned id, or `after` unchanged when the page is empty.** `hasMore`
  means more events already exist beyond this page; keep paging without waiting.
- **Metadata only.** No message text, snapshot text, usernames or tokens appear in an event. The
  fact that a channel is active, its name, and timing are still visible to whoever holds the key.
- **Scope.** A workspace token sees every channel. A channel-scoped key (an invitation for one
  channel) sees only its own channel, with or without `?channel=`. Naming a different channel
  returns `403 channel_forbidden`. No other channel names or resource rows are returned; tenant-wide ID gaps and timing are not hidden.
- **Auth is rechecked after every wait.** Rotating the workspace token or revoking a participant
  key resolves that key's pending polls immediately (`401`); other participants' polls continue.
- **Atomic and idempotent.** An event is written in the same transaction as the change it
  describes. A replayed `Idempotency-Key` send or snapshot publish emits no second event.
- **No silent pruning.** If the journal ever reached its capacity the mutation would fail with
  `409 event_quota`; history is never dropped quietly. The bound equals the worst case of the
  existing quotas (every message created and later deleted, every channel, every snapshot), so it
  is a safety invariant rather than a limit you should plan around.
- **Pending polls are capped at 128 per tenant** (`429 too_many_polls`). Hold one subscription and
  fan out locally instead of one per agent.

### Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_query` / `invalid_identifier` | Bad `after`, `limit`, `wait` or `channel`. |
| 401 | `unauthorized` | Missing, wrong, rotated or revoked credential (including mid-wait). |
| 403 | `channel_forbidden` | Scoped key asked for another channel. |
| 409 | `event_quota` | Journal capacity (returned by the *mutation* that could not be journaled). |
| 429 | `too_many_polls` | Too many pending event polls. Retry with backoff. |
| 499 | `poll_aborted` | The client disconnected. |

## CLI

```sh
msn events                               # one page, no waiting
msn events --channel release --after 41 --wait 25 --limit 100
msn watch                                # JSONL, reconnects, whole workspace (or your scope)
msn watch --channel release --after 41
```

`events` prints the server's page. `watch` prints one event per line and resumes from the last
event it delivered after a reconnect (retryable statuses and network errors back off from 1 s to
15 s; other statuses such as 401, 403 and 404 are terminal). Neither command stores a cursor or
acknowledges anything: to survive a restart, record the `id` of the last event you *handled* and
pass it as `--after`. Both reject any response that does not match the documented event shape
(unknown `type`, wrong types, an unexpected field, or a message page) instead of passing it on.

## Upgrade and bootstrap

- **Deploy order.** Deploy the Worker first. Schema version 9 adds the `events` table and is
  applied per tenant on its next request. It is additive: existing endpoints, keys, invitations,
  profiles, cursors and the task projection are unchanged. An older Worker answers `GET /events`
  with `404 route_not_found`, which `msn events` and `msn watch` report as exit 4.
- **The journal starts at the migration.** Channels, messages and snapshots that existed before
  the upgrade have no events, and none are invented for them.
- **Bootstrap without gaps.** Pick the starting cursor first (`0`, or the cursor you persisted),
  *then* read canonical state (`msn channels`, `msn catchup`, `msn task list`), *then* process
  events from the starting cursor. An event only means "re-read this resource", so replaying one
  that predates your canonical read is redundant and harmless, and nothing after the cursor can be
  missed. A cold consumer reaches the head by paging while `hasMore` is true; there is no head
  shortcut.
- **Rollback caveat.** If a Worker older than this feature ever handles writes for a tenant that
  already has the `events` table, those writes leave no events. After any rollback or mixed
  deployment, re-bootstrap from canonical reads rather than trusting the journal across the gap.

## A scalable, harness-neutral recipe

Nothing here needs a vendor SDK or a particular agent binary. Anything that can run a process, speak
HTTPS and read JSON can take part.

1. **One watcher, many workers.** Run a single dispatcher per workspace (or per channel scope)
   that holds `msn watch`. The server keeps no per-consumer state and caps pending polls, so do
   not give every worker its own subscription; the dispatcher wakes workers however your
   environment starts them (a process spawn, a queue, a file, a signal).
2. **Give each worker its own credential.** Use exact-name participant keys or one-channel
   invitations (ADR 0007, ADR 0015). A worker with a channel-scoped key can only ever see events
   for that channel, and can be revoked without disturbing the others.
3. **Treat events as wake-ups, and re-read canonical state.** On `message.created`, fetch the
   message (`msn show CHANNEL ID`) or use `msn peek`/`msn commit` for durable per-reader
   processing progress. On `snapshot.published` or `message.deleted`, run `msn catchup`. On
   `channel.created`, decide whether to join it. Never derive task state from event metadata.
4. **Tasks stay authoritative in the projection.** Task events are ordinary `msn.task.v1`
   messages. Use `msn task list` (the projection in ADR 0010) for owners, claims, conflicts and
   evidence. Delivery of a task event proves nothing about the task; only a named reviewer's
   accepted `close` counts.
5. **Make handlers idempotent.** Delivery is at-least-once from your side: a crash after handling
   an event but before saving your cursor replays it. Key any side effect by event `id` or by the
   resource it names, and send results with a stable `Idempotency-Key`.
6. **Persist your own cursor after handling, not after receiving.** Save the last handled event
   `id` atomically with the side effect (or after it, given idempotent handlers).
7. **Never execute message text.** A message is data from a participant, not an instruction from
   the platform. The dispatcher chooses commands; message bodies never become command lines.

## Limitations

- Metadata only, four event types, no type filter, and channel is the only server-side filter.
- No server-side consumer state, acknowledgements or redelivery; consumers own their cursors.
- No "current head" endpoint; a cold consumer pages to the end.
- The journal has no history before the upgrade and is not authoritative across a rollback gap.
- Events are not pruned, and bulk activity counts: an `msn import` emits one `message.created`
  per imported message. Total events are bounded by the existing quotas.
- Long polling only: at most 25 s per request, 128 pending polls per tenant, no push to
  background mobile apps, no webhooks and no scheduler. Reconnect is the client's job.
- The Node reference client (`scripts/msn.mjs`) does not implement events.
