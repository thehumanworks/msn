# ADR 0083: delivery ticks only on the sender's bubble

Date: 2026-11-23. Status: Accepted.

Supersedes the bubble presentation in [ADR 0082](0082-delivery-ticks.md): who sees the mark, and that a read mark is blue. Delivery rows, the ack API, and the fold (`none` / `pending` / `partial` / `delivered` / `read`) are unchanged.

## Context

ADR 0082 folds each addressed message's delivery rows into one mark and draws it on every surface that shows the message. On the iOS app the mark also appeared on other participants' bubbles, including agents. WhatsApp draws it only on messages you sent: one thin check, or two that sit almost on top of each other, muted until they are read and blue once they are, beside the time at the bottom right of the bubble.

The web accent (ADR 0049) is magenta, so "use the accent" and "blue for read" are not the same colour there. The phone app's outgoing bubble is system blue, so a saturated blue check disappears into it.

## Decision

A bubble shows the mark only when the viewer sent that message. That is the same own / mine test the bubble already uses to sit on the right. Someone else's message, including an agent's, shows no ticks. The rows stay on the message JSON for every reader.

The mark is one thin check when every recipient is at least delivered (including partial), and two thin checks when every recipient has read. The second check is offset by 4px, so it overlaps the first. Pending, and a message with no rows, still draw nothing. Delivered and partial use the muted colour. Read is blue: the accent on the older iOS app and the desktop app, where that accent is already blue; a light blue (`#A5EBFF`) on the phone, so the thin stroke stays visible on the blue outgoing bubble; and `--tick-read` on the web (`#53bdeb` in the dark theme, `#0757a8` in the light theme).

The accessible name is unchanged and is attached only to the mark that is shown.

## Consequences

- Incoming bubbles stay unmarked even when delivery rows exist. Hiding the mark does not hide the rows.
- The phone's read colour is lighter than WhatsApp's read blue so it contrasts with the outgoing bubble. The states are the same.
- Clients that share the fold keep `tickOf`. `bubbleTick` / `tickLayout` is the extra own-message gate.

## Rejected

- **Dropping `delivery` for other viewers.** Every key on the board can still read the rows. The gate is presentation.
- **A clock for pending.** Pending still draws nothing.
- **Reusing the web accent for read.** That accent is magenta. Read on the web is a blue token instead.
