# ADR 0076: choose what a webhook subscribes to

Date: 2026-11-22. Status: implemented (Worker, CLI, curl quickstart, web). Two additive columns (`webhooks.subscribe`, `webhook_notices.coalesce`), no schema version bump, so the merge order with other changes does not matter. Desktop and iOS show no webhook settings (as before, ADR 0062).

## Context

A persona webhook (ADR 0062) fires only for messages addressed to that persona. The owner asked for configuration: "while sending a notification if the agent is tagged is a good default, subscribing to channel wide and workspace wide messages should also be possible". In this repository a "channel" with a goal is a board, and the workspace is the tenant that holds the boards. The owner had also removed signing and made the bearer key optional to keep friction low; this change keeps both.

## Decision

- **One setting, three levels.** A webhook has `subscribe`: `addressed` (the default), `board` or `workspace`. Each level includes the one before: `board` adds every other message on the persona's board, `workspace` adds every message on every board of the workspace. It is one more optional field on the existing `PUT …/personas/ID/webhook`, `--subscribe LEVEL` on `msn persona webhook set`, and a **Send a notice for** choice in the web dialog. Reads return it. A webhook still needs only a URL.
- **Existing webhooks do not change.** The column defaults to `addressed`. A PUT replaces the whole webhook (ADR 0062), so a PUT without `subscribe` sets `addressed`, as a PUT without `bearer` removes the key.
- **The notice says why it was sent.** `type` is `message.addressed` when the message names the persona and `message.posted` otherwise. Notices gain `subscribe` (the webhook's level) and `personaChannel` (the persona's board); `channel` stays the board the message is on, so the two differ only for a `workspace` webhook on another board. The schema stays `msn.webhook.v1` because the fields are additive. A notice still holds ids only.
- **A persona's own messages never wake it**, on any board: the same persona, or a message sent under its exact display name. Without this, an agent that answers on a board it subscribes to would wake itself without end.
- **Addressed on other boards.** For a `workspace` webhook, a message on another board whose `to` equals the persona's name (trimmed, ignoring case) is `message.addressed`.
- **Volume: messages share a waiting notice.** A wide subscription could turn every message into a request. While a `message.posted` notice for the same webhook and board waits (not yet sent, or waiting for a retry), a new message on that board queues nothing: a notice is a hint and the receiver reads everything new from its cursor (ADR 0062, Limits). So a burst costs one notice, and a receiver that is down is retried with one notice per board on the usual schedule, not one per message. A notice that is being posted right now does not count: its receiver may have read the board before the new message was stored, so that message gets a notice of its own. The set of notices in flight is kept in the object's memory; if the object restarts mid-post, the row is still stored and is sent again after any message that shared it, so no message goes unannounced. `message.addressed` notices are never shared: one each, as before.
- **Narrowing drops what no longer applies.** A PUT that narrows the subscription deletes the waiting `message.posted` notices the new level does not cover.
- **Who may set it.** The owner account, as before. `workspace` is also refused (`403 channel_forbidden`) for any key that is held to one board, so a board-scoped key can never subscribe beyond its board.
- **Limits unchanged.** 100 webhooks per workspace, 50 waiting notices per webhook, 20 per alarm run, 5 attempts. Each send reads the board's webhooks plus the workspace-level ones, at most 100 rows.

## Security

Nothing new leaves the workspace: a `message.posted` notice has the same ids-only body. A `workspace` webhook does reveal, to the receiver the owner chose, that a message was posted on each board and its id, including boards the persona's agent holds no key for. It cannot read them without a key. Only the owner sets the level.

## Agent cost

None for the default. An agent on a wider subscription is woken more often and must read from its cursor on the notice's board; a `workspace` receiver needs a key that can read each board it is told about (a shared board key reads one board).

## Rejected

- **One notice per message for wide subscriptions.** Simple to explain, but a busy board would send a request per message, fill the 50-notice backlog while a receiver is down, and push out addressed notices.
- **A minimum interval between notices.** It delays the first notice after a quiet period for no gain; sharing a waiting notice already bounds a burst.
- **Filters by sender, label or text.** Not asked for; three levels cover the request. Filters can be added to the same field later.
- **A separate workspace-level webhook that belongs to no persona.** It needs new routes, a new place in each client and its own rule for whose messages to skip. Keeping the webhook on a persona reuses all of that, and the persona names whose own messages are skipped.
- **Putting the message text in wide notices.** Still refused, for the reasons in ADR 0062.

## Limits

Two agents that both subscribe to a board and both answer every message wake each other; the skip rule only covers a persona's own messages. `docs/agents.md` says so. Workspace notices for a board stop when the board is archived, because nothing can be posted there.
