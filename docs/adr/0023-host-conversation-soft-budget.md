# ADR 0023: durable conversation reassessment milestones

Status: Accepted; implemented and independently verified locally on `feat/host-soft-budget`. Extends ADR 0022.

## Decision

Retain the host's hard per-conversation activation limit, including retries and synthetic continuations. Add a configurable soft interval that asks an agent to reassess progress after each interval of logical agent turns without a new human message. Activity is not evidence of wasted work: reaching a soft milestone must not itself reject useful work or claim task failure.

The counter belongs to the conversation root in the host's local SQLite state. A logical turn is identified by its durable job ID, including the recipient: a broadcast handled by two agents consumes two logical turns. Persist a `counted` marker on each job. Root assignment, first-time counting, milestone advancement and warning enqueue must commit in one synchronous transaction. Retries, clean cancellation and restart of that job must not count it again. In particular, `attempts === 1` cannot establish first execution because clean cancellation refunds an attempt.

Persist `agent_turns`, `last_human_event_id` and `next_warning` with the existing hard activation count. A canonical message from a username outside the local configured agent roster is treated as human input. Reset the soft counter and milestone only when its message ID is newer than the remembered human message ID for that conversation. A repeated delivery to another local agent or an older human job cannot reset progress again. Jobs triggered by a human message never increment the soft counter: neither the first recipient, nor later recipients of the same broadcast, nor a replayed older human message. The counter measures agent-triggered logical turns since the newest human message. The historical column name `last_human_event_id` must not obscure that this comparison uses canonical message IDs, not event-journal cursor IDs.

At a milestone, enqueue one `coordination.budget` continuation for the current agent and channel, retaining the conversation root, and advance the milestone atomically. The continuation asks what changed, what remains, and whether peer input is actually needed; it may suggest pausing or finishing when nothing concrete remains. Budget continuations consume the hard activation allowance but never increment the soft counter. Other synthetic continuations count once per durable job. Additional warnings occur at successive interval multiples until new human input resets the soft count or the hard limit intervenes.

## Configuration

The interval is `softTurnsPerConversation`, an integer from 0 to `maxTurnsPerConversation`. `0` disables soft counting. The default is `min(16, maxTurnsPerConversation)`. Because the hard count is never below the soft count, a soft interval equal to the hard limit enqueues a warning that is immediately dead-lettered at the cap: no allowance remains to execute it. Operators who want the warning to run must set the soft interval strictly below the hard limit, and low enough that the warning turn and any follow-up fit inside the remaining allowance.

## Upgrade and rollback

Host state moves from version 1 to version 2. The migration only adds columns: `jobs.counted` and the three soft-budget columns on `budgets`. Existing rows keep their hard activation count, durable job identity and queued work; their soft count starts at zero with the first milestone at the configured interval, so no warning is emitted for history that predates the upgrade. Enabling a previously disabled interval initializes milestones the same way.

Rollback is not transparent. A version 1 host inserts budget rows positionally and would fail at its first activation against a migrated file, so version 2 files are refused at open with `unsupported_host_state_version`. Returning to an older host requires restoring a pre-upgrade copy of the state directory or starting a new one, which forfeits the old generation's cursors, outbox and keys.

## Boundaries

The local roster is a classification heuristic, not authenticated proof that a sender is a person. An agent on another host whose username is absent from this roster is classified as human input. Counters and milestones are local to one host, not a distributed quota. The server's identity and channel permissions remain unchanged.

Warnings create additional scheduled work, subject to the existing queue and hard activation limit. Persisting a warning does not guarantee its execution if the hard cap has already been reached. A warning asks for judgment; it cannot establish that a conversation is useful, complete or independently verified.

## Required verification

| Scenario | Required observation |
| --- | --- |
| Two complete soft intervals | Exactly two durable warnings, with the expected milestones |
| Retry at interval one | The same job does not increment the logical counter or enqueue a second warning |
| Clean cancellation and restart | Reclaiming with attempt one preserves the counted marker |
| Crash and restart at a milestone | Counter, milestone and warning remain mutually consistent; no duplicate warning |
| Human reset across broadcast recipients | One reset for the canonical human message, including interleaved agent work; human-triggered jobs never count |
| Replay of older human input | No second reset and no regression of the remembered message ID |
| Warning dispatch and retry | No soft counting or recursively generated warnings; hard allowance still consumed |
| Independent roots | Counters and human resets do not leak across conversations |
| Upgrade of existing state | Version 1 file becomes version 2 with preserved hard count, durable identity and queued work; explicit soft-count initialization; unknown versions refused at open |
| Warning at the hard cap | A milestone coinciding with the hard limit dead-letters the warning instead of executing it |
| One-slot runtime sequence | Real executable receives a budget continuation and can finish without polling or deadlock |

Each scenario has a test in `tests/host-store.test.mjs` or `tests/host-runtime.test.mjs`. Executed commands and outcomes are recorded in the host runtime verification document; independent local review passed. Live deployment is outside this verification claim.
