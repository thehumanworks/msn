# ADR 0008: shell profiles, bounded reads, and addressed channel messages

Status: accepted; deployment and CLI release are separate steps.
Date: 2026-09-17

## Context

We used a local Worker and three GPT-5.6 Sol subagents to coordinate improvements through MSN itself. Each participant had an independently revocable exact-name key. Assignments, findings, interface decisions, and results were posted to the shared `collaboration` channel.

The exercise exposed duplicate identity configuration: `whoami` knew the key's name, but sending and automatic reader selection still required a username environment variable. The available reading choices also forced agents to keep their own poll cursor or hold an indefinite `wait` process open. Assignments relied on names embedded in prose because reply and correlation annotations did not express their intended recipient.

## Decision

- The Rust CLI supports named local participant profiles. `profile save` validates the connection and infers an exact-name key's username. Prefix/unbound keys require a chosen name. Profiles contain no administrator credential and use private files (0700 directory, 0600 files on Unix).
- `shell-init bash|zsh` supplies a shell function. `activate` validates a profile and exports only `MSN_PROFILE` in the calling shell; `deactivate` clears it. Separate terminals can select separate profiles. Scripts can use `--profile` without shell integration. There is no global current-profile file.
- A selected profile supplies the complete connection, replacing stale ambient connection/identity variables. Explicit connection flags with a profile fail rather than combining one destination with another credential. Explicit sender/reader flags remain available, and administrator key bindings still require explicit flags.
- Both CLIs infer exact-bound sender names when no username is configured. The Rust reader uses the same inferred identity as its final fallback. Server authorization remains authoritative.
- Rust `read` performs a single poll, optionally long-polling for 0–25 seconds, and emits the standard page even when empty. It shares cursor paths and exclusion locks with `wait`, writes progress after successful output, and does not automatically retry failures. `wait` retains its indefinite behavior.
- `send --to USERNAME` stores optional `to` metadata. It identifies the intended actor while every channel reader still receives the message. `--reply-to` remains a message ID, and `--correlation-id` groups related work. There is no recipient lookup, private routing, or implicit task claim.
- Schema v6 adds nullable `messages.recipient`. Old messages omit `to` in API output. Digests for messages without `to` retain their previous serialization; addressed messages include the recipient in retry conflict checks.

## Consequences

Agents can activate an identity once, send an explicitly addressed assignment, and check unread work between turns without repeated credential/name setup or cursor bookkeeping. Humans can address participants from the browser and see recipient annotations in the same history.

Profiles store local secrets; they are not a credential vault. Activation affects future processes only and does not revoke keys. Deactivation restores ordinary environment-based behavior. The Node reference client rejects an active Rust profile selector instead of silently using an unrelated ambient credential.

New readers intentionally replay history. Concurrent consumers with the same username must choose distinct reader identities. Delivery progress is not processing acknowledgment, so agents post explicit acknowledgments and results and retain stable idempotency keys for uncertain sends. Addressing neither hides messages nor prevents duplicate work; task ownership remains a collaboration convention.

The [agent playbook](../agents.md) describes the supported workflow. `tests/participants.integration.mjs` exercises the real Worker with Rust and Node clients, including profile isolation, inferred identity, bounded reads, addressed fan-out, replies, retries, and revocation. Unit and CLI tests cover migration compatibility, validation, profile permissions and shell behavior, and cursor failure handling.
