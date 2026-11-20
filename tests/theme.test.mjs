// Light and dark theme tokens (ADR 0049): both themes define every colour token, the two light
// blocks stay identical, no rule outside them hard-codes a colour, and the text pairs the app
// uses meet WCAG AA (4.5:1) in both themes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

function block(pattern) {
  const match = pattern.exec(css);
  assert.ok(match, `missing ${pattern}`);
  const open = match.index + match[0].length - 1;
  const close = css.indexOf("}", open);
  return { start: match.index, end: close + 1, body: css.slice(open + 1, close) };
}

function tokens(body) {
  const out = new Map();
  for (const [, name, value] of body.matchAll(/(--[a-z-]+|color-scheme):\s*([^;]+);/g))
    out.set(name, value.trim());
  return out;
}

const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
const dark = block(/^:root\s*\{/m);
const lightSystem = block(/:root:not\(\[data-theme="dark"\]\)\s*\{/);
const lightForced = block(/^:root\[data-theme="light"\]\s*\{/m);
const darkTokens = new Map(
  [...tokens(dark.body)].filter(([, value]) => value.match(COLOUR) || value === "dark"),
);
const light = tokens(lightForced.body);

test("both light blocks are identical and redefine every dark colour token", () => {
  assert.deepEqual(tokens(lightSystem.body), light);
  assert.deepEqual([...light.keys()].sort(), [...darkTokens.keys()].sort());
  assert.equal(light.get("color-scheme"), "light");
  assert.equal(darkTokens.get("color-scheme"), "dark");
});

// Words a colour property may hold besides tokens: anything else (red, gray, white…) is a
// named colour and must become a token.
const COLOUR_PROPERTY =
  /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left|block|inline))?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|accent-color|caret-color|fill|stroke|text-decoration(?:-color)?|column-rule(?:-color)?)$/;
const NOT_A_COLOUR = new Set([
  "transparent",
  "currentcolor",
  "inherit",
  "initial",
  "unset",
  "revert",
  "none",
  "solid",
  "dashed",
  "dotted",
  "double",
  "inset",
  "auto",
  "underline",
]);

/** Raw colours in CSS text: hex, colour functions, and named colours in colour properties. */
function rawColours(text) {
  const found = text.match(COLOUR) ?? [];
  for (const [, property, value] of text.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)) {
    if (!COLOUR_PROPERTY.test(property)) continue;
    // Hex and colour functions are counted above; strip them, tokens and numbers with units.
    const bare = value
      .replace(/var\([^)]*\)|[a-z-]+\([^)]*\)|#[0-9a-f]+/gi, " ")
      .replace(/-?[\d.]+[a-z%]*/gi, " ");
    for (const word of bare.match(/[a-z][a-z-]*/gi) ?? [])
      if (!NOT_A_COLOUR.has(word.toLowerCase())) found.push(`${property}: ${word}`);
  }
  return found;
}

function outsideTokens() {
  const spans = [dark, lightSystem, lightForced].sort((a, b) => a.start - b.start);
  let rest = "";
  let at = 0;
  for (const span of spans) {
    rest += css.slice(at, span.start);
    at = span.end;
  }
  return (rest + css.slice(at)).replace(/\/\*[\s\S]*?\*\//g, "");
}

test("no rule outside the token blocks hard-codes a colour", () => {
  const found = rawColours(outsideTokens()).join(", ");
  assert.equal(found, "", `use a var(--token) instead of: ${found}`);
});

test("the raw-colour check catches hex, colour functions and named colours", () => {
  const sample =
    "a { color: red; background: oklch(0.7 0.1 200); border: 1px solid gray; fill: #fff; outline: 2px solid var(--accent); }";
  assert.deepEqual(rawColours(sample), ["oklch(", "#fff", "color: red", "border: gray"]);
});

function rgba(hex) {
  const h = hex.slice(1);
  const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
  const a = full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1;
  return [r, g, b, a];
}
const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
function luminance([r, g, b]) {
  const channel = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

for (const [name, theme] of [
  ["dark", darkTokens],
  ["light", light],
]) {
  test(`${name} theme: text, muted, accent and error text meet 4.5:1 on every surface`, () => {
    const c = (token) => rgba(theme.get(token));
    const bg = c("--bg");
    const surfaces = {
      bg,
      surface: c("--surface"),
      raised: c("--raised"),
      "accent-soft on bg": over(c("--accent-soft"), bg),
      "accent-soft on surface": over(c("--accent-soft"), c("--surface")),
    };
    const failures = [];
    for (const fg of ["--text", "--muted", "--accent", "--error"])
      for (const [where, under] of Object.entries(surfaces)) {
        const ratio = contrast(c(fg), under);
        if (ratio < 4.5) failures.push(`${fg} on ${where}: ${ratio.toFixed(2)}`);
      }
    for (const fill of ["--accent", "--accent-hover"]) {
      const ratio = contrast(c("--on-accent"), c(fill));
      if (ratio < 4.5) failures.push(`--on-accent on ${fill}: ${ratio.toFixed(2)}`);
    }
    // Non-text marks (presence dot) need 3:1 against the dialog surface.
    const dot = contrast(c("--presence"), c("--raised"));
    if (dot < 3) failures.push(`--presence on raised: ${dot.toFixed(2)}`);
    assert.deepEqual(failures, []);
  });
}
