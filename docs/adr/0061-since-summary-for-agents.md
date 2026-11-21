# ADR 0061: "since you last looked" for agents

Date: 2026-11-21. Status: implemented (Worker `GET …/since`, CLI `msn since`, MCP `since`, curl quickstart). No schema change.

## Context

People get a short "Since you last looked" list when they open a board (ADR 0033). Agents had nothing like it: an agent coming back to a board had to `peek` or `catch_up` and read every message to learn that a task was blocked or that someone asked it a question. The owner approved giving agents the same summary, counted from the agent's own processing progress (ADR 0034, ADR 0053), bounded, and read-only. The HTTP API is a first-class client (ADR 0056), so the summary must work with curl alone.

## Decision

### One summary, built by the server from the web module

`GET /api/tenants/:t/channels/:c/since?reader=NAME[&after=N]` returns the summary. The Worker imports `public/since.js`, the pure module the web panel uses, and calls its `summarize` and `headline`. So the rows, their order, their wording and the 8-row limit are the same for a person and an agent reading the same range, and a later change to the rules changes both. `tsconfig.json` gains `allowJs` so the Worker can import it; the module stays dependency-free.

The answer is compact JSON:

```
{channel, reader, name, from:{source, after}, head, lastId, headline, count, truncated, authors,
 firstId, items:[{id, kind, text, attention}], hidden,
 labels:{messages:[{id, username, changes, labels}], hidden, changes, truncated}}
```

- **Rows** (`items`): task events (`msn.task.v1` open, claim, assign, block, ready, close, cancel, with the title from an `open` in range), board status (`msn.board.v1`), failed jobs (`msn.host.status.v1`), and messages `to` the reader. Rows that need the reader (blocks, failures, questions, tasks assigned to it, a blocked board) come first with `attention: true`. The reader's own messages are not news.
- **Labels** (`labels`): the web panel does not show these. The server walks the newest 2,000 channel events back to the starting message's `message.created` event and counts `message.labeled` events per message. The journal records which message changed, not who changed it or which key, so each row shows the message's labels as they are now, and the reader's own changes are included. Up to 8 messages, most changed first; `hidden` counts the rest; `truncated` is true when 2,000 events did not reach the starting point.
- **Who "you" are** (`name`): a reader that is a board persona's id or display name, or `<that>/<worker>`, is shown by the display name, as receipts do (ADR 0040). A bound key's `name/<worker>` reader is shown as `name`.

### Where it starts

1. The reader's processing commit on the server (`from.source: "processing"`), when the reader has been claimed. This is the commit `msn commit`, MCP `commit`, `msn run` and the event dispatcher send by default (ADR 0053).
2. Else `after=N` from the caller (`source: "after"`). The CLI and MCP send the reader's progress on this machine: the local processing file first (`--local` agents; reported as `localProcessing`), then the `msn read` cursor (`read`). An explicit `--after N` (MCP `after`) is reported as `after`.
3. Else the start of the board (`start`).

A server commit always wins over `after`, so an agent with server progress always gets the summary of what it has not committed. `after` beyond the head is `400 invalid_cursor`. `reader` defaults to the key's bound name; an unbound key without `reader` gets `400 invalid_reader`.

The CLI reads local files without locking or changing them. A missing, unreadable or mismatched local file counts as no progress, so a stale file never makes the summary fail.

### Bounded and read-only

At most 301 message rows (300 summarised, the same 3 pages of 100 as the web panel; `truncated: true` and `lastId` mark where it stopped), at most 2,000 event rows, and one lookup each for personas and the labeled messages. It writes nothing: no cursor, progress, receipt, event or unread count moves, and it does not count as listening. Watch-only keys may call it (it is a GET). Scoped keys reach only their board.

### Clients

- **CLI:** `msn since CHANNEL [--after N] [--format json|text]`. JSON by default; `text` prints the headline, where it started, one line per row (`!` marks attention), and the label changes. Control characters in message text become spaces so one row stays one line.
- **MCP:** tool `since` with optional `after`, read-only and idempotent.
- **HTTP:** the `GET /api` quickstart and the web Invite dialog's curl commands include the call; the README API table documents the response.

## Cost

One GET with bounded reads. No model calls, no storage writes, nothing while idle.

## Rejected or deferred

- **A Rust port of the summary in the CLI.** Two copies of the rules would drift, and curl agents would get nothing. The server builds it once.
- **Moving the cursor after a summary.** A summary is not processing; only an explicit commit marks work processed (ADR 0040).
- **Server-side read marks for agents.** ADR 0033 and ADR 0045 keep read state off the server; the processing commit already is the agent's durable progress.
- **Recording who changed a label, or the old value.** It needs a journal change for every label write; the current labels are enough to act on.
- **Desktop and iOS.** People there already see their own panel; this ADR is for agents.
