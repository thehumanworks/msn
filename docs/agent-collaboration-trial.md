# MSN collaboration trial — 2026-09-17

We used MSN itself to coordinate this implementation: one lead, two GPT-5.6 Sol agents at medium reasoning effort, and one Sol reviewer at low effort. Each had an independent exact-name participant key in the same local `agent-lab` workspace. The `collaboration` channel carried assignments, questions, interface decisions, review requests, and results. Agent orchestration was used to start or resume workers; substantive coordination used MSN.

## First round: configuring identity and checking work

The lead and agents reproduced two concrete problems:

- With `MSN_USERNAME` unset, `whoami` returned the bound username, but `send` and automatic `wait` failed. The credential already supplied the identity, yet every caller had to duplicate it.
- After draining messages, `wait --wait 1` continued indefinitely. Interrupting it produced success with no output. `poll` could return an empty page, but required agents to manage their own cursor between work chunks.

Channel messages 6, 7, and 9 recorded these findings. We implemented exact-name identity inference, per-shell profiles, and one-request `read` with persisted reader progress. The lead then saved and activated a profile through the actual Bash function, removed connection and identity environment variables, and successfully ran `whoami`, `read`, and `send` (message 32).

The reviewer independently used two profiles with the same HOME/config/state directories. Each read the same request once and then received an empty page; a reply referenced the request, and an identical retry returned the same message ID with `replayed:true` (message 29). This verified both isolation and shared-channel collaboration, using the new workflow rather than only mocks.

## Second round: identifying who should act

The user suggested addressing a username. Agents confirmed that the lead had been prefixing assignments with names in prose; neither a message reply ID nor a task correlation ID identified the intended actor (messages 24 and 25).

We added `--to USERNAME` and used it for real handoffs: lead → reviewer (39), lead → reader (40), and replies addressed to lead (41 and 43). Retrying message 43 returned the same ID, and a nonrecipient reader still saw it (45). The channel remains a shared log; addressed messages are not private or exclusive work claims.

The human composer gained an optional recipient field and visible recipient annotations. Review identified a draft race: clearing text and recipient independently after an in-flight send could change a newly edited draft into a broadcast. The implementation and regression coverage now treat those draft fields together.

## Durable evidence

The repeatable real-Worker check is `npm run test:participants`. It now exercises inferred Rust/Node identity, profile selection despite hostile stale environment variables, bounded empty reads, shared-HOME isolation, addressed fan-out, replies, idempotent retries and recipient conflicts, revocation, cross-CLI cursor locks, and rotation. Its isolated server and temporary credentials are removed afterward.

The source suites additionally cover old-schema migration and digest compatibility, UTF-8 recipient validation, browser rendering and draft/retry behavior, private profile permissions, real Bash activation failure behavior, and read interruption/output failure. See [verification](verification.md) for the final run results, [ADR 0008](adr/0008-agent-collaboration-workflow.md) for the decisions, and the [agent playbook](agents.md) for usage.

These are local implementation and verification results. The trial did not deploy the Worker or publish a CLI release.
