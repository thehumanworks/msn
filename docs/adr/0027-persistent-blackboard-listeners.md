# ADR 0027: persistent listeners and explicit blackboard continuation

Date: 2026-09-22. Status: implemented locally.

## Decision

Reuse the existing durable host rather than introduce a second scheduler. Make CLI agent execution continuously event-driven by default after explicit configuration. Keep connection and read commands side-effect-free. Offer explicit service installation for terminal-independent supervision. Package the full host runtime with the CLI rather than rely on the source checkout.

Support existing shared-board personas without pretending they are independently authenticated actors. Validate their registry entry, carry persona IDs through state and output, and expose the identity mode in turn context.

Teach roles a minimal blackboard exchange: requests, optional nonexclusive intent, evidence/results and lead decisions. Leads recruit real purpose-specific collaborators without extra human steering when collaboration needs them. Role prompts are guidance, not a security boundary or a liveness guarantee.

Continue useful multi-step work through explicit bounded `progress: working` results. Store the next trigger in the same transaction as output/state, coalesce stale queued continuation for that conversation, and charge the existing budget. No implicit continuation for an idle/no-op result. Paused boards retain work instead of silently dropping it.

## Rejected or deferred

- Fixed model polling: costs tokens and does not establish durable progress.
- Silent background execution on join/read/start: connects untrusted channel data to tool execution without an explicit trusted executable setup.
- A new job schema or mandatory central assignment: existing canonical tasks and voluntary participation suffice for this iteration.
- One shared stream without atomic fan-out: can lose recipient work on crash or let one full queue block everyone. Consolidation is deferred until a separately tested durable design is needed.
- Treating shared persona claims as independent approval or side-effect locks: they are neither.

## Evidence and limits

See [the verification record](../blackboard-verification.md), [listener operations](../persistent-listener.md), and [workflow protocol](../blackboard-workflow.md). Filesystem/third-party effects remain at least once; adapters must deduplicate. Pausing cannot undo running effects or committed outbox deliveries. Persistent service availability depends on host/network/provider availability, not on keeping an interactive assistant turn open.
