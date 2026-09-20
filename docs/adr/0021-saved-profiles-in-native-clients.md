# ADR 0021: saved profiles in the desktop and iOS clients

- **Date:** 2026-09-20
- **Status:** Accepted
- **Supersedes (in part):** ADR 0018, only its statements that the desktop client reads CLI profiles "read-only" and that "nothing is written to disk". ADR 0019, only its statements that the iOS session is "one item" in the keychain and is "removed on sign out". Everything else in both ADRs stands.
- **Extends:** ADR 0016 (profile file format, directory and permission rules), ADR 0006 (remembered browser credentials). Adds no server endpoint and changes no server authorization.

## Context

The desktop client could connect with a saved `msn` CLI profile but could not save one: a person who typed an origin, workspace and key into the GUI had to retype them every launch, or leave the GUI and run `msn profile save`. The iOS client remembered exactly one session and deleted it on sign-out, so switching between two workspaces or two identities meant pasting a key each time.

Neither limit was a security decision. ADR 0018 records that the desktop read profiles read-only because "the CLI's profile loader is crate-private" — an implementation shortcut that the README later restated as if it were a rule ("never writes profiles"). The threat model gives no reason for it: the same key already sits in `~/.config/msn/profiles/*.json` (0700 directory, 0600 files) when the CLI saves it, and the browser client keeps its key in `localStorage` (ADR 0006), which is weaker than either a 0600 file or the iOS keychain. A GUI writing the identical file through the identical code adds no exposure. What the shortcut did cost was a second, drifting copy of the permission checks inside the desktop crate.

Alternatives considered:

- **Desktop stores keys in the OS keychain / libsecret instead of the CLI's files.** Stronger at rest on paper, but profiles would stop being shared with `msn`, which is the point of the feature for people who use both; it also adds a platform dependency per OS. Rejected for now; nothing here prevents a later ADR from moving all three clients together.
- **A second writer inside the desktop crate.** Rejected: two writers drift on exactly the properties that matter (modes, symlink refusal, never-replace, atomicity).
- **Save automatically on every successful connect.** Rejected: using the app on someone else's machine must not leave a key behind. Saving is opt-in per connection, as the iOS **Remember** switch already was.
- **iOS keeps one profile and merely stops deleting it on sign-out.** Rejected: it does not solve switching, and "sign out" silently keeping a key with no way to see or delete it would be worse than either extreme.

## Decision

**A profile is a saved connection that belongs to one user**: one display name, in one workspace, on one origin (and one channel, for a channel-scoped key). Every client records that identity with the key and shows it in its picker (`planner — alice @ my-team`). Profiles are only ever written for a connection the server has just authenticated, never from unverified form input.

**One store implementation on the desktop side.** `msn_cli::profile::ProfileStore` is the public API for first-party clients: `summaries` (never contains the key), `load`, `check_new_name` and `save`. It is the same directory, JSON shape, 0700/0600 checks and symlink refusal the CLI already used (ADR 0016); the desktop crate's own reader is deleted and it now depends on this API for both reading and writing. `Connection`'s `Debug` output redacts the key.

**Saving never replaces a profile.** With an explicit name, an existing profile is a conflict (the CLI's existing rule). Without a name the profile is named after the user and workspace (`alice-my-team`, then `alice-my-team-2`, …); an identical stored connection (same origin, workspace, user and key) is reported as already saved instead of duplicated. A rotated key for the same user becomes a new suffixed profile; the old file is left for the person to remove.

**Profile creation is atomic.** The complete file is written and synced under a temporary name and then hard-linked into place, which fails if the name exists. A crash or a concurrent reader never observes a partially written profile, and the never-replace rule holds under races. Filesystems without hard links fall back to the previous exclusive create. This also applies to `msn profile save` and `msn workspace …`, which share the writer.

**Desktop flow.** The connect form has an opt-in **Save as profile** checkbox with an optional name. A taken or invalid name is a form error before any network request. The request travels with `Command::Connect`; the network worker — the only holder of the key once a connection exists — saves after the identity endpoint has accepted the key and resolved the bound username, then reports `UiEvent::ProfileSaved` (which never carries the key). A failed save never affects the connection; it is shown as a notice. A rejected key writes nothing, not even the directory. Picking a saved profile clears the checkbox, and a completed save clears it so the next connection does not save again by accident.

**iOS flow.** The keychain (`expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, unchanged) now holds up to 16 named profiles: `msn.profiles.v1` is an index of names only (small, far below the keychain's per-item guidance), `msn.profile.v1.<name>` holds one session, and `msn.active.v1` names the profile to reopen on launch. Secure storage cannot enumerate keys, so writes are ordered to keep the invariant *every stored key is listed*: a save lists the name before writing the key; a removal deletes the key before unlisting the name. An interruption leaves at worst a listed name with no key, which the next read removes. Corrupt, tampered or insecure-origin profiles are removed and unlisted on read.

- The switch is now **Save as a profile on this device** (default on, as before). The name is automatic; the same user in the same workspace on the same server reuses their profile, so a rotated key replaces its own entry, while a different user can never overwrite it (names are chosen inside the serialised storage queue against what is actually stored).
- The sign-in screen lists saved profiles: tap to reconnect, **Forget** (confirmed) to delete the key from the device.
- **Sign out** ends the session and clears the active pointer but keeps the profile, so switching accounts is one tap. **Sign out and forget** also deletes the key. Signing in with the switch off removes that same user's older profile and never touches anyone else's.
- A key the server rejects with 401 is deleted from the device, as before.
- The single remembered session of earlier versions (`msn.session.v1`) is migrated once into a profile and stays active, so an existing user remains signed in after updating; the legacy item is removed only after the profile has been written.
- The model keeps its existing guarantee that storage follows the *newest intent*: intents are per identity (save, or forget) plus one for the active profile, applied through one serialised queue, so a slow save that began before "sign out and forget" cannot resurrect a key.

## Consequences

- The desktop app now writes to disk, only on request, and only this one kind of file. Its README's security section is updated; "never writes profiles" is no longer true and was never a recorded requirement.
- A key saved from the desktop is readable by anything running as that Unix user, exactly as for a CLI-saved profile. This is the accepted ADR 0016 posture, not a new one. Rust `String`s are still not zeroized.
- On iOS a signed-out device now still holds keys until **Forget** is used. This is the intended trade for account switching, it is stated in the sign-out dialog, and the picker makes every stored key visible and individually deletable. A lost or shared device is handled the same way as before: revoke the key (`keyId`) or rotate the workspace; the next 401 deletes the local copy.
- The desktop still never deletes or edits profiles; removal stays with the file system or a future CLI command. The channel scope of a channel-scoped key is not recorded in the CLI file format (it never was); the server continues to enforce it.
- An unreadable iOS index is treated as empty; keys it listed become unreachable on the device until the app's keychain items are cleared by uninstalling. This is the residual cost of storage that cannot enumerate keys, bounded by the index being names only and rewritten with a single small item.
- Tests: `cli/tests/profile_store.rs` (modes, never-replace, symlink squatting, automatic naming and de-duplication, invalid input writes nothing, key never in `Debug`/summaries, unsafe directory refused); `apps/desktop/tests/mock_server.rs` (saved only after authentication and readable by the CLI's loader, rejected key writes nothing, failed save keeps the connection) and a reducer test for stale outcomes; `apps/ios/tests/profileStorage.test.ts` and `appModel.test.ts` (ordering invariant under interrupted writes, self-healing, bounds, naming, migration, switching, forgetting, revocation, newest-intent races).
