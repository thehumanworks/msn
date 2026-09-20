# msn for iOS

An Expo SDK 57 / React Native client for msn workspaces: sign in, browse channels, read and send messages, read snapshots and see raw task activity. Design and rationale: [ADR 0019](../../docs/adr/0019-ios-client.md).

Requirements: Node 24 (22.18+ works; older Node needs `--experimental-strip-types` for the tests), and for native builds macOS with Xcode 26.4+ (iOS 16.4+ deployment target).

## Commands

Run from `apps/ios` after `npm ci`.

| Command | Purpose |
|---|---|
| `npm run typecheck` | App and test TypeScript (`tsc`) |
| `npm test` | Core tests: `node --test tests/*.test.ts` |
| `npm run check:deps` | `expo install --check` |
| `npm run export:ios` | Real Metro iOS bundle into `dist-ios/` (ignored) |
| `npm run prebuild:ios` | Generates `ios/` (ignored); proves the native project generates |
| `npm run ios` | Build and run in the iOS Simulator (macOS) |

Native build on a Mac:

```sh
npm ci
npm run prebuild:ios
cd ios && pod install
xcodebuild build -workspace MSN.xcworkspace -scheme MSN -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO
```

`eas.json` has `development` and `simulator` profiles that build for the Simulator only. No signing credentials, publishing or device install are configured. Change `ios.bundleIdentifier` in `app.json` (`dev.msn.ios` is a placeholder) before any signed distribution.

CI: `.github/workflows/ios.yml` runs typecheck, tests, dependency check, Metro export and prebuild on Linux, then an unsigned Simulator build on `macos-26`, failing if Xcode is older than 26.4.

## Using it

1. **Access key:** server origin, workspace, key and (if the key does not fix one) a display name.
2. **New workspace** or **Invitation:** create a workspace, or redeem an invitation code, when the server allows it.
3. Pick or create a channel. Tap a message to reply to it; add an optional recipient. Return sends; **Return key** switches to a newline. Messages that are not confirmed show **Retry** (same idempotency key and body) or **Discard**.
4. **Sign out** stops syncing and deletes the remembered key.

## Security

- The key is stored only in the iOS keychain (`expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`), and only if **Remember** is on. No AsyncStorage, logs, URLs or analytics.
- https origins only (http for localhost development). Requests use `expo/fetch` with redirects refused, so the bearer key cannot follow a redirect off the configured origin.
- A 401 from the server signs the app out and removes the saved key.
- The app sends no requests to any host other than the origin you enter, calls no models and executes no commands.

## Lifecycle

One long-poll event subscription per signed-in session. It runs only while the app is `active`; `inactive` and `background` abort all requests and pause. On return the app replays events from its stored cursor and refetches affected data. There is no background task or push notification, so nothing arrives while the app is not in the foreground.

## Limitations

- The outbox lives in memory: unsent or unconfirmed messages are lost if the app is terminated.
- Each channel shows at most the 500 most recent messages; older history is not paged in.
- Task activity is a raw log of `msn.task.v1` messages, not an authoritative board. Use `msn` CLI for effective task state.
- No push notifications, attachments, message deletion or editing, or multiple simultaneous accounts.
- Tests cover the core (transport, decoding, events, controllers). Screens are checked by typecheck and the Metro bundle only; there are no automated UI tests, and the app has not been run on a device by this change.

## Real Worker acceptance

After installing the repository-root dependencies, `npm run test:worker` launches an isolated local Wrangler Worker with temporary storage and fake keys. It exercises the actual iOS API/session/channel controllers against the implemented server, not a mocked API. It checks named channels, directed send, exact key/body replay, pause while inactive, replay on resume, no duplicate messages and termination after workspace-key rotation.

Observed on Ares/Linux: all acceptance checks passed, with two canonical messages and zero duplicates. This validates the controllers and HTTP contract under Node's injected transport; it is **not** evidence of running UIKit, SecureStore or the app on an iPhone. The native Expo transport has its own fail-closed redirect regression tests. A Metro iOS bundle and native project generation are verified separately; native compilation is the required unsigned simulator CI job.

The simulator CI artifact is archived with `ditto` to preserve the app bundle. It is an unsigned simulator build, not an installable device IPA or an App Store release. Bundle identifier/signing, device testing and distribution remain separate steps.
