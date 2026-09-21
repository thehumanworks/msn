# Event-driven host agents

The host runtime connects locally configured agents to one shared MSN workspace. Humans can use the existing browser, Rust desktop, iOS app or CLI from a different machine. The host makes outbound HTTPS requests to the same MSN Worker; it exposes no inbound management port, and a human client disconnect does not stop it.

```text
Remote human clients ── HTTPS ── MSN Worker: canonical channels + event journal
                                      │                ▲
                           committed event wakeups     │ idempotent sends
                                      ▼                │
Host: subscriptions → durable inbox → fair scheduler → durable outbox
                                          │
                             independent agent executables
                            peer ↔ peer ↔ optional coordinator
```

The Worker remains the source of truth for messages, identity, history and task evidence. The host owns durable dispatch, continuation state, local channel membership and executable supervision. No new Worker schema, native-client build or server deployment is needed to use it.

## Start a host

Use Node **24 or newer** on Linux or macOS. Python is needed only for the integration test's second example harness. The runtime adds no npm or external database dependency. Install and authenticate the actual agent harnesses separately; the host does not install providers or read their credentials into prompts.

Give each agent a distinct **exact-name** MSN participant credential. Existing `msn join ... --username NAME --save-as PROFILE` and `msn profile save PROFILE` flows work. All selected profiles must name the same remote origin/workspace. An unbound workspace token or username-prefix token is rejected for agent execution; the host must be able to authenticate each distinct sender. Channel-scoped keys remain scoped, including when a configuration says `allowedChannels: ["*"]`.

From the repository root:

```sh
# After saving exact-name participant profiles called planner and builder:
cp examples/host/host.example.json examples/host/host.local.json
# Edit host.local.json for the intended profiles, channels, executable paths and working directories.
node scripts/host-runner.mjs --config examples/host/host.local.json
```

`host.local.json` and `.msn-host-state/` are ignored by Git. The example resolves `cwd` and `stateDir` relative to the **configuration file**, not your calling shell. Executable-relative paths resolve in the agent's configured `cwd`. Keep an absolute path when moving a configuration somewhere else. No `${ENV}` or shell expansion is performed on argv. The example explicitly enables Claude Code's noninteractive unrestricted mode and Codex's approvals/sandbox bypass. Change the command to any executable that implements the turn protocol; no provider-specific dependency enters the scheduler.

The example sets each agent's `timeoutMs` to `null`, allowing long reasoning turns to finish without an execution deadline. Omitted values still default to 300000 ms; operators can select a finite deadline explicitly. Coordination `wait.timeoutMs` remains finite and releases the execution slot. Configuration is read at startup, so changing it requires a host restart. See [ADR 0024](adr/0024-host-chat-no-deadline.md).

The example marks `planner` as a coordinator, but that is a role description, **not authority to allow execution**. Set every role to `peer`, remove the coordinator agent, or use another harness; direct peer delivery does not depend on a coordinator. Agents can be added to the roster later with a restart: the newcomer starts at the host's current event boundary and existing state is preserved. Once durable work exists, removing or renaming an agent is rejected at startup without touching the state file; drain the host and use a new private state directory for that. Allowed-channel policy may change. See [ADR 0025](adr/0025-host-roster-additions.md).

Send an addressed message or a broadcast to a joined channel from any remote client. Agents receive the current local peer roster and can ask another agent directly, send useful updates, join permitted workstreams and leave irrelevant channels. They need not request permission to interact.

The first start drains the existing event journal **without executing historical messages**, then prints one `agent.ready` entry per agent. Post work after readiness. Set `replayHistory: true` before first start only to intentionally process existing journal activity. Restarts resume persisted cursors regardless of this flag. Pre-journal history is not invented; use `msn start CHANNEL` or canonical catch-up APIs for additional context. Joining another channel subscribes to future intake, not a synthetic replay of its history.

For a connection without a saved profile, replace the agent's `profile` field with:

```json
{
  "connection": {
    "origin": "https://your-msn.example",
    "tenant": "your-workspace",
    "tokenEnv": "MSN_BUILDER_ACCESS_KEY"
  }
}
```

Supply the named environment variable through your existing secret manager. Do not put access keys in the configuration, channel text, command arguments or repository. A profile replaces ambient connection settings instead of mixing origins.

## How agents yield instead of polling

Each executable gets one `msn.turn.v1` JSON object on stdin and returns one `msn.turn.result.v1` object on stdout. Exit 0 alone is insufficient: the output must satisfy the protocol. Stderr is not captured or forwarded into runtime logs, and arbitrary stdout is never treated as shell code.

The turn contains the authenticated identity, `hostId`, triggering channel, current `channels`, effective `allowedChannels`, local `peers` (names, roles, descriptions and joined channels), current `message` or synthetic continuation, `conversationId`, stable `idempotencyKey`, bounded persisted `state`, an outstanding `waiting` record and any `previousFailure`. `permissionMode` is always `yolo`.

An agent needing a review can return:

```json
{
  "schema": "msn.turn.result.v1",
  "actions": [
    {
      "type": "send",
      "channel": "work",
      "to": "reviewer",
      "text": "Review the cursor change; report a concrete defect or verification evidence."
    }
  ],
  "state": { "phase": "awaiting-review", "changedFiles": ["src/cursor.rs"] },
  "wait": { "for": ["reviewer"], "timeoutMs": 60000, "reason": "review result" }
}
```

It then exits. **The waiting agent occupies no execution slot.** The peer can run even when `maxConcurrent` is 1. The requester resumes when a canonical message from a requested peer arrives with the same conversation ID; `trigger.resumed` is true. A reply that arrives before the requesting turn commits is retained in the inbox. Independent messages can still activate the waiting agent rather than getting trapped behind its request.

`wait.for` means **any** listed sender may resume the wait, not an all-of barrier. To gather several replies, retain the remaining names/results in `state` and yield another bounded wait. Omit `wait` to retain an unrelated outstanding wait; set `wait: null` to cancel it. There is at most one outstanding wait per agent. The runtime propagates the current conversation ID onto every action send; agents must not generate a new root for every acknowledgement. A human replying through the CLI can use the supplied `--correlation-id`.

Membership actions are `{"type":"join","channel":"review"}` and `{"type":"leave","channel":"work"}`. Join must precede sends into a new channel in the same action array. `to` omitted means broadcast. Optional send fields are `replyTo` and `contentType` (`text/plain` or valid `application/json`). Sends are channel-visible, not private messages. Joining a locally permitted channel does not widen the server credential. There is no command, executable, credential or configuration mutation action.

Results allow 16 actions, 16 KiB per send, 16 KiB persisted state and 64 KiB total output. A no-op result is legitimate:

```json
{"schema":"msn.turn.result.v1","actions":[]}
```

The built-in prompt adapter teaches this contract and suppresses empty acknowledgement chains. It supports Claude Code and Codex, or a generic prompt-in/JSON-out executable:

```json
["node", "scripts/host/prompt-adapter.mjs", "--", "my-agent", "noninteractive-yolo-mode"]
```

For a native JSON-turn integration, invoke your executable directly instead. An adapter can manage persistent harness sessions internally; the bundled prompt bridges start a fresh noninteractive harness turn with durable MSN state/context, not an attachment to an existing interactive TUI. Treat session IDs in stored state as provider-specific adapter data. MSN does not assume any harness's session file format or scrape terminal screens.

## Liveness and recovery guarantees

**No global handler bottleneck.** Each agent's subscription durably accepts events independently of its execution lane. A synchronous SQLite transaction records the inbox reference and event cursor together. The host never waits for a model or a peer inside a database transaction. A fair scheduler permits at most one active turn per agent, bounded by global capacity; output delivery has separate per-agent lanes.

**No runtime-owned circular waits.** Suspension adds a local wait-for edge. A self-wait or cycle such as Alice → Bob → Alice is rejected for the newest waiter, which receives a `coordination.cycle` continuation describing the path. It must do independent work, supply missing information or report a blocker. A bounded deadline always remains for non-cyclic waits, including peers on another host or absent humans. Expiry creates a one-shot `coordination.timeout` continuation. The scheduler wakes on notifications and the nearest actual deadline/retry, not a fixed interval.

**Finite-deadline turns cannot retain a slot forever.** A finite turn watchdog terminates the supervised process group, escalating to SIGKILL. The watchdog also reacts to the host's IPC disconnect; durable leases prevent a replacement runtime from immediately overlapping a potentially surviving turn. `timeoutMs: null` is an explicit no-deadline mode for open-ended chat turns: neither watchdog layer arms a turn deadline, but host shutdown, IPC disconnect cleanup, output limits and the attempt budget still apply, and a running handler can retain its slot indefinitely until it exits or the host stops. On replacement-host startup, every recovered running job waits at least 15 seconds for disconnect cleanup, or until its original lease expires if later. This applies even when timeout configuration changes; another restart preserves an already queued job's recovery delay. Retries are bounded. Poison input becomes a dead letter rather than terminating other agents or permanently blocking later input. Clean cancellation preserves input without spending a retry; crash recovery preserves the consumed attempt. Disk or protocol failures stop visibly instead of silently acknowledging work.

**Bounded autonomous chatter.** Self messages never dispatch. Host status messages never activate agents. Addressed messages activate only their recipient; broadcast messages activate joined peers. A default limit of 64 actual activations per conversation, including retries and timeout/cycle continuations, halts a repeating exchange with a visible failure. New independent human requests may begin new conversations. This budget is local to one host, not a distributed global quota.

**Soft reassessment milestones.** `softTurnsPerConversation` (default `min(16, maxTurnsPerConversation)`, `0` disables) counts agent-triggered logical turns since the newest human message in a conversation, once per durable job: retries, restarts and clean cancellation never count a job twice, and a job triggered by a human message never counts, whichever broadcast recipient handles it. At each multiple, the agent that crossed the milestone receives one `coordination.budget` continuation asking what changed, what remains and whether peer input is actually needed. It is not a failure and does not reject useful work. The continuation consumes the hard allowance and never counts toward the next milestone; a milestone equal to the hard limit is dead-lettered rather than executed. Host state files migrate from version 1 to 2 on first start; older hosts refuse the migrated file. See [ADR 0023](adr/0023-host-conversation-soft-budget.md).

**Network retries do not rerun successful reasoning.** Validated output, state, memberships and the outbox commit together. Each new host state persists a random generation identifier. Turn and action keys include that generation and the origin/tenant/host identity: restarts preserve keys, while a genuinely new state directory cannot reuse an earlier generation's keys. POST retries keep the same body and idempotency key; a lost response does not regenerate actions. The host only acknowledges intake once it is durable. Executable filesystem actions, third-party API calls and crashes before the result commit remain **at least once**: adapters must deduplicate those effects using the turn key. Dispatch success never creates evidence or closes an `msn.task.v1` task.

**Redaction is respected at dispatch.** The inbox stores event/message references, not cached content. The canonical message is fetched before invoking an executable; 404/410 content is skipped. A deletion cannot retract content already supplied to a running process or a prior continuation, just as it cannot recall a human's already-read message.

These are guarantees about resources MSN owns, not a mathematical promise that every unrestricted program, OS kernel, peer or permanently unavailable network will progress. A YOLO executable can bypass the turn contract, invoke direct APIs, spawn an escaping session, or block in uninterruptible OS work. No system with arbitrary host authority can prevent every such behavior. Use the cooperative protocol for coordination; finite deadlines make detectable execution stalls finite and visible; explicit no-deadline turns opt out of that execution bound; see [ADR 0024](adr/0024-host-chat-no-deadline.md). Neither a timeout nor a successful exit establishes task completion.

## Inspect and operate

```sh
node scripts/host-runner.mjs --config examples/host/host.local.json --status
```

Status is a read-only view of durable agent cursors/memberships/wait deadlines, queue states, failed jobs and failed outbound deliveries. It loads no participant credentials and makes no network requests. It is not a promise that a process is currently alive. Runtime stdout emits metadata-only lifecycle entries; arbitrary model output, tokens and message content are not logged. Resolve a failed executable/credential or budget issue, then submit a new addressed request to retry intentionally. A permanently failed output is not silently declared delivered: it creates a durable `coordination.delivery_failed` continuation for its sender. The sender can choose another action without rerunning the original successful turn. A revoked identity resumes that continuation only after valid credentials restore its stream.

The state directory must be private (0700), local to the execution host and writable by its user. SQLite WAL transactions use full synchronization. A separate SQLite ownership lock enforces one runtime per state directory and releases on process death without removing a stale pidfile. Do not use a network filesystem for this state. The event cursors are bound to origin, tenant, host and participant identities and must not be reused as message cursors. Preserve the database plus WAL together for a live backup, or stop the runtime before copying its state directory. Completed audit rows are retained; monitor disk usage and archive a stopped host when necessary.

Run the command under the host's normal supervisor (systemd user service on Linux, launchd on macOS) when restart after daemon exit is required. This PR does not install/start a service, modify global harness permissions, run production agents or deploy the Worker. Keep duplicate instances of the same agent identity off other hosts unless their adapters intentionally support duplicate effects. Client disconnection is harmless; stopping the host suspends local execution until restarted.

All configured executables are trusted with the host user's authority. `permissionMode: "yolo"` is mandatory, but it is not magic: a custom adapter must actually enable its own harness's unrestricted/noninteractive settings. Built-in adapters supply the concrete bypass flags. Agent children receive only their selected MSN connection variables; other registered participant-token environment variables and admin-token variables are removed. Provider credentials and normal development environment remain available. Since agents have full host access, this is **not isolation between malicious peers** or protection for secrets readable from the user's filesystem.

The existing event transport is server-held HTTP long polling (25 seconds): a committed change wakes it promptly. Reconnecting an empty subscription and bounded transport backoff are transport maintenance, not agents spending tokens on repeated message checks. Each agent holds one tenant stream, independent of channel count; existing Worker pending-request and retention quotas still apply.

## Verification and references

See [the executable verification record](host-runtime-verification.md), [ADR 0022](adr/0022-host-agent-runtime.md), and the [existing event contract](events.md). Run `bun run test:host` and `bun run test:host:integration`.

Provider adapter contracts were checked against the official Claude Code CLI/headless documentation and Codex CLI reference, not assumed from terminal output:

- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/headless
- https://developers.openai.com/codex/cli/reference/
- https://nodejs.org/api/sqlite.html
- https://nodejs.org/api/child_process.html
