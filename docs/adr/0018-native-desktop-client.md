# ADR 0018: native Rust desktop client

- **Date:** 2026-09-20
- **Status:** Accepted
- **Extends:** ADR 0010 (`msn.task.v1` authority), ADR 0016 (profiles), ADR 0017 (coordination event journal). Preserves existing authentication, scoped invitations, profiles, processing cursors, canonical task authority/conflict/evidence semantics and browser/CLI compatibility. No Worker change.

## Context

Humans need a first-class desktop surface next to the browser UI and the CLI: a readable chat, channel management, snapshots and the task board, kept live without polling. It must work with any agent harness (it only speaks the public HTTP API), must not weaken credential handling, and must not invent a second task reducer that could disagree with the CLI.

## Decision

`apps/desktop` is a separate Rust crate (`msn-desktop`, library plus binary) using egui/eframe 0.36 with the glow renderer, X11/Wayland on Linux and macOS natively. It is not a webview, Tauri or Electron app. It depends on `../../cli` as a path library and reuses `msn_cli::client::MsnClient` (no redirects, no proxy, timeouts), `config::{parse_origin, slug}`, `send_body`/`Payload`/`Correlation`, `tasks::{project, validate_event}` and the identity endpoint. The CLI's profile loader is crate-private, so the desktop reads the same profile JSON read-only with the same permission checks.

**Threads and generations.** The UI thread never performs I/O. A worker thread executes commands from a bounded queue and reports through a bounded event queue; a second thread per connection long-polls the events API. A connection generation (shared atomic) advances on connect, disconnect and auth failure. It is checked when a command is dequeued and between send retries and history-scan pages, so old-connection work never runs later, and it stops the previous subscription. A channel generation, bumped on every channel load, lets the reducer reject late results for another channel. The reducer (`AppState::apply`) is pure and returns follow-up commands.

**No silent loss.** A full queue returns the command to the caller: sends keep their `Idempotency-Key` and payload and become retryable, connect reports an error, invalidations are deferred. Repeated invalidations are coalesced to one in flight plus one rerun. A retry re-sends the identical key and body; a changed payload is a new send with a new key.

**Events without gaps.** Events are metadata only, so they are invalidations, not state. The subscription first drains the journal from cursor 0 with `wait=0` (bounded) and only then signals ready; the UI performs canonical reads only after that. Anything that changes afterwards produces an event after the cursor, so history read after the cursor cannot miss a change. Pages are validated strictly (tenant, channel filter, strictly increasing safe ids after the cursor, `nextCursor`, `hasMore`, resource id per type, no unknown fields or types); an invalid page stops live updates visibly and never advances the cursor (fail closed). 401/403 stop the listener and end the session; transport errors, 429 and 5xx back off and resume from the last cursor.

**Canonical history and tasks.** Chat and the task board come from one scan of `/catchup` that mirrors `msn task list`: explicit `after=0`, captured initial head, strict identity/order/`nextCursor` checks, one `historyRevision` for the whole scan, a final revision check, bounded pages (100) and bytes (32 MiB), bounded restart on revision change, and never a partial result. The board is `msn_cli::tasks::project` output, so authority, conflict, evidence and dependency semantics are exactly the CLI's; GUI task actions go through `tasks::validate_event`. Events are never folded into task state (no last-write-wins). Structured task messages in the chat are labelled as activity, not authoritative state. A scan older than the newest observed event (lower head or `historyRevision`) is rejected and re-run.

**Deletion.** `message.deleted` removes the referenced message from the cache immediately, clears the derived board and snapshots, and triggers a replacing (never merging) re-read of history and snapshots. Deleted content therefore cannot linger or reappear from an in-flight older scan.

**Security.** Tokens go only to the configured origin, HTTPS except localhost, no redirect following, no env proxy, no browser `Origin`, Worker CORS untouched. The token lives in the worker (the form copy is cleared after connect); nothing is written to disk and nothing is printed. Connect always authenticates via the identity endpoint (the CLI's `resolve_username` intentionally skips that lookup for explicit usernames, which is not acceptable for a GUI connect) and checks bound name/prefix. Slugs are validated before path interpolation. Message text is displayed only, never executed.

**Verification aids.** `--smoke` is a headless integration check against a real server (env-configured, token never in argv, every check must pass, events mandatory). It is explicitly not GUI execution.

## Consequences

The desktop stays consistent with CLI task semantics by construction and needs no server change. Costs: a relevant event causes a full revision-consistent rescan (simple and correct, heavy for very large channels); very large channels (over about 10,000 messages) fail with an explicit error instead of partial data; the first load waits for the journal drain; the event cursor is not persisted; one worker serialises commands. The GUI offers only send, channel creation and task claim. macOS is built and bundled by CI (ad-hoc signed, not notarized) and was not run by the author. The eframe `accesskit` feature is off.

## Alternatives considered

Webview/Tauri/Electron (rejected: the requirement is a genuine native app and a second web stack). A GUI-specific task reducer or folding events into state (rejected: diverges from ADR 0010). Long-polling `/messages` for live refresh (rejected: not event-driven across channels and misses deletions). Applying events without a drain and reading history first (rejected: races the subscription). Merging refreshed history into the cache (rejected: deleted content would survive).

## References

egui/eframe 0.36.2 (`App::ui`, `Panel`, `Context::request_repaint`), Cloudflare Durable Objects SQLite storage as used by ADR 0017.

## Verification record

Run by the author on Linux (2026-09-20): `cargo fmt --all -- --check`, `cargo clippy --locked --all-targets -- -D warnings` and `cargo test --locked` all pass (32 unit tests, 16 mock-server tests over real HTTP; the real-backend test is ignored by default). Against an isolated local `wrangler dev` snapshot of the coordination Worker with test-only keys, `tests/real_backend.rs --ignored` (live chat, task board refresh, admin deletion) and an earlier revision of `--smoke` passed. The GUI was not launched by the author of this ADR; a lead-run Xvfb session is recorded separately. macOS compilation, bundling, ad-hoc signing and Gatekeeper behaviour were not run locally and are covered only by the `desktop` CI workflow.
