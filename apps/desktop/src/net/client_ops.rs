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
    Ok(list_all_channels(client, tenant, token, false)?.0)
}

/// Every channel including archived boards (ADR 0046), plus the names that are archived. The
/// sidebar hides the archived ones unless "Show archived" is on.
pub fn list_all_channels(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    include_archived: bool,
) -> Result<(Vec<String>, Vec<String>), CliError> {
    slug(tenant)?;
    let include = if include_archived {
        "&include=archived"
    } else {
        ""
    };
    let mut after = String::new();
    let mut names = Vec::new();
    let mut archived = Vec::new();
    for _ in 0..MAX_CHANNEL_PAGES {
        let path = if after.is_empty() {
            format!("/api/tenants/{tenant}/channels?limit={CHANNELS_PAGE_LIMIT}{include}")
        } else {
            format!(
                "/api/tenants/{tenant}/channels?limit={CHANNELS_PAGE_LIMIT}&after={after}{include}"
            )
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
            if row["archivedAt"].is_string() {
                archived.push(name.to_string());
            }
        }
        let has_more = page["hasMore"]
            .as_bool()
            .ok_or_else(|| CliError::generic("Invalid channel list."))?;
        if !has_more {
            return Ok((names, archived));
        }
        after = names
            .last()
            .cloned()
            .ok_or_else(|| CliError::generic("Invalid channel list continuation."))?;
    }
    Err(CliError::generic("Too many channels to list."))
}

/// Archives (`true`) or unarchives a board (ADR 0046). Owner only: a refusal is reported as a
/// plain error, never as a failed sign-in, so a participant who tries stays connected.
pub fn set_archived(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    archived: bool,
) -> Result<bool, CliError> {
    slug(tenant)?;
    slug(channel)?;
    let path = format!("/api/tenants/{tenant}/channels/{channel}/archive");
    let response = if archived {
        client.put(&path, token)?
    } else {
        client.delete(&path, token)?
    };
    if response.status == 403 {
        return Err(CliError::generic(
            "Only the board owner can archive or unarchive a board.",
        ));
    }
    classify(response.status, &response.body)?;
    let value: Value = serde_json::from_str(&response.body)
        .map_err(|_| CliError::generic("Response was not JSON."))?;
    if value["channel"].as_str() != Some(channel) {
        return Err(CliError::generic(
            "Archive response named a different channel.",
        ));
    }
    value["archived"]
        .as_bool()
        .ok_or_else(|| CliError::generic("Invalid archive response."))
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

/// The parent of a reply whose parent is not loaded (ADR 0041). `None` when it is gone: 404 (no
/// such message) and 410 (deleted) read alike, since either way there is nothing to show.
pub fn load_parent(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    id: u64,
) -> Result<Option<Value>, CliError> {
    match show_message(client, tenant, token, channel, id) {
        Ok(mut value) => Ok(Some(value["message"].take())),
        // The client maps 404 to NotFound and 410 to Conflict; a GET is never a 409.
        Err(CliError::NotFound(_) | CliError::Conflict(_)) => Ok(None),
        Err(err) => Err(err),
    }
}

/// Every reader's explicit commit position on a channel (ADR 0040), for the processed-by line.
pub fn fetch_receipts(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
) -> Result<Vec<msn_cli::receipts::Receipt>, CliError> {
    slug(tenant)?;
    slug(channel)?;
    let value = get_json(
        client,
        &msn_cli::receipts::channel_path(tenant, channel),
        token,
    )?;
    msn_cli::receipts::parse_channel(&value, channel)
}

/// What each name on the board says it is doing (ADR 0064), newest first.
pub fn fetch_statuses(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
) -> Result<Vec<msn_cli::status::Status>, CliError> {
    slug(tenant)?;
    slug(channel)?;
    let value = get_json(client, &msn_cli::status::list_path(tenant, channel), token)?;
    Ok(msn_cli::status::parse_list(&value))
}

/// The board's personas as (display name, listening now), for @ suggestions (ADR 0055).
pub fn fetch_personas(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
) -> Result<Vec<(String, bool)>, CliError> {
    slug(tenant)?;
    slug(channel)?;
    let value = get_json(
        client,
        &format!("/api/tenants/{tenant}/channels/{channel}/personas"),
        token,
    )?;
    Ok(value["personas"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|persona| {
                    let name = persona["displayName"].as_str()?;
                    Some((
                        name.to_owned(),
                        persona["listening"].as_bool() == Some(true),
                    ))
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Answers question `question` with `choice` as `username` (ADR 0065). Returns the question's
/// `answered` record: this answer's, or the first one when someone answered before. A refusal
/// (403 not addressed, 400 not a choice) is a plain error here, never a failed sign-in: only 401
/// ends the session.
#[allow(clippy::too_many_arguments)]
pub fn answer(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    username: &str,
    question: u64,
    choice: &str,
    key: &str,
) -> Result<Value, CliError> {
    slug(tenant)?;
    slug(channel)?;
    let base = format!("/api/tenants/{tenant}/channels/{channel}/messages");
    let response = client.post_json(
        &base,
        token,
        &[("Idempotency-Key", key)],
        &msn_cli::ask::answer_body(username, question, choice),
    )?;
    if response.status == 409
        && serde_json::from_str::<Value>(&response.body)
            .ok()
            .and_then(|body| body["error"]["code"].as_str().map(str::to_owned))
            .as_deref()
            == Some("already_answered")
    {
        let read = client.get(&format!("{base}/{question}"), Some(token))?;
        classify(read.status, &read.body)?;
        let value: Value = serde_json::from_str(&read.body)
            .map_err(|_| CliError::generic("Response was not JSON."))?;
        return Ok(value["message"]["answered"].clone());
    }
    if response.status != 401
        && let Err(CliError::Auth(message)) = classify(response.status, &response.body)
    {
        return Err(CliError::generic(message));
    }
    classify(response.status, &response.body)?;
    let value: Value = serde_json::from_str(&response.body)
        .map_err(|_| CliError::generic("Response was not JSON."))?;
    let reply = &value["message"];
    Ok(serde_json::json!({
        "id": reply["id"],
        "choice": reply["answer"],
        "username": reply["username"],
        "answeredAt": reply["createdAt"],
    }))
}

/// Adds or removes one reaction (ADR 0047) as `username`. Returns the message's reactions after
/// the change (`Value::Null` when it has none left).
#[allow(clippy::too_many_arguments)]
pub fn react(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    username: &str,
    id: u64,
    kind: &str,
    remove: bool,
) -> Result<Value, CliError> {
    slug(tenant)?;
    slug(channel)?;
    let kind = msn_cli::reactions::parse_kind(kind)?;
    let response = client.post_json(
        &format!("/api/tenants/{tenant}/channels/{channel}/messages/{id}/reactions"),
        token,
        &[],
        &msn_cli::reactions::body(username, kind, remove),
    )?;
    classify(response.status, &response.body)?;
    let value: Value = serde_json::from_str(&response.body)
        .map_err(|_| CliError::generic("Response was not JSON."))?;
    let message = &value["message"];
    if message["id"].as_u64() != Some(id) || message["channel"].as_str() != Some(channel) {
        return Err(CliError::generic(
            "Reaction response named a different message.",
        ));
    }
    Ok(message["reactions"].clone())
}

/// Takes message `id` as `username`, or releases it (ADR 0075). Returns the message's claim
/// after the change: `{username, claimedAt}`, or `Null` when nobody holds it. A message another
/// name holds is a conflict whose text names the holder.
pub fn claim(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    username: &str,
    id: u64,
    release: bool,
) -> Result<Value, CliError> {
    slug(tenant)?;
    slug(channel)?;
    let response = client.post_json(
        &msn_cli::claim_path(tenant, channel, id),
        token,
        &[],
        &msn_cli::claim_body(username, release),
    )?;
    classify(response.status, &response.body)?;
    let value: Value = serde_json::from_str(&response.body)
        .map_err(|_| CliError::generic("Response was not JSON."))?;
    let message = &value["message"];
    if message["id"].as_u64() != Some(id) || message["channel"].as_str() != Some(channel) {
        return Err(CliError::generic(
            "Claim response named a different message.",
        ));
    }
    Ok(message["claim"].clone())
}

/// Replaces the text of a message `username` sent (ADR 0052). Returns the edited message.
/// `base` is the `editedAt` the editor started from (None for a never-edited message); the server
/// refuses the save with 409 edit_conflict when the message changed since.
#[allow(clippy::too_many_arguments)]
pub fn edit_message(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    username: &str,
    id: u64,
    text: &str,
    base: Option<&str>,
) -> Result<Value, CliError> {
    slug(tenant)?;
    slug(channel)?;
    let response = client.send_optional_json(
        "PATCH",
        &format!("/api/tenants/{tenant}/channels/{channel}/messages/{id}"),
        token,
        Some(&json!({ "username": username, "text": text, "ifEditedAt": base })),
    )?;
    classify(response.status, &response.body)?;
    let value: Value = serde_json::from_str(&response.body)
        .map_err(|_| CliError::generic("Response was not JSON."))?;
    let message = value["message"].clone();
    if message["id"].as_u64() != Some(id)
        || message["channel"].as_str() != Some(channel)
        || !message["text"].is_string()
    {
        return Err(CliError::generic(
            "Edit response named a different message.",
        ));
    }
    Ok(message)
}

/// Messages edited after edit cursor `after` (ADR 0052), oldest edit first, and the cursor to
/// ask from next. `None` only learns the board's current cursor. At most a few pages.
pub fn fetch_edits(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    after: Option<u64>,
) -> Result<(Vec<Value>, u64), CliError> {
    slug(tenant)?;
    slug(channel)?;
    let mut found = Vec::new();
    let mut after = after;
    for _ in 0..5 {
        let query = after.map(|n| format!("?after={n}")).unwrap_or_default();
        let value = get_json(
            client,
            &format!("/api/tenants/{tenant}/channels/{channel}/edits{query}"),
            token,
        )?;
        let (page, cursor, more) = parse_edits(&value, channel)?;
        found.extend(page);
        after = Some(cursor);
        if !more {
            break;
        }
    }
    Ok((found, after.unwrap_or(0)))
}

/// One edits page: edited messages of this channel, the next edit cursor, and whether more wait.
pub fn parse_edits(value: &Value, channel: &str) -> Result<(Vec<Value>, u64, bool), CliError> {
    let bad = || CliError::generic("Invalid edits response.");
    let rows = value["edits"].as_array().ok_or_else(bad)?;
    for row in rows {
        if row["id"].as_u64().is_none()
            || row["channel"].as_str() != Some(channel)
            || !row["text"].is_string()
        {
            return Err(bad());
        }
    }
    let cursor = value["editCursor"]
        .as_u64()
        .filter(|n| *n <= MAX_SAFE_INTEGER)
        .ok_or_else(bad)?;
    let more = value["hasMore"].as_bool().ok_or_else(bad)?;
    Ok((rows.clone(), cursor, more))
}

/// The board's scheduled messages (ADR 0060), soonest first; each is checked to be this board's.
pub fn fetch_scheduled(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
) -> Result<Vec<Value>, CliError> {
    slug(tenant)?;
    slug(channel)?;
    let value = get_json(
        client,
        &format!("/api/tenants/{tenant}/channels/{channel}/scheduled"),
        token,
    )?;
    parse_scheduled(&value, channel)
}

/// `{scheduled: [...]}`: every row needs an id, this channel, text and a sendAt.
pub fn parse_scheduled(value: &Value, channel: &str) -> Result<Vec<Value>, CliError> {
    let bad = || CliError::generic("Invalid scheduled messages response.");
    let rows = value["scheduled"].as_array().ok_or_else(bad)?;
    for row in rows {
        if row["id"].as_u64().is_none()
            || row["channel"].as_str() != Some(channel)
            || !row["text"].is_string()
            || !row["sendAt"].is_string()
        {
            return Err(bad());
        }
    }
    Ok(rows.clone())
}

/// Schedules `text` to post at `send_at` (ADR 0060) with one Idempotency-Key. One attempt: the
/// list shows whether it arrived, and a retry with the same key replays it.
#[allow(clippy::too_many_arguments)]
pub fn schedule_message(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    username: &str,
    text: &str,
    key: &str,
    send_at: &str,
    correlation: Correlation,
) -> Result<(), CliError> {
    slug(tenant)?;
    slug(channel)?;
    let mut body = send_body(
        username,
        &Payload {
            text: text.to_string(),
            content_type: None,
        },
        &correlation,
    );
    body["sendAt"] = json!(send_at);
    let response = client.post_json(
        &format!("/api/tenants/{tenant}/channels/{channel}/messages"),
        token,
        &[("Idempotency-Key", key)],
        &body,
    )?;
    classify(response.status, &response.body)
}

/// Changes the text and/or time of a scheduled message (ADR 0060); a new time retries a failed one.
#[allow(clippy::too_many_arguments)]
pub fn change_scheduled(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    username: &str,
    id: u64,
    text: Option<&str>,
    send_at: Option<&str>,
) -> Result<(), CliError> {
    slug(tenant)?;
    slug(channel)?;
    let mut body = json!({ "username": username });
    if let Some(text) = text {
        body["text"] = json!(text);
    }
    if let Some(send_at) = send_at {
        body["sendAt"] = json!(send_at);
    }
    let response = client.send_optional_json(
        "PATCH",
        &format!("/api/tenants/{tenant}/channels/{channel}/scheduled/{id}"),
        token,
        Some(&body),
    )?;
    classify(response.status, &response.body)
}

/// Cancels a scheduled message as `username` (ADR 0060).
pub fn cancel_scheduled(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    username: &str,
    id: u64,
) -> Result<(), CliError> {
    slug(tenant)?;
    slug(channel)?;
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("username", username);
    let response = client.delete(
        &format!(
            "/api/tenants/{tenant}/channels/{channel}/scheduled/{id}?{}",
            query.finish()
        ),
        token,
    )?;
    classify(response.status, &response.body)
}

/// Current reactions (ADR 0047) for messages after `after`, by message id; at most a few pages.
pub fn fetch_reactions(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    after: u64,
) -> Result<(ReactionRows, Option<ClaimRows>), CliError> {
    slug(tenant)?;
    slug(channel)?;
    let mut found = Vec::new();
    // Claims (ADR 0075) come on the same pages; a server without them sends no list at all.
    let mut claims = Some(Vec::new());
    let mut after = after;
    for _ in 0..5 {
        let value = get_json(
            client,
            &format!("/api/tenants/{tenant}/channels/{channel}/reactions?after={after}"),
            token,
        )?;
        let (page, next) = parse_reactions(&value)?;
        found.extend(page);
        match (claims.as_mut(), parse_claims(&value)?) {
            (Some(all), Some(page)) => all.extend(page),
            _ => claims = None,
        }
        match next {
            Some(next) if next > after => after = next,
            // Five full pages did not reach the end: later messages would wrongly read as
            // untaken, so report no claims and keep what is shown.
            Some(_) => {
                claims = None;
                break;
            }
            None => break,
        }
    }
    Ok((found, claims))
}

/// Claims by message id, as the server lists them with the reactions (ADR 0075).
pub type ClaimRows = Vec<(u64, Value)>;

/// The `claims` list of one reactions page: `None` when the server sent none (before ADR 0075).
/// Each entry is a message id and `{username, claimedAt}`.
pub fn parse_claims(value: &Value) -> Result<Option<ClaimRows>, CliError> {
    let bad = || CliError::generic("Invalid reactions response.");
    let Some(rows) = value.get("claims") else {
        return Ok(None);
    };
    let rows = rows.as_array().ok_or_else(bad)?;
    let mut page = Vec::with_capacity(rows.len());
    for row in rows {
        let id = row["id"].as_u64().ok_or_else(bad)?;
        if !row["claim"]["username"].is_string() {
            return Err(bad());
        }
        page.push((id, row["claim"].clone()));
    }
    Ok(Some(page))
}

/// Reactions by message id, as the server lists them.
pub type ReactionRows = Vec<(u64, Value)>;

/// One reactions page: entries with an id and an object of kinds, and the next `after` when more.
pub fn parse_reactions(value: &Value) -> Result<(ReactionRows, Option<u64>), CliError> {
    let bad = || CliError::generic("Invalid reactions response.");
    let rows = value["reactions"].as_array().ok_or_else(bad)?;
    let mut page = Vec::with_capacity(rows.len());
    for row in rows {
        let id = row["id"].as_u64().ok_or_else(bad)?;
        if !row["reactions"].is_object() {
            return Err(bad());
        }
        page.push((id, row["reactions"].clone()));
    }
    let next = if value["hasMore"].as_bool() == Some(true) {
        Some(value["nextAfter"].as_u64().ok_or_else(bad)?)
    } else {
        None
    };
    Ok((page, next))
}

/// Unread counts above this computer's read marks (ADR 0045). The server keeps no read state;
/// `me` is the reader's display name, used to leave out their own messages and count the ones
/// addressed to them.
pub fn fetch_unread(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    me: &str,
    marks: &[(String, u64)],
) -> Result<Vec<crate::read_marks::Unread>, CliError> {
    slug(tenant)?;
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("me", me);
    for (channel, id) in marks {
        slug(channel)?;
        query.append_pair("mark", &format!("{channel}:{id}"));
    }
    let value = get_json(
        client,
        &format!("/api/tenants/{tenant}/unread?{}", query.finish()),
        token,
    )?;
    parse_unread(&value, marks)
}

/// Keeps only answers for boards that were asked about, at the mark that was sent.
pub fn parse_unread(
    value: &Value,
    marks: &[(String, u64)],
) -> Result<Vec<crate::read_marks::Unread>, CliError> {
    let rows = value["unread"]
        .as_array()
        .ok_or_else(|| CliError::generic("Invalid unread counts."))?;
    let mut counts = Vec::new();
    for row in rows {
        let (Some(channel), Some(after), Some(count), Some(to_you)) = (
            row["channel"].as_str(),
            row["after"].as_u64(),
            row["count"].as_u64(),
            row["toYou"].as_u64(),
        ) else {
            return Err(CliError::generic("Invalid unread counts."));
        };
        if !marks
            .iter()
            .any(|(name, id)| name == channel && *id == after)
        {
            continue;
        }
        counts.push(crate::read_marks::Unread {
            channel: channel.to_string(),
            after,
            count,
            to_you: to_you.min(count),
            capped: row["capped"].as_bool() == Some(true),
        });
    }
    Ok(counts)
}

/// The owner's active board mutes (ADR 0044).
pub fn list_mutes(
    client: &MsnClient,
    tenant: &str,
    token: &str,
) -> Result<Vec<msn_cli::mutes::Mute>, CliError> {
    slug(tenant)?;
    let value = msn_cli::mutes::list_with(client, tenant, token)?;
    let rows = value["mutes"]
        .as_array()
        .ok_or_else(|| CliError::generic("Invalid response field mutes."))?;
    Ok(rows
        .iter()
        .filter_map(msn_cli::mutes::Mute::from_value)
        .collect())
}

/// Mutes one board for the owner: 1h, 1d or (`None`) until turned back on.
pub fn set_mute(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    duration: Option<&str>,
    everything: bool,
) -> Result<(), CliError> {
    slug(tenant)?;
    slug(channel)?;
    msn_cli::mutes::mute_with(client, tenant, token, channel, duration, everything).map(|_| ())
}

pub fn clear_mute(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
) -> Result<(), CliError> {
    slug(tenant)?;
    slug(channel)?;
    msn_cli::mutes::unmute_with(client, tenant, token, channel)
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

/// Searches by words and an optional sender. With `all` false it searches one channel and checks
/// every result's workspace and channel, so a confused server cannot place another board's
/// message in this view. With `all` true it searches every board the key can read (ADR 0073);
/// the server picks the boards from the key, and every result must name a board of this workspace.
#[allow(clippy::too_many_arguments)]
pub fn search_messages(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    text: &str,
    from: Option<&str>,
    before: Option<u64>,
    all: bool,
) -> Result<SearchPage, CliError> {
    slug(tenant)?;
    slug(channel)?;
    let text = (!text.trim().is_empty()).then_some(text);
    let search = msn_cli::search::Search {
        text,
        from,
        before,
        limit: msn_cli::search::DEFAULT_LIMIT,
        ..Default::default()
    };
    let path = if all {
        msn_cli::search::path_all(tenant, &search, false)?
    } else {
        msn_cli::search::path(tenant, channel, &search)?
    };
    let value = get_json(client, &path, token)?;
    parse_search_page(&value, tenant, (!all).then_some(channel))
}

/// `channel` is the one board every result must be on, or `None` for a search of every board,
/// where each result must name some board (a valid slug) of this workspace.
pub fn parse_search_page(
    value: &Value,
    tenant: &str,
    channel: Option<&str>,
) -> Result<SearchPage, CliError> {
    let invalid = || CliError::generic("Search response did not match this workspace and channel.");
    let messages = value["messages"].as_array().ok_or_else(invalid)?;
    let mut last = u64::MAX;
    for message in messages {
        let id = message["id"].as_u64().ok_or_else(invalid)?;
        let board = message["channel"].as_str().ok_or_else(invalid)?;
        let board_ok = match channel {
            Some(channel) => board == channel,
            None => slug(board).is_ok(),
        };
        if id >= last || !board_ok || message["tenant"].as_str() != Some(tenant) {
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
/// The board's pinned messages (ADR 0038), in message order. Rows that name another workspace or
/// channel are dropped. A server without pins (404) or a plain channel simply has none.
pub fn fetch_pins(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
) -> Result<Vec<Value>, CliError> {
    slug(tenant)?;
    slug(channel)?;
    let value = get_json(
        client,
        &format!("/api/tenants/{tenant}/channels/{channel}/pins"),
        token,
    )?;
    Ok(parse_pins(&value, tenant, channel))
}

pub fn parse_pins(value: &Value, tenant: &str, channel: &str) -> Vec<Value> {
    value["pins"]
        .as_array()
        .map(|pins| {
            pins.iter()
                .filter(|pin| {
                    pin["tenant"].as_str() == Some(tenant)
                        && pin["channel"].as_str() == Some(channel)
                        && pin["id"].as_u64().is_some()
                })
                .take(10)
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

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
    fn unread_answers_must_match_what_was_asked() {
        let marks = vec![("work".to_string(), 7), ("ops".to_string(), 3)];
        let counts = parse_unread(
            &json!({"unread": [
                {"channel": "work", "after": 7, "count": 4, "toYou": 9, "capped": true},
                {"channel": "ops", "after": 2, "count": 1, "toYou": 0},
                {"channel": "other", "after": 1, "count": 1, "toYou": 0}
            ], "cap": 99}),
            &marks,
        )
        .unwrap();
        assert_eq!(counts.len(), 1);
        assert_eq!(counts[0].channel, "work");
        assert_eq!(
            (counts[0].count, counts[0].to_you, counts[0].capped),
            (4, 4, true)
        );
        assert!(parse_unread(&json!({"unread": [{"channel": "work"}]}), &marks).is_err());
        assert!(parse_unread(&json!({}), &marks).is_err());
    }

    #[test]
    fn search_pages_must_belong_to_the_channel_and_run_newest_first() {
        let message = |id: u64, channel: &str| json!({"id": id, "tenant": "t", "channel": channel});
        let page = parse_search_page(
            &json!({"messages": [message(9, "c"), message(4, "c")], "hasMore": true, "nextBefore": 4, "complete": false}),
            "t",
            Some("c"),
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
            assert!(parse_search_page(&bad, "t", Some("c")).is_err(), "{bad}");
        }
    }

    #[test]
    fn every_board_search_pages_may_mix_boards_of_this_workspace_only() {
        let message = |id: u64, tenant: &str, channel: &str| json!({"id": id, "tenant": tenant, "channel": channel});
        let mixed = json!({"messages": [message(9, "t", "ops"), message(4, "t", "c")], "hasMore": false, "complete": true});
        let page = parse_search_page(&mixed, "t", None).unwrap();
        assert_eq!(page.messages.len(), 2);
        // The same page is refused where one board was asked for.
        assert!(parse_search_page(&mixed, "t", Some("c")).is_err());
        for bad in [
            json!({"messages": [message(9, "other", "ops")], "hasMore": false}),
            json!({"messages": [message(4, "t", "c"), message(9, "t", "ops")], "hasMore": false}),
            json!({"messages": [message(9, "t", "Not A Slug")], "hasMore": false}),
            json!({"messages": [{"id": 9, "tenant": "t"}], "hasMore": false}),
        ] {
            assert!(parse_search_page(&bad, "t", None).is_err(), "{bad}");
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
    fn scheduled_lists_keep_only_this_boards_rows() {
        let row = json!({"id": 3, "channel": "general", "text": "later", "sendAt": "2026-11-21T09:00:00.000Z", "status": "pending"});
        assert_eq!(
            parse_scheduled(&json!({"scheduled": [row.clone()]}), "general").unwrap(),
            vec![row.clone()]
        );
        assert!(parse_scheduled(&json!({"scheduled": [row]}), "other").is_err());
        assert!(parse_scheduled(&json!({}), "general").is_err());
        assert!(
            parse_scheduled(
                &json!({"scheduled": [{"id": 1, "channel": "general", "text": "x"}]}),
                "general"
            )
            .is_err()
        );
    }

    #[test]
    fn edit_pages_keep_this_channels_messages_and_the_cursor() {
        let row = json!({"id": 4, "channel": "general", "text": "fixed", "editedAt": "2026-11-20T00:00:00Z"});
        let (page, cursor, more) = parse_edits(
            &json!({"edits": [row.clone()], "editCursor": 9, "hasMore": false}),
            "general",
        )
        .unwrap();
        assert_eq!((page, cursor, more), (vec![row.clone()], 9, false));
        assert!(
            parse_edits(
                &json!({"edits": [row], "editCursor": 9, "hasMore": false}),
                "other"
            )
            .is_err()
        );
        assert!(parse_edits(&json!({"edits": [], "hasMore": false}), "general").is_err());
        assert!(parse_edits(&json!({"edits": [{"id": 1, "channel": "general"}], "editCursor": 1, "hasMore": false}), "general").is_err());
    }

    #[test]
    fn claim_lists_parse_and_a_page_without_one_says_unknown() {
        // Take a request (ADR 0075): claims ride on the reactions page.
        let page = parse_claims(&json!({
            "reactions": [],
            "claims": [{"id": 4, "claim": {"username": "dev", "claimedAt": "2026-11-21T18:00:00.000Z"}}],
            "hasMore": false,
        }))
        .unwrap()
        .unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(
            (page[0].0, page[0].1["username"].as_str()),
            (4, Some("dev"))
        );
        assert_eq!(
            parse_claims(&json!({"reactions": [], "claims": []})).unwrap(),
            Some(vec![])
        );
        // A server from before ADR 0075 sends no list: unknown, not "nobody".
        assert_eq!(parse_claims(&json!({"reactions": []})).unwrap(), None);
        assert!(parse_claims(&json!({"claims": {}})).is_err());
        assert!(parse_claims(&json!({"claims": [{"id": 4}]})).is_err());
        assert!(parse_claims(&json!({"claims": [{"claim": {"username": "dev"}}]})).is_err());
    }

    #[test]
    fn reaction_pages_parse_ids_kinds_and_the_next_cursor() {
        let (page, next) = parse_reactions(&json!({
            "reactions": [{"id": 3, "reactions": {"done": ["lead"]}}],
            "hasMore": true,
            "nextAfter": 3
        }))
        .unwrap();
        assert_eq!(page, vec![(3, json!({"done": ["lead"]}))]);
        assert_eq!(next, Some(3));
        let (empty, end) = parse_reactions(&json!({"reactions": [], "hasMore": false})).unwrap();
        assert!(empty.is_empty() && end.is_none());
        assert!(parse_reactions(&json!({"reactions": [{"id": 1}]})).is_err());
        assert!(parse_reactions(&json!({"reactions": [], "hasMore": true})).is_err());
        assert!(parse_reactions(&json!({})).is_err());
    }

    #[test]
    fn pins_keep_only_this_streams_rows() {
        let value = json!({"pins": [
            {"id": 1, "tenant": "t", "channel": "c", "text": "rules"},
            {"id": 2, "tenant": "x", "channel": "c"},
            {"id": 3, "tenant": "t", "channel": "other"},
            {"tenant": "t", "channel": "c"}
        ]});
        let pins = parse_pins(&value, "t", "c");
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0]["text"], "rules");
        assert!(parse_pins(&json!({}), "t", "c").is_empty());
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
