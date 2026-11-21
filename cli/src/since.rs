//! "Since you last looked" for agents (ADR 0061): `msn since CHANNEL` and the MCP `since` tool.
//!
//! The server builds the summary (`GET …/channels/{c}/since`) with the same rules as the web
//! panel (ADR 0033), so a person and an agent see the same rows. It starts at the reader's server
//! processing commit (ADR 0034/0053). When the reader has none, this module passes the reader's
//! own progress on this machine as `after`: the local processing file first (`--local` agents),
//! then the `msn read` cursor. Nothing here writes a cursor, a progress file or a receipt.

use serde_json::{Value, json};
use url::Url;

use crate::agent::fetch_json;
use crate::client::MsnClient;
use crate::cursor::{CursorBinding, default_cursor_path, load_cursor};
use crate::error::CliError;
use crate::processing::{ProcessingState, default_processing_path, load_processing};

/// Where the summary started, as reported in `from.source`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Start {
    /// `--after N` (or the MCP `after` argument).
    Given(u64),
    /// This machine's processing progress (`msn peek`/`commit`, MCP `peek`/`commit`).
    LocalProcessing(u64),
    /// This machine's `msn read` cursor for the reader.
    Read(u64),
    /// Nothing on this machine: the server uses its processing commit, or the board's start.
    None,
}

impl Start {
    fn after(self) -> Option<u64> {
        match self {
            Start::Given(n) | Start::LocalProcessing(n) | Start::Read(n) => Some(n),
            Start::None => None,
        }
    }

    fn source(self) -> Option<&'static str> {
        match self {
            Start::Given(_) => Some("after"),
            Start::LocalProcessing(_) => Some("localProcessing"),
            Start::Read(_) => Some("read"),
            Start::None => None,
        }
    }
}

/// GET path for one reader's summary.
pub fn path(tenant: &str, channel: &str, reader: &str, after: Option<u64>) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("reader", reader);
    if let Some(after) = after {
        query.append_pair("after", &after.to_string());
    }
    format!(
        "/api/tenants/{tenant}/channels/{channel}/since?{}",
        query.finish()
    )
}

/// The reader's own progress on this machine, read without locking or changing anything. A file
/// that is missing, unreadable or bound to something else counts as no progress: a summary must
/// never fail because of a stale local file.
pub fn local_start(url: &Url, tenant: &str, channel: &str, reader: &str) -> Start {
    let processing = default_processing_path(url, tenant, reader, channel).ok();
    if let Some(path) = processing.as_deref().filter(|path| path.exists()) {
        let expected = ProcessingState::fresh(url, tenant, channel, reader);
        if let Ok(state) = load_processing(path, &expected) {
            return Start::LocalProcessing(state.committed_through);
        }
    }
    let read = default_cursor_path(url, tenant, reader, channel).ok();
    if let Some(path) = read.as_deref().filter(|path| path.exists()) {
        let binding = CursorBinding::new(url, tenant, channel, 0).with_reader(Some(reader));
        if let Ok(after) = load_cursor(path, &binding) {
            return Start::Read(after);
        }
    }
    Start::None
}

/// Fetch the summary and label where it started. The server's `processing` source wins over
/// anything sent from here.
pub fn fetch(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    reader: &str,
    start: Start,
) -> Result<Value, CliError> {
    let mut value = fetch_json(
        &MsnClient::new(url)?,
        &path(tenant, channel, reader, start.after()),
        token,
    )?;
    if value["channel"].as_str() != Some(channel) || value["reader"].as_str() != Some(reader) {
        return Err(CliError::generic(
            "Summary response did not match this channel and reader.",
        ));
    }
    if value["from"]["source"] == "after"
        && let Some(source) = start.source()
    {
        value["from"]["source"] = json!(source);
    }
    Ok(value)
}

fn where_from(from: &Value) -> String {
    let after = from["after"].as_u64().unwrap_or(0);
    match from["source"].as_str().unwrap_or_default() {
        "processing" => format!("after your processing commit at #{after}"),
        "localProcessing" => format!("after your progress on this machine at #{after}"),
        "read" => format!("after your read cursor at #{after}"),
        "after" => format!("after #{after}"),
        _ => "from the start of the board".into(),
    }
}

/// A short plain-text rendering for people at a terminal. Message text is untrusted: it is
/// printed as given, one item per line, with no markup interpreted.
pub fn render(value: &Value) -> String {
    let mut out = Vec::new();
    let count = value["count"].as_u64().unwrap_or(0);
    let labels = &value["labels"];
    let changes = labels["changes"].as_u64().unwrap_or(0);
    let head = value["head"].as_u64().unwrap_or(0);
    let from = where_from(&value["from"]);
    if count == 0 && changes == 0 {
        out.push(format!(
            "Nothing new since you last looked ({from}; board head #{head})."
        ));
        return out.join("\n");
    }
    out.push(value["headline"].as_str().unwrap_or_default().to_string());
    out.push(format!("({from}; board head #{head})"));
    for item in value["items"].as_array().into_iter().flatten() {
        let mark = if item["attention"] == true { "!" } else { " " };
        out.push(format!(
            "{mark} #{} {}",
            item["id"].as_u64().unwrap_or(0),
            one_line(item["text"].as_str().unwrap_or_default())
        ));
    }
    if let Some(hidden) = value["hidden"].as_u64().filter(|n| *n > 0) {
        out.push(format!("  and {hidden} more on the board"));
    }
    if value["truncated"] == true {
        out.push(format!(
            "  Read through #{} only; more messages follow.",
            value["lastId"].as_u64().unwrap_or(0)
        ));
    }
    let messages = labels["messages"].as_array().cloned().unwrap_or_default();
    let hidden = labels["hidden"].as_u64().unwrap_or(0);
    if changes > 0 {
        let total = messages.len() as u64 + hidden;
        out.push(format!(
            "Labels changed on {total} message{} ({changes} change{}){}:",
            if total == 1 { "" } else { "s" },
            if changes == 1 { "" } else { "s" },
            if labels["truncated"] == true {
                ", newest only"
            } else {
                ""
            }
        ));
        for row in &messages {
            let now = row["labels"]
                .as_object()
                .map(|map| {
                    map.iter()
                        .map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or_default()))
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| "no labels now".into());
            out.push(format!(
                "  #{} {}: {}",
                row["id"].as_u64().unwrap_or(0),
                one_line(row["username"].as_str().unwrap_or_default()),
                one_line(&now)
            ));
        }
        if hidden > 0 {
            out.push(format!("  and {hidden} more"));
        }
    }
    out.join("\n")
}

/// Control characters (newlines, escapes) in untrusted text become spaces, so one item stays one
/// line and cannot drive the terminal.
fn one_line(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary() -> Value {
        json!({
            "channel": "work",
            "reader": "worker",
            "from": {"source": "processing", "after": 3},
            "head": 9,
            "lastId": 9,
            "headline": "Since you last looked: 2 new messages from lead",
            "count": 2,
            "truncated": false,
            "authors": ["lead"],
            "firstId": 4,
            "items": [
                {"id": 5, "kind": "question", "text": "lead to you: \u{201c}ok?\u{1b}[2J\u{201d}", "attention": true},
                {"id": 4, "kind": "task", "text": "lead opened Parser", "attention": false}
            ],
            "hidden": 0,
            "labels": {
                "messages": [{"id": 2, "username": "human", "changes": 2, "labels": {"owner": "lead", "state": "done"}}],
                "hidden": 1,
                "changes": 3,
                "truncated": false
            }
        })
    }

    #[test]
    fn path_encodes_the_reader_and_optional_after() {
        assert_eq!(
            path("acme", "work", "a b/c", None),
            "/api/tenants/acme/channels/work/since?reader=a+b%2Fc"
        );
        assert_eq!(
            path("acme", "work", "w", Some(7)),
            "/api/tenants/acme/channels/work/since?reader=w&after=7"
        );
    }

    #[test]
    fn render_puts_attention_first_and_strips_control_characters() {
        let text = render(&summary());
        assert_eq!(
            text,
            [
                "Since you last looked: 2 new messages from lead",
                "(after your processing commit at #3; board head #9)",
                "! #5 lead to you: \u{201c}ok? [2J\u{201d}",
                "  #4 lead opened Parser",
                "Labels changed on 2 messages (3 changes):",
                "  #2 human: owner=lead state=done",
                "  and 1 more",
            ]
            .join("\n")
        );
    }

    #[test]
    fn render_says_nothing_new_with_where_it_started() {
        let mut value = summary();
        value["count"] = json!(0);
        value["items"] = json!([]);
        value["labels"] = json!({"messages": [], "hidden": 0, "changes": 0, "truncated": false});
        value["from"] = json!({"source": "read", "after": 9});
        assert_eq!(
            render(&value),
            "Nothing new since you last looked (after your read cursor at #9; board head #9)."
        );
    }

    #[test]
    fn local_sources_are_named_only_when_the_server_used_after() {
        assert_eq!(Start::LocalProcessing(4).source(), Some("localProcessing"));
        assert_eq!(Start::Read(2).after(), Some(2));
        assert_eq!(Start::None.after(), None);
    }
}
