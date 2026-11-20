//! Binary verification for peek/commit after root wiring.
//!
//! Goal: the `msn peek` / `msn commit` argv persist processing progress separately
//! from eager read cursors.
//! I1 peek_query_uses_committed_through
//! I2 peek_does_not_advance_committed_through
//! I4 peek_auth_and_invalid_page_do_not_persist
//! I9 processing_lock_excludes_peer
//! I10 stdout_failure_does_not_advance_highest_fetched
//! Also: replay without commit, isolation from readers/, monotonic commit via argv.

#[allow(dead_code)]
mod common;

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use common::{MockServer, Scripted};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
const PAGE: &str = r#"{"messages":[{"id":5,"tenant":"team","channel":"general"},{"id":7,"tenant":"team","channel":"general"}],"nextCursor":7,"hasMore":false}"#;
const EMPTY: &str = r#"{"messages":[],"nextCursor":0,"hasMore":false}"#;

struct TestHome(PathBuf);

impl TestHome {
    fn new(label: &str) -> Self {
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "msn-processing-bin-{label}-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("test home");
        Self(path)
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_msn"));
        command
            .env_clear()
            .env("NO_COLOR", "1")
            .env("TERM", "dumb")
            .env("HOME", &self.0)
            .env("XDG_STATE_HOME", self.0.join("state"))
            .env("XDG_CONFIG_HOME", self.0.join("config"));
        if let Ok(path) = std::env::var("PATH") {
            command.env("PATH", path);
        }
        command
    }

    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TestHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn output_capped(cmd: &mut Command, cap: Duration) -> std::process::Output {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run msn");
    let mut stdout = child.stdout.take().expect("stdout");
    let mut stderr = child.stderr.take().expect("stderr");
    let t_out = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let t_err = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            break status;
        }
        if start.elapsed() > cap {
            let _ = child.kill();
            break child.wait().expect("wait after kill");
        }
        thread::sleep(Duration::from_millis(15));
    };
    std::process::Output {
        status,
        stdout: t_out.join().expect("stdout thread"),
        stderr: t_err.join().expect("stderr thread"),
    }
}

fn base_peek_args(url: &str, cursor: &Path) -> Vec<String> {
    vec![
        "--url".into(),
        url.into(),
        "--tenant".into(),
        "team".into(),
        "--token".into(),
        "tenant-secret".into(),
        "--reader".into(),
        "alice".into(),
        "peek".into(),
        "general".into(),
        "--cursor-file".into(),
        cursor.display().to_string(),
    ]
}

fn base_commit_args(url: &str, cursor: &Path, through: &str) -> Vec<String> {
    vec![
        "--url".into(),
        url.into(),
        "--tenant".into(),
        "team".into(),
        "--token".into(),
        "tenant-secret".into(),
        "--reader".into(),
        "alice".into(),
        "commit".into(),
        "general".into(),
        "--through".into(),
        through.into(),
        "--cursor-file".into(),
        cursor.display().to_string(),
    ]
}

/// Local-only progress (`--local`, ADR 0053): the tests above the resumable section pin it.
fn peek_args(url: &str, cursor: &Path) -> Vec<String> {
    let mut args = base_peek_args(url, cursor);
    args.push("--local".into());
    args
}

fn commit_args(url: &str, cursor: &Path, through: &str) -> Vec<String> {
    let mut args = base_commit_args(url, cursor, through);
    args.push("--local".into());
    args
}

fn lock_path(cursor: &Path) -> PathBuf {
    let mut value = cursor.as_os_str().to_os_string();
    value.push(".lock");
    PathBuf::from(value)
}

fn parse_stdout(output: &std::process::Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|_| {
        panic!(
            "stdout was not JSON: {} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

fn state_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn peek_query_uses_committed_through() {
    let server = MockServer::spawn(vec![Scripted::json(200, PAGE)]);
    let home = TestHome::new("query");
    let cursor = home.file("proc.json");
    fs::write(
        &cursor,
        format!(
            r#"{{"server":"{}","tenant":"team","channel":"general","reader":"alice","committedThrough":3,"highestFetched":3}}"#,
            server.url()
        ),
    )
    .unwrap();
    let output = output_capped(
        home.command().args(peek_args(&server.url(), &cursor)),
        Duration::from_secs(8),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let envelope = parse_stdout(&output);
    assert_eq!(envelope["committedThrough"], 3);
    assert_eq!(envelope["highestFetched"], 7);
    assert_eq!(envelope["nextCursor"], 7);
    assert_eq!(envelope["hasMore"], false);
    assert!(
        server.recorded()[0].path.contains("after=3"),
        "{}",
        server.recorded()[0].path
    );
    assert_eq!(state_json(&cursor)["committedThrough"], 3);
    assert_eq!(state_json(&cursor)["highestFetched"], 7);
}

#[test]
fn peek_does_not_advance_committed_through() {
    let server = MockServer::spawn(vec![Scripted::json(200, PAGE), Scripted::json(200, PAGE)]);
    let home = TestHome::new("no-advance");
    let cursor = home.file("proc.json");
    let first = output_capped(
        home.command().args(peek_args(&server.url(), &cursor)),
        Duration::from_secs(8),
    );
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert_eq!(parse_stdout(&first)["committedThrough"], 0);
    assert_eq!(state_json(&cursor)["committedThrough"], 0);
    let second = output_capped(
        home.command().args(peek_args(&server.url(), &cursor)),
        Duration::from_secs(8),
    );
    assert!(second.status.success());
    assert_eq!(parse_stdout(&second)["committedThrough"], 0);
    assert_eq!(state_json(&cursor)["committedThrough"], 0);
    assert_eq!(state_json(&cursor)["highestFetched"], 7);
    assert!(server.recorded()[0].path.contains("after=0"));
    assert!(server.recorded()[1].path.contains("after=0"));
}

#[test]
fn peek_auth_and_invalid_page_do_not_persist() {
    let denied = MockServer::spawn(vec![Scripted::json(
        401,
        r#"{"error":{"code":"unauthorized","message":"no"}}"#,
    )]);
    let home = TestHome::new("auth");
    let cursor = home.file("auth.json");
    let output = output_capped(
        home.command().args(peek_args(&denied.url(), &cursor)),
        Duration::from_secs(8),
    );
    assert_eq!(output.status.code(), Some(3));
    assert!(!cursor.exists());

    let invalid = MockServer::spawn(vec![Scripted::json(
        200,
        r#"{"messages":[{"id":9,"tenant":"team","channel":"general"},{"id":3,"tenant":"team","channel":"general"}],"nextCursor":3,"hasMore":false}"#,
    )]);
    let bad = home.file("invalid.json");
    let output = output_capped(
        home.command().args(peek_args(&invalid.url(), &bad)),
        Duration::from_secs(8),
    );
    assert_eq!(output.status.code(), Some(1));
    assert!(!bad.exists());

    let wrong_stream = MockServer::spawn(vec![Scripted::json(
        200,
        r#"{"messages":[{"id":5,"tenant":"other","channel":"general"}],"nextCursor":5,"hasMore":false}"#,
    )]);
    let seeded = home.file("seeded.json");
    fs::write(
        &seeded,
        format!(
            r#"{{"server":"{}","tenant":"team","channel":"general","reader":"alice","committedThrough":3,"highestFetched":3}}"#,
            wrong_stream.url()
        ),
    )
    .unwrap();
    let output = output_capped(
        home.command().args(peek_args(&wrong_stream.url(), &seeded)),
        Duration::from_secs(8),
    );
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(state_json(&seeded)["highestFetched"], 3);
}

#[test]
fn commit_monotonic_via_argv() {
    let server = MockServer::spawn(vec![Scripted::json(200, PAGE)]);
    let home = TestHome::new("commit");
    let cursor = home.file("proc.json");
    let peek = output_capped(
        home.command().args(peek_args(&server.url(), &cursor)),
        Duration::from_secs(8),
    );
    assert!(peek.status.success());
    let future = output_capped(
        home.command()
            .args(commit_args(&server.url(), &cursor, "8")),
        Duration::from_secs(8),
    );
    assert_eq!(future.status.code(), Some(2));
    assert_eq!(state_json(&cursor)["committedThrough"], 0);
    let ok = output_capped(
        home.command()
            .args(commit_args(&server.url(), &cursor, "7")),
        Duration::from_secs(8),
    );
    assert!(
        ok.status.success(),
        "{}",
        String::from_utf8_lossy(&ok.stderr)
    );
    let body = parse_stdout(&ok);
    assert_eq!(body["committedThrough"], 7);
    assert_eq!(body["highestFetched"], 7);
    assert_eq!(state_json(&cursor)["committedThrough"], 7);
    let back = output_capped(
        home.command()
            .args(commit_args(&server.url(), &cursor, "5")),
        Duration::from_secs(8),
    );
    assert_eq!(back.status.code(), Some(2));
    assert_eq!(state_json(&cursor)["committedThrough"], 7);
}

#[test]
fn processing_lock_excludes_peer() {
    let server = MockServer::spawn(vec![
        Scripted::json(200, PAGE).delayed(Duration::from_secs(30)),
    ]);
    let home = TestHome::new("lock");
    let cursor = home.file("proc.json");
    let mut child = home
        .command()
        .args(peek_args(&server.url(), &cursor))
        .args(["--wait", "25"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn peek");
    let deadline = Instant::now() + Duration::from_secs(3);
    while !lock_path(&cursor).exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(lock_path(&cursor).exists(), "peek did not hold the lock");
    let blocked = output_capped(
        home.command()
            .args(commit_args(&server.url(), &cursor, "0")),
        Duration::from_secs(8),
    );
    assert_eq!(blocked.status.code(), Some(5));
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
#[test]
fn stdout_failure_does_not_advance_highest_fetched() {
    let server = MockServer::spawn(vec![
        Scripted::json(200, PAGE).delayed(Duration::from_millis(150)),
    ]);
    let home = TestHome::new("stdout");
    let cursor = home.file("proc.json");
    let mut child = home
        .command()
        .args(peek_args(&server.url(), &cursor))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn peek");
    drop(child.stdout.take());
    let deadline = Instant::now() + Duration::from_secs(8);
    let status = loop {
        if let Some(status) = child.try_wait().expect("child status") {
            break status;
        }
        if Instant::now() > deadline {
            child.kill().expect("kill hung peek");
            panic!("peek did not exit after stdout close");
        }
        thread::sleep(Duration::from_millis(15));
    };
    assert!(!status.success());
    assert!(!cursor.exists());
    assert!(!lock_path(&cursor).exists());
}

#[test]
fn default_processing_path_is_not_readers_and_ignores_eager_cursor() {
    let server = MockServer::spawn(vec![Scripted::json(200, PAGE), Scripted::json(200, EMPTY)]);
    let home = TestHome::new("default-path");
    let output = output_capped(
        home.command().args([
            "--url",
            &server.url(),
            "--tenant",
            "team",
            "--token",
            "tenant-secret",
            "--reader",
            "alice",
            "peek",
            "general",
            "--local",
        ]),
        Duration::from_secs(8),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state_root = home.0.join("state").join("msn");
    let mut processing_files = Vec::new();
    let mut reader_files = Vec::new();
    visit(&state_root, &mut processing_files, &mut reader_files);
    assert_eq!(processing_files.len(), 1, "{processing_files:?}");
    assert!(
        processing_files[0]
            .to_string_lossy()
            .contains("/processing/"),
        "{}",
        processing_files[0].display()
    );
    assert!(reader_files.is_empty(), "{reader_files:?}");
    assert_eq!(state_json(&processing_files[0])["committedThrough"], 0);
    assert_eq!(state_json(&processing_files[0])["reader"], "alice");

    let eager = home.file("eager.json");
    fs::write(
        &eager,
        format!(
            r#"{{"server":"{}","tenant":"team","channel":"general","reader":"alice","after":8}}"#,
            server.url()
        ),
    )
    .unwrap();
    let rejected = output_capped(
        home.command().args(peek_args(&server.url(), &eager)),
        Duration::from_secs(8),
    );
    assert_eq!(rejected.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("eager"));
}

fn visit(root: &Path, processing: &mut Vec<PathBuf>, readers: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            visit(&path, processing, readers);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
            let rendered = path.to_string_lossy();
            if rendered.contains("/processing/") {
                processing.push(path);
            } else if rendered.contains("/readers/") {
                readers.push(path);
            }
        }
    }
}

// Resumable mode (ADR 0034), R1–R5 in src/resumable.rs.

fn resumable(mut args: Vec<String>) -> Vec<String> {
    args.push("--resumable".into());
    args
}

fn body_json(recorded: &common::Recorded) -> Value {
    serde_json::from_slice(&recorded.body).expect("request body JSON")
}

const RESUMED: &str = r#"{"messages":[{"id":5,"tenant":"team","channel":"general"},{"id":7,"tenant":"team","channel":"general"}],"nextCursor":7,"hasMore":false,"committedThrough":3,"generation":1}"#;

#[test]
fn resumable_first_peek_claims_with_local_progress() {
    let server = MockServer::spawn(vec![
        Scripted::json(
            201,
            r#"{"reader":"alice","generation":1,"committedThrough":3,"holder":"h"}"#,
        ),
        Scripted::json(200, RESUMED),
    ]);
    let home = TestHome::new("res-claim");
    let cursor = home.file("proc.json");
    fs::write(
        &cursor,
        format!(
            r#"{{"server":"{}","tenant":"team","channel":"general","reader":"alice","committedThrough":3,"highestFetched":3}}"#,
            server.url()
        ),
    )
    .unwrap();
    let output = output_capped(
        home.command()
            .args(resumable(base_peek_args(&server.url(), &cursor))),
        Duration::from_secs(8),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let recorded = server.recorded();
    assert_eq!(recorded[0].method, "POST");
    assert!(
        recorded[0]
            .path
            .ends_with("/channels/general/processing/alice/claim")
    );
    let claim = body_json(&recorded[0]);
    assert_eq!(claim["expectGeneration"], 0);
    assert_eq!(claim["committedThrough"], 3);
    assert!(
        recorded[1]
            .path
            .contains("processingReader=alice&generation=1"),
        "{}",
        recorded[1].path
    );
    assert!(!recorded[1].path.contains("after="));
    let envelope = parse_stdout(&output);
    assert_eq!(envelope["generation"], 1);
    assert_eq!(envelope["committedThrough"], 3);
    assert_eq!(envelope["highestFetched"], 7);
    let state = state_json(&cursor);
    assert_eq!(state["generation"], 1);
    assert_eq!(state["highestFetched"], 7);
}

#[test]
fn resumable_held_reader_names_takeover() {
    let server = MockServer::spawn(vec![Scripted::json(
        409,
        r#"{"error":{"code":"processing_held","message":"Generation 4 holds this reader.","details":{"generation":4,"holder":"old-box","committedThrough":9}}}"#,
    )]);
    let home = TestHome::new("res-held");
    let cursor = home.file("proc.json");
    let output = output_capped(
        home.command()
            .args(resumable(base_peek_args(&server.url(), &cursor))),
        Duration::from_secs(8),
    );
    assert_eq!(output.status.code(), Some(5));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("old-box"), "{stderr}");
    assert!(
        stderr.contains("msn takeover general --reader 'alice'"),
        "{stderr}"
    );
    assert!(output.stdout.is_empty());
    assert_eq!(server.recorded().len(), 1);
    assert!(!cursor.exists());
}

#[test]
fn takeover_sends_current_generation() {
    let server = MockServer::spawn(vec![
        Scripted::json(
            200,
            r#"{"reader":"alice","generation":4,"committedThrough":9,"holder":"old-box"}"#,
        ),
        Scripted::json(
            200,
            r#"{"reader":"alice","generation":5,"committedThrough":9,"holder":"new-box","previousGeneration":4}"#,
        ),
    ]);
    let home = TestHome::new("res-takeover");
    let cursor = home.file("proc.json");
    let output = output_capped(
        home.command().args([
            "--url",
            &server.url(),
            "--tenant",
            "team",
            "--token",
            "tenant-secret",
            "--reader",
            "alice",
            "takeover",
            "general",
            "--cursor-file",
            &cursor.display().to_string(),
        ]),
        Duration::from_secs(8),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let recorded = server.recorded();
    assert_eq!(recorded[0].method, "GET");
    let claim = body_json(&recorded[1]);
    assert_eq!(claim["expectGeneration"], 4);
    assert!(claim.get("committedThrough").is_none());
    let envelope = parse_stdout(&output);
    assert_eq!(envelope["generation"], 5);
    assert_eq!(envelope["previousGeneration"], 4);
    assert_eq!(envelope["previousHolder"], "old-box");
    assert_eq!(envelope["committedThrough"], 9);
    let state = state_json(&cursor);
    assert_eq!(state["generation"], 5);
    assert_eq!(state["committedThrough"], 9);
    assert_eq!(state["highestFetched"], 9);
}

fn held_state(server: &MockServer, cursor: &Path) {
    fs::write(
        cursor,
        format!(
            r#"{{"server":"{}","tenant":"team","channel":"general","reader":"alice","committedThrough":3,"highestFetched":7,"generation":2}}"#,
            server.url()
        ),
    )
    .unwrap();
}

#[test]
fn resumable_fenced_commit_is_conflict() {
    let server = MockServer::spawn(vec![
        Scripted::json(
            409,
            r#"{"error":{"code":"processing_fenced","message":"Generation 2 was taken over; generation 3 now holds this reader. Stop processing."}}"#,
        ),
        Scripted::json(
            200,
            r#"{"reader":"alice","generation":3,"committedThrough":3,"holder":null}"#,
        ),
    ]);
    let home = TestHome::new("res-fenced");
    let cursor = home.file("proc.json");
    held_state(&server, &cursor);
    let output = output_capped(
        home.command()
            .args(resumable(base_commit_args(&server.url(), &cursor, "7"))),
        Duration::from_secs(8),
    );
    assert_eq!(output.status.code(), Some(5));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("This agent was replaced"), "{stderr}");
    let recorded = server.recorded();
    assert_eq!(
        body_json(&recorded[0]),
        serde_json::json!({"generation":2,"through":7})
    );
    assert_eq!(state_json(&cursor)["committedThrough"], 3);
    assert_eq!(state_json(&cursor)["generation"], 2);
}

#[test]
fn resumable_commit_saves_server_progress() {
    let server = MockServer::spawn(vec![Scripted::json(
        200,
        r#"{"reader":"alice","generation":2,"committedThrough":7,"holder":null}"#,
    )]);
    let home = TestHome::new("res-commit");
    let cursor = home.file("proc.json");
    held_state(&server, &cursor);
    let output = output_capped(
        home.command()
            .args(resumable(base_commit_args(&server.url(), &cursor, "7"))),
        Duration::from_secs(8),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(parse_stdout(&output)["committedThrough"], 7);
    assert_eq!(state_json(&cursor)["committedThrough"], 7);
}

#[test]
fn local_commit_refuses_resumable_file() {
    let server = MockServer::spawn(vec![]);
    let home = TestHome::new("res-local");
    let cursor = home.file("proc.json");
    held_state(&server, &cursor);
    for args in [
        commit_args(&server.url(), &cursor, "7"),
        peek_args(&server.url(), &cursor),
    ] {
        let output = output_capped(home.command().args(args), Duration::from_secs(8));
        assert_eq!(output.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&output.stderr).contains("--local"));
    }
    assert!(server.recorded().is_empty());
    assert_eq!(state_json(&cursor)["committedThrough"], 3);
}

// Default mode (ADR 0053), D1–D4 in src/resumable.rs: no flag sends progress to the server.

const CLAIMED: &str = r#"{"reader":"alice","generation":1,"committedThrough":0,"holder":"h"}"#;

#[test]
fn default_peek_and_commit_use_the_server() {
    let server = MockServer::spawn(vec![
        Scripted::json(201, CLAIMED),
        Scripted::json(200, RESUMED),
        Scripted::json(
            200,
            r#"{"reader":"alice","generation":1,"committedThrough":7,"holder":"h"}"#,
        ),
    ]);
    let home = TestHome::new("default-server");
    let cursor = home.file("proc.json");
    let peek = output_capped(
        home.command().args(base_peek_args(&server.url(), &cursor)),
        Duration::from_secs(8),
    );
    assert!(
        peek.status.success(),
        "{}",
        String::from_utf8_lossy(&peek.stderr)
    );
    assert_eq!(parse_stdout(&peek)["generation"], 1);
    let commit = output_capped(
        home.command()
            .args(base_commit_args(&server.url(), &cursor, "7")),
        Duration::from_secs(8),
    );
    assert!(
        commit.status.success(),
        "{}",
        String::from_utf8_lossy(&commit.stderr)
    );
    assert_eq!(parse_stdout(&commit)["committedThrough"], 7);
    let recorded = server.recorded();
    assert_eq!(recorded.len(), 3);
    assert!(recorded[0].path.ends_with("/processing/alice/claim"));
    assert_eq!(body_json(&recorded[0])["expectGeneration"], 0);
    assert!(
        recorded[1]
            .path
            .contains("processingReader=alice&generation=1")
    );
    assert!(recorded[2].path.ends_with("/processing/alice/commit"));
    assert_eq!(
        body_json(&recorded[2]),
        serde_json::json!({"generation":1,"through":7})
    );
    let state = state_json(&cursor);
    assert_eq!(state["generation"], 1);
    assert_eq!(state["committedThrough"], 7);
}

#[test]
fn default_held_reader_stays_local_and_names_takeover() {
    let server = MockServer::spawn(vec![
        Scripted::json(
            409,
            r#"{"error":{"code":"processing_held","message":"Generation 4 holds this reader.","details":{"generation":4,"holder":"old-box","committedThrough":9}}}"#,
        ),
        Scripted::json(200, PAGE),
        Scripted::json(200, EMPTY),
    ]);
    let home = TestHome::new("default-held");
    let cursor = home.file("proc.json");
    let output = output_capped(
        home.command().args(base_peek_args(&server.url(), &cursor)),
        Duration::from_secs(8),
    );
    // Held stays the other machine's: no takeover, no error, no receipt for this agent.
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("held by old-box"), "{stderr}");
    assert!(
        stderr.contains("msn takeover general --reader 'alice'"),
        "{stderr}"
    );
    assert!(stderr.contains("--resumable"), "{stderr}");
    assert!(parse_stdout(&output).get("generation").is_none());
    let state = state_json(&cursor);
    assert_eq!(state["keptLocal"], "processing_held");
    assert!(state.get("generation").is_none());
    // The choice is remembered: the next peek reads locally with no claim and no warning.
    let again = output_capped(
        home.command().args(base_peek_args(&server.url(), &cursor)),
        Duration::from_secs(8),
    );
    assert!(again.status.success());
    assert!(
        again.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&again.stderr)
    );
    let recorded = server.recorded();
    assert_eq!(recorded.len(), 3);
    assert!(recorded[0].path.ends_with("/claim"));
    assert!(recorded[1].path.contains("after=0"));
    assert!(recorded[2].path.contains("after=0"));
}

#[test]
fn resumable_claims_and_clears_a_kept_local_reader() {
    let server = MockServer::spawn(vec![
        Scripted::json(201, CLAIMED),
        Scripted::json(200, RESUMED),
    ]);
    let home = TestHome::new("clear-kept");
    let cursor = home.file("proc.json");
    fs::write(
        &cursor,
        format!(
            r#"{{"server":"{}","tenant":"team","channel":"general","reader":"alice","committedThrough":0,"highestFetched":0,"keptLocal":"processing_held"}}"#,
            server.url()
        ),
    )
    .unwrap();
    let output = output_capped(
        home.command()
            .args(resumable(base_peek_args(&server.url(), &cursor))),
        Duration::from_secs(8),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state = state_json(&cursor);
    assert_eq!(state["generation"], 1);
    assert!(state.get("keptLocal").is_none());
}

#[test]
fn resumable_held_reader_is_an_error() {
    let server = MockServer::spawn(vec![Scripted::json(
        409,
        r#"{"error":{"code":"processing_held","message":"Generation 4 holds this reader.","details":{"generation":4,"holder":"old-box","committedThrough":9}}}"#,
    )]);
    let home = TestHome::new("strict-held");
    let cursor = home.file("proc.json");
    let output = output_capped(
        home.command()
            .args(resumable(base_peek_args(&server.url(), &cursor))),
        Duration::from_secs(8),
    );
    assert_eq!(output.status.code(), Some(5));
    assert!(!cursor.exists());
}

#[test]
fn default_falls_back_to_local_for_watch_only_and_old_servers() {
    // Also a key bound to another name reading under --reader: it may read, not commit.
    default_fallbacks();
}

fn default_fallbacks() {
    for (status, body) in [
        (
            403,
            r#"{"error":{"code":"watch_only","message":"This access key can watch the board but not post or change anything."}}"#,
        ),
        (
            403,
            r#"{"error":{"code":"username_bound","message":"This access key may only send as \"owner\"."}}"#,
        ),
        (
            404,
            r#"{"error":{"code":"route_not_found","message":"Unknown processing operation."}}"#,
        ),
    ] {
        let server = MockServer::spawn(vec![
            Scripted::json(status, body),
            Scripted::json(200, PAGE),
        ]);
        let home = TestHome::new("default-fallback");
        let cursor = home.file("proc.json");
        let peek = output_capped(
            home.command().args(base_peek_args(&server.url(), &cursor)),
            Duration::from_secs(8),
        );
        assert!(
            peek.status.success(),
            "{}",
            String::from_utf8_lossy(&peek.stderr)
        );
        assert!(
            String::from_utf8_lossy(&peek.stderr).contains("stays on this machine"),
            "{}",
            String::from_utf8_lossy(&peek.stderr)
        );
        let envelope = parse_stdout(&peek);
        assert!(envelope.get("generation").is_none());
        let recorded = server.recorded();
        assert_eq!(recorded.len(), 2);
        assert!(recorded[1].path.contains("after=0"), "{}", recorded[1].path);
        // The commit follows the file: never claimed, so it stays local with no request.
        let commit = output_capped(
            home.command()
                .args(base_commit_args(&server.url(), &cursor, "7")),
            Duration::from_secs(8),
        );
        assert!(
            commit.status.success(),
            "{}",
            String::from_utf8_lossy(&commit.stderr)
        );
        assert_eq!(server.recorded().len(), 2);
        let state = state_json(&cursor);
        assert!(state.get("generation").is_none());
        assert!(state["keptLocal"].is_string());
        assert_eq!(state["committedThrough"], 7);
    }
}

#[test]
fn default_channel_not_found_is_an_error_not_a_fallback() {
    let server = MockServer::spawn(vec![Scripted::json(
        404,
        r#"{"error":{"code":"channel_not_found","message":"Channel not found."}}"#,
    )]);
    let home = TestHome::new("default-404");
    let cursor = home.file("proc.json");
    let output = output_capped(
        home.command().args(base_peek_args(&server.url(), &cursor)),
        Duration::from_secs(8),
    );
    assert!(!output.status.success());
    assert_eq!(server.recorded().len(), 1);
    assert!(!cursor.exists());
}

#[test]
fn local_flag_and_env_keep_progress_local() {
    for env in [None, Some("0"), Some("false")] {
        let server = MockServer::spawn(vec![Scripted::json(200, PAGE)]);
        let home = TestHome::new("local-mode");
        let cursor = home.file("proc.json");
        let mut command = home.command();
        match env {
            None => command.args(peek_args(&server.url(), &cursor)),
            Some(value) => command
                .env("MSN_RESUMABLE", value)
                .args(base_peek_args(&server.url(), &cursor)),
        };
        let output = output_capped(&mut command, Duration::from_secs(8));
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let recorded = server.recorded();
        assert_eq!(recorded.len(), 1);
        assert!(recorded[0].path.contains("after=0"), "{}", recorded[0].path);
        assert!(state_json(&cursor).get("generation").is_none());
    }
}

#[test]
fn resumable_and_local_conflict() {
    let server = MockServer::spawn(vec![]);
    let home = TestHome::new("both-flags");
    let cursor = home.file("proc.json");
    let output = output_capped(
        home.command()
            .args(resumable(peek_args(&server.url(), &cursor))),
        Duration::from_secs(8),
    );
    assert_eq!(output.status.code(), Some(2));
    assert!(server.recorded().is_empty());
}

#[test]
fn resumable_flag_never_falls_back() {
    let server = MockServer::spawn(vec![Scripted::json(
        403,
        r#"{"error":{"code":"watch_only","message":"This access key can watch the board but not post or change anything."}}"#,
    )]);
    let home = TestHome::new("strict-server");
    let cursor = home.file("proc.json");
    let output = output_capped(
        home.command()
            .args(resumable(base_peek_args(&server.url(), &cursor))),
        Duration::from_secs(8),
    );
    assert!(!output.status.success());
    assert_eq!(server.recorded().len(), 1);
    assert!(!cursor.exists());
}
