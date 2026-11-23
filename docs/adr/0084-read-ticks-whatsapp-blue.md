# ADR 0084: read ticks are WhatsApp blue, and a worker suffix is still the sender

Date: 2026-11-23. Status: Accepted.

Supersedes the phone read colour and the exact-name own test in [ADR 0083](0083-ticks-on-the-senders-bubble.md). Delivery rows, the fold, and one muted check for delivered and partial are unchanged.

## Context

ADR 0083 drew read ticks in a pale blue (`#A5EBFF`) on the phone so they would not vanish on the system-blue outgoing bubble, and in the desktop accent on the assumption that accent was blue. Sent and read then sat too close on the phone. The web accent is magenta (ADR 0049), so it cannot be the read colour; the desktop accent had to be checked rather than assumed.

A bound key sends as one name. A `name/worker` suffix is still that name (ADR 0040, ADR 0082). The bubble's own test was exact equality, so a worker's message sat on the incoming side with no ticks.

The second check was offset by 4px, but the phone box added a guessed slack and the desktop overlap used a guessed glyph advance. Negative letter-spacing on the pair also pulled the following text into the second check.

## Decision

Read ticks on the phone are WhatsApp blue `#53bdeb`. Sent stays the muted grey `#E4EAF1`. Delivered and partial stay one muted check.

The desktop accent is blue in both themes (cyan-blue, about 190°, not the web magenta). Desktop read ticks keep that accent. A test rejects a magenta accent, which would need its own read blue.

A bubble is the viewer's when the message username is the viewer's name, or that name plus a `/worker` suffix, and it is not an agent message. Edit and replace stay an exact username match, which is what the server allows.

The second check is still offset by 4px. Its box is the rotated stroke plus that offset. On the desktop the two checks are separate text sections; the second's leading is the galley's glyph width minus 4px, so the following text starts after the second check. One leading gap separates the time, or the checks when there is no time, from the rest of the header.

## Consequences

- Phone read and sent ticks are different colours. `#53bdeb` on the blue bubble is the colour asked for.
- A worker message is drawn as outgoing and gets ticks. It does not gain an Edit button.
- Desktop read colour stays the accent only while that accent is blue.

## Rejected

- Editing ADR 0083 in place. It stays the snapshot of the first own-bubble decision.
- Reusing the web magenta accent for read ticks.
- A guessed check advance, or a guessed width slack, for the second check.
