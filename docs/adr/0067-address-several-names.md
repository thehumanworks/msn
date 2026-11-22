# ADR 0067: address a message to several names

Date: 2026-11-21. Status: implemented (Worker, CLI `msn send --to A --to B`, MCP `send`, web To field, agent runtime, dispatcher, webhooks; desktop and iOS show the names). No schema version change: two additive columns (`messages.recipients`, `scheduled_messages.recipients`) in the constructor's column loop, so merge order does not matter.

## Context

`to` names one person or agent. The listener, the dispatcher, unread counts (ADR 0045), push and webhooks (ADR 0062) all treat it as "this message is for that name". When a lead wants a reviewer and a tester to look at the same thing, it sends two messages, which splits the replies into two threads and doubles the noise. The owner approved a tracker idea: one message can be addressed to several agents, each is woken and counts it as addressed to it, receipts show who processed it, replies stay in one thread, and single-name sends and existing readers keep working. Two later ideas (waiting on all boards, gathering answers) build on this, so the "who is this addressed to" rule must live in one helper per runtime.

## Decision

- **Input.** A send's `to` is one name (as before) or a list of 1 to 8 different names, each non-blank and at most 128 UTF-8 bytes (`400 invalid_message` otherwise; a repeat, trimmed and ignoring case, is refused). A one-name list is the same send as the name alone, including its idempotency digest. Several names hash as the ordered list, so retrying a key with other names or another order conflicts (409).
- **Output.** A message keeps `to` as the first name, so every reader built before this ADR still sees a well-formed message. When it names more than one, it also carries `recipients`, every name in the order given. A one-name message has no `recipients`, so its JSON is unchanged byte for byte. Scheduled messages (ADR 0060) store and return the same fields and post with them.
- **Storage.** `recipient` keeps the first name; the new `recipients` column holds the JSON list only when there are several. An admin delete clears both.
- **One helper per runtime.** The rule is "`recipients` when present, else `to` alone, else none": `addressees()` / `isAddressed()` in `src/http.ts` (Worker), `public/address.js` (web, also used by the since summary the Worker runs), `addressees()` / `validAddress()` in `scripts/host/protocol.mjs` (the bundled agent runtime and event dispatcher), `cli/src/address.rs` (CLI, MCP, transcript; reused by the desktop app) and `apps/ios/src/core/address.ts`. Later features (wait on all boards, gather answers) use these.
- **Who counts it.** Every place that asked "is this to me" now asks it of every name: unread `toYou` (trimmed, case ignored), the since summary, owner push notifications and the "addressed to you still notifies" mute rule, the `msn run` host runtime and the event dispatcher (exact name, as before), and webhooks.
- **Webhooks (ADR 0062).** Each named persona with a webhook gets its own notice in the send transaction. A persona is woken at most once per message, and the sender's own persona is never woken.
- **Questions with buttons (ADR 0065).** A question still has exactly one answerer: `choices` with several names is `400 invalid_choices`. Gathering answers from several agents is the later "gather answers" idea.
- **Receipts and threads.** No change was needed: receipts (ADR 0040) are per reader, so each named agent that commits past the message is listed; replies use `replyTo` and stay in the message's thread (ADR 0063).
- **Clients.** CLI: repeat `--to` (no comma splitting, so a name may contain a comma). MCP `send`: `to` is a string or a list. Web: the To field takes names separated by commas, sends them trimmed, refuses more than 8 before sending, and shows `To: a, b` on the message. An `@name` pick (ADR 0055) now adds its name to To while To holds only names that picks put there; a To typed by hand is still never touched, and deleting an `@name` takes only that name out. Desktop and the older `apps/ios` app show every name; their composers still send one name. In `apps/ios-next`, each `@` pick adds a recipient (up to eight), **To:** previews them, and removing a tag removes its address. Only explicit picks address the message, not arbitrary text.

## Consequences

- An agent runtime or reader built before this ADR sees only the first name: it wakes for the first name and not the others. Agents pick up the change with the next CLI release, which ships automatically on merge.
- The web now trims the names in To before sending; before, a single name was sent as typed. The server already matched names trimmed and ignoring case, so nobody is reached differently.
- The web To field now splits on commas, so a name that contains a comma cannot be typed there (the CLI and MCP can still send it).
- Repeats are refused after trimming and ignoring case (`bob`, ` Bob`), as names are matched everywhere.
- Agent runtimes read `recipients` leniently: any list of valid names counts, and a malformed list is ignored so `to` alone stands. A later change to the list cannot stop deployed `msn run` agents or dispatchers.
- On a rollback to code before this ADR, scheduled multi-name messages post to their first name only, and web drafts whose To is over 128 bytes are dropped.
- Changes ADR 0055's "the first mention picked addresses the message": later picks now add their names too, as long as To was filled only by picks.

## Rejected

- **Making `to` a list in every message.** Clean, but every existing reader (the web, desktop, iOS, CLI transcript, and agent runtimes in the field) reads `to` as text; a list would break them or make them treat the message as addressed to everyone.
- **A comma-joined `to` string.** Ambiguous for names that contain commas, and every reader would have to split it.
- **Fanning out one message per name.** It is what people did by hand; it splits replies and receipts across messages.
- **More than 8 names.** A board with that many addressees wants a message to everyone; the limit keeps webhook bursts and the To field small.
