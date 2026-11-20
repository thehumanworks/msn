// Safe Markdown for message bodies (ADR 0043).
//
// parse() turns message text into a small plain tree. It never produces HTML: raw HTML in a
// message stays literal text, and a link exists only when its target is http or https.
// renderMarkdown() builds DOM nodes from that tree with createElement and text nodes only.
//
// The same parser exists in apps/ios/src/core/markdown.ts and apps/desktop/src/markdown.rs.
// tests/fixtures/markdown-cases.json is the shared contract: all three must produce exactly
// the trees it lists, so change the three together.

/** Quotes and lists nest at most this deep; deeper markers stay plain text. */
const MAX_BLOCK_DEPTH = 8;
/** Bold, italic, strikethrough and links nest at most this deep; deeper markers are dropped. */
const MAX_INLINE_DEPTH = 8;
/** A link label longer than this is not a link (bounds the bracket search). */
const MAX_LABEL = 1000;

const isSpace = (c) => c === undefined || /\s/u.test(c);
const isPunct = (c) => c !== undefined && /^[!-/:-@[-`{-~]$/.test(c);
const isAlnum = (c) => c !== undefined && /^[\p{L}\p{N}]$/u.test(c);
const isBlank = (line) => /^[ \t]*$/.test(line);
const indentOf = (line) => line.length - line.replace(/^ +/, "").length;

/**
 * A link target is kept only when it is an absolute http or https URL with a host and no
 * whitespace, control characters, quotes or angle brackets. Everything else is not a link.
 */
export function safeHref(url) {
  if (typeof url !== "string" || url.length > 2048) return null;
  const lower = url.slice(0, 8).toLowerCase();
  const rest = lower.startsWith("https://") ? 8 : lower.startsWith("http://") ? 7 : 0;
  if (!rest || url.length === rest || url[rest] === "/") return null;
  for (const ch of url) {
    const code = ch.codePointAt(0);
    if (code <= 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f) || `<>"\`\\`.includes(ch))
      return null;
  }
  return url;
}

// ---------------------------------------------------------------- blocks

function fenceOpen(line) {
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

function fenceCloses(line, fence) {
  const indent = indentOf(line);
  if (indent > 3) return false;
  let n = 0;
  while (line[indent + n] === fence.ch) n++;
  return n >= fence.n && isBlank(line.slice(indent + n));
}

function heading(line) {
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

function quoteLine(line) {
  const indent = indentOf(line);
  if (indent > 3 || line[indent] !== ">") return null;
  const rest = line.slice(indent + 1);
  return rest[0] === " " ? rest.slice(1) : rest;
}

function listMarker(line) {
  const indent = indentOf(line);
  if (indent > 3) return null;
  let at = indent;
  let ordered = false;
  let start = null;
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
function splitRow(line) {
  const text = line.trim();
  const cells = [];
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

function delimiterRow(line) {
  const cells = splitRow(line);
  if (!cells?.length) return null;
  const align = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    align.push(left && right ? "center" : right ? "right" : left ? "left" : "");
  }
  return align;
}

function tableStart(lines, i) {
  if (i + 1 >= lines.length || indentOf(lines[i]) > 3 || indentOf(lines[i + 1]) > 3) return null;
  const head = splitRow(lines[i]);
  if (!head) return null;
  const align = delimiterRow(lines[i + 1]);
  if (!align || align.length !== head.length) return null;
  return { head, align };
}

/** True when lines[i] starts a block that ends the paragraph or lazy list text before it. */
function interrupts(lines, i, depth) {
  const line = lines[i];
  if (fenceOpen(line) || heading(line)) return true;
  if (depth < MAX_BLOCK_DEPTH && quoteLine(line) !== null) return true;
  if (depth < MAX_BLOCK_DEPTH) {
    const marker = listMarker(line);
    if (marker && marker.content !== "" && (!marker.ordered || marker.start === 1)) return true;
  }
  return tableStart(lines, i) !== null;
}

function parseBlocks(lines, depth) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence) {
      const body = [];
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
      const body = [];
      while (i < lines.length && quoteLine(lines[i]) !== null) body.push(quoteLine(lines[i++]));
      out.push({ type: "quote", children: parseBlocks(body, depth + 1) });
      continue;
    }
    const first = depth < MAX_BLOCK_DEPTH ? listMarker(line) : null;
    if (first) {
      const items = [];
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
      const fitRow = (cells) => Array.from({ length: width }, (_, k) => parseInline(cells[k] ?? ""));
      const rows = [];
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
    while (i < lines.length && !isBlank(lines[i]) && !interrupts(lines, i, depth)) para.push(lines[i++]);
    out.push({ type: "paragraph", children: parseInline(para.join("\n")) });
  }
  return out;
}

/** Parses message text into blocks. Plain text becomes paragraphs of text only. */
export function parse(text) {
  return parseBlocks(
    String(text ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n"),
    0,
  );
}

// ---------------------------------------------------------------- inlines

function runLength(s, i, ch) {
  let n = 0;
  while (s[i + n] === ch) n++;
  return n;
}

/** The end of a bare http(s) URL starting at i, after trailing punctuation is trimmed. */
function bareUrlEnd(s, i) {
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
 * `tail` holds the last index of "](" and of ")" in `s`, for cheap early exits.
 */
function parseLink(s, i, tail) {
  // Cheap exits first, so a long run of "[" or "[a](" stays linear.
  if (tail[0] < i || tail[1] < i) return null;
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
    while (k < s.length && k - from <= 2048 && !isSpace(s[k])) {
      if (s[k] === "\\" && isPunct(s[k + 1])) k++;
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
  const href = safeHref(target.replace(/\\([!-/:-@[-`{-~])/g, "$1"));
  if (!href) return null;
  return { label: s.slice(i + 1, close), href, end: k + 1 };
}

function height(node) {
  return node.h ?? 0;
}

/** Nesting depth of finished nodes (link labels hold no links, so this stays shallow). */
function depthOf(nodes) {
  let deepest = 0;
  for (const node of nodes) if (node.children) deepest = Math.max(deepest, 1 + depthOf(node.children));
  return deepest;
}

function link(href, children) {
  return { type: "link", href, children, h: depthOf(children) + 1 };
}

/** Matches * _ ~~ delimiter runs into strong, em and del (CommonMark's algorithm, simplified). */
function processEmphasis(nodes) {
  const stack = [];
  const bottom = new Map();
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
function finish(nodes) {
  const out = [];
  for (const node of nodes) {
    let next = node;
    if (node.type === "delim") {
      if (!node.len) continue;
      next = { type: "text", text: node.ch.repeat(node.len) };
    } else if (node.type === "strong" || node.type === "em" || node.type === "del") {
      next = { type: node.type, children: finish(node.children) };
    } else if (node.type === "link") {
      next = { type: "link", href: node.href, children: node.children };
    }
    const last = out[out.length - 1];
    if (next.type === "text" && last?.type === "text") last.text += next.text;
    else out.push(next.type === "text" ? { type: "text", text: next.text } : next);
  }
  return out;
}

function parseInline(s, inLink = false) {
  const nodes = [];
  let text = "";
  const flush = () => {
    if (text) nodes.push({ type: "text", text });
    text = "";
  };
  const tail = [s.lastIndexOf("]("), s.lastIndexOf(")")];
  const noCloser = new Set();
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && isPunct(s[i + 1])) {
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
      if (c === "~" && n !== 2) {
        text += s.slice(i, i + n);
        i += n;
        continue;
      }
      const before = s[i - 1];
      const after = s[i + n];
      const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
      const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
      const open = c === "_" ? left && (!right || isPunct(before)) : left;
      const close = c === "_" ? right && (!left || isPunct(after)) : right;
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

// ---------------------------------------------------------------- DOM

function renderInline(doc, parent, nodes) {
  for (const node of nodes) {
    if (node.type === "text") {
      parent.append(doc.createTextNode(node.text));
      continue;
    }
    if (node.type === "code") {
      const code = doc.createElement("code");
      code.textContent = node.text;
      parent.append(code);
      continue;
    }
    if (node.type === "link") {
      // Checked again here so a tree built elsewhere can never carry another scheme.
      const href = safeHref(node.href);
      if (!href) {
        renderInline(doc, parent, node.children);
        continue;
      }
      const a = doc.createElement("a");
      a.setAttribute("href", href);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer nofollow");
      a.setAttribute("referrerpolicy", "no-referrer");
      a.title = href;
      renderInline(doc, a, node.children);
      parent.append(a);
      continue;
    }
    const tag = { strong: "strong", em: "em", del: "del" }[node.type];
    if (!tag) continue;
    const element = doc.createElement(tag);
    renderInline(doc, element, node.children);
    parent.append(element);
  }
}

function renderBlocks(doc, parent, blocks) {
  for (const block of blocks) {
    let element;
    if (block.type === "paragraph") {
      element = doc.createElement("p");
      renderInline(doc, element, block.children);
    } else if (block.type === "heading") {
      // Real h1-h6 would join the page outline; a message heading is only emphasis there.
      element = doc.createElement("p");
      element.className = `md-heading md-h${block.level}`;
      element.setAttribute("role", "heading");
      element.setAttribute("aria-level", String(Math.min(6, block.level + 2)));
      renderInline(doc, element, block.children);
    } else if (block.type === "code_block") {
      element = doc.createElement("pre");
      element.className = "md-code";
      element.tabIndex = 0;
      const code = doc.createElement("code");
      code.textContent = block.text;
      if (block.lang) element.dataset.lang = block.lang;
      element.append(code);
    } else if (block.type === "quote") {
      element = doc.createElement("blockquote");
      renderBlocks(doc, element, block.children);
    } else if (block.type === "list") {
      element = doc.createElement(block.ordered ? "ol" : "ul");
      if (block.ordered && block.start !== 1) element.setAttribute("start", String(block.start));
      for (const item of block.items) {
        const li = doc.createElement("li");
        if (item.length === 1 && item[0].type === "paragraph") renderInline(doc, li, item[0].children);
        else renderBlocks(doc, li, item);
        element.append(li);
      }
    } else if (block.type === "table") {
      element = doc.createElement("div");
      element.className = "md-table";
      element.tabIndex = 0;
      const table = doc.createElement("table");
      const row = (cells, tag) => {
        const tr = doc.createElement("tr");
        cells.forEach((cell, k) => {
          const td = doc.createElement(tag);
          if (block.align[k]) td.className = `md-${block.align[k]}`;
          renderInline(doc, td, cell);
          tr.append(td);
        });
        return tr;
      };
      const thead = doc.createElement("thead");
      thead.append(row(block.head, "th"));
      const tbody = doc.createElement("tbody");
      for (const cells of block.rows) tbody.append(row(cells, "td"));
      table.append(thead, tbody);
      element.append(table);
    } else continue;
    parent.append(element);
  }
}

/**
 * Renders message text as DOM. One paragraph becomes a <p> exactly as before; anything else
 * becomes a <div class="md"> of blocks. Only element and text nodes are created.
 */
export function renderMarkdown(text, doc = document) {
  const blocks = parse(text);
  if (blocks.length === 0 || (blocks.length === 1 && blocks[0].type === "paragraph")) {
    const p = doc.createElement("p");
    if (blocks.length) renderInline(doc, p, blocks[0].children);
    else p.textContent = text;
    return p;
  }
  const div = doc.createElement("div");
  div.className = "md";
  renderBlocks(doc, div, blocks);
  return div;
}
