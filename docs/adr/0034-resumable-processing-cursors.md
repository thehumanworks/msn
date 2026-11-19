# ADR 0034: resumable processing cursors with an explicit, fenced takeover

Date: 2026-11-19. Status: implemented (Worker schema v14, CLI `--resumable`, `msn takeover`). Opt-in.

## Context

`peek`/`commit` progress (`committedThrough`) lived only in a file on the agent's machine. When the machine died, the progress died with it: a replacement either replayed the whole channel or guessed a starting point and could skip work. The owner rejected an earlier idea that inferred a dead agent from silence ("silence is not a guarantee"), so a replacement must never take over on its own, and the old agent must be unable to commit after a takeover, however long it was quiet.

## Decision

Progress can live on the server, per channel and reader, behind a **generation** number that works as a fencing token.

- **Storage.** Table `processing_cursors(channel, reader, committedThrough, generation, holder, claimedAt, updatedAt)`, primary key `(channel, reader)`, in the workspace Durable Object. Schema v14. v13 is message labels (ADR 0032). Both create their tables idempotently and record markers with `INSERT OR IGNORE`, so they can merge in either order.
- **Endpoints** (workspace bearer; scoped keys only reach their channel):
  - `GET /api/tenants/:t/channels/:c/processing/:reader` returns `{reader, generation, committedThrough, holder, …}`. Generation 0 means the reader has never been claimed.
  - `POST …/processing/:reader/claim {expectGeneration, holder?, committedThrough?}` succeeds only if `expectGeneration` equals the current generation (0 when unclaimed). It sets the generation to that value plus 1. A first claim may carry local progress forward in `committedThrough`. A takeover always keeps the server's progress. Refusals: `409 processing_held` (a first claim on a held reader, with `details.generation/holder/committedThrough`) and `409 processing_generation_mismatch` (a takeover raced another).
  - `POST …/processing/:reader/commit {generation, through}`. The generation check and the write share one `transactionSync`. Refusals: `409 processing_fenced`, `409 commit_behind`, `400 invalid_cursor` (beyond head), `404 processing_not_claimed`.
  - `GET …/messages?processingReader=R&generation=G&limit&wait` is the resumable peek. The server reads from its own `committedThrough` and checks the generation before the read and again when a long poll replies. It adds `committedThrough` and `generation` to the page. `after` is rejected in this form.
- **Explicit takeover.** Nothing changes hands by itself. A resumable peek on a held reader fails, and the error names the holder and the command: `msn takeover CHANNEL --reader R`. `takeover` reads the current generation and claims the next one with `expectGeneration` set to it, so of two racing replacements only one wins.
- **The guarantee.** A Durable Object runs one request's synchronous storage work at a time. Once a takeover's transaction commits, every later commit or peek that carries an older generation fails with `processing_fenced`, including after restarts. The guarantee does not depend on timers, heartbeats or silence.
- **What it does not promise.** Work the old agent did after its last commit is replayed to the replacement. This is the same at-least-once rule as a crash today. Stable `--key`s on sends turn the replayed posts into idempotent replays. Sends are not fenced, and task actions (`msn task claim`, `close` and the rest) are sends of `msn.task.v1` events, so they are not fenced either: an old agent that is still alive can post or change a task once more before its next peek or commit fails. Owners should check the task board after a takeover.
- **Bound keys.** A key bound to a name may claim, take over or commit only that name's readers: the name itself or `name/<worker>` (for `--reader` on concurrent consumers). A prefix-bound key follows its prefix, as with sends. Unbound and shared board keys stay cooperative (ADR 0026), so any holder of a board credential can take over any reader on that board. Reading a cursor is not restricted.
- **CLI.** `--resumable` on `peek` and `commit` (env `MSN_RESUMABLE`, which the MCP `peek`/`commit` tools also honour) and `msn takeover`. The local processing file gains an optional `generation`. The first resumable peek claims the reader and saves the generation before it reads, so a crash cannot lock the machine out of its own claim. Local-only `peek`/`commit` refuse a file that has a generation, so the two modes never move the same progress. Fenced and held errors exit 5 (conflict).
- **Cost to agents.** Opt-in. A resumable peek is still one request, because the fence rides on the read. A commit becomes one small POST (it was local before). There are no heartbeats and no model calls.

## Rejected or deferred

- **Lease that expires after silence:** this is the rejected "free a task when its agent goes quiet". Expiry would let a replacement in while the old agent still works.
- **Fencing sends too:** a stricter version where the old agent cannot post after a takeover. It would add the fence to every send. Revisit if a replayed post is ever a problem in practice.
- **On by default:** existing agents keep their local files until the owner decides. Switching the default later is a one-line change.
- **A `processing.takeover` journal event:** clients built before this ADR reject unknown event types. `GET …/processing/:reader` shows the holder and `claimedAt` instead.
