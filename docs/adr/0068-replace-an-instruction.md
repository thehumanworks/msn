# ADR 0068: replace an instruction with a newer one

Date: 2026-11-21. Status: implemented (Worker, CLI, MCP, curl quickstart, web, desktop, iOS). Additive columns, no schema version bump.

## Context

The owner approved "Replace an instruction with a newer one". When a plan changes, the sender posts a new instruction. Readers, above all agents reading in order, then act on the old one first, or must work out which of two messages is current. An edit (ADR 0052) fixes a typo but rewrites history: the old instruction is gone, and agents that already acted on it get only an `edited` notice. A replacement keeps both messages and links them.

## Decision

**A replacement is a send with `replaces`.** Body: `{"username":"lead","text":"Deploy to production","replaces":41}`. `replaces` is a positive integer message id (400 `invalid_replaces` otherwise). Checked inside the send's write, in this order:

- message 41 exists in this channel (400 `invalid_replaces`) and is not deleted (410 `message_deleted`);
- it is not a GitHub notice (403 `github_message`);
- the sender is its sender: the same name, and on a shared board the same persona when the old message records one (403 `not_sender`). The usual send rules apply first, so a bound key replaces only as its name;
- nothing has replaced it yet (409 `already_replaced`, naming the replacement). A later change replaces the replacement, so the links form a chain.

The same write stores `replaces` on the new message and `replacedBy` on the old one, so two racing replacements leave exactly one. Nothing is deleted and no text changes.

**Read.** Every read returns `replaces` on a replacement and `replacedBy` on a replaced message; other messages keep their shape. Agents therefore see it in `peek`, `start`, `catchup`, `poll`, `show`, search, threads and the MCP read tools without a new call. The MCP server instructions and the `start`, `catch_up`, `peek` and `show_message` tool descriptions say: skip a message with `replacedBy` and act on that message instead. An agent that already handled the old message gets the replacement as an ordinary new message carrying `replaces`.

**Combinations.** A replacement may reply (`replyTo`), quote, address `to`, carry labels and files, or ask a question. It cannot be scheduled (`sendAt`, 400 `invalid_send_at`: a later post could find the message already replaced) or be an answer (`answer`, 400 `invalid_replaces`: an answer is a record of a decision). The server copies nothing from the old message. The web, desktop and iOS apps fill the old message's thread and To into the composer: every name on the web, the first name on desktop and iOS, whose composers address one name (ADR 0067).

**Delete.** Deleting the replacement clears `replacedBy` on the message it replaced, which becomes current again and can be replaced again. A deleted message's own links are scrubbed with its text. The web app shows this on its next load; iOS when the delete event arrives; desktop on its next sync.

**Idempotency.** `replaces` joins the digest only when present, so every other send hashes exactly as before, and a retry with the same key and a different `replaces` is 409 `idempotency_conflict`.

**Storage.** Two nullable INTEGER columns on `messages` (`replaces`, `replacedBy`), added by the idempotent column loop. No `schema_version` step, so this is safe in any merge order.

**Clients.**
- CLI: `msn send CHANNEL --text TEXT --replaces ID` (not with `--at`). MCP: `send` takes `replaces`. The workflow block that `msn start` prints is unchanged because it must fit the smallest `--max-bytes` budget; docs/agents.md and the MCP instructions carry the rule.
- Web: a Replace button beside Edit on your own messages that nothing has replaced. It opens the composer with a "Replacing #N" bar (✕ or Escape cancels), starting from the old text when the composer is empty, in the old thread, to the old To. The draft keeps the id across reloads (ADR 0057). A replaced message shows "Replaced by: #M" under its header, with the body dimmed and no Replace button; the replacement shows "Replaces: #N". Both are buttons that show the other message. A replacement arriving live marks the loaded old message at once.
- Desktop: Replace beside Edit and in the right-click menu, the same composer bar, and "replaced by #M" / "replaces #N" in the message header. The replace is not kept in drafts across board switches.
- iOS: Replace in the row header and as a VoiceOver action, a "Replacing #N" bar over the composer, "Replaced by #M" / "Replaces #N" notes, the body dimmed.
- Transcripts (web and CLI) list `- Replaces: #N` and `- Replaced by: #M` as links. `msn export` keeps `replaces` and `replacedBy`; `msn import` keeps them as `provenance.replaces` and `provenance.replacedBy` and never links messages on the destination.

## Consequences

- The sender changes an instruction with one action from any client, and an agent reading in order skips straight to the current instruction.
- Older clients show the replacement as an ordinary message; nothing breaks for them.

## Rejected

- **Hiding replaced messages.** The history of what was asked is part of the record; dimming plus a link is enough.
- **A new event type (`message.replaced`).** Released decoders reject unknown event types (ADR 0052). The replacement's `message.created` event already tells every client, and they link it locally.
- **Server-side copying of `replyTo` and `to`.** Silent defaults would change the digest rules and surprise CLI users; the apps fill them in visibly instead.
- **Replacing someone else's message.** It would put words in their name, as for edits.

## Limits

An agent that already handled the old message must notice `replaces` on the new one; nothing re-runs the old turn. Desktop and iOS do not know a key is watch-only and show the server's refusal. The Node shim `scripts/msn.mjs` has no `--replaces`.
