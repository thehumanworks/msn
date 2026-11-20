# Event-driven, harness-neutral agent dispatch

`event-runner.mjs` is an optional Node 22+ adapter between MSN's durable change feed and an **operator-selected local executable**. There are no model SDKs, agent binaries, provider credentials or model calls in MSN itself. An agent harness, a Python worker, a CI adapter and a human client use the same HTTP/message contracts.

```sh
# Build the Rust CLI and save an exact-name participant profile first.
msn --profile reviewer start collaboration
node scripts/event-runner.mjs --profile reviewer --channel collaboration \
  --state-file "$HOME/.local/state/msn/reviewer-events.json" \
  -- /absolute/path/to/trusted-handler --your-handler-option
```

Use one process/state file per origin + tenant + channel + participant identity. Multiple independently named participants fan out without consuming each other's messages. A selected profile replaces ambient connection/username variables. Without a profile, use `MSN_URL`, `MSN_WORKSPACE_TENANT`, `MSN_WORKSPACE_TOKEN`, and optionally `MSN_USERNAME` for a prefix/unbound key. HTTPS is required except localhost development. Access keys never appear in command-line flags or URLs.

## Dispatch contract

The server commits resource changes and metadata events atomically. The runner holds a bounded server long-poll, wakes on changes and fetches the current message referenced by `message.created`. It validates origin/tenant/channel identity, event ordering, safe integer cursors and canonical message identity. It ignores self-authored messages and, by default, messages not explicitly addressed with `to` to this identity. `--include-broadcast` is deliberate opt-in. Deleted/missing messages are skipped without restoring redacted payloads. Channel, snapshot and deletion notifications do not execute a handler.

The runner asks for edits (`include=edits`). When the sender edits a message the handler would have received (ADR 0052), the handler runs again with `event.type` `message.edited`, the message's new text and `editedAt`, a new idempotency key, and a `notice` field such as `Message 51 from planner was edited at …`. Act on what changed; the earlier dispatch is not undone. Edits move no cursor or receipt.

Only the executable and argv following `--` are runnable; neither message text nor any event field becomes a shell command. The runner uses `shell: false` and delivers a single JSON envelope to stdin:

```json
{
  "schema": "msn.dispatch.v1",
  "event": {"id": 14, "tenant": "team", "channel": "collaboration", "type": "message.created", "resourceId": 51, "historyRevision": 0, "createdAt": "2026-09-20T10:00:00.000Z"},
  "message": {"id": 51, "tenant": "team", "channel": "collaboration", "username": "planner", "to": "reviewer", "text": "Review task-42", "contentType": "text/plain", "correlationId": "task-42"},
  "identity": {"origin": "https://YOUR-WORKER.workers.dev", "tenant": "team", "channel": "collaboration", "username": "reviewer"},
  "idempotencyKey": "msn-event-<sha256>"
}
```

The handler receives the resolved `MSN_URL`, `MSN_WORKSPACE_TENANT`, `MSN_WORKSPACE_TOKEN`, `MSN_USERNAME`, `MSN_CHANNEL`, `MSN_EVENT_ID`, `MSN_MESSAGE_ID`, and `MSN_IDEMPOTENCY_KEY`. Stale profile/legacy connection selectors and `MSN_ADMIN_TOKEN` are removed. Other existing environment variables are inherited so an operator-selected harness can use its own configuration. The selected executable is trusted with the participant key; this is not a sandbox or a substitute for OS isolation. Channel content remains untrusted input to that executable.

Handlers must finish synchronously. A zero exit acknowledges **dispatch**, never evidence-based task completion. Nonzero exit retries up to `--attempts` (default 3, maximum 10). The default handler timeout is five minutes, configurable with `--handler-timeout-ms` up to one hour. Timeout or shutdown terminates the handler process group and leaves the event unacknowledged. Child stdout/stderr are suppressed to prevent accidental credential output; emit durable results through MSN, or use an independently secured diagnostic sink within your handler.

Use `MSN_IDEMPOTENCY_KEY` (plus a fixed short suffix when publishing distinct result/evidence/task messages) for side effects. It is bound to origin, tenant, channel, participant and event ID, and survives retries/restarts. An operation with no downstream idempotency contract may execute more than once: exactly-once side effects are not promised.

## Effective collaboration, not just notifications

1. A coordinator opens a task with acceptance criteria, dependencies, owner and an independent reviewer using `msn task open`. It sends an addressed assignment using `msn send --to WORKER --correlation-id TASK --key STABLE_ASSIGNMENT_KEY`.
2. The worker's handler inspects the canonical `msn task list` projection and referenced evidence before acting. Competing ownership, unmet dependencies, malformed events or missing evidence do not become permission to proceed. The existing task schema and reviewer authority remain unchanged.
3. The worker posts its result and `task ready` evidence with stable keys **before** returning zero. A failed handler leaves input replayable. The reviewer checks the acceptance criteria and closes the task explicitly or sends a directed correction. Transport delivery, acknowledgements and snapshots do not close tasks.
4. Only relevant directed messages activate a handler. Unrelated channel chatter does not spend model tokens. Review and downstream assignments use explicit task/correlation IDs instead of prose-based guessing. Re-entry uses `start`/catchup plus canonical task state, not a saved delivery cursor as proof of completed work.

Handlers should enforce their own per-task work/model budgets and authorization policy. This adapter bounds each invocation and retry sequence, but does not guarantee that independently configured agents cannot create a cross-agent feedback loop.

## Recovery and durability

The checkpoint is a separate versioned event cursor, not a message processing or delivery cursor. It is bound to server, tenant, channel and reader; foreign, malformed, symlink and non-monotonic state fails closed. Files use mode 0600; new directories use 0700. An exclusive lock prevents two active processes using the same checkpoint. Writes are file-synced, atomically renamed, and directory-synced before processing subsequent events. Remove a stale `.lock` only after verifying that its recorded process has stopped.

Cursor advancement happens only after each event's successful handling or deliberate filtering. A crash between a successful side effect and checkpoint persistence replays that input with the same idempotency key. Auth/permission failures stop dispatch. Retryable transport, 429 and 5xx failures reconnect with bounded exponential backoff without moving the cursor. Redirects are never followed. `--once` handles one bounded page and exits; continuous mode requires a positive server wait to avoid a tight poll loop.

The journal begins when the event-capable Worker is deployed: it does not fabricate events for earlier messages. Use `msn start` and the canonical task/message APIs to establish pre-upgrade context. Deploying code is separate from migrating/copying channel history. No Worker is deployed by this PR.

## Verification

`node --test tests/event-runner.test.mjs` runs real local HTTP servers and executable child processes. It covers explicit argv handling, directed-only dispatch, broadcast opt-in, self-message suppression, stable retry keys across restart, failed-event replay, independent stream bindings, exclusive locks, private files, symlink rejection, redaction, auth loss, foreign messages, malformed event continuation, handler timeout, SIGTERM, and redirect credential isolation. The suite is included in `bun run test`.

### Real Worker collaboration trial

`bun run test:dispatch` builds the Rust CLI and runs an isolated local Wrangler Worker with three separate participant keys. A planner opens and assigns a task; a generic Node worker handler verifies the canonical task, posts evidence and requests review; a second handler verifies that evidence and closes the task as its designated reviewer. The fixture stops and restarts the Worker, asserts identical durable event replay, resumes both independent checkpoints, and checks there are no duplicate side effects. It also verifies prompt wake-up of a pending 25-second event long-poll.

Observed fixture result on Ares: 3 participants, 2 handler dispatches, 6 messages, 7 metadata events, effective task state `closed`; restart replay identical, duplicate side effects 0. This is an isolated fixture, not a production deployment or a model-quality benchmark.
