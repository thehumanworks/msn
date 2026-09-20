# ADR 0022: event-driven, harness-neutral host agent runtime

Status: Accepted. Extends ADRs 0010, 0017 and 0020. Supersedes the one-handler-at-a-time dispatcher as the recommended multi-agent runtime; its public interface remains compatible.

## Decision

Keep the existing authenticated Worker as the durable, remote-accessible channel service. Add a host-side Node runtime, using built-in SQLite and process APIs, with no model SDK dependency and no inbound network listener. Existing browser, Rust desktop, iOS and CLI clients communicate through the same remote workspace. Disconnecting a client does not stop the host. Linux and macOS are the supported execution hosts.

Each locally configured agent has an exact-name participant credential, trusted executable argv, working directory, initial channel memberships, allowed channels and `permissionMode: "yolo"`. Commands and credentials can only be configured on the host, never by a channel message. The runtime neither asks for tool approval nor sandboxes the agent; adapters must enable their harness's noninteractive unrestricted mode. This is a trusted-host execution contract, not a claim that an environment variable can override every harness's permission implementation. Credentials retain their existing server scope. YOLO host access is intentionally powerful, not a security boundary between agents.

Independent event subscriptions persist an inbox reference and its event cursor in one SQLite transaction **before** dispatch. Only canonical messages addressed to the agent, or broadcasts in a joined channel, activate it; self messages and runtime diagnostics do not. The inbox contains references, not cached message bodies. Messages are reread immediately before execution so redacted queued content is skipped. Intake never awaits a model, a peer, or outbound delivery.

A fair scheduler runs at most one turn per agent, subject to a host-wide concurrency limit. A versioned JSON stdin/stdout turn protocol supplies identity, a peer roster, the triggering message or continuation, bounded durable agent state and an idempotency key. Agents can send messages, join/leave permitted channels and suspend for a correlated peer reply. An optional coordinator is an ordinary peer, never a mutex, turn-taking authority or mandatory routing hop.

Suspension persists a deadline and releases the execution slot. New work can still wake the agent. A local wait-for graph rejects a cycle by enqueueing an actionable continuation for the newest waiter; deadlines enqueue timeout continuations. The scheduler sleeps on notifications and the nearest actual deadline/retry, never a fixed-interval work scan. An executable that blocks instead of yielding has a finite watchdog; retries are bounded and failure moves to a visible dead letter rather than stopping unrelated agents. A per-conversation activation budget bounds autonomous ping-pong. These are explicit liveness guarantees for runtime-owned resources, not a proof that arbitrary unrestricted user programs or unavailable infrastructure always make progress.

Turn output is validated and committed with state, memberships and a transactional outbox. Output sends use stable per-turn/action idempotency keys. A network retry never reruns a successful model turn or regenerates its output. Crash recovery replays unfinished inputs with the same key; external filesystem or third-party side effects remain at-least-once. Dispatch success never creates task evidence or closes an `msn.task.v1` task.

## Alternatives

A global channel lock or mandatory coordinator introduces head-of-line blocking. One model-side polling loop per agent wastes tokens and cannot guarantee progress. Replacing the Worker and native client protocols would discard tested authentication, replay and task authority. Hardcoding an agent SDK would couple transport and orchestration to a harness. A broker, database service or additional native binary is unnecessary for one host; Node is already part of the project. A single executable adapter alone cannot supply independent durable mailboxes, supervision or wait-graph handling.

## Operational boundaries

One runtime owns one private local state directory. A host's agent roster and origin/tenant/identity binding cannot silently change under persisted work. Different hosts must not run the same agent identity concurrently unless explicitly designed for duplicate effects. Deploy with a process supervisor for restart after host-daemon exit. No production service or agent is installed or started by this change.

The event service uses server-held long polls (25 seconds), awakened by committed events. HTTP renewal and bounded transport backoff are not agent work polling. Cloudflare's existing quotas and event retention limits remain unchanged. No credentials or history are copied between origins.

## References

Checked 2026-09-20: https://nodejs.org/api/sqlite.html (DatabaseSync, transactions); https://nodejs.org/api/child_process.html (spawn, process groups, IPC); https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ and https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ (existing event service). Node 24+ is the host runtime baseline; CI tests Node 24 and 26.

Verification and results: [host-runtime-verification.md](../host-runtime-verification.md).
