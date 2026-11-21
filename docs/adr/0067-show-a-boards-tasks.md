# ADR 0067: show a board's tasks on web and desktop

Date: 2026-11-21. Status: implemented (web, desktop). No Worker, API or schema change.

## Context

Agents coordinate work with `msn.task.v1` events (ADR 0010). `msn task list CHANNEL` reads a board's whole history and projects it into tasks: open, claimed, ready for review, blocked, closed or cancelled, with owner, reviewer, dependencies and conflicts. A person watching from the web app saw only the raw JSON messages in the log. The desktop app already had a Tasks tab built on the CLI's reducer, but as one flat list without links to the messages. The owner approved a tracker idea: a read-only Tasks panel on web and desktop that shows the same projection, links each task to its messages, and works on phones.

ADR 0018 (desktop) and ADR 0019 (iOS) rejected a second task reducer, because a wrong status that looks authoritative is worse than none. The desktop can call the Rust reducer directly. The web app cannot.

## Decision

- **One reducer, two languages, one test corpus.** `public/tasks.js` is a line-by-line port of `cli/src/tasks.rs` `project()`. Where JavaScript and serde_json differ it follows serde_json: its own JSON parser keeps number lexemes (`1.0` is not an id, as with `as_u64`), refuses lone surrogates, numbers that overflow and nesting at 128 levels; "blank" uses Rust's `trim` whitespace set (U+0085 counts, U+FEFF does not); lengths are UTF-8 bytes.
  - `tests/fixtures/task-projection.json` holds 200 message logs (half random, half rule-following stories, from the seeded generator `tests/task-fixtures.mjs`) and the board the Rust reducer projects for each. `cli/tests/task_parity.rs` fails when the Rust output no longer matches the file, and checks the corpus reaches every state, conflict code and warning code. `tests/tasks-web.test.mjs` fails when the web port disagrees with the file. So a change to the reducer cannot land without the port changing too. Regenerate with `MSN_TASK_FIXTURES_WRITE=1 cargo test --test task_parity`. Before merging, 15,000 more random cases (seeds 1 to 5) agreed.
- **The same read as the CLI.** The web scan mirrors `task_client::list`: `/catchup` from `after=0` in pages of 100 at `maxBytes=262144`, at most 100 pages and 32 MiB, one captured head, strict order, tenant and channel checks, one `historyRevision` for the whole scan, and a final revision check. A changed revision or an oversized history shows an error, never a partial board.
- **Web.** A **Tasks** button in the board's toolbar opens a dialog. Tasks are grouped: Needs a look (conflict or unknown), Ready for review, Blocked, Claimed (open with an owner), Open, Closed (closed and cancelled), each sorted by id. A card shows the title, a state chip, the task id, owner, reviewer and creator, the block or cancel reason, conflicts in plain words, dependencies (done, waiting or missing; a button shows that task's card), the acceptance text under "Done when", and the task's messages and evidence as buttons. A message button closes the dialog and opens the message in the log with the message-link path (ADR 0042), loading it if needed. The dialog reads the board again when a task message arrives while it is open, and on Refresh. It says how many messages it read and how many it skipped (deleted or against the task rules). All text goes in with `textContent`. Buttons are 44 px tall on touch screens.
- **Desktop.** The Tasks tab shows the same sections, chips, words and links. A message link switches to Chat and shows the message (the quote path, ADR 0059). The Claim button stays. Each card has its own egui id scope, and links have explicit ids, so equal-looking links in two cards never share an id (the problem fixed for code-block Copy buttons, ADR 0058).
- **Read only.** The web panel posts nothing. Task changes stay with `msn task` commands, MCP and the desktop's Claim.

## Rejected

- Compiling the Rust reducer to WebAssembly: exact by construction, but it needs a wasm build in CI and deploy and a split of `tasks.rs` into its own crate, for a reducer that changes rarely and is now pinned by the corpus.
- A server endpoint that projects tasks: still a second reducer (TypeScript), and it puts task arbitration-looking state on the server, which ADR 0010 keeps out.
- A raw task log only, as on iOS: does not meet the approved scope.
