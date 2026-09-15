pub mod args;
pub mod client;
pub mod config;
pub mod cursor;
pub mod error;

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
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
    CHANNELS_PAGE_LIMIT, MAX_LIMIT, MAX_SAFE_INTEGER, MAX_WAIT, parse_int, require_tenant,
    require_text, require_token, require_username, slug,
};
use cursor::{CursorBinding, default_cursor_path, load_cursor, write_cursor};
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
        Command::Send { channel, text, key } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let username = require_username(cli.username.as_deref())?;
            let channel = slug(&channel)?;
            let text = read_text(&text)?;
            send(
                &url,
                &tenant,
                &token,
                channel,
                &username,
                &text,
                key.as_deref(),
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
        Command::Wait {
            channel,
            after,
            wait,
            limit,
            cursor_file,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let (wait, limit) = parse_loop_bounds(wait.as_deref(), limit.as_deref())?;
            let file = match (&after, cursor_file) {
                (Some(_), Some(_)) => {
                    return Err(CliError::usage(
                        "Use either --after or --cursor-file, not both.",
                    ));
                }
                (Some(_), None) => None,
                (None, Some(path)) => Some(PathBuf::from(path)),
                (None, None) => {
                    let path = default_cursor_path(&url, &tenant, channel)?;
                    if let Some(parent) = path.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    Some(path)
                }
            };
            let cursor_after =
                resolve_cursor(&url, &tenant, channel, after.as_deref(), file.as_deref())?;
            let target = LoopTarget {
                url: &url,
                tenant: &tenant,
                token: &token,
                channel,
                wait,
                limit,
                cursor_file: file.as_deref(),
            };
            wait_for_messages(&target, cursor_after, stop)
        }
        Command::Follow {
            channel,
            after,
            wait,
            limit,
            cursor_file,
            once,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let (wait, limit) = parse_loop_bounds(wait.as_deref(), limit.as_deref())?;
            if after.is_some() && cursor_file.is_some() {
                return Err(CliError::usage(
                    "Use either --after or --cursor-file, not both.",
                ));
            }
            let file = cursor_file.map(PathBuf::from);
            let cursor_after =
                resolve_cursor(&url, &tenant, channel, after.as_deref(), file.as_deref())?;
            let target = LoopTarget {
                url: &url,
                tenant: &tenant,
                token: &token,
                channel,
                wait,
                limit,
                cursor_file: file.as_deref(),
            };
            follow(&target, cursor_after, once, stop)
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

/// `--wait` (default 25) and `--limit` (default 100) for the long-poll loops; both must be ≥ 1.
fn parse_loop_bounds(wait: Option<&str>, limit: Option<&str>) -> Result<(u64, u64), CliError> {
    let wait = parse_optional_int(wait, 25, MAX_WAIT)?;
    let limit = parse_optional_int(limit, 100, MAX_LIMIT)?;
    if wait < 1 || limit < 1 {
        return Err(CliError::usage("limit and follow wait must be positive."));
    }
    Ok((wait, limit))
}

/// `--after` when given, else the bound cursor file's value (0 when the file is absent).
fn resolve_cursor(
    url: &Url,
    tenant: &str,
    channel: &str,
    after: Option<&str>,
    cursor_file: Option<&Path>,
) -> Result<u64, CliError> {
    let after = parse_optional_int(after, 0, MAX_SAFE_INTEGER)?;
    match cursor_file {
        Some(path) => load_cursor(path, &CursorBinding::new(url, tenant, channel, after)),
        None => Ok(after),
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

fn send(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    username: &str,
    text: &str,
    key: Option<&str>,
) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    let key = key
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    eprintln!("Idempotency-Key: {key}");
    let _ = io::stderr().flush();
    let body = json!({ "username": username, "text": text });
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

/// Everything a long-poll loop needs besides the moving cursor.
struct LoopTarget<'a> {
    url: &'a Url,
    tenant: &'a str,
    token: &'a str,
    channel: &'a str,
    wait: u64,
    limit: u64,
    cursor_file: Option<&'a Path>,
}

/// A successfully fetched, validated `{messages,nextCursor,hasMore}` page.
struct Page<'a> {
    raw: &'a str,
    messages: &'a [Value],
    next_cursor: u64,
}

enum Flow {
    Continue,
    Stop,
}

fn follow(
    target: &LoopTarget<'_>,
    after: u64,
    once: bool,
    stop: Arc<AtomicBool>,
) -> Result<(), CliError> {
    poll_loop(target, after, stop, |page| {
        for message in page.messages {
            println!(
                "{}",
                serde_json::to_string(message).map_err(|e| CliError::generic(e.to_string()))?
            );
            io::stdout()
                .flush()
                .map_err(|error| CliError::generic(error.to_string()))?;
        }
        if once && !page.messages.is_empty() {
            Ok(Flow::Stop)
        } else {
            Ok(Flow::Continue)
        }
    })
}

fn wait_for_messages(
    target: &LoopTarget<'_>,
    after: u64,
    stop: Arc<AtomicBool>,
) -> Result<(), CliError> {
    poll_loop(target, after, stop, |page| {
        if page.messages.is_empty() {
            return Ok(Flow::Continue);
        }
        println!("{}", page.raw);
        io::stdout()
            .flush()
            .map_err(|error| CliError::generic(error.to_string()))?;
        Ok(Flow::Stop)
    })
}

/// GET pages from `after` until `on_page` says stop or a signal flips `stop`. Each 2xx page is
/// delivered to `on_page` first and only then persisted to the cursor file, so an interrupt can
/// replay a page but never skips one. 429/5xx/transport errors retry with 1s→15s backoff.
fn poll_loop(
    target: &LoopTarget<'_>,
    mut after: u64,
    stop: Arc<AtomicBool>,
    mut on_page: impl FnMut(&Page<'_>) -> Result<Flow, CliError>,
) -> Result<(), CliError> {
    let LoopTarget {
        url,
        tenant,
        token,
        channel,
        wait,
        limit,
        cursor_file,
    } = *target;
    let client = MsnClient::new(url)?;
    let mut backoff_ms = BACKOFF_START_MS;
    while !stop.load(Ordering::SeqCst) {
        let path = format!(
            "/api/tenants/{tenant}/channels/{channel}/messages?after={after}&wait={wait}&limit={limit}"
        );
        match client.get(&path, Some(token)) {
            Ok(response) if (200..300).contains(&response.status) => {
                let parsed = parse_page(&response.body)?;
                let page = Page {
                    raw: response.body.trim(),
                    messages: &parsed.0,
                    next_cursor: parsed.1.unwrap_or(after),
                };
                let flow = on_page(&page)?;
                after = page.next_cursor;
                if let Some(path) = cursor_file {
                    write_cursor(path, &CursorBinding::new(url, tenant, channel, after))?;
                }
                if matches!(flow, Flow::Stop) {
                    return Ok(());
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

/// Validates a messages page and returns its rows plus `nextCursor` (absent → `None`).
fn parse_page(body: &str) -> Result<(Vec<Value>, Option<u64>), CliError> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(CliError::generic("Empty response body"));
    }
    let mut page: Value =
        serde_json::from_str(trimmed).map_err(|_| CliError::generic("Response was not JSON"))?;
    let next_cursor = match page.get("nextCursor") {
        Some(Value::String(s)) => Some(parse_int(s, MAX_SAFE_INTEGER)?),
        Some(other) => other.as_u64(),
        None => None,
    };
    let messages = match page.get_mut("messages").map(Value::take) {
        Some(Value::Array(messages)) => messages,
        _ => return Err(CliError::generic("Response was not JSON")),
    };
    Ok((messages, next_cursor))
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
