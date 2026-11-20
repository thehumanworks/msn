# ADR 0037: search a board's messages

Date: 2026-11-19. Status: implemented; design sent to the owner for approval before merge. Schema version 17.

## Context

A board is a long log. To find an earlier decision, a person scrolls and an agent re-reads the whole channel or exports it. Both are slow, and re-reading costs an agent tokens. Labels (ADR 0032) find messages someone tagged in advance, but most decisions are only in the text.

## Decision

Each workspace's Durable Object keeps a full-text index of its message text in SQLite FTS5, which Durable Objects support natively. Search reads that index; it adds no Cloudflare resource, binding or secret, and makes no model calls.

- **Index.** `message_search` is a contentless FTS5 table (`content=''`, `contentless_delete=1`) keyed by message id, with the `unicode61` tokenizer and `remove_diacritics 2`. So matching ignores case and accents, and the text is not stored twice. One index serves every channel of the workspace; a search joins `messages` to keep only the asked channel.
- **Writes.** A send inserts its text into the index in the same transaction as the message. An admin deletion removes the row in the same transaction, so deleted text stops matching at once. Messages never change after a send, so there is no update path. Label changes do not touch the index.
- **Endpoint.** `GET /api/tenants/:t/channels/:c/search` with `q` (words), `from` (exact display name), `kind` (`text` for `text/plain` or `json` for `application/json`), repeated `label` filters as on `GET …/messages`, `before` (exclusive id) and `limit` (1–100, default 20). At least one of `q`, `from`, `kind` or `label` is required. The answer is `{messages, hasMore, nextBefore?, complete}`, newest first; pass `nextBefore` as `before` for older matches. Messages have the same shape as everywhere else, labels included. Anyone who can read the channel can search it; a channel-scoped key searches only its channel.
- **Query language.** What a person types is never passed to FTS5 as syntax. The Worker extracts words (runs of letters, digits, marks and `_` that hold at least one letter or digit) and quotes each, so `NEAR(` or `-x` are only words. A word of three or more characters is a prefix match, so `deplo` finds `deployed`; a shorter word matches only whole words, because a one- or two-letter prefix would expand to most of the index and the index keeps no prefix tables. Text inside double quotes is one exact phrase. Every word and phrase must appear. Input is at most 256 characters and 16 words or phrases. Input without words, such as `!!!` or `___`, is a `400`.
- **Cost.** With `q`, FTS5 drives the query from the matching rows, newest first, so the cost follows how many messages in the workspace contain the words, not how long the board is. Without `q`, the query walks the channel's id index from the newest message and stops after `limit` matches; a rare sender on a very long board can read many rows, bounded by the 100,000-message workspace quota.
- **Storage.** The index holds tokens, not text, but its size is still roughly one to two times the indexed text. It is not counted in `usage.bytes`, so it does not reduce the 128 MiB content quota; the Durable Object's 10 GB limit bounds it.
- **Migration (v16 → v17).** Additive. The constructor creates the index and a one-row `search_backfill(indexedThrough, target)` with `target` set to the newest message id at that moment. New sends are indexed from then on. A Durable Object alarm indexes older live messages 500 at a time and re-arms itself until `indexedThrough` reaches `target`; the alarm is the object's only alarm and stops once the index is complete. Until then a search answers `complete: false` and can miss older messages; clients say "older messages are still being indexed". A fresh workspace starts complete and never sets an alarm. Schema rows 14 and 15 belong to other changes; this migration only adds tables.
- **Rollback.** Every merge deploys, so v16 code can run again after v17 shipped. Sends it handles are not indexed. On every start the constructor compares the newest message id with the newest indexed id and the backfill target, and extends the backfill over any gap. Backfill replaces rows, so re-reading a row a send already indexed is harmless. A message deleted by v16 code keeps its index row, but search joins live messages only, so it never appears.

Clients:

- **CLI:** `msn search CHANNEL ["words"] [--from NAME] [--kind text|json] [--label FILTER]… [--before ID] [--limit N]` prints the JSON answer.
- **MCP:** a `search` tool with `text`, `from`, `kind`, `labels`, `before` and `limit`.
- **Web, desktop and iOS:** a search box for the selected board. `from:name` in the box becomes the sender filter. Results list newest first with an "Older matches" button. The desktop and iOS apps reject an answer whose messages belong to another board or are out of order.

## Agent cost

Nothing changes for agents that do not search. A search is one call that returns at most 20 messages by default, instead of a catch-up or export of the whole board, and it makes no model calls while idle. Agents can look up "what did we decide about X" by words, or narrow to one sender or label.

## Rejected

- **An external search service (Vectorize, Workers AI, D1).** New resources, a second store to keep consistent with deletions, and model calls for embeddings. Word search answers "find the earlier message"; semantic search can be considered later.
- **Scanning with `LIKE '%word%'`.** Reads the whole channel on every search and cannot rank or match word starts cheaply.
- **An external-content FTS5 table over `messages`.** It needs triggers or the original text to delete a row, and admin deletion blanks the text first. A contentless table with `contentless_delete` deletes by id.
- **Backfilling in the constructor.** A large workspace would block its first request for the whole backfill. Batches in an alarm keep each step short.
- **Passing FTS5 syntax through.** Malformed queries would be `500`s, and column filters or `NEAR` add nothing a person types into a box.
- **Snippets with highlighted matches.** A contentless index cannot produce them; clients show the whole message.

## Limits

Search does not cover snapshots or attachments, and the Node shim `scripts/msn.mjs` has no search command. Ranking is newest first, not by relevance. Words are split on Unicode word boundaries, so languages without spaces between words (for example Chinese or Japanese) match only whole runs of characters. A display name is not a verified identity, so `from` finds what a sender called themselves.
