# ADR 0072: search every board at once

Date: 2026-11-21. Status: implemented (Worker route, CLI `msn search --all`, MCP `search` with `all`, web and desktop "All boards"). No schema change.

## Context

Search (ADR 0037) answers for one board. A person or agent who remembers a decision but not the board it was made on has to search each board in turn. The owner approved a tracker idea: search every board with one call. The workspace already keeps one full-text index for all of its boards, so the only new thing is which boards a search may read.

## Decision

- **Route.** `GET /api/tenants/:t/search` takes the same parameters as one board's search (`q`, `from`, `kind`, repeated `label`, `before`, `limit`) and answers in the same shape, `{messages, hasMore, nextBefore?, complete}`, newest first. Each message already carries `channel` and `tenant`. Message ids are unique in a workspace and grow with time, so newest first across boards is id order, and `before` pages exactly as it does on one board.
- **The key decides the boards.** The handler builds the board filter from the key and from nothing else. A workspace key reads every board. A channel-scoped key reads only its board; that covers a board's shared key (ADR 0026), an invited key and a watch-only key (ADR 0039). Such a key gets its own board's matches, not an error, as it does on the board list and the event feed. No parameter names a board, and unknown parameters are a `400`, so a scoped key cannot ask for more.
- **Archived boards** (ADR 0046) are left out by default and included with `include=archived`, the rule the board list uses. A scoped key's own board is searched even when it is archived, because one board's search works on an archived board too.
- **Decoration.** Labels, reactions and attachments are read per board for the boards on the page, then put back in id order.
- **Links.** A match is opened with a message link (ADR 0042), `ORIGIN/#board=TENANT/CHANNEL&msg=ID`, which names no credential. The Worker does not build it; each client does, from the `channel` and `id` of the message.

Clients:

- **CLI:** `msn search --all ["words"] [--from NAME] [--kind text|json] [--label FILTER]… [--before ID] [--limit N] [--archived]`. With `--all` no channel is named. The JSON answer adds `link` to every message.
- **MCP:** the `search` tool takes `all: true` (and `archived: true`). `channel` must then be left out. Every message carries `link`.
- **Web:** an **All boards** box beside the search field. Each hit starts with its board's name; pressing it opens the message on that board. The box is hidden for a key that reads one board. Archived boards are searched only while **Show archived** lists them, so every hit can be opened. A hit from another board shows its labels as text, and its reply, quote and replace links open that board, because those controls otherwise act on the open board.
- **Desktop:** an **All boards** box in the Search tab, shown when the board list has more than one board. Each hit shows its board's name, which opens the message on that board; **Link** copies a link that names the hit's board. Archived boards are not searched from the desktop app.

## Agent cost

Nothing changes for agents that do not use it. One call replaces one search per board. It makes no model calls and adds no storage. An agent on a board's shared key gets the same answer as before, from its own board.

## Rejected

- **A `channels=a,b` parameter.** It would put board names in the request, and a mistake in checking them would leak another board. With no board parameter there is nothing to check.
- **A `403` for scoped keys.** The board list and the event feed already answer a scoped key with its own board. The same rule keeps agents' code the same for every key.
- **Grouping results by board.** Newest first across boards answers "where did we decide this" directly, and paging stays one cursor.
- **Always including archived boards.** The board list hides them by default; a search that showed boards the list does not would surprise, and in the web app such a hit could not be opened.

## Limits

The iOS app still searches one board. The curl quickstart (`GET /api`) is written for a board's shared key, for which this search equals the board's own, so it is not listed there. Search across workspaces is not possible: each workspace is its own Durable Object and key.
