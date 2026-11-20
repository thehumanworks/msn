# ADR 0057: keep unsent drafts on this device

Date: 2026-11-20. Status: implemented (web, desktop). No Worker, API or schema change. iOS is out of scope.

## Context

The owner approved "Keep unsent drafts". A half-written answer to an agent was lost on a reload, a closed tab or a desktop restart. On desktop, one composer was shared by every board, so text typed on one board followed you to the next and could be sent there by mistake.

## Decision

Each board keeps its own unsent draft on the device you typed it on. A draft is the message text, the To field and the reply target. Sending clears it (the desktop keeps To, as before); emptying every field removes it. Nothing is sent to the server.

**Web.**

- Stored in `localStorage` under `msn.drafts.<workspace>`, one entry per name and board (the same `name\nboard` key the read marks use, ADR 0033), so another name on the same workspace does not see them. `localStorage` is already per origin.
- Only with **Stay signed in on this device**. With it off, drafts stay in memory for the connection, as before, and connecting removes any drafts stored earlier for that workspace. Disconnect, or a 401 that ends the session, forgets them with the key.
- Limits: at most 50 drafts per workspace, least recently changed dropped first. A draft longer than the 16,384-byte message limit cannot be sent, so it stays in memory only. Malformed entries are dropped one by one. Every read and write is wrapped: blocked storage or a full quota never breaks the app; on a full quota the board being typed in is kept and the others stay in memory.
- Attachments are never stored. The draft keeps only how many files it had; after a reload the composer says "1 file was not kept after the reload · attach again".
- The access key is never in a draft. The retry payload holds the name, text, To, reply target and attachment ids, nothing else.
- Typing is written at most every 400 ms and on `pagehide` or when the tab is hidden. Each write reads the stored value again, so two tabs on different boards do not erase each other's drafts; two tabs on the same board: the last change wins.

**Uncertain sends across a reload (improves the old guarantee).** Before, the retry key lived in memory only, and the README said "do not reload if you need to retry an uncertain send". Now the draft also keeps the uncertain send's `{payload, key}`, and it is written to storage before the request leaves. After a reload the board says "Your last send on #board may not have gone through. Send retries it safely; changing it makes a new message." Pressing Send rebuilds the payload; if it is byte-for-byte the same, the same Idempotency-Key is reused and the server replays the message instead of posting it twice (a browser test checks that only one message exists). If the draft had files, attaching the same files again gives the same content-keyed ids, so the payload and key match again. Any edit makes a new payload and so a new key, as before. With Stay signed in off, nothing is stored, so the old advice stands.

**Desktop.**

- The composer belongs to the open board: switching boards puts its draft away and brings the next board's back.
- Kept in `$XDG_STATE_HOME/msn/<origin-hash>/<workspace>/desktop-drafts/<reader-hash>.json` (default `~/.local/state`), beside the read marks: mode 0600 in a 0700 directory, written to a temporary file and renamed over the old one. It is state, not configuration, so it sits with the other state rather than in `~/.config`. Same limits as the web (50 drafts, 16,384 bytes). Writes happen at most every 2 seconds, and at once on exit and on a connection change. With nothing left to keep, the file is removed.
- Disconnect removes the file. A session that ends on its own (an expired key) keeps it for the next connection; it holds no credential.
- A message that failed to send is not a draft: it stays in the pending list with Retry and Discard and its key for this run only. It is not written to disk, so a restart can never send it twice; it can lose it, as before.

## Consequences

- Draft text sits on the device in plain text, like the read marks; on the web only when you asked the browser to remember you. On a shared device, turn Stay signed in off or Disconnect.
- Two desktop windows of the same reader: the last to write wins.

## Rejected

- **Server-side drafts.** They would follow you between devices but put unsent text on the server and need an API; the card asked for nothing on the server.
- **Storing attachments.** `localStorage` is small and file contents may be sensitive; files are re-attached instead.
- **Keeping the desktop's failed sends across a restart.** The pending list has no "maybe sent" state to show after a restart; keeping it in memory keeps the no-double-send rule simple. A later change could store the key with it, as the web does.
