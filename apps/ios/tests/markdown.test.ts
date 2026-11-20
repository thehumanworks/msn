// Safe Markdown parser for iOS (ADR 0043). The fixture file at the repository root is shared
// with the web and desktop parsers, which must produce the same trees.
import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { linksOf, parse, plainText, safeHref, type Block, type Inline } from "../src/core/markdown.ts";

type Case = { name: string; input: string; expected: Block[] };
const cases: Case[] = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/markdown-cases.json", import.meta.url), "utf8"),
);

for (const { name, input, expected } of cases) {
  test(`fixture: ${name}`, () => assert.deepStrictEqual(parse(input), expected));
}

function links(blocks: Block[]): string[] {
  const out: string[] = [];
  const inline = (nodes: Inline[]) => {
    for (const node of nodes) {
      if (node.type === "link") out.push(node.href);
      if ("children" in node) inline(node.children);
    }
  };
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "heading") inline(block.children);
    else if (block.type === "quote") out.push(...links(block.children));
    else if (block.type === "list") for (const item of block.items) out.push(...links(item));
    else if (block.type === "table") for (const cell of [...block.head, ...block.rows.flat()]) inline(cell);
  }
  return out;
}

test("hostile inputs never produce a link other than http(s)", () => {
  const hostile = [
    "[x](javascript:alert(1))",
    "[x](data:text/html,<script>alert(1)</script>)",
    "[x](//evil.example)",
    "<javascript:alert(1)>",
    "![x](vbscript:x)",
    "[x](https://ok.example\" onmouseover=\"x)",
    "> - [x](file:///etc/passwd)",
  ];
  for (const input of hostile)
    for (const href of links(parse(input))) assert.match(href, /^https?:\/\/[^/\s"<>]/i, input);
});

test("safeHref allows http and https only", () => {
  assert.equal(safeHref("https://example.com"), "https://example.com");
  for (const bad of ["javascript:alert(1)", "data:,x", "tel:1", "https://", "https://a b", 42])
    assert.equal(safeHref(bad), null);
});

test("a 16 KiB hostile message parses quickly", () => {
  for (const input of ["*a ".repeat(5000), "[".repeat(16000), `${"[a](".repeat(4000)})`, "**a ".repeat(2000) + " a**".repeat(2000)]) {
    const started = performance.now();
    parse(input);
    assert.ok(performance.now() - started < 1500);
  }
});

test("plainText and linksOf read the words and links without markup", () => {
  const blocks = parse("## Plan\n**Ship** [docs](https://e.com/d)\n\n- `a`\n\n| x | y |\n|-|-|\n| 1 | 2 |");
  assert.equal(plainText(blocks), "Plan\nShip docs\na\nx, y\n1, 2");
  assert.deepStrictEqual(linksOf(blocks), [{ href: "https://e.com/d", label: "docs" }]);
});

test("16 KiB of mixed emphasis delimiters parses in a few milliseconds", () => {
  const patterns = ["*_", "_*", ".*_", "*_ ", "**__", "*_~~", "(*_)", "*.", "_**", "[a](", "[x]"];
  for (const p of patterns) parse(p.repeat(500));
  for (const p of patterns) {
    const input = p.repeat(Math.floor(16384 / p.length));
    const started = performance.now();
    parse(input);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 40, `${JSON.stringify(p)} took ${elapsed.toFixed(1)} ms`);
  }
});
