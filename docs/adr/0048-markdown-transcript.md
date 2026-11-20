# ADR 0048: download a board as a Markdown transcript

Date: 2026-11-20. Status: implemented (CLI, web). No Worker, API or schema change.

## Context

The owner approved "Download a board as a readable transcript". The only way to take a board's history away was `msn export`, which writes the `msn.channel.archive.v1` JSON-lines archive (ADR 0011). That file is built for `msn import`, not for people: no headings, raw JSON per line. People want to share a finished board, attach it to a PR or hand it to an agent as plain reading.

Message text is untrusted: anyone holding a board credential can post. A transcript that pasted message text into Markdown as-is would let a message add headings, close the surrounding structure, forge another message's header, or inject raw HTML into a viewer that renders it.

## Decision

**One document, two producers.** `public/transcript.js` (web) and `cli/src/transcript.rs` (CLI) build the same Markdown from message rows exactly as `GET …/messages` returns them. `tests/fixtures/transcript-cases.json` is the contract: both test suites render every case and must produce exactly the listed text, as with `markdown-cases.json` (ADR 0043).

**Shape.**
- A title `# Transcript of #CHANNEL`, then workspace, board, the message count and id range, "Starts after message #N" when `--after` was used, and the export time.
- Per message: an anchor `<a id="msg-ID"></a>`, a heading `### #ID · YYYY-MM-DD HH:MM:SS UTC · SENDER` (the time comes first, so a sender name cannot fake it), then optional lines `Reply to`, `To`, `Labels` (sorted by key) and `Attachments` (by index: name, size, media type), then the text.
- **Reply links.** A parent that is in the transcript links to its anchor. A parent outside it (before `--after`, or deleted) links to the message link of ADR 0042, which opens the web app on that message with the reader's own access. No link carries a credential.
- Times are UTC in both producers, so a transcript does not depend on the machine that made it. Sizes use integer arithmetic so both producers round the same way.

**Escaping.**
- *Message text* goes verbatim inside a fenced code block whose backtick fence is one longer than the longest backtick run in the text (at least three). In CommonMark a fence closes only on a line of at least as many backticks, so no message can end its block, and nothing inside a code block is read as a heading, list, link or HTML. Info string `json` for `application/json` messages, `text` otherwise. CR and CRLF become LF; nothing else is changed. This keeps the text exactly as sent, which is what an agent or a reviewer needs, at the cost of not rendering the message's own formatting (ADR 0043) in a Markdown viewer.
- *Every other value from the board* (sender, recipient, label keys and values, file names and media types, and a malformed time) is written on a line that starts with fixed text, with a backslash before each of `` \ ` * _ [ ] ( ) < > & ! ~ | # $ : @ `` and before a `.` that follows `www`, and with line breaks, other control characters, bidirectional controls and invisible characters (zero-width, soft hyphen, word joiners, U+061C, U+180E, tag characters U+E0000 to U+E007F) replaced by U+FFFD. So such a value cannot start a block, break its line, form a link (including GFM autolinks of `https://…`, `www.…` and `a@b.c`), hide text from a person that an agent still reads, an HTML tag, an entity, a table cell, GitHub math or a closing heading sequence, or visually reorder the line.
- Workspace and board names are slugs; they are escaped in text anyway and appear unescaped only inside link targets, where a slug needs none.

**CLI.** `msn export CHANNEL --format md [--out FILE] [--after N] [--limit N] [--force]`. `--format jsonl` stays the default and still requires `--out`; leaving it out now says to use `--format md` to print a transcript (exit 2). The transcript reuses the archive's consistency rules: it pins the board head and history revision through catch-up, pages messages with the same validation, stops at the pinned head, and fails with exit 5 and no output if the history revision changed (a redaction) during the run. Without `--out` the transcript is printed to stdout only after every page was read; with `--out` it is written as a mode 0600 `FILE.partial`, synced and renamed, an existing file needs `--force`, and a JSON summary (`path`, `format`, `messageCount`, `boundary`, first and last id) is printed. Snapshots are not part of a transcript.

**Web.** A **Download** button in the board toolbar reads the open board the same way (pin, pages of 100, re-check the revision) and saves `TENANT-BOARD-transcript.md`. It shows progress in the status line, does nothing if the connection or board changes while reading, and asks to try again if history changed.

## Consequences

- People can share or archive a board as one readable file; agents can be handed it as plain text.
- Formatting inside messages shows as source in a Markdown viewer. It stays readable as text and cannot break the document.
- Two producers must stay in step; the shared fixture makes drift a test failure.
- Desktop and iOS do not offer Download yet. They can call the same code later (desktop links `msn_cli`; iOS could port the JS module).
- Nothing new on the server, so nothing to migrate and no new load beyond the existing paged reads.

## Rejected

- **A server endpoint that renders Markdown.** Server work and a second history route for something both clients can build from existing pages.
- **Blockquoting message text and escaping only HTML.** Escaping `<` correctly needs to know which parts are code, which means a full Markdown parse; a mistake there lets raw HTML through. A code fence needs only a backtick count.
- **Backslash-escaping all message text.** Safe, but the raw file fills with backslashes and loses its line breaks, which defeats a readable transcript.
- **Local time.** It would make the same board export differently on different machines.
