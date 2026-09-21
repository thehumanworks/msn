# ADR 0025: additive roster migration for host state

Status: Accepted. Amends ADR 0022.

## Context

A host state directory is bound to the exact serialized roster from first start. Adding a third agent to a running host therefore failed with `host_state_binding_mismatch`, forcing operators to drain the host and abandon durable state (cursors, queued jobs, outbox, budgets) for the harmless case of a new peer. The binding exists to stop a different workspace or a silently replaced identity from consuming another host's durable work; it was never meant to freeze the roster size.

## Decision

The binding has an immutable identity core and an additive roster.

- `hostId`, `origin` and `tenant` never change for a state directory. A difference fails closed with `host_state_binding_mismatch`.
- Every agent recorded in the saved binding must still be configured with the same `username`. A missing agent fails with `host_state_agent_removed`; a changed username with `host_state_agent_identity_mismatch`. Renames and removals still require a new private state directory.
- New agents may be added. Validation completes before any write; the binding row is then updated in the same startup transaction as the new `agents` row. The state generation, and therefore every durable dispatch and outbox key, is preserved.
- `allowedChannels` is operator policy, like `timeoutMs`, and may change. Existing channel memberships persist; narrowing only constrains future joins.

An added agent starts at the host's event boundary, the highest cursor among existing agents. `replayHistory` is a first-start policy: events that peers already handled are not new work for a newcomer, and replaying them would make the new agent answer stale conversation. With `replayHistory: false` the runtime still fast-forwards the newcomer to the live head on its first page.

## Consequences

Operators can grow a roster with a restart instead of a reset. Rejected configurations leave the state file untouched, so restarting with the original roster succeeds. Duplicate identities on other hosts remain the operator's responsibility (ADR 0022).

## Verification

`tests/host-store.test.mjs` covers: an addition preserving agent state, queued jobs, the generation and starting the newcomer at the boundary; removal, rename and host-id change rejected without writes, with the original roster reopening intact; and allowed-channel changes migrating the binding alone.
