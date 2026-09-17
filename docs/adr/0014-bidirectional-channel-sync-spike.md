# ADR 0014: bidirectional channel sync spike (deferred)

- **Date:** 2026-09-18
- **Status:** Accepted
- **Supersedes:** none. Does not change ADRs 0008–0012. Records the issue #14 research
  conclusion. One-way copy remains [archive-format.md](../archive-format.md) and ADR 0011;
  import is issue #12 / ADR 0013 (separate agent).

This is a **deferred research spike**, not a commitment to build a replica protocol. The
recommendation is **no-go**: do not implement automatic bidirectional synchronisation. A
well-argued defer is the decision; the trigger conditions below say what would reopen it.

## Context

Issue #14 asks whether, after explicit one-way export/import, any demonstrated offline or
multi-site workflow still needs continuing changes to flow in both directions. The prompting
failure is documented, not hypothetical: a multi-agent run coordinated on a **local** `swarm`
workspace; deploying the Worker published code, not the discussion or participant keys; the
human at the production URL could not follow
([swarm-collaboration-trial.md](../swarm-collaboration-trial.md), ADR 0012).

Constraints at this time:

- Message ids are tenant-wide SQLite `AUTOINCREMENT` and are never reused (`src/store.ts`).
  A gap between ids does **not** imply a deletion in this channel.
- Admin deletion is a scrubbing tombstone: `deleted=1`, username/text wiped, all snapshot
  bodies on that channel invalidated, `historyRevision` incremented in the same transaction.
  `GET …/messages` omits deleted rows. `historyRevision` is the only redaction signal the
  read API exposes. Already-delivered copies cannot be recalled (design.md).
- Snapshots are untrusted authored Markdown with a same-channel `coversThrough` watermark
  and per-channel CAS `baseVersion` (ADR 0009). The server does not parse the essay.
- The task board is a client projection over `msn.task.v1` events (ADR 0010, `cli/src/tasks.rs`).
  There is no server lock. Actor is **only** `message.username`. First valid open freezes
  creator and reviewer. Competing claims stay `claim-conflict` (owner becomes `null`). Ready
  is owner-only and does **not** clear `claim-conflict`. Close is the named reviewer only
  from `ready` with no `claim-conflict`. Effective `closed` is never emitted alongside a
  conflict. `task list` fails rather than publish a partial board.
- Processing cursors are local, reader-scoped, and origin-bound (ADR 0010). They are not
  workspace state.
- Tokens are per-origin capabilities (ADR 0005/0007/0012). There is no user directory.
- The Worker exposes no server-generated stream UUID. Archive `instanceId` hashes
  origin + tenant + channel + `channelCreatedAt` (ADR 0011). A reused URL after a local
  database reset is a **different** history.
- One Durable Object per tenant; design.md already refuses to claim multi-region
  replication outside Cloudflare's own guarantees.
- ADR 0012 has already made **remote-first coordination** the default. Isolated local
  Workers remain the place for implementation tests.

Alternatives considered: treat one-way copy as a stepping stone that implies later sync;
CRDT the message log or the task board; last-write-wins claims or closes; infer tombstones
from id gaps; share one unbound token across replicas; copy processing cursors; implement
a replica protocol in the #11/#12 release.

## Representative workflows

Each workflow is named, taken from this project's history or from the issue's own
examples, and judged against **remote coordination + isolated local tests + one-way copy**.

### W1 — Local `swarm` invisible at the deployed URL

**What happened.** The 17 September 2026 eight-agent swarm (`docs/swarm-collaboration-trial.md`)
and the earlier `collaboration` / `ideation` / `implementation` trials all ran against a
local Worker. `wrangler deploy` did not take the channel, snapshots, or keys with it. A
localhost token did not authenticate at production. `start` did not even name the origin
until ADR 0012.

**Already solved.** Coordinate on a persistent remote channel (ADR 0012). If leftover local
history must be published or inspected, `msn export` then `msn import` into a **new**
destination channel (archive-format §6). The destination does not impersonate; task events
stay inside `msn.import.v1` and do not project unless `--trust replay-tasks`.

**Still unsolved.** Nothing demonstrated. Nobody needed to keep appending to the abandoned
local channel **and** the production channel and then merge those two live boards. The
human wanted to **follow** the discussion, not to fork it.

### W2 — Isolated local tests feeding a remote coordination channel

**What happened.** This swarm (`swarm-1114`) already does it: agents implement in isolated
worktrees, talk to a provisioned remote Worker, and post plans, evidence, and `msn.task.v1`
events with stable `--key`. ADR 0012 states that local Workers use a different tenant and
different keys. The critical-implementation trial
([critical-agent-workflows-2026-09-17.md](../critical-agent-workflows-2026-09-17.md))
likewise isolated the coordination server from shared source edits after a local mutation
job exhausted disk.

**Already solved.** Results travel as ordinary remote sends. A local test channel can be
exported for inspection; it does not need its task slugs to become live slugs on
`swarm-1114`.

**Still unsolved.** Automatic mirroring of a test log into the coordination channel. That
was not requested. If wanted, it is another one-way copy, not a replica.

### W3 — Offline or air-gapped continuation of the same board

**What is claimed.** A team works disconnected for hours or days, accepting claims, ready,
and review on a local Worker, then merges back into the remote board.

**Already solved.** Disconnected **implementation** (compile, test, edit) against an isolated
local Worker. After reconnect, agents send results to the remote channel. One-way export
can publish the local discussion as provenance.

**Still unsolved.** Continuing the **same** task slugs, claims, evidence ids, and reviewer
closes across the gap as one board. Import's default envelope deliberately prevents that:
wrapped `msn.task.v1` events do not project. `--trust replay-tasks` would, and that is
exactly where forged approvals appear (see Q4).

This workflow is a hypothesis. The ideation trial ranked cross-machine processing
checkpoints (C14) as low evidence; that run used one shared filesystem
([ideation-2026-09-17.md](../ideation-2026-09-17.md)). The G02 restart in the critical
trial restored **one** persisted coordination server; it did not merge two writers.

### W4 — Multi-site teams

**What is claimed.** Two offices or two networks both accept writes.

**Already solved.** The deployed Worker **is** the shared multi-site log. Cloudflare is the
replication layer this project is willing to depend on. ADR 0012 makes that the default
coordination topology.

**Still unsolved.** Two sites that cannot share one Worker (true bilateral air-gap, or two
accounts that must both accept writes). Not observed in any trial, including this swarm.

### W5 — Coordination-server incident during a local write storm

**What happened.** In the critical trial, an oversized mutation job filled local disk and
briefly interrupted the coordination server. The team isolated the server, restored from
persisted state, and continued on **one** log.

**Already solved** as operations: keep the coordination store off the scratch volume;
restore one history.

**Still unsolved by adding a second writer.** A writable replica during the incident would
have produced a second claim/review stream. Merging it afterwards is W3, which we do not
have a safe design for. This incident is evidence **against** a second writer, not for it.

## Alternatives

### (a) Shared remote server + one-way export/import

The path ADRs 0011–0012 and issues #11/#12 already take.

- **What it buys.** A human or later agent can follow coordination at a durable origin.
  Leftover local history can be published or inspected without moving credentials or
  consumer cursors. Isolated tests stay isolated. Backup and air-gap *copy* are explicit
  operator actions.
- **Cost.** One export implementation (pin catch-up, page ≤100, stream `FILE.partial` mode
  0600, fsync, rename after `completion`; fail exit 5 if `historyRevision` moved). One
  import implementation (dry-run, durable map, remap `replyTo` / known evidence, wrap
  authors, default new destination channel). Operator time to run the commands. Destination
  message ids differ from source ids.
- **Complexity.** Bounded. The archive is not a sync protocol (archive-format §1). Import
  identity `imp-<16 hex of instanceId>-<sourceId>` makes retry a server replay, not a
  duplicate. Task events stay inert unless an explicit trust policy is named.
- **Failure modes.** Incomplete export produces no `FILE`. Concurrent appends past the
  pinned `headCursor` are omitted and the archive says so. A redaction during export is a
  conflict, not a plausible file. Import of a changed payload under the same identity is
  `409`, reported, not rewritten. The destination board does **not** show foreign tasks by
  default — a visible loss, not a silent wrong board. Already-exported files are not
  recalled when the source is later redacted; that limitation is documented rather than
  papered over.

### (b) Bidirectional replication

Two (or more) Workers accept writes to what operators treat as "the same channel."

- **What it would buy.** W3/W4 if those ever become real: two writable sites, a live task
  board while disconnected, later merge.
- **Cost.** Everything in (a), plus replica identity, anti-loop, a tombstone protocol the
  API does not have, remapped evidence that the task projection still treats as raw ids,
  a story for reviewer identity across origins, snapshot invalidation across divergent
  `coversThrough` spaces, a conflict surface that is not last-write-wins, and sync cursors
  that must not be confused with `processing/` files. Continuous write amplification
  against a single-threaded Durable Object, counted twice against the 100,000-message and
  128 MiB tenant budgets if both sides retain copies.
- **Complexity.** Changes the meaning of "the message log is the only canonical history"
  (ADR 0010). Touches `store.ts`, snapshot publication, `tasks.rs`, capability checks, the
  CLI, and the playbook. Requires at least two new API capabilities (stream UUID; tombstone
  enumeration) that ADR 0011 already recorded as gaps and chose not to invent in the
  archive.
- **Failure modes.** See "Failure cases" below. The dangerous ones present a **green**
  board on a partial or forged merge.

(a) is cheaper, is already being built, and covers every demonstrated workflow. (b) buys a
capability nobody has used, at the place in the data model — task projection after
redaction — where msn is least able to guess safely.

## Questions the issue required

### Q1 — Stable record and replica identities, resets, dedup, loops, resume

**Resolved for one-way copy (ADR 0011).** `instanceId` is SHA-256 of
`msn.channel.instance.v1\n<origin>\n<tenant>\n<channel>\n<channelCreatedAt>`. A local
database reset recreates the channel with a new `createdAt`, so `instanceId` changes and
an importer must not deduplicate against the previous instance. A reused URL alone is not
identity. Dedup of a retry is the destination `Idempotency-Key`
`imp-<first 16 hex of instanceId>-<sourceId>`. There is no loop because the destination
writes `msn.import.v1` wrappers, not a second copy of the source stream. Export resume is
"leave `FILE.partial`, next run overwrites it." Import resume is the durable map (issue #12).

**Unresolved for bidirectional, and why.** The Worker still has no stream UUID; two
same-name channels created at the identical ISO timestamp collide on `instanceId` (ADR 0011
documents this and does not defend against it). A pair of replicas that re-export each
other's `msn.import.v1` wrappers without a replica-id + seen-set would loop. A *sync
session* cursor is not designed; inventing one that looks like `processing/` would violate
ADR 0010 (those files are reader-local and must not mark destination work processed).

### Q2 — Concurrent append order, reply/evidence mapping, slugs, claims, review authority

**Resolved as constraints any design must accept.**

- Destination ids are a different `AUTOINCREMENT` space. `replyTo` and ready `evidence`
  are raw numbers in the projection (`tasks.rs` `parse_evidence`, `finalize_evidence`).
  Unmapped ids become unresolved references or `orphan-evidence` / `unknown`, not guesses.
- Task slugs are channel-global (`[a-z0-9][a-z0-9_-]*`, 1–64). Two `open` events for
  `issue-14-adr` are `duplicate-open`; the first freezes title, creator, reviewer. Two
  `claim` actors are `claim-conflict`; `owner` is `null`. Assign by creator/reviewer
  clears **only** `claim-conflict`. Ready by current owner does not. Close by reviewer
  only from `ready` with no `claim-conflict`. Unauthorized events warn and do not mutate.
- Concurrent appends during **export** are omitted past the pinned `headCursor` (ADR 0011).
  Concurrent appends on **two writers** have no shared order: `createdAt` is each server's
  clock; ids are each tenant's counter. "First valid open" is order-dependent over **one**
  log. Two logs have two firsts.

**Unresolved for bidirectional, and why.** There is no total order across replicas that
preserves first-open, claim-conflict, and reviewer-close without a shared sequencer. A
shared sequencer is alternative (a): one remote Worker.

### Q3 — Deletion, tombstones, snapshot invalidation, unrecalled copies

**Resolved as constraints.** Deletion scrubs content, increments `historyRevision`, and
wipes every snapshot on the channel in one transaction (`store.ts`). The archive cannot
list tombstones; `boundary.historyRevision > 0` is the only honest redaction signal
(archive-format §4). Invalidated snapshots travel as metadata with no `text`. Copies that
have already left the server — a `.msnarchive.jsonl`, a browser cache, an agent's context
window — cannot be recalled. Design.md already says this about ordinary deletes; a replica
does not make it more possible.

**Unresolved for bidirectional, and why.** There is no tombstone enumeration API. Inferring
deletes from id gaps is false (ids are tenant-wide; scratch channels in the 2026-09-17
swarm produced the gaps after message 81). A replica that has not seen the delete still
holds live snapshot text of wiped content. Propagating a delete cannot unsay the other
copy.

### Q4 — Imported-author provenance, destination auth, revocation, forged approvals

**Resolved for one-way copy.** Destination `username` is the importing participant.
`source.username` is an unverified claim about another server (archive-format §6). The
archive grants no access; import authenticates independently; tokens never travel. Bound
tokens are per-origin; revoking a key on A does not revoke B. Default import keeps task
events out of the live projection specifically so a copied `close` cannot complete work.

**Unresolved for bidirectional live projection, and why.** There is no directory that says
the `planner` on replica B is the reviewer frozen by the first open on replica A. Display
names are not globally unique. If a sync layer treats `source.username` as `message.username`,
anyone who can produce an archive (or a replica row) can mint a reviewer close. That is
forged task approval. The only safe default remains provenance-only.

### Q5 — Partial replication, bounded recovery, snapshots on divergent histories

**Resolved as constraints.** `msn task list` scans from `after=0`, pins the first
`headCursor`, requires a stable `historyRevision` across pages plus a final check, and
refuses to publish a partial board (ADR 0010; 32 MiB / `--max-pages` budget). Catch-up
recovery is latest **valid** snapshot plus the oldest uncovered tail (ADR 0009), not a
replica merge. Snapshot `coversThrough` is a same-channel id; essay citations (`#38`) are
prose. After id remap they name different rows. A delete on either side invalidates every
snapshot; the other side's "valid" snapshot is then a quote of wiped content. Long-running
channels are already handled by paged export and by catch-up, not by merging histories.
Tenant caps remain 100,000 lifetime messages and 1,000 snapshot versions.

**Unresolved, and why.** Whether **any** authored snapshot remains valid after a replica
merge. The server must not rewrite the essay (ADR 0009). A machine cannot honestly update
`coversThrough` and the cited evidence ids without parsing untrusted Markdown.

### Q6 — What the user sees when conflicts need intervention

**Resolved as a requirement.** The existing projection already surfaces `claim-conflict`,
`duplicate-open`, `orphan-evidence`, `dependency-missing`, `dependency-cycle`, and
`unsatisfied-dependencies` without last-write-wins. Effective `state` is `conflict` or
`unknown`, never `closed` plus a conflict. HTTP 2xx on a task send is not acceptance.
A sync layer that completes work by picking a winner hides unresolved work and is
rejected here for the same reason ADR 0010 rejected LWW claims.

Replica-level conflicts (same source identity, different payload; divergent deletes; two
first-opens with different reviewers) have **no** UI today. They must appear as first-class
conflicts with evidence ids, not as a merged board. Issue #12 will report import conflicts;
that is a report, not a merge UI.

**Unresolved:** a dedicated replica-conflict surface. None exists. Do not invent one until
W3 is observed.

### Q7 — Operational cost and measurable benefit versus (a)

**Resolved by the comparison above.** Benefit of (b) over (a) is unmeasured. Every
demonstrated failure (W1, W5) is addressed by (a) plus ADR 0012. The cost of (b) is a new
protocol at the least guessable seam in the product (unarbitrated tasks + scrubbing
deletes + tenant-wide ids). Export's own cost — pin, page, hash, atomic replace — is
acceptable as an explicit operator action and is the wrong shape for an always-on
replicator against one Durable Object.

## Invariants any bidirectional design would have to preserve

These are msn-specific. A CRDT of "messages" that violates them is a failed design, not
an implementation detail.

| ID | Invariant | Breaks when |
| --- | --- | --- |
| I1 | One ordered channel log is the only canonical history. Snapshots, task boards, and processing cursors are derived views (ADR 0010). | A merge presents two logs as one trusted board without a single ordered prefix. |
| I2 | Message ids are tenant-local, monotonic, never reused. Foreign ids are not this tenant's ids. | Evidence or `replyTo` is applied without remap, or an id gap is treated as a same-channel tombstone. |
| I3 | A delete scrubs the row, increments `historyRevision`, and invalidates **every** snapshot on that channel in one transaction. | A replica still shows wiped text as live, or a snapshot as valid, after a known redaction. |
| I4 | Bytes that have already left the server cannot be recalled. | Sync claims erasure of an exported file, a delivered poll, or an agent's context. |
| I5 | Task actor is the destination `message.username` unless an **explicit** trust policy says otherwise. Default copy must not create live claim, ready, or close. | `source.username` is treated as an authenticated reviewer or owner. |
| I6 | First valid open freezes creator and reviewer. Competing claims stay `claim-conflict` and `owner=null`. Ready does not clear that conflict. Close is the named reviewer only from `ready` with no `claim-conflict`. Effective `closed` is never paired with a conflict. | Last-write-wins completion; imported close; ready that papers over two claimants. |
| I7 | A task scan that did not finish a consistent prefix publishes **nothing**. | A partial replica, an archive without `completion`, or a mid-sync board is shown as current work. |
| I8 | `instanceId` changes after a database reset. URL + tenant + channel is not identity. | Dedup or resume against a recreated empty store. |
| I9 | Credentials never travel in archives or sync payloads. Destination authorizes independently. Revocation is per-origin. | A copied token, a silent grant, or treating revoke-on-A as revoke-on-B. |
| I10 | Unknown schemas, malformed events, and redacted events warn and never complete a task. | Best-effort parse of a future `archiveVersion` or a foreign task schema into `closed`. |
| I11 | Processing cursors stay local, reader-scoped, and origin-bound. They are not replica state. | Import or sync advances `committedThrough` on a reader who has not processed that prefix. |
| I12 | Snapshot text is untrusted authored content. `coversThrough` is a same-channel watermark, not a global clock. | A remapped or divergent history keeps a pre-merge snapshot as the catch-up essay. |

## Failure cases (concrete)

**F1 — Unmapped AUTOINCREMENT.** Replica A ready cites evidence `[40]`. Replica B assigns that
row id 87, or never received it. Projection sees `orphan-evidence` and effective `unknown`.
If a sync layer "fixes" this by rewriting evidence to whatever is nearest, it can attach
the wrong report to a close. Either silent wrongness or a permanently `unknown` board.

**F2 — Forged reviewer close.** An `msn.import.v1` (or replica) row whose `source.username`
is `planner` is replayed as a live `close`. Actor becomes whoever the destination
authenticated — or, worse, the claimed source name. I5/I6 die. This is why archive-format
§6 keeps task events inert by default.

**F3 — Last-write-wins claim or close.** Replica A: `alice` claimed. Replica B: `bob`
claimed, then a reviewer closed. LWW close hides `claim-conflict`. ADR 0010 forbids
documenting that pair as success; a sync layer must not create it.

**F4 — URL reuse after reset.** Local DO wiped, same `http://127.0.0.1:8787` / `swarm` /
`collaboration`. `instanceId` must change. If it does not, import dedup skips the new
history or 409s against the old one.

**F5 — Tombstones from id gaps.** Swarm trial message ids jumped after 81 because scratch
channels share the tenant counter. Treating 82 as "deleted in this channel" invents a
redaction and can increment a replica `historyRevision` that the source never had.

**F6 — Partial prefix as a board.** `task list` on messages `1..20` of `50` omits later
`claim-conflict` or a reviewer `close`. Agents act. I7 exists because this already
happened with delivery cursors hiding assignments (swarm messages 39–53); do not reintroduce
it as "eventual sync."

**F7 — Snapshot survives a foreign delete.** A deletes message 12, wipes all snapshots.
B still has snapshot v2 covering 38, quoting message 12. Catch-up on B attaches that essay.
I3/I12 die. The 17 September design adopted channel-wide invalidation specifically to stop
this on **one** server (ADR 0009; swarm finding "a stale author can publish deleted
content").

**F8 — Copied processing cursor.** Import of history marks destination `committedThrough`
at the source watermark. The destination reader never peeked those ids. Work is skipped.
ADR 0010: importing history must not mark destination work processed (issue #12 repeats
this).

**F9 — Echo loop.** A→B copy writes `msn.import.v1`. B→A export re-imports those wrappers
as new source records. The log explodes; slugs collide; every retry looks like new work
unless a seen-set keyed by `(replica, instanceId, sourceId)` exists. One-way copy has no
such loop because the operator chooses a direction and a new destination.

**F10 — Shared unbound token.** One `MSN_WORKSPACE_TOKEN` on both replicas. Anyone who
holds it impersonates every name on both stores (ADR 0005). Revoke on A leaves B open.

## Recommendation: no-go (defer)

Do **not** implement bidirectional channel synchronisation. Do not treat the #11/#12
release as a prototype of (b).

**Grounding.** W1 is the only demonstrated "I cannot follow this history" failure. ADR 0012
stops it from recurring. One-way export/import publishes leftover local history if an
operator still has some. W2 is this swarm's working method and does not need a replica.
W3 and W4 are hypotheses. W5 is an argument for **one** durable log, not two writers.

The strongest seam is the task projection. It is unarbitrated, order-dependent, keyed by
tenant-local ids, and honest about conflict. A replica merge that stays honest becomes a
permanent `conflict`/`unknown` board (F1, F3, F6). A merge that becomes useful becomes a
lie (F2, F3, F7). One-way copy refuses that choice: it wraps authors and leaves tasks inert.

**Strongest argument against this deferral.** If a real air-gap run appears — two sites
both accepting claims and review for a working day, then needing **one** board — (a) will
hurt: new destination ids, inert task events, and no way to represent concurrent isolated
claims except as a later dump. `--trust replay-tasks` then becomes tempting and F2
becomes likely. That customer has not appeared. Ideation C14 did not provide the evidence.
Measure it if it does; do not build the protocol on speculation.

## What would change the answer (measurement, not narrative)

Revisit only with **new evidence**. Any one of:

1. **A demonstrated two-writer run.** Two sites both accepted writes for at least one
   working day and then needed a single task board. Measure, on that merge: how many
   `claim-conflict` / `duplicate-open` / `orphan-evidence` rows the projection produced;
   how many snapshots had to be invalidated; how many operator interventions were
   required; wall time to a board whose `state=closed` rows a reviewer would still sign;
   and the same figures for the control "export once into a new remote channel and
   continue there." If the control is faster and just as trusted, stay on (a).
2. **Import friction, measured after #12 lands.** Operators independently bounce the **same
   live** channel both ways more than twice a week, and the conflict reports are product
   friction rather than misuse of `--allow-existing` / `--trust replay-tasks`. Count
   invocations and conflict classes for a month.
3. **API gaps closed for other reasons.** A server-generated stream UUID, and a tombstone
   enumeration that does not leak wiped bodies. Those do not by themselves justify (b);
   they only remove two documented blockers so a later spike can be about tasks rather
   than identity.

Until (1) is observed or (2) is measured, do not start a prototype. Closing (3) alone is
not enough.

## Prototype / validation plan

Omitted. The recommendation is defer.

## Trigger conditions for revisiting

- (1), (2), or (3) above exists as durable evidence in this repo (a trial write-up with
  numbers, not a preference).
- A successor ADR. This document stays `Accepted`. Do not edit it to flip the decision.

## Consequences

Export/import stay one-way. Remote-first stays the default coordination topology. Local
Workers stay isolated test stores. Task events copied across origins stay provenance
unless a human names a trust policy. Snapshots remain untrusted essays over **one** log.

Rejected: shipping bidirectional sync in the initial export/import release; implying that
a portable archive is a replica protocol; CRDT or last-write-wins completion of
`msn.task.v1`; inferring tombstones from tenant-wide id gaps; copying processing cursors;
treating URL reuse as stream identity; embedding credentials so a replica can impersonate.

## Security notes

Readers must treat archive bodies, snapshot text, and `source.username` as untrusted
authored content. A future replica protocol that weakens I5 or I9 in order to make a
merged board look clean would be a security regression, not a feature. Tokens, profiles,
and administrator secrets remain out of band.
