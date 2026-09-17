# Swarm snapshots and long-horizon recovery — 2026-09-17

Implemented and verified locally through an eight-subagent MSN swarm: two Astra (low), two Sol (medium), and four Cursor Grok (`cursor-grok-4.6-high-fast`) participants. Native participants worked in waves within the runtime concurrency limit. Details and durable evidence: [swarm trial](swarm-collaboration-trial.md), [transcript and artifacts](examples/swarm-2026-09-17/README.md).

- Rust: **127** passing tests (28 library + 79 CLI + 6 identity + 4 profile + 2 read-safety + 8 snapshots).
- Worker/API: **51** passing tests (40 existing + 11 snapshots), including restart, CAS/replay, redaction/revision, exact continuation, full UTF-8 byte bounds and streamed-body revocation.
- Node CLI: **16** passing tests.
- Browser: **58** passing cases across desktop/mobile Chromium (29 per viewport); 12 new snapshot/catch-up cases cover safe text, bounded pagination, drafts, history revisions, late channel responses and raw Poll/Live/channel-return transitions.
- Total: **252 tests**, plus both real local Worker scenarios: `npm run test:swarm` and `npm run test:participants`.
- Cargo fmt, Clippy all-targets/all-features with warnings denied, TypeScript, Biome and `git diff --check` passed.
- Live browser check via agent-browser: local snapshot v2 renders, Live pauses, no console errors or horizontal overflow. Screenshot saved with the trial.
- A fresh Cursor session recovered scope, owners and next actions from a 7,850-byte saved catch-up response before opening old history. At the second checkpoint, 104,434 bytes of raw channel JSON became 3,876 bytes of authored recovery context (96.3% fewer bytes, with raw history preserved).

No deployment, release or commit was performed. No bindings changed, so no type regeneration was needed. Tests simulate long-history/age/restart/race conditions; this was not a multi-day soak. Snapshot content is authored and unverified; cadence is a reminder, not an LLM scheduler. Expected workerd forced-restart/canceled-poll diagnostics remain in test output; assertions pass. Prior evidence below describes earlier states and deployments.

---

# Agent collaboration verification — 2026-09-17

Implemented and exercised locally through MSN with three GPT-5.6 Sol subagents (two medium-effort participants and one low-effort reviewer). [The trial record](agent-collaboration-trial.md) connects the observed friction, channel exchanges, and improvements. These changes are not deployed or included in a published CLI release.

| Check | Observed result |
| --- | --- |
| Real collaboration | Independent participant sessions coordinated implementation and review through MSN, then used profiles, bounded reads, and addressed handoffs |
| `npm run test:participants` | Passed against a real local Worker: inferred identity, complete-profile precedence, independent bounded reads, addressed fan-out/replies/retries, revocation, cursor locks, and rotation |
| `cargo test --manifest-path cli/Cargo.toml --locked` | 118 tests passed: 27 unit, 79 CLI, 6 identity, 4 profile, 2 read-safety |
| Rust formatting and Clippy with warnings denied | Passed |
| Worker API suite | 40 tests passed, including pinned historical digest vectors and v5→v6 migration |
| Node CLI suite | 16 tests passed |
| TypeScript and Biome | Passed |
| `npm run test:browser` | 46 desktop/mobile Chromium tests passed after the final draft-race fixes |
| agent-browser visual check | Connected, sent an addressed message through the human composer, verified CLI receipt; recipient control/annotations rendered, no horizontal overflow or page errors |

Profile tests execute the actual Bash shell hook and prove failed activation preserves the previous selection. Read-specific tests prove SIGTERM and closed stdout release locks without advancing the saved cursor. The real participant scenario selects profiles while deliberately supplying incorrect ambient origin, tenant, token, username, and reader values; it still reads the correct workspace with independent progress.

The Worker migration adds only a nullable recipient column; bindings are unchanged. Existing plain and typed/correlated retry digests have fixed compatibility vectors. Addressing remains visible to every reader and does not authorize or claim work.

Browser regressions cover recipient escaping, byte-preserving names, a changed recipient generating a new retry key, independent channel drafts, and editing only text or only recipient during an in-flight successful send. Both fields of the edited draft survive completion. The final browser message was observed through the CLI in the same collaboration log (message 53). Scope is local Linux and Chromium desktop/mobile; no production migration or published binary is claimed. The prior deployment evidence below refers to earlier code.

---

# Local verification — 2026-09-16

Participant keys, reader isolation and browser reading improvements are implemented in this checkout. **Not deployed:** the production evidence below describes earlier versions, not these changes. No production secret files were read, no production requests were made, and no production workspaces or keys were modified.

| Check | Observed result |
| --- | --- |
| `bun run check` | TypeScript and Biome passed; 36 real-workerd API tests, 13 Node CLI tests and 40 desktop/mobile Chromium tests passed |
| `cargo fmt --manifest-path cli/Cargo.toml --all -- --check` | Passed |
| `cargo clippy --manifest-path cli/Cargo.toml --all-targets --all-features -- -D warnings` | Passed, zero warnings |
| `cargo test --manifest-path cli/Cargo.toml --locked` | 27 unit and 75 integration tests passed, zero failures |
| `bun run test:participants` | Passed: builds the real Rust binary, starts a local Worker on a temporary loopback port, and runs both CLIs with isolated HOME/state and fixture secrets |
| `git diff --check` | Passed |

The repeatable participant smoke checks independent key creation, `whoami`, shared-channel fan-out, separate readers sharing HOME, cursor resume, name enforcement, reply/correlation fields, secret-free key listing, targeted revocation of pending reads, other participants retaining access, cross-CLI cursor locks, signal cleanup, and emergency revoke-all rotation. Temporary Worker state and CLI state are removed afterward.

Regression tests include v4→v5 migration and earlier schema upgrades without losing the original key/history, revocation during a streamed send, browser stale-response handling, non-JSON 401s, 403 draft retention, channel resume versus Reread, memory cache bounds, mobile hidden-pane pruning/scroll anchoring and safe correlation rendering. Initial test failures were corrected and the final suites rerun; expected forced-restart/cancelled-poll workerd diagnostics remain visible.

Limits: Linux Rust checks and Chromium desktop/mobile only. No live deployment, production migration, Firefox/WebKit run, load/soak test, or downstream exactly-once processing guarantee. Browser progress remains memory-only. Cursor sidecar locks require cooperating updated clients and manual recovery after an unclean exit. See ADR 0007 for the decisions and README for usage.

---

# Delivery evidence — 2026-09-14

## Deployed application

- URL: https://msn.rodat-human-ada.workers.dev
- Version: `b03652bf-ed65-4403-b0ff-42fb68c9302f` (100% traffic).
- Command: `npx wrangler deploy --secrets-file scripts/.secrets/production.json` — exit 0, `Deployed msn triggers (2.58 sec)`. See `docs/deploy.log:17-28`.
- `npx wrangler deployments list` confirms 100% traffic on this version (`docs/deployments.log`).
- `npx wrangler secret list` returned `[{"name":"ADMIN_TOKEN","type":"secret_text"}]`.
- Workspace `main`, channel `general` is ready with one welcome message. Its member credentials are in `scripts/.secrets/workspace.json`; **do not publish that file**. Admin secret is separate in `scripts/.secrets/production.json`. Verified permissions: directory 700, both files 600. Both are gitignored and outside `public/`.

## Contract coverage

1. Human/agent ergonomics: `public/index.html`, `public/app.js` and `public/style.css`; `scripts/msn.mjs` has help, JSON output, JSONL follow, retry keys, safe origin handling and atomic context-bound cursor files. `README.md` and public `guide.html` document onboarding/API/operations. Deployed screenshots: `docs/screenshots/welcome.png`, `workspace.png`, `mobile.png`.
2. Multi-tenanted concurrent messaging: tenant-derived DO namespace in `src/index.ts:17-23`; hashed capabilities and SQL transactions in `src/store.ts:58-63,163-229`. `tests/api.test.ts:109` executes 60 concurrent sends across two tenants/channels. Live smoke verifies another 20 concurrent writes.
3. Poll/reread/send/delete: SQL cursor pages `src/store.ts:92-103`; race-free bounded fan-out waiters `105-161`; atomic idempotent sends `163-229`; restricted admin deletion `258-284`. Tests cover empty timeout, registration races, cancellation cleanup, 128-reader cap, key rotation, monotonic IDs, retry tombstones, and exact deletion authorization.
4. Date/channel/user-defined username: `src/store.ts:17-25,210-219`; UTC server timestamps, no display-user login. `tests/api.test.ts:91` checks two-way human/agent messages and their metadata. Tenant capability authenticates workspace access, NOT the username.
5. Checks: all 33 tests pass (17 Workers-runtime + 6 Node CLI + 10 desktop/mobile browser), strict TypeScript passes, Biome recommended lint/format passes without warnings. Exact final check output is `docs/check.log`.
6. Actual Cloudflare deployment and live verification: `docs/deploy.log`, `docs/deployments.log`, `docs/live-smoke.log`, `docs/live-browser.log`.

## Commands and observed results

- `npx wrangler types`: generated `worker-configuration.d.ts` with ASSETS, ADMIN_TOKEN and MSN_DURABLE_OBJECT; runtime types generated. Run after binding changes.
- `bun run check > docs/check.log 2>&1`: exit 0. Runs `tsc --noEmit`, `biome check .`, `vitest run`, `node --test tests/cli.test.mjs`, and `playwright test --config tests/playwright.config.mjs`.
  - `docs/check.log:2-4`: TypeScript exit 0; `Checked 18 files in 67ms. No fixes applied.`
  - `docs/check.log:450-451`: `Test Files 1 passed (1)`, `Tests 17 passed (17)`.
  - `docs/check.log:461-464`: Node `tests 6`, `pass 6`, `fail 0`.
  - `docs/check.log:504`: Playwright `10 passed (16.0s)`.
- `MSN_URL=https://msn.rodat-human-ada.workers.dev node --input-type=module -e "import {readFileSync} from 'node:fs'; process.env.MSN_ADMIN_TOKEN=JSON.parse(readFileSync('scripts/.secrets/production.json','utf8')).ADMIN_TOKEN; await import('./scripts/live-smoke.mjs');"`: exit 0, `LIVE SMOKE PASSED` (`docs/live-smoke.log:1-7`). Checks live assets, security headers, two tenant capabilities, two-way metadata, single poll, long-poll fan-out/wakeup/timeout, reread, pagination, concurrent writes, admin-only delete and rotation of active readers. It removes all its own test-message content; empty uniquely named test tenants and tombstones remain by design.
- A Node/Playwright live-browser script read the private workspace credentials, opened the deployed page in Chromium, connected as Tomas, checked history, captured desktop/mobile screenshots, invoked the actual CLI to read the same history, and disconnected. All assertions passed with zero JS errors (`docs/live-browser.log:1-3`).

## Review and limitations

Advisor consulted before architecture selection and before deployment. Follow-up changes added channel-scoped browser drafts/retry state with navigation-race regressions, rotation during streamed-body tests, hash-at-rest checks, metadata quotas and exact UTF-8 quota/deletion accounting. Source reviewed for parameterized SQL, synchronous read/register, auth recheck after awaits, restricted paths, XSS-safe rendering and credential handling. `docs/design.md` records current Cloudflare references and trust/scale assumptions.

Not run: Firefox/WebKit browser coverage (Chromium desktop/mobile covered), unbounded load/soak benchmarks (bounded concurrency tests and live smoke covered), Cloudflare PITR restore (no backup restoration claimed). No all-browser compatibility, exactly-once downstream delivery, per-user fairness or verified display identity is claimed. This is a mutually trusted workspace capability model, not a public anonymous chat service. Lifetime quotas cannot be freed by deleting content; use a new tenant when exhausted.

Expected test diagnostics: the deliberate rollback trigger logs a sanitized failure; `abortAllDurableObjects()` intentionally logs forced teardown exceptions in the restart test. Local workerd sometimes logs broken pipes when browser tests cancel long polls. These are visible in the unfiltered logs; all assertions, timer-cleanup tests and live tests pass. An attempted graceful eviction test timed out, so the explicit crash/restart test was retained rather than weakening its coverage.

Initial issues caught and corrected: DO SQLite does not support `PRAGMA user_version` (replaced by schema_version table); ESM-only Vitest plugin requires package type=module; Static Assets redirects `/guide.html` to `/guide` (live smoke explicitly checks this, retaining redirect rejection for credential-bearing APIs). Biome's migration produced preset=none, noticed and changed to preset=recommended before final checks.

## Formal completion blocker

The project is deployed and verified, but the optional Pi goal verifier was configured as the unregistered `grok/grok-4.6`. Task #1 check was rejected before artifact review. The verifier must be reconfigured with a registered provider/model using its startup environment variables, then task #1 must be rechecked before later tasks or goal completion. The agent has NOT disabled/modified the verifier, changed goal state manually, or bypassed this gate. User notified via Aimail. This section records harness state, not an application defect.

## Rust CLI live smoke — 2026-09-14

Against `https://msn.rodat-human-ada.workers.dev`, tenant `main`, via `fnox run -- ./cli/target/debug/msn …`. Tokens were not printed or written into the repo.

| Step | Result |
| --- | --- |
| `health` | `{"ok":true,"service":"msn"}` exit 0 |
| `channels` | 1 channel (`general`) |
| `create cli-smoke-1789421600` | `{"channel":"cli-smoke-1789421600","created":true}` |
| `send` (username `msn-cli-smoke`, text `hello from rust cli`) | message id 2, `replayed` false; UUIDv4 key on stderr |
| `poll --after 0` | 1 message, id 2 |
| `delete` ids 2 and 3 | both `{"deleted":true}` |
| `provision` / `rotate` throwaway `cli-smoke-1789421600` | 201 then 200; each response had a token (≥32 chars); tokens differed. Live `main` was not rotated. |

Follow (first attempt used `--after` and `--cursor-file` together and exited 2 before polling). Repeat on `cli-follow-1789421714` with `--cursor-file` only: send id 6 (`follow-arrives`) appeared as one JSON line; cursor file had `tenant=main`, `channel=cli-follow-1789421714`, `after=6`, mode `0600`; then `delete` id 6. No smoke message text remains on `main`. Empty uniquely named channels/tenants remain (no delete-channel API).

## Optional message payload typing (`contentType`, issue #5) — 2026-09-14

Verification contract: I1 existing sends stay `text/plain` (field omitted → `tests/api.test.ts::round-trips…`, `tests/cli.test.mjs::--text sends omit contentType`, `cli/tests/cli.rs::send_generates_uuid_key`); I2 invalid `--json` never reaches the Worker with exit 2 (`tests/cli.test.mjs::--json validates locally`, `cli/tests/cli.rs::send_json_invalid_exits_2_before_network`, `send_json_invalid_utf8_stdin_exits_2`, `tests/browser.spec.mjs` CLI exit-2 check); I3 Worker rejects `application/json` whose `text` is not JSON with 400 (`tests/api.test.ts::types application/json payloads…`); I4 inbox never interprets JSON as HTML (`tests/browser.spec.mjs::untrusted content is plain text…` posts an `application/json` body containing `<img onerror>` and `<script>` strings; asserts `<pre>` text, zero child elements, no `window.pwned`); I5 digest includes `contentType` (`tests/api.test.ts::includes contentType in the idempotency digest…`); I6 schema migration v2→v3 (`tests/api.test.ts::migrates a version-2 schema…`); I7 docs (`README.md`, `cli/README.md`, `public/guide.html`, ADR `docs/adr/0004-optional-message-content-type.md`).

Observed results (this checkout, Node 22, bun 1.4.2 for install, Rust 1.94 stable):

- `bun run typecheck`: exit 0. `bun run lint`: `Checked 18 files … No fixes applied.`
- `vitest run`: `Tests 20 passed (20)` (17 existing + 3 new Worker cases on real workerd SQLite DOs).
- `node --test tests/cli.test.mjs`: `pass 7, fail 0` (6 existing + 1 new).
- `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`: clean.
- `cargo test --test cli`: `40 passed` (35 existing + 5 new: `send_json_sets_content_type`, `send_json_invalid_exits_2_before_network`, `send_json_from_stdin`, `send_json_invalid_utf8_stdin_exits_2`, `send_text_and_json_conflict`). `cargo test --lib`: 17 pass plus 3 new `validate_json`/`read_json` cases; the pre-existing `cursor::tests::given_unreadable_cursor_when_load_then_generic` fails only because this container runs as root (a `0o000` file is still readable), on the unmodified tree as well; it is unrelated to this change and passes on CI's non-root runners.
- Playwright (`tests/browser.spec.mjs`, desktop + mobile Chromium against `wrangler dev`): `10 passed`. The first test now also sends `--json '{"op":"ping","task":42}'` through the real Node CLI, checks the inbox renders it pretty-printed in `<pre>` with an `application/json` marker, confirms `poll` reports `contentType` per message, and confirms an invalid `--json` exits 2. In this container Playwright 1.63 had to be pointed at the preinstalled Chromium via `launchOptions.executablePath` in a session-only config; the committed config is unchanged. Across three full runs, one mobile run failed the unmodified "network-uncertain sends preserve drafts" test: the live long-poll overwrote the status text after the deliberately aborted (but server-stored) send, before the assertion read it. That race predates this change and is not touched here.

Not run: live deployment smoke (no production credentials in this session); mutation testing (no mutator is configured for the Worker, and `cargo mutants` was not run).

## GitHub Release binary — 2026-09-14

- Tag: `v0.1.1` — https://github.com/thehumanworks/msn/releases/tag/v0.1.1
- Assets: four `msn-v0.1.1-<target>.tar.gz` plus matching `.sha256` for `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `x86_64-apple-darwin`, `aarch64-apple-darwin`.
- Downloaded `msn-v0.1.1-x86_64-unknown-linux-gnu.tar.gz` with `gh release download`, extracted under `/tmp` (not committed).
- `/tmp/.../msn --version` printed `msn 0.1.1`.
- `fnox run -- /tmp/.../msn channels` against the default Worker origin, tenant `main`, listed `general` plus leftover empty smoke channel names; exit 0. Tokens were not printed.
