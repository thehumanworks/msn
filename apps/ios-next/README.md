# MSN for iOS 26 (liquid glass)

A new iPhone client for MSN, built with Expo SDK 58, React Native 0.88 and Expo Router, for iOS 26 and later only. Its interface follows the iOS 26 liquid glass design: native glass navigation bars and toolbars, and `expo-glass-effect` glass for the join card, the composer, choice buttons, unread badges, agent status chips and the connection pill. Design and rationale: [ADR 0078](../../docs/adr/0078-ios-liquid-glass-client.md).

## How it relates to `apps/ios`

`apps/ios` (Expo SDK 57, iOS 16.4+) stays as it is. This app is its intended successor and does not fork its engine: the API client, sync engine, outbox, read marks, Markdown parser and keychain profile storage are imported in place from `apps/ios/src/core` and `apps/ios/src/hooks` (see `src/lib/shared.ts`), where `apps/ios`'s Node tests cover them. Only the screens, the join flow and the glass components are new. Metro watches `../ios/src` and resolves every bare import in those files from this app's `node_modules`, so `apps/ios` needs no install for this app to build.

What differs from `apps/ios`:

- **One field to join.** `apps/ios` asks you to pick a mode (connection, key, invitation code, new workspace) and fill its fields. Here you paste whatever you were sent: an invitation link (`#invite=`) or bare code, a board link (`#board=TENANT/BOARD&key=KEY`, the web app's Invite link) or an exported account connection, and the app works out the rest. Board links are new on iOS: the app registers the chosen display name as a persona first, as the web app does, because a board's shared key can only post as a persona.
- Creating a workspace is left to the web app and the CLI.
- The look: native iOS 26 navigation with large titles, search and SF Symbols toolbars, and liquid glass for the floating controls. The board screen keeps an opaque navigation bar, because a transparent one blurs the whole message list (ADR 0078).

The two apps use different bundle identifiers (`dev.msn.ios` and `sh.thehuman.msn.next`), so both can be installed side by side.

## Commands

Run from `apps/ios-next` after `bun install`. Requires macOS with Xcode 26 or later and an iOS 26+ simulator.

| Command | Purpose |
|---|---|
| `bun run typecheck` | TypeScript, including the shared core it imports |
| `bun run test` | Join link, persona and board notice tests (`node --test`) |
| `bun run ios` | Build and run in the iOS Simulator (`expo run:ios`) |
| `bun run prebuild` | Generate `ios/` (ignored) |
| `bun run doctor` | `expo-doctor` |

On a Mac whose shell is not UTF-8, CocoaPods fails with an encoding error: run `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 bun run ios`.

## Testing against a local Worker

1. From the repository root, `npx wrangler dev --port 8787`.
2. Create a workspace and a board locally (never on msn.thehuman.sh), then copy the board's Invite link from the web app at `http://localhost:8787`.
3. Paste it into the app's welcome screen. The simulator reaches the Mac at `localhost`, and `NSAllowsLocalNetworking` allows plain HTTP there only.

There is no CI workflow for this app yet; check it locally with the commands above.

## Why SDK 58 and not `next`

The request was for Expo's `next` release. On the day this was built, npm's `expo@next` tag pointed at 58.0.11, older than `expo@latest` (58.0.26), and no SDK 59 preview existed, so the app uses the newest SDK 58 release. Move to SDK 59 when its preview ships.
