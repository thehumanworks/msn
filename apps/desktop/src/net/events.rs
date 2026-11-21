//! Client for the coordination events API: `GET /api/tenants/:tenant/events`.
//!
//! Metadata only: event bodies carry no message text, usernames or tokens, so every event that
//! touches a channel triggers a canonical re-read through the existing endpoints. Pages are
//! validated strictly and fail closed: a page that does not match the contract is rejected as a
//! whole and the caller must NOT advance its cursor.

use serde::Deserialize;

use msn_cli::client::{MsnClient, is_retryable_status, status_error};
use msn_cli::config::{MAX_LIMIT, MAX_SAFE_INTEGER, is_slug, slug};
use msn_cli::error::CliError;

pub const EVENTS_WAIT_SECONDS: u64 = 25;
pub const EVENTS_PAGE_LIMIT: u64 = MAX_LIMIT;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum EventKind {
    #[serde(rename = "channel.created")]
    ChannelCreated,
    #[serde(rename = "message.created")]
    MessageCreated,
    #[serde(rename = "message.deleted")]
    MessageDeleted,
    #[serde(rename = "snapshot.published")]
    SnapshotPublished,
    /// Someone's agent status changed (ADR 0064); asked for with `include=statuses`.
    #[serde(rename = "status.changed")]
    StatusChanged,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoordinationEvent {
    pub id: u64,
    pub tenant: String,
    pub channel: String,
    #[serde(rename = "type")]
    pub kind: EventKind,
    #[serde(rename = "resourceId")]
    pub resource_id: Option<u64>,
    #[serde(rename = "historyRevision")]
    pub history_revision: u64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventsPage {
    pub events: Vec<CoordinationEvent>,
    #[serde(rename = "nextCursor")]
    pub next_cursor: u64,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
}

/// What a page must look like given the request that produced it.
pub struct PageExpectation<'a> {
    pub tenant: &'a str,
    pub after: u64,
    pub limit: u64,
    pub channel: Option<&'a str>,
}

fn invalid(detail: &str) -> CliError {
    CliError::generic(format!("Invalid events response: {detail}."))
}

fn safe(value: u64) -> bool {
    value <= MAX_SAFE_INTEGER
}

/// Strictly parses and validates a page. Any deviation is an error; nothing is partially accepted.
pub fn parse_events_page(body: &str, expect: &PageExpectation<'_>) -> Result<EventsPage, CliError> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(invalid("empty body"));
    }
    let page: EventsPage =
        serde_json::from_str(trimmed).map_err(|error| invalid(&format!("bad shape ({error})")))?;
    if page.events.len() as u64 > expect.limit {
        return Err(invalid("more events than the requested limit"));
    }
    let mut previous = expect.after;
    for event in &page.events {
        if !safe(event.id) || event.id <= previous {
            return Err(invalid(
                "event ids must be safe integers strictly after the cursor and increasing",
            ));
        }
        if event.tenant != expect.tenant {
            return Err(invalid("event belongs to another workspace"));
        }
        if !is_slug(&event.channel) || expect.channel.is_some_and(|c| c != event.channel) {
            return Err(invalid(
                "event channel is malformed or outside the requested filter",
            ));
        }
        if !safe(event.history_revision) || event.created_at.is_empty() {
            return Err(invalid("malformed historyRevision or createdAt"));
        }
        let resource_ok = match event.kind {
            EventKind::ChannelCreated => event.resource_id.is_none(),
            EventKind::MessageCreated
            | EventKind::MessageDeleted
            | EventKind::SnapshotPublished
            | EventKind::StatusChanged => event.resource_id.is_some_and(|id| id >= 1 && safe(id)),
        };
        if !resource_ok {
            return Err(invalid("resourceId does not match the event type"));
        }
        previous = event.id;
    }
    if page.next_cursor != previous {
        return Err(invalid(
            "nextCursor does not match the last delivered event",
        ));
    }
    if page.has_more && page.events.is_empty() {
        return Err(invalid("hasMore with no events"));
    }
    Ok(page)
}

/// How a failed events request should be handled by the subscription loop.
#[derive(Debug)]
pub enum EventsError {
    /// 401/403: stop listening and force re-authentication.
    Auth(CliError),
    /// Transport failure, 429 or 5xx: keep the cursor and retry with backoff.
    Retry(CliError),
    /// Malformed page, missing endpoint or other 4xx: fail closed, never skip past it.
    Terminal(CliError),
}

impl std::fmt::Display for EventsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EventsError::Auth(e) | EventsError::Retry(e) | EventsError::Terminal(e) => e.fmt(f),
        }
    }
}

/// One validated page of `GET /api/tenants/:tenant/events`. `wait` is 0..=25, `limit` 1..=100.
pub fn fetch_events(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    after: u64,
    limit: u64,
    wait: u64,
    channel: Option<&str>,
) -> Result<EventsPage, EventsError> {
    slug(tenant).map_err(EventsError::Terminal)?;
    // Agent status changes (ADR 0064) are opt-in; this client knows the type.
    let mut path = format!(
        "/api/tenants/{tenant}/events?after={after}&limit={limit}&wait={wait}&include=statuses"
    );
    if let Some(channel) = channel {
        slug(channel).map_err(EventsError::Terminal)?;
        path.push_str("&channel=");
        path.push_str(channel);
    }
    let response = client.get(&path, Some(token)).map_err(|e| match e {
        CliError::Network(_) => EventsError::Retry(e),
        other => EventsError::Terminal(other),
    })?;
    match response.status {
        200..=299 => parse_events_page(
            &response.body,
            &PageExpectation {
                tenant,
                after,
                limit,
                channel,
            },
        )
        .map_err(EventsError::Terminal),
        401 | 403 => Err(EventsError::Auth(status_error(
            response.status,
            &response.body,
        ))),
        404 if channel.is_none() => Err(EventsError::Terminal(CliError::generic(
            "The server has no workspace events endpoint (HTTP 404). Deploy the coordination API to this origin, then Disconnect and Connect again.",
        ))),
        status if is_retryable_status(status) => {
            Err(EventsError::Retry(status_error(status, &response.body)))
        }
        status => Err(EventsError::Terminal(status_error(status, &response.body))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expect(after: u64) -> PageExpectation<'static> {
        PageExpectation {
            tenant: "acme",
            after,
            limit: 100,
            channel: None,
        }
    }

    fn event(id: u64, kind: &str, resource: &str) -> String {
        format!(
            r#"{{"id":{id},"tenant":"acme","channel":"general","type":"{kind}","resourceId":{resource},"historyRevision":1,"createdAt":"2026-01-01T00:00:00Z"}}"#
        )
    }

    fn page(events: &[String], next: u64, more: bool) -> String {
        format!(
            r#"{{"events":[{}],"nextCursor":{next},"hasMore":{more}}}"#,
            events.join(",")
        )
    }

    #[test]
    fn valid_page_round_trips() {
        let body = page(
            &[
                event(3, "channel.created", "null"),
                event(4, "message.created", "42"),
            ],
            4,
            false,
        );
        let parsed = parse_events_page(&body, &expect(2)).unwrap();
        assert_eq!(parsed.events.len(), 2);
        assert_eq!(parsed.next_cursor, 4);
    }

    #[test]
    fn status_changed_needs_a_sequence_number() {
        let ok = page(&[event(3, "status.changed", "5")], 3, false);
        let parsed = parse_events_page(&ok, &expect(2)).unwrap();
        assert_eq!(parsed.events[0].kind, EventKind::StatusChanged);
        let bad = page(&[event(3, "status.changed", "null")], 3, false);
        assert!(parse_events_page(&bad, &expect(2)).is_err());
    }

    #[test]
    fn empty_page_keeps_cursor() {
        assert!(parse_events_page(&page(&[], 7, false), &expect(7)).is_ok());
        assert!(parse_events_page(&page(&[], 8, false), &expect(7)).is_err());
        assert!(parse_events_page(&page(&[], 7, true), &expect(7)).is_err());
    }

    #[test]
    fn rejects_replayed_or_unordered_ids() {
        let body = page(
            &[
                event(5, "message.created", "1"),
                event(5, "message.created", "2"),
            ],
            5,
            false,
        );
        assert!(parse_events_page(&body, &expect(0)).is_err());
        let body = page(&[event(3, "message.created", "1")], 3, false);
        assert!(
            parse_events_page(&body, &expect(3)).is_err(),
            "id must be strictly after cursor"
        );
    }

    #[test]
    fn rejects_wrong_next_cursor() {
        let body = page(&[event(5, "message.created", "1")], 6, false);
        assert!(parse_events_page(&body, &expect(0)).is_err());
    }

    #[test]
    fn rejects_foreign_tenant_and_channel_filter_violations() {
        let body = page(&[event(1, "message.created", "1")], 1, false).replace("acme", "other");
        assert!(parse_events_page(&body, &expect(0)).is_err());
        let filtered = PageExpectation {
            channel: Some("random"),
            ..expect(0)
        };
        let body = page(&[event(1, "message.created", "1")], 1, false);
        assert!(parse_events_page(&body, &filtered).is_err());
    }

    #[test]
    fn rejects_unsafe_ids_bad_resources_unknown_types_and_extra_fields() {
        let unsafe_id = page(
            &[event(9_007_199_254_740_992, "message.created", "1")],
            9_007_199_254_740_992,
            false,
        );
        assert!(parse_events_page(&unsafe_id, &expect(0)).is_err());
        let null_resource = page(&[event(1, "message.created", "null")], 1, false);
        assert!(parse_events_page(&null_resource, &expect(0)).is_err());
        let channel_with_resource = page(&[event(1, "channel.created", "3")], 1, false);
        assert!(parse_events_page(&channel_with_resource, &expect(0)).is_err());
        let unknown = page(&[event(1, "channel.archived", "null")], 1, false);
        assert!(parse_events_page(&unknown, &expect(0)).is_err());
        let extra = page(&[event(1, "message.created", "1")], 1, false)
            .replace(r#""id":1,"#, r#""id":1,"text":"x","#);
        assert!(parse_events_page(&extra, &expect(0)).is_err());
    }

    #[test]
    fn rejects_non_json_and_message_page_shapes() {
        assert!(parse_events_page("", &expect(0)).is_err());
        assert!(parse_events_page("nope", &expect(0)).is_err());
        assert!(
            parse_events_page(
                r#"{"messages":[],"nextCursor":0,"hasMore":false}"#,
                &expect(0)
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_more_events_than_limit() {
        let small = PageExpectation {
            limit: 1,
            ..expect(0)
        };
        let body = page(
            &[
                event(1, "message.created", "1"),
                event(2, "message.created", "2"),
            ],
            2,
            false,
        );
        assert!(parse_events_page(&body, &small).is_err());
    }
}
