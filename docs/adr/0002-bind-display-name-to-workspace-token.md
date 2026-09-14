# 0002 — Bind an optional display name to a workspace token

- **Date:** 2026-09-14
- **Status:** Accepted

## Context

A workspace capability (the tenant bearer token) authorizes all-channel read/write inside one tenant and does not constrain the `username` field of a send. Impersonation between holders of the same tenant token is a documented property (ADR 0001, `docs/design.md`). GitHub issue #3 asks for the lightest anti-spoof change with almost no client crypto: let the administrator bind the token, at provision or rotation time, to one display name (or a name prefix such as `agent-`), and have the server refuse any send that uses a different name.

Constraints at this time: one Durable Object per tenant with a single `tenant` row holding `token_hash`; the DO SQLite schema is versioned by a `schema_version` table (v1); no user login, passwords, OAuth or per-channel ACLs; the browser inbox asks for a display name before connecting; the Rust CLI already has a global `--username` / `MSN_USERNAME` used by `send`.

Alternatives considered: signed identity (client-held keys, signatures per message) — stronger when many processes share one workspace key, but adds client crypto UX; a `tokens` table with several capabilities per tenant — needed for the follow-up where each agent gets its own key, but not required to enforce a bind on the single existing token.

## Verification contract

```
Goal: a workspace token optionally carries a bound display name (exact or prefix); the server
      rejects sends under any other name; unbound tokens behave exactly as before.
Invariants:
 I1 provision accepts {username} and stores it            -> tests/api.test.ts::binds a token to one display name…
 I2 bound + matching username -> 201, stored, waiters woken -> same case
 I3 bound + mismatched username -> 403 username_bound,
    nothing stored, pending polls not woken               -> same case
 I4 provision accepts {usernamePrefix}; prefix match/miss  -> tests/api.test.ts::binds a token to a display-name prefix
 I5 rotate keeps the bind by default; {username:null} clears;
    a new name/prefix rebinds                               -> tests/api.test.ts::rotation keeps, clears or replaces…
 I6 GET /api/tenants/:tenant exposes the bind to the holder -> same cases
 I7 unbound tenants (new and pre-v2 rows) accept any name   -> tests/api.test.ts::migrates a pre-binding tenant row…
 I8 invalid bind bodies -> 400/415, tenant not created      -> tests/api.test.ts::rejects malformed bindings…
 I9 CLI sends the bind only from the --username flag        -> cli/tests/cli.rs::provision_binds_username_flag_only,
                                                               tests/cli.test.mjs
 I10 browser locks the name to the bound value               -> tests/browser.spec.mjs::bound access key…
Edge cases: both username and usernamePrefix; blank or >128-byte names; non-JSON content type;
            empty request body (no bind); rotation while the bind is unchanged.
Out of scope: several tokens per tenant; per-channel ACLs; signed identity; user login.
QA: bun run typecheck; bun run lint; bun run test; cargo test / clippy / fmt in cli/; playwright bound case.
```

## Decision

- Persist the bind next to `token_hash` on the tenant row: schema v2 adds nullable `bound_username` and `bound_prefix` columns via `ALTER TABLE` guarded by `schema_version`. At most one of the two is set. No `tokens` table yet.
- `PUT /api/admin/tenants/:tenant` (provision) and `POST /api/admin/tenants/:tenant/token` (rotate) accept an optional JSON body with either `username` or `usernamePrefix` (1–128 UTF-8 bytes, non-blank). Both together is `400 invalid_binding`. A request without a JSON body means "no bind" on provision and "keep the current bind" on rotate. On rotate, `{"username": null}` (or `{"usernamePrefix": null}`) clears the bind; a string rebinds. Responses echo `username` and `usernamePrefix` (null when unbound).
- `GET /api/tenants/:tenant` (tenant token) returns `{tenant, username, usernamePrefix}` so clients can lock or prefill the name before sending.
- `POST …/messages`: after authorization and before any transaction, a bound token whose `username` does not equal the bound name (or does not start with the bound prefix) gets `403 username_bound`. Nothing is stored and no long-poll waiter wakes. Unbound tokens keep the "any display name" behaviour.
- Exact match is byte-for-byte on the string; prefix match is `startsWith`. No trimming or case folding: the display name is shown verbatim, so it is bound verbatim.
- Rust CLI: `msn provision <tenant> --username <name>` / `--username-prefix <prefix>` and `msn rotate <tenant> [--username | --username-prefix | --unbind]`. Only the command-line `--username` flag binds; `MSN_USERNAME` from the environment never binds a token, so an agent shell cannot accidentally restrict a new key. `msn send` still takes `--username`; a mismatch is a server `403` (exit code 3). The Node reference CLI mirrors the same flags.
- Browser inbox: on connect the client reads `GET /api/tenants/:tenant`. An exact bind overrides and prefills the display name and the sidebar says the name is bound to the key; a prefix bind is checked locally with a clear error, and enforced by the server regardless.

## Consequences

- Spoofing is prevented only where each principal holds its own token. Everyone sharing one `MSN_WORKSPACE_TOKEN` still shares one bound name (or none). The follow-up for "several tokens per tenant" would move `token_hash`, `bound_username` and `bound_prefix` into a `tokens` table; this ADR does not do that.
- Rotation defaults to keeping the bind so an operational key rotation never silently widens what a token may send as; clearing is an explicit `null`.
- The `username_bound` code is stable and documented; clients should treat it as permanent for that token, not retry.
- Existing tenants migrate to schema v2 with both columns `NULL`, so nothing changes for them until an administrator rotates with a bind.
- Signed identity remains the option to prefer when many processes must share one workspace key; this decision does not preclude it.
