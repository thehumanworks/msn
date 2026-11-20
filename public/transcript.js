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

/** ASCII punctuation that can start inline markup (CommonMark, GFM tables, GitHub math). */
const MARKUP = new Set(["\\", "`", "*", "_", "[", "]", "(", ")", "<", ">", "&", "!", "~", "|", "#", "$"]);

/** True for characters that must not appear raw in an inline value: controls, bidi and zero-width. */
function unsafeCode(n) {
  return (
    n < 0x20 ||
    (n >= 0x7f && n <= 0x9f) ||
    (n >= 0x200b && n <= 0x200f) ||
    n === 0x2028 ||
    n === 0x2029 ||
    (n >= 0x202a && n <= 0x202e) ||
    (n >= 0x2066 && n <= 0x2069) ||
    n === 0xfeff
  );
}

/** One line of escaped inline text: markup characters get a backslash, controls become U+FFFD. */
export function inline(value) {
  let out = "";
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    if (unsafeCode(code)) out += "�";
    else if (MARKUP.has(char)) out += `\\${char}`;
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
  out.push("Times are UTC. Each message's text is shown exactly as it was sent, inside a code block.");
  const shown = new Set();
  for (const message of messages) {
    out.push("", "---", "");
    out.push(`<a id="msg-${message.id}"></a>`);
    out.push(`### #${message.id} · ${inline(message.username)} · ${utc(message.createdAt)}`);
    const details = [];
    if (Number.isSafeInteger(message.replyTo)) {
      const target = shown.has(message.replyTo)
        ? `#msg-${message.replyTo}`
        : `${origin}/#board=${tenant}/${channel}&msg=${message.replyTo}`;
      details.push(`- Reply to: [#${message.replyTo}](${target})`);
    }
    if (typeof message.to === "string") details.push(`- To: ${inline(message.to)}`);
    const labels = Object.entries(message.labels ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (labels.length)
      details.push(`- Labels: ${labels.map(([key, value]) => `${inline(key)}=${inline(value)}`).join(", ")}`);
    const files = [...(message.attachments ?? [])].sort((a, b) => a.index - b.index);
    if (files.length)
      details.push(
        `- Attachments: ${files.map((file) => `${inline(file.name)} (${size(file.bytes)}, ${inline(file.mediaType)})`).join("; ")}`,
      );
    if (details.length) out.push("", ...details);
    out.push("", fence(message.text, message.contentType === "application/json" ? "json" : "text"));
    shown.add(message.id);
  }
  if (!messages.length) out.push("", "_No messages._");
  return `${out.join("\n")}\n`;
}
