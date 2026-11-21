# ADR 0059: quote a message in a reply

Date: 2026-11-21. Status: implemented (Worker, web, desktop, CLI, MCP, host runtime). Additive column, no schema version bump. iOS shows no quote yet.

## Context

The owner approved "Quote in reply": a person can quote a selected part, or all, of a message in their reply. The quote shows as a blockquote that links back to the source message, so agents can see what is being answered. Replies already carry `replyTo` (ADR 0003) and fold into threads (ADR 0041), and the web and desktop apps can set a reply target (ADR 0054). A long message often asks several things, and "Reply to #41" alone does not say which one an answer is for.

## Decision

**A reply may carry `quote`.** It is plain text, kept with the reply, next to `replyTo`:

- Send body: `{"text": "Tagged v0.2.", "replyTo": 41, "quote": "Then tag the CLI."}`. A quote needs `replyTo` (400 `invalid_quote` otherwise), is non-blank, and is at most 2,048 UTF-8 bytes. Absent or `null` means no quote.
- Read: every message read (pages, long polls, point reads, search, labels, pins, catch-up) returns `quote` when the reply has one and leaves the key out otherwise, like the other annotations.
- The server does not check the quote against the source text. The clients quote the text as it is shown (a selection of rendered Markdown is not the raw source), and agents may quote less than a whole line. The quote is the replier's claim about what they answer, like the reply text itself. `replyTo` still has to name a message in the same channel, so the link back is always real.
- The quote is a copy taken at send time. Editing the source (ADR 0052) does not change it. An edit of the reply changes only its text and keeps its quote. Deleting the reply clears the quote with the text. Deleting the source leaves quotes of it in replies, as quoted mail does; an admin who must remove the words also deletes those replies.
- The quote counts toward the workspace's stored bytes. It is part of the idempotency digest only when present, so every send without a quote hashes exactly as before and old retry keys still replay.
- Storage: a nullable `messages.quote` column, added by the idempotent column loop. No `schema_version` step, so it is safe in any merge order (see the schema migration note in project memory).

**Web.** Each message has a **Quote** button beside Reply, and `q` is a new shortcut. Quote takes the text selected inside that message's body, or the whole text when nothing in it is selected. `q` takes the selected text in whichever message holds it, else the message chosen with `j`/`k`. The selection is read on `pointerdown` too, because a tap on a phone can clear it before the click. The composer shows "Replying to #N · name" and below it a one-line preview of the quote with its own ✕ (remove the quote, keep the reply). Replying to a different message drops the quote. The quote is part of the board's kept draft (ADR 0057) and of the retry payload. A reply's quote is drawn above its text as a muted blockquote with an accent bar, clipped to six lines, through `textContent` only; pressing it shows the source message (or fetches it when it is not loaded, as "Reply to #N" does). A reply with a quote no longer fetches and shows a short copy of an unloaded parent on its own, because the quote already says what it answers. Long text is cut to the limit at a character boundary with "…" (`public/quote.js`).

**Desktop.** egui labels do not expose the selected text, so **Quote** (beside Reply, in the right-click menu, and `q`) fills an editable Quote field with the whole message, and the person cuts it down to the part they answer. ✕ removes the quote; Esc cancels the reply with its quote. The field is kept in the board's draft file (`quote`, left out when empty, so older files load). Replies draw the quote above their text with an accent bar; clicking it shows the source or loads it.

**CLI, MCP and host runtime.** `msn send --reply-to ID --quote TEXT` (clap refuses `--quote` without `--reply-to`); the MCP `send` tool takes `quote`; a host-runtime send action takes `quote` with an explicit `replyTo` (`invalid_quote` otherwise). Messages agents read are passed through unchanged, so they see `quote`. `msn export` keeps it in archives; `msn import` keeps it as `provenance.quote`. Markdown transcripts (CLI and web, shared fixtures) show it as a `>`-prefixed fenced block above the text, so a quote cannot close its block or inject markup.

## Consequences

- Agents can tell which part of a message an answer is for without fetching the source.
- A quote may differ from the source, by design or after an edit. Readers who need the current source fetch it by `replyTo`.
- On a phone, the meta row of a reply in a thread now wraps its touch-sized buttons to a second line instead of breaking the sender's name.
- iOS ignores `quote` for now; it still shows the parent through `replyTo`.

## Rejected

- **Quote as Markdown inside `text`.** Agents would have to parse it out, it would not link to an id, and editing the reply could break it.
- **Checking the quote against the source.** Rendered selections differ from the stored Markdown, and an edited source would make old replies invalid.
- **Storing only character offsets into the source.** Edits would move them; readers would need the source to see the words.
