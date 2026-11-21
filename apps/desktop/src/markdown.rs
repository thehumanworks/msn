//! Safe Markdown for message bodies (ADR 0043), the desktop copy of `public/markdown.js`.
//!
//! [`parse`] turns message text into a small plain tree. Nothing here makes HTML: raw HTML stays
//! literal text, and a link exists only when its target is http or https. [`show`] draws the tree
//! with egui labels, and a link opens only after [`safe_href`] accepts it again.
//!
//! `tests/fixtures/markdown-cases.json` at the repository root is the shared contract with the
//! web and iOS parsers: all three must produce exactly the trees it lists.

use eframe::egui;
use serde::Serialize;

/// Quotes and lists nest at most this deep; deeper markers stay plain text.
const MAX_BLOCK_DEPTH: usize = 8;
/// Bold, italic, strikethrough and links nest at most this deep; deeper markers are dropped.
const MAX_INLINE_DEPTH: usize = 8;
/// A link label longer than this is not a link (bounds the bracket search).
const MAX_LABEL: usize = 1000;
const MAX_URL: usize = 2048;
/// Emphasis delimiter runs per paragraph; later ones are literal, which keeps matching linear.
const MAX_DELIMS: usize = 500;
/// Characters a backslash escapes. A backslash before anything else, itself included, stays.
const ESCAPABLE: &str = "`*_~[]()<>#|!+-.";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Inline {
    Text { text: String },
    Code { text: String },
    Strong { children: Vec<Inline> },
    Em { children: Vec<Inline> },
    Del { children: Vec<Inline> },
    Link { href: String, children: Vec<Inline> },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Paragraph {
        children: Vec<Inline>,
    },
    Heading {
        level: u8,
        children: Vec<Inline>,
    },
    CodeBlock {
        lang: String,
        text: String,
    },
    Quote {
        children: Vec<Block>,
    },
    List {
        ordered: bool,
        start: Option<u32>,
        items: Vec<Vec<Block>>,
    },
    Table {
        /// "", "left", "center" or "right" per column.
        align: Vec<String>,
        head: Vec<Vec<Inline>>,
        rows: Vec<Vec<Vec<Inline>>>,
    },
}

/// Whitespace by code point, the same set in all three parsers.
fn is_space_char(c: char) -> bool {
    matches!(
        c as u32,
        9..=13 | 32 | 0x85 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000
    )
}
fn is_space(c: Option<char>) -> bool {
    c.is_none_or(is_space_char)
}
fn is_escapable(c: Option<char>) -> bool {
    c.is_some_and(|c| ESCAPABLE.contains(c))
}
fn is_punct(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_punctuation())
}
fn is_alnum(c: Option<char>) -> bool {
    c.is_some_and(char::is_alphanumeric)
}
fn is_blank(line: &str) -> bool {
    line.chars().all(|c| c == ' ' || c == '\t')
}
fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// A link target is kept only when it is an absolute http or https URL with a host and no
/// whitespace, control characters, quotes or angle brackets. Everything else is not a link.
pub fn safe_href(url: &str) -> Option<&str> {
    if url.encode_utf16().count() > MAX_URL {
        return None;
    }
    let lower: String = url.chars().take(8).collect::<String>().to_lowercase();
    let rest = if lower.starts_with("https://") {
        8
    } else if lower.starts_with("http://") {
        7
    } else {
        return None;
    };
    if url.len() == rest || url.as_bytes()[rest] == b'/' {
        return None;
    }
    let bad = url.chars().any(|ch| {
        let code = ch as u32;
        code <= 0x20
            || is_space_char(ch)
            || code == 0x7f
            || (0x80..=0x9f).contains(&code)
            // Zero-width and bidirectional controls can disguise where a link really goes.
            || (0x200b..=0x200f).contains(&code)
            || (0x202a..=0x202e).contains(&code)
            || (0x2066..=0x2069).contains(&code)
            || "<>\"`\\".contains(ch)
    });
    if bad { None } else { Some(url) }
}

// ---------------------------------------------------------------- blocks

struct Fence {
    indent: usize,
    ch: char,
    n: usize,
    lang: String,
}

fn run_of(line: &str, from: usize, ch: char) -> usize {
    line[from..].chars().take_while(|&c| c == ch).count()
}

fn fence_open(line: &str) -> Option<Fence> {
    let indent = indent_of(line);
    if indent > 3 {
        return None;
    }
    let ch = line[indent..].chars().next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let n = run_of(line, indent, ch);
    if n < 3 {
        return None;
    }
    let info = &line[indent + n..];
    if ch == '`' && info.contains('`') {
        return None;
    }
    let lang = info
        .trim()
        .split([' ', '\t'])
        .next()
        .unwrap_or("")
        .to_string();
    Some(Fence {
        indent,
        ch,
        n,
        lang,
    })
}

fn fence_closes(line: &str, fence: &Fence) -> bool {
    let indent = indent_of(line);
    if indent > 3 {
        return false;
    }
    let n = run_of(line, indent, fence.ch);
    n >= fence.n && is_blank(&line[indent + n..])
}

fn heading(line: &str) -> Option<(u8, String)> {
    let indent = indent_of(line);
    if indent > 3 {
        return None;
    }
    let n = run_of(line, indent, '#');
    if !(1..=6).contains(&n) {
        return None;
    }
    let rest = &line[indent + n..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    let mut text = rest.trim().to_string();
    if !text.is_empty() && text.chars().all(|c| c == '#') {
        text.clear();
    } else {
        // Drop a closing run of # that follows a space or tab.
        let without = text.trim_end_matches('#');
        if without.len() < text.len() && without.ends_with([' ', '\t']) {
            text = without.trim().to_string();
        } else {
            text = text.trim().to_string();
        }
    }
    // An empty heading would hide the text; "#" alone stays a plain line.
    if text.is_empty() {
        None
    } else {
        Some((n as u8, text))
    }
}

fn quote_line(line: &str) -> Option<&str> {
    let indent = indent_of(line);
    if indent > 3 || !line[indent..].starts_with('>') {
        return None;
    }
    let rest = &line[indent + 1..];
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

struct Marker {
    ordered: bool,
    start: Option<u32>,
    delim: char,
    width: usize,
    content: String,
}

fn list_marker(line: &str) -> Option<Marker> {
    let indent = indent_of(line);
    if indent > 3 {
        return None;
    }
    let bytes = line.as_bytes();
    let mut at = indent;
    let mut ordered = false;
    let mut start = None;
    let first = *bytes.get(at)?;
    let delim;
    if matches!(first, b'-' | b'*' | b'+') {
        delim = first as char;
        at += 1;
    } else {
        while at - indent < 9 && bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if at == indent || !matches!(bytes.get(at), Some(b'.' | b')')) {
            return None;
        }
        ordered = true;
        start = line[indent..at].parse().ok();
        delim = bytes[at] as char;
        at += 1;
    }
    let empty = |width| Marker {
        ordered,
        start,
        delim,
        width,
        content: String::new(),
    };
    if at == line.len() {
        return Some(empty(at + 1));
    }
    if bytes[at] != b' ' {
        return None;
    }
    let spaces = run_of(line, at, ' ');
    if at + spaces == line.len() {
        return Some(empty(at + 1));
    }
    let width = if spaces > 4 { at + 1 } else { at + spaces };
    Some(Marker {
        ordered,
        start,
        delim,
        width,
        content: line[width..].to_string(),
    })
}

/// Splits a table row on unescaped pipes, or returns None when the line has none.
fn split_row(line: &str) -> Option<Vec<String>> {
    let text = line.trim();
    let mut cells = Vec::new();
    let mut cell = String::new();
    let mut pipes = 0;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && chars.peek().is_some() {
            cell.push(c);
            cell.push(chars.next().unwrap_or_default());
        } else if c == '|' {
            pipes += 1;
            cells.push(std::mem::take(&mut cell));
        } else {
            cell.push(c);
        }
    }
    if pipes == 0 {
        return None;
    }
    cells.push(cell);
    if cells[0].trim().is_empty() && text.starts_with('|') {
        cells.remove(0);
    }
    if cells.last().is_some_and(|c| c.trim().is_empty()) && text.ends_with('|') {
        cells.pop();
    }
    Some(cells.into_iter().map(|c| c.trim().to_string()).collect())
}

fn delimiter_row(line: &str) -> Option<Vec<String>> {
    let cells = split_row(line)?;
    if cells.is_empty() {
        return None;
    }
    let mut align = Vec::new();
    for cell in cells {
        let inner = cell.strip_prefix(':').unwrap_or(&cell);
        let inner = inner.strip_suffix(':').unwrap_or(inner);
        if inner.is_empty() || !inner.chars().all(|c| c == '-') {
            return None;
        }
        let left = cell.starts_with(':');
        let right = cell.ends_with(':') && cell.len() > 1;
        align.push(
            match (left, right) {
                (true, true) => "center",
                (false, true) => "right",
                (true, false) => "left",
                _ => "",
            }
            .to_string(),
        );
    }
    Some(align)
}

fn table_start(lines: &[String], i: usize) -> Option<(Vec<String>, Vec<String>)> {
    if i + 1 >= lines.len() || indent_of(&lines[i]) > 3 || indent_of(&lines[i + 1]) > 3 {
        return None;
    }
    let head = split_row(&lines[i])?;
    let align = delimiter_row(&lines[i + 1])?;
    (align.len() == head.len()).then_some((head, align))
}

/// True when lines[i] starts a block after a blank line: any list may start there.
fn starts_block(lines: &[String], i: usize, depth: usize) -> bool {
    interrupts(lines, i, depth)
        || (depth < MAX_BLOCK_DEPTH
            && list_marker(&lines[i]).is_some_and(|marker| !marker.content.is_empty()))
}

/// True when lines[i] starts a block that ends the paragraph or lazy list text before it.
fn interrupts(lines: &[String], i: usize, depth: usize) -> bool {
    let line = &lines[i];
    if fence_open(line).is_some() || heading(line).is_some() {
        return true;
    }
    if depth < MAX_BLOCK_DEPTH && quote_line(line).is_some() {
        return true;
    }
    if depth < MAX_BLOCK_DEPTH
        && let Some(marker) = list_marker(line)
        && !marker.content.is_empty()
        && (!marker.ordered || marker.start == Some(1))
    {
        return true;
    }
    table_start(lines, i).is_some()
}

fn parse_blocks(lines: &[String], depth: usize) -> Vec<Block> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = &lines[i];
        if is_blank(line) {
            i += 1;
            continue;
        }
        if let Some(fence) = fence_open(line) {
            let mut body = Vec::new();
            i += 1;
            while i < lines.len() && !fence_closes(&lines[i], &fence) {
                let strip = fence.indent.min(indent_of(&lines[i]));
                body.push(&lines[i][strip..]);
                i += 1;
            }
            i += 1;
            out.push(Block::CodeBlock {
                lang: fence.lang,
                text: body.join("\n"),
            });
            continue;
        }
        if let Some((level, text)) = heading(line) {
            out.push(Block::Heading {
                level,
                children: parse_inline(&text, false),
            });
            i += 1;
            continue;
        }
        if depth < MAX_BLOCK_DEPTH && quote_line(line).is_some() {
            let mut body = Vec::new();
            while let Some(rest) = lines.get(i).and_then(|l| quote_line(l)) {
                body.push(rest.to_string());
                i += 1;
            }
            out.push(Block::Quote {
                children: parse_blocks(&body, depth + 1),
            });
            continue;
        }
        if let Some(first) = (depth < MAX_BLOCK_DEPTH)
            .then(|| list_marker(line))
            .flatten()
        {
            let same = |m: &Marker| m.ordered == first.ordered && m.delim == first.delim;
            let mut items = Vec::new();
            while i < lines.len() {
                let Some(marker) = list_marker(&lines[i]).filter(same) else {
                    break;
                };
                let mut body = vec![marker.content.clone()];
                i += 1;
                while i < lines.len() {
                    let next = &lines[i];
                    if is_blank(next) {
                        let mut j = i;
                        while j < lines.len() && is_blank(&lines[j]) {
                            j += 1;
                        }
                        if j < lines.len() && indent_of(&lines[j]) >= marker.width {
                            while i < j {
                                body.push(String::new());
                                i += 1;
                            }
                            continue;
                        }
                        break;
                    }
                    if indent_of(next) >= marker.width {
                        body.push(next[marker.width..].to_string());
                        i += 1;
                    } else if !body.last().is_some_and(|l| is_blank(l))
                        && list_marker(next).is_none()
                        && !interrupts(lines, i, depth)
                    {
                        body.push(next.clone());
                        i += 1;
                    } else {
                        break;
                    }
                }
                items.push(parse_blocks(&body, depth + 1));
                let mut j = i;
                while j < lines.len() && is_blank(&lines[j]) {
                    j += 1;
                }
                if j >= lines.len() || list_marker(&lines[j]).filter(same).is_none() {
                    break;
                }
                i = j;
            }
            out.push(Block::List {
                ordered: first.ordered,
                start: first.start,
                items,
            });
            continue;
        }
        if let Some((head, align)) = table_start(lines, i) {
            let width = head.len();
            let fit = |cells: &[String]| -> Vec<Vec<Inline>> {
                (0..width)
                    .map(|k| parse_inline(cells.get(k).map_or("", String::as_str), false))
                    .collect()
            };
            let mut rows = Vec::new();
            i += 2;
            while i < lines.len()
                && !is_blank(&lines[i])
                && fence_open(&lines[i]).is_none()
                && heading(&lines[i]).is_none()
                && quote_line(&lines[i]).is_none()
            {
                let Some(cells) = split_row(&lines[i]) else {
                    break;
                };
                rows.push(fit(&cells));
                i += 1;
            }
            out.push(Block::Table {
                align,
                head: fit(&head),
                rows,
            });
            continue;
        }
        let mut para = vec![line.as_str()];
        i += 1;
        while i < lines.len() {
            if !is_blank(&lines[i]) {
                if interrupts(lines, i, depth) {
                    break;
                }
                para.push(&lines[i]);
                i += 1;
                continue;
            }
            // Blank lines inside running text stay in the paragraph, so they show as before.
            let mut j = i;
            while j < lines.len() && is_blank(&lines[j]) {
                j += 1;
            }
            if j >= lines.len() || starts_block(lines, j, depth) {
                break;
            }
            while i < j {
                para.push(&lines[i]);
                i += 1;
            }
        }
        out.push(Block::Paragraph {
            children: parse_inline(&para.join("\n"), false),
        });
    }
    out
}

/// Parses message text into blocks. Plain text becomes paragraphs of text only.
pub fn parse(text: &str) -> Vec<Block> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<String> = normalized.split('\n').map(str::to_string).collect();
    parse_blocks(&lines, 0)
}

// ---------------------------------------------------------------- inlines

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Strong,
    Em,
    Del,
}

enum Work {
    Text(String),
    /// A finished code span or link, with its nesting height.
    Done(Inline, usize),
    Delim {
        ch: char,
        len: usize,
        orig: usize,
        open: bool,
        close: bool,
    },
    Wrap {
        kind: Kind,
        children: Vec<Work>,
        height: usize,
    },
}

impl Work {
    fn height(&self) -> usize {
        match self {
            Work::Done(_, h) => *h,
            Work::Wrap { height, .. } => *height,
            _ => 0,
        }
    }
}

fn at(s: &[char], i: usize) -> Option<char> {
    s.get(i).copied()
}

fn before(s: &[char], i: usize) -> Option<char> {
    i.checked_sub(1).and_then(|k| at(s, k))
}

fn run_length(s: &[char], i: usize, ch: char) -> usize {
    s[i.min(s.len())..].iter().take_while(|&&c| c == ch).count()
}

fn index_of(s: &[char], needle: &[char], from: usize) -> Option<usize> {
    if from >= s.len() {
        return None;
    }
    s[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

fn slice(s: &[char], from: usize, to: usize) -> String {
    s[from.min(s.len())..to.min(s.len())].iter().collect()
}

fn link_node(href: String, children: Vec<Inline>, child_height: usize) -> Work {
    Work::Done(Inline::Link { href, children }, child_height + 1)
}

/// The end of a bare http(s) URL starting at i, after trailing punctuation is trimmed.
fn bare_url_end(s: &[char], i: usize) -> Option<usize> {
    let head = slice(s, i, i + 8).to_lowercase();
    let scheme = if head.starts_with("https://") {
        8
    } else if head.starts_with("http://") {
        7
    } else {
        return None;
    };
    if is_alnum(before(s, i)) {
        return None;
    }
    let mut end = i + scheme;
    while end < s.len() && !is_space_char(s[end]) && s[end] != '<' && s[end] != '`' {
        end += 1;
    }
    loop {
        let last = s[end - 1];
        if "?!.,:;*_~'\"".contains(last) {
            end -= 1;
        } else if last == ')' {
            let opens = s[i..end].iter().filter(|&&c| c == '(').count();
            let closes = s[i..end].iter().filter(|&&c| c == ')').count();
            if opens >= closes {
                break;
            }
            end -= 1;
        } else {
            break;
        }
    }
    (end > i + scheme).then_some(end)
}

struct FoundLink {
    label: Vec<char>,
    href: String,
    end: usize,
}

/// The last "](" and ")" in the text and the next "]", ")" and whitespace seen, so repeated
/// link attempts (a long run of "[" or "[a](") stay linear.
struct Tail {
    bracket: Option<usize>,
    paren: Option<usize>,
    next_close: Option<usize>,
    next_paren: Option<usize>,
    next_space: Option<usize>,
}

fn next_at(s: &[char], from: usize, found: impl Fn(char) -> bool) -> usize {
    s[from.min(s.len())..]
        .iter()
        .position(|&c| found(c))
        .map_or(s.len(), |p| p + from)
}

/// Parses "[label](target)" at i. Returns None when it is not a well-formed safe link.
fn parse_link(s: &[char], i: usize, tail: &mut Tail) -> Option<FoundLink> {
    if tail.bracket.is_none_or(|last| last < i) || tail.paren.is_none_or(|last| last < i) {
        return None;
    }
    if tail.next_close.is_none_or(|at| at < i) {
        tail.next_close = Some(next_at(s, i, |c| c == ']'));
    }
    if tail.next_close.unwrap_or(0) - i > MAX_LABEL {
        return None;
    }
    let mut depth = 0usize;
    let mut close = None;
    let mut k = i;
    while k < s.len() && k - i <= MAX_LABEL {
        match s[k] {
            '\\' => k += 1,
            '[' => depth += 1,
            ']' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    close = Some(k);
                    break;
                }
            }
            _ => {}
        }
        k += 1;
    }
    let close = close?;
    if at(s, close + 1) != Some('(') {
        return None;
    }
    let mut k = close + 2;
    while at(s, k) == Some(' ') {
        k += 1;
    }
    let target;
    if at(s, k) == Some('<') {
        let end = index_of(s, &['>'], k)?;
        target = slice(s, k + 1, end);
        k = end + 1;
    } else {
        let mut parens = 0usize;
        let from = k;
        // The target ends at a ")" or whitespace. When neither comes within the length limit the
        // URL would be too long anyway; the cached positions keep repeated attempts linear.
        if tail.next_paren.is_none_or(|at| at < from) {
            tail.next_paren = Some(next_at(s, from, |c| c == ')'));
        }
        if tail.next_space.is_none_or(|at| at < from) {
            tail.next_space = Some(next_at(s, from, is_space_char));
        }
        if tail
            .next_paren
            .unwrap_or(0)
            .min(tail.next_space.unwrap_or(0))
            .saturating_sub(from)
            > MAX_URL
        {
            return None;
        }
        while k < s.len() && k - from <= MAX_URL && !is_space_char(s[k]) {
            if s[k] == '\\' && is_escapable(at(s, k + 1)) {
                k += 1;
            } else if s[k] == '(' {
                parens += 1;
            } else if s[k] == ')' {
                if parens == 0 {
                    break;
                }
                parens -= 1;
            }
            k += 1;
        }
        target = slice(s, from, k);
    }
    while at(s, k) == Some(' ') {
        k += 1;
    }
    if let Some(quote @ ('"' | '\'')) = at(s, k) {
        let end = index_of(s, &[quote], k + 1)?;
        k = end + 1;
        while at(s, k) == Some(' ') {
            k += 1;
        }
    }
    if at(s, k) != Some(')') {
        return None;
    }
    let mut unescaped = String::new();
    let t: Vec<char> = target.chars().collect();
    let mut j = 0;
    while j < t.len() {
        if t[j] == '\\' && is_escapable(t.get(j + 1).copied()) {
            j += 1;
        }
        unescaped.push(t[j]);
        j += 1;
    }
    let href = safe_href(&unescaped)?.to_string();
    Some(FoundLink {
        label: s[i + 1..close].to_vec(),
        href,
        end: k + 1,
    })
}

/// Matches * _ ~~ delimiter runs into strong, em and del (CommonMark's algorithm, simplified).
fn process_emphasis(nodes: &mut Vec<Work>) {
    let mut stack: Vec<usize> = Vec::new();
    let mut bottom: Vec<((char, bool, usize), usize)> = Vec::new();
    let mut k = 0;
    while k < nodes.len() {
        let Work::Delim {
            ch,
            open: c_open,
            close: c_close,
            orig: c_orig,
            ..
        } = nodes[k]
        else {
            k += 1;
            continue;
        };
        if !c_close {
            if c_open {
                stack.push(k);
            }
            k += 1;
            continue;
        }
        let key = (ch, c_open, c_orig % 3);
        let mut found = true;
        while delim_len(&nodes[k]) > 0 && found {
            found = false;
            let floor = bottom
                .iter()
                .find(|(name, _)| *name == key)
                .map_or(0, |(_, v)| *v);
            let mut s = stack.len();
            while s > floor {
                s -= 1;
                let Work::Delim {
                    ch: o_ch,
                    len: o_len,
                    orig: o_orig,
                    close: o_close,
                    ..
                } = nodes[stack[s]]
                else {
                    continue;
                };
                if o_ch != ch {
                    continue;
                }
                if ch != '~'
                    && (o_close || c_open)
                    && (o_orig + c_orig) % 3 == 0
                    && !(o_orig % 3 == 0 && c_orig % 3 == 0)
                {
                    continue;
                }
                let c_len = delim_len(&nodes[k]);
                let used = if ch == '~' || (o_len >= 2 && c_len >= 2) {
                    2
                } else {
                    1
                };
                let start = stack[s];
                let tallest = nodes[start + 1..k]
                    .iter()
                    .map(Work::height)
                    .max()
                    .unwrap_or(0);
                // Past the nesting cap the delimiters are used up but add no formatting.
                if tallest < MAX_INLINE_DEPTH {
                    let kind = if ch == '~' {
                        Kind::Del
                    } else if used == 2 {
                        Kind::Strong
                    } else {
                        Kind::Em
                    };
                    let children: Vec<Work> = nodes.drain(start + 1..k).collect();
                    nodes.insert(
                        start + 1,
                        Work::Wrap {
                            kind,
                            children,
                            height: tallest + 1,
                        },
                    );
                    k = start + 2;
                }
                shrink(&mut nodes[start], used);
                shrink(&mut nodes[k], used);
                let remaining = delim_len(&nodes[start]);
                stack.truncate(if remaining > 0 { s + 1 } else { s });
                for (_, value) in bottom.iter_mut() {
                    *value = (*value).min(stack.len());
                }
                found = true;
                break;
            }
        }
        if delim_len(&nodes[k]) > 0 {
            if !found {
                match bottom.iter_mut().find(|(name, _)| *name == key) {
                    Some((_, value)) => *value = stack.len(),
                    None => bottom.push((key, stack.len())),
                }
            }
            if c_open {
                stack.push(k);
            }
        }
        k += 1;
    }
}

fn delim_len(node: &Work) -> usize {
    match node {
        Work::Delim { len, .. } => *len,
        _ => 0,
    }
}

fn shrink(node: &mut Work, by: usize) {
    if let Work::Delim { len, .. } = node {
        *len -= by;
    }
}

/// Turns leftover delimiters into text, merges neighbouring text and drops bookkeeping.
fn finish(nodes: Vec<Work>) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::new();
    for node in nodes {
        let next = match node {
            Work::Delim { len: 0, .. } => continue,
            Work::Delim { ch, len, .. } => Inline::Text {
                text: ch.to_string().repeat(len),
            },
            Work::Text(text) => Inline::Text { text },
            Work::Done(inline, _) => inline,
            Work::Wrap { kind, children, .. } => {
                let children = finish(children);
                match kind {
                    Kind::Strong => Inline::Strong { children },
                    Kind::Em => Inline::Em { children },
                    Kind::Del => Inline::Del { children },
                }
            }
        };
        if let (Inline::Text { text: add }, Some(Inline::Text { text })) = (&next, out.last_mut()) {
            text.push_str(add);
        } else {
            out.push(next);
        }
    }
    out
}

fn inline_height(nodes: &[Inline]) -> usize {
    fn one(node: &Inline) -> usize {
        match node {
            Inline::Text { .. } | Inline::Code { .. } => 0,
            Inline::Strong { children }
            | Inline::Em { children }
            | Inline::Del { children }
            | Inline::Link { children, .. } => 1 + inline_height(children),
        }
    }
    nodes.iter().map(one).max().unwrap_or(0)
}

fn parse_inline(text: &str, in_link: bool) -> Vec<Inline> {
    let s: Vec<char> = text.chars().collect();
    parse_chars(&s, in_link)
}

fn parse_chars(s: &[char], in_link: bool) -> Vec<Inline> {
    let mut nodes: Vec<Work> = Vec::new();
    let mut text = String::new();
    let flush = |nodes: &mut Vec<Work>, text: &mut String| {
        if !text.is_empty() {
            nodes.push(Work::Text(std::mem::take(text)));
        }
    };
    let mut no_closer: Vec<usize> = Vec::new();
    let mut tail = Tail {
        bracket: s.windows(2).rposition(|w| w == [']', '(']),
        paren: s.iter().rposition(|&c| c == ')'),
        next_close: None,
        next_paren: None,
        next_space: None,
    };
    let mut delims = 0usize;
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        if c == '\\' && is_escapable(at(s, i + 1)) {
            text.push(s[i + 1]);
            i += 2;
            continue;
        }
        if c == '`' {
            let n = run_length(s, i, '`');
            let mut close = None;
            if !no_closer.contains(&n) {
                let mut k = i + n;
                while k < s.len() {
                    let m = run_length(s, k, '`');
                    if m == n {
                        close = Some(k);
                        break;
                    }
                    k += m.max(1);
                }
                if close.is_none() {
                    no_closer.push(n);
                }
            }
            if let Some(close) = close {
                flush(&mut nodes, &mut text);
                let mut code: Vec<char> = s[i + n..close]
                    .iter()
                    .map(|&c| if c == '\n' { ' ' } else { c })
                    .collect();
                if code.len() >= 2
                    && code[0] == ' '
                    && code[code.len() - 1] == ' '
                    && code.iter().any(|c| !c.is_whitespace())
                {
                    code = code[1..code.len() - 1].to_vec();
                }
                nodes.push(Work::Done(
                    Inline::Code {
                        text: code.into_iter().collect(),
                    },
                    0,
                ));
                i = close + n;
            } else {
                text.extend(&s[i..i + n]);
                i += n;
            }
            continue;
        }
        if !in_link && (c == '[' || (c == '!' && at(s, i + 1) == Some('['))) {
            let from = if c == '!' { i + 1 } else { i };
            if let Some(found) = parse_link(s, from, &mut tail) {
                flush(&mut nodes, &mut text);
                let mut children = parse_chars(&found.label, true);
                if children.is_empty() {
                    children.push(Inline::Text {
                        text: found.href.clone(),
                    });
                }
                let height = inline_height(&children);
                nodes.push(link_node(found.href, children, height));
                i = found.end;
                continue;
            }
        }
        if !in_link && c == '<' {
            let end = index_of(s, &['>'], i);
            let target = end.map(|end| slice(s, i + 1, end));
            if let (Some(end), Some(href)) = (end, target.as_deref().and_then(safe_href)) {
                let href = href.to_string();
                flush(&mut nodes, &mut text);
                nodes.push(link_node(
                    href.clone(),
                    vec![Inline::Text { text: href }],
                    0,
                ));
                i = end + 1;
                continue;
            }
        }
        if !in_link
            && (c == 'h' || c == 'H')
            && let Some(end) = bare_url_end(s, i)
        {
            let url = slice(s, i, end);
            if let Some(href) = safe_href(&url) {
                flush(&mut nodes, &mut text);
                nodes.push(link_node(
                    href.to_string(),
                    vec![Inline::Text {
                        text: href.to_string(),
                    }],
                    0,
                ));
            } else {
                text.push_str(&url);
            }
            i = end;
            continue;
        }
        if c == '*' || c == '_' || c == '~' {
            let n = run_length(s, i, c);
            if (c == '~' && n != 2) || delims >= MAX_DELIMS {
                text.extend(&s[i..i + n]);
                i += n;
                continue;
            }
            let prev = before(s, i);
            let after = at(s, i + n);
            let left = !is_space(after) && (!is_punct(after) || is_space(prev) || is_punct(prev));
            let right = !is_space(prev) && (!is_punct(prev) || is_space(after) || is_punct(after));
            let (open, close) = if c == '_' {
                (
                    left && (!right || is_punct(prev)),
                    right && (!left || is_punct(after)),
                )
            } else {
                (left, right)
            };
            // Between two letters or digits (snake_case, 2*3*4) a delimiter is literal.
            let in_word = is_alnum(prev) && is_alnum(after);
            let (open, close) = (open && !in_word, close && !in_word);
            delims += 1;
            flush(&mut nodes, &mut text);
            nodes.push(Work::Delim {
                ch: c,
                len: n,
                orig: n,
                open,
                close,
            });
            i += n;
            continue;
        }
        text.push(c);
        i += 1;
    }
    flush(&mut nodes, &mut text);
    process_emphasis(&mut nodes);
    finish(nodes)
}

// ---------------------------------------------------------------- egui

/// The text of a message that is one paragraph of plain words, with escapes resolved, so it
/// keeps the old single-label path. None when the message has any formatting.
pub fn plain_text(blocks: &[Block]) -> Option<String> {
    match blocks {
        [] => Some(String::new()),
        [Block::Paragraph { children }] => children
            .iter()
            .map(|child| match child {
                Inline::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()
            .map(|parts| parts.concat()),
        _ => None,
    }
}

/// What a message body shows: plain text, or formatted blocks.
pub enum Parsed {
    Plain(String),
    Blocks(Vec<Block>),
}

thread_local! {
    static PARSED: std::cell::RefCell<std::collections::HashMap<String, std::rc::Rc<Parsed>>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

/// Parses message text once and reuses the result on later frames. The cache is keyed by the
/// whole text and emptied when it grows past a few thousand messages.
pub fn parse_cached(text: &str) -> std::rc::Rc<Parsed> {
    PARSED.with(|cache| {
        if let Some(found) = cache.borrow().get(text) {
            return found.clone();
        }
        let blocks = parse(text);
        let parsed = std::rc::Rc::new(match plain_text(&blocks) {
            Some(plain) if blocks.is_empty() => Parsed::Plain(if plain.is_empty() {
                text.to_string()
            } else {
                plain
            }),
            Some(plain) => Parsed::Plain(plain),
            None => Parsed::Blocks(blocks),
        });
        let mut cache = cache.borrow_mut();
        if cache.len() >= 4096 {
            cache.clear();
        }
        cache.insert(text.to_string(), parsed.clone());
        parsed
    })
}

#[derive(Clone, Copy)]
struct Style {
    strong: bool,
    em: bool,
    del: bool,
    code: bool,
    link: bool,
}

const PLAIN: Style = Style {
    strong: false,
    em: false,
    del: false,
    code: false,
    link: false,
};

struct Span {
    text: String,
    style: Style,
    href: Option<String>,
}

fn flatten(nodes: &[Inline], style: Style, href: Option<&str>, out: &mut Vec<Span>) {
    for node in nodes {
        match node {
            Inline::Text { text } => out.push(Span {
                text: text.clone(),
                style,
                href: href.map(str::to_string),
            }),
            Inline::Code { text } => out.push(Span {
                text: text.clone(),
                style: Style {
                    code: true,
                    ..style
                },
                href: href.map(str::to_string),
            }),
            Inline::Strong { children } => flatten(
                children,
                Style {
                    strong: true,
                    ..style
                },
                href,
                out,
            ),
            Inline::Em { children } => flatten(children, Style { em: true, ..style }, href, out),
            Inline::Del { children } => flatten(children, Style { del: true, ..style }, href, out),
            Inline::Link { href, children } => flatten(
                children,
                Style {
                    link: true,
                    ..style
                },
                Some(href),
                out,
            ),
        }
    }
}

fn format(ui: &egui::Ui, style: Style, size: f32, base: egui::Color32) -> egui::TextFormat {
    let visuals = ui.visuals();
    let mut format = egui::TextFormat {
        font_id: if style.code {
            egui::FontId::monospace(size - 1.0)
        } else {
            egui::FontId::proportional(size)
        },
        color: base,
        italics: style.em,
        ..Default::default()
    };
    if style.strong {
        // The bundled fonts have no bold face, so strong text is brighter and slightly larger.
        format.color = visuals.strong_text_color();
        format.font_id.size += 0.5;
    }
    if style.code {
        format.background = visuals.code_bg_color;
    }
    if style.del {
        format.strikethrough = egui::Stroke::new(1.0, base);
    }
    if style.link {
        format.color = visuals.hyperlink_color;
        format.underline = egui::Stroke::new(1.0, visuals.hyperlink_color);
    }
    format
}

/// One run of inline text as a single wrapping, selectable label. Links are character ranges
/// of that label: a click on one opens it, so selecting across a link still works.
fn show_inline(ui: &mut egui::Ui, nodes: &[Inline], size: f32, base: egui::Color32) {
    let mut spans = Vec::new();
    flatten(nodes, PLAIN, None, &mut spans);
    let mut job = egui::text::LayoutJob::default();
    let mut links: Vec<(std::ops::Range<usize>, &str)> = Vec::new();
    let mut chars = 0;
    for span in &spans {
        job.append(&span.text, 0.0, format(ui, span.style, size, base));
        let count = span.text.chars().count();
        if let Some(href) = span.href.as_deref().and_then(safe_href) {
            links.push((chars..chars + count, href));
        }
        chars += count;
    }
    let galley = egui::WidgetText::from(job).into_galley(
        ui,
        Some(egui::TextWrapMode::Wrap),
        ui.available_width(),
        egui::TextStyle::Body,
    );
    let label = egui::Label::new(galley.clone());
    let response = if links.is_empty() {
        ui.add(label)
    } else {
        // Click and drag, so text stays selectable across links.
        ui.add(label.sense(egui::Sense::click_and_drag()))
    };
    if links.is_empty() {
        return;
    }
    let link_at = |pointer: egui::Pos2| -> Option<&str> {
        let rel = pointer - response.rect.min;
        let cursor = galley.cursor_from_pos(rel);
        // The cursor sits between two characters; take the one whose box holds the pointer.
        [Some(cursor.index.0), cursor.index.0.checked_sub(1)]
            .into_iter()
            .flatten()
            .find(|&c| {
                let left = galley.pos_from_cursor(egui::text::CCursor::new(c));
                let right = galley.pos_from_cursor(egui::text::CCursor::new(c + 1));
                left.min.y == right.min.y
                    && rel.x >= left.min.x
                    && rel.x < right.min.x
                    && rel.y >= left.min.y
                    && rel.y < left.max.y
            })
            .and_then(|c| links.iter().find(|(range, _)| range.contains(&c)))
            .map(|(_, href)| *href)
    };
    if let Some(href) = response.hover_pos().and_then(link_at) {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
        let href = href.to_string();
        let response = response.clone().on_hover_text_at_pointer(href);
        if response.clicked() {
            // safe_href again so nothing but http(s) ever reaches the browser.
            if let Some(href) = response
                .interact_pointer_pos()
                .and_then(link_at)
                .and_then(safe_href)
            {
                ui.ctx().open_url(egui::OpenUrl::new_tab(href));
            }
        }
    }
}

/// How long the copy button reads "Copied" after a click.
const COPIED_SECS: f64 = 2.0;

/// The id of the copy button on block `n` of the blocks drawn in `ui`.
fn copy_id(ui: &egui::Ui, n: usize) -> egui::Id {
    ui.id().with(("md-code-copy", n))
}

/// ADR 0058: a small Copy button in a code block's top-right corner. It shows while the pointer
/// is over the block, and copies the code exactly as written, without the fence or language.
fn copy_button(ui: &mut egui::Ui, id: egui::Id, block: egui::Rect, text: &str) {
    let now = ui.input(|i| i.time);
    let copied_at = ui.ctx().data(|d| d.get_temp::<f64>(id));
    let copied = copied_at.is_some_and(|at| now - at < COPIED_SECS);
    if !copied && !ui.rect_contains_pointer(block) {
        return;
    }
    let label = if copied { "Copied" } else { "Copy" };
    let font = egui::FontId::proportional(11.0);
    let galley = ui
        .painter()
        .layout_no_wrap(label.to_string(), font, egui::Color32::PLACEHOLDER);
    let size = galley.size() + egui::vec2(12.0, 6.0);
    let rect = egui::Rect::from_min_size(
        egui::pos2(block.right() - size.x - 4.0, block.top() + 4.0),
        size,
    );
    let response = ui
        .interact(rect, id, egui::Sense::click())
        .on_hover_cursor(egui::CursorIcon::PointingHand)
        .on_hover_text("Copy code");
    response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, "Copy code"));
    let visuals = ui.style().interact(&response);
    let color = if response.hovered() {
        ui.visuals().hyperlink_color
    } else {
        ui.visuals().weak_text_color()
    };
    ui.painter().rect(
        rect,
        4,
        ui.visuals().extreme_bg_color,
        visuals.bg_stroke,
        egui::StrokeKind::Inside,
    );
    ui.painter()
        .galley(rect.center() - galley.size() / 2.0, galley, color);
    if response.clicked() {
        ui.ctx().copy_text(text.to_string());
        ui.ctx().data_mut(|d| d.insert_temp(id, now));
        ui.ctx()
            .request_repaint_after(std::time::Duration::from_secs_f64(COPIED_SECS));
    }
}

fn show_blocks(ui: &mut egui::Ui, blocks: &[Block], size: f32, base: egui::Color32) {
    for (n, block) in blocks.iter().enumerate() {
        match block {
            Block::Paragraph { children } => show_inline(ui, children, size, base),
            Block::Heading { level, children } => {
                let bigger = match level {
                    1 => size + 5.0,
                    2 => size + 3.0,
                    _ => size + 1.0,
                };
                let strong = ui.visuals().strong_text_color();
                show_inline(ui, children, bigger, strong);
            }
            Block::CodeBlock { text, .. } => {
                // Long lines scroll sideways instead of wrapping.
                let frame = egui::Frame::new()
                    .fill(ui.visuals().code_bg_color)
                    .corner_radius(6)
                    .inner_margin(egui::Margin::symmetric(8, 6))
                    .show(ui, |ui| {
                        egui::ScrollArea::horizontal()
                            .id_salt(ui.next_auto_id())
                            .show(ui, |ui| {
                                ui.add(
                                    egui::Label::new(
                                        egui::RichText::new(text)
                                            .monospace()
                                            .size(size - 1.0)
                                            .color(base),
                                    )
                                    .extend(),
                                );
                            });
                    });
                copy_button(ui, copy_id(ui, n), frame.response.rect, text);
            }
            Block::Quote { children } => {
                ui.horizontal_top(|ui| {
                    let (rect, _) =
                        ui.allocate_exact_size(egui::vec2(3.0, size * 1.4), egui::Sense::hover());
                    ui.painter()
                        .rect_filled(rect, 1.0, ui.visuals().weak_text_color());
                    ui.vertical(|ui| {
                        show_blocks(ui, children, size, ui.visuals().weak_text_color());
                    });
                });
            }
            Block::List {
                ordered,
                start,
                items,
            } => {
                for (n, item) in items.iter().enumerate() {
                    ui.horizontal_top(|ui| {
                        let marker = if *ordered {
                            format!("{}.", start.unwrap_or(1) as u64 + n as u64)
                        } else {
                            "\u{2022}".to_string()
                        };
                        ui.add_sized(
                            egui::vec2(18.0, size * 1.3),
                            egui::Label::new(egui::RichText::new(marker).size(size).color(base)),
                        );
                        ui.vertical(|ui| show_blocks(ui, item, size, base));
                    });
                }
            }
            Block::Table { head, rows, .. } => {
                egui::ScrollArea::horizontal()
                    .id_salt(ui.next_auto_id())
                    .show(ui, |ui| {
                        egui::Grid::new(ui.next_auto_id())
                            .striped(true)
                            .spacing(egui::vec2(12.0, 4.0))
                            .show(ui, |ui| {
                                for cell in head {
                                    let strong = ui.visuals().strong_text_color();
                                    show_inline(ui, cell, size - 1.0, strong);
                                }
                                ui.end_row();
                                for row in rows {
                                    for cell in row {
                                        show_inline(ui, cell, size - 1.0, base);
                                    }
                                    ui.end_row();
                                }
                            });
                    });
            }
        }
    }
}

/// Draws parsed message text inside the current (bubble) ui.
pub fn show(ui: &mut egui::Ui, blocks: &[Block]) {
    let size = egui::TextStyle::Body.resolve(ui.style()).size;
    let base = ui.visuals().text_color();
    ui.spacing_mut().item_spacing.y = 4.0;
    show_blocks(ui, blocks, size, base);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        input: String,
        expected: serde_json::Value,
    }

    fn cases() -> Vec<Case> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/markdown-cases.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).expect("fixture file")).expect("json")
    }

    #[test]
    fn shared_fixtures_match_web_and_ios() {
        let mut failures = Vec::new();
        for case in cases() {
            let got = serde_json::to_value(parse(&case.input)).expect("serialize");
            if got != case.expected {
                failures.push(format!(
                    "{}\n  got:      {got}\n  expected: {}",
                    case.name, case.expected
                ));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    fn links(blocks: &[Block], out: &mut Vec<String>) {
        fn inline(nodes: &[Inline], out: &mut Vec<String>) {
            for node in nodes {
                match node {
                    Inline::Link { href, children } => {
                        out.push(href.clone());
                        inline(children, out);
                    }
                    Inline::Strong { children }
                    | Inline::Em { children }
                    | Inline::Del { children } => inline(children, out),
                    _ => {}
                }
            }
        }
        for block in blocks {
            match block {
                Block::Paragraph { children } | Block::Heading { children, .. } => {
                    inline(children, out)
                }
                Block::Quote { children } => links(children, out),
                Block::List { items, .. } => items.iter().for_each(|item| links(item, out)),
                Block::Table { head, rows, .. } => head
                    .iter()
                    .chain(rows.iter().flatten())
                    .for_each(|cell| inline(cell, out)),
                Block::CodeBlock { .. } => {}
            }
        }
    }

    /// ADR 0058: hovering a code block shows Copy; a click copies only the code, then the
    /// button reads Copied.
    #[test]
    fn the_copy_button_copies_a_code_block_without_its_fence() {
        let ctx = egui::Context::default();
        let blocks = parse("Run this:\n\n```sh\nmsn join general\nmsn listen\n```");
        let screen = Some(egui::Rect::from_min_size(
            egui::Pos2::ZERO,
            egui::vec2(600.0, 300.0),
        ));
        let button_id = std::cell::Cell::new(None);
        let frame = |events: Vec<egui::Event>| {
            let mut output = ctx.run_ui(
                egui::RawInput {
                    screen_rect: screen,
                    events,
                    ..Default::default()
                },
                |ui| {
                    button_id.set(Some(copy_id(ui, 1)));
                    show(ui, &blocks);
                },
            );
            output.textures_delta.clear();
            output
                .platform_output
                .commands
                .into_iter()
                .filter_map(|command| match command {
                    egui::OutputCommand::CopyText(text) => Some(text),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        frame(vec![]);
        let id = button_id.get().unwrap();
        assert!(ctx.read_response(id).is_none(), "hidden until hovered");
        // The block sits below the paragraph; hover its left edge, then find the button.
        frame(vec![egui::Event::PointerMoved(egui::pos2(4.0, 40.0))]);
        frame(vec![]);
        let button = ctx.read_response(id).expect("hovering shows Copy");
        let pos = button.rect.center();
        let press = |pressed| egui::Event::PointerButton {
            pos,
            button: egui::PointerButton::Primary,
            pressed,
            modifiers: Default::default(),
        };
        frame(vec![egui::Event::PointerMoved(pos)]);
        frame(vec![press(true)]);
        assert_eq!(frame(vec![press(false)]), ["msn join general\nmsn listen"]);
        // Away from the block, Copied still shows for a moment.
        frame(vec![egui::Event::PointerMoved(egui::pos2(590.0, 290.0))]);
        assert!(
            ctx.read_response(id).is_some(),
            "Copied stays while it reads"
        );
    }

    #[test]
    fn hostile_inputs_never_link_anything_but_http_or_https() {
        for input in [
            "[x](javascript:alert(1))",
            "[x](data:text/html,<script>alert(1)</script>)",
            "[x](//evil.example)",
            "[x](file:///etc/passwd)",
            "<javascript:alert(1)>",
            "![x](vbscript:x)",
            "[x](https://ok.example\" onmouseover=\"x)",
            "> - [x](JAVASCRIPT:x)",
        ] {
            let mut found = Vec::new();
            links(&parse(input), &mut found);
            for href in found {
                assert!(
                    safe_href(&href).is_some() && href.to_lowercase().starts_with("http"),
                    "{input} -> {href}"
                );
            }
        }
        for bad in [
            "javascript:alert(1)",
            "data:,x",
            "https://",
            "https:///x",
            "https://a b",
        ] {
            assert_eq!(safe_href(bad), None, "{bad}");
        }
    }

    #[test]
    fn plain_text_keeps_the_single_label_path() {
        let plain = |text: &str| plain_text(&parse(text));
        assert_eq!(
            plain("Deploy done (see #41) - all good.\nSecond line").as_deref(),
            Some("Deploy done (see #41) - all good.\nSecond line")
        );
        assert_eq!(plain("").as_deref(), Some(""));
        assert_eq!(plain("a\n\n\nb").as_deref(), Some("a\n\n\nb"));
        // Escapes resolve the same way as on web and iOS.
        assert_eq!(
            plain(r"a\*b and \\server\share").as_deref(),
            Some(r"a*b and \\server\share")
        );
        assert_eq!(plain("**bold**"), None);
        assert_eq!(plain("a\n\n- b"), None);
        let first = parse_cached("**cached**");
        assert!(std::rc::Rc::ptr_eq(&first, &parse_cached("**cached**")));
    }

    #[test]
    fn mixed_emphasis_delimiters_stay_fast() {
        let patterns = [
            "*_", "_*", ".*_", "*_ ", "**__", "*_~~", "(*_)", "*.", "_**", "[a](", "[x]",
        ];
        for p in patterns {
            let input = p.repeat(16384 / p.len());
            let started = std::time::Instant::now();
            parse(&input);
            // Debug builds are several times slower than release; this is still linear-time.
            assert!(
                started.elapsed() < std::time::Duration::from_millis(250),
                "{p:?} took {:?}",
                started.elapsed()
            );
        }
    }

    #[test]
    fn hostile_sixteen_kib_inputs_are_fast_and_shallow() {
        let size = 16 * 1024;
        for input in [
            "*a ".repeat(size / 3),
            "[".repeat(size),
            format!("{})", "[a](".repeat(size / 4)),
            format!("{}{}", "**a ".repeat(size / 8), " a**".repeat(size / 8)),
            "> ".repeat(size / 2),
            "- ".repeat(size / 2),
            "https://a.b/".repeat(size / 12),
        ] {
            let started = std::time::Instant::now();
            let blocks = parse(&input);
            assert!(
                started.elapsed() < std::time::Duration::from_secs(2),
                "{:?} took {:?}",
                &input[..12],
                started.elapsed()
            );
            for block in &blocks {
                if let Block::Paragraph { children } = block {
                    assert!(inline_height(children) <= MAX_INLINE_DEPTH);
                }
            }
        }
    }
    /// Clicking a link opens it; the paragraph is one label, so its text stays selectable.
    #[test]
    fn a_click_on_a_link_opens_it_and_plain_words_do_not() {
        let blocks = parse("see [docs](https://example.com/docs) now");
        let ctx = egui::Context::default();
        let screen = egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(600.0, 200.0));
        let frame = |events: Vec<egui::Event>| {
            let mut output = ctx.run_ui(
                egui::RawInput {
                    screen_rect: Some(screen),
                    events,
                    ..Default::default()
                },
                |ui| show(ui, &blocks),
            );
            output.textures_delta.clear();
            output
        };
        let first = frame(Vec::new());
        let (origin, galley) = first
            .shapes
            .iter()
            .find_map(|clipped| match &clipped.shape {
                egui::Shape::Text(text) => Some((text.pos, text.galley.clone())),
                _ => None,
            })
            .expect("one text shape");
        assert_eq!(galley.job.text, "see docs now");
        let point = |c: usize| {
            let rect = galley.pos_from_cursor(egui::text::CCursor::new(c));
            origin + egui::vec2(rect.min.x + 2.0, rect.center().y)
        };
        let click = |at: egui::Pos2| {
            frame(vec![egui::Event::PointerMoved(at)]);
            frame(vec![egui::Event::PointerButton {
                pos: at,
                button: egui::PointerButton::Primary,
                pressed: true,
                modifiers: Default::default(),
            }]);
            frame(vec![egui::Event::PointerButton {
                pos: at,
                button: egui::PointerButton::Primary,
                pressed: false,
                modifiers: Default::default(),
            }])
            .platform_output
            .commands
            .into_iter()
            .filter_map(|command| match command {
                egui::OutputCommand::OpenUrl(open) => Some(open.url),
                _ => None,
            })
            .collect::<Vec<_>>()
        };
        assert_eq!(
            click(point(5)),
            vec!["https://example.com/docs".to_string()]
        );
        assert!(click(point(1)).is_empty(), "plain words are not a link");
    }
}
