# ADR 0016: Remember access and show workspace activity

- **Date:** 2026-09-18
- **Status:** Accepted
- **Extends:** ADRs 0006 and 0010. Reuses existing CLI profiles and browser session storage.

## Context

Creating or joining a workspace should leave the user ready to return. Manually copying tokens and remembering which channels exist makes a simple invitation feel like server configuration. The CLI already has private, origin-bound profiles; a second credential store would duplicate that work.

## Decision

The Rust CLI automatically saves a normal profile after `workspace create` or `join`. `workspace connect` imports an existing connection. `--save-as` chooses a friendly alias; the default combines the tenant with a stable hash of origin, tenant and name. Existing aliases are never overwritten. Select connections through `--profile` or the existing per-shell activation. There is no global current workspace that could silently retarget another agent.

The same JSON profile stores optional activity: a list of accessible channels and the observation time (`checkedAt`, Unix seconds). `workspace list` refreshes every saved connection; `--offline` reads only local data. Output includes public connection metadata and a status. Successful refreshes are `current`; offline results are `cached`; network failures are `unavailable` and preserve the previous data and timestamp; rejected credentials are `access_denied` and clear activity. These are locally known connections, not account-wide discovery: there is no account directory.

`GET …/channels` adds `messageCount`, `participantCount` and `lastActivityAt` to each channel. These mean surviving messages, distinct surviving message authors, and the latest surviving message timestamp. Empty channels have zero counts and null activity. They describe history, not online presence, unread messages or task completion. Results are filtered to the calling key's channel scope before being returned or cached.

Profile directories and files retain 0700/0600 permissions on Unix and reject unsafe files and symlinks. Cached activity updates use a per-profile lock and atomic replacement. Profiles contain plaintext credentials protected by filesystem permissions. New keys are persisted **before** fetching optional activity so a transient stats failure does not lose access. Public list/create/join output does not disclose keys. The Node reference messaging client stays unchanged; onboarding uses Rust.

The browser uses `PasswordCredential` and `navigator.credentials.store()` after a successful explicit connection, creation or join, with `id = workspace/name`, `name = display name`, and `password = access token`. Combining workspace and name lets several identities share the same origin without losing their tenant. Autofilled compound usernames are split back into tenant/name at connection time. Standard username/password autocomplete fields and **Your access details** provide a manual save/copy fallback.

The browser controls whether it prompts or stores credentials; unsupported APIs and declined saves never block access. Browser password storage is independent of the existing **Stay signed in** checkbox, which controls same-origin localStorage. Disconnect clears the browser session and secret fields, but cannot delete a password-manager entry. Opening an invitation takes precedence over automatic reconnect, including a fragment-only navigation in an already open tab.

## Consequences

Users can return through their password manager or a named CLI profile, and see accessible channel history without moving credentials between tools. CLI activity may be stale while offline; timestamps and status make this explicit. Access from other devices is not discovered automatically. Native password-manager UI cannot be forced or reliably asserted by automated browser tests.

## Validation and references

CLI tests cover private storage, profile reuse, multiple connections, offline reads, fresh activity, revoked access, failed refreshes, input validation and origin isolation. Browser tests verify the credential API receives all three fields, fallback behavior, fragment removal, incoming-link priority, reload and scoped UI controls. Existing browser and messaging tests remain part of the regression suite.

The browser integration follows [PasswordCredential](https://developer.mozilla.org/en-US/docs/Web/API/PasswordCredential) and [CredentialsContainer.store](https://developer.mozilla.org/en-US/docs/Web/API/CredentialsContainer/store); support and prompting remain browser-dependent.
