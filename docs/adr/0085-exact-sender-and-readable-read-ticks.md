# ADR 0085: ticks use the exact sender, and the phone read tick clears 3:1

Date: 2026-11-23. Status: Accepted.

Supersedes two sentences of [ADR 0084](0084-read-ticks-whatsapp-blue.md): that a `/worker` suffix counts as the sender, and that phone read ticks are `#53bdeb`. Delivery rows, the fold, one muted check for delivered and partial, the 4px overlap, and the web `--tick-read` token are unchanged.

## Context

ADR 0084 treated `name/worker` as the same sender as `name`, because a reader cursor may use that suffix (ADR 0040, ADR 0082). The message username is a different field. The server's `text()` check accepts any non-blank string within the byte limit, and the only reserved sender is `github`. A person can register as `tomas/x`. Treating a slash suffix as the viewer would draw that person's bubble as outgoing and, if the same predicate also gated controls, would offer edit, replace, or other owner actions on it.

`#53bdeb` on the phone's system-blue outgoing bubble is about 1.9:1 in light (`#007AFF`) and about 1.7:1 in dark (`#0A84FF`). A non-text mark needs at least 3:1. The older iOS outgoing bubble is `#1f3a5f` with accent `#58a6ff`, which already clears that. The web outgoing bubble is a left border, not a blue fill, and `--tick-read` already clears 4.5:1 on the surfaces behind it. The desktop accent is blue and is checked on the composited own bubble.

## Decision

Ticks use an exact username match (`sentByViewer` / `sent_by_viewer`). A bound key already sends as its bound name, so that name matches exactly. `tomas/x` does not match `tomas`. A session whose name is the full string `Ada/worker` matches that string and gets ticks on its own messages.

Edit, replace, bubble side, and other sender controls use the same exact match through a separate function (`exactSender` / `senderActions`, or `username == me`). They do not call the tick predicate. Claim, delete, and ack stay on their existing holder and owner checks.

Phone read ticks are `#E8F7FF`. That clears 3:1 on both system blues and stays lighter than the muted sent grey `#E4EAF1`. Delivered and partial stay that one grey check. The older iOS app keeps its blue accent. The web keeps `--tick-read`. Desktop read ticks keep the accent while it clears 3:1 on the own bubble.

## Consequences

- A username that only starts with the viewer draws no ticks and no sender controls.
- Phone read ticks are a light cyan, distinct from the grey delivered check.
- Widening the tick rule later cannot grant edit or replace, because those call sites do not use it.

## Rejected

- Editing ADR 0084 in place. It stays the snapshot that allowed the suffix and `#53bdeb`.
- Reserving `/` in usernames only to make the suffix rule safe.
- Using `#53bdeb` or the sent grey as the phone read colour.
- Painting a second check for delivered. Delivered stays one muted check.
