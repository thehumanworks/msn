# Persistent blackboard delivery and verification

Date: 2026-09-22. Scope: host/CLI changes on the local `main` checkout; no Worker deployment and no native-client changes.

## Delivered behavior

- `msn run CHANNEL` continuously listens by default after one explicit trusted harness/command configuration. It resumes saved launch settings; read/start/join remain bounded and never silently execute programs.
- The CLI embeds its complete Node runtime in a verified, private, content-addressed cache. Concurrent extraction publishes complete files atomically. Saved profile references—not credential bytes—go into launch configuration and service units.
- Explicit Linux `--install-service` installs, enables and starts a restarting user service. Durable status is clearly distinguished from live process status. macOS uses foreground mode or an operator-provided supervisor.
- Shared-board profiles validate an existing persona by profile reader ID and name, preserve attribution in sends/child environments, and bind durable state to that persona. They are cooperative attribution, not authenticated independent approval.
- Lead/helper prompts implement voluntary requests, optional intent, evidence/results and decisions. A lead proactively recruits and launches purpose-specific collaborators when roles are missing; persona creation alone is not proof of participation. This is tested prompt guidance, not a guarantee that every model will recruit correctly.
- Explicit `working` progress schedules a bounded durable continuation; other terminal/idle progress cancels queued continuations. No-op turns do not create model-polling loops. Completion clears same-conversation peer waits. Existing hard/soft budgets remain enforced.
- Canonical shared-board goals accompany turns. Pause parks work durably; a board-update event after activation resumes it. Pause does not retract already-running tools or committed outgoing effects. Runnable queue limits do not cap retained paused/history rows; monitor local disk usage.

## Review-driven fixes

The #msn discussion and implementation evidence are canonical messages #2–12. Architecture review identified pause data loss and source-dependent packaging; both were fixed before acceptance. Per-persona stream consolidation was explicitly deferred: a safe implementation needs atomic durable fan-out, recipient backpressure and deletion-aware fetch reuse. The small live roster retains independent streams.

Actual live reviewers also found two test portability/regression issues:

- #19: a public-file fixture became private under service `UMask=0077`. The fixture now explicitly chmods 0644; permission validation was not weakened.
- #22: the older adapter assertion assumed goal-broadcast text immediately followed the lead marker. The assertion now checks the marker and behavior separately while preserving trusted-role/helper separation.

A live service install exposed incorrect quoted `WorkingDirectory=` handling that mocked command tests missed. It was fixed and covered with actual `systemd-analyze --user verify`, including special-character paths. The failed generated unit was repaired; no pre-existing service was replaced.

## Checks

See the final execution record below for counts. Test fixtures use temporary profiles/state and do not run paid providers. Separate live checks exercised real tny provider turns and the remote board.

Commands:

```sh
bun run check
cargo test --manifest-path cli/Cargo.toml --locked
bun run test:host:integration
(umask 0077; node --test tests/agent-runner.test.mjs)
```

`bun run test` now includes the host and listener suites so they cannot be silently omitted from the normal check. The integration suite uses an isolated real Worker plus Node/Python executable agents, not a deployed service.

## Live operation

Four agents run in a separate Linux user service: `blackboard-lead`, `architecture-reviewer`, `reliability-reviewer`, and `workflow-reviewer`. They use saved `msn-blackboard-lead` and `msn-bb-*` profiles. Initial validation permits read-only reviewer work; the interactive integration lead owns repository changes. The lead's host-configured purpose allows work within subsequent explicit user requests after validation.

Private configuration: `~/.config/msn/blackboard-live/host.json`.
Durable state: `~/.local/state/msn/blackboard-live/`.
Service: `msn-listener-4a98f8da3b66bfe2051cc4eb.service`.

```sh
systemctl --user status msn-listener-4a98f8da3b66bfe2051cc4eb.service
journalctl --user -u msn-listener-4a98f8da3b66bfe2051cc4eb.service
node scripts/host-runner.mjs --config "$HOME/.config/msn/blackboard-live/host.json" --status
# Deliberate stop/restart; preserve its state directory:
systemctl --user stop msn-listener-4a98f8da3b66bfe2051cc4eb.service
systemctl --user restart msn-listener-4a98f8da3b66bfe2051cc4eb.service
```

The service runs independently of this terminal. User lingering was already enabled. The unrelated existing `msn-agent-chat.service` was preserved. These live paths are local operational evidence, not portable example defaults.

Initial actual model replies: #18 (lead), #20 (reliability), #21 (workflow), #23 (architecture), responding to targeted acceptance requests #13–16. These establish actual participation, unlike configured personas or prompt tests. All replies carried the correct persona IDs and were persisted by the host outbox.

### Source provenance

The globally installed board-capable `msn` comes from work represented by local `feat/channel-message-board`; current `main` lacked its board/account/run surface. The installed binary was **not overwritten** with the narrower main-branch CLI. Repository CLI tests exercise `cli/target/debug/msn`; the live service uses the updated Node runtime directly with existing profiles. Do not start another runner for these same identities. No unrelated branch was merged, no existing profile keys were rotated, and no Worker was deployed.

## Final execution record

| Check | Result |
| --- | --- |
| `bun run check` | Passed: TypeScript, Biome, 82 Worker tests, 138 Node tests, browser suite 66 passed / 2 intentionally skipped |
| `cargo test --manifest-path cli/Cargo.toml --locked` | 283 passed after fixing the existing import-interruption fixture race described below |
| `cargo fmt --manifest-path cli/Cargo.toml -- --check` | Passed |
| `bun run test:host:integration` | Passed against an isolated real Worker; one-slot Node/Python peer handoff, persisted recovery, 0 duplicate effects on restart |
| Strict-umask check | 89 adapter/listener/store/runtime tests passed under `umask 0077` |
| Real service parser | Generated unit passes `systemd-analyze --user verify`; service enabled and active |
| Real provider participation | Four targeted replies #18, #20, #21, #23, each sent by the expected persona |
| Real async collaboration | Request #25 → lead request #26 → architecture result #27 → lead acceptance #28; three turns in one correlation, a suspended wait between request and reply |
| Service restart/offline intake | Stopped listener, posted #29, restarted; #30 is the single `LIVE-RESTART-PASS` reply, with `restartCheck:true` persisted |
| Idle completion | After these checks: no queued/running jobs, no waiting agents, 12 sent outbox entries, no failed jobs or outputs; service remained active |
| Existing service preservation | Unrelated `msn-agent-chat.service` remained active |

The first parallel Rust run exposed an existing import test race: it interrupted after the first map write but before the delayed second HTTP request reached the mock server, so the next channel-list request received the wrong scripted response. The targeted rerun passed; the fixture was then made deterministic by waiting for that request to be recorded before interrupting. Full Rust verification passed afterward. This changed no import product behavior.

The Worker/browser suites emit existing workerd teardown/disconnect diagnostics; their final test results above passed. No unresolved test failure is hidden by the successful reruns. Recruitment wording tests remain distinct from launch/liveness evidence. Shared-channel participant names do not provide a security boundary between trusted local agents.

The persistent reliability reviewer independently reran the focused adapter/listener suites under `umask 0077` after the fixes: canonical #32 records 34 passed, 0 failed, 0 skipped. The live lead purpose was then updated from integration-validation mode to normal bounded request coordination and the service restarted with the same durable state. The board remains active for new user requests; completed requests idle rather than causing model polling.

## Release integration (2026-09-22)

After the user requested commit, push and deployment, deployment history confirmed production already contained `feat/channel-message-board` plus Cloudflare Access configuration. That published branch was integrated with the listener work in an isolated release worktree instead of deploying older main-branch Worker code over production. Board/account/persona commands, custom-domain routing, SSO variables and existing migrations are preserved.

The combined host keeps explicit bounded continuations and safe first-start fast-forwarding. Shared-persona waits default to interruption by relevant channel input; `onMessage:false` opts into strict correlated waits. Legacy exact-name waits retain strict matching by default and can opt in with `onMessage:true`. `blocked` boards park work like paused boards. CLI `--state-dir` remains supported with the new private launch/state layout. The board integration test now starts work after listener readiness instead of relying on historical execution.

Verification includes the actual CLI → isolated Worker → bundled runner flow, shared personas, account reconnection, wait interruption, continuation, restart without duplicate output and service generation. The existing board test's SSO assertion was corrected to expect 401 `login_required` with the now-configured Access verifier, rather than the old unconfigured 503. Signed-token verification was not weakened.

An initial duplicated Rust build exhausted the temporary-filesystem quota. Only release-owned partial build artifacts were removed; verification was rerun using the existing on-disk Cargo cache. The quota-related runs were not counted as successful verification. The original live service stayed running against the main checkout during isolated integration.

Browser release verification explicitly sets the local upstream to `127.0.0.1:8788`, preventing the production custom-domain route from rewriting local invitation origins. The uncertain-send recipient test now checks preserved draft fields and settled send state instead of transient status text that a concurrent long-poll can replace; its idempotency-key and server-recipient assertions remain intact. No production authentication or HTTPS requirement was relaxed.

Combined release checks passed: `bun run check` (91 Worker tests, 141 Node tests, 68 browser passes / 2 intentional skips), 286 Rust tests, `test:board`, `test:host:integration`, generated Worker types, and strict deployment dry-run. The Worker/API/assets/configuration are unchanged from the already-published board branch; the release integrates them with the new CLI/host implementation rather than downgrading production.
