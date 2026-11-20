//! Markdown transcript of a board (ADR 0048).
//!
//! `render` turns message rows, exactly as `GET …/messages` returns them, into one Markdown
//! document. The web app builds the same document in `public/transcript.js`;
//! `tests/fixtures/transcript-cases.json` is the shared contract, so change the two together.
//!
//! Message text is untrusted. It goes inside a fenced code block whose fence is longer than any
//! run of backticks in the text, so nothing in a message can close the block, start a heading,
//! inject HTML or otherwise change the transcript around it. Every other value that comes from
//! the board (names, labels, file names) is written as escaped inline text on a line that starts
//! with fixed text, so it cannot start a block either.

use std::collections::HashSet;

use serde_json::Value;

/// What the transcript header names, besides the messages.
pub struct TranscriptMeta<'a> {
    /// `scheme://host[:port]` without a trailing slash, as in message links (ADR 0042).
    pub origin: &'a str,
    pub tenant: &'a str,
    pub channel: &'a str,
    /// RFC 3339 UTC instant, `YYYY-MM-DDTHH:MM:SS.sssZ`.
    pub exported_at: &'a str,
    /// Exclusive lower bound the export started from; 0 for the whole board.
    pub after: u64,
}

const MARKUP: &[char] = &[
    '\\', '`', '*', '_', '[', ']', '(', ')', '<', '>', '&', '!', '~', '|', '#', '$', ':', '@',
];

/// Controls, bidi controls and invisible characters (zero-width, soft hyphen, word joiners, tag
/// characters) that can hide text from a person reading the transcript while an agent still reads it.
fn unsafe_char(c: char) -> bool {
    let n = c as u32;
    n < 0x20
        || (0x7f..=0x9f).contains(&n)
        || n == 0xad
        || n == 0x61c
        || n == 0x180e
        || (0x200b..=0x200f).contains(&n)
        || n == 0x2028
        || n == 0x2029
        || (0x202a..=0x202e).contains(&n)
        || (0x2060..=0x2064).contains(&n)
        || (0x2066..=0x206f).contains(&n)
        || n == 0xfeff
        || (0xe0000..=0xe007f).contains(&n)
}

fn ends_with_www(out: &str) -> bool {
    out.len() >= 3
        && out.is_char_boundary(out.len() - 3)
        && out[out.len() - 3..].eq_ignore_ascii_case("www")
}

/// One line of escaped inline text: markup characters get a backslash, controls become U+FFFD.
pub fn inline(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if unsafe_char(c) {
            out.push('\u{FFFD}');
        } else {
            // `:` and `@` stop GFM autolinks; a `.` after `www` stops `www.` autolinks.
            if MARKUP.contains(&c) || (c == '.' && ends_with_www(&out)) {
                out.push('\\');
            }
            out.push(c);
        }
    }
    out
}

/// `2026-11-20T17:04:05.123Z` → `2026-11-20 17:04:05 UTC`; anything else is shown escaped.
pub fn utc(iso: &str) -> String {
    let b = iso.as_bytes();
    let digits = |range: std::ops::Range<usize>| b[range].iter().all(u8::is_ascii_digit);
    let shape = b.len() >= 20
        && digits(0..4)
        && b[4] == b'-'
        && digits(5..7)
        && b[7] == b'-'
        && digits(8..10)
        && b[10] == b'T'
        && digits(11..13)
        && b[13] == b':'
        && digits(14..16)
        && b[16] == b':'
        && digits(17..19)
        && b[b.len() - 1] == b'Z';
    let fraction = shape
        && (b.len() == 20
            || (b[19] == b'.' && (22..=30).contains(&b.len()) && digits(20..b.len() - 1)));
    if fraction {
        format!("{} {} UTC", &iso[0..10], &iso[11..19])
    } else {
        inline(iso)
    }
}

/// Byte size with one decimal, computed in integers so the web prints exactly the same.
pub fn size(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let (unit, name) = if bytes < 1024 * 1024 {
        (1024u128, "KiB")
    } else {
        (1024u128 * 1024, "MiB")
    };
    let tenths = (u128::from(bytes) * 10 + unit / 2) / unit;
    format!("{}.{} {name}", tenths / 10, tenths % 10)
}

/// A fenced block that no line of `text` can close. Line endings become `\n`.
pub fn fence(text: &str, info: &str) -> String {
    let body = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut longest = 0;
    let mut run = 0;
    for c in body.chars() {
        if c == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let marks = "`".repeat(longest.max(2) + 1);
    let newline = if body.is_empty() || body.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    format!("{marks}{info}\n{body}{newline}{marks}")
}

/// The whole transcript. `messages` are rows in ascending id order.
pub fn render(meta: &TranscriptMeta, messages: &[Value]) -> String {
    let id_of = |m: &Value| m["id"].as_u64().unwrap_or(0);
    let mut out: Vec<String> = vec![
        format!("# Transcript of #{}", inline(meta.channel)),
        String::new(),
        format!("- Workspace: {}", inline(meta.tenant)),
        format!("- Board: {}", inline(meta.channel)),
    ];
    if meta.after > 0 {
        out.push(format!("- Starts after message #{}", meta.after));
    }
    match (messages.first(), messages.last()) {
        (Some(first), Some(last)) => out.push(format!(
            "- Messages: {}, #{} to #{}",
            messages.len(),
            id_of(first),
            id_of(last)
        )),
        _ => out.push("- Messages: none".to_string()),
    }
    out.push(format!("- Exported: {}", utc(meta.exported_at)));
    out.push(String::new());
    out.push(
        "Times are UTC. Each message's text is shown exactly as it was sent, inside a code block."
            .to_string(),
    );
    let mut shown = HashSet::new();
    for message in messages {
        let id = id_of(message);
        out.extend(["".into(), "---".into(), "".into()]);
        out.push(format!("<a id=\"msg-{id}\"></a>"));
        // The time comes before the sender, so a sender name cannot fake it.
        out.push(format!(
            "### #{id} · {} · {}",
            utc(message["createdAt"].as_str().unwrap_or("")),
            inline(message["username"].as_str().unwrap_or(""))
        ));
        let mut details = Vec::new();
        if let Some(parent) = message.get("replyTo").and_then(Value::as_u64) {
            let target = if shown.contains(&parent) {
                format!("#msg-{parent}")
            } else {
                format!(
                    "{}/#board={}/{}&msg={parent}",
                    meta.origin, meta.tenant, meta.channel
                )
            };
            details.push(format!("- Reply to: [#{parent}]({target})"));
        }
        if let Some(to) = message.get("to").and_then(Value::as_str) {
            details.push(format!("- To: {}", inline(to)));
        }
        if let Some(labels) = message.get("labels").and_then(Value::as_object) {
            let mut pairs: Vec<(&String, &Value)> = labels.iter().collect();
            pairs.sort_by(|a, b| a.0.cmp(b.0));
            if !pairs.is_empty() {
                let shown_labels: Vec<String> = pairs
                    .iter()
                    .map(|(key, value)| {
                        format!("{}={}", inline(key), inline(value.as_str().unwrap_or("")))
                    })
                    .collect();
                details.push(format!("- Labels: {}", shown_labels.join(", ")));
            }
        }
        if let Some(files) = message.get("attachments").and_then(Value::as_array) {
            let mut files: Vec<&Value> = files.iter().collect();
            files.sort_by_key(|file| file["index"].as_u64().unwrap_or(0));
            if !files.is_empty() {
                let shown_files: Vec<String> = files
                    .iter()
                    .map(|file| {
                        format!(
                            "{} ({}, {})",
                            inline(file["name"].as_str().unwrap_or("")),
                            size(file["bytes"].as_u64().unwrap_or(0)),
                            inline(file["mediaType"].as_str().unwrap_or(""))
                        )
                    })
                    .collect();
                details.push(format!("- Attachments: {}", shown_files.join("; ")));
            }
        }
        if !details.is_empty() {
            out.push(String::new());
            out.extend(details);
        }
        let info = if message["contentType"].as_str() == Some("application/json") {
            "json"
        } else {
            "text"
        };
        out.push(String::new());
        out.push(fence(message["text"].as_str().unwrap_or(""), info));
        shown.insert(id);
    }
    if messages.is_empty() {
        out.push(String::new());
        out.push("_No messages._".to_string());
    }
    let mut text = out.join("\n");
    text.push('\n');
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared contract with `public/transcript.js`.
    #[test]
    fn fixture_cases_match() {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/fixtures/transcript-cases.json"
        ));
        let cases: Vec<Value> = serde_json::from_str(raw).expect("fixture is JSON");
        assert!(!cases.is_empty());
        for case in cases {
            let meta = &case["meta"];
            let rendered = render(
                &TranscriptMeta {
                    origin: meta["origin"].as_str().unwrap(),
                    tenant: meta["tenant"].as_str().unwrap(),
                    channel: meta["channel"].as_str().unwrap(),
                    exported_at: meta["exportedAt"].as_str().unwrap(),
                    after: meta["after"].as_u64().unwrap_or(0),
                },
                case["messages"].as_array().unwrap(),
            );
            assert_eq!(
                rendered,
                case["expected"].as_str().unwrap(),
                "case {}",
                case["name"]
            );
        }
    }

    #[test]
    fn fence_outlasts_backtick_runs() {
        assert_eq!(fence("a", "text"), "```text\na\n```");
        assert_eq!(
            fence("x ``` y\n````", "text"),
            "`````text\nx ``` y\n````\n`````"
        );
        assert_eq!(fence("", "text"), "```text\n```");
        assert_eq!(fence("a\r\nb\rc", "text"), "```text\na\nb\nc\n```");
    }

    #[test]
    fn sizes_round_in_integers() {
        assert_eq!(size(0), "0 B");
        assert_eq!(size(1023), "1023 B");
        assert_eq!(size(1024), "1.0 KiB");
        assert_eq!(size(1280), "1.3 KiB");
        assert_eq!(size(1024 * 1024), "1.0 MiB");
    }

    #[test]
    fn utc_accepts_only_iso_instants() {
        assert_eq!(utc("2026-11-20T17:04:05.123Z"), "2026-11-20 17:04:05 UTC");
        assert_eq!(utc("2026-11-20T17:04:05Z"), "2026-11-20 17:04:05 UTC");
        assert_eq!(utc("not <a> date"), "not \\<a\\> date");
        assert_eq!(utc("2026-11-20T17:04:05.Z"), "2026-11-20T17\\:04\\:05.Z");
    }

    #[test]
    fn inline_blocks_autolinks_and_hidden_text() {
        assert_eq!(inline("https://a.b"), "https\\://a.b");
        assert_eq!(inline("a@b.c"), "a\\@b.c");
        assert_eq!(inline("see www.x.y"), "see www\\.x.y");
        assert_eq!(
            inline("a\u{ad}b\u{E0041}c\u{2060}d"),
            "a\u{FFFD}b\u{FFFD}c\u{FFFD}d"
        );
    }
}
