# 0002 — `msn wait`, `follow --once`, and a default cursor state directory

- **Date:** 2026-09-14
- **Status:** Accepted
- **Extends:** 0001 (Rust CLI contract)

## Context

Agents use msn as a cross-VM bus. The primitive they need between turns is "messages since I last looked": block until something new exists, print it, remember where we got to, exit. Agent runtimes cannot hold a process forever, so `follow` (never exits) is the wrong shape, and `poll --after ID --wait 25` (one page, 0–25 s) forces operators to track `--after` or cursor files by hand and to wrap it in an ad-hoc loop.

`follow` already has the right state: an atomically replaced, mode 0600 JSON cursor bound to server/tenant/channel. What is missing is a command shape around it and a place for that file to live when the caller does not name one.

Constraints at this time: the Worker long-poll cap stays 25 s; no WebSockets / hibernatable Durable Object sockets; no server-side per-client cursors; `--after` must not mix with `--cursor-file` (as for `follow`); a signal must never advance the cursor past ids that were not delivered on stdout.

Alternatives considered: teach agents a shell loop around `poll` (fragile, cursor tracking by hand); make `follow` exit on `--once` only (no default cursor location, still one line per message rather than the `poll` page); a server-side cursor per client (rejected: adds tenant state for a purely client-side concern); hashing the origin with `std::hash::DefaultHasher` (rejected: algorithm unspecified across Rust releases, so persisted paths would silently move); adding a hashing crate (rejected: FNV-1a is ten lines and needs no dependency research).

## Decision

- Add `msn wait CHANNEL [--wait 1–25] [--limit 1–100] [--after ID | --cursor-file PATH]`. It reuses `follow`'s long-poll loop (25 s bound, 1 s→15 s backoff on 429/5xx/transport errors, redirects fatal, other 4xx fatal with the existing exit codes). Empty pages keep polling. The first page with at least one message is printed verbatim on stdout (same `{messages,nextCursor,hasMore}` schema as `poll`), `nextCursor` is persisted atomically (0600, bound to server/tenant/channel), and the process exits 0.
- Default cursor file when neither `--after` nor `--cursor-file` is given: `$XDG_STATE_HOME/msn/<origin-hash>/<tenant>/<channel>.json`, falling back to `$HOME/.local/state/msn/…`. `<origin-hash>` is FNV-1a 64 of the ASCII origin serialization, 16 lowercase hex digits. Parent directories are created on demand. Missing `HOME` and `XDG_STATE_HOME` is a usage error (exit 2) pointing at `--cursor-file` / `--after`.
- `--after` disables cursor files for that run (nothing read or written). `--after` with `--cursor-file` is a usage error, as for `follow`.
- Add `msn follow CHANNEL --once`: identical to `follow` but exits 0 after the first non-empty page has been printed and the cursor persisted.
- Ordering inside the shared loop: deliver the page to stdout, then persist the cursor. SIGINT/SIGTERM (via `ctrlc` with `termination`) exits 0; the cursor file is only ever replaced by rename, so an interrupt can leave a stale `.tmp` sibling or replay a page, but never corrupts the file and never skips ids.

## Consequences

- `msn wait general` twice in a row prints two disjoint batches with no operator bookkeeping; a first run with no prior cursor behaves like `poll --after 0 --wait 25` repeated until a message exists.
- One default cursor file per (origin, tenant, channel) per user. Two concurrent readers that must not share a position should pass distinct `--cursor-file`s; sharing the default file is at-most-once between them, not fan-out.
- The default state directory is a client-side contract: changing the hash function or layout later requires a superseding ADR and a migration note, because existing agents would otherwise restart from id 0.
- Delivery remains at-least-once on the consumer side (replay after interrupt is possible); deduplicate by tenant/channel/id when that matters, as already documented for `follow`.
- Non-goals recorded: WebSockets / hibernatable DO sockets (later upgrade path, not blocked by this), raising the 25 s Worker cap, server-side per-client cursors, a `wait` command in the Node reference CLI (`scripts/msn.mjs`).
