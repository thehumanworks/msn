# ADR 0049: light and dark themes

Date: 2026-11-20. Status: implemented (web, desktop). No server change, no schema version change.

## Context

Web and desktop were dark only. People who work in a light system theme, or in daylight, get a dark window in the middle of a light desktop. The owner approved "Add a light theme": web and desktop follow the system light or dark setting, and each device can force either.

## Decision

**Default: follow the system.** With no choice saved, web uses `prefers-color-scheme` and desktop uses the theme the OS reports to egui (`ThemePreference::System`). Both change live when the system setting changes.

**Per-device choice, never on the server.** A theme is about the screen in front of you, not the account, so the choice stays on the device:
- Web: **Theme on this device** (System, Light, Dark) in the board list. It is saved in `localStorage` as `msn.theme` (`light` or `dark`; System removes it). It survives Disconnect, because it is not a credential. Other open tabs follow a change.
- Desktop: **Theme** (System, Light, Dark) under Disconnect in the sidebar. It is saved as `$XDG_CONFIG_HOME/msn/desktop-theme` (or `~/.config/msn/desktop-theme`), next to the CLI's profiles, holding `light` or `dark`; System removes the file. A failed write shows "Theme not saved" and the theme still applies for the session.

**Web: CSS tokens only.** `public/style.css` already drew from colour tokens on `:root`. The light values are defined twice with identical contents: under `@media (prefers-color-scheme: light)` for `:root:not([data-theme="dark"])`, and for `:root[data-theme="light"]`. A forced dark sets `data-theme="dark"`, which the media block skips. The last hard-coded colours (primary hover, the dialog backdrop, the listening dot) became tokens (`--accent-hover`, `--backdrop`, `--presence`). `color-scheme` is set per theme so native controls and scrollbars match. `public/theme.js` is a classic, render-blocking script in `<head>`, so a forced theme applies before the first paint; the CSP (`script-src 'self'`) forbids an inline script. It also sets the `theme-color` meta for the browser bar.

**Desktop: one palette per theme.** `theme.rs` has a `Palette` for each theme (text, muted, accent, error, warning, link, code, surfaces, bubbles, backdrop and participant name colours) and installs both egui styles. Drawing code calls `theme::accent()` and the like, which read the palette of the theme the current frame draws in (set by `theme::sync` at the start of each frame).

**Contrast (WCAG AA, 4.5:1 for text).**
- `tests/theme.test.mjs` checks that both light blocks are identical and redefine every dark colour token, that no rule outside the token blocks hard-codes a colour, and that text, muted, accent and error meet 4.5:1 on every surface (and white-on-accent for primary buttons) in both themes.
- A Playwright test renders a board with a pin, labels, receipts, inline code, a code block, a quote and a link, and measures every text element against the background it is painted on, in both themes, on desktop and phone viewports.
- A desktop unit test composites each surface over the backdrop over a black and a white desktop (light) or a dark desktop (dark), and checks every text colour on it.
- To pass, some dark desktop colours changed slightly: the message time and id use the full muted colour (it was dimmed to about 3:1), avatar discs are fainter so the initial stands out, the user's own bubble is less opaque (its muted and link text was 3.6:1 and 3.2:1), links use the accent colour, and the send/Connect blue is darker so its white text reaches 5:1.

**New UI must use tokens.** The CSS test fails on any raw colour outside the token blocks (hex, `rgb()`/`hsl()`/`hwb()`/`lab()`/`lch()`/`oklab()`/`oklch()`/`color()`, and named colours such as `red` in colour properties), so new web elements (for example reactions or the transcript download) get both themes by using `var(--…)`.

## Rejected

- **A server-side or per-account preference:** two devices in different rooms want different themes, and it would need an API and a schema change for no shared benefit.
- **Duplicating the light block with a CSS preprocessor or `light-dark()`:** the build has no CSS step, and `light-dark()` cannot express "forced dark on a light system" without the same attribute selectors. The duplicate is guarded by the test.
- **iOS in this change:** the pitch named web and desktop. The iOS app keeps its current look.

## Limits

- The desktop window is translucent; contrast for the dark theme is checked over a dark desktop only, as before this change. The light theme is checked over black and white.
- The web app manifest's `theme_color` and `background_color` stay dark: a manifest has one value, so an installed app's splash screen is dark on a light system. The page itself switches as soon as it loads.
- Placeholder text in empty fields keeps the platform's faint style in both themes.
