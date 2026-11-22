# ADR 0079: sign in to the iOS app with Cloudflare Access

Date: 2026-11-22. Status: implemented (Worker and `apps/ios-next`), not yet deployed. Adds one route option, one endpoint and one Durable Object table; no change to the Access application.

## Context

The owner asked for Cloudflare Access sign-in in the iOS app. The web app signs in by opening `/login`, which only an Access application covers. The Worker verifies the `Cf-Access-Jwt-Assertion` (signature against the team's JWKS, issuer, audience, expiry), opens an owner connection for the account derived from issuer and subject, and redirects to `/#account=CONNECTION`. That puts the account key in a URL, which a native app cannot receive and which the apps must never do. The CLI instead exchanges an Access token from `cloudflared` at `POST /api/account/login`, which a phone cannot run.

Options considered:

- **Embedded web view** watching for `/#account=`. No server change, but Google and other identity providers refuse embedded browsers, and the key still travels in a URL.
- **Universal-link callback** (`ASWebAuthenticationSession` with an https callback). Needs an Apple app-site-association file and the Associated Domains entitlement, still delivers the key in a URL, and cannot be exercised against a local Worker.
- **One-time code with a verifier**, as in OAuth's PKCE (RFC 7636) for native apps (RFC 8252). Chosen.

## Decision

- **The app opens `/login?app=CHALLENGE` in the system sign-in sheet** (`expo-web-browser`'s `openAuthSessionAsync`, which is `ASWebAuthenticationSession`), so the person's Safari session, passkeys and identity provider work as on the web. `CHALLENGE` is the lowercase hex SHA-256 of a 32-byte random verifier that never leaves the app until the exchange.
- **The Worker answers with a code, not a key.** After verifying Access exactly as for the web sign-in, `/login?app=` stores a single-use code in the account's Durable Object (`app_logins`: code hash, challenge, email, expiry) and answers `303 msn://login?account=ACCOUNT&code=CODE`. A malformed challenge is a 400. Codes live two minutes, at most 20 may wait per account, and expired rows are deleted whenever a code is stored or spent.
- **`POST /api/account/app-login` trades `{account, code, verifier}` for the owner connection** the web sign-in opens (`{url, tenant, username, token, owner}`). The code is spent on the first attempt, right or wrong, and the verifier's hash must match the stored challenge. Cross-origin browser callers are refused, as for `/api/account/login`.
- **Refusals cross Durable Object RPC as values.** An `HttpError` thrown in the object reaches the Worker as a plain error and would answer 500, so the two new RPC methods return `{refused: {status, code, message}}`, which the Worker turns back into the HTTP error.
- **`/login` on another hostname keeps the challenge.** The redirect to `ACCESS_LOGIN_URL` forwards a well-formed `app` parameter and still drops everything else.
- **The app checks what comes back.** It accepts only `msn://login` with a well-formed account and code, posts only to the origin it started from, and refuses a connection for another origin or account. The button shows only when `/api/account/config` reports `cloudflareAccess: true`. The key then goes through the shared `signInWithKey`, which checks it and saves it to the keychain.

## Consequences

- If someone sends the owner a sign-in link with their own challenge, the code goes to the owner's phone, and the sender has no code to use. A code that leaks from the phone is useless without the verifier.
- Each app sign-in creates an owner key, like each web or CLI sign-in. Signing out of the app does not revoke it.
- The Access application needs no change: Access ignores query strings when matching application paths.
- Tested with Worker tests (exchange, single use, wrong verifier, expiry, quota, malformed input, the redirect hop, and `/login?app=` without or with a forged assertion) and app tests against a fake server and sign-in sheet. A real Access sign-in can only be checked after deploying, on a device signed in to the team.
