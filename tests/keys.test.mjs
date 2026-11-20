// Keyboard shortcuts (ADR 0054): which key does what, and that typing in a field never fires one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHORD_MS, isTyping, SHORTCUTS, shortcut, step } from "../public/keys.js";

const body = { tagName: "BODY" };
const press = (key, extra = {}) => ({ key, target: body, ...extra });

test("single keys map to their shortcuts outside fields", () => {
  for (const [key, action] of [
    ["/", "search"],
    ["j", "next"],
    ["k", "previous"],
    ["r", "reply"],
    ["?", "help"],
    ["Escape", "close"],
  ])
    assert.deepEqual(shortcut(press(key)), { action, chord: null }, key);
  assert.equal(shortcut(press("x")).action, null);
  assert.equal(shortcut(press("J")).action, null, "Shift+j is not j");
});

test("g then b opens the board list, only within the chord window", () => {
  const first = shortcut(press("g"), null, 1000);
  assert.deepEqual(first, { action: null, chord: 1000 });
  assert.deepEqual(shortcut(press("b"), first.chord, 1000 + CHORD_MS), { action: "boards", chord: null });
  assert.equal(shortcut(press("b"), 1000, 1001 + CHORD_MS).action, null, "too late");
  assert.equal(shortcut(press("b")).action, null, "b alone does nothing");
  // Any other key ends the chord without acting, so g then j does not move.
  assert.deepEqual(shortcut(press("j"), 1000, 1100), { action: null, chord: null });
});

test("shortcuts never fire while typing, or with Ctrl, Alt or the command key", () => {
  for (const target of [
    { tagName: "INPUT", type: "text" },
    { tagName: "INPUT", type: "search" },
    { tagName: "INPUT", type: "" },
    { tagName: "TEXTAREA" },
    { tagName: "SELECT" },
    { tagName: "DIV", isContentEditable: true },
  ]) {
    assert.ok(isTyping(target), JSON.stringify(target));
    for (const key of ["/", "j", "k", "r", "?", "g"])
      assert.deepEqual(shortcut(press(key, { target })), { action: null, chord: null });
    // A g typed in a field never arms the chord.
    assert.equal(shortcut(press("b", { target }), 1000, 1001).action, null);
  }
  for (const target of [{ tagName: "INPUT", type: "checkbox" }, { tagName: "BUTTON" }, body, null])
    assert.equal(isTyping(target), false, JSON.stringify(target));
  for (const modifier of ["ctrlKey", "metaKey", "altKey", "isComposing"])
    assert.equal(shortcut(press("j", { [modifier]: true })).action, null, modifier);
  // Escape types nothing, so it also works from a field.
  assert.equal(shortcut(press("Escape", { target: { tagName: "TEXTAREA" } })).action, "close");
});

test("j and k step through messages and stop at the ends", () => {
  assert.equal(step("next", -1, 0), -1);
  assert.equal(step("next", -1, 5, 2), 2, "j starts at the first message in view");
  assert.equal(step("previous", -1, 5, 2), 4, "k starts at the newest");
  assert.equal(step("next", -1, 5, -1), 0);
  assert.equal(step("next", 1, 5), 2);
  assert.equal(step("next", 4, 5), 4);
  assert.equal(step("previous", 1, 5), 0);
  assert.equal(step("previous", 0, 5), 0);
});

test("the help sheet lists every shortcut", () => {
  const keys = SHORTCUTS.map((entry) => entry.keys.join(" "));
  assert.deepEqual(keys, ["/", "j", "k", "r", "g b", "Esc", "?"]);
  for (const entry of SHORTCUTS) assert.ok(entry.does.length > 0);
});
