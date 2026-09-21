# ADR 0024: no execution deadline for conversational host agents

Status: Accepted. Extends ADR 0022; complements ADR 0023.

## Decision

Set agent `timeoutMs` to explicit `null` in the bundled host example and in the Ares conversational host configuration for Codex and Claude. Long reasoning and implementation turns should be able to finish without an arbitrary wall-clock cutoff. Keep the compatibility default of 300000 ms when the field is omitted; operators may still explicitly configure a finite deadline from 10 to 3600000 ms.

`null` disables both the turn worker's deadline and the supervisor's deadline. It does not disable host shutdown, IPC-disconnect cleanup, output limits, retry limits or the hard conversation activation budget. A running handler can retain its execution slot indefinitely. Soft conversation reassessment milestones count completed scheduling progress; they cannot interrupt a stuck handler.

Coordination `wait.timeoutMs` remains a required finite deadline. Such waits release the execution slot and schedule a continuation; they do not terminate the peer's process. Execution deadlines and coordination waits serve different purposes.

## Recovery and activation

A no-deadline turn records a fixed 15-second recovery lease. A replacement host delays recovery of previously running work until at least 15 seconds after replacement startup, or the original lease if later. Repeated restart preserves queued recovery delays. This gives disconnected watchdogs time to terminate their process groups; it does not provide exactly-once external effects.

Configuration is loaded once at startup. Updating a live host's file does not alter deadlines already installed in memory. Restart that host after active turns have durably returned their results, preserving its private state directory. The live configuration stays outside Git; the example and this ADR record the reproducible policy.

## Verification

Existing host tests cover null validation, normal completion, bounded cancellation, IPC-disconnect cleanup, runtime shutdown and restart recovery, including expired no-deadline leases. See [the verification record](../host-runtime-verification.md). Local configuration validation establishes the values on disk; it does not establish activation in a running host or live restart behavior.
