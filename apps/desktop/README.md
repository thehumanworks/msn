# msn desktop

A native Linux and macOS client for msn, written in Rust with [egui/eframe](https://docs.rs/eframe/0.36.2/eframe/) (glow/OpenGL renderer, X11 and Wayland on Linux, AppKit on macOS). It is not a webview, Tauri or Electron app. It reuses the [`msn-cli`](../../cli) crate as a library for the HTTP client, origin/slug validation, the send body, and the authoritative `msn.task.v1` task projection (`msn_cli::tasks::project`, ADR 0010).

Design and trade-offs: [ADR 0018](../../docs/adr/0018-native-desktop-client.md). It consumes the coordination events API from [ADR 0017](../../docs/adr/0017-coordination-event-journal.md).

## What it does

- **Connect** with origin, workspace, access token and optional username, or pick an existing `msn profile` (read-only reuse). Connecting always authenticates against the workspace identity endpoint, even when you type a username, and checks the name against the key's binding.
- **Channels**: list, create, select. Names come from the server's `name` field and are validated as slugs before they reach a URL.
- **Chat**: canonical history, live refresh, directed recipient (`to`) and reply (`replyTo`), Enter to send. Every send has a stable `Idempotency-Key`; a failed or uncertain send keeps its key and payload and is retried with the same bytes. Editing the text creates a new send with a new key.
- **Snapshots**: the snapshot list and the latest valid snapshot text.
- **Tasks**: a board projected from canonical history by the CLI's own reducer, showing effective state, asserted state, owner, reviewer, dependencies, evidence, conflicts and warnings. Delivery of a message never implies task completion. The only task action in the GUI is **Claim**; other actions stay in `msn task`.
- **Live updates** come from `GET /api/tenants/:tenant/events` (server long-poll, no periodic scans). Events are metadata only; every relevant event triggers a canonical re-read.

## Build and run

Requires Rust 1.95 or newer (eframe/egui 0.36 need it).

```sh
cd apps/desktop
cargo build --release --locked
target/release/msn-desktop
```

Linux build dependencies (Debian/Ubuntu names): `pkg-config libxkbcommon-dev libwayland-dev libx11-dev libxcursor-dev libxi-dev libxrandr-dev libxcb1-dev libgl1-mesa-dev libegl1-mesa-dev`. A working OpenGL driver is needed at runtime (Mesa software rendering is enough).

Install the desktop entry with `install -Dm644 packaging/linux/msn-desktop.desktop ~/.local/share/applications/msn-desktop.desktop` and put the binary on `PATH`. There is no icon yet.

### macOS app bundle

```sh
packaging/macos/build-app.sh              # native architecture
UNIVERSAL=1 packaging/macos/build-app.sh  # arm64 + x86_64
```

This produces `target/macos/msn desktop.app`, ad-hoc signed and **not notarized**, so expect macOS to require manual approval on first launch (that behaviour has not been verified by the author). The script and the macOS build run in CI on `macos-latest` (`.github/workflows/desktop.yml`); they have **not** been executed on a Mac by the author of this change. Developer ID signing and notarization are out of scope.

## Security model

- The token is entered or read from a profile, kept in memory for the session, and sent only to the configured origin as `Authorization: Bearer`. After connecting, the network worker is the only holder; the form's copy is cleared and UI state holds no credentials. The app never writes tokens or any state to disk and never prints them. Rust `String`s are not zeroized; this is not a defence against a local memory dump.
- HTTPS is required. Plain `http://` is accepted only for `localhost`, `127.0.0.1` and `::1` (`msn_cli::config::parse_origin`). The origin cannot contain credentials, a path, a query or a fragment.
- Redirects are never followed, so credentials cannot be forwarded to another host. Environment proxies are ignored. Native requests carry no browser `Origin` header; the Worker's CORS policy is unchanged.
- Profiles are read from `$XDG_CONFIG_HOME/msn/profiles` or `~/.config/msn/profiles` only if the directory is `0700` and the file is a regular, non-symlink `0600` file, matching the CLI. The app never writes profiles.
- Message, snapshot and task text is only displayed. It is never interpreted or executed as a command.
- Tenant and channel identifiers are validated with `msn_cli::config::slug` before path interpolation.

## Concurrency and correctness

All network I/O runs on background threads with bounded queues (32 commands, 256 UI events). A connection generation advances on connect, disconnect and auth failure; queued work of an older generation is skipped when dequeued, in-flight sends and history scans stop at their next step, and the previous events subscription exits. A channel generation is bumped on every channel (re)load so a late response for another channel or an earlier load is discarded. A full command queue hands the command back: sends keep their key and payload and show Retry; invalidations are deferred and repeated invalidations are coalesced.

Startup order avoids a history/subscription race: the subscription first drains the event journal silently to establish its cursor (`EventsReady`), and only then does the UI read channels or history, so a change after the cursor always yields an event. Events are validated strictly (tenant, channel filter, strictly increasing safe ids, `nextCursor`, `hasMore`, resource id per type); an invalid page stops live updates with a visible notice and never advances the cursor. Transient errors back off (1s to 15s) and resume from the last cursor; 401/403 stop the listener and return to the connect screen.

`message.deleted` immediately removes that message from the cache, clears the derived task board and snapshots, and re-reads canonical history. History is scanned exactly like `msn task list` (`after=0`, captured head, strict order/identity/`nextCursor`, one `historyRevision`, final revision check, bounded pages and bytes, never a partial result). A scan result older than the newest event seen is rejected and re-run. `message.created` refreshes chat and the board together.

The GUI redraws only when an input event or a background result arrives; there is no timer-driven repaint loop while idle (egui spinners animate only while something is loading or connecting).

## Headless smoke test (not a GUI test)

```sh
MSN_URL=https://… MSN_WORKSPACE_TENANT=… MSN_WORKSPACE_TOKEN=… [MSN_USERNAME=…] \
  target/release/msn-desktop --smoke
```

Runs the same client code against a real server without a window: authenticated connect, event drain, channel create/list (by `name`), a send with an `Idempotency-Key`, a replay of the same key/body (must return the same message id with `replayed: true`), an exact point-read of the sent message, a revision-consistent history scan, a server long-poll that must be woken by the send, and a check that the replay produced no duplicate event. Every check must pass; the events endpoint is mandatory and there is no skip. The token is read from the environment, never argv. It is a terminal diagnostic and does not exercise the GUI.

## Tests

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

- Unit tests: strict event-page validation, history scan validation, send-outcome parsing, the reducer (stale generations, replay/dedupe, coalescing, deletion purge, retry keys, rejected commands, auth teardown, cursor gating).
- `tests/mock_server.rs`: the real worker, reducer and HTTP client against a stateful fake Worker over real HTTP (auth and binding, idempotent send and retry key reuse, cancellation, paging, deletion, long-poll wake, idle repaint count, queue-full handback, revocation, invalid pages, end-to-end live chat/board/deletion).
- `tests/real_backend.rs` (ignored by default): the same flow against a real Worker, including admin deletion. Run it against a local `wrangler dev` with test-only tenant and keys:

  ```sh
  MSN_URL=http://127.0.0.1:8787 MSN_WORKSPACE_TENANT=t MSN_WORKSPACE_TOKEN=k MSN_ADMIN_TOKEN=a \
    cargo test --test real_backend -- --ignored
  ```

## Limitations

- Channel history is capped at 100 catchup pages (about 10,000 messages) and 32 MiB per scan; beyond that the load fails with an explicit error instead of showing partial data. The chat keeps the latest 2,000 messages in memory.
- Each relevant event triggers a full revision-consistent rescan (chat and board share it, coalesced). This is simple and correct but heavy for very large channels.
- Initial event-cursor establishment drains the journal in pages of 100 (bounded at 2,500 pages, above the server's capacity). A very large journal delays the first channel load.
- One sequential network worker: a slow request briefly delays later queued commands. Send retries are bounded (3 attempts).
- The event cursor is in memory only; a restart re-drains, then reads canonical state.
- GUI actions are limited: send, create channel, claim task. No snapshot publishing, no other task actions, no attachments, single-line composer.
- No system tray, notifications, or background operation. The eframe `accesskit` feature is disabled to keep dependencies small, so screen-reader support is not provided.
- The macOS bundle and macOS build are verified only by CI configuration, not by the author. Windows is not supported.
