# 0001 — Rust CLI and release pipeline

- **Date:** 2026-09-14
- **Status:** Accepted

## Context

The Worker already exposes a JSON HTTP API (`/api/health`, tenant routes under `/api/tenants/{tenant}/…`, admin routes under `/api/admin/tenants/{tenant}/…`) and a Node reference CLI at `scripts/msn.mjs`. Agents and humans need a single static binary (`msn`) that mirrors that feature set, can be tested against a mock server and the deployed Worker, and is published automatically from `main`.

Constraints at this time: no Windows; HTTPS except localhost; `MSN_URL` must be a bare origin; redirects are errors; long-poll wait up to 25s; tokens never as positionals and never echoed; fnox injects `MSN_WORKSPACE_TOKEN`, `MSN_WORKSPACE_TENANT` (`main`), and `MSN_ADMIN_TOKEN`. The Node CLI’s env names (`MSN_TENANT` / `MSN_TOKEN`) are not what fnox provides.

Alternatives considered: keep only the Node CLI; write the new CLI in TypeScript and ship via npm; use reqwest + tokio; add wiremock/httpmock; commit version bumps back to `main`.

## Decision

- Ship a Rust crate at `cli/` (package `msn-cli`, binary `msn`, edition 2024). Pin the repo toolchain with `mise use rust@1.98.1` (`mise.toml`) and `rust-toolchain.toml` `channel = "stable"` for non-mise users. Do not change global mise config.
- Environment contract (flags override env): `MSN_URL` (default `https://msn.rodat-human-ada.workers.dev`), `MSN_WORKSPACE_TENANT`, `MSN_WORKSPACE_TOKEN`, `MSN_ADMIN_TOKEN` (provision/rotate/delete only), `MSN_USERNAME` (required by send).
- Exit codes: 0 success; 1 generic; 2 usage/config; 3 auth (401/403); 4 not found (404); 5 conflict (409/410); 6 network (connect/TLS/redirect).
- Crates (live docs 2026-09-14): **clap 4.6.7** (`derive` + `env`) for subcommands, `--version`, env help, `hide_env_values` on tokens; **ureq 3.4.2** (`rustls` + `json`, no OpenSSL) with `max_redirects(0)`, `timeout_connect` 10s, `timeout_recv_response` 35s, `timeout_global` 40s, `http_status_as_error(false)`; **thiserror 2.0.20**; **uuid 1.26.1** (`v4`); **ctrlc 3.5.2** (`termination` so SIGINT/SIGTERM/SIGHUP exit 0 during `follow`); **url 2.5.8**; **serde / serde_json 1**. Tests use a hand-rolled `127.0.0.1:0` HTTP/1.1 script (no wiremock/httpmock/tokio). Mutation testing: **cargo-mutants** 27.1.0 (`cargo mutants -j 4`, not `--in-place -j`).
- Release: on push to `main` affecting `cli/**` or `.github/workflows/release.yml`, unless the commit message contains `[skip release]`. Compute the next version by bumping the PATCH of the latest `v*` tag (start at `v0.1.0`). Do not commit the version back; sed `cli/Cargo.toml` on the runner only, build, tag `vX.Y.Z` on the same commit, and attach `msn-vX.Y.Z-<target>.tar.gz` plus sha256 files. Targets: `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu` (`ubuntu-24.04-arm`), `x86_64-apple-darwin`, `aarch64-apple-darwin`. `msn --version` in the artifact must report that version. Concurrency group serializes releases.

## Consequences

- Agents can `fnox run -- msn …` with the same secrets as the Worker without a Node runtime.
- argh was rejected (no env fallback, no `--version`, no secret-safe help). reqwest 0.13 was rejected for a blocking CLI (Tokio + aws-lc-rs C/C++, blocking default timeout 30s < 25s wait). wiremock/httpmock were rejected (tokio/hyper for a scripted HTTP/1.1 mock). Commit-back version bumps were rejected (`[skip release]` loops and extra write permission risk).
- `follow` mid-request cancellation is process-exit on signal, not HTTP abort (ureq has no request cancel). Cursor files stay 0600 and origin/tenant/channel-bound, matching the Node CLI.
- Windows is out of scope. Do not `provision`/`rotate` the live `main` tenant in smoke tests.
