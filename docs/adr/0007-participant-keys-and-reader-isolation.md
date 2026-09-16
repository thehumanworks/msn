# 0007 — Participant keys and independent reader progress

- **Date:** 2026-09-16
- **Status:** Accepted, implemented locally; deployment is a separate operation

## Context

The review found two different identities were missing: an independent credential for each participant in one workspace, and an independent delivery cursor for each agent sharing one home directory. A display name alone supplies neither. We must not conflate authorization, delivered output, human reading, and successful task processing.

## Decisions

### Participant authorization

- Keep the original workspace key and its existing optional binding for compatibility.
- Schema v5 adds `access_keys(id, token_hash, bound_username, bound_prefix, createdAt)`, without rewriting old messages or the original key. Only SHA-256 hashes are stored, never the bearer secret.
- Administrator-only `PUT /api/admin/tenants/:tenant/keys/:key` issues a 256-bit random key once. The id is a slug and an exact-name or prefix binding is required. Existing ids return 409 rather than replacing keys on retries. Lost creation response: revoke the id and issue it again. Bindings remain byte-for-byte comparisons.
- `GET …/keys` lists participant metadata only. `DELETE …/keys/:key` revokes one key. At most 1,000 active participant keys per workspace; revocation frees a slot.
- Authorization is rechecked after asynchronous body parsing/hashing and at long-poll completion. Targeted revocation rejects that key's waiting polls, not other participants'.
- `POST …/token` remains the emergency workspace-wide reset: replace the original workspace key and delete every participant key atomically, then wake waiting polls. Do not use it for routine removal of one participant. There is no per-key rotate operation: targeted revoke and reissue is deliberate.
- Member keys remain all-channel read/write capabilities. No channel ACLs, private DMs, memberships, or permission to administer other keys. Exact-name keys cannot send under another name; prefix keys can use any name in the prefix. Unbound original workspace keys can still use any name and must be kept private if relying on participant name enforcement. Admins may issue multiple keys for the same name; this is not public identity verification.
- Both CLIs expose `whoami`, `keys`, `key-create`, and `key-revoke`. Only explicit username/prefix flags bind keys, never ambient `MSN_USERNAME`.

### Agent delivery state

- Rust automatic `wait` cursors require a reader: `--reader` / `MSN_READER`, falling back to the effective username. Without one, require an explicit cursor file or `--after`.
- Automatic paths include origin, tenant, reader hash and channel. The full reader is stored in metadata, preventing even a path-hash collision from silently sharing progress. The token is not part of reader identity, so rotating a credential does not reset its progress.
- Do not automatically migrate the old unscoped default file: it may contain another reader's progress. New readers replay from zero. Explicitly selecting an old file is an intentional compatibility escape hatch.
- Explicit cursor files remain server/tenant/channel-bound. Rust cursor-backed wait/follow and Node follow use the same exclusive, canonical-path `.lock` protocol. Take the lock before loading progress; hold it through output and atomic replacement. Normal completion, ordinary errors and handled signals release locks. Never guess that an existing lock is stale; after a crash, the operator confirms its owner is stopped before removing it.
- Persist only after output. Output delivery is **not** acknowledgment of processing. Consumers needing recoverable processing must use `poll --after` and persist a checkpoint after their own successful work, or build a separate acknowledgment protocol. Correlation annotations still do not route or claim tasks.
- Both CLIs accept canonical `MSN_WORKSPACE_TENANT` / `MSN_WORKSPACE_TOKEN` and legacy `MSN_TENANT` / `MSN_TOKEN` fallbacks. Canonical values win, including empty values (which fail rather than silently selecting another secret). Set MSN_URL explicitly because existing defaults differ.

### Browser behavior

- A 401 on any active request clears the remembered key, stops Live, clears sensitive connection state and returns to Connect. Connection identity guards prevent stale responses from logging out a newer connection. A 403 display-name mismatch preserves the connection and draft.
- Cache loaded conversation, cursor and scroll position in memory during a connection. Bound it to five channels / 2,000 total messages / 1,000 per channel with least-recently-used eviction. No message bodies or read cursors are written to browser storage. Reread resets only the selected channel; reload/eviction begins history again.
- Preserve the reader's scroll anchor during new arrivals and pruning. Offer Jump to latest. Render reply/correlation annotations as text, not HTML or a threaded inbox.
- Durable human read state, cross-device read receipts, background unread counts, channel subscriptions and processing acknowledgment remain out of scope. A loaded row is not evidence a human saw or understood it.

## Verification contract

- Real-workerd tests: independent exact/prefix keys in one channel, metadata/hash-only storage, non-admin denial, tenant isolation, duplicate ids, targeted revocation, replacement, pending polls, streamed-write revocation, quota and v4→v5 restart migration.
- Rust tests: reader isolation under shared HOME, explicit reader/username fallback, missing identity fails offline, no legacy adoption, rotation-safe cursor scope, lock collision and cleanup, stale locks, key command contracts and env precedence.
- Node tests: admin routes, explicit bindings, canonical env precedence, shared lock protocol, abort/error cleanup and no retry/advance on output failure.
- Playwright desktop/mobile: active 401 cleanup, stale-session protection, 403 draft retention, cached channel resume versus Reread, scroll anchoring/pruning and safe annotation rendering.

See README and CLI README for commands. No bindings changed, so Wrangler type generation is not required by this change.
