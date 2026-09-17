# MSN swarm self-improvement trial — 2026-09-17

Eight subagents and one coordinator used a real local MSN Worker to improve MSN itself. The trial produced versioned channel snapshots, bounded fresh-session catch-up, explicit snapshot reminders, a browser catch-up view, and regression coverage for races and recovery. No deployment, release, or commit was performed.

## Participants and communication

| MSN participant | Model/runtime | Responsibility |
| --- | --- | --- |
| astra-design | GPT-6 Astra, low effort, Codex subagent | Server contract, storage, API and tests |
| astra-review | GPT-6 Astra, low effort, Codex subagent | Independent architecture and implementation review |
| sol-cli | GPT-5.6 Sol, medium effort, Codex subagent | Rust snapshot and catch-up commands |
| sol-integration | GPT-5.6 Sol, medium effort, Codex subagent | Real Worker/Rust integration tests |
| grok-reentry | `cursor-agent --model cursor-grok-4.6-high-fast` | Cold-session recovery and independent probes |
| grok-noise | Same Cursor model | Context volume, response bounds and reminder cadence |
| grok-races | Same Cursor model | Concurrent writers, replay, identity and deletion probes |
| grok-docs | Same Cursor model | Agent protocol, usage verification and documentation |

The coordinator used the participant `lead`. Each participant had an independently bound local key and profile. Native runtime capacity allowed three subagents alongside the coordinator, so the four native roles worked in waves. The four Cursor agents ran concurrently as separate processes. This was eight logical subagents, not eight native agents simultaneously.

All substantive assignments, contract decisions, questions, findings, reviews and completion reports went through MSN's `swarm` channel. Native launch/resume instructions and Cursor process prompts supplied identity, the local wrapper and where to read the assignment. Tool status/final notifications also exist outside MSN; they were not the working discussion channel. The [runtime manifest](examples/swarm-2026-09-17/participants.json) records the Cursor model names actually reported at initialization. No further agents were spawned by participants.

## Improvement rounds

1. **Experience the current workflow.** All participants read the channel and discussed findings with peers. Grok re-entry/noise independently measured the first 23 messages: 17,920 JSON bytes, 13,490 text bytes, with roughly 93% of text addressed to other participants. More importantly, a saved delivery cursor hid the original assignment on a later read. Filtering by recipient would also hide shared decisions, so the team preserved fan-out and designed a separate recovery command. Evidence: messages 39–53.
2. **Design, implement and use checkpoints.** Astra review identified two hazards before implementation: a newly published snapshot must not skip unseen messages during pagination, and a summary prepared before deletion must not resurrect deleted content. The contract adopted exact continuation, version CAS and a redaction revision. The measured channel volume changed the reminder threshold from 100 uncovered messages to 20 messages or 16 KiB, plus missing-snapshot and age reminders. Server, Rust CLI, browser and docs were implemented in separate ownership areas. Evidence: 10–24, 54, 63–76.
3. **Return with lost context, probe, fix and verify.** The coordinator published snapshot v1 through message 76. `grok-reentry` started a completely new Cursor session and saved the `catchup` response before opening source, documentation or old history. It reconstructed the objective, all owners, decisions, blockers and its next task from the snapshot and five newer messages. Other Grok roles independently exercised bounds, identity, concurrent publication and redaction on scratch channels. Astra reviewed the implementation. Findings led to further fixes, then the whole regression suite ran. A second checkpoint captured the updated state through message 239. Grok docs also ran a final correction pass. Evidence: 82–99, 167, 218–239.

## Findings that changed the product

| Finding | Implemented response | Evidence |
| --- | --- | --- |
| A delivery cursor does not restore forgotten task state | Stateless `catchup`; initial request always considers the latest snapshot, independently of reader progress | 39, 41, 92, 221 |
| Default history pages can overwhelm a returning agent | Count and complete serialized UTF-8 byte limits; explicit remaining-tail indicators | 43, 54, 218 |
| A 100-message checkpoint reminder arrives too late for this workload | Reminder at 20 messages or 16 KiB, and at handoff/milestone by protocol | 43, 63, 70 |
| A newer summary can hide unseen tail during continuation | Explicit `after` reads exactly that tail and omits snapshots | 13–16, 20, 167 |
| A stale author can publish deleted content | Atomic history revision, required publication precondition and channel-wide snapshot invalidation | 15, 20, 234 |
| Competing snapshot authors can overwrite useful work | Immutable versions, CAS, separate retry namespace, replay before version checks | 20, 42, 167 |
| Byte-budget error hid the actionable retry value in the CLI | Include the numeric minimum in both structured error data and error text | 75, 81, 96, 220, 234 |
| CLI help drifted from its actual default | Corrected help and examples; regression assertions on both help surfaces | 82, 92, 226, 232 |
| Browser raw Poll/Live could retain a now-invalid summary | Clear unvalidated snapshot context when leaving catch-up; regress Poll, Live and channel return | 90, 220 |
| A reported one-byte overflow mixed HTTP bytes with CLI framing | Direct HTTP measurement disproved the server defect; document the trailing newline | 228, 236 |

Snapshot bodies are authored Markdown, with a conventional task ledger rather than a server-enforced workflow. The template carries objective, decisions, open tasks with owners/status, blockers, artifacts, next actions, unresolved claims and evidence. Summaries remain unverified participant content; the original messages remain available.

## Recovery measurements

These are measurements of this trial, not a model-quality benchmark or lossless compression claim.

| Point in history | Full channel JSON | Recovery input | Observation |
| --- | --- | --- | --- |
| Through message 81 | 81 messages; 64,896 compact JSON bytes | 7,850-byte saved CLI response: v1 snapshot + 5 tail messages | A fresh Grok session recovered its assignment and project state before reading old history |
| Through message 239 | 136 messages; 104,434 compact JSON bytes | 3,876-byte HTTP response: v2 snapshot, empty tail | 96.3% fewer bytes; important claims still need evidence verification |

Message ids are tenant-wide; gaps after message 81 come from independent scratch-channel probes. Full-log comparison sizes use the same compact JSON envelope shape and UTF-8 encoding. CLI response files include a trailing newline. The [v1 comparison](examples/swarm-2026-09-17/comparison-v1.json), [v2 comparison](examples/swarm-2026-09-17/comparison-v2.json) and [fresh response](examples/swarm-2026-09-17/fresh-reentry.json) preserve the measurements.

## Validation and saved evidence

252 tests passed: Rust 127, Worker/API 51, Node CLI 16, browser 58 across desktop/mobile Chromium. Both `npm run test:swarm` and `npm run test:participants` passed against isolated real local Workers and actual CLIs. Cargo formatting, Clippy with warnings denied, TypeScript, Biome and diff checks passed. The live browser view showed snapshot v2, paused Live, safe text, no horizontal overflow and no console errors. Expected workerd diagnostics during forced restart and canceled long polls remained visible; assertions passed.

Durable artifacts are indexed in [the evidence directory](examples/swarm-2026-09-17/README.md), including the full channel transcript, two checkpoints, the fresh-session response, measurements, independent probe results, runtime manifest and screenshot. Exports were checked against every local fixture key; credentials, profile files and full Cursor tool logs are excluded. Raw temporary runtime logs and local Worker state remain under `/tmp/msn-swarm-20260917` and are not durable project artifacts.

The actual session ran for minutes, with tests simulating history growth, age, restarts and races. This is not a multi-day soak test. Snapshot reminders do not schedule an LLM, and summaries are not semantically verified. Task claims, an autonomous scheduler and automatic summarization are outside this change. Workspace limits remain explicit, including 1,000 lifetime snapshot versions and the shared content budget. New commands require the updated Rust CLI and Worker.
