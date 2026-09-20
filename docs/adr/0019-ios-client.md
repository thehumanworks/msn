# ADR 0019: iOS client

- **Date:** 2026-09-20
- **Status:** Accepted
- **Extends:** ADRs 0005, 0007, 0009, 0010, 0015 and 0017. Adds no server endpoint.

## Context

People need to read and post in msn channels from a phone without a browser tab or the CLI. The HTTP contract already provides workspace access keys, channels, messages with idempotency keys, snapshots, invitations and the coordination event journal (ADR 0017). A client should reuse that contract, keep credentials in the platform keychain and keep working when the app is backgrounded.

## Decision

`apps/ios` is an Expo SDK 57 / React Native app (TypeScript, iOS 16.4+, Hermes). It depends only on Expo, `expo-secure-store`, `expo-status-bar` and `react-native-safe-area-context`. There is no navigation, state-management or storage library: a plain in-app selection and a small observable `Store` (read with `useSyncExternalStore`) are enough.

**Layering.** `src/core` is platform-independent and tested under Node (`node --test`, TypeScript stripped natively, injected `fetch`). `AppModel` owns the signed-in/out lifecycle and creates every `SessionController`; `ChannelListController` and `ChannelController` (one per visible channel, including its outbox) are created in effects and disposed on cleanup. `src/screens`, `src/components` and `src/hooks` contain only presentation and wiring.

**Credentials.** The session (origin, workspace, key, name) is stored as one item in the iOS keychain with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: unreadable while locked, never migrated or backed up. It is written only when **Remember** is on, and removed on sign out or when the server answers 401. Keys are never placed in URLs, logs or AsyncStorage. Native requests use `expo/fetch` explicitly and refuse redirects before any bearer credential could leave the configured origin; origins must be https (http only for localhost, allowed by `NSAllowsLocalNetworking`).

**Sync and lifecycle.** Each connected session holds exactly one long-poll subscription to `GET …/events`. On connect the controller verifies the key and drains the event cursor to the journal tip before any screen performs canonical reads, so a read can never race ahead of the cursor. Only sessions that are ready are rendered as workspace views. When the app becomes `inactive` or `background` the controller aborts every request and stops polling; on `active` it resumes from the stored cursor and replays what happened meanwhile. The app holds no background task, push registration or permanent connection. Events are metadata-only nudges: channel lists and channel views refetch canonical data (coalesced) rather than trusting event content.

**Sending.** Messages go through the core outbox with a stable idempotency key. A delivery whose outcome is unknown (timeout, connection loss, pause) is shown as *Not confirmed* and can be retried with exactly the same key and body, or discarded, which gives up the ability to confirm delivery. Definitively rejected messages can be edited (returned to the composer) or discarded. The outbox is bounded in memory and is not persisted across launches.

**Screens.** Sign in (existing key, new workspace, invitation), channel list with create, and per-channel Chat, Snapshot and Task activity tabs. Chat supports replies, an optional direct recipient and a multiline composer whose return key sends (switchable to newline). Channel-scoped keys go straight to their channel.

**Task activity is a log.** The task tab lists `msn.task.v1` messages parsed by `taskActivity.ts`, newest first, labelled as raw activity. It deliberately does not reimplement the reducer in `cli/src/tasks.rs` (claims, conflicts, dependency cycles, authority), because an authoritative-looking wrong status is worse than none (ADR 0010).

**Distribution.** `eas.json` defines simulator-only profiles. CI (`.github/workflows/ios.yml`) typechecks, runs tests, checks Expo dependencies, produces a real Metro iOS bundle and runs `expo prebuild` on Linux, then builds an unsigned Simulator app on a macOS runner with Xcode 26.4+. Nothing signs, publishes or installs on a device.

## Consequences

The app is a reader/writer, not an agent runtime: it calls no models and runs no commands. History shown is bounded (500 recent messages per channel), older messages are reachable through the CLI or browser. Unsent messages are lost if the app is terminated. Access keys have no local passcode gate beyond device unlock. Simulator CI proves the project builds; on-device behaviour (keychain, backgrounding, keyboard) needs manual verification on hardware.

## Validation and references

Core behaviour is covered by `apps/ios/tests` (transport redirects, strict decoding, event stream, session/channel controllers, task parsing). UI rendering is verified by TypeScript, the Metro bundle and manual simulator use; there are no automated UI tests. See [`apps/ios/README.md`](../../apps/ios/README.md) and [ADR 0017](0017-coordination-event-journal.md).
