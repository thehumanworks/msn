/**
 * Safe Markdown for message bodies (ADR 0043), the iOS copy of public/markdown.js.
 *
 * parse() turns message text into a small plain tree. Nothing here makes HTML or markup: raw
 * HTML stays literal text, and a link exists only when its target is http or https. The
 * MarkdownText component renders the tree with nested <Text> and <View> only.
 *
 * tests/fixtures/markdown-cases.json at the repository root is the shared contract with the
 * web and desktop parsers: all three must produce exactly the trees it lists.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong" | "em" | "del"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export type Align = "" | "left" | "center" | "right";

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "code_block"; lang: string; text: string }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number | null; items: Block[][] }
  | { type: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] };

type Tail = { bracket: number; paren: number; nextClose: number; nextParen: number; nextSpace: number };
type Fence = { indent: number; ch: string; n: number; lang: string };
type Marker = { ordered: boolean; start: number | null; delim: string; width: number; content: string };
// Work nodes are inline nodes plus delimiter runs and a nesting height while emphasis is matched.
// biome-ignore lint/suspicious/noExplicitAny: internal scratch shape, finished into Inline.
type Work = { type: string; [key: string]: any };

/** Quotes and lists nest at most this deep; deeper markers stay plain text. */
const MAX_BLOCK_DEPTH = 8;
/** Bold, italic, strikethrough and links nest at most this deep; deeper markers are dropped. */
const MAX_INLINE_DEPTH = 8;
/** A link label longer than this is not a link (bounds the bracket search). */
const MAX_LABEL = 1000;
/** Emphasis delimiter runs per paragraph; later ones are literal, which keeps matching linear. */
const MAX_DELIMS = 500;

const ALNUM = (() => {
  try {
    return new RegExp("^[\\p{L}\\p{N}]$", "u");
  } catch {
    return null;
  }
})();

/** Whitespace by code point, the same set in all three parsers (and faster than a regex). */
const isSpaceCode = (n: number): boolean =>
  (n >= 9 && n <= 13) ||
  n === 32 ||
  n === 0x85 ||
  n === 0xa0 ||
  n === 0x1680 ||
  (n >= 0x2000 && n <= 0x200a) ||
  n === 0x2028 ||
  n === 0x2029 ||
  n === 0x202f ||
  n === 0x205f ||
  n === 0x3000;
const isSpace = (c: string | undefined): boolean => c === undefined || isSpaceCode(c.charCodeAt(0));
/** Characters a backslash escapes. A backslash before anything else, itself included, stays. */
const ESCAPABLE = "`*_~[]()<>#|!+-.";
const isEscapable = (c: string | undefined): boolean => c !== undefined && ESCAPABLE.includes(c);
const isPunct = (c: string | undefined): boolean => c !== undefined && /^[!-/:-@[-`{-~]$/.test(c);
const isAlnum = (c: string | undefined): boolean =>
  c !== undefined && (ALNUM ? ALNUM.test(c) : /^[0-9A-Za-z]$/.test(c) || c.toLowerCase() !== c.toUpperCase());
const isBlank = (line: string): boolean => /^[ \t]*$/.test(line);
const indentOf = (line: string): number => line.length - line.replace(/^ +/, "").length;

/**
 * A link target is kept only when it is an absolute http or https URL with a host and no
 * whitespace, control or bidirectional characters, quotes or angle brackets. Everything
 * else is not a link.
 */
export function safeHref(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 2048) return null;
  const lower = url.slice(0, 8).toLowerCase();
  const rest = lower.startsWith("https://") ? 8 : lower.startsWith("http://") ? 7 : 0;
  if (!rest || url.length === rest || url[rest] === "/") return null;
  for (const ch of url) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      code <= 0x20 ||
      isSpaceCode(code) ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f) ||
      // Zero-width and bidirectional controls can disguise where a link really goes.
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      `<>"\`\\`.includes(ch)
    )
      return null;
  }
  return url;
}

// ---------------------------------------------------------------- blocks

function fenceOpen(line: string): Fence | null {
  const indent = indentOf(line);
  if (indent > 3) return null;
  const ch = line[indent];
  if (ch !== "`" && ch !== "~") return null;
  let n = 0;
  while (line[indent + n] === ch) n++;
  if (n < 3) return null;
  const info = line.slice(indent + n);
  if (ch === "`" && info.includes("`")) return null;
  const lang = info.trim().split(/[ \t]+/)[0];
  return { indent, ch, n, lang };
}

function fenceCloses(line: string, fence: Fence): boolean {
  const indent = indentOf(line);
  if (indent > 3) return false;
  let n = 0;
  while (line[indent + n] === fence.ch) n++;
  return n >= fence.n && isBlank(line.slice(indent + n));
}

function heading(line: string): { level: number; text: string } | null {
  const indent = indentOf(line);
  if (indent > 3) return null;
  let n = 0;
  while (line[indent + n] === "#") n++;
  if (n < 1 || n > 6) return null;
  const rest = line.slice(indent + n);
  if (rest !== "" && rest[0] !== " " && rest[0] !== "\t") return null;
  let text = rest.trim();
  if (/^#+$/.test(text)) text = "";
  else text = text.replace(/[ \t]+#+$/, "").trim();
  // An empty heading would hide the text; "#" alone stays a plain line.
  return text ? { level: n, text } : null;
}

function quoteLine(line: string): string | null {
  const indent = indentOf(line);
  if (indent > 3 || line[indent] !== ">") return null;
  const rest = line.slice(indent + 1);
  return rest[0] === " " ? rest.slice(1) : rest;
}

function listMarker(line: string): Marker | null {
  const indent = indentOf(line);
  if (indent > 3) return null;
  let at = indent;
  let ordered = false;
  let start: number | null = null;
  let delim = line[at];
  if (delim === "-" || delim === "*" || delim === "+") at++;
  else {
    while (at - indent < 9 && line[at] >= "0" && line[at] <= "9") at++;
    if (at === indent || (line[at] !== "." && line[at] !== ")")) return null;
    ordered = true;
    start = Number(line.slice(indent, at));
    delim = line[at];
    at++;
  }
  if (at === line.length) return { ordered, start, delim, width: at + 1, content: "" };
  if (line[at] !== " ") return null;
  let spaces = 0;
  while (line[at + spaces] === " ") spaces++;
  const rest = line.slice(at + spaces);
  if (rest === "") return { ordered, start, delim, width: at + 1, content: "" };
  const width = spaces > 4 ? at + 1 : at + spaces;
  return { ordered, start, delim, width, content: line.slice(width) };
}

/** Splits a table row on unescaped pipes, or returns null when the line has none. */
function splitRow(line: string): string[] | null {
  let text = line.trim();
  const cells: string[] = [];
  let cell = "";
  let pipes = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length) {
      cell += text[i] + text[i + 1];
      i++;
    } else if (text[i] === "|") {
      pipes++;
      cells.push(cell);
      cell = "";
    } else cell += text[i];
  }
  if (!pipes) return null;
  cells.push(cell);
  if (cells[0].trim() === "" && line.trim().startsWith("|")) cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === "" && line.trim().endsWith("|")) cells.pop();
  return cells.map((c) => c.trim());
}

function delimiterRow(line: string): Align[] | null {
  const cells = splitRow(line);
  if (!cells?.length) return null;
  const align: Align[] = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    align.push(left && right ? "center" : right ? "right" : left ? "left" : "");
  }
  return align;
}

function tableStart(lines: string[], i: number): { head: string[]; align: Align[] } | null {
  if (i + 1 >= lines.length || indentOf(lines[i]) > 3 || indentOf(lines[i + 1]) > 3) return null;
  const head = splitRow(lines[i]);
  if (!head) return null;
  const align = delimiterRow(lines[i + 1]);
  if (!align || align.length !== head.length) return null;
  return { head, align };
}

/** True when lines[i] starts a block after a blank line: any list may start there. */
function startsBlock(lines: string[], i: number, depth: number): boolean {
  if (interrupts(lines, i, depth)) return true;
  const marker = depth < MAX_BLOCK_DEPTH ? listMarker(lines[i]) : null;
  return marker !== null && marker.content !== "";
}

/** True when lines[i] starts a block that ends the paragraph or lazy list text before it. */
function interrupts(lines: string[], i: number, depth: number): boolean {
  const line = lines[i];
  if (fenceOpen(line) || heading(line)) return true;
  if (depth < MAX_BLOCK_DEPTH && quoteLine(line) !== null) return true;
  if (depth < MAX_BLOCK_DEPTH) {
    const marker = listMarker(line);
    if (marker && marker.content !== "" && (!marker.ordered || marker.start === 1)) return true;
  }
  return tableStart(lines, i) !== null;
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !fenceCloses(lines[i], fence)) {
        const strip = Math.min(fence.indent, indentOf(lines[i]));
        body.push(lines[i].slice(strip));
        i++;
      }
      i++;
      out.push({ type: "code_block", lang: fence.lang, text: body.join("\n") });
      continue;
    }
    const head = heading(line);
    if (head) {
      out.push({ type: "heading", level: head.level, children: parseInline(head.text) });
      i++;
      continue;
    }
    if (depth < MAX_BLOCK_DEPTH && quoteLine(line) !== null) {
      const body: string[] = [];
      while (i < lines.length && quoteLine(lines[i]) !== null) body.push(quoteLine(lines[i++]) as string);
      out.push({ type: "quote", children: parseBlocks(body, depth + 1) });
      continue;
    }
    const first = depth < MAX_BLOCK_DEPTH ? listMarker(line) : null;
    if (first) {
      const items: Block[][] = [];
      while (i < lines.length) {
        const marker = listMarker(lines[i]);
        if (!marker || marker.ordered !== first.ordered || marker.delim !== first.delim) break;
        const body = [marker.content];
        i++;
        while (i < lines.length) {
          const next = lines[i];
          if (isBlank(next)) {
            let j = i;
            while (j < lines.length && isBlank(lines[j])) j++;
            if (j < lines.length && indentOf(lines[j]) >= marker.width) {
              while (i < j) {
                body.push("");
                i++;
              }
              continue;
            }
            break;
          }
          if (indentOf(next) >= marker.width) {
            body.push(next.slice(marker.width));
            i++;
          } else if (!isBlank(body[body.length - 1]) && !listMarker(next) && !interrupts(lines, i, depth)) {
            body.push(next);
            i++;
          } else break;
        }
        items.push(parseBlocks(body, depth + 1));
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j++;
        const after = j < lines.length ? listMarker(lines[j]) : null;
        if (!after || after.ordered !== first.ordered || after.delim !== first.delim) break;
        i = j;
      }
      out.push({ type: "list", ordered: first.ordered, start: first.start, items });
      continue;
    }
    const table = tableStart(lines, i);
    if (table) {
      const width = table.head.length;
      const fitRow = (cells: string[]): Inline[][] => Array.from({ length: width }, (_, k) => parseInline(cells[k] ?? ""));
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && !fenceOpen(lines[i]) && !heading(lines[i])) {
        if (quoteLine(lines[i]) !== null) break;
        const cells = splitRow(lines[i]);
        if (!cells) break;
        rows.push(fitRow(cells));
        i++;
      }
      out.push({ type: "table", align: table.align, head: fitRow(table.head), rows });
      continue;
    }
    const para = [line];
    i++;
    for (;;) {
      if (i >= lines.length) break;
      if (!isBlank(lines[i])) {
        if (interrupts(lines, i, depth)) break;
        para.push(lines[i++]);
        continue;
      }
      // Blank lines inside running text stay in the paragraph, so they show as before.
      let j = i;
      while (j < lines.length && isBlank(lines[j])) j++;
      if (j >= lines.length || startsBlock(lines, j, depth)) break;
      while (i < j) para.push(lines[i++]);
    }
    out.push({ type: "paragraph", children: parseInline(para.join("\n")) });
  }
  return out;
}

/** Parses message text into blocks. Plain text becomes paragraphs of text only. */
export function parse(text: string): Block[] {
  return parseBlocks(String(text ?? "").replace(/\r\n?/g, "\n").split("\n"), 0);
}

// ---------------------------------------------------------------- inlines

function runLength(s: string, i: number, ch: string): number {
  let n = 0;
  while (s[i + n] === ch) n++;
  return n;
}

/** The end of a bare http(s) URL starting at i, after trailing punctuation is trimmed. */
function bareUrlEnd(s: string, i: number): number {
  const head = s.slice(i, i + 8).toLowerCase();
  const scheme = head.startsWith("https://") ? 8 : head.startsWith("http://") ? 7 : 0;
  if (!scheme || isAlnum(s[i - 1])) return -1;
  let end = i + scheme;
  while (end < s.length && !isSpace(s[end]) && s[end] !== "<" && s[end] !== "`") end++;
  for (;;) {
    const last = s[end - 1];
    if ("?!.,:;*_~'\"".includes(last)) end--;
    else if (last === ")") {
      const url = s.slice(i, end);
      if (url.split("(").length >= url.split(")").length) break;
      end--;
    } else break;
  }
  return end > i + scheme ? end : -1;
}

/**
 * Parses "[label](target)" at i. Returns null when it is not a well-formed safe link.
 * `tail` holds the last "](" and ")" in `s` and the next "]", ")" and whitespace seen, for
 * cheap early exits.
 */
function parseLink(s: string, i: number, tail: Tail): { label: string; href: string; end: number } | null {
  // Cheap exits first, so a long run of "[" or "[a](" stays linear.
  if (tail.bracket < i || tail.paren < i) return null;
  if (tail.nextClose < i) {
    const at = s.indexOf("]", i);
    tail.nextClose = at < 0 ? s.length : at;
  }
  if (tail.nextClose - i > MAX_LABEL) return null;
  let depth = 0;
  let close = -1;
  for (let k = i; k < s.length && k - i <= MAX_LABEL; k++) {
    if (s[k] === "\\") k++;
    else if (s[k] === "[") depth++;
    else if (s[k] === "]" && --depth === 0) {
      close = k;
      break;
    }
  }
  if (close < 0 || s[close + 1] !== "(") return null;
  let k = close + 2;
  while (s[k] === " ") k++;
  let target = "";
  if (s[k] === "<") {
    const end = s.indexOf(">", k);
    if (end < 0) return null;
    target = s.slice(k + 1, end);
    k = end + 1;
  } else {
    let parens = 0;
    const from = k;
    // The target ends at a ")" or whitespace. When neither comes within the length limit the
    // URL would be too long anyway; the cached positions keep repeated attempts linear.
    if (tail.nextParen < from) {
      const at = s.indexOf(")", from);
      tail.nextParen = at < 0 ? s.length : at;
    }
    if (tail.nextSpace < from) {
      let at = from;
      while (at < s.length && !isSpace(s[at])) at++;
      tail.nextSpace = at;
    }
    if (Math.min(tail.nextParen, tail.nextSpace) - from > 2048) return null;
    while (k < s.length && k - from <= 2048 && !isSpace(s[k])) {
      if (s[k] === "\\" && isEscapable(s[k + 1])) k++;
      else if (s[k] === "(") parens++;
      else if (s[k] === ")") {
        if (parens === 0) break;
        parens--;
      }
      k++;
    }
    target = s.slice(from, k);
  }
  while (s[k] === " ") k++;
  const quote = s[k];
  if (quote === '"' || quote === "'") {
    const end = s.indexOf(quote, k + 1);
    if (end < 0) return null;
    k = end + 1;
    while (s[k] === " ") k++;
  }
  if (s[k] !== ")") return null;
  const href = safeHref(target.replace(/\\([`*_~[\]()<>#|!+\-.])/g, "$1"));
  if (!href) return null;
  return { label: s.slice(i + 1, close), href, end: k + 1 };
}

function height(node: Work): number {
  return node.h ?? 0;
}

/** Nesting depth of finished nodes (link labels hold no links, so this stays shallow). */
function depthOf(nodes: Work[]): number {
  let deepest = 0;
  for (const node of nodes) if (node.children) deepest = Math.max(deepest, 1 + depthOf(node.children));
  return deepest;
}

function link(href: string, children: Work[]): Work {
  return { type: "link", href, children, h: depthOf(children) + 1 };
}

/** Matches * _ ~~ delimiter runs into strong, em and del (CommonMark's algorithm, simplified). */
function processEmphasis(nodes: Work[]): void {
  const stack: number[] = [];
  const bottom = new Map<string, number>();
  for (let k = 0; k < nodes.length; k++) {
    const closer = nodes[k];
    if (closer.type !== "delim") continue;
    if (closer.close) {
      const key = `${closer.ch}${closer.open ? 1 : 0}${closer.orig % 3}`;
      let found = true;
      while (closer.len > 0 && found) {
        found = false;
        for (let s = stack.length - 1; s >= (bottom.get(key) ?? 0); s--) {
          const opener = nodes[stack[s]];
          if (opener.ch !== closer.ch) continue;
          if (
            closer.ch !== "~" &&
            (opener.close || closer.open) &&
            (opener.orig + closer.orig) % 3 === 0 &&
            !(opener.orig % 3 === 0 && closer.orig % 3 === 0)
          )
            continue;
          const use = closer.ch === "~" ? 2 : opener.len >= 2 && closer.len >= 2 ? 2 : 1;
          const at = stack[s];
          let tallest = 0;
          for (let j = at + 1; j < k; j++) tallest = Math.max(tallest, height(nodes[j]));
          // Past the nesting cap the delimiters are used up but add no formatting.
          if (tallest < MAX_INLINE_DEPTH) {
            const type = closer.ch === "~" ? "del" : use === 2 ? "strong" : "em";
            nodes.splice(at + 1, 0, { type, children: nodes.splice(at + 1, k - at - 1), h: tallest + 1 });
            k = at + 2;
          }
          opener.len -= use;
          closer.len -= use;
          stack.length = opener.len > 0 ? s + 1 : s;
          for (const [name, value] of bottom) if (value > stack.length) bottom.set(name, stack.length);
          found = true;
          break;
        }
      }
      if (closer.len > 0) {
        if (!found) bottom.set(key, stack.length);
        if (closer.open) stack.push(k);
      }
    } else if (closer.open) stack.push(k);
  }
}

/** Turns leftover delimiters into text, merges neighbouring text and drops bookkeeping. */
function finish(nodes: Work[]): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    let next: Inline;
    if (node.type === "delim") {
      if (!node.len) continue;
      next = { type: "text", text: node.ch.repeat(node.len) };
    } else if (node.type === "strong" || node.type === "em" || node.type === "del") {
      next = { type: node.type, children: finish(node.children) };
    } else if (node.type === "link") {
      next = { type: "link", href: node.href, children: node.children };
    } else if (node.type === "code") {
      next = { type: "code", text: node.text };
    } else next = { type: "text", text: node.text };
    const last = out[out.length - 1];
    if (next.type === "text" && last?.type === "text") last.text += next.text;
    else out.push(next);
  }
  return out;
}

function parseInline(s: string, inLink = false): Inline[] {
  const nodes: Work[] = [];
  let text = "";
  const flush = () => {
    if (text) nodes.push({ type: "text", text });
    text = "";
  };
  const tail: Tail = { bracket: s.lastIndexOf("]("), paren: s.lastIndexOf(")"), nextClose: -1, nextParen: -1, nextSpace: -1 };
  let delims = 0;
  const noCloser = new Set<number>();
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && isEscapable(s[i + 1])) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const n = runLength(s, i, "`");
      let close = -1;
      if (!noCloser.has(n)) {
        for (let k = i + n; k < s.length; ) {
          const m = runLength(s, k, "`");
          if (m === n) {
            close = k;
            break;
          }
          k += m || 1;
        }
        if (close < 0) noCloser.add(n);
      }
      if (close >= 0) {
        flush();
        let code = s.slice(i + n, close).replace(/\n/g, " ");
        if (code.length >= 2 && code[0] === " " && code[code.length - 1] === " " && code.trim() !== "")
          code = code.slice(1, -1);
        nodes.push({ type: "code", text: code });
        i = close + n;
      } else {
        text += s.slice(i, i + n);
        i += n;
      }
      continue;
    }
    if (!inLink && (c === "[" || (c === "!" && s[i + 1] === "["))) {
      const found = parseLink(s, c === "!" ? i + 1 : i, tail);
      if (found) {
        flush();
        const children = parseInline(found.label, true);
        nodes.push(link(found.href, children.length ? children : [{ type: "text", text: found.href }]));
        i = found.end;
        continue;
      }
    }
    if (!inLink && c === "<") {
      const end = s.indexOf(">", i);
      const href = end > i ? safeHref(s.slice(i + 1, end)) : null;
      if (href) {
        flush();
        nodes.push(link(href, [{ type: "text", text: href }]));
        i = end + 1;
        continue;
      }
    }
    if (!inLink && (c === "h" || c === "H")) {
      const end = bareUrlEnd(s, i);
      if (end > i) {
        const href = safeHref(s.slice(i, end));
        if (href) {
          flush();
          nodes.push(link(href, [{ type: "text", text: href }]));
        } else text += s.slice(i, end);
        i = end;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      const n = runLength(s, i, c);
      if ((c === "~" && n !== 2) || delims >= MAX_DELIMS) {
        text += s.slice(i, i + n);
        i += n;
        continue;
      }
      const before = s[i - 1];
      const after = s[i + n];
      const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
      const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
      // Between two letters or digits (snake_case, 2*3*4) a delimiter is literal.
      const inWord = isAlnum(before) && isAlnum(after);
      const open = !inWord && (c === "_" ? left && (!right || isPunct(before)) : left);
      const close = !inWord && (c === "_" ? right && (!left || isPunct(after)) : right);
      delims++;
      flush();
      nodes.push({ type: "delim", ch: c, len: n, orig: n, open, close });
      i += n;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  processEmphasis(nodes);
  return finish(nodes);
}

function inlineText(nodes: Inline[]): string {
  return nodes.map((node) => ("children" in node ? inlineText(node.children) : node.text)).join("");
}

function blockText(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "heading") out.push(inlineText(block.children));
    else if (block.type === "code_block") out.push(block.text);
    else if (block.type === "quote") out.push(...blockText(block.children));
    else if (block.type === "list") for (const item of block.items) out.push(...blockText(item));
    else if (block.type === "table")
      for (const row of [block.head, ...block.rows]) out.push(row.map(inlineText).join(", "));
  }
  return out;
}

/** The words a reader sees, without markup: for VoiceOver labels and one-line previews. */
export function plainText(blocks: Block[]): string {
  return blockText(blocks).join("\n");
}

/** Every link in reading order, so VoiceOver can offer them as actions on a message row. */
export function linksOf(blocks: Block[]): { href: string; label: string }[] {
  const out: { href: string; label: string }[] = [];
  const inline = (nodes: Inline[]) => {
    for (const node of nodes) {
      if (node.type === "link") out.push({ href: node.href, label: inlineText(node.children) });
      else if ("children" in node) inline(node.children);
    }
  };
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "heading") inline(block.children);
    else if (block.type === "quote") out.push(...linksOf(block.children));
    else if (block.type === "list") for (const item of block.items) out.push(...linksOf(item));
    else if (block.type === "table") for (const cell of [...block.head, ...block.rows.flat()]) inline(cell);
  }
  return out;
}
