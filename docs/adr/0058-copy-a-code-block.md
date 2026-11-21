# ADR 0058: copy a code block

Date: 2026-11-21. Status: implemented (web, desktop). No Worker, API or schema change. iOS is out of scope.

## Context

The owner approved "Copy a code block". Agents post commands, patches and config in fenced code blocks (ADR 0043). A person who wants to run one had to select it by hand, which is slow on a phone and easy to get wrong (a missed line, an extra fence).

## Decision

Every fenced code block in a message has a **Copy** button in its top-right corner. It copies the code exactly as the sender wrote it: no fence, no language tag, indentation and blank lines kept. Nothing is sent to the server.

**Web.**

- `messageContent` wraps each `pre.md-code` that `renderMarkdown` made in a `div.md-codeblock` and adds the button beside the `<pre>`, not inside it, so the block's text (and search, fold and transcript code that reads it) is unchanged. `markdown.js` and its shared fixtures are untouched. An edited message is rendered through the same path, so it gets the button too.
- The button copies `pre.textContent` with `navigator.clipboard.writeText`. Success reads "Copied" for 2 seconds and the status line says "Code copied."; a blocked clipboard says "Clipboard unavailable. Select the code and copy it manually." as an error, and claims nothing.
- Its accessible name is "Copy code", or "Copy sh code" when the fence names a language.
- With a mouse it shows on hover or when focus is in the block, so it never covers code nobody is pointing at. On touch (`hover: none` or `pointer: coarse`) it always shows and is at least 44 by 44 px, matching the mobile rules of PR 58; a one-line block grows to 48 px so the button stays inside it.

**Desktop.** The egui code block draws a small Copy button in its top-right corner while the pointer is over the block. A click puts the code on the clipboard (`copy_text`) and the button reads "Copied" for 2 seconds.

## Consequences

- On a wide line, the button covers the end of the first line while it shows (on touch, always). The block still scrolls sideways, and the hidden part can be read by scrolling.
- iOS keeps its current behaviour: code block text is already selectable with a long press. A button needs a clipboard native module (`expo-clipboard`), so a new native dependency and app build, which is not worth it for this card.

## Rejected

- **A header bar with the language and Copy above each block.** Clearer, but on a phone a 44 px bar on every block costs more height than the button saves.
- **Putting the button inside the `<pre>` from `markdown.js`.** It would change the block's text and the shared parser output that web, desktop and iOS test against.
