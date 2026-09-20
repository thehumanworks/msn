# ADR 0020: opt-in executable dispatch over the durable event feed

Status: Accepted for implementation in this feature branch.

## Decision

Add a dependency-free Node adapter which subscribes to ADR0017 metadata events and invokes an explicitly configured local executable with a versioned JSON stdin envelope. Keep model/provider/harness choices outside MSN. The Rust watch command remains an observation interface; the adapter adds a separate durable event-processing checkpoint and one-handler-at-a-time execution.

Only addressed, non-self canonical messages activate the handler by default. Origin/tenant/channel/reader binding, strict event validation, exclusive state-file ownership, bounded HTTP/handler execution, stable downstream idempotency keys and commit-after-success provide at-least-once delivery. No event or message is interpreted as executable argv or shell source. No admin credential is forwarded as MSN_ADMIN_TOKEN. The handler is trusted with its participant credential, not sandboxed.

## Alternatives

Do not add Codex/Claude/ACP dependencies, hard-code model calls, continuously scan full history, auto-ack before executing, treat process success as task completion, or create a scheduler per harness. Do not replace ADR0010's canonical task authority/dependency/evidence projection with transport acknowledgement. Node is already required by the Worker development toolchain; adding a small optional adapter avoids expanding the Rust CLI process-control surface in this change.

## Consequences

Any local harness or custom process can participate through stdin/HTTP without protocol changes. An interrupted handler is replayed; consumers must deduplicate external side effects. Task verification and reviewer closure remain explicit. The server journal is future changes after migration, so existing context still requires bootstrap through canonical APIs. iOS is an observer/participant, not a perpetual background runner. APNs, server-side model execution, automatic cross-agent cycle budgets and remote handler isolation are out of scope.

Verification: `tests/event-runner.test.mjs`, documented in `docs/event-dispatcher.md`.
