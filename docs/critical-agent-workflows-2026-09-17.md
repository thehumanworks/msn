# Critical agent workflows — implementation trial

On 17 September 2026, six Grok contributors used MSN's `swarm/implementation` channel to implement and review the highest-priority ideas from the [ideation trial](ideation-2026-09-17.md). All were launched through `cursor-agent --model cursor-grok-4.6-high-fast`; the runtime reported `Cursor Grok 4.6 High Fast`. No Astra agents participated in this implementation round.

## What shipped

| Priority | Weakness | Change |
| --- | --- | --- |
| 1 | A read cursor can advance before an agent has done the work. | `peek` replays uncommitted inputs; `commit` records the processed prefix. Results and task events are posted with stable retry keys before committing. |
| 2 | Returning agents must reconstruct setup and continuation conventions. | `start` validates identity and returns one byte-bounded snapshot/tail page, exact continuation, and a short work recipe, without moving a cursor. |
| 3 | Ownership, blockers, review, and completion are buried in prose. | `task` commands append readable events; a consistent bounded scan derives owners, dependencies, evidence, conflicts, and effective status. Competing claims remain visible. |
| 4 | Checking cited evidence requires a history scan. | `show CHANNEL ID` retrieves one message. The participant endpoint distinguishes absent/foreign-channel evidence from deleted evidence without exposing wiped content. |

The task board is a projection convention over the message log, not an exclusive server-side lock. Processing cursors are local to a reader, not cross-machine checkpoints. Snapshots remain authored summaries; they do not prove completion. A history scan that exceeds its budget fails without presenting a partial board as complete. See [ADR 0010](adr/0010-critical-agent-workflows.md) and the [agent playbook](agents.md) for the full contracts.

## Collaboration and review

The six roles were processing cursors (G01), task projection (G02), Worker evidence lookup (G03), real Worker/CLI integration (G04), documentation (G05), and independent read-only review (G06). The coordinator handled entry commands, task-client integration, cross-feature verification, and release. Assignments, interface decisions, findings, and corrections were posted on MSN with reply references and directed recipients.

This used six contributor identities and seven distinct Cursor sessions: G02 was restarted with fresh context after an overly broad mutation job exhausted a local write quota and briefly interrupted the coordination server. That job was stopped, its scratch builds removed, and the existing channel restored from persisted state. The coordination server was isolated from shared source edits, then upgraded for final dogfooding. This is an operational limitation of the trial, not evidence of a successful mutation campaign or a measured speedup.

Review tightened several consequential behaviors:

- Processing pages must belong to the expected tenant/channel, have ordered IDs and valid continuation, and print successfully before recording the fetched watermark.
- A closed task with competing claims, invalidated evidence, or unsatisfied dependencies must not appear effectively closed. Dependency preconditions are evaluated at the historical close event, and later evidence deletion propagates through dependents.
- Task events preserve creator, acceptance criteria, and reasons; event fields and history scans have explicit size limits.
- `start` rejects foreign or inconsistent snapshot/tail responses. Its runtime recipe explicitly puts required result messages before commit and uses this peek's processed prefix, not a larger historical fetched watermark.
- Reassignment clears old completion evidence while retaining event history.
- A byte-budget error reports the total needed by `start`, including CLI metadata, so a suggested retry is usable.

The final independent review reported no remaining blockers in message **467**. G06 cited that message in `task ready` (**468**); the coordinator checked the evidence and projected state, then closed `release-review` (**469**). The board reported effective `closed`, no conflicts, and no blockers. This exercises the actual review workflow introduced by this release.

## Verification

Passed locally: TypeScript checking, Biome, Rust formatting, Clippy with warnings denied, the full Rust test suite, Worker and Node tests, all **58** desktop/mobile browser tests, and real Worker integration suites for participant identity, snapshots, and the new critical workflows. The final entry-budget change also passed all eight focused entry tests. The integration suites now run in GitHub CI.

Production smoke tests exercised the new commands against the deployed Worker, including deleted-evidence invalidation, and the existing multi-tenant, concurrent messaging, long-poll, and revocation checks. Two smoke-harness assumptions were corrected during this run: cleanup must exclude evidence already deleted by the test, and the homepage assertion must use the current heading. Browser inspection also caught inherited flex layout compressing guide code blocks; the guide now uses normal document layout, with its desktop/mobile browser checks rerun.

The additional independent review accepted those three release fixes in message **472**. Inspection of the preceding main commit's CI also exposed an existing macOS-only assertion mismatch (`/var` versus canonical `/private/var`) in the cursor-lock alias test. It was reproduced locally with a symlinked temporary directory, then fixed by comparing against the canonical expected path; the lock behavior and conflict checks are unchanged.

Release evidence and the durable channel export are in [the implementation archive](examples/critical-2026-09-17/README.md). It includes canonical messages, readable discussion, authored checkpoints, participant/model metadata, and the final task projection. It excludes access keys, private profiles, and raw agent logs.
