// Phone viewport behaviour shared by every page: the layout follows the visible area so an
// open keyboard never hides the composer or any other field, and the page never zooms under a
// stray gesture.

const root = document.documentElement;
const listeners = new Set();

/** Run `callback` after each visual-viewport change: keyboard, rotation, or browser chrome. */
export function onViewportChange(callback) {
  listeners.add(callback);
}

const KEYBOARD_MIN = 150;
let applied = 0;
let appliedTop = -1;
let appliedBelow = -1;

// A field that takes focus while the keyboard opens can end up under the shortened shell, for
// example the new-channel name at the foot of the board list. Bring it back into its own
// scroller; `nearest` leaves a field that is already visible alone.
function revealFocused() {
  const field = document.activeElement;
  if (!field?.matches?.("input:not([type=checkbox]):not([type=radio]), textarea, select")) return;
  requestAnimationFrame(() => {
    if (document.activeElement === field) field.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

function sync() {
  // Without visualViewport the CSS default (100dvh) already applies; keep it rather than
  // guessing from innerHeight, which on iOS reports the layout viewport, keyboard included.
  const viewport = window.visualViewport;
  if (!viewport) return;
  const height = Math.round(viewport.height);
  // To show a focused field above the keyboard, iOS pans the visible area down inside the
  // layout viewport rather than resizing it. The shell is fixed to the layout viewport, so it
  // must follow that pan; pinned at the top it would sit above the screen while the visible
  // area showed only the empty page beneath it.
  const top = Math.max(0, Math.round(viewport.offsetTop));
  // Dialogs live in the top layer, outside the shell; they centre in the visible area instead.
  const below = Math.max(0, Math.round(window.innerHeight - viewport.offsetTop - viewport.height));
  if (top !== appliedTop) {
    appliedTop = top;
    root.style.setProperty("--app-top", `${top}px`);
  }
  if (below !== appliedBelow) {
    appliedBelow = below;
    root.style.setProperty("--app-below", `${below}px`);
  }
  // iOS also fires these while the visible area merely shifts. Only a changed height resizes
  // anything, and only that is worth telling a listener about mid-scroll.
  if (height === applied) return;
  const shrank = applied !== 0 && height < applied;
  applied = height;
  root.style.setProperty("--app-height", `${height}px`);
  // The keyboard is the only thing that takes this much of the screen from the visual viewport.
  root.classList.toggle("keyboard-open", window.innerHeight - height > KEYBOARD_MIN);
  for (const callback of listeners) callback();
  if (shrank) revealFocused();
}

if (window.visualViewport) {
  // resize fires as the keyboard animates; scroll fires when iOS shifts the visible area.
  window.visualViewport.addEventListener("resize", sync);
  window.visualViewport.addEventListener("scroll", sync);
  sync();
}
window.addEventListener("orientationchange", sync);

// Safari on iOS ignores user-scalable=no, so pinch-to-zoom is refused explicitly. Chrome and
// Firefox never fire these; there the meta viewport and touch-action already cover it.
for (const type of ["gesturestart", "gesturechange", "gestureend"])
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });

// Older iOS still zooms on a two-finger drag, which touch-action alone does not refuse.
document.addEventListener(
  "touchmove",
  (event) => {
    if (event.touches.length > 1) event.preventDefault();
  },
  { passive: false },
);
