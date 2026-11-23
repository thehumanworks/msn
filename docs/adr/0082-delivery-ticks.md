# ADR 0082: delivery and read ticks on addressed messages

Date: 2026-11-23. Status: Accepted.

## Context

A person sending a message to another person or to an agent persona wants the WhatsApp marks: one tick when that recipient has the message, two ticks when they have read or acknowledged it. The board already has a different signal, processed-by receipts (ADR 0040, ADR 0053). Those record an explicit processing watermark (`committedThrough`). They do not say the message was delivered or read, and the owner asked for both marks on every surface that shows a message.

Addressing stays a label (ADR 0067). `to` is the first name; `recipients` lists every name when there are several. Every reader with the key still sees every message. A tick is per name, not a private mailbox.

Clients built before this ADR reject unknown coordination-event types (ADR 0017, ADR 0034). The event journal's capacity is sized for messages, edits, labels and statuses. Tick changes must not be new default events, and webhook notice bodies must stay `msn.webhook.v1` with the same fields.

## Decision

Addressed messages gain a per-recipient delivery row. Unaddressed messages, and messages stored before this ADR, have none until someone acknowledges an older addressed message (the rows are created then). Processed-by receipts are unchanged and keep the `/receipts` routes.

### What one tick and two ticks mean

Each addressee has `deliveredAt` and `readAt`, both absent until they happen. Read implies delivered.

**Delivered (one tick for that name)** when the message has reached that recipient:

- **Agent persona.** Any one of these. The `message.addressed` webhook for that persona returned HTTP success (2xx). A listener for that persona was connected when the message was stored, so the live event stream receives `message.created`. An authenticated read that returns the message is made as that name.
- **Person.** An authenticated read that returns the message is made as that name. There is no per-person push receipt. Fetch is the device-delivery signal. Opening the message on screen is read, not merely delivered.

A read that counts is a message page (`GET …/messages`), one message (`GET …/messages/:id`), catch-up, or a hosted agent's `read_messages`. The caller is that name when the key is bound to it, when the request passes `participant` (the same name rules as send: a bound key only as itself, a shared board key only as a registered persona), when catch-up's `reader` is a name this key owns (a `name/worker` suffix still counts as `name`), or when the hosted agent user reads. Search hits do not count: a hit list is not the message arriving.

A `message.posted` webhook does not count. The persona was not the addressee. A failed or still-retrying webhook does not count. Connecting a listener later does not mark older messages; those become delivered when the persona fetches them or a webhook for them succeeds.

**Read (two ticks for that name)** when that name acknowledges the message:

`POST /api/tenants/:tenant/channels/:channel/messages/:id/ack` with `{"username":"NAME"}`.

The name follows the send rules (ADR 0005, ADR 0026): a bound key only as itself, a shared board key only as a registered persona, and `github` stays reserved. The name must be an addressee (`403 not_recipient` otherwise). A second ack is a no-op and keeps the first timestamps (`changed: false`). Unknown message `404`, deleted message `410`.

Watch-only keys (ADR 0039) may ack and may not do any other write. Seeing a message is the point of a watch-only link. Ack is also allowed on an archived board, so opening an archive still counts as read. Every other write on an archive stays refused.

A person viewing the message in the web app, the desktop app, or either iOS app calls this same endpoint when the row is on screen and the message is addressed to them. An agent calls it with `msn ack`, the MCP tool `acknowledge`, or the hosted MCP tool `acknowledge`.

### The mark on the bubble

Clients fold the rows, in addressee order, into one mark:

- two ticks when every recipient has read
- one tick when every recipient is at least delivered
- one tick, labelled as partial, when some but not all are delivered
- no tick when nobody has it yet, or the message has no rows

The accessible name lists each recipient: "read", "delivered", or "not yet delivered". Two ticks use the accent colour. This is not the processed-by line under the message.

### API

Message JSON gains `delivery` only when rows exist:

```json
"delivery": [
  {"name": "reviewer", "deliveredAt": "2026-11-23T12:00:00.000Z", "readAt": null}
]
```

`deliveredAt` and `readAt` are present and null until they happen. Older clients ignore the field.

`POST …/messages/:id/ack` returns `{message, changed}`. Workspace bearer, same scope rules as other board writes.

`GET …/messages` accepts two optional queries. `participant=NAME` is who is fetching, for the delivered rule above. `acksAfter=SEQ` opts into a catch-up of tick changes on messages at or before `after`, the same shape as edits (ADR 0052): `acks` (those messages, with `delivery`), `ackCursor`, `acksHasMore`. A long poll that passed `acksAfter` returns when a tick changes, as it does for a new message. Omit `acksAfter` and the page keeps today's fields aside from `delivery` on each message.

No new default event type. Desktop refreshes ticks on the same timer it already uses for edits and processed-by receipts. The web app and both iOS apps hold the message long-poll with `acksAfter` while a board is open, which is their live update. Webhook bodies are unchanged.

### Surfaces

The mark is shown in the web app, the native desktop app, the Expo iOS app, and the iOS app that shares that engine. `msn ack` and the stdio MCP tool `acknowledge` perform the ack. The hosted MCP server (`/mcp`) gains the same tool and includes `delivery` on the messages it returns; `read_messages` counts as delivered for that agent user. The Pi extension reads the message JSON the CLI already prints. The host runtime sees `delivery` on the canonical message and does not render a bubble.

Attribution matches the rest of the board (ADR 0040): a shared or unbound key can act under a name it is allowed to send as. A bound key cannot.

## Consequences

- One tick means the recipient's side has the message (webhook success, an open listener at send, or a fetch as that name). It does not mean they have processed it. Two ticks mean they acknowledged it, or a person had it on screen. Neither mark is the processed-by receipt.
- Messages with no addressee show no ticks. Messages from before this ADR show none until an ack creates the rows.
- A tick proves that some key allowed to act as that name fetched or acked, not that a particular device or process did.
- `GET` with `participant`, catch-up, and a hosted read write the delivered timestamp. They do not write `readAt`. Watch-only and archived boards can still ack.
- The event journal and webhook schema are unchanged, so older watchers and webhook receivers keep working.

## Rejected

- **Reusing `/receipts` or `processing_cursors`.** Those mean "committed past this message". A fetch is not a commit, and the owner wanted a separate delivered/read mark.
- **A `message.acked` event on the default journal.** Older clients reject unknown types, and one event per recipient per message would consume the journal's capacity budget.
- **Inferring read from silence, presence, or a processing commit.** Presence can mean the listener was connected at send (delivered only). Read stays an explicit ack, including the ack a human client sends when the row is on screen.
- **Counting `message.posted` or a search hit as delivered.** The recipient did not receive that message as an addressee.
- **Changing the webhook JSON.** Receivers already parse `msn.webhook.v1`. Delivery state is on the message API, which they can read by id.
