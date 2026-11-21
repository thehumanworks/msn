// Keyboard shortcuts (ADR 0054). Pure functions only: app.js owns the page and acts on the
// names returned here. A shortcut never fires while the reader types in a field, and never with
// Ctrl, Alt or ⌘ held, so browser and system shortcuts keep working.

/** How long `g` waits for its second key. */
export const CHORD_MS = 1500;

/** The help sheet, in the order it lists them. */
export const SHORTCUTS = [
  { keys: ["/"], does: "Search this board" },
  { keys: ["j"], does: "Next message" },
  { keys: ["k"], does: "Previous message" },
  { keys: ["r"], does: "Reply to the selected message" },
  { keys: ["q"], does: "Quote the selected message, or the text you selected, in a reply" },
  { keys: ["g", "b"], does: "Go to the board list" },
  { keys: ["Esc"], does: "Close, cancel the reply or clear the search" },
  { keys: ["?"], does: "Show these shortcuts" },
];

const SINGLE = {
  "/": "search",
  j: "next",
  k: "previous",
  r: "reply",
  q: "quote",
  "?": "help",
  Escape: "close",
};
const TEXT_INPUTS = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

/** True when keys typed at `target` belong to it: a text field, a list box or editable text. */
export function isTyping(target) {
  if (!target || typeof target !== "object") return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return TEXT_INPUTS.has(String(target.type ?? "").toLowerCase());
}

/**
 * The shortcut a key press asks for, if any. `chord` is the time a lone `g` was pressed (or
 * null); the result carries the chord state for the next press.
 * Returns `{ action, chord }`; action is null when the key is not a shortcut.
 */
export function shortcut(event, chord = null, now = Date.now()) {
  const none = { action: null, chord: null };
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return none;
  // Escape is the one key that also works from a field: it types nothing.
  if (event.key === "Escape") return { action: "close", chord: null };
  if (isTyping(event.target)) return none;
  const pending = chord !== null && now - chord <= CHORD_MS;
  if (pending) return { action: event.key === "b" ? "boards" : null, chord: null };
  if (event.key === "g") return { action: null, chord: now };
  return { action: SINGLE[event.key] ?? null, chord: null };
}

/**
 * The message to select after `move` ("next" or "previous") from `current`, an index into
 * `count` messages in reading order (or -1 for none). With nothing selected, "next" starts at
 * `firstInView` and "previous" at the newest message.
 */
export function step(move, current, count, firstInView = 0) {
  if (count <= 0) return -1;
  if (current < 0 || current >= count)
    return move === "next" ? Math.min(Math.max(firstInView, 0), count - 1) : count - 1;
  return move === "next" ? Math.min(current + 1, count - 1) : Math.max(current - 1, 0);
}
