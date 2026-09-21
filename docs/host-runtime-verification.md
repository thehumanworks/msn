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

## Soft budget review — 2026-09-21

Codex independently inspected the working changes on `feat/host-soft-budget` and executed `npm run test:host`: all 48 tests passed, with no skipped or cancelled tests. This includes ten soft-budget store/configuration cases and the one-slot executable budget-continuation case. `npm run lint` also passed (48 files checked). These are local executable-fixture checks, not live provider or deployed-host verification.

The reviewed implementation uses canonical human message IDs to reset once across broadcast recipients, excludes every human-triggered job from soft counting, and preserves the counted marker through cancellation and retries. The version-2 migration prevents the older positional budget insert from operating on the expanded schema. The warning wording asks for reassessment without treating activity alone as failure.

The separate request to remove the chat handler deadline was implemented after that review. `timeoutMs: null` is an explicit no-deadline mode: validation accepts `null` while rejecting `0` and strings, neither the worker watchdog nor the supervisor arms a turn deadline, and the recovery lease becomes a short fixed grace (`NO_DEADLINE_LEASE_MS`) instead of deriving from the deadline. Focused checks cover the process, cancellation and recovery paths: a no-deadline turn completes normally and a SIGTERM-ignoring no-deadline turn is still cancelled within the bounded escalation; the IPC-disconnect watchdog reaps its child with both finite and `null` deadlines; and a runtime-level turn runs past the finite fixture default, records a lease bounded by the fixed grace, and stops cleanly on host shutdown. After these additions `npm run test:host` passes all 52 tests with none skipped or cancelled, and `npm run lint` and `git diff --check` pass. These are local executable-fixture checks; no live provider run, commit, push, host restart or deployment is claimed.

Independent re-review reproduced a remaining recovery gap despite all 52 tests passing: a no-deadline turn started at synthetic time 0 has `lease_until=15000`; reopening its state at time 20000 sets `available=20000` and permits immediate reclamation. The lease has expired while the handler could still be running, so restart does not reserve time for the old watchdog's disconnect cleanup and SIGKILL escalation. This is a deterministic store-level reproduction, not an observed live duplicate execution. Integration remains pending a recovery grace measured from replacement-host startup (including configuration changes), plus a regression for an expired no-deadline lease. The runtime documentation's claim that every non-cooperative turn eventually releases its slot also needs qualification for the explicit no-deadline mode.

Codex independently reviewed the replacement-startup recovery fix: running jobs now become available at `max(replacement startup + RECOVERY_GRACE_MS, original lease)`, regardless of current timeout configuration. The expired-lease regression now rejects claims at restart and throughout the grace. The first independent run exposed only a strict assertion mismatch with SQLite's null-prototype row; normalizing that row fixed the assertion, and `npm run test:host` then passed 53/53. Codex added a regression for repeated restart of queued recovery work and preservation of longer original leases; the subsequent focused `node --test tests/host-store.test.mjs` passed 30/30. `npm run lint` checked 48 files cleanly and `git diff --check` passed. The runtime guide now qualifies slot liveness for no-deadline turns. These checks close the reproduced store recovery gap; they do not establish live-host restart or deployment behavior. Commit and push remain pending integration handoff.

After Claude's final integration handoff, Codex reviewed the complete diff and independently reran `npm run test:host`: 54/54 passed, with no failures, skipped or cancelled tests. `npm run lint` checked 48 files without fixes, and `git diff --check` passed. This is the final local validation for the combined soft-budget and no-deadline changes. The unrelated `mise.lock` modification is excluded from integration. Live-host activation and restart verification remain pending the deployment target.

Following that validation, the example host configuration and the Ares chat host configuration were changed to `timeoutMs: null` for both agents, and the no-deadline mode was registered as ADR 0024, amending ADR 0022. The running Ares host still has the earlier finite deadlines in memory until it is restarted. This is a configuration and documentation change; `npm run test:host`, `npm run lint` and `git diff --check` were rerun and the example was parsed as JSON before commit.

Roster growth was the next gap: adding an agent to an existing state directory failed with `host_state_binding_mismatch`. The store now validates an immutable identity core (`hostId`, `origin`, `tenant`) and requires every saved agent to remain with the same username, rejecting removals (`host_state_agent_removed`) and renames (`host_state_agent_identity_mismatch`) before any write; additions update the binding in the startup transaction, keep the state generation, and start the newcomer at the host event boundary rather than at cursor 0. Three store tests cover addition, rejection with intact reopen, and allowed-channel policy changes; `npm run test:host`, `npm run lint` and `git diff --check` were rerun locally. This is ADR 0025. The running Ares host is unchanged until restarted.
