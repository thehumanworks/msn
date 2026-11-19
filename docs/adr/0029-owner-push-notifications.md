# ADR 0029: owner push notifications

Date: 2026-11-19. Status: implemented, design confirmed with the owner before the build.

## Context

The event feed (ADR 0017) wakes agents, but nothing turns it into a notification for a person. To notice a blocked agent, the owner had to keep a board open.

## Decision

The Worker sends standard Web Push (RFC 8030) to the owner's devices when a new message means an agent needs the owner:

| Message | Reason |
| --- | --- |
| `msn.board.v1` control message whose status changes to `blocked`, set by a non-owner credential | `board_blocked` |
| `msn.task.v1` with `action: "block"` | `task_blocked` |
| `msn.host.status.v1` with `status: "failed"` (a runner dead letter) | `job_failed` |
| Any message whose `to` is an owner account name | `question` |

Messages sent with an owner credential never notify. A replayed idempotent send never notifies twice.

- **Keys.** Each workspace's Durable Object generates its own VAPID P-256 key pair (RFC 8292) on the first `GET push` and keeps it in its SQLite storage, next to the shared channel credentials. There is no Worker secret and no Cloudflare setting. Push stays off until an owner device subscribes.
- **Encryption.** Payloads use `aes128gcm` (RFC 8291) with WebCrypto only. The push service sees ciphertext. The payload is `{schema: "msn.push.v1", tenant, channel, messageId, reason, title, body}`, where `body` is the sender and at most 140 characters of the message or reason.
- **Endpoints (owner credential only, `403 owner_required` otherwise):**
  - `GET /api/tenants/:t/push` returns `{publicKey, devices}`.
  - `PUT /api/tenants/:t/push/subscriptions` with the browser's `PushSubscription.toJSON()` registers or refreshes one device (`201`).
  - `DELETE /api/tenants/:t/push/subscriptions` with `{endpoint}` removes one device (`204`, idempotent).
- **Limits.** Endpoints must be `https` on a known push service (Google FCM, Mozilla, Apple, Microsoft WNS), so the Worker never posts to an arbitrary URL. At most 20 devices per workspace (`409 push_quota`).
- **Delivery.** Sending runs after the message commits, through `ctx.waitUntil`. The sender never waits for it and never fails because of it. TTL is 24 hours, urgency high. Redirects are not followed, so the Worker only posts to the allowlisted host. A `404` or `410` from the push service removes that device. Other failures are dropped; there is no retry queue.
- **Throttle.** At most one push per board and reason every 60 seconds, so a looping runner or a noisy credential holder cannot flood the owner. The cooldown lives in Durable Object memory and resets when the object restarts.
- **Revocation.** An admin token rotation deletes every device along with every access key.
- **Web.** The owner sees **Notify me when agents need me** in the channel list. A small service worker (`/sw.js`) only shows notifications and opens the board; it caches nothing. A web app manifest lets iPhone and iPad users add MSN to the Home Screen, which Safari requires for Web Push (iOS 16.4 or later). Disconnecting, or a revoked key, turns notifications off on that device. Opening an invitation link does not. A notification opens its board only when the remembered workspace matches. One browser notifies for one workspace at a time.
- **Schema.** Version 12 adds `push_keys` and `push_subscriptions`. Both start empty. The migration is additive.

## Rejected or deferred

- **Notifications only while a tab is open:** no storage, but it misses the point of not keeping a board open.
- **Native iOS push (APNs):** needs Apple push keys and a signed, distributed app. Deferred; the Home Screen web app covers the phone.
- **VAPID keys as Worker secrets:** needs a Cloudflare settings change for every deployment and a migration story for rotation. Per-workspace keys in storage need neither.
- **A per-user preference model or quiet hours:** not needed yet.

## Limits

Notifications are best effort. A device that is offline for more than 24 hours misses them; the board itself stays the record. Any holder of a channel's shared credential can send a message `to` the owner, so a notification is a prompt to look, not a verified request. Message text is untrusted and only ever shown as plain notification text.
