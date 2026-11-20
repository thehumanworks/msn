//! GUI-facing wrappers around the existing channel/message/snapshot/task HTTP surface.
//!
//! They call the same endpoints as the CLI (reusing `msn_cli::client`, `msn_cli::tasks` and
//! `msn_cli::send_body`) but return parsed values instead of printing. Every tenant/channel slug
//! is validated with `msn_cli::config::slug` before it is interpolated into a path.

use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use msn_cli::client::{MsnClient, RawResponse, classify, is_retryable_status, status_error};
use msn_cli::config::{CHANNELS_PAGE_LIMIT, MAX_SAFE_INTEGER, is_slug, slug};
use msn_cli::error::CliError;
use msn_cli::tasks;
use msn_cli::{Correlation, Payload, send_body};

const SEND_RETRY_ATTEMPTS: u32 = 3;
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(15);

/// Mirrors `msn task list --max-pages` (default 100) and its 32 MiB scan budget.
pub const MAX_HISTORY_PAGES: u64 = 100;
pub const MAX_HISTORY_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_BOARD_BYTES: usize = 262_144;
const MAX_SCAN_ATTEMPTS: u32 = 3;
const MAX_SNAPSHOT_PAGES: u64 = 10;
const SNAPSHOTS_KEPT: usize = 20;
const MAX_CHANNEL_PAGES: u64 = 5;

pub type Cancelled<'a> = &'a dyn Fn() -> bool;

fn cancelled_error() -> CliError {
    CliError::generic("Cancelled: the connection changed.")
}

/// A send-shaped failure. `retryable` reflects the raw HTTP status (429/5xx) or a transport
/// error, decided before the response is folded into a `CliError`.
pub struct SendError {
    pub cli_error: CliError,
    pub retryable: bool,
}

pub struct SendOutcome {
    pub id: u64,
    pub replayed: bool,
}

fn get_json_sized(client: &MsnClient, path: &str, token: &str) -> Result<(Value, usize), CliError> {
    let response = client.get(path, Some(token))?;
    classify(response.status, &response.body)?;
    let value = serde_json::from_str(&response.body)
        .map_err(|_| CliError::generic("Response was not JSON."))?;
    Ok((value, response.body.len()))
}

fn get_json(client: &MsnClient, path: &str, token: &str) -> Result<Value, CliError> {
    get_json_sized(client, path, token).map(|(value, _)| value)
}

fn integer(value: &Value, field: &str) -> Result<u64, CliError> {
    value[field]
        .as_u64()
        .filter(|n| *n <= MAX_SAFE_INTEGER)
        .ok_or_else(|| CliError::generic(format!("Invalid response field {field}.")))
}

pub fn list_channels(
    client: &MsnClient,
    tenant: &str,
    token: &str,
) -> Result<Vec<String>, CliError> {
    slug(tenant)?;
    let mut after = String::new();
    let mut names = Vec::new();
    for _ in 0..MAX_CHANNEL_PAGES {
        let path = if after.is_empty() {
            format!("/api/tenants/{tenant}/channels?limit={CHANNELS_PAGE_LIMIT}")
        } else {
            format!("/api/tenants/{tenant}/channels?limit={CHANNELS_PAGE_LIMIT}&after={after}")
        };
        let page = get_json(client, &path, token)?;
        let rows = page["channels"]
            .as_array()
            .ok_or_else(|| CliError::generic("Invalid channel list."))?;
        for row in rows {
            let name = row["name"]
                .as_str()
                .filter(|name| is_slug(name))
                .ok_or_else(|| CliError::generic("Invalid channel name in channel list."))?;
            names.push(name.to_string());
        }
        let has_more = page["hasMore"]
            .as_bool()
            .ok_or_else(|| CliError::generic("Invalid channel list."))?;
        if !has_more {
            return Ok(names);
        }
        after = names
            .last()
            .cloned()
            .ok_or_else(|| CliError::generic("Invalid channel list continuation."))?;
    }
    Err(CliError::generic("Too many channels to list."))
}

pub fn create_channel(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
) -> Result<(), CliError> {
    slug(tenant)?;
    slug(channel)?;
    let response = client.put(&format!("/api/tenants/{tenant}/channels/{channel}"), token)?;
    classify(response.status, &response.body)?;
    let value: Value = serde_json::from_str(&response.body)
        .map_err(|_| CliError::generic("Response was not JSON."))?;
    if value["channel"].as_str() != Some(channel) {
        return Err(CliError::generic(
            "Create response named a different channel.",
        ));
    }
    Ok(())
}

/// POSTs the same Idempotency-Key and body on every attempt (never regenerated mid-retry) and
/// retries 429/5xx/transport failures. Stops early when `cancelled` reports the connection moved
/// on, so a queued/old-connection send cannot keep running after disconnect.
fn post_with_retry(
    client: &MsnClient,
    path: &str,
    token: &str,
    key: &str,
    body: &Value,
    cancelled: Cancelled<'_>,
) -> Result<Value, SendError> {
    let mut backoff = BACKOFF_START;
    for attempt in 0..SEND_RETRY_ATTEMPTS {
        if cancelled() {
            return Err(SendError {
                cli_error: cancelled_error(),
                retryable: false,
            });
        }
        let outcome: Result<RawResponse, CliError> =
            client.post_json(path, token, &[("Idempotency-Key", key)], body);
        let last = attempt + 1 == SEND_RETRY_ATTEMPTS;
        match outcome {
            Ok(response) if (200..300).contains(&response.status) => {
                return serde_json::from_str(&response.body).map_err(|_| SendError {
                    cli_error: CliError::generic("Response was not JSON."),
                    retryable: true,
                });
            }
            Ok(response) if is_retryable_status(response.status) => {
                if last {
                    return Err(SendError {
                        cli_error: status_error(response.status, &response.body),
                        retryable: true,
                    });
                }
            }
            Ok(response) => {
                return Err(SendError {
                    cli_error: status_error(response.status, &response.body),
                    retryable: false,
                });
            }
            Err(err) => {
                let retryable = matches!(err, CliError::Network(_));
                if !retryable || last {
                    return Err(SendError {
                        cli_error: err,
                        retryable,
                    });
                }
            }
        }
        thread::sleep(backoff);
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
    unreachable!("loop returns within SEND_RETRY_ATTEMPTS iterations")
}

/// Real response shape is `{message:{id,..},replayed}`; a 2xx without a usable message id is a
/// failure (retryable with the same key, which is safe because sends are idempotent).
fn parse_send_outcome(
    value: &Value,
    tenant: &str,
    channel: &str,
) -> Result<SendOutcome, SendError> {
    let bad = |detail: &str| SendError {
        cli_error: CliError::generic(format!("Unexpected send response: {detail}.")),
        retryable: true,
    };
    let message = value.get("message").ok_or_else(|| bad("no message"))?;
    let id = message["id"]
        .as_u64()
        .filter(|id| (1..=MAX_SAFE_INTEGER).contains(id))
        .ok_or_else(|| bad("no message id"))?;
    if message["channel"].as_str() != Some(channel) || message["tenant"].as_str() != Some(tenant) {
        return Err(bad("message belongs to another channel or workspace"));
    }
    let replayed = value["replayed"]
        .as_bool()
        .ok_or_else(|| bad("no replayed flag"))?;
    Ok(SendOutcome { id, replayed })
}

#[allow(clippy::too_many_arguments)]
pub fn send_message(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    username: &str,
    text: &str,
    key: &str,
    correlation: Correlation,
    cancelled: Cancelled<'_>,
) -> Result<SendOutcome, SendError> {
    let fatal = |cli_error| SendError {
        cli_error,
        retryable: false,
    };
    slug(tenant).map_err(fatal)?;
    slug(channel).map_err(fatal)?;
    let body = send_body(
        username,
        &Payload {
            text: text.to_string(),
            content_type: None,
        },
        &correlation,
    );
    let value = post_with_retry(
        client,
        &format!("/api/tenants/{tenant}/channels/{channel}/messages"),
        token,
        key,
        &body,
        cancelled,
    )?;
    parse_send_outcome(&value, tenant, channel)
}

/// Exact point-read of one live message; checks id, channel and tenant of the response.
pub fn show_message(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    id: u64,
) -> Result<Value, CliError> {
    slug(tenant)?;
    slug(channel)?;
    let value = get_json(
        client,
        &format!("/api/tenants/{tenant}/channels/{channel}/messages/{id}"),
        token,
    )?;
    let message = &value["message"];
    if message["id"].as_u64() != Some(id)
        || message["channel"].as_str() != Some(channel)
        || message["tenant"].as_str() != Some(tenant)
    {
        return Err(CliError::generic(
            "Message response did not match the requested workspace, channel and ID.",
        ));
    }
    Ok(value)
}

/// One page of search results (ADR 0037), newest first.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchPage {
    pub messages: Vec<Value>,
    pub has_more: bool,
    pub next_before: Option<u64>,
    /// False while the server is still indexing messages older than the search feature.
    pub complete: bool,
}

/// Searches one channel by words and an optional sender; checks every result's workspace and
/// channel so a confused server cannot place another board's message in this view.
pub fn search_messages(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    text: &str,
    from: Option<&str>,
    before: Option<u64>,
) -> Result<SearchPage, CliError> {
    slug(tenant)?;
    slug(channel)?;
    let text = (!text.trim().is_empty()).then_some(text);
    let path = msn_cli::search::path(
        tenant,
        channel,
        &msn_cli::search::Search {
            text,
            from,
            before,
            limit: msn_cli::search::DEFAULT_LIMIT,
            ..Default::default()
        },
    )?;
    let value = get_json(client, &path, token)?;
    parse_search_page(&value, tenant, channel)
}

pub fn parse_search_page(
    value: &Value,
    tenant: &str,
    channel: &str,
) -> Result<SearchPage, CliError> {
    let invalid = || CliError::generic("Search response did not match this workspace and channel.");
    let messages = value["messages"].as_array().ok_or_else(invalid)?;
    let mut last = u64::MAX;
    for message in messages {
        let id = message["id"].as_u64().ok_or_else(invalid)?;
        if id >= last
            || message["channel"].as_str() != Some(channel)
            || message["tenant"].as_str() != Some(tenant)
        {
            return Err(invalid());
        }
        last = id;
    }
    let has_more = value["hasMore"].as_bool().ok_or_else(invalid)?;
    let next_before = value["nextBefore"].as_u64();
    if has_more && next_before.is_none() {
        return Err(invalid());
    }
    Ok(SearchPage {
        messages: messages.clone(),
        has_more,
        next_before: next_before.filter(|_| has_more),
        complete: value["complete"].as_bool().unwrap_or(true),
    })
}

/// A revision-consistent snapshot of a channel's canonical history.
#[derive(Debug, Clone, PartialEq)]
pub struct History {
    pub messages: Vec<Value>,
    pub head: u64,
    pub revision: u64,
}

/// Scans `/catchup` exactly like `msn task list` (`cli/src/task_client.rs`): explicit `after=0`
/// so no snapshot substitutes history, captured initial head, strict identity/order/nextCursor
/// checks, bounded pages and bytes, one revision throughout, and a final revision re-check. On a
/// revision change the scan restarts (bounded); it never returns partial history.
pub fn fetch_history(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    cancelled: Cancelled<'_>,
) -> Result<History, CliError> {
    slug(tenant)?;
    slug(channel)?;
    scan_history(
        |path| get_json_sized(client, path, token),
        tenant,
        channel,
        cancelled,
    )
}

pub fn scan_history(
    mut get: impl FnMut(&str) -> Result<(Value, usize), CliError>,
    tenant: &str,
    channel: &str,
    cancelled: Cancelled<'_>,
) -> Result<History, CliError> {
    let mut last_error = None;
    for _ in 0..MAX_SCAN_ATTEMPTS {
        match scan_once(&mut get, tenant, channel, cancelled) {
            Err(CliError::Conflict(message)) => last_error = Some(CliError::conflict(message)),
            other => return other,
        }
    }
    Err(last_error.unwrap_or_else(|| CliError::conflict("History kept changing during the scan.")))
}

fn scan_once(
    get: &mut impl FnMut(&str) -> Result<(Value, usize), CliError>,
    tenant: &str,
    channel: &str,
    cancelled: Cancelled<'_>,
) -> Result<History, CliError> {
    let base = format!("/api/tenants/{tenant}/channels/{channel}/catchup");
    let mut cursor = 0u64;
    let mut captured_head: Option<u64> = None;
    let mut revision: Option<u64> = None;
    let mut messages = Vec::new();
    let mut bytes = 0usize;
    let mut complete = false;
    for _ in 0..MAX_HISTORY_PAGES {
        if cancelled() {
            return Err(cancelled_error());
        }
        let (page, size) = get(&format!("{base}?after={cursor}&limit=100&maxBytes=262144"))?;
        bytes += size;
        if bytes > MAX_HISTORY_BYTES {
            return Err(CliError::generic(
                "Channel history exceeds the 32 MiB scan budget; nothing partial is shown.",
            ));
        }
        let current_revision = integer(&page, "historyRevision")?;
        if revision.is_some_and(|r| r != current_revision) {
            return Err(CliError::conflict(
                "History changed during the scan. Retrying from the beginning.",
            ));
        }
        revision = Some(current_revision);
        let current_head = integer(&page, "headCursor")?;
        let head = *captured_head.get_or_insert(current_head);
        if current_head < head {
            return Err(CliError::conflict(
                "Channel head regressed during the scan.",
            ));
        }
        let next = integer(&page, "nextCursor")?;
        let more = page["hasMore"]
            .as_bool()
            .ok_or_else(|| CliError::generic("Invalid history hasMore."))?;
        let rows = page["messages"]
            .as_array()
            .ok_or_else(|| CliError::generic("Invalid history messages."))?;
        let mut previous = cursor;
        for row in rows {
            let id = integer(row, "id")?;
            if id <= previous
                || id > current_head
                || row["tenant"].as_str() != Some(tenant)
                || row["channel"].as_str() != Some(channel)
            {
                return Err(CliError::generic(
                    "History is unordered or belongs to another channel.",
                ));
            }
            previous = id;
            if id <= head {
                messages.push(row.clone());
            }
        }
        if next != previous || (more && rows.is_empty()) {
            return Err(CliError::generic(
                "History cursor did not match the delivered rows.",
            ));
        }
        cursor = next;
        if !more || cursor >= head {
            complete = true;
            break;
        }
    }
    if !complete {
        return Err(CliError::generic(format!(
            "Channel history exceeds {MAX_HISTORY_PAGES} pages; nothing partial is shown."
        )));
    }
    let (check, _) = get(&format!("{base}?after=0&limit=1&maxBytes=262144"))?;
    if Some(integer(&check, "historyRevision")?) != revision {
        return Err(CliError::conflict(
            "History changed during the scan. Retrying from the beginning.",
        ));
    }
    Ok(History {
        messages,
        head: captured_head.unwrap_or(0),
        revision: revision.unwrap_or(0),
    })
}

/// Projects history through the authoritative reducer (`msn_cli::tasks::project`, ADR0010),
/// refusing oversized output rather than rendering a partial board.
pub fn project_board(history: &History) -> Result<Value, String> {
    let mut board = tasks::project(&history.messages);
    board["headCursor"] = json!(history.head);
    board["historyRevision"] = json!(history.revision);
    let size = serde_json::to_vec(&board).map_err(|e| e.to_string())?.len();
    if size > MAX_BOARD_BYTES {
        return Err("Task output exceeds 256 KiB; no partial board is shown.".into());
    }
    Ok(board)
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SnapshotView {
    pub entries: Vec<Value>,
    pub latest_text: Option<(u64, String)>,
}

pub fn fetch_snapshots(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
) -> Result<SnapshotView, CliError> {
    slug(tenant)?;
    slug(channel)?;
    let mut after = 0u64;
    let mut entries: Vec<Value> = Vec::new();
    let mut complete = false;
    for _ in 0..MAX_SNAPSHOT_PAGES {
        let page = get_json(
            client,
            &format!("/api/tenants/{tenant}/channels/{channel}/snapshots?after={after}&limit=100"),
            token,
        )?;
        let rows = page["snapshots"]
            .as_array()
            .ok_or_else(|| CliError::generic("Invalid snapshot list."))?;
        let mut previous = after;
        for row in rows {
            let version = integer(row, "version")?;
            if version <= previous || row["channel"].as_str() != Some(channel) {
                return Err(CliError::generic("Snapshot list is unordered or foreign."));
            }
            previous = version;
        }
        entries.extend(rows.iter().cloned());
        let has_more = page["hasMore"]
            .as_bool()
            .ok_or_else(|| CliError::generic("Invalid snapshot list."))?;
        if integer(&page, "nextCursor")? != previous {
            return Err(CliError::generic("Snapshot cursor did not match rows."));
        }
        after = previous;
        if !has_more {
            complete = true;
            break;
        }
    }
    if !complete {
        return Err(CliError::generic("Too many snapshots to list."));
    }
    if entries.len() > SNAPSHOTS_KEPT {
        entries.drain(..entries.len() - SNAPSHOTS_KEPT);
    }
    let latest_valid = entries
        .iter()
        .rev()
        .find(|entry| entry["invalidated"].as_bool() == Some(false))
        .and_then(|entry| entry["version"].as_u64());
    let latest_text = match latest_valid {
        None => None,
        Some(version) => {
            let response = client.get(
                &format!("/api/tenants/{tenant}/channels/{channel}/snapshots/{version}"),
                Some(token),
            )?;
            match response.status {
                410 => None,
                _ => {
                    classify(response.status, &response.body)?;
                    let value: Value = serde_json::from_str(&response.body)
                        .map_err(|_| CliError::generic("Response was not JSON."))?;
                    let text = value["snapshot"]["text"]
                        .as_str()
                        .ok_or_else(|| CliError::generic("Snapshot response had no text."))?;
                    Some((version, text.to_string()))
                }
            }
        }
    };
    Ok(SnapshotView {
        entries,
        latest_text,
    })
}

/// Sends a `msn.task.v1` event, validated with the authoritative `tasks::validate_event`.
#[allow(clippy::too_many_arguments)]
pub fn send_task_event(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    username: &str,
    task: &str,
    mut event: Value,
    key: &str,
    cancelled: Cancelled<'_>,
) -> Result<SendOutcome, SendError> {
    let fatal = |cli_error| SendError {
        cli_error,
        retryable: false,
    };
    slug(tenant).map_err(fatal)?;
    slug(channel).map_err(fatal)?;
    slug(task).map_err(fatal)?;
    event["schema"] = Value::String(tasks::SCHEMA.to_string());
    event["task"] = Value::String(task.to_string());
    tasks::validate_event(&event).map_err(fatal)?;
    let text =
        serde_json::to_string(&event).map_err(|e| fatal(CliError::generic(e.to_string())))?;
    let value = post_with_retry(
        client,
        &format!("/api/tenants/{tenant}/channels/{channel}/messages"),
        token,
        key,
        &json!({
            "username": username,
            "text": text,
            "contentType": "application/json",
            "correlationId": format!("task:{task}"),
        }),
        cancelled,
    )?;
    parse_send_outcome(&value, tenant, channel)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: u64) -> Value {
        json!({"id": id, "tenant": "acme", "channel": "general", "username": "a", "text": "t",
               "contentType": "text/plain", "createdAt": "2026-01-01T00:00:00Z"})
    }

    fn page(
        messages: Vec<Value>,
        next: u64,
        more: bool,
        head: u64,
        revision: u64,
    ) -> (Value, usize) {
        (
            json!({"messages": messages, "nextCursor": next, "hasMore": more, "headCursor": head,
                   "historyRevision": revision}),
            100,
        )
    }

    fn never() -> bool {
        false
    }

    #[test]
    fn search_pages_must_belong_to_the_channel_and_run_newest_first() {
        let message = |id: u64, channel: &str| json!({"id": id, "tenant": "t", "channel": channel});
        let page = parse_search_page(
            &json!({"messages": [message(9, "c"), message(4, "c")], "hasMore": true, "nextBefore": 4, "complete": false}),
            "t",
            "c",
        )
        .unwrap();
        assert_eq!(
            (
                page.messages.len(),
                page.has_more,
                page.next_before,
                page.complete
            ),
            (2, true, Some(4), false)
        );
        for bad in [
            json!({"messages": [message(4, "c"), message(9, "c")], "hasMore": false}),
            json!({"messages": [message(9, "other")], "hasMore": false}),
            json!({"messages": [], "hasMore": true}),
            json!({"messages": "nope", "hasMore": false}),
        ] {
            assert!(parse_search_page(&bad, "t", "c").is_err(), "{bad}");
        }
    }

    #[test]
    fn scan_accepts_consistent_paged_history_and_final_check() {
        let mut calls = 0;
        let history = scan_history(
            |_| {
                calls += 1;
                Ok(match calls {
                    1 => page(vec![message(1), message(2)], 2, true, 3, 5),
                    2 => page(vec![message(3)], 3, false, 3, 5),
                    _ => page(vec![], 0, false, 3, 5),
                })
            },
            "acme",
            "general",
            &never,
        )
        .unwrap();
        assert_eq!(history.messages.len(), 3);
        assert_eq!((history.head, history.revision), (3, 5));
    }

    #[test]
    fn scan_ignores_rows_appended_beyond_initial_head() {
        let mut calls = 0;
        let history = scan_history(
            |_| {
                calls += 1;
                Ok(match calls {
                    1 => page(vec![message(1)], 1, true, 2, 1),
                    2 => page(vec![message(2), message(3)], 3, false, 3, 1),
                    _ => page(vec![], 0, false, 3, 1),
                })
            },
            "acme",
            "general",
            &never,
        )
        .unwrap();
        assert_eq!(history.head, 2);
        assert_eq!(
            history.messages.len(),
            2,
            "id 3 postdates the captured head"
        );
    }

    #[test]
    fn scan_rejects_foreign_unordered_and_bad_cursor_pages() {
        let foreign = |_: &str| {
            let mut m = message(1);
            m["channel"] = json!("other");
            Ok(page(vec![m], 1, false, 1, 1))
        };
        assert!(scan_history(foreign, "acme", "general", &never).is_err());
        let unordered = |_: &str| Ok(page(vec![message(2), message(1)], 1, false, 2, 1));
        assert!(scan_history(unordered, "acme", "general", &never).is_err());
        let bad_cursor = |_: &str| Ok(page(vec![message(1)], 9, false, 1, 1));
        assert!(scan_history(bad_cursor, "acme", "general", &never).is_err());
        let empty_more = |_: &str| Ok(page(vec![], 0, true, 1, 1));
        assert!(scan_history(empty_more, "acme", "general", &never).is_err());
    }

    #[test]
    fn scan_restarts_on_revision_change_then_fails_if_it_never_settles() {
        let mut calls = 0;
        let result = scan_history(
            |_| {
                calls += 1;
                Ok(page(vec![message(1)], 1, true, 2, calls))
            },
            "acme",
            "general",
            &never,
        );
        assert!(matches!(result, Err(CliError::Conflict(_))));
    }

    #[test]
    fn scan_fails_when_final_revision_check_differs() {
        let mut calls = 0;
        let result = scan_history(
            |_| {
                calls += 1;
                // Final check of every attempt reports a newer revision.
                Ok(if calls % 2 == 1 {
                    page(vec![message(1)], 1, false, 1, 1)
                } else {
                    page(vec![], 0, false, 1, 2)
                })
            },
            "acme",
            "general",
            &never,
        );
        assert!(matches!(result, Err(CliError::Conflict(_))));
    }

    #[test]
    fn scan_enforces_byte_budget_and_cancellation() {
        let huge = |_: &str| {
            let (v, _) = page(vec![message(1)], 1, true, 5, 1);
            Ok((v, MAX_HISTORY_BYTES + 1))
        };
        assert!(scan_history(huge, "acme", "general", &never).is_err());
        let cancelled_now = || true;
        let result = scan_history(|_| unreachable!(), "acme", "general", &cancelled_now);
        assert!(result.is_err());
    }

    #[test]
    fn send_outcome_requires_message_id_and_matching_identity() {
        let ok = json!({"message": message(7), "replayed": false});
        let outcome = parse_send_outcome(&ok, "acme", "general").ok().unwrap();
        assert_eq!((outcome.id, outcome.replayed), (7, false));
        assert!(parse_send_outcome(&json!({"id": 7}), "acme", "general").is_err());
        assert!(
            parse_send_outcome(
                &json!({"message": {"text": "x"}, "replayed": false}),
                "acme",
                "general"
            )
            .is_err()
        );
        assert!(parse_send_outcome(&ok, "acme", "other").is_err());
        assert!(parse_send_outcome(&json!({"message": message(7)}), "acme", "general").is_err());
    }

    #[test]
    fn board_projection_uses_authoritative_reducer() {
        let open = json!({"id": 1, "tenant": "acme", "channel": "general", "username": "alice",
            "contentType": "application/json", "createdAt": "x",
            "text": r#"{"schema":"msn.task.v1","task":"t1","action":"open","title":"Do it","reviewer":"bob"}"#});
        let history = History {
            messages: vec![open],
            head: 1,
            revision: 0,
        };
        let board = project_board(&history).unwrap();
        assert_eq!(board["tasks"][0]["id"], "t1");
        assert_eq!(board["tasks"][0]["state"], "open");
    }
}
