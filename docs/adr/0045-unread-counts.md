# ADR 0045: unread counts on the board list

Date: 2026-11-20. Status: implemented in the Worker, web, desktop and iOS. No schema change (main stays at v18).

## Context

People with several boards could not tell from the board list where new work was waiting, or where an agent had asked them something. The owner approved an idea: per board, show how many messages you have not read and how many of those are addressed to you (the optional `to` field), using the read position the apps already keep, with no new tracking from presence or silence.

## Decision

The client sends the read marks it keeps on the device; the Worker counts what is above each one and keeps nothing.

- **API.** `GET /api/tenants/:t/unread?me=<name>&mark=<channel>:<id>&mark=…` returns `{unread:[{channel,after,count,toYou,capped?}],cap:99}` in request order. 1–100 marks, each channel once; `me` at most 128 characters. Malformed input is `400 invalid_query`. A channel-scoped key gets `403 channel_forbidden` for any other board. It is a GET, so watch-only keys (ADR 0039) can use it.
- **What counts.** Live messages with an id above the mark, except those whose `username` is exactly `me` (your own messages are not news, as in ADR 0033). `toYou` counts those whose `to`, trimmed and case-folded, equals `me` the same way. Replies count like any message.
- **Cost bound.** Per board the Worker reads at most 100 rows from the existing `channel_messages(channel, deleted, id)` index (`ORDER BY id LIMIT 100`) and stops counting at 99; `capped: true` then shows as "99+". When some of those 100 rows are the reader's own, `count` is below 99 and `capped` still says there are more, so "N+" is a lower bound. A request reads at most 100 × 100 index rows whatever the history size. Nothing is written, so there is no migration and no stored read state.
- **Read marks.** Web keeps the ADR 0033 marks (`localStorage["msn.read.<workspace>"]`). Desktop and iOS had none, so they now keep the same kind of mark on the device: the newest message whose top reached the visible conversation while the window has focus (desktop) or the app is active (iOS), held just below a reply still folded away (ADR 0041). Desktop stores `$XDG_STATE_HOME/msn/<origin-hash>/<tenant>/desktop-read/<reader-hash>.json` (mode 0600, 200 boards). iOS keeps up to 100 marks in memory and writes one keychain item per identity, `msn.read.v1.<hash>`, holding the most recently read boards that fit in 1,800 bytes (expo-secure-store documents a 2,048-byte value limit; that is roughly 20 to 60 boards depending on name length). It is written only after the profile save succeeded, at most every 2 seconds; "Sign out and forget" drops any pending write and removes the item. Desktop writes its file at most every 2 seconds and on disconnect or exit, merging with what is on disk (the higher id per board wins), with the directory created 0700. Marks only move forward.
- **Which boards.** Only listed boards that have a mark on this device; a board never read here shows no count (it has no "where you stopped"). With more than 100, the most recently read win. The open board shows no count.
- **When counts load.** No new timer runs while idle. Web: when the board list loads, when the page becomes visible, on Back, and at most once a minute while the open board is polling and the page is visible. Desktop: only while the window has focus, at most once every 10 seconds, and only for the boards that changed (an event on another board, or the board just left); the whole list after it reloads. A background window asks nothing until focus returns. iOS: when the channel list opens (it is rebuilt each time you go back to it) and after list reloads caused by events, at most once every 30 seconds with one trailing request. An answer whose mark has moved since it was asked is not shown.
- **Display.** A muted count and an accent "@N" for messages to you. Web keeps the board's name as the button's accessible name and gives the count as its description; iOS adds it to the row's label; desktop shows it on hover.

## Agent cost

None. Agents send the same messages; nothing in the CLI, MCP tools or event feed changes.

## Rejected

- **Server-side read state** (a `PUT …/read` and a table): follows you across devices, but is the durable read state ADR 0007 and ADR 0033 left out, and needs a migration. Revisit if people ask for cross-device marks.
- **Counting from the channel list's `messageCount`:** that is a total, not a count above a mark, and gives nothing for "to you".
- **Counts for boards never opened on the device:** with no mark, every message would count and a new device would show "99+" everywhere.
- **Presence or silence as a read signal:** rejected by the owner for guarantees; only what reached the screen counts.

## Limits

Marks are per device, so reading on the phone does not clear the laptop's count. Counting stops at 99. A board renamed or deleted keeps its mark until it ages out. The desktop records a message as read once its top is on screen in a focused window, without checking that the window is not covered.
