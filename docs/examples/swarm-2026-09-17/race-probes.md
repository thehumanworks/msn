# grok-races round 2 — measured probes

Channels: `races-r2-cas`, `races-r2-other`, `races-r2-redact` (not swarm).
CLI wrapper `/tmp/msn-swarm-20260917/msn grok-races`.
CF docs fetched 2026-09-17: DO rules + DO/Workers limits.

## Recovered assignment

Catchup (no --after) snapshot v1 coversThrough 76: adversarial CAS/replay/redaction/identity probes. Tombstone repair with fresh revision is allowed (#64).

## Measured results

| Case | Result | Evidence |
|---|---|---|
| I1 spoof `--username alice` | 403 username_bound | stderr: This access key may only send as "grok-races" |
| I1 key not reserved | later publish key `races-r2-spoof` created v5 | probe_r2_extra.json |
| C1 cross-channel coversThrough=106 on cas | 400 invalid_coverage | id 106 is races-r2-other |
| C4 future 999999 | 400 | |
| C6 coversThrough=0 with live 104-105 | **201 allowed** | first snapshot v1 on cas |
| P5 snapshot key == message key | 201 on other | key races-r2-other-1 |
| R3 coverage regress to 0 | 400 | |
| R1 concurrent same baseVersion | exactly one create (v3) + one 409 | probe_r2_results.json |
| R2 winner replay after v4 | 200 replayed v3 | |
| P3 changed body same key | 409 idempotency_conflict | |
| T1 oldest tail limit=5 | ids 113-117 of 25 extras | hasMore/incomplete true |
| T2 omit after | snapshot present | covers 105 |
| T2 after=105 | snapshot null, empty tail | |
| T2 after=104 | snapshot null, [105] | no skip to later snapshot |
| T6 small snap maxBytes=1024 | 200, 2 msgs, ser=1003, byteLimitReached | |
| T6 12KiB snap maxBytes=1024 | 413, CLI stderr has no requiredBytes | reproduces #96 |
| T after > head | 400 invalid_cursor | |
| T7 catchup vs reader files | no files changed | |
| list | no `text` field | versions 1-4 |
| show latest | has text | |
| offline `covers-through 08` | exit 2 | |
| historyRevision=1 while server 0 | 409 history_conflict | no delete occurred |
| CLI help default | prints 65536; config.rs 32768 | already assigned to sol-cli |
| snapshotDue after 25 tail | message_threshold | |

## Redaction (after lead DELETE 204 on races-r2-redact:138)

| Case | Result |
|---|---|
| show v1 | 410, no text |
| list v1 | invalidated, username "", no text field, historyRevision 1 |
| catchup | snapshot null, historyRevision 1 |
| poll after 0 | empty (secret gone) |
| replay key races-r2-redact-snap | 410 cannot restore |
| publish histRev 0 | 409 history_conflict |
| publish histRev 1 coversThrough=138 tombstone | 201 v2 (allowed #64) |
| catchup after repair | attaches v2 |
| show v1 after repair | still 410 |

C6: lead #219 says coversThrough=0 on nonempty is intentional.
413 recheck after lead fix: `at least 12570` now in stderr.

## Code notes (read-only)

- `coversThrough` existence is `SELECT id FROM messages WHERE channel=? AND id=?` (tombstones count). Matches #64.
- `latestSnapshot` includes invalidated rows for CAS baseVersion and regression check.
- Delete wipes all channel snapshot text + increments `channel_history` in one transactionSync.
- Authorize after body/hash awaits; no await before publishSnapshot transaction.
- CLI `error_message` still keeps only `error.message`; after lead's server change that message includes `at least N`.
