# ADR 0044: mute a board's notifications

Date: 2026-11-20. Status: implemented (Worker, web, desktop, iOS, CLI). No schema version change.

## Context

Owner push notifications (ADR 0029) fire for every board in the workspace. A busy or noisy board (a long release, a looping runner) makes the owner turn notifications off everywhere, and then they miss the board that matters. The owner approved "Mute a board's notifications": each person can mute one board forever, for 1 hour or for 1 day, from web, desktop and iOS, plus `msn mute` and `msn unmute`.

## Decision

**What a mute does.** It holds back Web Push for one person and one board. Nothing else changes: messages keep arriving, the event feed, unread state and the board are untouched. A message whose `to` is that person's name still notifies, unless they also chose **mute everything**.

**Whose mute.** Push subscriptions belong to owner credentials (ADR 0029), so a mute belongs to the owner credential's account name (`bound_username`; an unbound legacy workspace token is the empty name). Every owner key and Access login of the same account shares the name, so a mute set on the phone holds on the laptop. Each device now records whose it is (`push_subscriptions.person`), set when the device registers. Devices registered before this change have no person and count as the workspace's own owner (`tenant.bound_username`), which is who registered them in an account workspace.

**Storage.** A `push_mutes` table keyed by `(person, channel)` with `until` (ISO time, `NULL` for forever) and `everything`. It is created with `CREATE TABLE IF NOT EXISTS`, and `person` joins the idempotent column loop, so the change needs no `schema_version` step (pin messages takes v18 in an open change, and nothing here needs a one-time step). Mutes survive an admin token rotation, which removes devices but not preferences.

**Expiry at send time.** `notifyOwner` reads each device's person's mute for the board when a message needs the owner, and compares `until` with the current time. Nothing runs while idle: no alarm, no sweep. Expired rows are ignored by reads and deleted the next time that person sets a mute.

**Throttle.** The existing cooldown (one push per board and reason per 60 seconds) is checked after muted devices are removed. A message every device has muted therefore does not use up the cooldown for a later message someone does hear.

**API (owner credential only, `403 owner_required` otherwise).**
- `GET /api/tenants/:t/push/mutes` returns `{mutes: [{channel, until, everything}]}`, the caller's mutes that have not expired.
- `PUT /api/tenants/:t/push/mutes/:channel` with `{for?: "1h" | "1d", everything?: boolean}` sets or replaces the mute and returns it. Leaving out `for` (or sending no body) mutes until unmuted. Other values give `400 invalid_mute`; an unknown board gives `404 channel_not_found`.
- `DELETE /api/tenants/:t/push/mutes/:channel` turns notifications back on (`204`, idempotent).

**Clients.**
- Web: a **Mute** button in the board toolbar for the owner, which reads **Muted** or **Muted until 16:42** when a mute is active. Its dialog offers 1 hour, 1 day or until turned back on, a **Mute everything, including messages addressed to me** box, and **Turn notifications back on**.
- Desktop: the same choices in a **Mute** menu in the board header, shown only for an owner key. A non-owner key never asks, because a 403 would end the session.
- iOS: a **Mute** button in the channel header for an owner key opens the same choices inline. The native app does not receive Web Push itself (ADR 0029 deferred APNs); the mute applies to the owner's Home Screen web app and browsers.
- CLI: `msn mute CHANNEL [--for 1h|1d] [--everything] [--json]`, `msn mute` (list) and `msn unmute CHANNEL`. A non-owner key exits 3.

## Rejected

- **Per-device mutes in the browser only:** no server state, but a phone would keep buzzing after muting on the laptop.
- **A scheduled clean-up of expired mutes:** an alarm that runs while idle, for rows that cost nothing to ignore.
- **Arbitrary durations:** 1 hour, 1 day and forever cover the pitch; more choices add UI on three clients for little gain.
- **Muting the event feed or unread counts:** agents and the board must keep seeing every message.

## Limits

A person is an account name, not a verified human: two people who share one owner account share their mutes. Clients show a mute's end time as the server reported it; a mute that ends while a board is open shows as active until the board is opened again or the page reloads, but the server has already stopped holding notifications back.
