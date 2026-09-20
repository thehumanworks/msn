//! Shared parsing/validation for the coordination event journal (`GET /events`, ADR 0017).
//!
//! Kept separate from `client::parse_page` (message pages) on purpose: an event id and a message
//! id are different counters on the server, and `events`/`watch` must never resolve a cursor
//! through the message-page parser or vice versa. Invalid or unrecognized event shapes are
//! rejected outright (fail closed) rather than passed through to a caller that might treat a
//! malformed row as real coordination state.

use serde::Deserialize;
use serde_json::Value;

use crate::error::CliError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum EventType {
    #[serde(rename = "channel.created")]
    ChannelCreated,
    #[serde(rename = "message.created")]
    MessageCreated,
    #[serde(rename = "message.deleted")]
    MessageDeleted,
    #[serde(rename = "snapshot.published")]
    SnapshotPublished,
}

/// Metadata only: the server never sends message/snapshot text, usernames or tokens here.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoordinationEvent {
    pub id: u64,
    pub tenant: String,
    pub channel: String,
    #[serde(rename = "type")]
    pub kind: EventType,
    pub resource_id: Option<u64>,
    pub history_revision: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventsPage {
    // Only used to force full-shape validation of every row; the raw JSON is what gets printed.
    #[allow(dead_code)]
    events: Vec<CoordinationEvent>,
    next_cursor: u64,
    #[allow(dead_code)]
    has_more: bool,
}

/// Validates a full `{events,nextCursor,hasMore}` body strictly, then returns the raw JSON
/// event objects (so `watch` can print exactly what the server sent) plus the validated cursor.
pub fn parse_events_page(body: &str) -> Result<(Vec<Value>, u64), CliError> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(CliError::generic("Empty response body"));
    }
    let raw: Value =
        serde_json::from_str(trimmed).map_err(|_| CliError::generic("Response was not JSON"))?;
    let page: EventsPage = serde_json::from_value(raw.clone())
        .map_err(|error| CliError::generic(format!("Invalid events response: {error}")))?;
    let events = match raw.get("events") {
        Some(Value::Array(events)) => events.clone(),
        _ => return Err(CliError::generic("Response was not JSON")),
    };
    Ok((events, page.next_cursor))
}

/// Validate the requested stream and cursor before displaying or acknowledging a page.
pub fn validate_events_page(
    body: &str,
    tenant: &str,
    channel: Option<&str>,
    after: u64,
    limit: u64,
) -> Result<(Vec<Value>, u64), CliError> {
    use crate::config::{MAX_SAFE_INTEGER, slug};
    let (rows, next) = parse_events_page(body)?;
    let page: EventsPage =
        serde_json::from_str(body).map_err(|_| CliError::generic("Invalid events response."))?;
    let invalid =
        || CliError::generic("Event page does not match the requested stream, ordering or cursor.");
    if limit == 0 || limit > 100 || after > MAX_SAFE_INTEGER || rows.len() as u64 > limit {
        return Err(invalid());
    }
    let mut previous = after;
    for (row, event) in rows.iter().zip(&page.events) {
        let resource_valid = match event.kind {
            EventType::ChannelCreated => row.get("resourceId").is_some_and(Value::is_null),
            _ => event
                .resource_id
                .is_some_and(|id| id > 0 && id <= MAX_SAFE_INTEGER),
        };
        if event.id <= previous
            || event.id > MAX_SAFE_INTEGER
            || event.tenant != tenant
            || channel.is_some_and(|expected| event.channel != expected)
            || slug(&event.channel).is_err()
            || event.history_revision > MAX_SAFE_INTEGER
            || event.created_at.is_empty()
            || event.created_at.len() > 64
            || !resource_valid
        {
            return Err(invalid());
        }
        previous = event.id;
    }
    if next != previous || next > MAX_SAFE_INTEGER || (page.has_more && rows.len() as u64 != limit)
    {
        return Err(invalid());
    }
    Ok((rows, next))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_page() -> &'static str {
        r#"{"events":[{"id":2,"tenant":"team","channel":"general","type":"message.created","resourceId":1,"historyRevision":0,"createdAt":"2026-09-20T00:00:00.000Z"}],"nextCursor":2,"hasMore":false}"#
    }

    #[test]
    fn given_valid_page_when_parsed_then_events_and_cursor_round_trip() {
        let (events, cursor) = parse_events_page(valid_page()).unwrap();
        assert_eq!(cursor, 2);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "message.created");
    }

    #[test]
    fn given_null_resource_id_when_parsed_then_ok() {
        let body = r#"{"events":[{"id":1,"tenant":"team","channel":"general","type":"channel.created","resourceId":null,"historyRevision":0,"createdAt":"2026-09-20T00:00:00.000Z"}],"nextCursor":1,"hasMore":false}"#;
        assert!(parse_events_page(body).is_ok());
    }

    #[test]
    fn given_unknown_event_type_when_parsed_then_fails_closed() {
        let body = r#"{"events":[{"id":1,"tenant":"team","channel":"general","type":"channel.archived","resourceId":null,"historyRevision":0,"createdAt":"2026-09-20T00:00:00.000Z"}],"nextCursor":1,"hasMore":false}"#;
        assert!(parse_events_page(body).is_err());
    }

    #[test]
    fn given_missing_required_field_when_parsed_then_fails_closed() {
        // `id` is required (unlike `resourceId`, which the contract types as nullable).
        let body = r#"{"events":[{"tenant":"team","channel":"general","type":"channel.created","resourceId":null,"historyRevision":0,"createdAt":"2026-09-20T00:00:00.000Z"}],"nextCursor":1,"hasMore":false}"#;
        assert!(parse_events_page(body).is_err());
    }

    #[test]
    fn given_unexpected_field_when_parsed_then_fails_closed() {
        let body = r#"{"events":[{"id":1,"tenant":"team","channel":"general","type":"channel.created","resourceId":null,"historyRevision":0,"createdAt":"2026-09-20T00:00:00.000Z","text":"leaked"}],"nextCursor":1,"hasMore":false}"#;
        assert!(parse_events_page(body).is_err());
    }

    #[test]
    fn given_a_message_page_shape_when_parsed_as_events_then_fails_closed() {
        // A message page (`{messages,nextCursor,hasMore}`) must never be mistaken for an events
        // page: the event cursor and the message cursor must never be confused.
        let body = r#"{"messages":[{"id":1}],"nextCursor":1,"hasMore":false}"#;
        assert!(parse_events_page(body).is_err());
    }

    #[test]
    fn given_empty_or_non_json_body_when_parsed_then_errors() {
        assert!(parse_events_page("").is_err());
        assert!(parse_events_page("not json").is_err());
        assert!(parse_events_page("[]").is_err());
    }
    #[test]
    fn events_are_bound_to_the_requested_stream_and_monotonic_safe_cursor() {
        assert!(validate_events_page(valid_page(), "team", Some("general"), 0, 100).is_ok());
        assert!(validate_events_page(valid_page(), "other", None, 0, 100).is_err());
        assert!(validate_events_page(valid_page(), "team", Some("other"), 0, 100).is_err());
        assert!(validate_events_page(valid_page(), "team", None, 2, 100).is_err());
        let base: Value = serde_json::from_str(valid_page()).unwrap();
        for (field, value) in [
            ("id", serde_json::json!(0)),
            ("id", serde_json::json!(9007199254740992_u64)),
            ("historyRevision", serde_json::json!(9007199254740992_u64)),
            ("resourceId", Value::Null),
            ("resourceId", serde_json::json!(0)),
            ("channel", serde_json::json!("not a slug")),
            ("createdAt", serde_json::json!("")),
        ] {
            let mut invalid = base.clone();
            invalid["events"][0][field] = value;
            assert!(
                validate_events_page(&invalid.to_string(), "team", None, 0, 100).is_err(),
                "{field}"
            );
        }
        for next in [0, 1, 3, 9007199254740992_u64] {
            let mut invalid = base.clone();
            invalid["nextCursor"] = Value::from(next);
            assert!(validate_events_page(&invalid.to_string(), "team", None, 0, 100).is_err());
        }
        let mut duplicate = base.clone();
        duplicate["events"]
            .as_array_mut()
            .unwrap()
            .push(base["events"][0].clone());
        assert!(validate_events_page(&duplicate.to_string(), "team", None, 0, 100).is_err());
    }

    #[test]
    fn empty_events_cannot_jump_a_cursor_or_claim_more_and_resource_id_is_required() {
        let empty = serde_json::json!({"events":[], "nextCursor":8, "hasMore":false});
        assert!(validate_events_page(&empty.to_string(), "team", None, 8, 100).is_ok());
        let mut jump = empty.clone();
        jump["nextCursor"] = serde_json::json!(9);
        assert!(validate_events_page(&jump.to_string(), "team", None, 8, 100).is_err());
        let mut more = empty;
        more["hasMore"] = serde_json::json!(true);
        assert!(validate_events_page(&more.to_string(), "team", None, 8, 100).is_err());
        let mut absent: Value = serde_json::from_str(valid_page()).unwrap();
        absent["events"][0]["type"] = serde_json::json!("channel.created");
        absent["events"][0]
            .as_object_mut()
            .unwrap()
            .remove("resourceId");
        assert!(validate_events_page(&absent.to_string(), "team", None, 0, 100).is_err());
    }
}
