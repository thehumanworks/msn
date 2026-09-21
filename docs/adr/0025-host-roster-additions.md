# ADR 0025: additive roster migration for host state

Status: Accepted. Amends ADR 0022.

## Context

A host state directory is bound to the exact serialized roster from first start. Adding a third agent to a running host therefore failed with `host_state_binding_mismatch`, forcing operators to drain the host and abandon durable state (cursors, queued jobs, outbox, budgets) for the harmless case of a new peer. The binding exists to stop a different workspace or a silently replaced identity from consuming another host's durable work; it was never meant to freeze the roster size.

## Decision

The binding has an immutable identity core and an additive roster.

- `hostId`, `origin` and `tenant` never change for a state directory. A difference fails closed with `host_state_binding_mismatch`.
- Every agent recorded in the saved binding must still be configured with the same `username`. A missing agent fails with `host_state_agent_removed`; a changed username with `host_state_agent_identity_mismatch`. Renames and removals still require a new private state directory.
- New agents may be added. Validation completes before any write; the binding row is then updated in the same startup transaction as the new `agents` row. The state generation, and therefore every durable dispatch and outbox key, is preserved.
- Every other saved binding field, including each existing agent's `allowedChannels`, remains immutable and fails with `host_state_binding_mismatch`. Relaxing that is a separate decision, not part of additive growth.

An added agent never executes work that predates its addition. `replayHistory` is a first-start policy only: the newcomer is inserted uninitialized regardless of it, so the runtime's first page fast-forwards it to the live server head before any event is queued. The highest saved cursor among existing agents seeds that first page, but it is not the boundary: peers may lag behind the server head, and events they have not consumed yet are still history for the newcomer.

## Consequences

Operators can grow a roster with a restart instead of a reset. Rejected configurations leave the state file untouched, so restarting with the original roster succeeds. Duplicate identities on other hosts remain the operator's responsibility (ADR 0022).

## Verification

`tests/host-store.test.mjs` covers: an addition preserving agent state, queued jobs and the generation, with the newcomer uninitialized and fast-forwarded past an event no peer has consumed; removal, rename, allowed-channel and host-id changes rejected without writes, with the original roster reopening intact. `tests/host-runtime.test.mjs` restarts a `replayHistory: true` host with an added agent while the server head is ahead of every saved cursor and checks the newcomer executes only input posted after the addition.
