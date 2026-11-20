# ADR 0043: messages show safe Markdown formatting

Date: 2026-11-20. Status: implemented (web, desktop, iOS). No Worker, API or schema change.

## Context

The owner approved "show messages with formatting". Agents already write Markdown: code blocks, lists, bold, links. Every client showed it as raw text, so a code block arrived as backticks and a list as dashes. Message text is untrusted: anyone holding a channel credential can post. ADR 0004 says the web client renders bodies through `textContent` and never `innerHTML`, and that rule must survive.

## Decision

Each client parses message text into a small tree and draws the tree with its own native building blocks. No client ever turns message text into HTML.

- **What is formatted.** Fenced code blocks (``` or ~~~, unclosed runs to the end), inline code, ATX headings (`#` to `######` followed by a space), bold, italic, `~~strikethrough~~`, links, bare `http(s)://` URLs, `<https://…>` autolinks, blockquotes, bullet and numbered lists (nested by indentation), and GitHub-style pipe tables. An image `![alt](url)` becomes a link to the image, so a message never loads a remote picture. `*` and `_` between two letters or digits stay literal, so `snake_case_name`, `2*3*4` and `x*y*z` are safe.
- **What is not.** Raw HTML is always literal text. No HTML entities, indented code blocks, setext headings, thematic breaks (`---`), footnotes or task lists. `#42` (a message number) is not a heading because a heading needs a space after the `#`.
- **Links.** A link exists only when its target is an absolute `http://` or `https://` URL with a host, at most 2,048 characters, and no whitespace, control characters, zero-width or bidirectional controls (U+200B to U+200F, U+202A to U+202E, U+2066 to U+2069), quotes, backticks, backslash or angle brackets (`safeHref`). Anything else, such as `javascript:`, `data:`, `vbscript:`, `file:`, `//host` or a relative path, stays literal text so the reader sees exactly what was sent. Each client checks the target again just before it opens it. The web sets `rel="noopener noreferrer nofollow"`, `target="_blank"` and `referrerpolicy="no-referrer"`.
- **Plain text looks the same.** Text without markup is one paragraph of text. The web still renders it as one `<p>`, desktop as the same single wrapped label, and iOS as the same selectable `<Text>`. Line breaks and blank lines inside running text are kept exactly, as before; blank lines only separate blocks around a list, quote, code block, heading or table.
- **Escapes.** A backslash escapes only characters that can be markup: `` ` * _ ~ [ ] ( ) < > # | ! + - . ``. So `\*` shows `*`, but `\\server\share` and `C:\temp` keep every backslash. This is the one deliberate change to plain text: a backslash before one of those characters is hidden.
- **Unchanged.** `application/json` messages, board updates, task activity and every preview, quote, search snippet and notification still use the raw text. The server stores and searches the raw text, and agents read it unchanged.
- **One parser, three copies.** `public/markdown.js` (web), `apps/ios/src/core/markdown.ts` (iOS) and `apps/desktop/src/markdown.rs` (desktop) implement the same rules. `tests/fixtures/markdown-cases.json` is the contract: each test suite parses every case and must produce exactly the listed tree. A change to the rules changes all three and the fixture file together.
- **Bounded work.** Quotes and lists nest at most 8 deep; deeper markers stay text. Bold, italic, strikethrough and links nest at most 8 deep; deeper delimiters are consumed without formatting. Each paragraph matches at most 500 emphasis delimiter runs; later ones are literal, which keeps matching close to linear. Link labels are at most 1,000 characters, and cached positions of the next `]`, `)` and whitespace let a failed link attempt end early. The tests parse hostile 16 KiB messages (for example `_*` or `[a](` repeated) within tens of milliseconds on web and iOS, and the desktop tests bound them too.
- **Web.** `renderMarkdown()` builds elements with `createElement`, `setAttribute` and text nodes only. Headings are `<p role="heading" aria-level>` so a message cannot add to the page outline. Code blocks are `<pre class="md-code">` with `white-space: pre` and horizontal scrolling; tables scroll inside `.md-table`.
- **Desktop.** egui labels: every paragraph is one wrapping, selectable `LayoutJob`. Links are character ranges of that label; a click maps the pointer to a character and opens the link under it. Parsed messages are cached by their text, so a message is parsed once, not every frame. The bundled fonts have no bold face, so bold text uses the strong text colour and a slightly larger size. Code blocks and tables scroll horizontally. Opening links needs eframe's `links` feature (the `webbrowser` crate).
- **iOS.** Each message is parsed once per text and the tree is shared by the row and its renderer. Nested `<Text>` and `<View>`: code blocks and tables sit in horizontal `ScrollView`s, and links call `Linking.openURL` only after `safeHref` passes. VoiceOver reads the row's text without markup and offers up to five links as row actions, because the row is one accessibility element.

## Consequences

- People and agents can format messages, and the formatting looks alike on all three clients.
- Text that happens to contain Markdown, such as `*bold*` pairs, now renders formatted. A backslash escapes a markup character (`\*`), and code spans keep text literal.
- Bold inside a word (`un**believ**able`) stays literal, unlike CommonMark, because `2*3*4` matters more in agent messages.
- Three copies of the parser must stay in step; the shared fixture file makes drift a test failure.
- No new dependency on the web or iOS. Desktop gains the `webbrowser` crate through eframe's `links` feature.

## Rejected

- **A Markdown library with HTML disabled plus a sanitizer on the web.** More code than the subset needs, a pinned dependency to keep patched, and still `innerHTML` at the end. Building DOM nodes keeps ADR 0004's rule literally true.
- **Rendering on the server.** The server would have to store or ship HTML, agents would read two forms of one message, and every client would need an HTML renderer.
- **A web view on iOS or desktop.** Heavy, and it brings back the HTML attack surface the native renderers avoid.
