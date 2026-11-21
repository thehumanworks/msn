# ADR 0071: gather answers from several agents

Date: 2026-11-21. Status: implemented (CLI `msn gather`, MCP `gather` and `wait_gather`). Client only: no Worker route, no schema change.

## Context

A lead that wants the same answer from several agents (an estimate, a go/no-go) can address one message to all of them since ADR 0067, but then has to read the thread and work out by hand who has replied. The owner approved a tracker idea: `msn gather CHANNEL "Estimate?" --to a --to b --to c` sends one question and waits until each named agent has replied in its thread, or until a timeout. It prints the answers keyed by name and lists who has not replied yet, based only on replies actually posted, never on silence. An MCP tool does the same.

## Decision

- **The question is a normal several-name send** (ADR 0067): `to` is the list of 1 to 8 names, with optional `replyTo`. Agents are woken by the usual rules and need nothing new to take part; they just reply.
- **An answer is a named agent's first reply anywhere in the question's thread** (ADR 0063), as that reply is now. The author must equal a name after trimming; case is not folded, because on a shared board `Planner` is another participant than `planner` (as ADR 0065 decides for answers). Later replies by the same agent do not change its answer, so the result does not depend on when gathering stops. Top-level messages, other threads and names not asked are ignored.
- **The asker's own replies never count.** Naming yourself is refused before anything is sent (CLI and MCP), and a question addressed to its asker by other means leaves that name pending.
- **Only posted replies count.** `pending` is exactly the names with no reply seen. Nothing is inferred from receipts, status or time.
- **Reading.** The client reads the question (`GET …/messages/ID`), then its thread (`GET …/messages?thread=ID&after=…&wait=…`), long-polling, and re-reads the question after each page to see a replacement. Once every name has a reply (or time is up), it re-reads each recorded reply (`GET …/messages/ID`) so the answer is current: edited text shows (`editedAt`), and a deleted reply no longer counts, the agent's next reply in the thread taking its place. The whole gather is rebuilt from the question each time, so resuming (`msn gather --question ID`, MCP `wait_gather`) needs no stored state. Reads stop at the deadline: full pages are read on only while time is left, and the CLI retries a failed read (429, 5xx, network) only until the deadline, then prints what it has and exits 2.
- **Replaced messages (ADR 0068).** A reply that its author replaces is followed along `replacedBy` (at most 16 links) to the newest message, wherever it was posted: its text is the answer, and `replaced` lists the older ids. Following `replacedBy` rather than matching `replaces` keeps working when a middle link is deleted, since the server then links the first message to the last. When the asker replaces the question, gathering stops and reports `replacedBy`: replies to the old question may answer something that changed, so they are not carried over, and the new question is gathered on its own (`--question NEW`). Only replies posted before the replacement count, so resuming an already replaced question gives the same answers.
- **Output.** `{question, names, complete, answers: {NAME: {username, messageId, text, createdAt, contentType?, editedAt?, replaced?}}, pending: [NAME], replacedBy?}`, keyed by the names as the question lists them. The CLI prints it and exits 0 when complete, 2 on `--timeout` (default 600 s, at most 86400) and 1 when the question was replaced; it prints what it has in every case, including on an interrupt. The MCP `gather` tool adds `message` and `idempotencyKey`, and waits at most 25 s per call; it builds the gather from the posted message, and any failure after the post returns the key, so a retry replays the question instead of asking twice.

## Consequences

- Works against any Worker that has ADR 0067; it uses only existing read routes.
- Each wait reads the thread from the question again, plus one read of the question per page and one per recorded reply before reporting; bounded by the thread's size and at most 8 names.
- An agent that posts "looking into it" before its estimate has answered with the first message. Agents are told to reply once and to replace the reply to change it (docs/agents.md).
- A deleted reply disappears from reads, so the name is pending again unless the agent replied again in the thread.
- A replacement posted outside the thread counts only through the reply it replaces; an agent that first answers outside the thread is not seen.

## Rejected

- **A server route that tracks answers.** More state and a schema change for something the existing reads already give.
- **Latest reply wins.** The result would change with timing; replacing the reply says "this supersedes" explicitly.
- **Following a replaced question automatically.** The new question may name other agents or ask something else; mixing answers to both would be wrong.
- **Questions with buttons for several names.** ADR 0065 keeps exactly one answerer per question; gather takes free-text replies.
