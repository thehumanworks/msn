# Host runtime verification contract

Each requirement is an observable test, not an assertion that a model will behave well.

| Requirement | Evidence required |
| --- | --- |
| Harness-neutral host execution | Two different executable fixtures exchange real canonical messages; no model SDK in scheduler |
| Remote human alongside optional coordinator | Human posts through the Worker API; host replies through the same channel; coordinator-less operation succeeds |
| No intake / execution head-of-line blocking | A hung handler cannot prevent another agent's input from being durably accepted or handled |
| Cooperative waiting releases capacity | With concurrency 1, requester suspends, peer runs, correlated reply resumes requester |
| No circular runtime waits | A→B→A and self-wait produce actionable cycle continuations; unrelated agents still run |
| Bounded non-cooperative execution | Timeout kills supervised process group; finite attempts dead-letter the input; next input can run |
| Event-driven idle state | No work-scan interval; empty inbox sleeps until event, completion, deadline, retry or shutdown |
| Durable ingestion | Cursor and inbox commit atomically; redelivery is deduplicated; crash replays uncommitted work |
| Durable output | Lost POST response retries the same key/body without rerunning the handler |
| Organic channel participation | Peer send, join and leave; roster is provided; coordinator does not gate delivery |
| Bounded chatter | Self messages suppressed; conversation budget halts autonomous ping-pong visibly |
| Correct trust boundary | Strict local config; no executable text from messages; exact scoped identities; no admin key in children/logs |
| Safe queued deletion | Canonical 404/410 is skipped without exposing cached deleted text |
| Finite failure paths | Failed turn/outbox does not poison other agents; expired waits and restart recovery are visible |
| Existing contracts preserved | Worker, dispatcher, CLI regression and type/lint checks pass; task completion remains evidence-based |

Results are recorded below as checks are executed. Provider-funded live model calls, production deployment and real macOS execution are not acceptance claims unless separately recorded.

## Executed evidence — Linux / Ares

Executed on the isolated `feat/host-agent-coordination` worktree, with Node 26.8.1 and Rust 1.98.1. No production Worker or user workspace was changed.

| Check | Observed result |
| --- | --- |
| `bun run test:host` | 37 passed: 17 state/transaction tests, 12 real-HTTP/process runtime tests, 6 process supervision tests and 2 prompt-adapter contract tests |
| `bun run test:host:integration` | Passed against an isolated real Wrangler/Cloudflare Worker: remote-protocol human → Node agent → Python agent → Node agent → human, with one execution slot, no required coordinator, a correlated resume, and zero duplicate effects after restart; seven canonical messages, four committed outbound sends |
| `bun run test` | 82 Worker tests across five files and 40 existing JavaScript CLI/onboarding/dispatcher tests passed |
| `bun run typecheck` | Passed |
| `bun run lint` | Passed |
| `cargo fmt --manifest-path cli/Cargo.toml --all -- --check` | Passed |
| `cargo clippy --manifest-path cli/Cargo.toml --all-targets --all-features --locked -- -D warnings` | Passed |
| `cargo test --manifest-path cli/Cargo.toml --locked` | 271 passed, zero failures/ignored tests |
| `bun run test:dispatch` | Existing real-Worker workflow passed: worker/reviewer dispatch, evidence-based task closure, identical event journal on restart, zero duplicate side effects |

Important regressions exercised with actual processes and sockets: an agent that ignores SIGTERM is killed by its deadline while another agent completes; a lost successful POST response reuses exactly the committed key/body without rerunning the original turn; a second process cannot acquire the SQLite owner lock; SIGKILL releases that lock automatically; a disconnected host's supervisor reaps its child; a two-peer circular wait recovers with only one execution slot; an absent peer's deadline wakes the requester without incoming traffic; and a terminal send failure creates a new durable continuation rather than silently disappearing.

The real Worker run caught a shutdown/restart defect: canceling a canonical read consumed the only allowed attempt, potentially dead-lettering input that had not reached its executable. Clean cancellation now refunds that claim, while crash recovery retains consumed attempts. Excluded canonical messages are classified before enforcing an exhausted execution-attempt budget. A regression test covers the corrected cancellation path.

## Explicit limits of this evidence

Linux was executed locally. `.github/workflows/host.yml` adds Node 24/26 × Linux/macOS process tests plus a Node-24 real-Worker integration job; merely adding those jobs is not a claim that remote CI has passed. Local attempts to invoke a separate Node 24 through `npm exec` exited before the runtime started, so they are not counted as Node-24 evidence.

Claude/Codex adapter tests use executable fixtures to verify actual argv, stdin, output extraction and validation. They do **not** claim a completed live provider-backed MSN conversation. No production daemon was installed, no existing interactive TUI was attached, and no macOS/iOS GUI was launched by this change. The existing native clients were not changed. Host state is local; duplicate-agent ownership across separate hosts and exactly-once external filesystem/API effects are outside the contract.

A final adversarial state-reset test reproduced an idempotency collision between two new state directories sharing host/agent names and local job IDs. Turn, conversation-root and action keys now include a persisted random state generation and the origin/tenant/host binding. The regression rejects cross-generation collisions and verifies stable keys when reopening the same generation.

Two bounded independent Claude Code review invocations (repository-reading and source-only) timed out without returning a report. Neither counts as completed external review or approval. The executable checks and reproduced/fixed defects above are the verification evidence.
