//! Crash-safe processing progress, separate from the eager read cursor.
//!
//! Verification contract:
//! Goal: peek fetches after committedThrough without advancing it; commit advances
//! a monotonic prefix through an id that was actually fetched and printed.
//! I1 peek_fetches_after_committed_through -> tests/processing.rs::peek_query_uses_committed_through
//! I2 peek_never_advances_committed -> tests/processing.rs::peek_does_not_advance_committed_through
//! I3 highest_fetched_after_valid_page_and_stdout -> src/processing.rs::peek_persists_highest_only_after_stdout
//! I4 failed_auth_or_invalid_page_no_write -> tests/processing.rs::peek_auth_and_invalid_page_do_not_persist
//! I5 no_eager_cursor_adoption -> src/processing.rs::rejects_eager_after_cursor
//! I6 default_path_under_processing_not_readers -> src/processing.rs::default_path_uses_processing
//! I7 explicit_cursor_file_bound_to_reader -> src/processing.rs::explicit_file_rejects_foreign_reader
//! I8 commit_monotonic_and_bounded -> src/processing.rs::commit_rejects_future_and_backwards
//! I9 lock_excludes_second_worker -> tests/processing.rs::processing_lock_excludes_peer
//! I10 stdout_failure_replays -> src/processing.rs::peek_stdout_failure_does_not_persist
//! I11 isolation_by_origin_tenant_channel_reader -> src/processing.rs::default_path_isolates_bindings
//! Out of scope: command wiring (root), exactly-once side effects, server committedThrough.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;

use crate::client::{MsnClient, classify};
use crate::config::{MAX_LIMIT, MAX_SAFE_INTEGER, MAX_WAIT, origin_key, parse_int};
use crate::cursor::{CursorLock, origin_hash, reader_hash};
use crate::error::CliError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessingState {
    pub server: String,
    pub tenant: String,
    pub channel: String,
    pub reader: String,
    #[serde(rename = "committedThrough")]
    pub committed_through: u64,
    #[serde(rename = "highestFetched")]
    pub highest_fetched: u64,
    /// Set once this reader's progress is resumable on the server (ADR 0034); the fence on every
    /// resumable peek and commit. Absent for local-only progress, so older files stay valid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
}

impl ProcessingState {
    pub(crate) fn fresh(url: &Url, tenant: &str, channel: &str, reader: &str) -> Self {
        Self {
            server: origin_key(url),
            tenant: tenant.to_string(),
            channel: channel.to_string(),
            reader: reader.to_string(),
            committed_through: 0,
            highest_fetched: 0,
            generation: None,
        }
    }

    fn expected(url: &Url, tenant: &str, channel: &str, reader: &str) -> Self {
        Self::fresh(url, tenant, channel, reader)
    }
}

/// `$XDG_STATE_HOME` (or `$HOME/.local/state`) `/msn/<origin-hash>/<tenant>/processing/<reader-hash>/<channel>.json`.
pub fn default_processing_path(
    url: &Url,
    tenant: &str,
    reader: &str,
    channel: &str,
) -> Result<PathBuf, CliError> {
    let reader_hash = reader_hash(reader)?;
    let state_home = match std::env::var_os("XDG_STATE_HOME") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => match std::env::var_os("HOME") {
            Some(home) if !home.is_empty() => PathBuf::from(home).join(".local").join("state"),
            _ => {
                return Err(CliError::usage(
                    "Set HOME (or XDG_STATE_HOME), or pass --cursor-file.",
                ));
            }
        },
    };
    Ok(state_home
        .join("msn")
        .join(origin_hash(url))
        .join(tenant)
        .join("processing")
        .join(reader_hash)
        .join(format!("{channel}.json")))
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

pub fn commit(
    url: &Url,
    tenant: &str,
    channel: &str,
    reader: &str,
    cursor_file: Option<&Path>,
    through: u64,
) -> Result<(), CliError> {
    commit_to(
        &mut io::stdout().lock(),
        url,
        tenant,
        channel,
        reader,
        cursor_file,
        through,
    )
}

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
    let state = load_processing(
        path,
        &ProcessingState::expected(url, tenant, channel, reader),
    )?;
    refuse_resumable(&state)?;
    if stop.load(Ordering::SeqCst) {
        return Ok(());
    }
    let client = Arc::new(MsnClient::new(url)?);
    let request = format!(
        "/api/tenants/{tenant}/channels/{channel}/messages?after={}&wait={wait}&limit={limit}",
        state.committed_through
    );
    let Some(response) = get_interruptible(client, request, token.to_string(), stop)? else {
        return Ok(());
    };
    let response = response?;
    classify(response.status, &response.body)?;
    let (mut page, last_id) =
        parse_processing_page(&response.body, tenant, channel, state.committed_through)?;
    let highest_fetched = match last_id {
        Some(id) => state.highest_fetched.max(id),
        None => state.highest_fetched,
    };
    page["committedThrough"] = json!(state.committed_through);
    page["highestFetched"] = json!(highest_fetched);
    let printed =
        serde_json::to_string(&page).map_err(|error| CliError::generic(error.to_string()))?;
    writeln!(out, "{printed}")?;
    out.flush()
        .map_err(|error| CliError::generic(error.to_string()))?;
    if last_id.is_some() {
        let mut next = state;
        next.highest_fetched = highest_fetched;
        write_processing(path, &next)?;
    }
    Ok(())
}

pub(crate) fn commit_to(
    out: &mut dyn Write,
    url: &Url,
    tenant: &str,
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
    let mut state = load_processing(
        path,
        &ProcessingState::expected(url, tenant, channel, reader),
    )?;
    refuse_resumable(&state)?;
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
    state.committed_through = through;
    write_processing(path, &state)?;
    writeln!(
        out,
        "{}",
        serde_json::to_string(&json!({
            "committedThrough": state.committed_through,
            "highestFetched": state.highest_fetched,
        }))
        .map_err(|error| CliError::generic(error.to_string()))?
    )?;
    out.flush()
        .map_err(|error| CliError::generic(error.to_string()))?;
    Ok(())
}

/// Local-only commands must not move progress that the server now owns (ADR 0034).
fn refuse_resumable(state: &ProcessingState) -> Result<(), CliError> {
    if state.generation.is_some() {
        return Err(CliError::usage(
            "This reader's progress is resumable (kept on the server). Pass --resumable or set MSN_RESUMABLE=1.",
        ));
    }
    Ok(())
}

pub(crate) fn validate_bounds(wait: u64, limit: u64) -> Result<(), CliError> {
    if wait > MAX_WAIT {
        return Err(CliError::usage("wait must be an integer from 0 to 25."));
    }
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(CliError::usage("limit must be an integer from 1 to 100."));
    }
    Ok(())
}

pub(crate) fn resolve_path(
    url: &Url,
    tenant: &str,
    reader: &str,
    channel: &str,
    cursor_file: Option<&Path>,
) -> Result<PathBuf, CliError> {
    let path = match cursor_file {
        Some(path) => path.to_path_buf(),
        None => default_processing_path(url, tenant, reader, channel)?,
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(path)
}

pub(crate) fn load_processing(
    path: &Path,
    expected: &ProcessingState,
) -> Result<ProcessingState, CliError> {
    let raw = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(expected.clone());
        }
        Err(error) => return Err(CliError::generic(error.to_string())),
    };
    let value: Value = serde_json::from_str(&raw).map_err(|_| corrupt_state())?;
    if value.get("after").is_some() {
        return Err(CliError::usage(
            "Processing file is not a processing cursor (looks like an eager read cursor).",
        ));
    }
    let saved: ProcessingFile = serde_json::from_value(value).map_err(|_| corrupt_state())?;
    if saved.server != expected.server
        || saved.tenant != expected.tenant
        || saved.channel != expected.channel
        || saved.reader != expected.reader
    {
        return Err(CliError::usage(
            "Processing file belongs to a different server, tenant, channel or reader.",
        ));
    }
    let committed_through = parse_watermark(&saved.committed_through, "committedThrough")?;
    let highest_fetched = parse_watermark(&saved.highest_fetched, "highestFetched")?;
    if committed_through > highest_fetched {
        return Err(corrupt_state());
    }
    let generation = match &saved.generation {
        None | Some(Value::Null) => None,
        Some(value) => Some(parse_watermark(value, "generation")?),
    };
    Ok(ProcessingState {
        server: saved.server,
        tenant: saved.tenant,
        channel: saved.channel,
        reader: saved.reader,
        committed_through,
        highest_fetched,
        generation,
    })
}

pub(crate) fn write_processing(path: &Path, state: &ProcessingState) -> Result<(), CliError> {
    if state.committed_through > state.highest_fetched {
        return Err(corrupt_state());
    }
    let payload =
        serde_json::to_string(state).map_err(|error| CliError::generic(error.to_string()))?;
    let tmp = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp)?;
    file.write_all(payload.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path)?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(path, perms)?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct ProcessingFile {
    server: String,
    tenant: String,
    channel: String,
    reader: String,
    #[serde(rename = "committedThrough")]
    committed_through: Value,
    #[serde(rename = "highestFetched")]
    highest_fetched: Value,
    #[serde(default)]
    generation: Option<Value>,
}

fn parse_watermark(value: &Value, name: &str) -> Result<u64, CliError> {
    match value {
        Value::Number(number) => number
            .as_u64()
            .filter(|n| *n <= MAX_SAFE_INTEGER)
            .ok_or_else(|| CliError::usage(format!("Invalid integer: {name}"))),
        Value::String(raw) => parse_int(raw, MAX_SAFE_INTEGER),
        _ => Err(CliError::usage(format!("Invalid integer: {name}"))),
    }
}

pub(crate) fn parse_processing_page(
    body: &str,
    tenant: &str,
    channel: &str,
    committed_through: u64,
) -> Result<(Value, Option<u64>), CliError> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(CliError::generic("Empty response body"));
    }
    let page: Value = serde_json::from_str(trimmed).map_err(|_| invalid_page())?;
    if !page.is_object() {
        return Err(invalid_page());
    }
    let has_more = match page.get("hasMore") {
        Some(Value::Bool(value)) => *value,
        _ => return Err(invalid_page()),
    };
    let next_cursor = match page.get("nextCursor") {
        Some(value) => parse_page_cursor(value)?,
        None => return Err(invalid_page()),
    };
    let last_id = last_message_id(page.get("messages"), tenant, channel, committed_through)?;
    match last_id {
        None => {
            if has_more || next_cursor != committed_through {
                return Err(invalid_page());
            }
        }
        Some(id) => {
            if next_cursor != id {
                return Err(invalid_page());
            }
        }
    }
    Ok((page, last_id))
}

fn last_message_id(
    messages: Option<&Value>,
    tenant: &str,
    channel: &str,
    committed_through: u64,
) -> Result<Option<u64>, CliError> {
    let Some(Value::Array(messages)) = messages else {
        return Err(invalid_page());
    };
    let mut previous = None;
    let mut last = None;
    for message in messages {
        if message.get("tenant").and_then(Value::as_str) != Some(tenant)
            || message.get("channel").and_then(Value::as_str) != Some(channel)
        {
            return Err(invalid_page());
        }
        let id = message_id(message)?;
        if id <= committed_through || previous.is_some_and(|prior| id <= prior) {
            return Err(invalid_page());
        }
        previous = Some(id);
        last = Some(id);
    }
    Ok(last)
}

fn parse_page_cursor(value: &Value) -> Result<u64, CliError> {
    match value {
        Value::Number(number) => number
            .as_u64()
            .filter(|n| *n <= MAX_SAFE_INTEGER)
            .ok_or_else(invalid_page),
        Value::String(raw) => parse_int(raw, MAX_SAFE_INTEGER).map_err(|_| invalid_page()),
        _ => Err(invalid_page()),
    }
}

fn invalid_page() -> CliError {
    CliError::generic("Response was not JSON")
}

fn message_id(message: &Value) -> Result<u64, CliError> {
    match message.get("id") {
        Some(Value::Number(number)) => number
            .as_u64()
            .filter(|n| *n >= 1 && *n <= MAX_SAFE_INTEGER)
            .ok_or_else(|| CliError::generic("Response was not JSON")),
        Some(Value::String(raw)) => {
            let parsed = parse_int(raw, MAX_SAFE_INTEGER)
                .map_err(|_| CliError::generic("Response was not JSON"))?;
            if parsed < 1 {
                return Err(CliError::generic("Response was not JSON"));
            }
            Ok(parsed)
        }
        _ => Err(CliError::generic("Response was not JSON")),
    }
}

fn corrupt_state() -> CliError {
    CliError::usage("Processing file is corrupt.")
}

pub(crate) fn get_interruptible(
    client: Arc<MsnClient>,
    path: String,
    token: String,
    stop: &AtomicBool,
) -> Result<Option<Result<crate::client::RawResponse, CliError>>, CliError> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    thread::Builder::new()
        .name("msn-peek".into())
        .spawn(move || {
            let _ = tx.send(client.get(&path, Some(&token)));
        })?;
    loop {
        if stop.load(Ordering::SeqCst) {
            return Ok(None);
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(response) => return Ok((!stop.load(Ordering::SeqCst)).then_some(response)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(CliError::generic("Polling worker stopped unexpectedly."));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::{TcpListener, TcpStream};
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_LOCK: Mutex<()> = Mutex::new(());
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn tmp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "msn-processing-unit-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn url() -> Url {
        Url::parse("https://msn.test").unwrap()
    }

    fn with_env<T>(vars: &[(&str, Option<&str>)], f: impl FnOnce() -> T) -> T {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let saved: Vec<(String, Option<std::ffi::OsString>)> = vars
            .iter()
            .map(|(name, _)| ((*name).to_string(), std::env::var_os(name)))
            .collect();
        for (name, value) in vars {
            unsafe {
                match value {
                    Some(v) => std::env::set_var(name, v),
                    None => std::env::remove_var(name),
                }
            }
        }
        let result = f();
        for (name, value) in saved {
            unsafe {
                match value {
                    Some(v) => std::env::set_var(&name, v),
                    None => std::env::remove_var(&name),
                }
            }
        }
        result
    }

    fn write_state(path: &Path, state: &ProcessingState) {
        write_processing(path, state).unwrap();
    }

    fn read_state(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    struct FailWriter;

    impl Write for FailWriter {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed stdout"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct Scripted {
        status: u16,
        body: String,
        recorded: Arc<Mutex<Vec<String>>>,
    }

    fn spawn_scripted(responses: Vec<(u16, &'static str)>) -> (Url, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let rec = Arc::clone(&recorded);
        thread::spawn(move || {
            for (status, body) in responses {
                let Ok((stream, _)) = listener.accept() else {
                    break;
                };
                handle_scripted(
                    stream,
                    Scripted {
                        status,
                        body: body.to_string(),
                        recorded: Arc::clone(&rec),
                    },
                );
            }
        });
        (
            Url::parse(&format!("http://127.0.0.1:{}", addr.port())).unwrap(),
            recorded,
        )
    }

    fn handle_scripted(mut stream: TcpStream, scripted: Scripted) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let mut buf = Vec::new();
        let mut tmp = [0u8; 2048];
        let header_end = loop {
            match stream.read(&mut tmp) {
                Ok(0) => return,
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break pos + 4;
                    }
                }
                Err(_) => return,
            }
        };
        let headers = String::from_utf8_lossy(&buf[..header_end]);
        let path = headers
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("")
            .to_string();
        scripted.recorded.lock().unwrap().push(path);
        let out = format!(
            "HTTP/1.1 {} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            scripted.status,
            scripted.body.len(),
            scripted.body
        );
        let _ = stream.write_all(out.as_bytes());
    }

    #[test]
    fn default_path_uses_processing() {
        let url = url();
        let path = with_env(
            &[("XDG_STATE_HOME", Some("/xdg")), ("HOME", Some("/home/u"))],
            || default_processing_path(&url, "team", "alice", "general").unwrap(),
        );
        let expected = PathBuf::from(format!(
            "/xdg/msn/{}/team/processing/{}/general.json",
            origin_hash(&url),
            reader_hash("alice").unwrap()
        ));
        assert_eq!(path, expected);
        assert!(!path.to_string_lossy().contains("/readers/"));
    }

    #[test]
    fn default_path_isolates_bindings() {
        let url = url();
        let path = with_env(
            &[("XDG_STATE_HOME", None), ("HOME", Some("/home/u"))],
            || default_processing_path(&url, "team", "alice", "general").unwrap(),
        );
        let other_reader = with_env(
            &[("XDG_STATE_HOME", None), ("HOME", Some("/home/u"))],
            || default_processing_path(&url, "team", "bob", "general").unwrap(),
        );
        let other_channel = with_env(
            &[("XDG_STATE_HOME", None), ("HOME", Some("/home/u"))],
            || default_processing_path(&url, "team", "alice", "other").unwrap(),
        );
        let other_tenant = with_env(
            &[("XDG_STATE_HOME", None), ("HOME", Some("/home/u"))],
            || default_processing_path(&url, "other", "alice", "general").unwrap(),
        );
        let other_origin = with_env(
            &[("XDG_STATE_HOME", None), ("HOME", Some("/home/u"))],
            || {
                default_processing_path(
                    &Url::parse("https://other.test").unwrap(),
                    "team",
                    "alice",
                    "general",
                )
                .unwrap()
            },
        );
        assert_ne!(path, other_reader);
        assert_ne!(path, other_channel);
        assert_ne!(path, other_tenant);
        assert_ne!(path, other_origin);
        assert!(path.to_string_lossy().contains("/processing/"));
    }

    #[test]
    fn given_no_home_when_default_path_then_usage() {
        let url = url();
        let err = with_env(&[("XDG_STATE_HOME", None), ("HOME", None)], || {
            default_processing_path(&url, "team", "alice", "general").unwrap_err()
        });
        assert_eq!(err.exit_code(), 2);
        assert!(err.to_string().contains("--cursor-file"));
    }

    #[test]
    fn commit_rejects_future_and_backwards() {
        let dir = tmp_dir();
        let file = dir.join("proc.json");
        let url = url();
        write_state(
            &file,
            &ProcessingState {
                committed_through: 3,
                highest_fetched: 9,
                ..ProcessingState::fresh(&url, "team", "general", "alice")
            },
        );
        let err = commit_to(
            &mut Vec::new(),
            &url,
            "team",
            "general",
            "alice",
            Some(&file),
            10,
        )
        .unwrap_err();
        assert_eq!(err.exit_code(), 2);
        assert!(err.to_string().contains("highestFetched"));
        let back = commit_to(
            &mut Vec::new(),
            &url,
            "team",
            "general",
            "alice",
            Some(&file),
            2,
        )
        .unwrap_err();
        assert_eq!(back.exit_code(), 2);
        assert!(back.to_string().contains("committedThrough"));
        assert_eq!(read_state(&file)["committedThrough"], 3);
        let mut out = Vec::new();
        commit_to(&mut out, &url, "team", "general", "alice", Some(&file), 3).unwrap();
        commit_to(
            &mut Vec::new(),
            &url,
            "team",
            "general",
            "alice",
            Some(&file),
            9,
        )
        .unwrap();
        assert_eq!(read_state(&file)["committedThrough"], 9);
        let printed: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(printed["committedThrough"], 3);
        assert_eq!(printed["highestFetched"], 9);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn commit_missing_file_only_allows_through_zero() {
        let dir = tmp_dir();
        let file = dir.join("missing.json");
        let url = url();
        let err = commit_to(
            &mut Vec::new(),
            &url,
            "team",
            "general",
            "alice",
            Some(&file),
            1,
        )
        .unwrap_err();
        assert_eq!(err.exit_code(), 2);
        assert!(!file.exists());
        let mut out = Vec::new();
        commit_to(&mut out, &url, "team", "general", "alice", Some(&file), 0).unwrap();
        assert_eq!(read_state(&file)["committedThrough"], 0);
        assert_eq!(read_state(&file)["highestFetched"], 0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_eager_after_cursor() {
        let dir = tmp_dir();
        let file = dir.join("eager.json");
        fs::write(
            &file,
            r#"{"server":"https://msn.test","tenant":"team","channel":"general","reader":"alice","after":8}"#,
        )
        .unwrap();
        let url = url();
        let err = commit_to(
            &mut Vec::new(),
            &url,
            "team",
            "general",
            "alice",
            Some(&file),
            0,
        )
        .unwrap_err();
        assert_eq!(err.exit_code(), 2);
        assert!(err.to_string().contains("eager"));
        assert!(fs::read_to_string(&file).unwrap().contains("\"after\":8"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn explicit_file_rejects_foreign_reader() {
        let dir = tmp_dir();
        let file = dir.join("bound.json");
        let url = url();
        write_state(
            &file,
            &ProcessingState::fresh(&url, "team", "general", "alice"),
        );
        let err = commit_to(
            &mut Vec::new(),
            &url,
            "team",
            "general",
            "bob",
            Some(&file),
            0,
        )
        .unwrap_err();
        assert_eq!(err.exit_code(), 2);
        assert!(err.to_string().contains("reader"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn load_rejects_corrupt_and_inconsistent_watermarks() {
        let dir = tmp_dir();
        let file = dir.join("bad.json");
        let url = url();
        let expected = ProcessingState::expected(&url, "team", "general", "alice");
        fs::write(&file, "{").unwrap();
        assert_eq!(
            load_processing(&file, &expected).unwrap_err().exit_code(),
            2
        );
        fs::write(
            &file,
            r#"{"server":"https://msn.test","tenant":"team","channel":"general","reader":"alice","committedThrough":9,"highestFetched":3}"#,
        )
        .unwrap();
        assert_eq!(
            load_processing(&file, &expected).unwrap_err().exit_code(),
            2
        );
        fs::write(
            &file,
            r#"{"server":"https://msn.test","tenant":"team","channel":"general","reader":"alice","committedThrough":"4","highestFetched":"8"}"#,
        )
        .unwrap();
        let loaded = load_processing(&file, &expected).unwrap();
        assert_eq!(loaded.committed_through, 4);
        assert_eq!(loaded.highest_fetched, 8);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn write_processing_is_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_dir();
        let file = dir.join("mode.json");
        write_state(
            &file,
            &ProcessingState::fresh(&url(), "team", "general", "alice"),
        );
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn peek_persists_highest_only_after_stdout() {
        const PAGE: &str = r#"{"messages":[{"id":5,"tenant":"team","channel":"general"},{"id":7,"tenant":"team","channel":"general"}],"nextCursor":7,"hasMore":false}"#;
        let (url, recorded) = spawn_scripted(vec![(200, PAGE), (200, PAGE)]);
        let dir = tmp_dir();
        let file = dir.join("proc.json");
        let mut printed = Vec::new();
        peek_to(
            &mut printed,
            &url,
            "team",
            "tenant-secret",
            "general",
            "alice",
            Some(&file),
            0,
            100,
            &AtomicBool::new(false),
        )
        .unwrap();
        let envelope: Value = serde_json::from_slice(&printed).unwrap();
        assert_eq!(envelope["committedThrough"], 0);
        assert_eq!(envelope["highestFetched"], 7);
        assert_eq!(envelope["nextCursor"], 7);
        assert_eq!(envelope["hasMore"], false);
        assert_eq!(read_state(&file)["committedThrough"], 0);
        assert_eq!(read_state(&file)["highestFetched"], 7);
        assert!(
            recorded.lock().unwrap()[0].contains("after=0"),
            "{}",
            recorded.lock().unwrap()[0]
        );

        peek_to(
            &mut Vec::new(),
            &url,
            "team",
            "tenant-secret",
            "general",
            "alice",
            Some(&file),
            0,
            50,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(read_state(&file)["committedThrough"], 0);
        assert_eq!(read_state(&file)["highestFetched"], 7);
        assert!(recorded.lock().unwrap()[1].contains("after=0"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn smaller_replay_page_does_not_lower_highest_fetched() {
        const WIDE: &str = r#"{"messages":[{"id":5,"tenant":"team","channel":"general"},{"id":7,"tenant":"team","channel":"general"}],"nextCursor":7,"hasMore":false}"#;
        const NARROW: &str = r#"{"messages":[{"id":5,"tenant":"team","channel":"general"}],"nextCursor":5,"hasMore":true}"#;
        let (url, _) = spawn_scripted(vec![(200, WIDE), (200, NARROW)]);
        let dir = tmp_dir();
        let file = dir.join("proc.json");
        let mut first = Vec::new();
        peek_to(
            &mut first,
            &url,
            "team",
            "tenant-secret",
            "general",
            "alice",
            Some(&file),
            0,
            100,
            &AtomicBool::new(false),
        )
        .unwrap();
        let mut second = Vec::new();
        peek_to(
            &mut second,
            &url,
            "team",
            "tenant-secret",
            "general",
            "alice",
            Some(&file),
            0,
            1,
            &AtomicBool::new(false),
        )
        .unwrap();
        let envelope: Value = serde_json::from_slice(&second).unwrap();
        assert_eq!(envelope["nextCursor"], 5);
        assert_eq!(envelope["highestFetched"], 7);
        assert_eq!(read_state(&file)["highestFetched"], 7);
        commit_to(
            &mut Vec::new(),
            &url,
            "team",
            "general",
            "alice",
            Some(&file),
            5,
        )
        .unwrap();
        assert_eq!(read_state(&file)["committedThrough"], 5);
        assert_eq!(read_state(&file)["highestFetched"], 7);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn peek_stdout_failure_does_not_persist() {
        const PAGE: &str = r#"{"messages":[{"id":7,"tenant":"team","channel":"general"}],"nextCursor":7,"hasMore":false}"#;
        let (url, _) = spawn_scripted(vec![(200, PAGE)]);
        let dir = tmp_dir();
        let file = dir.join("proc.json");
        let err = peek_to(
            &mut FailWriter,
            &url,
            "team",
            "tenant-secret",
            "general",
            "alice",
            Some(&file),
            0,
            100,
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(err.exit_code(), 1);
        assert!(!file.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn peek_auth_and_invalid_page_do_not_persist() {
        let (denied, _) = spawn_scripted(vec![(
            401,
            r#"{"error":{"code":"unauthorized","message":"no"}}"#,
        )]);
        let dir = tmp_dir();
        let file = dir.join("auth.json");
        let err = peek_to(
            &mut Vec::new(),
            &denied,
            "team",
            "bad",
            "general",
            "alice",
            Some(&file),
            0,
            100,
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(err.exit_code(), 3);
        assert!(!file.exists());

        let (invalid, _) = spawn_scripted(vec![(
            200,
            r#"{"messages":[{"id":9,"tenant":"team","channel":"general"},{"id":3,"tenant":"team","channel":"general"}],"nextCursor":3,"hasMore":false}"#,
        )]);
        let bad = dir.join("invalid.json");
        let err = peek_to(
            &mut Vec::new(),
            &invalid,
            "team",
            "tenant-secret",
            "general",
            "alice",
            Some(&bad),
            0,
            100,
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(err.exit_code(), 1);
        assert!(!bad.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn peek_rejects_malformed_next_hasmore_and_identity() {
        let dir = tmp_dir();
        let cases = [
            r#"{"messages":[{"id":5,"tenant":"team","channel":"general"}],"nextCursor":5}"#,
            r#"{"messages":[],"nextCursor":0,"hasMore":true}"#,
            r#"{"messages":[{"id":5,"tenant":"team","channel":"general"}],"nextCursor":6,"hasMore":false}"#,
            r#"{"messages":[],"nextCursor":1,"hasMore":false}"#,
            r#"{"messages":[{"id":3,"tenant":"team","channel":"general"}],"nextCursor":3,"hasMore":false}"#,
            r#"{"messages":[{"id":5,"tenant":"other","channel":"general"}],"nextCursor":5,"hasMore":false}"#,
            r#"{"messages":[{"id":5,"tenant":"team","channel":"other"}],"nextCursor":5,"hasMore":false}"#,
        ];
        for (index, body) in cases.into_iter().enumerate() {
            let (url, _) = spawn_scripted(vec![(200, body)]);
            let file = dir.join(format!("bad-{index}.json"));
            fs::write(
                &file,
                format!(
                    r#"{{"server":"{}","tenant":"team","channel":"general","reader":"alice","committedThrough":3,"highestFetched":3}}"#,
                    origin_key(&url)
                ),
            )
            .unwrap();
            let err = peek_to(
                &mut Vec::new(),
                &url,
                "team",
                "tenant-secret",
                "general",
                "alice",
                Some(&file),
                0,
                100,
                &AtomicBool::new(false),
            )
            .unwrap_err();
            assert_eq!(err.exit_code(), 1, "{body}");
            assert_eq!(read_state(&file)["highestFetched"], 3, "{body}");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn peek_empty_page_does_not_create_file() {
        const PAGE: &str = r#"{"messages":[],"nextCursor":0,"hasMore":false}"#;
        let (url, _) = spawn_scripted(vec![(200, PAGE)]);
        let dir = tmp_dir();
        let file = dir.join("empty.json");
        let mut printed = Vec::new();
        peek_to(
            &mut printed,
            &url,
            "team",
            "tenant-secret",
            "general",
            "alice",
            Some(&file),
            4,
            10,
            &AtomicBool::new(false),
        )
        .unwrap();
        let envelope: Value = serde_json::from_slice(&printed).unwrap();
        assert_eq!(envelope["committedThrough"], 0);
        assert_eq!(envelope["highestFetched"], 0);
        assert!(!file.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn peek_does_not_advance_committed_through() {
        const PAGE: &str = r#"{"messages":[{"id":4,"tenant":"team","channel":"general"}],"nextCursor":4,"hasMore":true}"#;
        let (url, recorded) = spawn_scripted(vec![(200, PAGE)]);
        let dir = tmp_dir();
        let file = dir.join("proc.json");
        write_state(
            &file,
            &ProcessingState {
                committed_through: 2,
                highest_fetched: 2,
                ..ProcessingState::fresh(&url, "team", "general", "alice")
            },
        );
        peek_to(
            &mut Vec::new(),
            &url,
            "team",
            "tenant-secret",
            "general",
            "alice",
            Some(&file),
            0,
            100,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(read_state(&file)["committedThrough"], 2);
        assert_eq!(read_state(&file)["highestFetched"], 4);
        assert!(recorded.lock().unwrap()[0].contains("after=2"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn processing_lock_excludes_peer() {
        let dir = tmp_dir();
        let file = dir.join("locked.json");
        fs::write(&file, "{}").unwrap();
        let lock = CursorLock::acquire(&file).unwrap();
        let err = commit(&url(), "team", "general", "alice", Some(&file), 0).unwrap_err();
        assert_eq!(err.exit_code(), 5);
        drop(lock);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn peek_rejects_foreign_eager_file_before_network() {
        let dir = tmp_dir();
        let file = dir.join("eager.json");
        fs::write(
            &file,
            r#"{"server":"https://msn.test","tenant":"team","channel":"general","after":8}"#,
        )
        .unwrap();
        let err = peek_to(
            &mut Vec::new(),
            &url(),
            "team",
            "tenant-secret",
            "general",
            "alice",
            Some(&file),
            0,
            100,
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(err.exit_code(), 2);
        fs::remove_dir_all(dir).unwrap();
    }
}
