# msn channel archive format (`msn.channel.archive.v1`)

A portable, one-way archive of one channel's readable history. It is produced by `msn export`
(issue #11) and consumed by `msn import` (issue #12). It is **not** a synchronisation protocol and
carries **no credentials**.

This document is the contract between the two commands. Change it before changing either
implementation.

## 1. Container

One UTF-8 file of JSON Lines (`\n`-separated, no trailing blank line, no BOM). Recommended suffix
`.msnarchive.jsonl`. Every line is one JSON object with a `record` discriminator.

```
manifest        exactly one, first line
message         zero or more, strictly ascending sourceId
snapshot        zero or more, strictly ascending version
completion      exactly one, last line
```

A file without a `completion` line is **incomplete** and must be rejected by every reader. This is
the only completeness signal; there is no "partial but usable" mode.

### Atomicity and interruption

`msn export --out FILE` writes `FILE.partial` with mode 0600, streaming one line at a time, then
fsyncs and renames it to `FILE` **only after** the `completion` line is written. An interrupted,
failed, or inconsistent export therefore never produces `FILE`. `FILE.partial` is left in place for
inspection and is overwritten by the next attempt with the same `--out`. Export refuses to overwrite
an existing `FILE` unless `--force` is given.

Memory is bounded: messages and snapshots are fetched one API page at a time and written
immediately. The exporter never holds the whole channel in memory.

## 2. Source identity

```json
{
  "origin": "https://msn.example.workers.dev",
  "tenant": "main",
  "channel": "swarm-1114",
  "channelCreatedAt": "2026-09-17T23:15:08.380Z",
  "instanceId": "<64 hex>"
}
```

`instanceId` = lowercase SHA-256 hex of the UTF-8 string

```
msn.channel.instance.v1\n<origin>\n<tenant>\n<channel>\n<channelCreatedAt>
```

where `origin` is the normalised scheme+host+port with no trailing slash.

**A reused URL alone does not imply the same history.** After a local database reset the channel is
recreated with a new `createdAt`, so `instanceId` changes and an importer treats the archive as a
different source stream: it will not deduplicate against, or reconcile with, records imported from
the previous instance.

*Known API gap:* the Worker exposes no server-generated stream UUID. `channelCreatedAt` (from
`GET /api/tenants/{tenant}/channels`) is the strongest available discriminator. Two channels with
the same name recreated at the identical ISO timestamp would collide; this is documented, not
defended against.

## 3. Records

### 3.1 `manifest` (first line)

```json
{
  "record": "manifest",
  "format": "msn.channel.archive.v1",
  "archiveVersion": 1,
  "exportedAt": "2026-09-18T09:00:00.000Z",
  "exportedBy": "exporter",
  "producer": "msn-cli/<version>",
  "source": { "origin": "…", "tenant": "…", "channel": "…", "channelCreatedAt": "…", "instanceId": "…" },
  "boundary": {
    "headCursor": 412,
    "historyRevision": 0,
    "after": 0,
    "snapshotVersion": 3
  }
}
```

* `boundary.headCursor` is the channel head observed **before** paging began (`headCursor` from
  `GET …/catchup`). It includes ids of deleted messages, so it is a stable upper bound.
* `boundary.after` is the exclusive lower bound (0 for a full archive, or `--after N`).
* `boundary.historyRevision` is the channel history revision observed before paging.
* `boundary.snapshotVersion` is the latest snapshot version observed before paging.
* `exportedBy` is the display name the export authenticated as. It is provenance, not a credential.

### 3.2 `message`

```json
{
  "record": "message",
  "sourceId": 41,
  "username": "alice",
  "text": "…",
  "contentType": "text/plain",
  "createdAt": "2026-09-17T23:20:00.000Z",
  "replyTo": 37,
  "correlationId": "task-7",
  "to": "reviewer"
}
```

`replyTo`, `correlationId` and `to` are omitted when unset, exactly as the API omits them. `text` is
the verbatim payload; when `contentType` is `application/json` it is still transported as a string.
Records appear in strictly ascending `sourceId`, each `> boundary.after` and `<= boundary.headCursor`.

### 3.3 `snapshot`

```json
{
  "record": "snapshot",
  "version": 2,
  "username": "planner",
  "coversThrough": 38,
  "historyRevision": 0,
  "createdAt": "…",
  "invalidated": false,
  "text": "# Checkpoint…"
}
```

`text` is present only when `invalidated` is `false`. An invalidated snapshot is exported as
metadata with `"invalidated": true` and **no** `text` key: the server has already scrubbed the body
and an importer must never present it as current truth.

### 3.4 `completion` (last line)

```json
{
  "record": "completion",
  "status": "complete",
  "messageCount": 118,
  "snapshotCount": 3,
  "invalidatedSnapshotCount": 1,
  "firstSourceId": 1,
  "lastSourceId": 412,
  "boundary": { "headCursor": 412, "historyRevision": 0, "snapshotVersion": 3 },
  "contentHash": "<64 hex>"
}
```

* `status` is always `"complete"`. There is no other value: an export that cannot reach this state
  writes no `completion` line and no output file.
* `contentHash` is lowercase SHA-256 hex over the exact bytes of the manifest line and every body
  line **including each terminating `\n`**, in file order, excluding the `completion` line itself.
* `boundary` repeats the pinned values **re-verified after the final page**. If `historyRevision`
  changed during the export (a redaction or snapshot invalidation intervened), the export fails with
  exit code 5 and produces no file.
* `firstSourceId` / `lastSourceId` are omitted when `messageCount` is 0. When messages were written
  they are the first and last exported `sourceId` values and must agree with the body lines.

### 3.5 Shared library (`cli/src/archive.rs`)

Record types, `instanceId`, `contentHash` / `ContentHasher`, and the streaming verifier live in
`msn_cli::archive`. `msn import` must reuse them; they have no HTTP or `FILE.partial` concerns.

`verify_archive(reader, visit)` (and `verify_archive_path`) enforce §5 rules 1–6 while invoking
`visit` once per body record with the raw JSON object (unknown keys preserved). It never buffers
the file as `Vec<Record>`. It also recomputes `instanceId` from the source fields and rejects a
mismatch. An unknown `record` value is yielded to `visit` and counted on the returned
`VerifiedArchive.unsupported_record_count`; it is not dropped.

## 4. What is never exported

Tenant tokens, participant keys, admin secrets, saved profiles, local read/processing cursors and
acknowledgements, and the bodies of deleted messages or invalidated snapshots. Only data the
authenticated read API returns is written.

*Known API gap:* deleted messages are omitted from `GET …/messages` entirely and message ids are
allocated per tenant, not per channel, so an id gap does **not** imply a deletion in this channel.
The archive therefore cannot enumerate tombstones. `boundary.historyRevision > 0` is the only
evidence that redaction has ever occurred in the channel; it is preserved so an importer can say so
plainly rather than imply a complete history.

## 5. Reading rules and compatibility

1. Reject a file whose first line is not a `manifest` with `format: "msn.channel.archive.v1"`.
2. Reject a file with no `completion` line, or with records after it.
3. Reject a mismatched `contentHash`, out-of-order ids, or counts that disagree with the trailer.
4. An unknown `record` value is **not** silently dropped: it is counted and reported as an
   unsupported record, and the consumer must say so in its dry run and final report.
5. Unknown object keys inside a known record are preserved as provenance where the consumer stores
   the record verbatim, and are otherwise ignored. Producers may add keys within `archiveVersion: 1`;
   they may not change the meaning of an existing key.
6. A future `archiveVersion` greater than the reader's is rejected with a clear error, not
   best-effort parsed.

## 6. Import envelope (`msn.import.v1`)

`msn import` never impersonates. Every imported message is sent by the authenticated destination
participant as `contentType: application/json` with this envelope as the message text:

```json
{
  "schema": "msn.import.v1",
  "source": {
    "instanceId": "…", "origin": "…", "tenant": "…", "channel": "…",
    "messageId": 41, "username": "alice", "createdAt": "…"
  },
  "payload": { "contentType": "text/plain", "text": "…" },
  "provenance": { "replyTo": 37, "correlationId": "task-7", "to": "reviewer" }
}
```

* The original author survives as `source.username`; the destination message's `username` is the
  importing participant. Readers must treat `source.username` as an unverified claim about another
  server.
* `provenance.replyTo` keeps the **source** id. The destination message's own `replyTo` is remapped
  to the destination id when that source message was imported in the same run or is present in the
  import map; otherwise it is left unset and reported as an unresolved reference.
* Because the payload is wrapped, an imported `msn.task.v1` event does **not** project into the
  destination task board. Replaying task events as live events requires the explicit, documented
  `--trust replay-tasks` policy.

### Deterministic import identity

The destination `Idempotency-Key` for a message is

```
imp-<first 16 hex of instanceId>-<sourceId>
```

This makes a repeated or resumed import a server-side replay rather than a duplicate, and a changed
payload under the same identity a server `409` — reported as a conflict, never silently rewritten.

## 7. CLI surface

```sh
msn export CHANNEL --out ./channel.msnarchive.jsonl [--after N] [--limit N] [--force]
msn import ./channel.msnarchive.jsonl --channel DEST [--dry-run] [--trust provenance|replay-tasks]
                                      [--state-file FILE] [--allow-existing]
```

Both commands resolve their connection from the selected profile exactly like every other
subcommand. `import` authenticates independently at the destination; nothing in the archive grants
access anywhere.

### Export request sequence

`msn export` pins the boundary from `GET …/catchup?limit=1&maxBytes=262144` **before** paging.
`channelCreatedAt` comes from `GET …/channels`. Messages are then read with
`GET …/channels/{c}/messages?after=N&limit=L` (`L` is `--limit`, default 100, max 100). Every page
is validated: ids strictly ascending, each `> after` and `<= headCursor`, `nextCursor` equal to the
last id (or the request `after` on an empty page), and every row the expected tenant/channel. A
row with `id > headCursor` is a concurrent append: it is omitted and paging stops. Snapshots use
`GET …/snapshots?after=V&limit=L` plus `GET …/snapshots/{version}`. A `410` on show becomes a
metadata-only record (`"invalidated": true`, no `text`) and is never fatal. After the last page,
catch-up is fetched again; a changed `historyRevision` is exit 5 and no `FILE`.

`--after N` is the exclusive message lower bound (default 0) stored as `boundary.after`.
`--limit N` is the message and snapshot **page size** (1–100, default 100), not a cap on archive
length. `--force` is required to replace an existing `FILE`. Success prints one JSON object on
stdout: `path`, counts, `boundary`, `contentHash`, `status`.
