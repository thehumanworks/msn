// Safe Markdown parser for the web client (ADR 0043). The fixture file is shared with the
// desktop (Rust) and iOS (TypeScript) parsers, which must produce the same trees.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse, safeHref } from "../public/markdown.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/markdown-cases.json", import.meta.url), "utf8"));

for (const { name, input, expected } of cases) {
  test(`fixture: ${name}`, () => assert.deepEqual(parse(input), expected));
}

/** Every link anywhere in the tree, so hostile inputs can be checked for their targets. */
function links(nodes, out = []) {
  for (const node of nodes) {
    if (node.type === "link") out.push(node.href);
    for (const key of ["children", "items", "head", "rows"]) {
      const value = node[key];
      if (Array.isArray(value)) links(value.flat(2), out);
    }
  }
  return out;
}

const hostile = [
  "[x](javascript:alert(1))",
  "[x]( javascript:alert(1))",
  "[x](java\tscript:alert(1))",
  "[x](jav&#x09;ascript:alert(1))",
  "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[x](vbscript:msgbox(1))",
  "[x](file:///etc/passwd)",
  "[x](//evil.example)",
  "[x](/relative)",
  "[x](\\\\evil\\share)",
  "<javascript:alert(1)>",
  "<data:text/html,<script>alert(1)</script>>",
  "![x](javascript:alert(1))",
  '[x](https://ok.example" onmouseover="alert(1))',
  "[x](https://ok.example/<script>)",
  "[x](\u0001https://ok.example)",
  "javascript:alert(1)//https://",
  '<a href="javascript:alert(1)">x</a>',
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  '<iframe srcdoc="<script>alert(1)</script>">',
];

test("hostile inputs never produce a link other than http(s) with a host", () => {
  for (const input of hostile) {
    for (const href of links(parse(input))) {
      assert.match(href, /^https?:\/\/[^/\s]/i, `${input} -> ${href}`);
      assert.doesNotMatch(href, /[\s"<>`\\]/, `${input} -> ${href}`);
      assert.ok(![...href].some((ch) => ch.charCodeAt(0) < 0x20), `${input} -> ${href}`);
    }
  }
});

test("raw HTML is kept as literal text", () => {
  for (const input of hostile.filter((h) => h.startsWith("<") && !/^<(javascript|data)/.test(h))) {
    const tree = parse(input);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].type, "paragraph");
    assert.deepEqual(tree[0].children, [{ type: "text", text: input }]);
  }
});

test("safeHref allows http and https only", () => {
  assert.equal(safeHref("https://example.com/a?b=1#c"), "https://example.com/a?b=1#c");
  assert.equal(safeHref("HTTP://Example.com"), "HTTP://Example.com");
  for (const bad of [
    "javascript:alert(1)",
    "data:,x",
    "mailto:a@b.c",
    "https://",
    "https:///x",
    "ftp://x",
    "https://a b",
    "https://a\nb",
    " https://a",
    "https://a\u0085",
  ])
    assert.equal(safeHref(bad), null, bad);
});

test("plain text without markup is one text paragraph per block, unchanged", () => {
  const text = "Deploy finished at 12:30.\nAll 3 checks passed (see #41) - nothing else to do.";
  assert.deepEqual(parse(text), [{ type: "paragraph", children: [{ type: "text", text }] }]);
});

test("pathological 16 KiB inputs parse quickly with bounded nesting", () => {
  const size = 16 * 1024;
  const inputs = [
    "*".repeat(size),
    "*a ".repeat(size / 3),
    "_a ".repeat(size / 3) + "*".repeat(100),
    "[".repeat(size),
    "[a](".repeat(size / 4),
    "`".repeat(size),
    "` `` ``` ".repeat(size / 10),
    "> ".repeat(size / 2),
    "- ".repeat(size / 2),
    `${"| a ".repeat(size / 4)}\n${"|-".repeat(size / 4)}`,
    "**a ".repeat(size / 8) + " a**".repeat(size / 8),
    "https://a.b/".repeat(size / 12),
    "~~a ".repeat(size / 8) + " a~~".repeat(size / 8),
    `${"[a](".repeat(size / 4)})`,
    `${"[".repeat(size - 20)}](https://a.b)`,
  ];
  const depth = (nodes) =>
    Math.max(
      0,
      ...nodes.map((n) => (Array.isArray(n.children) && n.type !== "quote" ? 1 + depth(n.children) : 0)),
    );
  for (const input of inputs) {
    const started = performance.now();
    const tree = parse(input);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1500, `${JSON.stringify(input.slice(0, 12))} took ${elapsed.toFixed(0)} ms`);
    for (const block of tree)
      if (block.type === "paragraph") assert.ok(depth(block.children) <= 8, "inline nesting is capped");
  }
});
