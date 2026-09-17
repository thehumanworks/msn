# ADR 0012: remote-first agent collaboration and explicit origin

- **Date:** 2026-09-18
- **Status:** Accepted
- **Supersedes:** none. Extends ADRs 0008 and 0010. Does not edit those snapshots.

## Context

A multi-agent run coordinated on a LOCAL `swarm` workspace. Deploying the Worker published code, not the discussion and not participant credentials. The human at the production URL could not follow the history. A local participant token did not authenticate there. Nothing in onboarding made that consequence visible: `start` reported `identity` `{username, reader, tenant}` (ADR 0010) with no server origin, and the playbook did not distinguish deploying code from transferring workspace data.

Alternatives considered: treating the Rust CLI default URL as implicit production and rewriting existing profiles; embedding tokens in handoff URLs or channel messages; requiring production for implementation tests; automatically publishing local history on deploy; bumping `protocolVersion` because `identity` gained a field; implementing channel export/import in this change (issues #11 and #12).

## Decision

### Remote-first default

- Coordination that a human or a later agent should follow uses a **persistent remote channel**: the deployed Worker, a production workspace, and named participant keys issued against that origin.
- Isolated **local Workers** remain the place for implementation tests. They use a different tenant and different keys.
- Local-only coordination stays available as an **explicit, named choice** (a profile such as `local-swarm`, and a handoff that states access depends on a local process). It is not the default and is not implied by `bun run dev`.

### Origin on `start`

- `msn start` adds `origin` to the existing `identity` object. The value is `crate::config::origin_base(url)` — the same normalised scheme+host+port the HTTP client uses. Agents and humans can tell which environment they are in without inspecting ambient variables.
- `protocolVersion` stays `1`. Adding a field is backward compatible: consumers that do not read `origin` ignore it. A version bump is reserved for removing fields, changing types, or changing command semantics (cursor mutation, budget rules, required keys).
- ADR 0010's identity shape `{username, reader, tenant}` is extended, not rewritten. That document stays a point-in-time snapshot.
- Bounded output is unchanged: `--max-bytes` (2048–262144, default 32768) measures the extra JSON (now including origin), subtracts it, and still requires at least 1024 bytes for the catch-up body. The "Increase start --max-bytes…" errors keep adding that overhead to any server `requiredBytes`.

### Credential and origin isolation

- Never silently switch an existing profile to production. `profile save` already refuses overwrite; retargeting means a new profile name after importing a key for that origin.
- Never reuse credentials across origins. A token is a capability for one Durable Object store.
- Never put tokens in URLs or channel messages. Access handoffs name origin, workspace, display name, channel, and whether a local process must still be running; the token is delivered out of band.
- Remote use requires an explicitly configured destination: `MSN_URL` set to that origin before `profile save`, or `--url` on a command that is not using a profile. `--profile` cannot be combined with `--url` / `--tenant` / `--token`.
- `scripts/onboarding-check.mjs` confirms a participant can read the named channel on the advertised origin (health, identity binding, channel readability) and refuses to print tokens.

### Out of scope

- Automatic migration of local history to a remote origin.
- Requiring production for tests.
- Implementing `msn export` / `msn import`. One-way channel copy is [archive-format.md](../archive-format.md) and issues #11/#12.

## Consequences

`start` names the server. Onboarding states that a deploy is not a workspace move. A participant given a localhost token can see why it fails at the production URL. Local test workspaces stay isolated if operators follow the named-profile rule; nothing in the Worker prevents pointing a local key at production, so the check and the playbook are the control.

Rejected: implicit profile retargeting; protocol version 2 for an additive field; shipping export/import here; treating `MSN_URL` ambient defaults as sufficient identification of the environment.
