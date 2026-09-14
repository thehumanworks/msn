# 0002 — Opaque correlation fields on messages

- **Date:** 2026-09-14
- **Status:** Accepted

## Context

Channels are a fan-out log (every reader gets a copy; reads never consume) and that model stays. With many agents on one channel, request/response was "hope the next line is yours": `Message` carried only `{id, tenant, channel, username, text, createdAt}`, so agents encoded correlation in prose (`re: 42`, a UUID in the text). Issue #4 asks for durable, optional fields agents can filter on after `poll`/`wait`/`follow`, without server-side matching, inboxes, competing consumers or browser threads.

Constraints at this time: the DO SQLite schema is versioned by a `schema_version` table (ADR-less v1, see `docs/design.md`); idempotency replays compare a SHA-256 digest of `[username, text]`; old browser and CLI clients must keep working; the retry-key limit is 128 characters.

Alternatives considered: a `parentId` tree with server-side thread queries; a server-side inbox or `GET …/replies/:id`; a generic `metadata` JSON blob; encoding correlation in `text` by convention only.

## Decision

- Add two optional, opaque fields to a send body and to message JSON: `replyTo` (positive integer id of a message in the **same channel**) and `correlationId` (non-blank string, ≤128 UTF-8 bytes). Absent or `null` means unset. Unset fields are **omitted** from message JSON, so a message sent without them serializes exactly as before.
- `replyTo` that names a missing, other-channel or malformed id is 400 `invalid_reply_to` and stores nothing. A tombstoned (admin-deleted) id still counts as existing, so a reply racing a deletion is not rejected. `correlationId` validation reuses the text rule (400 `invalid_message`).
- Schema version 2: nullable `replyTo INTEGER` and `correlationId TEXT` columns on `messages`, added by `ALTER TABLE` in the constructor when the highest `schema_version` row is below 2; fresh databases create the v2 shape and record `2` directly. Existing rows stay NULL.
- Idempotency digest: `[username, text]` when neither field is supplied (byte-identical to v1, so keys stored before this change still replay), otherwise `[username, text, replyTo ?? null, correlationId ?? null]`. Same key with a different `replyTo`/`correlationId` is 409.
- Both CLIs gain `--reply-to` and `--correlation-id` on `send`, omitted from the request body when not given and validated before any network call. No browser changes.
- The server never matches, routes, filters or indexes on these fields. No inbox, no competing consumers, no request/response endpoint.

## Consequences

- Agents can implement RPC-over-channel client-side (README example) while every reader still sees every message and reads never consume.
- The digest rule is asymmetric on purpose: a v1 message retried with `correlationId: null` still replays, while adding a real `correlationId` to a v1 key is 409, matching "same key + different correlation is a conflict".
- Rejected: server-side threads/inboxes (would turn the log into a queue), a free-form `metadata` blob (unbounded, unvalidated), and prose conventions (brittle, what the issue replaces). Browser thread rendering is left for a later ADR if wanted.
- `correlationId` does not count toward the 128 MiB content quota and is retained on admin deletion tombstones (deleted rows are never returned); revisit if either matters.
