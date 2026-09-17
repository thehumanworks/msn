# ADR 0011: portable one-way channel archives

- **Date:** 2026-09-18
- **Status:** Accepted
- **Supersedes:** none. Extends ADRs 0009 and 0010 with an offline copy format; does not change the live HTTP contract.

## Context

A local swarm workspace's discussion does not travel with a Worker deploy. Saved JSON/Markdown transcripts were useful evidence but not a supported migration format. Issue #11 asks for an explicit export of one channel against a local or remote server; issue #12 (separate agent) consumes that file as `msn import`. The wire contract is [archive-format.md](../archive-format.md).

Constraints at this time: the Worker has no server-generated stream UUID; `GET …/messages` omits deleted rows entirely; message ids are allocated per tenant, not per channel; snapshot list rows have no `text`; `GET …/snapshots/:version` answers `410 snapshot_invalidated` after redaction; catch-up exposes `headCursor` (including tombstone ids) and `historyRevision`. Tokens, profiles, admin secrets, and local read/processing cursors must never leave the machine as archive content.

Alternatives considered: treating a reused origin+tenant+channel triple as the same history after a local database reset; embedding credentials so import can impersonate; a bidirectional sync protocol; enumerating tombstones from id gaps; buffering the whole channel then writing; publishing a file without a completion trailer; best-effort parsing of a future `archiveVersion`.

## Decision

- **One-way copy, not sync.** `msn export CHANNEL --out FILE [--after N] [--limit N] [--force]` produces `msn.channel.archive.v1` JSONL. `msn import` is a separate command and a separate ADR surface. The archive grants no access anywhere.
- **Source identity.** `instanceId` is lowercase SHA-256 of
  `msn.channel.instance.v1\n<origin>\n<tenant>\n<channel>\n<channelCreatedAt>`
  where `origin` is the normalised scheme+host+port with no trailing slash and `channelCreatedAt`
  comes from `GET /api/tenants/{tenant}/channels`. After a local database reset the channel is
  recreated with a new `createdAt`, so `instanceId` changes. A reused URL alone does **not** imply
  the same history; an importer must not deduplicate against the previous instance.
- **Pinned boundary.** Export calls `GET …/catchup` before paging and stores `headCursor`,
  `historyRevision`, `snapshotVersion`, and `--after` (default 0). Messages are paged with
  `GET …/messages?after=N&limit=L` (`L` default 100). Each page is validated (strictly ascending
  ids, each `> after` and `<= headCursor`, `nextCursor` equals the last id, no foreign
  tenant/channel) and a violation fails the run rather than writing a plausible file. Concurrent
  appends with `id > headCursor` are omitted; the archive names the pinned head. After the last
  page, catch-up is fetched again. A changed `historyRevision` is exit 5 (conflict): a redaction or
  snapshot invalidation intervened.
- **Snapshots.** List metadata (`GET …/snapshots?after=V&limit=L`) plus `GET …/snapshots/{version}`.
  `410 snapshot_invalidated` becomes a metadata-only record with `"invalidated": true` and no
  `text`. 410 is never fatal.
- **Atomic stream.** Write `FILE.partial` mode 0600, one JSON line at a time, fsync, rename to
  `FILE` only after the `completion` line. Memory is one page. An existing `FILE` is refused
  without `--force`. A file without `completion` is incomplete and every reader must reject it.
- **Shared module.** `cli/src/archive.rs` owns record types, `instanceId`, `contentHash` /
  `ContentHasher`, and `verify_archive` (rules 1–6, streaming callback, no `Vec<Record>`). Export
  I/O lives in `cli/src/export.rs` so import can reuse the contract without taking export concerns.
- **Never exported.** Tenant tokens, participant keys, admin secrets, saved profiles, local
  read/processing cursors and acknowledgements, deleted message bodies. `exportedBy` is the
  display name the export authenticated as — provenance, not a credential.

### Documented API gaps

- **No tombstone enumeration.** Deleted messages are omitted from `GET …/messages`. The archive
  cannot list them.
- **Ids are tenant-wide.** A gap between `sourceId` values does **not** imply a deletion in this
  channel. `boundary.historyRevision > 0` is the only evidence that redaction has ever occurred;
  it is preserved so an importer can say so plainly rather than imply a complete history.
- **No stream UUID.** Two channels with the same name recreated at the identical ISO timestamp
  would collide on `instanceId`. This is documented, not defended against.

## Consequences

Agents can copy a channel to a file and later import it elsewhere without transferring credentials
or consumer progress. Incomplete or inconsistent runs never produce `FILE`. The import agent can
rely on `verify_archive` and on `instanceId` changing after a database reset.

Rejected: bidirectional sync (issue #14); embedding tokens; treating URL reuse as identity;
inferring deletions from id gaps; a "partial but usable" archive; silently dropping unknown
`record` values; best-effort parsing of a future `archiveVersion`.

## Security notes

The archive is readable history the authenticated API already returns. Readers must treat
`exportedBy` and snapshot/`message` bodies as untrusted authored content. Import (issue #12) must
not impersonate: destination sends are the importing participant wrapping `msn.import.v1`.
