## Objective
Make MSN useful for long-horizon multi-agent collaboration by letting a returning agent recover project state from an authored snapshot plus a bounded canonical tail. This is a local development trial, not a deployment.

## Decisions
- Server contract #54 amended by #63/#70: versioned Markdown snapshots, <=16KiB UTF-8, explicit coversThrough + baseVersion + historyRevision and required retry key. Catchup defaults limit20/maxBytes32768, full JSON bounded, exact-after continuation. No automatic reader cursor mutation.
- Snapshot reminders: missing valid snapshot, 20 uncovered messages, 16384 stored username+text bytes, or 24h old with pending messages (#63/#70). Reminders are not an LLM scheduler.
- Admin deletion wipes all channel snapshot text and increments historyRevision atomically. Fresh revision permits tombstone coverage; stale authors rejected (#54/#64). Summaries are authored unverified data; canonical messages/artifacts remain evidence.
- Keep all channel messages visible regardless of --to. No task claiming, inbox filter, or rejoin cursor mutation (#33/#43).

## Open tasks
- astra-design — implementing final server tests and fixing requiredBytes exact retry boundary raised by lead #75; owns src/store.ts, src/http.ts, tests/snapshots.test.ts.
- sol-integration — running real Worker/Rust integration; owns tests/swarm.integration.mjs (#37/#38).
- lead — owns browser Catch up with safe snapshot rendering, paused Live, bounded pages, revision mismatch clearing, late-request protection; three new browser test cases running. Owns final integration, docs overview, evidence exports. Existing migration expectation changed to schema7.
- astra-review — first architecture pass complete (#20), will review implemented code next.
- sol-cli — implementation complete (#74), 124 Rust tests passed; available for review fixes, owns cli/src/* and cli/tests/snapshots.rs.
- grok-reentry — round1 complete (#57); next task is fresh-context return: run catchup without --after and reconstruct objective, owners, decisions, blocker and next actions from this snapshot and tail, then report actual sufficiency and byte count.
- grok-noise — round1 complete (#62); next verify implemented byte/count bounds and due thresholds, including Unicode/escaping and actionable requiredBytes.
- grok-races — round1 complete (#55); next adversarial probes of CAS/replay/redaction/identity; tombstone repair with fresh revision is allowed (#64), do not mistake that for a bug.
- grok-docs — docs/agents.md and ADR0009 complete (#76); next review actual CLI help/workflow against prose and correct only those owned docs if needed.

## Blockers
No external blocker. New code is local and needs final regression/review. A possible requiredBytes off-by-one is under review (#75). Do not claim feature deployed or all checks passed yet.

## Artifacts
Repo /home/tomas/Projects/msn. Role command: /tmp/msn-swarm-20260917/msn ROLE <args>. Shared channel swarm. Local server http://127.0.0.1:8798. Scratch /tmp/msn-swarm-20260917. Tests: cargo test --manifest-path cli/Cargo.toml --locked; npm test; npm run test:browser; integration command forthcoming. Current CLI syntax in #71: snapshot template; snapshot publish CHANNEL --text - --covers-through N --base-version N --history-revision N --key K; snapshot list/show; catchup CHANNEL [--after N] [--limit N] [--max-bytes N].

## Next actions
Complete tests, run Grok round2 probes and Astra implementation review through MSN, fix findings, publish updated checkpoint, perform fresh-context return, save durable evidence in repo. Do not commit/deploy or call production. Do not print credentials. No additional subagents.

## Unresolved
Snapshot contents cannot be semantically verified by server. Cadence and quota are explicit policy. No automatic task scheduling/claims. Browser summary is participant-authored text, not executable markup.

## Evidence
Reviewed messages #1–#76, covering through #76, historyRevision0; contract #54/#63/#70, review matrix #20/#42, measured baseline #39/#43, CLI success #74, docs result #76. Later messages remain canonical tail and may change this state.
