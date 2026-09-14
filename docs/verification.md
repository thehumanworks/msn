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
