# Message board verification — 2026-09-21

Implemented on `feat/channel-message-board` in the existing checkout. The pre-existing `mise.lock` change was preserved and is not part of this implementation. No production credentials were used for the following checks.

| Check | Result |
| --- | --- |
| Rust CLI tests | 277 passed |
| Rust format and strict Clippy | Passed |
| Worker typecheck and Biome | Passed |
| Worker/API/JWT suite | 88 tests passed, including legacy migrations and channel-scope regressions |
| Existing JavaScript CLI/dispatcher tests | 40 passed |
| Host state/process/runtime suite | 59 passed |
| Browser suite | 68 passed, 2 existing platform-specific skips; desktop and mobile account/shared-persona flow checked |
| CLI board integration | Passed against an isolated local Worker with the actual Rust binary and its embedded executable runtime |
| Desktop Rust build and library tests | Build passed; 36 tests passed |
| iOS TypeScript and core tests | Typecheck passed; 124 tests passed |
| Diff whitespace check | Passed |

The CLI integration creates/reopens a portable account, creates a board, adds personas that share its credential, checks sibling-channel denial, exports/imports the owner connection, and reads the account's channel directory through the imported connection. A real `msn wait --wait 25` returns promptly on a new message. A generic executable suspends for a peer, receives a different human conversation immediately, performs a durable goal continuation, and publishes one result. Restarting the runner reuses state without another execution or duplicate output.

The systemd integration uses a fake `systemctl` executable: it checks service installation arguments and the generated unit, including profile-based access and absence of channel/account secrets. It does not install or start a service on this machine. Existing real-process host tests cover termination, disconnected supervisor cleanup, outbox retries and recovery grace. Additional state tests cover an unrelated channel message ending a suspended peer wait and incoming input superseding a delayed continuation after restart.

Signed-login tests use real generated RSA keys and JWT verification, rejecting wrong signatures, audiences, issuers and expired assertions. They do not contact a live Cloudflare Access application. The configured team domain/audience and human allow policy are required before deployment of the optional SSO flow. Native clients support the portable account fallback; no native OAuth callback or native GUI launch was verified.

Initial browser regressions came from the new file input's accessible name also matching the old generic “Connect” locator. The input was renamed and the full suite rerun successfully. Worker migration expectations were advanced to schema 10, including resetting every later schema marker when simulating v8. A control-message size check also covers goals whose JSON escaping would otherwise exceed the message wire limit; the board retains the full goal while notifications carry a bounded preview.

The checks above are local source/build/integration evidence. The installed global `msn` binary has not been replaced; the tested updated CLI is `cli/target/debug/msn`.

## Production deployment — 2026-09-22

Deployed the Worker and web client to <https://msn.rodat-human-ada.workers.dev> using `fnox run -- bunx wrangler deploy --keep-vars`. Cloudflare reports 100% traffic on version `a7b60d9d-57a4-4f7b-9bd2-a3a3351ec601`. Existing bindings and secrets were retained. A deployment dry run, TypeScript, Biome and whitespace checks passed. The served `index.html` and `app.js` match the local source byte for byte.

The actual Rust CLI and embedded runner passed the same board integration against production: owner account creation/retry, shared persona credentials, channel isolation, cross-client account import, prompt wake from a 25-second wait, a new conversation interrupting a suspended peer wait, autonomous goal continuation, and restart without duplicate output. This used a deterministic generic executable, not a model provider. Its test messages were deleted and its test credentials revoked afterward; an empty test account/channel remains. Existing production workspace credentials still authenticate and list all seven existing channels.

To repeat the isolated-account production check with credentials supplied by the host's secret manager:

```sh
MSN_BOARD_TEST_URL=https://msn.rodat-human-ada.workers.dev fnox run -- node tests/board.integration.mjs
```

Without `MSN_BOARD_TEST_URL`, the integration still starts an isolated local Worker. Live mode requires HTTPS and `MSN_ADMIN_TOKEN` solely to clean up its newly created test account's messages and revoke its credentials. It never reuses an existing account profile. The simulated systemd check remains simulated in both modes.

The legacy live smoke also passed health/assets/security headers, tenant isolation, bidirectional messaging, fan-out wakeups, timeout/pagination, concurrent writes, admin deletion and revocation of pending polls. Its old home-page text assertion was updated for the message board heading before rerunning it.

Cloudflare Access is not configured (`/api/account/config` reports `cloudflareAccess: false`); portable account connections are available. No live model-backed conversation, actual user-service activation, native application distribution or published CLI release is claimed.

## Access configuration and login routing — 2026-09-22

Configured the supplied `nothumanlabs.cloudflareaccess.com` team domain and application audience as plain Worker variables, and attached `msn.thehuman.sh` as a Custom Domain. This supersedes the unconfigured Access status above. The existing Access application protects `msn.thehuman.sh/login`; the original `workers.dev` address remains available to existing profiles and agents. Worker version `8200a850-d32c-44af-968b-bd899f27fc7f` includes these settings and preserves preview URLs.

The original `login_required` loop occurred because `/login` on `workers.dev` reached the Worker without an Access assertion. `ACCESS_LOGIN_URL` now directs the web link and alternate-host `/login` requests to the protected custom domain. Missing assertions produce a configuration-oriented error instead of telling the caller to reopen the same URL. The redirect destination is validated and comes only from deployment configuration; caller query parameters are discarded. API login remains a JSON endpoint and does not redirect.

Type generation, TypeScript, Biome, JavaScript syntax and whitespace checks passed. The targeted Worker/API/account suite passed 44 tests, including canonical redirects, destination validation, unsigned identity rejection and real JWT verification. Production checks confirmed the canonical redirect, configured login URL, API authentication and rejection of spoofed identity headers. Public Cloudflare DNS resolves the new hostname; an HTTPS request using that published address and normal certificate verification returned an Access sign-in redirect for `/login`, and HTTP 200 for the home page and API health. This host's system resolver still cached the earlier missing hostname during verification.

The Access application had no Allow policy at the time of verification. The intended sign-in email was requested; no email policy was inferred or created. A completed human SSO session remains unverified until that policy is configured and the human signs in.
