// Markdown transcript of a board (ADR 0048).
//
// renderTranscript() turns message rows, exactly as GET …/messages returns them, into one
// Markdown document a person can read, share or hand to an agent. The CLI builds the same
// document in cli/src/transcript.rs; tests/fixtures/transcript-cases.json is the shared contract,
// so change the two together.
//
// Message text is untrusted. It goes inside a fenced code block whose fence is longer than any
// run of backticks in the text, so nothing in a message can close the block, start a heading,
// inject HTML or otherwise change the transcript around it. Every other value that comes from
// the board (names, labels, file names) is written as escaped inline text on a line that starts
// with fixed text, so it cannot start a block either.

import { addressees } from "./address.js";

/**
 * ASCII punctuation that can start inline markup (CommonMark, GFM tables, GitHub math), plus `:`
 * and `@`, which GFM autolinks (`https://…`, `a@b.c`). `www.` is handled in inline().
 */
const MARKUP = new Set([
  "\\",
  "`",
  "*",
  "_",
  "[",
  "]",
  "(",
  ")",
  "<",
  ">",
  "&",
  "!",
  "~",
  "|",
  "#",
  "$",
  ":",
  "@",
]);

/**
 * True for characters that must not appear raw in an inline value: controls, bidi controls and
 * invisible characters (zero-width, soft hyphen, word joiners, tag characters) that can hide text
 * from a person reading the transcript while an agent still reads it.
 */
function unsafeCode(n) {
  return (
    n < 0x20 ||
    (n >= 0x7f && n <= 0x9f) ||
    n === 0xad ||
    n === 0x61c ||
    n === 0x180e ||
    (n >= 0x200b && n <= 0x200f) ||
    n === 0x2028 ||
    n === 0x2029 ||
    (n >= 0x202a && n <= 0x202e) ||
    (n >= 0x2060 && n <= 0x2064) ||
    (n >= 0x2066 && n <= 0x206f) ||
    n === 0xfeff ||
    (n >= 0xe0000 && n <= 0xe007f)
  );
}

/** One line of escaped inline text: markup characters get a backslash, controls become U+FFFD. */
export function inline(value) {
  let out = "";
  for (const char of String(value ?? "")) {
    const code = char.codePointAt(0);
    if (unsafeCode(code)) out += "\uFFFD";
    // A `.` after `www` would let GFM autolink `www.example.com`.
    else if (MARKUP.has(char) || (char === "." && /www$/i.test(out))) out += `\\${char}`;
    else out += char;
  }
  return out;
}

/** `2026-11-20T17:04:05.123Z` → `2026-11-20 17:04:05 UTC`; anything else is shown escaped. */
export function utc(iso) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z$/.exec(String(iso));
  return match ? `${match[1]} ${match[2]} UTC` : inline(iso);
}

/** Byte size with one decimal, computed in integers so the CLI prints exactly the same. */
export function size(bytes) {
  const n = Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0;
  if (n < 1024) return `${n} B`;
  const unit = n < 1024 * 1024 ? 1024 : 1024 * 1024;
  const tenths = Math.floor((n * 10 + unit / 2) / unit);
  return `${Math.floor(tenths / 10)}.${tenths % 10} ${unit === 1024 ? "KiB" : "MiB"}`;
}

/** A fenced block that no line of `text` can close. Line endings become `\n`. */
export function fence(text, info) {
  const body = String(text).replace(/\r\n?/g, "\n");
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const marks = "`".repeat(Math.max(3, longest + 1));
  return `${marks}${info}\n${body}${body === "" || body.endsWith("\n") ? "" : "\n"}${marks}`;
}

/**
 * meta: { origin, tenant, channel, exportedAt, after }. `after` is the exclusive lower bound the
 * export started from (0 for the whole board). messages: rows in ascending id order.
 */
export function renderTranscript(meta, messages) {
  const { origin, tenant, channel, exportedAt, after = 0 } = meta;
  const out = [`# Transcript of #${inline(channel)}`, ""];
  out.push(`- Workspace: ${inline(tenant)}`);
  out.push(`- Board: ${inline(channel)}`);
  if (after > 0) out.push(`- Starts after message #${after}`);
  out.push(
    messages.length
      ? `- Messages: ${messages.length}, #${messages[0].id} to #${messages[messages.length - 1].id}`
      : "- Messages: none",
  );
  out.push(`- Exported: ${utc(exportedAt)}`);
  out.push("");
  out.push(
    "Times are UTC. Each message's text is shown exactly as its sender last wrote it, inside a code block.",
  );
  const shown = new Set();
  for (const message of messages) {
    out.push("", "---", "");
    out.push(`<a id="msg-${message.id}"></a>`);
    // The times come before the sender, so a sender name cannot fake them. An edited message
    // (ADR 0052) says when its text last changed.
    const edited = typeof message.editedAt === "string" ? ` (edited ${utc(message.editedAt)})` : "";
    out.push(`### #${message.id} · ${utc(message.createdAt)}${edited} · ${inline(message.username)}`);
    const details = [];
    if (Number.isSafeInteger(message.replyTo)) {
      const target = shown.has(message.replyTo)
        ? `#msg-${message.replyTo}`
        : `${origin}/#board=${tenant}/${channel}&msg=${message.replyTo}`;
      details.push(`- Reply to: [#${message.replyTo}](${target})`);
    }
    const to = addressees(message);
    if (to.length) details.push(`- To: ${to.map(inline).join(", ")}`);
    // A question (ADR 0065) lists its choices; an answer names the choice it picked.
    if (Array.isArray(message.choices) && message.choices.length)
      details.push(`- Choices: ${message.choices.map(inline).join("; ")}`);
    if (typeof message.answer === "string") details.push(`- Answer: ${inline(message.answer)}`);
    const labels = Object.entries(message.labels ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (labels.length)
      details.push(`- Labels: ${labels.map(([key, value]) => `${inline(key)}=${inline(value)}`).join(", ")}`);
    const files = [...(message.attachments ?? [])].sort((a, b) => a.index - b.index);
    if (files.length)
      details.push(
        `- Attachments: ${files.map((file) => `${inline(file.name)} (${size(file.bytes)}, ${inline(file.mediaType)})`).join("; ")}`,
      );
    if (details.length) out.push("", ...details);
    // A quote (ADR 0059) is the part of the replyTo message this reply answers, kept verbatim too.
    if (typeof message.quote === "string")
      out.push(
        "",
        fence(message.quote, "text")
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n"),
      );
    out.push("", fence(message.text ?? "", message.contentType === "application/json" ? "json" : "text"));
    shown.add(message.id);
  }
  if (!messages.length) out.push("", "_No messages._");
  return `${out.join("\n")}\n`;
}
