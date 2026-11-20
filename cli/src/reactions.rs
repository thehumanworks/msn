//! Message reactions (ADR 0047): a fixed set of four kinds, one of each per name per message.

use crate::error::CliError;
use serde_json::{Value, json};

/// The kinds the server accepts, in display order: ✓ done, 👀 seen, 👍 yes, ✗ no.
pub const KINDS: [&str; 4] = ["done", "seen", "yes", "no"];

/// Accepts a kind name or a common alias (check, eyes, +1, x and their symbols).
pub fn parse_kind(raw: &str) -> Result<&'static str, CliError> {
    let kind = match raw.trim().to_ascii_lowercase().as_str() {
        "done" | "check" | "✓" | "✔" | "✅" => "done",
        "seen" | "eyes" | "👀" => "seen",
        "yes" | "+1" | "thumbsup" | "👍" => "yes",
        "no" | "x" | "cross" | "✗" | "❌" => "no",
        _ => {
            return Err(CliError::usage(format!(
                "Unknown reaction {raw:?}; use one of {}.",
                KINDS.join(", ")
            )));
        }
    };
    Ok(kind)
}

/// Body of POST …/messages/{id}/reactions.
pub fn body(username: &str, kind: &str, remove: bool) -> Value {
    if remove {
        json!({ "username": username, "kind": kind, "remove": true })
    } else {
        json!({ "username": username, "kind": kind })
    }
}

#[cfg(test)]
mod tests {
    use super::{body, parse_kind};
    use serde_json::json;

    #[test]
    fn kinds_and_aliases_map_to_the_four_server_kinds() {
        for (raw, kind) in [
            ("done", "done"),
            ("✓", "done"),
            ("Check", "done"),
            ("eyes", "seen"),
            ("👀", "seen"),
            ("+1", "yes"),
            ("👍", "yes"),
            ("x", "no"),
            ("cross", "no"),
        ] {
            assert_eq!(parse_kind(raw).unwrap(), kind);
        }
        assert!(parse_kind("heart").is_err());
        assert!(parse_kind("").is_err());
    }

    #[test]
    fn body_names_the_sender_and_only_says_remove_when_removing() {
        assert_eq!(
            body("lead", "done", false),
            json!({"username":"lead","kind":"done"})
        );
        assert_eq!(
            body("lead", "no", true),
            json!({"username":"lead","kind":"no","remove":true})
        );
    }
}
