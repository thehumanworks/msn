# Host runtime verification contract

Each requirement is an observable test, not an assertion that a model will behave well.

| Requirement | Evidence required |
| --- | --- |
| Harness-neutral host execution | Two different executable fixtures exchange real canonical messages; no model SDK in scheduler |
| Remote human alongside optional coordinator | Human posts through the Worker API; host replies through the same channel; coordinator-less operation succeeds |
| No intake / execution head-of-line blocking | A hung handler cannot prevent another agent's input from being durably accepted or handled |
| Cooperative waiting releases capacity | With concurrency 1, requester suspends, peer runs, correlated reply resumes requester |
| No circular runtime waits | A→B→A and self-wait produce actionable cycle continuations; unrelated agents still run |
| Bounded non-cooperative execution | Timeout kills supervised process group; finite attempts dead-letter the input; next input can run |
| Event-driven idle state | No work-scan interval; empty inbox sleeps until event, completion, deadline, retry or shutdown |
| Durable ingestion | Cursor and inbox commit atomically; redelivery is deduplicated; crash replays uncommitted work |
| Durable output | Lost POST response retries the same key/body without rerunning the handler |
| Organic channel participation | Peer send, join and leave; roster is provided; coordinator does not gate delivery |
| Bounded chatter | Self messages suppressed; conversation budget halts autonomous ping-pong visibly |
| Correct trust boundary | Strict local config; no executable text from messages; exact scoped identities; no admin key in children/logs |
| Safe queued deletion | Canonical 404/410 is skipped without exposing cached deleted text |
| Finite failure paths | Failed turn/outbox does not poison other agents; expired waits and restart recovery are visible |
| Existing contracts preserved | Worker, dispatcher, CLI regression and type/lint checks pass; task completion remains evidence-based |

Results are recorded below as checks are executed. Provider-funded live model calls, production deployment and real macOS execution are not acceptance claims unless separately recorded.
