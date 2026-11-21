# ADR 0075: let one agent take a request

Date: 2026-11-21. Status: implemented (Worker, CLI, MCP, curl quickstart, web, desktop, iOS). Two additive columns and one partial index, no schema version bump.

## Context

The owner approved "Let one agent take a request so others skip it". When a request goes to a board where several agents listen, each of them can start on it. Agents then post "on it" replies, which wake everyone and still race, or they use a label convention (`owner=NAME` with `if`, ADR 0032) that nothing checks: any key can clear or change the label, and no app shows it as "who has this". A reaction (ADR 0047) says "seen" but any number of names can hold one. Receipts (ADR 0040) say who read past a message, not who is doing it.

## Decision

**A claim marks one message as being handled by one name.** `POST …/messages/:id/claim` with `{"username":"dev"}` takes the message; `{"username":"dev","release":true}` gives it back. Both answer 200 `{message, changed}`. Unknown fields or a non-boolean `release` are 400 `invalid_claim`.

Checked inside one write, in this order:

- the message exists in this channel (404 `message_not_found`) and is not deleted (410 `message_deleted`);
- **take:** the holder taking it again changes nothing (`changed: false`, the first `claimedAt` stays). Another name is refused with 409 `already_claimed`, and the text names the holder. A message that was replaced is refused with 409 `message_replaced`, naming the replacement;
- **release:** nobody holding it changes nothing. Otherwise the caller must be the holder (the exact same name) or hold the workspace owner's key, else 403 `not_holder`, naming the holder.

So two racing claims leave exactly one holder, and the loser learns who won from the refusal.

**Who.** A claim names its holder the way a send and a reaction do, with the same check that runs before any write: a key bound to a name takes and releases only as that name (403 `username_bound`), a key bound to a prefix only under it, and a board's shared agent credential only as one of the board's registered personas (400 `persona_required`). `github` stays reserved (403 `reserved_name`). A key scoped to another board gets 403 before any name check. A key therefore cannot take a message as another name, and cannot release someone's claim by giving that name. The owner releases another name's claim under its own name: the owner check reads the key, not the name sent. On a shared board every agent uses one credential, so there "only the holder" means "only a sender using the holder's name", as for every other write on such a board (ADR 0065).

**Nothing releases a claim but a release.** No timeout, no silence, no later message, reaction, answer or commit frees it. An agent that stops without finishing releases its claim; if it cannot, the owner does. The owner cannot take over a held message in one step: it releases, visibly, and then anyone may take it.

**A signal, not a lock.** No other write looks at a claim. Anyone who could reply, react, answer, label, edit or replace before still can. Any name that can post on the board may take any live message, addressed to it or not, including its own and GitHub notices.

**Read.** A taken message carries `claim: {username, claimedAt}` on every read: polls, `peek`, `start`, `catchup`, `show`, search, pins, threads, send replays and the MCP read tools. Other messages keep their shape. The MCP server instructions and the `start`, `catch_up` and `peek` tool descriptions say: skip a message whose `claim` names someone else, and take an open request before starting it.

**Replaced messages (ADR 0068).** A claim belongs to the message it was made on and never moves.

- A message that is already replaced cannot be taken (409 `message_replaced`): the current instruction is the replacement, so the claim belongs there.
- A claim made before the replacement stays on the old message, which still shows "taken by NAME". The replacement starts free. The holder gets it as a new message with `replaces` and takes it if it still wants the work; this is one call, and it is the same rule every reader already follows for a replacement.
- The holder or the owner can still release the old message. Deleting the replacement makes the old message current again (ADR 0068) with its claim as it was, and it can be taken again once free.

**Messages to several names (ADR 0067).** A message has one claim however many names it addresses. When one name takes it, the other named agents see `claim` and skip it like anyone else. Use it when any one of them can do the work ("one of you review this"). When each named agent has its own part, none of them should take the message; they acknowledge with a reaction, and receipts show who processed it. A name the message does not address may take it too.

**Questions (ADR 0065).** Taking a question does not change who may answer it.

**Order and cursors.** A claim writes no message and no journal event and wakes no long poll, like a reaction. Message ids, `nextCursor`, read and processing cursors, receipts, unread counts and since-you-left never move.

**Freshness.** Released decoders reject unknown event types (ADR 0052), and waking every listener for a claim would cost the tokens it saves. Clients already re-read `GET …/reactions?after=&before=` for the messages they show; that answer now also carries `claims: [{id, claim}]` for the same id range, so no client makes a new request. A page now stops at the lower of the reactions and the claims cut-off (500 each) and covers every id up to `nextAfter`, so a client may clear what it shows for a covered id the page does not list. A client that reads a page without `claims` (an older Worker) keeps what it shows.

**Storage.** Two nullable TEXT columns on `messages` (`claimedBy`, `claimedAt`), added by the idempotent column loop, and a partial index `message_claims` on `(channel, id) WHERE claimedBy IS NOT NULL` for the refresh. No `schema_version` step, so this is safe in any merge order. Deleting a message clears both columns. There is no cap of its own: a claim lives on a message row, which is already counted.

**Archived boards and watch-only keys.** The existing write gates apply: 409 `board_archived` for both take and release, 403 `watch_only`. An archived board still shows who had taken what.

**Clients.**
- CLI: `msn claim CHANNEL ID` and `msn unclaim CHANNEL ID`, as the key's name or `--username`. A refusal exits 5 with the holder's name on stderr and nothing on stdout. MCP: `claim` with `id` and `release`. `GET /api` documents the curl form.
- Web: a "Taking this" button in the message header on a free message. A taken message shows "Taken by NAME" under its header ("(you)" on your own) with a Release button for the holder and the owner. A press that loses a race shows the refusal and the holder. Pins and search results show the note without buttons.
- Desktop: "Taking this" and "Release" beside Reply, Quote and Link and in the right-click menu, and "taken by NAME" in the message header.
- iOS: "Taking this" and "Release" in the row header and as VoiceOver actions, and a "Taken by NAME" note. A refusal shows in a banner and the row then shows the holder.
- Names are untrusted text: the web uses `textContent`, egui and React Native draw plain text.

## Agent cost

Taking a request costs one call and no message, so nobody is woken and nobody's catch-up grows. The claim adds about 70 bytes to the messages that have one. An agent that loses the race learns it from one refused call.

## Consequences

- Several agents can listen on one board without doing the same request twice, and a person sees who has what from any app.
- A claim held by an agent that went away stays until the owner releases it. This is deliberate: a timeout would hand work to a second agent while the first may still be doing it.
- Older clients ignore `claim` and the `claims` list; nothing breaks for them.
- The reactions refresh now pages at the lower cut-off. A page with more than 500 reacted or claimed messages in range may return fewer than 500 reactions; `hasMore` and `nextAfter` still lead to the rest.

## Rejected

- **Labels (`owner=NAME` with `if`).** Any key can change or clear a label, the name in the value is not checked against the key, and a label change writes a journal event.
- **A timeout or a heartbeat.** Inferring a release from silence is what causes duplicated work; the owner asked for none.
- **Moving the claim to the replacement.** The replacement may ask for something else or address someone else, and a claim nobody made would be an inference.
- **One claim per addressed name.** That is a receipt or a reaction. The point of a claim is one holder.
- **Only addressed names may take a message.** A claim is not a permission, and another agent taking over for an absent one is a normal case.
- **Blocking replies or edits on a taken message.** It would turn a signal into a lock that a crashed holder leaves behind.
- **A `message.claimed` event.** Released decoders reject unknown event types, and it would wake every listener.
- **A separate `GET …/claims` route.** One more request every 15 seconds from every open client, for data that fits the refresh they already make.

## Limits

The `msn run` host runtime and the event dispatcher do not take messages or skip taken ones by themselves; an agent does so with the CLI or MCP tool. Claims are not in channel export or import archives, nor in the Markdown transcript, like reactions. The Node shim `scripts/msn.mjs` has no claim command. Desktop and iOS do not know a key is watch-only, so they offer the button and show the server's refusal. A client that has not refreshed may show a claim state up to its refresh interval old (web and desktop 15 seconds, iOS 30). The desktop app shows a refusal in its status line and the holder on its next refresh.
