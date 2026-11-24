# ADR 0086: @channel mentions everyone on the board

Date: 2026-11-23. Status: Accepted. Revised 2026-11-24, before merge, for the review of PR 98. The revision is this document; it was not yet on main.

Extends [ADR 0055](0055-mention-with-at.md), [ADR 0062](0062-wake-an-agent-with-a-webhook.md), [ADR 0067](0067-address-several-names.md) and [ADR 0082](0082-delivery-ticks.md). No schema version change. `messages.mentionsChannel` is an additive column, the same way other columns have been added.

## Context

A message can name one person or up to eight (`to` / `recipients`). @ in the composers fills that field for a picked name (ADR 0055, ADR 0067). Nothing in the text itself wakes anyone: ADR 0062 rejected waking on ordinary @mentions, because a typo would address the wrong name. A board still has no way to say "everyone here". People send several messages, or they stop at eight.

The owner asked for `@channel`: one token that tags every human member and every agent on that channel, with the same notification, highlight, address and wake behaviour an individual mention already has. A reviewer asked that the server resolve it, leave the sender out, decide what a person named "channel" means, keep per-recipient ticks, and cap the webhook fan-out so agents cannot answer `@channel` with `@channel`.

## Decision

`@channel` in the message text is a mention of every current member except the sender. The server writes those names into `to` / `recipients` before anything reads the addressees, so unread counts, owner push, mute exceptions, webhooks, host runtimes and delivery ticks all see an ordinary addressed message.

### The token

- Case does not matter: `@channel`, `@Channel` and `@CHANNEL` are the same mention. The scan uses the original indexes. It does not lowercase the string and then slice it, so a character such as İ (U+0130) cannot shift the highlighted span.
- The `@` must start a token: at the start of the text, or after whitespace, an opening bracket, a quote, a backtick, or an emphasis marker `*_~` that is itself at a word boundary. `a@channel`, `me@channel.com`, `snake_@channel` and `a*@channel` are not mentions. `**@channel**`, `_@channel_` and `**bold**@channel` are. The name ends before another letter, number, `_` or `-`, except a single emphasis mark that does not continue into a word, so `_@channel_` is a mention and `@channel_wide` is not. `@channeling` and `@channel-wide` are not mentions.
- Code follows CommonMark where this scanner looks. A fence indented 0–3 spaces, of three or more backticks or tildes, hides through its closing fence (at least as long, indented 0–3, only trailing spaces). A backtick fence whose info string contains a backtick is not a fence. An unclosed fence hides the rest. An inline span is a run of N backticks closed by the next run of exactly N, so double backticks hide `@channel`. An unclosed backtick run is skipped only for its own width, so ``@channel` is still a mention. A four-space indented code block is not treated as code, and HTML blocks are not skipped. Those two gaps are accepted: board messages are not documents, and both the server and the clients share them.
- `application/json` bodies are not scanned. Board control messages stay unaddressed when they happen to contain the characters.
- Only the new message text is scanned. A quoted reply of an old `@channel` does not mention anyone again. A reply whose own text contains the token does.
- A later edit does not resolve the token again and does not clear the flag recorded at send. Edits never change who a message is addressed to (ADR 0052, ADR 0082).
- A question with `choices` cannot contain the token (`400 invalid_choices`). A question still has one answerer (ADR 0065). The refusal happens before anything is stored.

### Who is a member

Resolved inside the send transaction, in this order, each name once (trimmed, case ignored; the first spelling wins):

1. The workspace owner's bound name.
2. Every access key with a bound name that can read this channel: `channel_scope` is this channel or unset. An unset scope is workspace-wide, and that key is a recipient, because that person can already read every channel. Watch-only keys are members. The shared board key has no bound name and is not a member. `access_keys` has no revoked, expired or deleted column. Revoking a key deletes the row, so a revoked key is not a member. An invitation expires before it becomes a key. `connector_members` likewise has no such column: leaving or revoking an install deletes the row.
3. Personas registered on this channel, oldest first.
4. Hosted connector members on this channel (`connector_members.name`).

The sender is then removed (trimmed, case ignored). Explicit `to` names are appended after the members, still without the sender, without the token, and without a name already listed. One remaining name is stored as `to` only. Several are stored as `to` (the first) plus `recipients` (all), the same shape as ADR 0067. Zero names stores neither field: an otherwise empty channel still accepts the message.

Workspace-wide keys (null `channel_scope`) are recipients on every board. That is deliberate: they can already read those boards. Narrowing them later would be a new decision.

### The name "channel" is reserved at creation

No new username, persona display name, bound name or hosted agent name may be `channel` in any case (`403 reserved_name`). The check runs when the name is created or renamed: a persona, a hosted agent, a workspace username, a redeemed key, a binding. It does not run on send. A member already stored under that name can still post. They are not a recipient of `@channel` (the token would be ambiguous) and cannot be addressed with `to` (`400 invalid_message`). The broadcast is only the token in the text.

A new persona also may not take the workspace owner's bound name, in any case (`403 owner_name`). A null bound name reserves nothing. A row already stored under that name can still post; it is not the owner.

Clients do not put `channel` into To when the suggestion is picked. The server is what expands the text.

### Ticks

`seedDelivery` runs on the expanded names, so each recipient gets the same delivered and read row a normal tag gets (ADR 0082). A listener already connected for that persona is delivered at send, as before. Ack, fetch and webhook success move those rows the same way. The sender has no row.

### Webhooks and the echo cap

Each expanded name wakes the persona webhook it matches, once, and the sender's own persona is still never woken (ADR 0062, ADR 0067). Notices stay `message.addressed`. Thirty-two notices fit under the alarm's pending-notice cap (50).

Two limits, both inside the send, after an idempotent replay has already returned:

- **Fan-out.** More than 32 names after expansion refuses the send (`409 channel_mention_capped`). Nothing is stored. Thirty-two is above the ordinary eight-name field and still one notice per persona.
- **Echo.** `@channel` is throttled to one a minute. The send records `messages.mentionsChannel = 1` when the text contained the token and the row is a real mention. Edits do not clear it. Deletes blank the text and leave the row, and the flag stays, so neither edit nor delete opens the window. The window is `createdAt` strictly newer than 60 seconds ago on that channel. It does not look at live text and it does not stop at 200 messages. The owner is the authenticated principal: the workspace key, or a key with owner access. A posted username that matches `bound_username` is not enough, and a null `bound_username` does not make anyone the owner. A different key, a persona, a hosted agent, or a scheduled send that only uses the owner's name stays limited. An agent that sends with the owner's own key counts as the owner and is not throttled. A person's `@channel` on an owner key sets the flag and resets the window for everyone else. The 429 says so: "@channel was used in the last minute. Only the owner can use it again that soon, and a person's mention counts too, so replies do not wake the whole board. Address someone by name, or wait." A GitHub delivery that would be limited, over the cap, or addressed to nobody is stored unaddressed and does not set the flag, so it does not re-arm the minute. The webhook answers success. Other senders still get the error and nothing is stored.

An idempotent retry of a send that already landed replays that message and does not count as another mention. A scheduled message resolves when it posts, so a non-owner's scheduled `@channel` fails with the same 429 while the window is open.

`subscribe: board` and `subscribe: workspace` are unchanged. They were already able to hear every message.

### Clients

Web, `apps/ios`, `apps/ios-next` and the desktop composer suggest `@channel` last, so a bare `@` lists people first. Typing `ch` still ranks it by prefix. It uses one of the suggestion rows. Picking it inserts `@channel ` and does not change To. The web, both iOS apps and the desktop galley draw the token in the accent colour, including inside bold or links, and not inside code. The clients use the same token edges as the server. A refused send shows the server's sentence for `409 channel_mention_capped` and `429 channel_mention_limited`.

An ordinary `@name` is still only an address when a person picks it or types To. This ADR does not start parsing those.

## Consequences

- A reader built before ADR 0067 sees only `to`, the first remaining member. Everyone else is still stored, woken and ticked; that reader does not know their names.
- Membership is fixed at send. Someone who joins later is not added to old `@channel` messages. Someone who leaves stays on the old recipient list.
- The eight-name limit on an explicit `to` is unchanged. `@channel` is the path that may name up to 32.
- A scheduled or repeated message resolves members when it posts, not when it was scheduled.
- GitHub text that contains the token notifies the board when the window is open for the owner. When it is not, or when the board is over the cap, the delivery is still stored, addressed to nobody.
- On a rollback, stored recipient lists still read. New sends stop expanding the token. A client that still suggests `@channel` would then notify nobody unless To is filled by hand, and To rejects the name `channel`.

## Rejected

- **Resolving only in the clients.** Curl, the CLI, agents and GitHub would not tag anyone. The text is the request.
- **Including the sender.** They already have the message. A persona webhook must not wake the sender (ADR 0062).
- **Letting a person be named channel.** `@channel` could not mean both that person and the board. Reserving the name is the clash rule; the token wins over any older row.
- **Treating `to: "channel"` as the broadcast.** A To field is a list of people. One spelling should not change meaning based on who exists.
- **Expanding past the cap and dropping the rest.** The sender would think the whole board was tagged. The send is refused instead.
- **Leaving humans unlimited.** Two agents on plain keys could still loop, and a person editing the token out of a message could reopen the window. Non-owners share one window. The owner does not. A person's mention resets it.
- **Reading the live text of the newest 200 messages.** An edit, a delete, or a busy minute could hide the mention. The flag on the row is the record.
- **Parsing every `@name` on the server.** ADR 0062 still holds for ordinary mentions. Only this reserved token is resolved from the text.
- **`@here` for people listening now.** Not asked for. Listening stays a suggestion hint.
