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
//!
//! Default mode (ADR 0053): with neither `--resumable` nor `--local` (and `MSN_RESUMABLE` unset),
//! progress goes to the server, so processed-by receipts (ADR 0040) name this reader.
//! D1 default_peek_claims_and_commits_on_server -> tests/processing.rs::default_peek_and_commit_use_the_server
//! D2 default_held_reader_stays_local_and_names_takeover -> tests/processing.rs::default_held_reader_stays_local_and_names_takeover
//! D3 default_keeps_local_when_server_cannot_hold_progress (held, watch-only, bound to another name, old server), remembered -> tests/processing.rs::default_falls_back_to_local_for_watch_only_and_old_servers
//! D5 resumable_claims_and_clears_a_kept_local_reader -> tests/processing.rs::resumable_claims_and_clears_a_kept_local_reader
//! D6 kept_local_other_than_held_is_retried_after_a_day -> tests/processing.rs::kept_local_other_than_held_is_retried_after_a_day
//! D4 local_flag_and_env_keep_progress_local -> tests/processing.rs::local_flag_and_env_keep_progress_local

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

/// Where a reader's processing progress lives (ADR 0053).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The default: send commits to the server, unless this key's progress cannot be there (another
    /// machine holds the reader, a watch-only key, a key bound to another name, a server older than
    /// ADR 0034); then progress stays on this machine, and the file remembers that choice.
    Default,
    /// `--resumable` or `MSN_RESUMABLE=1`: the server or an error, never a fallback.
    Server,
    /// `--local` or `MSN_RESUMABLE=0`: progress stays on this machine; no receipts.
    Local,
}

/// Reads `MSN_RESUMABLE` the way clap reads a boolean env: `0`, `false`, `no`, `off`, `n` and `f`
/// keep progress local, any other non-empty value forces the server, unset or empty is the default.
pub fn mode_from_env() -> Mode {
    parse_mode(std::env::var("MSN_RESUMABLE").ok().as_deref())
}

fn parse_mode(value: Option<&str>) -> Mode {
    let value = value.unwrap_or_default().trim().to_ascii_lowercase();
    match value.as_str() {
        "" => Mode::Default,
        "0" | "false" | "no" | "off" | "n" | "f" => Mode::Local,
        _ => Mode::Server,
    }
}

/// Flags win over the environment; clap keeps `--resumable` and `--local` apart.
pub fn mode(resumable: bool, local: bool) -> Mode {
    if resumable {
        Mode::Server
    } else if local {
        Mode::Local
    } else {
        mode_from_env()
    }
}

/// What a resumable step did when the default mode allows keeping progress local.
enum Outcome {
    Done,
    /// Carry on locally. `Some` is a one-time explanation to print; `None` means the choice was
    /// already made (and explained) on an earlier peek.
    KeepLocal(Option<String>),
}

/// The claim refusals after which default mode keeps progress local (ADR 0053), as
/// (code to remember, one-time explanation). Each means "this reader's progress cannot be on the
/// server for this key right now", never "take it over": a reader held by another machine stays
/// theirs, a watch-only key (ADR 0039) or a key bound to another name may not commit as this
/// reader, and a server before ADR 0034 has no route. Anything else is an error.
fn keep_local(response: &RawResponse, channel: &str, reader: &str) -> Option<(String, String)> {
    let code = error_code(&response.body)?;
    let why = match (response.status, code.as_str()) {
        (409, "processing_held") => {
            let holder = serde_json::from_str::<Value>(&response.body)
                .ok()
                .and_then(|v| v["error"]["details"]["holder"].as_str().map(str::to_string))
                .unwrap_or_else(|| "another machine".into());
            format!(
                "Reader '{reader}' on {channel} is held by {holder}, so this agent keeps its progress on this machine and no receipt names it. If that agent is gone for good, run msn takeover {channel} --reader '{reader}'; pass --resumable to require server progress."
            )
        }
        (403, "watch_only") => "This key is watch-only, so processing progress stays on this machine and no receipt names this reader.".into(),
        (403, "username_bound") => "This key is bound to another name, so this reader's processing progress stays on this machine and no receipt names it.".into(),
        (404, "route_not_found") => "This server does not keep processing progress, so it stays on this machine and no receipt names this reader.".into(),
        _ => return None,
    };
    let later = if code == "processing_held" {
        "Later peeks for this reader stay local without asking again."
    } else {
        "Later peeks stay local and ask the server again after a day."
    };
    Some((code, format!("{why} {later}")))
}

/// How long a remembered fallback lasts before default mode asks the server again (ADR 0053).
const RETRY_KEPT_LOCAL_SECS: u64 = 24 * 60 * 60;

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// A held reader stays local until someone acts (`msn takeover` or `--resumable`): retrying could
/// only find it held again. The other reasons can go away on their own (a server upgrade, a new
/// key), so they are retried once a day; a missing time counts as due.
fn kept_local_still_applies(state: &ProcessingState) -> bool {
    match (state.kept_local.as_deref(), state.kept_local_at) {
        (None, _) => false,
        (Some("processing_held"), _) => true,
        (Some(_), Some(at)) => now_secs().saturating_sub(at) < RETRY_KEPT_LOCAL_SECS,
        (Some(_), None) => false,
    }
}

fn note(reason: &str) {
    let _ = writeln!(io::stderr(), "msn: {reason}");
}

/// Peek in the given mode. Default mode claims the reader on the server on first use.
#[allow(clippy::too_many_arguments)]
pub(crate) fn peek_with(
    mode: Mode,
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
    if mode == Mode::Local {
        return crate::processing::peek_to(
            out,
            url,
            tenant,
            token,
            channel,
            reader,
            cursor_file,
            wait,
            limit,
            stop,
        );
    }
    let fallback = mode == Mode::Default;
    match peek_inner(
        out,
        url,
        tenant,
        token,
        channel,
        reader,
        cursor_file,
        wait,
        limit,
        stop,
        fallback,
    )? {
        Outcome::Done => Ok(()),
        Outcome::KeepLocal(reason) => {
            if let Some(reason) = reason {
                note(&reason);
            }
            crate::processing::peek_to(
                out,
                url,
                tenant,
                token,
                channel,
                reader,
                cursor_file,
                wait,
                limit,
                stop,
            )
        }
    }
}

/// Commit in the given mode. Default mode follows the progress file: a reader that a peek claimed
/// on the server commits there; one that stayed local (watch-only, older server) commits locally.
#[allow(clippy::too_many_arguments)]
pub(crate) fn commit_with(
    mode: Mode,
    out: &mut dyn Write,
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    reader: &str,
    cursor_file: Option<&Path>,
    through: u64,
) -> Result<(), CliError> {
    if mode == Mode::Local {
        return crate::processing::commit_to(
            out,
            url,
            tenant,
            channel,
            reader,
            cursor_file,
            through,
        );
    }
    match commit_inner(
        out,
        url,
        tenant,
        token,
        channel,
        reader,
        cursor_file,
        through,
        mode == Mode::Default,
    )? {
        Outcome::Done => Ok(()),
        Outcome::KeepLocal(_) => {
            crate::processing::commit_to(out, url, tenant, channel, reader, cursor_file, through)
        }
    }
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
                "{} Holder: {holder}. If that agent is gone for good, take over explicitly: msn takeover {channel} --reader '{reader}'. Without --resumable, this agent would keep its progress on this machine instead (no receipts).",
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
) -> Result<Result<Value, RawResponse>, CliError> {
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
        return Ok(Err(response));
    }
    json_body(&response).map(Ok)
}

#[allow(clippy::too_many_arguments)]
pub fn peek(
    mode: Mode,
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
    peek_with(
        mode,
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
/// With `fallback`, a server that cannot hold progress for this key leaves the file untouched and
/// returns `KeepLocal`, after the lock is released, so the caller can peek locally.
#[allow(clippy::too_many_arguments)]
fn peek_inner(
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
    fallback: bool,
) -> Result<Outcome, CliError> {
    validate_bounds(wait, limit)?;
    reader_hash(reader)?;
    let path = resolve_path(url, tenant, reader, channel, cursor_file)?;
    let lock = CursorLock::acquire(&path)?;
    let path = lock.cursor_path();
    let mut state = load_processing(path, &ProcessingState::fresh(url, tenant, channel, reader))?;
    if stop.load(Ordering::SeqCst) {
        return Ok(Outcome::Done);
    }
    let client = Arc::new(MsnClient::new(url)?);
    let generation = match state.generation {
        Some(generation) => generation,
        // Default mode already chose local for this reader: no claim request on every peek.
        None if fallback && kept_local_still_applies(&state) => {
            return Ok(Outcome::KeepLocal(None));
        }
        None => {
            // First resumable use: claim only an unheld reader, carrying local progress forward.
            let carry = (state.committed_through > 0).then_some(state.committed_through);
            let claimed = match claim(&client, tenant, token, channel, reader, 0, carry)? {
                Ok(claimed) => claimed,
                Err(response) => {
                    if fallback && let Some((code, why)) = keep_local(&response, channel, reader) {
                        state.kept_local = Some(code);
                        state.kept_local_at = Some(now_secs());
                        write_processing(path, &state)?;
                        return Ok(Outcome::KeepLocal(Some(why)));
                    }
                    return Err(refusal(&response, channel, reader));
                }
            };
            let generation = generation_of(&claimed, "generation")?;
            let committed = generation_of(&claimed, "committedThrough")?;
            state.generation = Some(generation);
            state.kept_local = None;
            state.kept_local_at = None;
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
        return Ok(Outcome::Done);
    };
    let response = response?;
    if !(200..300).contains(&response.status) {
        return Err(refusal(&response, channel, reader));
    }
    let server: Value = json_body(&response)?;
    let committed = generation_of(&server, "committedThrough")?;
    let (mut page, last_id) = parse_processing_page(&response.body, tenant, channel, committed)?;
    crate::processing::note_edits(
        &page,
        &mut state,
        tenant,
        channel,
        committed,
        last_id.is_none(),
    )?;
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
    Ok(Outcome::Done)
}

#[allow(clippy::too_many_arguments)]
pub fn commit(
    mode: Mode,
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    reader: &str,
    cursor_file: Option<&Path>,
    through: u64,
) -> Result<(), CliError> {
    commit_with(
        mode,
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

/// Resumable commit: the server checks the generation and writes in one transaction. With
/// `follow_file`, a progress file that was never claimed on the server returns `KeepLocal`.
#[allow(clippy::too_many_arguments)]
fn commit_inner(
    out: &mut dyn Write,
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    reader: &str,
    cursor_file: Option<&Path>,
    through: u64,
    follow_file: bool,
) -> Result<Outcome, CliError> {
    if through > MAX_SAFE_INTEGER {
        return Err(CliError::usage(format!("Invalid integer: {through}")));
    }
    reader_hash(reader)?;
    let path = resolve_path(url, tenant, reader, channel, cursor_file)?;
    let lock = CursorLock::acquire(&path)?;
    let path = lock.cursor_path();
    let mut state = load_processing(path, &ProcessingState::fresh(url, tenant, channel, reader))?;
    let Some(generation) = state.generation else {
        if follow_file {
            return Ok(Outcome::KeepLocal(None));
        }
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
    if state.edits_committed.is_some() {
        state.edits_committed = Some(state.edits_fetched);
    }
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
    Ok(Outcome::Done)
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
    let claimed = claim(&client, tenant, token, channel, reader, previous, carry)?
        .map_err(|response| refusal(&response, channel, reader))?;
    let generation = generation_of(&claimed, "generation")?;
    let committed = generation_of(&claimed, "committedThrough")?;
    // The replaced machine's highestFetched is unknown here; peek again before committing.
    let state = ProcessingState {
        committed_through: committed,
        highest_fetched: committed,
        generation: Some(generation),
        // Edits this machine already handled stay handled (ADR 0052).
        edits_committed: local.edits_committed,
        edits_fetched: local.edits_committed.unwrap_or(0),
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
