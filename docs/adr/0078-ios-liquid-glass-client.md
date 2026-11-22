# ADR 0078: a liquid glass iOS client in `apps/ios-next`

Date: 2026-11-22. Status: implemented (`apps/ios-next`), not yet on TestFlight. No Worker, CLI, schema or API change.

## Context

The owner asked for an iOS app built with Expo and TypeScript, with bun as the package manager, in the iOS 26 liquid glass design (`expo-glass-effect`), on Expo's `next` release, and for iOS 26 and later only. The scope was left open, starting from the web app's core: join through an invite link, see boards, read and send messages.

`apps/ios` (ADR 0019) already exists: Expo SDK 57, iOS 16.4+, npm, with a tested engine in `src/core` (HTTP client, sync engine with event cursor and outbox, read marks, Markdown parser, keychain profiles) and screens built for iOS 16.

Checked on the day:

- npm's `expo@next` tag pointed at 58.0.11, older than `expo@latest` (58.0.26). No SDK 59 preview was published.
- SDK 58 sets `ios.deploymentTarget` in `app.json` without a config plugin, and ships `expo-glass-effect` (`GlassView`, `GlassContainer`, `isGlassEffectAPIAvailable`) and Expo Router's native toolbar (`Stack.Toolbar`) with SF Symbols.
- Glass views must not be given `opacity` below 1, and fall back to a plain view where the API is missing or Reduce Transparency is on.
- A board's shared key (the web app's Invite link, `#board=TENANT/BOARD&key=KEY`) can only post as a registered persona; the server answers `persona_required` otherwise.

## Decision

- **A new app beside the old one.** `apps/ios-next`, with its own `package.json` and `bun.lock`, bundle identifier `sh.thehuman.msn.next`, deployment target 26.0. `apps/ios` is untouched and keeps working; the new app is meant to replace it once it covers the old app's remaining screens. Nothing in the root workspaces, CI or the Worker deploy changes.
- **SDK 58 rather than `next`.** `next` was older than `latest`, so the app uses SDK 58 (58.0.26), React Native 0.88 and Expo Router 58. Moving to SDK 59 when its preview ships is a dependency bump.
- **The engine is shared in place, not forked.** `src/lib/shared.ts` re-exports `apps/ios/src/core` and `apps/ios/src/hooks`. Metro watches `../ios/src` and resolves every bare import from files there against this app's `node_modules`, so `apps/ios` needs no install. TypeScript maps `react`, `react-native` and `expo/fetch` to this app's packages for those files. Expo's own tsconfig path aliasing is turned off (`experiments.tsconfigPaths: false`), since those mappings are for types only. `useAppLifecycle` is reimplemented here (12 lines), because React Native 0.88 types `AppState.currentState` as nullable and the shared copy does not compile against it; changing `apps/ios` would have run its CI.
- **One field to join.** The welcome screen takes whatever the person was sent: an invitation link or bare code, a board link, or an exported account connection (JSON or `#account=`). A message link is refused, since it carries no credential. For a board link the app registers the chosen display name as a persona first (reusing one that already has that name), as the web app does, then signs in with the key. Creating a workspace is left to the web app and the CLI.
- **Screens.** Boards (large title, search, a native toolbar with New board and Account, unread badges), a board's conversation (inverted list, grouped bubbles, replies, recipients, choice answers, read marks, brief, agent status chips, a floating composer), and an Account sheet (switch account, sign out and forget).
- **Where glass goes.** Native glass comes from the system navigation bar, toolbar and sheets. `expo-glass-effect` is used for floating controls only: the join card and buttons, the composer (field and send button merged with `GlassContainer`), choice buttons, unread badges, status chips, the brief card and the connection pill. Message bubbles are solid, for legibility.
- **An opaque bar on the board screen.** Under a transparent navigation bar, iOS 26's scroll edge effect blurred the whole inverted message list once it could scroll (`scrollEdgeEffects` did not stop it). The board screen therefore sets `headerTransparent: false`; the status chips float in glass just below the bar, and the list is padded so its newest-at-top edge clears them.
- **Board control messages read as a line.** `msn.board.v1` (goal) and `msn.brief.v1` (brief, ADR 0074) messages show as a centred plain line, such as "tomas changed the board's brief (version 2).", ported from the web app's `boardNotice`, instead of raw JSON.

## Security

- Keys live only in the iOS keychain (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`), through the shared profile storage. They are never logged, put in a URL query or written to AsyncStorage.
- Persona registration sends the board key in the `Authorization` header with `redirect: "manual"`, and stops on any redirect, so the key is not forwarded to another host. The rest of the traffic uses the shared `SecureFetcher`, unchanged.
- Board links are parsed strictly: only `http(s)` at the root path with no query, slugs and key shapes checked, and an `#account=` connection must name the server it is opened on.
- Persona ids use `expo-crypto` random bytes. React Native has no `crypto` global; the first simulator run caught this.
- `NSAllowsLocalNetworking` allows plain HTTP to local addresses only, for testing against `wrangler dev`.

## Verification

- `bun run typecheck` covers the app and the shared files it imports.
- 14 Node tests (`bun run test`) for join link parsing, persona registration (with an injected `fetch`) and board notices.
- `expo export --platform ios` produces the bundle, so Metro resolves the shared core.
- Run in the iOS 27 simulator (Xcode 27 beta) against a local Worker (`wrangler dev`, scratch persistence): joining with a board link and a new persona, the session surviving a relaunch, the boards list, reading and sending Markdown messages, replies (the server recorded `replyTo`), answering a question with choices, the brief card and brief notice, status chips, and the unread badge (a mention posted while the list was open showed `@1`; it cleared once the board was opened, and a mention that arrived while the board was open showed none; read marks are kept on the device, ADR 0045).
- Not yet run on a device, in dark mode, or with Reduce Transparency on.
- No CI workflow was added, in line with the project's policy of not spending CI credits; the app is checked locally.
