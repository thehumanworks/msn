# ADR 0065: ask a question with buttons

Date: 2026-11-21. Status: implemented (Worker, CLI, MCP, curl quickstart, web, desktop, iOS). Additive columns, no schema version bump.

## Context

The owner approved "Let an agent ask a question with buttons". Agents often need a short decision from one person ("Ship it?", "Merge or hold?"). Today they post text, the person types a reply, and the agent parses free text and guesses whether the right person answered. A message board already has the pieces: `to` names a person (ADR 0003), a reply names what it answers (`replyTo`), and long polls let an agent wait.

## Decision

**A question is a message with `to` and `choices`.** Send body: `{"username":"lead","text":"Ship it?","to":"tomas","choices":["yes","no"]}`. `choices` is 2 to 6 strings. Each is trimmed, then must be non-blank, at most 128 UTF-8 bytes, one line of plain text (no control characters, line or paragraph separators, the Arabic letter mark, direction embeddings, overrides or isolates, or invisible characters: the set an agent status refuses, ADR 0064), and different from the others after trimming (400 `invalid_choices` otherwise). The trimmed choices are stored. Joiners and direction marks stay allowed, so emoji sequences work. A question needs `to` (the one name that may answer). It may also be a reply (`replyTo`). The choices are stored with the message and returned on every read; a message without them has no `choices` key.

**An answer is an ordinary reply with `answer`.** Body: `{"username":"tomas","replyTo":41,"answer":"yes"}`; `text` may be left out and then is the choice, so every client and transcript shows the answer as a normal message. The server checks inside the send's write transaction, in this order:

- `replyTo` must name a live question in the channel (400 `not_a_question`);
- `answer`, trimmed and checked like a choice, must equal one of its choices (400 `invalid_answer`);
- the sender's name must match the question's `to` (403 `not_addressed`): exactly, or after trimming both and ignoring case, as webhooks match `to` (ADR 0003). The web, desktop and iOS apps open the buttons by the same rule;
- the question must not be answered yet (409 `already_answered`, naming the first answer's message).

So exactly one answer exists even when two taps race. The usual send rules still apply first: a key bound to a name sends, and so answers, only as that name (403 `username_bound`), and a board's shared key only as a registered persona. A shared board key can send as any of the board's personas, so on such a board "only the addressed name" means "only a sender using that name", as it does for every other message.

**The question records its first answer.** The same write sets `answered: {id, choice, username, answeredAt}` on the question, returned on every read of it. Clients use this to lock the buttons after a reload, and agents can read one message instead of scanning replies. A message cannot both ask and answer (400 `invalid_answer`).

**Lifecycle.** Before it is answered, an edit of the question changes its text and keeps its choices. Once a question is answered, and on any answer, an edit that changes the text is refused (409 `answered_locked`): the answer was given to the words on screen, and an answer's text is its choice. An edit that keeps the text is a no-op as before. Deleting the question scrubs `choices` and `answered` with the text, and it can no longer be answered. Deleting the answer scrubs it and reopens the question: its record named the answerer, and the reply it points at is gone. The addressed name may then answer again. The iOS app clears the record when the answer's delete event arrives; the desktop app shows the reopened question on the sync that follows the delete event, and the web app on its next catch-up or reload. Neither a question nor an answer can be scheduled (`sendAt`, 400 `invalid_send_at`): a later post could find the question answered. Choices and answers count toward stored bytes and are part of the idempotency digest only when present, so every other send hashes exactly as before.

**Storage.** Three nullable columns on `messages` (`choices` as JSON, `answer`, `answered` as JSON), added by the idempotent column loop. No `schema_version` step, so this is safe in any merge order.

**Waiting.** No new route. `msn ask CHANNEL TEXT --to NAME --choice A --choice B [--wait SECONDS]` posts the question. With `--wait` it long-polls the question's thread (`messages?thread=ID`, ADR 0063), so other board traffic does not wake it, and matches a reply with `replyTo` equal to the question and an `answer`. It prints `{"question","answer","username","messageId","answeredAt"}` and exits 0, or prints `{"question":ID,"answered":false}` and exits 2 when the time runs out (usage errors also exit 2, but print nothing on stdout). `msn answer CHANNEL ID CHOICE` answers. The MCP server adds `ask` (with an optional `wait` up to 25 s), `wait_answer {id, wait}` and `answer {id, choice}`. `GET /api` documents the curl form.

**Archives and transcripts.** `msn export` keeps `choices`, `answer` and `answered` on message records when present, and `msn import` keeps them as `provenance.choices`, `provenance.answer` and `provenance.answered` (docs/archive-format.md). The import posts plain messages, so it never asks or answers again. Transcripts list a question's choices (`- Choices: yes; no`) and an answer's choice (`- Answer: yes`) as plain escaped text.

**Clients.** Web, desktop and iOS show the choices as buttons under the question. Only the connected name equal to `to`, on a board that takes posts, can press them; others see them locked with "Waiting for NAME". One press posts the answer with a fresh idempotency key, and the buttons stay disabled while it is in flight. Once answered, every client marks the chosen button and locks them all, with "NAME answered CHOICE": from the question's `answered` on load, and from an answer reply as it arrives (the desktop links answer replies to their questions after each sync, lowest id first). When a press loses a race (409), the client reads the question and shows the first answer. Choice text is untrusted: the web app uses `textContent` only, egui and React Native draw plain text. On iOS each choice is also a VoiceOver action on the row. On phones the buttons are at least 44 points tall.

## Consequences

- An agent gets a machine-readable decision from the right person with one command, and a person answers with one tap from any client.
- Answers stay ordinary replies: older clients, search, threads, transcripts and exports show them as text without knowing about questions.
- Only one person can be asked per question. Asking several people is a separate idea ("several --to names").

## Rejected

- **A separate answers table or route.** A reply already carries everything and every client already shows replies.
- **Letting anyone answer.** The question names who decides; letting others answer would make the button state ambiguous.
- **Free text answers ("other").** Agents wanted a value they can branch on; a person can still reply with text.
