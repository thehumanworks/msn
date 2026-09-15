# 0003 — Browser-remembered workspace credentials and a mobile-first UI

- **Date:** 2026-09-15
- **Status:** Accepted
- **Relates to:** `docs/design.md` (Isolation and identity), ADR 0001, ADR 0002

## Context

The browser inbox previously held the workspace key in page memory only: a reload or a closed tab required
re-entering tenant, key and display name. That is safe on shared devices but hostile to the primary use
case, a person checking channels from a phone many times a day. The request was a minimalistic,
mobile-first, dark UI with bright magenta accents that lets people interact with their channels easily
and saves credentials in the browser for ease of use.

Alternatives considered:

- **Memory only (status quo).** Maximum safety, poor ergonomics on phones.
- **`sessionStorage`.** Survives reload but not a closed tab, which is the common phone flow; little gain.
- **Cookie-based sessions.** Requires a server-side session model and CSRF handling; contradicts the
  no-login capability design in `docs/design.md`.
- **`localStorage`, opt-out per connection.** Survives reloads and closed tabs; cleared by an explicit
  disconnect or when the server rejects the key. Same-origin only; the existing strict CSP
  (`script-src 'self'`, no inline scripts) and `textContent` rendering remain the XSS boundary.

## Decision

1. The connect form has a **"Stay signed in on this device"** checkbox, checked by default. On a
   successful connect with it checked, the browser stores `{tenant, token, username}` under
   `localStorage["msn.session"]` and the last opened channel under `localStorage["msn.channel.<tenant>"]`.
   With it unchecked nothing is stored and any previous entry for that browser is removed.
2. On page load, a remembered session reconnects automatically and reopens the remembered channel. A
   401/403 during that reconnect forgets the stored session and shows the form with tenant and display
   name prefilled. A transient failure keeps the stored session and prefills all three fields so retry is
   one tap.
3. **Disconnect** clears the stored session and channel for that tenant. It is the only way, besides
   server-side key rotation, to forget a key from the UI.
4. Storage access is wrapped so a blocked or unavailable `localStorage` degrades to memory-only
   behaviour instead of breaking the page.
5. The UI is rebuilt mobile-first: one pane at a time on narrow viewports (channel list ↔ conversation
   with a back button), two panes from 760px up; dark palette with `#ff2bd6` accents; Enter sends,
   Shift+Enter inserts a newline; the composer autosizes. The HTTP API, CLI and Worker are unchanged.

## Consequences

- A stolen or shared device exposes the workspace key until Disconnect is pressed or the key is
  rotated by an administrator. `guide.html`, the connect form and README say so and recommend a private
  window on shared devices. Rotation continues to invalidate remembered keys everywhere at once.
- `docs/design.md`'s statement that keys never enter client storage is superseded by this ADR: keys
  never enter URLs or application logs; they enter same-origin `localStorage` only when the person
  opts to stay signed in.
- The browser suite asserts the new contract in both desktop and Pixel 7 projects:
  `tests/browser.spec.mjs` "remembered credentials reconnect on reload, restore the last channel, and are
  forgotten on disconnect or rejection" and "… keys persist only when asked".
- Drafts and uncertain-send retry keys are still memory-only and channel-scoped; a reload still starts a
  new logical send.
