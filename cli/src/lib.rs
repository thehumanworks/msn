pub mod args;
pub mod client;
pub mod config;
pub mod cursor;
pub mod error;

use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use url::Url;
use uuid::Uuid;

use args::{Cli, Command};
use client::{
    MsnClient, classify, error_message, is_retryable_status, print_success, status_error,
};
use config::{
    CHANNELS_PAGE_LIMIT, MAX_LIMIT, MAX_SAFE_INTEGER, MAX_WAIT, parse_int, require_correlation_id,
    require_tenant, require_text, require_token, require_username, slug,
};
use cursor::{CursorBinding, load_cursor, write_cursor};
use error::CliError;

const BACKOFF_START_MS: u64 = 1000;
const BACKOFF_MAX_MS: u64 = 15000;

pub fn execute(cli: Cli, stop: Arc<AtomicBool>) -> Result<(), CliError> {
    let url = config::parse_origin(&cli.url)?;
    match cli.command {
        Command::Health => health(&url),
        Command::Channels => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            channels(&url, &tenant, &token)
        }
        Command::Create { channel } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            create(&url, &tenant, &token, channel)
        }
        Command::Send {
            channel,
            text,
            key,
            reply_to,
            correlation_id,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let username = require_username(cli.username.as_deref())?;
            let channel = slug(&channel)?;
            let reply_to = reply_to
                .as_deref()
                .map(|raw| parse_int(raw, MAX_SAFE_INTEGER))
                .transpose()?;
            let correlation_id = correlation_id
                .as_deref()
                .map(require_correlation_id)
                .transpose()?;
            let text = read_text(&text)?;
            send(
                &url,
                &tenant,
                &token,
                channel,
                &username,
                &text,
                key.as_deref(),
                Correlation {
                    reply_to,
                    correlation_id,
                },
            )
        }
        Command::Poll {
            channel,
            after,
            wait,
            limit,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let after = parse_optional_int(after.as_deref(), 0, MAX_SAFE_INTEGER)?;
            let wait = parse_optional_int(wait.as_deref(), 0, MAX_WAIT)?;
            let limit = parse_optional_int(limit.as_deref(), 100, MAX_LIMIT)?;
            if limit < 1 {
                return Err(CliError::usage("limit must be an integer from 1 to 100."));
            }
            poll(&url, &tenant, &token, channel, after, wait, limit)
        }
        Command::Follow {
            channel,
            after,
            wait,
            limit,
            cursor_file,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let wait = parse_optional_int(wait.as_deref(), 25, MAX_WAIT)?;
            let limit = parse_optional_int(limit.as_deref(), 100, MAX_LIMIT)?;
            if wait < 1 {
                return Err(CliError::usage("limit and follow wait must be positive."));
            }
            if limit < 1 {
                return Err(CliError::usage("limit and follow wait must be positive."));
            }
            if after.is_some() && cursor_file.is_some() {
                return Err(CliError::usage(
                    "Use either --after or --cursor-file, not both.",
                ));
            }
            let mut cursor_after = parse_optional_int(after.as_deref(), 0, MAX_SAFE_INTEGER)?;
            let file = cursor_file.map(PathBuf::from);
            if let Some(path) = file.as_ref() {
                let binding = CursorBinding::new(&url, &tenant, channel, 0);
                cursor_after = load_cursor(path, &binding)?;
            }
            follow(
                &url,
                &tenant,
                &token,
                channel,
                cursor_after,
                wait,
                limit,
                file.as_deref(),
                stop,
            )
        }
        Command::Provision { tenant } => {
            let token = require_token(cli.admin_token.as_deref(), "MSN_ADMIN_TOKEN")?;
            let tenant = slug(&tenant)?;
            provision(&url, tenant, &token)
        }
        Command::Rotate { tenant } => {
            let token = require_token(cli.admin_token.as_deref(), "MSN_ADMIN_TOKEN")?;
            let tenant = slug(&tenant)?;
            rotate(&url, tenant, &token)
        }
        Command::Delete {
            channel,
            message_id,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.admin_token.as_deref(), "MSN_ADMIN_TOKEN")?;
            let channel = slug(&channel)?;
            let id = parse_int(&message_id, MAX_SAFE_INTEGER)?;
            delete(&url, &tenant, &token, channel, id)
        }
    }
}

fn parse_optional_int(raw: Option<&str>, default: u64, max: u64) -> Result<u64, CliError> {
    match raw {
        None => Ok(default),
        Some(value) => parse_int(value, max),
    }
}

fn read_text(text: &str) -> Result<String, CliError> {
    if text == "-" {
        let mut buf = String::new();
        io::stdin().read_to_string(&mut buf)?;
        return require_text(&buf);
    }
    require_text(text)
}

fn health(url: &Url) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    finish(&client.get("/api/health", None)?)
}

fn channels(url: &Url, tenant: &str, token: &str) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    let path = format!("/api/tenants/{tenant}/channels?limit={CHANNELS_PAGE_LIMIT}");
    finish(&client.get(&path, Some(token))?)
}

fn create(url: &Url, tenant: &str, token: &str, channel: &str) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    finish(&client.put(&format!("/api/tenants/{tenant}/channels/{channel}"), token)?)
}

/// Optional correlation fields for `send`; `None` leaves the field out of the JSON body entirely.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Correlation {
    pub reply_to: Option<u64>,
    pub correlation_id: Option<String>,
}

/// The POST body for a send. Unset correlation fields are omitted, so a plain send is byte-for-byte
/// what older CLIs produced and idempotency replays keep matching.
pub fn send_body(username: &str, text: &str, correlation: &Correlation) -> Value {
    let mut body = json!({ "username": username, "text": text });
    if let Some(reply_to) = correlation.reply_to {
        body["replyTo"] = json!(reply_to);
    }
    if let Some(correlation_id) = &correlation.correlation_id {
        body["correlationId"] = json!(correlation_id);
    }
    body
}

#[allow(clippy::too_many_arguments)]
fn send(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    username: &str,
    text: &str,
    key: Option<&str>,
    correlation: Correlation,
) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    let key = key
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    eprintln!("Idempotency-Key: {key}");
    let _ = io::stderr().flush();
    let body = send_body(username, text, &correlation);
    let response = client.post_json(
        &format!("/api/tenants/{tenant}/channels/{channel}/messages"),
        token,
        &[("Idempotency-Key", key.as_str())],
        &body,
    )?;
    finish(&response)
}

fn poll(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    after: u64,
    wait: u64,
    limit: u64,
) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    let path = format!(
        "/api/tenants/{tenant}/channels/{channel}/messages?after={after}&wait={wait}&limit={limit}"
    );
    finish(&client.get(&path, Some(token))?)
}

fn provision(url: &Url, tenant: &str, token: &str) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    finish(&client.put(&format!("/api/admin/tenants/{tenant}"), token)?)
}

fn rotate(url: &Url, tenant: &str, token: &str) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    finish(&client.post(&format!("/api/admin/tenants/{tenant}/token"), token)?)
}

fn delete(url: &Url, tenant: &str, token: &str, channel: &str, id: u64) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    finish(&client.delete(
        &format!("/api/admin/tenants/{tenant}/channels/{channel}/messages/{id}"),
        token,
    )?)
}

fn finish(response: &client::RawResponse) -> Result<(), CliError> {
    classify(response.status, &response.body)?;
    print_success(response.status, &response.body)
}

#[allow(clippy::too_many_arguments)]
fn follow(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    mut after: u64,
    wait: u64,
    limit: u64,
    cursor_file: Option<&std::path::Path>,
    stop: Arc<AtomicBool>,
) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    let mut backoff_ms = BACKOFF_START_MS;
    while !stop.load(Ordering::SeqCst) {
        let path = format!(
            "/api/tenants/{tenant}/channels/{channel}/messages?after={after}&wait={wait}&limit={limit}"
        );
        match client.get(&path, Some(token)) {
            Ok(response) if (200..300).contains(&response.status) => {
                emit_follow_page(&response.body, &mut after)?;
                if let Some(path) = cursor_file {
                    write_cursor(path, &CursorBinding::new(url, tenant, channel, after))?;
                }
                backoff_ms = BACKOFF_START_MS;
            }
            Ok(response) if (300..400).contains(&response.status) => {
                return Err(CliError::network("Redirects are not allowed"));
            }
            Ok(response) if is_retryable_status(response.status) => {
                let message = error_message(response.status, &response.body);
                if interruptible_sleep(backoff_ms, &stop, &message, after) {
                    return Ok(());
                }
                backoff_ms = (backoff_ms.saturating_mul(2)).min(BACKOFF_MAX_MS);
            }
            Ok(response) => return Err(status_error(response.status, &response.body)),
            Err(error) => {
                // MsnClient maps transport failures to exit 6; retry those.
                if interruptible_sleep(backoff_ms, &stop, &error.to_string(), after) {
                    return Ok(());
                }
                backoff_ms = (backoff_ms.saturating_mul(2)).min(BACKOFF_MAX_MS);
            }
        }
    }
    Ok(())
}

fn emit_follow_page(body: &str, after: &mut u64) -> Result<(), CliError> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(CliError::generic("Empty response body"));
    }
    let page: Value =
        serde_json::from_str(trimmed).map_err(|_| CliError::generic("Response was not JSON"))?;
    let messages = page
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| CliError::generic("Response was not JSON"))?;
    for message in messages {
        println!(
            "{}",
            serde_json::to_string(message).map_err(|e| CliError::generic(e.to_string()))?
        );
        io::stdout()
            .flush()
            .map_err(|error| CliError::generic(error.to_string()))?;
    }
    if let Some(next) = page.get("nextCursor") {
        if let Some(n) = next.as_u64() {
            *after = n;
        } else if let Some(s) = next.as_str() {
            *after = parse_int(s, MAX_SAFE_INTEGER)?;
        }
    }
    Ok(())
}

fn interruptible_sleep(backoff_ms: u64, stop: &AtomicBool, message: &str, after: u64) -> bool {
    eprintln!("{message}; reconnecting from cursor {after}");
    let _ = io::stderr().flush();
    let total = Duration::from_millis(backoff_ms);
    let start = std::time::Instant::now();
    while start.elapsed() < total {
        if stop.load(Ordering::SeqCst) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    stop.load(Ordering::SeqCst)
}

pub fn install_stop_signals() -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let _ = ctrlc::set_handler(move || {
        flag.store(true, Ordering::SeqCst);
        let _ = io::stdout().flush();
        let _ = io::stderr().flush();
        std::process::exit(0);
    });
    stop
}
