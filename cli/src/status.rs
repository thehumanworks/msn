//! Agent status (ADR 0064): one short line a name sets to say what it is doing on a board.
//! It is only what the agent said; nothing is inferred, and it stays until changed or cleared.

use crate::error::CliError;
use serde_json::{Value, json};

/// Longest status, in Unicode characters (code points), as the server counts it.
pub const MAX_STATUS_CHARS: usize = 80;

/// Trims and checks a status text the way the server does, so mistakes fail before a request.
pub fn parse_text(raw: &str) -> Result<String, CliError> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(CliError::usage(
            "A status must not be blank; use --clear to remove it.",
        ));
    }
    if text.chars().any(char::is_control) {
        return Err(CliError::usage(
            "A status is one line: no newlines, tabs or control characters.",
        ));
    }
    if text.chars().count() > MAX_STATUS_CHARS {
        return Err(CliError::usage(format!(
            "A status is at most {MAX_STATUS_CHARS} characters."
        )));
    }
    Ok(text.to_owned())
}

/// PUT …/channels/{channel}/status sets or (with no text) clears one name's status.
pub fn set_path(tenant: &str, channel: &str) -> String {
    format!("/api/tenants/{tenant}/channels/{channel}/status")
}

/// GET …/channels/{channel}/statuses lists every name's status on the board.
pub fn list_path(tenant: &str, channel: &str) -> String {
    format!("/api/tenants/{tenant}/channels/{channel}/statuses")
}

/// Body of PUT …/status: `text: null` clears.
pub fn body(username: &str, text: Option<&str>) -> Value {
    json!({ "username": username, "text": text })
}

#[cfg(test)]
mod tests {
    use super::{body, list_path, parse_text, set_path};
    use serde_json::json;

    #[test]
    fn text_is_trimmed_one_line_and_at_most_80_characters() {
        assert_eq!(
            parse_text("  running tests on PR 54 ").unwrap(),
            "running tests on PR 54"
        );
        assert_eq!(parse_text(&"é".repeat(80)).unwrap(), "é".repeat(80));
        for bad in ["", "   ", "two\nlines", "tab\there"] {
            assert!(parse_text(bad).is_err(), "{bad:?}");
        }
        assert!(parse_text(&"x".repeat(81)).is_err());
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
