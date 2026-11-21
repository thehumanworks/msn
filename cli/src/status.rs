//! Agent status (ADR 0064): one short line a name sets to say what it is doing on a board.
//! It is only what the agent said; nothing is inferred, and it stays until changed or cleared.

use crate::error::CliError;
use serde_json::{Value, json};

/// Longest status, in Unicode characters (code points), as the server counts it.
pub const MAX_STATUS_CHARS: usize = 80;

/// Trims and checks a status text the way the server does, so mistakes fail before a request.
pub fn parse_text(raw: &str) -> Result<String, CliError> {
    // Trim what the server's String.prototype.trim does: Unicode whitespace and U+FEFF.
    let text = raw.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if text.is_empty() {
        return Err(CliError::usage(
            "A status must not be blank; use --clear to remove it.",
        ));
    }
    if text.chars().any(forbidden) {
        return Err(CliError::usage(
            "A status is one line of plain text: no newlines, tabs, control, direction or invisible characters.",
        ));
    }
    if text.chars().count() > MAX_STATUS_CHARS {
        return Err(CliError::usage(format!(
            "A status is at most {MAX_STATUS_CHARS} characters."
        )));
    }
    Ok(text.to_owned())
}

/// The characters the server refuses in a status: controls, line and paragraph separators,
/// direction marks, embeddings, overrides and isolates, and invisible ones. Zero-width joiner and
/// non-joiner stay allowed for emoji sequences and scripts that need them.
fn forbidden(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{2028}'
                | '\u{2029}'
                | '\u{061c}'
                | '\u{200e}'
                | '\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2066}'..='\u{2069}'
                | '\u{200b}'
                | '\u{2060}'
                | '\u{feff}'
        )
}

/// PUT …/channels/{channel}/status sets or (with no text) clears one name's status.
pub fn set_path(tenant: &str, channel: &str) -> String {
    format!("/api/tenants/{tenant}/channels/{channel}/status")
}

/// GET …/channels/{channel}/statuses lists every name's status on the board.
pub fn list_path(tenant: &str, channel: &str) -> String {
    format!("/api/tenants/{tenant}/channels/{channel}/statuses")
}

/// One name's status as `GET …/statuses` lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub name: String,
    pub text: String,
    /// ISO time the status was set.
    pub set_at: String,
}

/// Reads `{statuses:[{name,text,setAt}]}`, newest first as the server sends it. Rows that are
/// not well formed are skipped, and at most 200 are kept (the per-board cap).
pub fn parse_list(value: &Value) -> Vec<Status> {
    value["statuses"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some(Status {
                        name: row["name"].as_str()?.to_owned(),
                        text: row["text"].as_str()?.to_owned(),
                        set_at: row["setAt"].as_str()?.to_owned(),
                    })
                })
                .take(200)
                .collect()
        })
        .unwrap_or_default()
}

/// Seconds since the Unix epoch for `YYYY-MM-DDTHH:MM:SS(.fff)Z`; `None` for anything else.
pub fn unix_seconds(iso: &str) -> Option<i64> {
    let b = iso.as_bytes();
    if b.len() < 20 || b[b.len() - 1] != b'Z' || b[10] != b'T' {
        return None;
    }
    let num = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = iso.get(range)?;
        part.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| part.parse().ok())?
    };
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hh, mm, ss) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Days from civil (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

/// "just now", "3 min ago", "2 h ago" or "4 d ago", as the web app words it; the UTC time when
/// `set_at` is not a time this can read.
pub fn ago(set_at: &str, now: i64) -> String {
    let Some(then) = unix_seconds(set_at) else {
        return crate::transcript::utc(set_at);
    };
    let seconds = (now - then).max(0);
    match seconds {
        s if s >= 86_400 => format!("{} d ago", s / 86_400),
        s if s >= 3600 => format!("{} h ago", s / 3600),
        s if s >= 60 => format!("{} min ago", s / 60),
        _ => "just now".into(),
    }
}

/// Body of PUT …/status: `text: null` clears.
pub fn body(username: &str, text: Option<&str>) -> Value {
    json!({ "username": username, "text": text })
}

#[cfg(test)]
mod tests {
    use super::{Status, ago, body, list_path, parse_list, parse_text, set_path, unix_seconds};
    use serde_json::json;

    #[test]
    fn text_is_trimmed_one_line_and_at_most_80_characters() {
        assert_eq!(
            parse_text("  running tests on PR 54 ").unwrap(),
            "running tests on PR 54"
        );
        assert_eq!(parse_text(&"é".repeat(80)).unwrap(), "é".repeat(80));
        assert_eq!(parse_text("\u{feff} ok \u{feff}").unwrap(), "ok");
        assert_eq!(
            parse_text("👨\u{200d}💻 coding").unwrap(),
            "👨\u{200d}💻 coding"
        );
        for bad in [
            "",
            "   ",
            "two\nlines",
            "tab\there",
            "a\u{2028}b",
            "a\u{2029}b",
            "evil\u{202e}txt",
            "iso\u{2066}late",
            "zero\u{200b}width",
            "mid\u{feff}bom",
        ] {
            assert!(parse_text(bad).is_err(), "{bad:?}");
        }
        assert!(parse_text(&"x".repeat(81)).is_err());
    }

    #[test]
    fn parse_list_keeps_well_formed_rows_in_order() {
        let value = json!({"statuses": [
            {"name": "lead", "text": "merging", "setAt": "2026-11-21T02:00:00Z", "seq": 3},
            {"name": "dev", "text": 5, "setAt": "2026-11-21T01:00:00Z"},
            {"name": "ops", "text": "deploying", "setAt": "2026-11-21T00:00:00Z"}
        ]});
        assert_eq!(
            parse_list(&value),
            vec![
                Status {
                    name: "lead".into(),
                    text: "merging".into(),
                    set_at: "2026-11-21T02:00:00Z".into()
                },
                Status {
                    name: "ops".into(),
                    text: "deploying".into(),
                    set_at: "2026-11-21T00:00:00Z".into()
                },
            ]
        );
        assert!(parse_list(&json!({})).is_empty());
    }

    #[test]
    fn ages_read_like_the_web_app() {
        assert_eq!(unix_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            unix_seconds("2026-11-21T02:00:00.123Z"),
            Some(1_795_226_400)
        );
        assert_eq!(unix_seconds("2026-11-21 02:00:00"), None);
        let at = "2026-11-21T02:00:00Z";
        let now = 1_795_226_400;
        assert_eq!(ago(at, now + 30), "just now");
        assert_eq!(ago(at, now - 30), "just now");
        assert_eq!(ago(at, now + 180), "3 min ago");
        assert_eq!(ago(at, now + 7300), "2 h ago");
        assert_eq!(ago(at, now + 3 * 86_400), "3 d ago");
        assert_eq!(ago("soon", now), "soon");
    }

    #[test]
    fn paths_and_body_match_the_api() {
        assert_eq!(set_path("t", "c"), "/api/tenants/t/channels/c/status");
        assert_eq!(list_path("t", "c"), "/api/tenants/t/channels/c/statuses");
        assert_eq!(
            body("lead", Some("on it")),
            json!({"username":"lead","text":"on it"})
        );
        assert_eq!(body("lead", None), json!({"username":"lead","text":null}));
    }
}
