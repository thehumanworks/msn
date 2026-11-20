//! Processed-by receipts (ADR 0040): which readers have explicitly committed past a message.
//!
//! The server reads them only from resumable processing cursors (ADR 0034), so a receipt proves
//! exactly one thing: that reader ran `msn commit --resumable` (or the MCP `commit` tool with
//! MSN_RESUMABLE=1) through this message or later. "Not yet" means no such commit covers it. It
//! does not mean the agent has not seen the message, and local-only commits are not visible.

use serde::Deserialize;
use serde_json::Value;

use crate::error::CliError;

/// What a receipt proves, for help text, tooltips and empty states in every client.
pub const MEANING: &str = "Processed means the reader explicitly committed past this message with a resumable commit (msn commit --resumable). Not yet means no such commit covers it; it does not mean the reader has not seen it. Local-only commits are not shown.";

/// One reader's explicit commit position. `committed_through` is `None` for a board persona
/// that has never committed a resumable cursor on this channel.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub name: String,
    pub reader: Option<String>,
    pub persona_id: Option<String>,
    pub committed_through: Option<u64>,
    pub updated_at: Option<String>,
}

impl Receipt {
    /// True only when an explicit commit covers `message_id`.
    pub fn processed(&self, message_id: u64) -> bool {
        self.committed_through
            .is_some_and(|through| through >= message_id)
    }
}

/// GET path for one message's split into processed and not yet.
pub fn message_path(tenant: &str, channel: &str, message_id: u64) -> String {
    format!("/api/tenants/{tenant}/channels/{channel}/messages/{message_id}/receipts")
}

/// GET path for every reader's position on a channel, for clients that label many messages.
pub fn channel_path(tenant: &str, channel: &str) -> String {
    format!("/api/tenants/{tenant}/channels/{channel}/receipts")
}

/// Parses `GET …/receipts` and checks it answers for the asked channel.
pub fn parse_channel(value: &Value, channel: &str) -> Result<Vec<Receipt>, CliError> {
    let invalid = || CliError::generic("Receipts response did not match this channel.");
    if value["channel"].as_str() != Some(channel) {
        return Err(invalid());
    }
    serde_json::from_value(value["receipts"].clone()).map_err(|_| invalid())
}

/// One compact line for a message, such as `Processed by lead · not yet: worker`, or `None` when
/// the channel has no personas and no committed readers (nothing to say).
pub fn summary(receipts: &[Receipt], message_id: u64) -> Option<String> {
    if receipts.is_empty() {
        return None;
    }
    let (done, waiting): (Vec<&Receipt>, Vec<&Receipt>) =
        receipts.iter().partition(|r| r.processed(message_id));
    let names = |list: &[&Receipt]| {
        list.iter()
            .map(|r| r.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };
    Some(match (done.is_empty(), waiting.is_empty()) {
        (false, true) => format!("Processed by {}", names(&done)),
        (true, false) => format!("Not yet processed by {}", names(&waiting)),
        _ => format!(
            "Processed by {} \u{b7} not yet: {}",
            names(&done),
            names(&waiting)
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn receipt(name: &str, through: Option<u64>) -> Receipt {
        Receipt {
            name: name.into(),
            reader: through.map(|_| name.into()),
            persona_id: None,
            committed_through: through,
            updated_at: None,
        }
    }

    #[test]
    fn processed_needs_an_explicit_commit_at_or_after_the_message() {
        assert!(receipt("a", Some(5)).processed(5));
        assert!(!receipt("a", Some(4)).processed(5));
        assert!(!receipt("a", Some(0)).processed(1));
        assert!(!receipt("a", None).processed(1));
    }

    #[test]
    fn summary_names_both_sides_and_says_nothing_without_readers() {
        let all = [receipt("lead", Some(3)), receipt("worker", None)];
        assert_eq!(
            summary(&all, 2).as_deref(),
            Some("Processed by lead \u{b7} not yet: worker")
        );
        assert_eq!(
            summary(&all, 4).as_deref(),
            Some("Not yet processed by lead, worker")
        );
        assert_eq!(summary(&all[..1], 1).as_deref(), Some("Processed by lead"));
        assert_eq!(summary(&[], 1), None);
    }

    #[test]
    fn parse_checks_the_channel_and_shape() {
        let ok = json!({"channel": "work", "receipts": [
            {"name": "lead", "reader": "p1", "personaId": "p1", "committedThrough": 2, "updatedAt": "t"},
            {"name": "worker", "reader": null, "personaId": "p3", "committedThrough": null, "updatedAt": null},
        ]});
        let parsed = parse_channel(&ok, "work").unwrap();
        assert_eq!(parsed[0].committed_through, Some(2));
        assert_eq!(parsed[1].committed_through, None);
        assert!(parse_channel(&ok, "other").is_err());
        assert!(parse_channel(&json!({"channel": "work", "receipts": "x"}), "work").is_err());
    }

    #[test]
    fn paths_name_the_message_or_channel() {
        assert_eq!(
            message_path("t", "c", 7),
            "/api/tenants/t/channels/c/messages/7/receipts"
        );
        assert_eq!(channel_path("t", "c"), "/api/tenants/t/channels/c/receipts");
    }
}
