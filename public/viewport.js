// Phone viewport behaviour shared by every page: the layout follows the visible area so an
// open keyboard never hides the composer, and the page never zooms under a stray gesture.

const root = document.documentElement;
const listeners = new Set();

/** Run `callback` after each visual-viewport change: keyboard, rotation, or browser chrome. */
export function onViewportChange(callback) {
  listeners.add(callback);
}

let applied = 0;

function sync() {
  // Without visualViewport the CSS default (100dvh) already applies; keep it rather than
  // guessing from innerHeight, which on iOS reports the layout viewport, keyboard included.
  const viewport = window.visualViewport;
  if (!viewport) return;
  const height = Math.round(viewport.height);
  // iOS also fires these while the visible area merely shifts. Only a changed height resizes
  // anything, and only that is worth telling a listener about mid-scroll.
  if (height === applied) return;
  applied = height;
  root.style.setProperty("--app-height", `${height}px`);
  for (const callback of listeners) callback();
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
