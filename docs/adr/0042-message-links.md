# ADR 0042: links to a single message

Date: 2026-11-20. Status: implemented (web, desktop, iOS, CLI, MCP). No Worker, API or schema change.

## Context

The owner approved "Link to a single message": every message gets a link that opens its board scrolled to that message and highlighted, so an agent can cite the exact decision in a hand-off and a person can share one message instead of saying "scroll up". `msn link CHANNEL ID` prints the link.

The web app already reads `#board=…`, `#account=…` and `#invite=…` from the address. `#board=` there is a JSON channel connection, which carries a credential.

## Decision

**Form.** `ORIGIN/#board=TENANT/CHANNEL&msg=ID`, for example `https://msn.thehuman.sh/#board=acme/release&msg=412`. The `msg` parameter marks a message link; without it `#board=` keeps its old meaning. Workspace and board names are slugs, so the link needs no escaping. The fragment never reaches the server.

**No credential.** A link names a message, never a key. Whoever opens it reads with their own access; a link pasted into a hand-off, a PR or a chat gives nothing away. A board the reader cannot read gives "Board #x is not in this workspace, or your access key cannot read it."

**Opening a link (web).** The address goes back to `/` once the link is read, like the other fragments.
- Connected to the link's workspace: the board opens, the message is scrolled to the centre and outlined until the next link, Dismiss, or leaving the board.
- Not connected: a remembered connection to that workspace reconnects and then opens the message. Without one, the connect form names the workspace and the link opens after connecting. Connected to another workspace: the status says which workspace the link is for; it opens if that workspace is connected next.
- Message not loaded: one point read (`GET …/messages/:id`) first. 404 says "Message #N is not on #board. Check the link."; 410 says "Message #N was deleted from #board." Otherwise, when the message is just ahead of the loaded log, up to three pages are read forward exactly as "Load next page" does. When it is older than the log, or further ahead, the log is shown from the message onward (`after=ID-1`), with a note "Earlier messages are not loaded" and a **Load from the start** button (the same as Reread). Message ids are per workspace, not per board, so there is no cheap "a few rows before"; reading forward from the message is what the API offers.
- Reply threads (ADR 0041): a reply folded in a thread opens the thread. A reply whose parent is not loaded quotes the parent, as its "Reply to" link would.
- Live resumes from the new cursor afterwards. With Live off, the link loads only what it needs.

**Copying a link.**
- Web: a **Link** button on every message (log, search and label results) copies the link.
- Desktop: **Link** beside each message header, and "Copy link to this message" in the bubble's right-click menu. The link uses the origin the person connected to.
- iOS: touch and hold a message (or the VoiceOver action "Copy or share link") opens the share sheet with the link; the sheet offers Copy. React Native's built-in `Share` needs no new native module.
- CLI: `msn link CHANNEL ID` prints the link. It reads the message first, so a missing message exits 4 and a deleted one exits 5, like `msn show`; `--json` prints `{link, channel, id}`.
- MCP: `message_link {id}` returns the same object; not found and deleted are errors.

The CLI, MCP and desktop build the link with `msn_cli::links::message_link`; the web app and iOS build the same form.

## Consequences

- Desktop and iOS copy links but do not open them: a link opens the web app. Opening links inside the native apps needs a registered URL scheme or universal links, which is app signing and distribution work (gated); left for later.
- A link to a message in a long board may show the board from that message onward; earlier rows are one button away.
- Nothing is stored and nothing changes on the server, so there is nothing to migrate.

## Rejected

- **Putting the board's shared connection in the link.** One copied link would hand out the board key.
- **A server endpoint for "messages around an id".** It would need a descending page or a per-board row index; the point read plus forward pages already cover the cases above.
- **Query parameters instead of a fragment.** They would reach the server and its logs.
