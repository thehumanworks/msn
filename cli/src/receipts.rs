//! Processed-by receipts (ADR 0040): which readers have explicitly committed past a message.
//!
//! The server reads them only from server processing cursors (ADR 0034), so a receipt proves
//! exactly one thing: someone holding the key committed under that reader name through this
//! message or later. Since ADR 0053, `msn commit`, the MCP `commit` tool, `msn run` and the event
//! dispatcher send that commit by default; `--local` or MSN_RESUMABLE=0 keeps it off the board.
//! Only readers with a server cursor are named. "Not yet" means that reader has committed, but
//! not this far. A persona that never committed to the server is never named: its progress is
//! unknown, and local-only commits are not visible.

use serde::Deserialize;
use serde_json::Value;

use crate::error::CliError;

/// What a receipt proves, for help text, tooltips and empty states in every client.
pub const MEANING: &str = "From explicit processing commits sent to the server only (the default for msn commit, MCP and msn run; --local keeps them off). Processed: the reader committed past this message. Not yet: the reader has committed, but not this far; it may still have seen it. Agents that never commit to the server are not listed. A shared board key can commit under any persona's name.";

/// Names listed per side before the rest are folded into "+N more".
pub const MAX_NAMES: usize = 10;

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

/// True when the receipt is the message sender's own reader, by persona id or by name (with any
/// `/worker` suffix). A sender is never listed on its own message.
pub fn from_sender(receipt: &Receipt, username: &str, persona_id: Option<&str>) -> bool {
    (persona_id.is_some() && receipt.persona_id.as_deref() == persona_id)
        || receipt.name == username
        || receipt
            .name
            .strip_prefix(username)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn names(list: &[&Receipt]) -> String {
    let shown = list
        .iter()
        .take(MAX_NAMES)
        .map(|r| r.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    match list.len().checked_sub(MAX_NAMES) {
        Some(more) if more > 0 => format!("{shown} +{more} more"),
        _ => shown,
    }
}

/// One compact line for a message, such as `Processed by lead · not yet: worker`, naming only
/// readers with a server cursor and never the sender. `None` when there is nobody to name.
pub fn summary(
    receipts: &[Receipt],
    message_id: u64,
    sender: &str,
    sender_persona: Option<&str>,
) -> Option<String> {
    let (done, waiting): (Vec<&Receipt>, Vec<&Receipt>) = receipts
        .iter()
        .filter(|r| r.committed_through.is_some() && !from_sender(r, sender, sender_persona))
        .partition(|r| r.processed(message_id));
    Some(match (done.is_empty(), waiting.is_empty()) {
        (true, true) => return None,
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
    fn summary_names_only_committed_readers_and_never_the_sender() {
        let all = [
            receipt("lead", Some(3)),
            receipt("worker", Some(1)),
            receipt("silent", None),
        ];
        assert_eq!(
            summary(&all, 2, "human", None).as_deref(),
            Some("Processed by lead \u{b7} not yet: worker")
        );
        assert_eq!(
            summary(&all, 4, "human", None).as_deref(),
            Some("Not yet processed by lead, worker")
        );
        assert_eq!(
            summary(&all, 1, "human", None).as_deref(),
            Some("Processed by lead, worker")
        );
        assert_eq!(
            summary(&all, 2, "lead", None).as_deref(),
            Some("Not yet processed by worker")
        );
        let worker = Receipt {
            name: "lead/w1".into(),
            persona_id: Some("p1".into()),
            ..receipt("x", Some(9))
        };
        assert!(from_sender(&worker, "lead", None));
        assert!(from_sender(&worker, "renamed", Some("p1")));
        assert!(!from_sender(&worker, "lea", None));
        assert_eq!(summary(&[receipt("silent", None)], 1, "human", None), None);
        assert_eq!(summary(&[], 1, "human", None), None);
    }

    #[test]
    fn summary_caps_each_side() {
        let many: Vec<_> = (0..13)
            .map(|i| receipt(&format!("r{i}"), Some(5)))
            .collect();
        let line = summary(&many, 1, "human", None).unwrap();
        assert!(line.starts_with("Processed by r0, r1,"), "{line}");
        assert!(line.ends_with("r9 +3 more"), "{line}");
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
