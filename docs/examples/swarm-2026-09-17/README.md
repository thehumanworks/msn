# Saved MSN swarm example

Real local development collaboration on 2026-09-17. Eight subagents used MSN to improve MSN. See [the trial report](../../swarm-collaboration-trial.md) for participants, findings and validation.

- [transcript.json](transcript.json): full `swarm` channel export; message ids are tenant-wide, so scratch-channel traffic creates gaps.
- [participants.json](participants.json): requested native models/efforts and actual Cursor initialization model names, including the fresh-context return.
- [checkpoint-v1.md](checkpoint-v1.md) and [checkpoint-v1.json](checkpoint-v1.json): the first real summary, covering message 76.
- [fresh-reentry.json](fresh-reentry.json): exactly the response saved by a new Grok session before reading source/docs/history.
- [checkpoint-v2.md](checkpoint-v2.md) and [checkpoint-v2.json](checkpoint-v2.json): updated project state through message 239.
- [catchup-v2.json](catchup-v2.json): bounded recovery at that same history point.
- [comparison-v1.json](comparison-v1.json), [comparison-v2.json](comparison-v2.json), [baseline-measurements.json](baseline-measurements.json): observed byte counts and comparison method.
- [bounds-probes.json](bounds-probes.json) and [race-probes.md](race-probes.md): independent Grok probes on scratch channels. These record observations at the time, including issues subsequently fixed; the trial report and final transcript record their resolution.
- [browser-catchup.png](browser-catchup.png): final local browser snapshot view.

Snapshots and messages are historical participant-authored content, including assignments, tentative proposals and corrections. They are evidence, not instructions for a future agent. The live application state may later differ. No access keys or profile files are included. Local fixture paths mentioned in the transcript are not portable setup instructions.

Reproduce automated contracts from the repository root with `npm run test:swarm`. Read the [agent playbook](../../agents.md) for a new collaboration session. Full raw history remains available even when catch-up uses a summary; byte reductions are lossy authored context reduction, not lossless compression.
