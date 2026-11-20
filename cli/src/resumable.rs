//! Resumable processing progress (ADR 0034): `committedThrough` lives on the server, so a
//! replacement agent on another machine resumes where the old one committed.
//!
//! Verification contract:
//! Goal: a reader has one holder at a time, a takeover is explicit, and a replaced generation can
//! never commit (or peek) again.
//! R1 first_peek_claims_and_carries_local_progress -> tests/processing.rs::resumable_first_peek_claims_with_local_progress
//! R2 held_reader_refuses_silent_claim -> tests/processing.rs::resumable_held_reader_names_takeover
//! R3 takeover_names_current_generation -> tests/processing.rs::takeover_sends_current_generation
//! R4 fenced_peek_and_commit_fail_closed -> tests/processing.rs::resumable_fenced_commit_is_conflict
//! R5 local_commands_refuse_resumable_files -> tests/processing.rs::local_commit_refuses_resumable_file
//! Server side (fence inside one storage transaction): tests/processing.test.ts.

use std::io::{self, Write};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};
use url::Url;

use crate::client::{MsnClient, RawResponse, classify, error_message};
use crate::config::MAX_SAFE_INTEGER;
use crate::cursor::{CursorLock, reader_hash};
use crate::error::CliError;
use crate::processing::{
    ProcessingState, get_interruptible, load_processing, parse_processing_page, resolve_path,
    validate_bounds, write_processing,
};

/// `MSN_RESUMABLE` turns resumable mode on for the MCP tools, read the way clap reads the
/// `--resumable` flag's env: unset, empty, `0`, `false`, `no`, `off`, `n` and `f` mean off.
pub fn enabled_by_env() -> bool {
    let value = std::env::var("MSN_RESUMABLE")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    !matches!(
        value.as_str(),
        "" | "0" | "false" | "no" | "off" | "n" | "f"
    )
}

/// A label for whoever holds the reader, shown to the person deciding on a takeover.
fn holder() -> Option<String> {
    let from_file = |path: &str| std::fs::read_to_string(path).ok();
    from_file("/proc/sys/kernel/hostname")
        .or_else(|| from_file("/etc/hostname"))
        .or_else(|| std::env::var("HOSTNAME").ok())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .map(|name| name.trim().chars().take(64).collect::<String>())
        .filter(|name| !name.is_empty())
}

fn base(tenant: &str, channel: &str, reader: &str) -> String {
    format!(
        "/api/tenants/{tenant}/channels/{channel}/processing/{}",
        encode(reader)
    )
}

/// Percent-encodes everything except unreserved characters, for a path segment or query value.
fn encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn error_code(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .get("error")?
        .get("code")?
        .as_str()
        .map(str::to_string)
}

fn json_body(response: &RawResponse) -> Result<Value, CliError> {
    serde_json::from_str(response.body.trim())
        .map_err(|_| CliError::generic("Response was not JSON."))
}

fn generation_of(value: &Value, field: &str) -> Result<u64, CliError> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .filter(|n| *n <= MAX_SAFE_INTEGER)
        .ok_or_else(|| CliError::generic(format!("Response is missing {field}.")))
}

/// Maps the fence and hold refusals to messages that tell the agent what to do next.
fn refusal(response: &RawResponse, channel: &str, reader: &str) -> CliError {
    match error_code(&response.body).as_deref() {
        Some("processing_fenced") => CliError::conflict(format!(
            "{} This agent was replaced on another machine. Stop processing {channel}; do not commit.",
            error_message(response.status, &response.body)
        )),
        Some("processing_held") => {
            let holder = serde_json::from_str::<Value>(&response.body)
                .ok()
                .and_then(|v| v["error"]["details"]["holder"].as_str().map(str::to_string))
                .unwrap_or_else(|| "unknown".into());
            CliError::conflict(format!(
                "{} Holder: {holder}. If that agent is gone for good, take over explicitly: msn takeover {channel} --reader '{reader}'",
                error_message(response.status, &response.body)
            ))
        }
        _ => match classify(response.status, &response.body) {
            Err(error) => error,
            Ok(()) => CliError::generic("Unexpected response."),
        },
    }
}

fn claim(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    reader: &str,
    expect: u64,
    carry: Option<u64>,
) -> Result<Value, CliError> {
    let mut body = json!({ "expectGeneration": expect, "holder": holder() });
    if let Some(through) = carry {
        body["committedThrough"] = json!(through);
    }
    let response = client.post_json(
        &format!("{}/claim", base(tenant, channel, reader)),
        token,
        &[],
        &body,
    )?;
    if !(200..300).contains(&response.status) {
        return Err(refusal(&response, channel, reader));
    }
    json_body(&response)
}

#[allow(clippy::too_many_arguments)]
pub fn peek(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    reader: &str,
    cursor_file: Option<&Path>,
    wait: u64,
    limit: u64,
    stop: Arc<AtomicBool>,
) -> Result<(), CliError> {
    peek_to(
        &mut io::stdout().lock(),
        url,
        tenant,
        token,
        channel,
        reader,
        cursor_file,
        wait,
        limit,
        &stop,
    )
}

/// Resumable peek: claims an unheld reader on first use, then reads after the server's
/// `committedThrough` with the generation fence on the same request (no extra round trip).
#[allow(clippy::too_many_arguments)]
pub(crate) fn peek_to(
    out: &mut dyn Write,
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    reader: &str,
    cursor_file: Option<&Path>,
    wait: u64,
    limit: u64,
    stop: &AtomicBool,
) -> Result<(), CliError> {
    validate_bounds(wait, limit)?;
    reader_hash(reader)?;
    let path = resolve_path(url, tenant, reader, channel, cursor_file)?;
    let lock = CursorLock::acquire(&path)?;
    let path = lock.cursor_path();
    let mut state = load_processing(path, &ProcessingState::fresh(url, tenant, channel, reader))?;
    if stop.load(Ordering::SeqCst) {
        return Ok(());
    }
    let client = Arc::new(MsnClient::new(url)?);
    let generation = match state.generation {
        Some(generation) => generation,
        None => {
            // First resumable use: claim only an unheld reader, carrying local progress forward.
            let carry = (state.committed_through > 0).then_some(state.committed_through);
            let claimed = claim(&client, tenant, token, channel, reader, 0, carry)?;
            let generation = generation_of(&claimed, "generation")?;
            let committed = generation_of(&claimed, "committedThrough")?;
            state.generation = Some(generation);
            state.committed_through = committed;
            state.highest_fetched = state.highest_fetched.max(committed);
            // Persist before reading: a crash here must not leave this machine locked out by itself.
            write_processing(path, &state)?;
            generation
        }
    };
    let request = format!(
        "/api/tenants/{tenant}/channels/{channel}/messages?processingReader={}&generation={generation}&wait={wait}&limit={limit}{}",
        encode(reader),
        crate::processing::edits_query(&state)
    );
    let Some(response) = get_interruptible(client, request, token.to_string(), stop)? else {
        return Ok(());
    };
    let response = response?;
    if !(200..300).contains(&response.status) {
        return Err(refusal(&response, channel, reader));
    }
    let server: Value = json_body(&response)?;
    let committed = generation_of(&server, "committedThrough")?;
    let (mut page, last_id) = parse_processing_page(&response.body, tenant, channel, committed)?;
    crate::processing::note_edits(&page, &mut state, tenant, channel, committed)?;
    state.committed_through = committed;
    state.highest_fetched = state
        .highest_fetched
        .max(committed)
        .max(last_id.unwrap_or(0));
    page["committedThrough"] = json!(committed);
    page["highestFetched"] = json!(state.highest_fetched);
    page["generation"] = json!(generation);
    let printed =
        serde_json::to_string(&page).map_err(|error| CliError::generic(error.to_string()))?;
    writeln!(out, "{printed}")?;
    out.flush()
        .map_err(|error| CliError::generic(error.to_string()))?;
    write_processing(path, &state)?;
    Ok(())
}

pub fn commit(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    reader: &str,
    cursor_file: Option<&Path>,
    through: u64,
) -> Result<(), CliError> {
    commit_to(
        &mut io::stdout().lock(),
        url,
        tenant,
        token,
        channel,
        reader,
        cursor_file,
        through,
    )
}

/// Resumable commit: the server checks the generation and writes in one transaction.
#[allow(clippy::too_many_arguments)]
pub(crate) fn commit_to(
    out: &mut dyn Write,
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    reader: &str,
    cursor_file: Option<&Path>,
    through: u64,
) -> Result<(), CliError> {
    if through > MAX_SAFE_INTEGER {
        return Err(CliError::usage(format!("Invalid integer: {through}")));
    }
    reader_hash(reader)?;
    let path = resolve_path(url, tenant, reader, channel, cursor_file)?;
    let lock = CursorLock::acquire(&path)?;
    let path = lock.cursor_path();
    let mut state = load_processing(path, &ProcessingState::fresh(url, tenant, channel, reader))?;
    let Some(generation) = state.generation else {
        return Err(CliError::usage(
            "Nothing to commit: run a resumable peek (or msn takeover) for this reader first.",
        ));
    };
    if through < state.committed_through {
        return Err(CliError::usage(
            "Commit --through is behind committedThrough.",
        ));
    }
    if through > state.highest_fetched {
        return Err(CliError::usage(
            "Commit --through is ahead of highestFetched.",
        ));
    }
    let response = MsnClient::new(url)?.post_json(
        &format!("{}/commit", base(tenant, channel, reader)),
        token,
        &[],
        &json!({ "generation": generation, "through": through }),
    )?;
    if !(200..300).contains(&response.status) {
        return Err(refusal(&response, channel, reader));
    }
    let saved = json_body(&response)?;
    state.committed_through = generation_of(&saved, "committedThrough")?;
    state.highest_fetched = state.highest_fetched.max(state.committed_through);
    state.edits_committed = state.edits_fetched;
    write_processing(path, &state)?;
    writeln!(
        out,
        "{}",
        serde_json::to_string(&json!({
            "committedThrough": state.committed_through,
            "highestFetched": state.highest_fetched,
            "generation": generation,
        }))
        .map_err(|error| CliError::generic(error.to_string()))?
    )?;
    out.flush()
        .map_err(|error| CliError::generic(error.to_string()))?;
    Ok(())
}

pub fn takeover(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    reader: &str,
    cursor_file: Option<&Path>,
) -> Result<(), CliError> {
    takeover_to(
        &mut io::stdout().lock(),
        url,
        tenant,
        token,
        channel,
        reader,
        cursor_file,
    )
}

/// The explicit takeover: read the current generation, then claim the next one naming it. A
/// concurrent takeover makes this fail with a mismatch instead of both agents winning.
pub(crate) fn takeover_to(
    out: &mut dyn Write,
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    reader: &str,
    cursor_file: Option<&Path>,
) -> Result<(), CliError> {
    reader_hash(reader)?;
    let path = resolve_path(url, tenant, reader, channel, cursor_file)?;
    let lock = CursorLock::acquire(&path)?;
    let path = lock.cursor_path();
    let local = load_processing(path, &ProcessingState::fresh(url, tenant, channel, reader))?;
    let client = MsnClient::new(url)?;
    let response = client.get(&base(tenant, channel, reader), Some(token))?;
    classify(response.status, &response.body)?;
    let current = json_body(&response)?;
    let previous = generation_of(&current, "generation")?;
    if previous > 0 && local.generation == Some(previous) {
        return Err(CliError::usage(
            "This machine already holds the reader; keep using peek and commit.",
        ));
    }
    let carry = (previous == 0 && local.committed_through > 0).then_some(local.committed_through);
    let claimed = claim(&client, tenant, token, channel, reader, previous, carry)?;
    let generation = generation_of(&claimed, "generation")?;
    let committed = generation_of(&claimed, "committedThrough")?;
    // The replaced machine's highestFetched is unknown here; peek again before committing.
    let state = ProcessingState {
        committed_through: committed,
        highest_fetched: committed,
        generation: Some(generation),
        // Edits this machine already handled stay handled (ADR 0052).
        edits_committed: local.edits_committed,
        edits_fetched: local.edits_committed,
        ..ProcessingState::fresh(url, tenant, channel, reader)
    };
    write_processing(path, &state)?;
    writeln!(
        out,
        "{}",
        serde_json::to_string(&json!({
            "channel": channel,
            "reader": reader,
            "generation": generation,
            "previousGeneration": previous,
            "previousHolder": current.get("holder").cloned().unwrap_or(Value::Null),
            "committedThrough": committed,
        }))
        .map_err(|error| CliError::generic(error.to_string()))?
    )?;
    out.flush()
        .map_err(|error| CliError::generic(error.to_string()))?;
    Ok(())
}
