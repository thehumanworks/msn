# ADR 0013: channel import and imported-author trust

- **Date:** 2026-09-18
- **Status:** Accepted
- **Supersedes:** none. Consumes ADR 0011's archive contract. Complements ADR 0012 (remote-first coordination). Does not implement bidirectional sync.

## Context

Issue #12 needs a one-way copy of a portable `msn.channel.archive.v1` into a selected destination profile/workspace/channel, in both directions (local → remote and remote → local). Copying raw text would break reply links, task evidence, snapshot coverage, and author trust. The archive carries no credentials. Destination message ids are tenant-local AUTOINCREMENT values, so source ids cannot be reused. Task projection treats the outer message `username` as the actor. A wiped body is gone from the API; an invalidated snapshot must not become current truth. Reader and processing cursors are local consumer state, not history.

Alternatives considered: impersonating `source.username` at the destination; treating archive tokens or the source key as dest credentials; merging into an existing channel by default; replaying every `msn.task.v1` event onto the live board; inferring a complete history across redaction gaps; importing delivery/processing cursors so dest work looks processed; a bidirectional replica (issue #14).

## Decision

- **Independent destination authentication.** `msn import FILE --channel DEST` uses the selected profile exactly like every other subcommand. Nothing in the archive grants access. Extra keys such as `token` on a record are provenance noise and are never sent as `Authorization`.
- **Safe default destination.** A missing `DEST` is created. An existing `DEST` is refused unless `--allow-existing` is given. Appending into live history is the caller's decision; msn never merges implicitly. A matching import map (same dest origin/tenant/channel and source `instanceId`) is a continuation of that copy and does not require `--allow-existing`.
- **No impersonation.** Every imported message is sent by the authenticated destination participant as `contentType: application/json` with the `msn.import.v1` envelope from [archive-format.md](../archive-format.md) §6. `source.username` is an unverified claim about another server. Source ids, timestamps, `replyTo`, `correlationId` and `to` are preserved inside the envelope.
- **Trust policy.** `--trust provenance` (default) wraps task events; they do not project into the destination board. `--trust replay-tasks` is the only way imported `msn.task.v1` events are sent as live JSON. It re-attributes actorship to the importing participant, warns on stderr, and is never implied by another flag. A dest that already has that task slug keeps those events wrapped and reports a conflict.
- **Idempotency and import map.** Destination `Idempotency-Key` is `imp-<first 16 hex of instanceId>-<sourceId>` (plus `-begin` / `-done` / `-snap-N` / `-snapunavail-N`). A retry or resume is a server-side replay. A 409 for the same identity with a different payload is a CONFLICT: report it, do not rewrite. The map lives under `$XDG_STATE_HOME/msn/<dest-origin-hash>/<dest-tenant>/imports/<instanceId>/<DEST>.json` (or `--state-file`), written atomically mode 0600 with a lock. It stores source→dest ids, snapshot publish preconditions, `lastSourceId`, and `in-progress` / `complete`.
- **Reference remapping.** Destination `replyTo` is the mapped dest id, or unset and reported when the target was never imported. Known task evidence ids and snapshot `coversThrough` are remapped the same way. Unknown structured payloads are wrapped, not silently rewritten, and are reported as not fully restored.
- **Deletion / invalidation.** Never resurrect wiped content. Invalidated snapshots are sent as `payload.kind: "snapshot-unavailable"` and are never published as valid dest snapshots. `historyRevision > 0` is stated in the report: source redactions are not reconstructible.
- **No consumer cursors.** Import writes only the import map. It does not create `readers/` or `processing/` files and does not mark destination work processed.
- **Interruption.** A partial copy stays `in-progress` with counts and `lastSourceId`. Begin and completion markers bound the dest channel so a reader can see the import is unfinished. Resume uses the same command and the same map.

## Consequences

Operators can copy a channel into a new dest workspace without transferring keys or consumer progress. The dest log is honest: every row is the importer's send, with source claims inside the envelope. Live task boards stay empty unless someone opts into `--trust replay-tasks`.

Rejected: impersonation; using archive credentials; implicit merge; default task replay; importing cursors; treating id gaps as reconstructible deletes; bidirectional sync.

## Security notes

Destination tokens never leave the selected profile. `source.username` and snapshot/message bodies remain untrusted authored content. `--trust replay-tasks` can close dest tasks as the importer; that is why it is explicit and warned.
