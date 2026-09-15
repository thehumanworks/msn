//! Verification contract (2026-09-14)
//!
//! Goal: `msn` exposes the Worker API; mock + live tested; released on main.
//! I1 url_must_be_bare_https_origin
//! I2 missing_workspace_token_names_env
//! I3 channels_prints_server_json
//! I4 send_generates_uuid_key / send_uses_explicit_key
//! I5 send_replay_ok / send_conflict_exits_5
//! I6 poll_query_params / poll_rejects_invalid_wait_limit
//! I7 follow_writes_bound_cursor / follow_rejects_foreign_cursor
//! I8 follow_retries_503 / follow_fatal_404
//! I9 admin_routes_use_admin_token / missing_admin_token_exits_2
//! I10 status_401_exits_3 / status_404_exits_4 / network_refusal_exits_6 / delete_204
//! I11 invalid_slug_exits_2
//! I12 help_lists_commands_and_env
//! I13 send_omits_correlation_fields_by_default / send_forwards_reply_to_and_correlation_id
//!     / send_rejects_invalid_reply_to_or_correlation_id_before_network (issue #4)
//! I14 send_json_sets_content_type / send_json_invalid_exits_2_before_network
//!     / send_json_from_stdin / send_json_invalid_utf8_stdin_exits_2 / send_text_and_json_conflict
//!
//! Edge: empty_response_body, non_json_error_body, send_text_from_stdin, follow_sigint_exits_0
//!
//! Addendum (2026-09-14): `msn wait` / `msn follow --once`
//! W1 wait_prints_first_non_empty_page_then_exits
//! W2 wait_default_cursor_file_resumes_after_previous_run
//! W3 wait_after_flag_skips_cursor_file
//! W4 wait_after_and_cursor_file_conflict
//! W5 wait_rejects_foreign_cursor
//! W6 wait_retries_503_then_exits
//! W7 wait_fatal_404
//! W8 wait_sigint_exits_0_and_keeps_cursor
//! W9 wait_query_params / wait_rejects_zero_wait_or_limit
//! F1 follow_once_exits_after_first_non_empty_page
//! H1 help_lists_commands_and_env (adds `wait`)
//!
//! Mutation run (cargo mutants -f src/lib.rs -f src/cursor.rs -f src/args.rs -f src/main.rs):
//! 85/86 caught. Equivalent survivor: `interruptible_sleep` `<` → `<=` on the 50 ms sleep loop.

mod common;

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

use common::{MockServer, Scripted};

fn bin() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_msn"));
    cmd.env_clear();
    cmd.env("NO_COLOR", "1");
    cmd.env("TERM", "dumb");
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }
    cmd.env("HOME", std::env::temp_dir());
    cmd
}

fn tenant_args(url: &str) -> [&str; 6] {
    ["--url", url, "--tenant", "team", "--token", "tenant-secret"]
}

fn output_of(args: &[&str]) -> std::process::Output {
    let mut cmd = bin();
    cmd.args(args);
    output_capped(cmd, Duration::from_secs(8))
}

/// Runs `cmd` to completion, killing it after `cap` so a never-exiting CLI fails the test
/// instead of hanging it.
fn output_capped(mut cmd: Command, cap: Duration) -> std::process::Output {
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
        stdout: t_out.join().expect("stdout join"),
        stderr: t_err.join().expect("stderr join"),
    }
}

fn stdout_str(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn stderr_str(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

fn tmp_file(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{prefix}-{}-{nanos}-{seq}", std::process::id()))
}

fn read_lines_timeout(stdout: ChildStdout, n: usize, cap: Duration) -> Vec<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut lines = Vec::new();
        for _ in 0..n {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                break;
            }
            lines.push(line);
        }
        let _ = tx.send(lines);
    });
    rx.recv_timeout(cap)
        .expect("timed out waiting for CLI stdout")
}

fn interrupt(pid: u32) {
    let _ = Command::new("kill")
        .args(["-INT", &pid.to_string()])
        .status();
}

#[test]
fn url_must_be_bare_https_origin() {
    let server = MockServer::spawn(vec![Scripted::json(200, r#"{"ok":true}"#)]);
    let base = server.url();
    let bad = [
        format!("{base}/path"),
        format!("{base}/?token=secret"),
        format!("http://user:password@127.0.0.1:{}", server.addr.port()),
        "http://remote.test".to_string(),
    ];
    for url in bad {
        let out = output_of(&["--url", &url, "health"]);
        assert_eq!(
            out.status.code(),
            Some(2),
            "url={url} stderr={}",
            stderr_str(&out)
        );
    }
    assert!(server.recorded().is_empty());
}

#[test]
fn missing_workspace_token_names_env() {
    let server = MockServer::spawn(vec![Scripted::json(200, r#"{"channels":[]}"#)]);
    let url = server.url();
    let out = output_of(&["--url", &url, "--tenant", "team", "channels"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(stderr_str(&out).contains("MSN_WORKSPACE_TOKEN"));
    assert!(server.recorded().is_empty());
}

#[test]
fn channels_prints_server_json() {
    let body = r#"{"channels":[{"name":"general","createdAt":"t"}],"nextCursor":"general","hasMore":false}"#;
    let server = MockServer::spawn(vec![Scripted::json(200, body)]);
    let url = server.url();
    let out = output_of(&[&tenant_args(&url)[..], &["channels"]].concat());
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    assert_eq!(stdout_str(&out).trim(), body);
    let rec = server.recorded();
    assert_eq!(rec.len(), 1);
    assert_eq!(rec[0].method, "GET");
    assert_eq!(rec[0].path, "/api/tenants/team/channels?limit=1000");
    assert_eq!(
        rec[0].headers.get("authorization").map(String::as_str),
        Some("Bearer tenant-secret")
    );
}

#[test]
fn send_generates_uuid_key() {
    let body = r#"{"message":{"id":1},"replayed":false}"#;
    let server = MockServer::spawn(vec![Scripted::json(201, body)]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "--username",
        "free name",
        "send",
        "general",
        "--text",
        "hello",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    let rec = &server.recorded()[0];
    let key = rec.headers.get("idempotency-key").expect("key header");
    let uuid = regex_uuid(key);
    assert!(uuid, "key={key}");
    assert!(stderr_str(&out).contains(&format!("Idempotency-Key: {key}")));
    let content_type = rec
        .headers
        .get("content-type")
        .map(String::as_str)
        .unwrap_or("");
    assert_eq!(
        content_type.split(';').next().unwrap_or("").trim(),
        "application/json"
    );
    let payload: serde_json::Value = serde_json::from_slice(&rec.body).unwrap();
    assert_eq!(payload["username"], "free name");
    assert_eq!(payload["text"], "hello");
    assert!(
        payload.get("contentType").is_none(),
        "--text sends omit contentType (Worker default text/plain)"
    );
}

#[test]
fn send_json_sets_content_type() {
    let server = MockServer::spawn(vec![Scripted::json(
        201,
        r#"{"message":{"id":3,"contentType":"application/json"},"replayed":false}"#,
    )]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "--username",
        "planner-agent",
        "send",
        "general",
        "--json",
        r#"{"op":"ping","task":42}"#,
        "--key",
        "cmd-1",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    assert!(stdout_str(&out).contains(r#""contentType":"application/json""#));
    let rec = server.recorded();
    assert_eq!(rec.len(), 1);
    assert_eq!(
        rec[0].headers.get("idempotency-key").map(String::as_str),
        Some("cmd-1")
    );
    let payload: serde_json::Value = serde_json::from_slice(&rec[0].body).unwrap();
    assert_eq!(payload["username"], "planner-agent");
    assert_eq!(payload["text"], r#"{"op":"ping","task":42}"#);
    assert_eq!(payload["contentType"], "application/json");
}

#[test]
fn send_json_invalid_exits_2_before_network() {
    let server = MockServer::spawn(vec![Scripted::json(201, r#"{"message":{"id":1}}"#)]);
    let url = server.url();
    for json in [r#"{"op":"#, "not json", "{'op':'ping'}", "", "  "] {
        let mut args = tenant_args(&url).to_vec();
        args.extend(["--username", "u", "send", "general", "--json", json]);
        let out = output_of(&args);
        assert_eq!(out.status.code(), Some(2), "{json:?} {}", stderr_str(&out));
        assert!(stderr_str(&out).contains("JSON"), "{json:?}");
        assert!(
            !stderr_str(&out).contains("Idempotency-Key"),
            "no retry key for a rejected payload: {json:?}"
        );
    }
    assert!(
        server.recorded().is_empty(),
        "invalid JSON must never be sent"
    );
}

#[test]
fn send_json_from_stdin() {
    let server = MockServer::spawn(vec![Scripted::json(201, r#"{"message":{"id":2}}"#)]);
    let url = server.url();
    let mut child = bin()
        .args(tenant_args(&url))
        .args(["--username", "pipe", "send", "general", "--json", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all("{\"op\":\"ping\",\"note\":\"héllo 👋\"}\n".as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let payload: serde_json::Value = serde_json::from_slice(&server.recorded()[0].body).unwrap();
    assert_eq!(payload["text"], "{\"op\":\"ping\",\"note\":\"héllo 👋\"}\n");
    assert_eq!(payload["contentType"], "application/json");
}

#[test]
fn send_json_invalid_utf8_stdin_exits_2() {
    let server = MockServer::spawn(vec![Scripted::json(201, r#"{"message":{"id":2}}"#)]);
    let url = server.url();
    let mut child = bin()
        .args(tenant_args(&url))
        .args(["--username", "pipe", "send", "general", "--json", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"{\"op\":\"\xff\xfe\"}")
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert_eq!(
        out.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stderr).contains("UTF-8"));
    assert!(server.recorded().is_empty());
}

#[test]
fn send_text_and_json_conflict() {
    let server = MockServer::spawn(vec![Scripted::json(201, r#"{"message":{"id":1}}"#)]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "--username",
        "u",
        "send",
        "general",
        "--text",
        "x",
        "--json",
        "{}",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(2), "{}", stderr_str(&out));
    let mut args = tenant_args(&url).to_vec();
    args.extend(["--username", "u", "send", "general"]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(2), "{}", stderr_str(&out));
    assert!(server.recorded().is_empty());
}

#[test]
fn send_uses_explicit_key() {
    let server = MockServer::spawn(vec![Scripted::json(200, r#"{"message":{"id":1}}"#)]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "--username",
        "free name",
        "send",
        "general",
        "--text",
        "hello 👋",
        "--key",
        "same-key",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    assert_eq!(
        server.recorded()[0]
            .headers
            .get("idempotency-key")
            .map(String::as_str),
        Some("same-key")
    );
    assert!(stderr_str(&out).contains("Idempotency-Key: same-key"));
}

#[test]
fn send_omits_correlation_fields_by_default() {
    let server = MockServer::spawn(vec![Scripted::json(201, r#"{"message":{"id":1}}"#)]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend(["--username", "u", "send", "general", "--text", "plain"]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    let payload: serde_json::Value = serde_json::from_slice(&server.recorded()[0].body).unwrap();
    let keys: Vec<&str> = payload
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(keys, ["text", "username"]);
}

#[test]
fn send_forwards_reply_to_and_correlation_id() {
    let body = r#"{"message":{"id":43,"replyTo":42,"correlationId":"task-7"},"replayed":false}"#;
    let server = MockServer::spawn(vec![Scripted::json(201, body)]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "--username",
        "responder",
        "send",
        "general",
        "--text",
        "pong",
        "--reply-to",
        "42",
        "--correlation-id",
        "task-7",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    let payload: serde_json::Value = serde_json::from_slice(&server.recorded()[0].body).unwrap();
    assert_eq!(
        payload,
        serde_json::json!({
            "username": "responder",
            "text": "pong",
            "replyTo": 42,
            "correlationId": "task-7"
        })
    );
    assert!(stdout_str(&out).contains("\"replyTo\":42"));
    // Only the supplied field is sent; the other stays absent rather than null.
    let server = MockServer::spawn(vec![Scripted::json(201, r#"{"message":{"id":2}}"#)]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "--username",
        "u",
        "send",
        "general",
        "--text",
        "x",
        "--correlation-id",
        "only",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    let payload: serde_json::Value = serde_json::from_slice(&server.recorded()[0].body).unwrap();
    assert_eq!(
        payload,
        serde_json::json!({ "username": "u", "text": "x", "correlationId": "only" })
    );
}

#[test]
fn send_rejects_invalid_reply_to_or_correlation_id_before_network() {
    let server = MockServer::spawn(vec![]);
    let url = server.url();
    for extra in [
        ["--reply-to", "-1"],
        ["--reply-to", "1.5"],
        ["--reply-to", "07"],
        ["--reply-to", "9007199254740992"],
        ["--correlation-id", " "],
    ] {
        let mut args = tenant_args(&url).to_vec();
        args.extend(["--username", "u", "send", "general", "--text", "x"]);
        args.extend(extra);
        let out = output_of(&args);
        assert_eq!(
            out.status.code(),
            Some(2),
            "{extra:?}: {}",
            stderr_str(&out)
        );
    }
    let long = "x".repeat(129);
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "--username",
        "u",
        "send",
        "general",
        "--text",
        "x",
        "--correlation-id",
        &long,
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(2), "{}", stderr_str(&out));
    assert!(server.recorded().is_empty());
    // The Worker's same-channel check surfaces as a plain 400, exit 1, with its message.
    let server = MockServer::spawn(vec![Scripted::json(
        400,
        r#"{"error":{"code":"invalid_reply_to","message":"replyTo must be the id of an existing message in this channel."}}"#,
    )]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "--username",
        "u",
        "send",
        "general",
        "--text",
        "x",
        "--reply-to",
        "999",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr_str(&out).contains("existing message in this channel"));
}

#[test]
fn send_replay_ok() {
    let server = MockServer::spawn(vec![Scripted::json(
        200,
        r#"{"message":{"id":1},"replayed":true}"#,
    )]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "--username",
        "u",
        "send",
        "general",
        "--text",
        "x",
        "--key",
        "k",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0));
    assert!(stdout_str(&out).contains("\"replayed\":true"));
}

#[test]
fn send_conflict_exits_5() {
    let server = MockServer::spawn(vec![Scripted::json(
        409,
        r#"{"error":{"code":"idempotency_conflict","message":"This idempotency key was used for different content."}}"#,
    )]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "--username",
        "u",
        "send",
        "general",
        "--text",
        "y",
        "--key",
        "k",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(5));
    assert!(stderr_str(&out).contains("different content"));
}

#[test]
fn poll_query_params() {
    let server = MockServer::spawn(vec![Scripted::json(
        200,
        r#"{"messages":[],"nextCursor":5,"hasMore":false}"#,
    )]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "poll", "general", "--after", "5", "--wait", "3", "--limit", "10",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    assert_eq!(
        server.recorded()[0].path,
        "/api/tenants/team/channels/general/messages?after=5&wait=3&limit=10"
    );
}

#[test]
fn poll_rejects_invalid_wait_limit() {
    let server = MockServer::spawn(vec![Scripted::json(200, r#"{}"#)]);
    let url = server.url();
    for extra in [
        ["poll", "general", "--wait", "26"],
        ["poll", "general", "--limit", "0"],
    ] {
        let mut args = tenant_args(&url).to_vec();
        args.extend(extra);
        let out = output_of(&args);
        assert_eq!(out.status.code(), Some(2), "{extra:?} {}", stderr_str(&out));
    }
    assert!(server.recorded().is_empty());
}

#[test]
fn follow_writes_bound_cursor() {
    let page = r#"{"messages":[{"id":7},{"id":8}],"nextCursor":8,"hasMore":false}"#;
    let server = MockServer::spawn(vec![Scripted::json(200, page)]);
    let url = server.url();
    let file = tmp_file("msn-cursor");
    let mut child = bin()
        .args(tenant_args(&url))
        .args([
            "follow",
            "general",
            "--cursor-file",
            file.to_str().unwrap(),
            "--wait",
            "1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn follow");
    let stdout = child.stdout.take().expect("stdout");
    let lines = read_lines_timeout(stdout, 2, Duration::from_secs(3));
    assert_eq!(lines.len(), 2, "follow printed {:?}", lines);
    let line1 = &lines[0];
    let line2 = &lines[1];
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(line1).unwrap()["id"],
        7
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(line2).unwrap()["id"],
        8
    );
    let saved = wait_file(&file);
    let json: serde_json::Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(json["server"], url);
    assert_eq!(json["tenant"], "team");
    assert_eq!(json["channel"], "general");
    assert_eq!(json["after"], 8);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    interrupt(child.id());
    let status = child.wait().expect("wait");
    assert_eq!(status.code(), Some(0));
    let _ = fs::remove_file(&file);
}

#[test]
fn follow_rejects_foreign_cursor() {
    let server = MockServer::spawn(vec![Scripted::json(200, r#"{"messages":[]}"#)]);
    let url = server.url();
    let file = tmp_file("msn-foreign-cursor");
    fs::write(
        &file,
        r#"{"server":"https://other.test","tenant":"team","channel":"general","after":9}"#,
    )
    .unwrap();
    let mut args = tenant_args(&url).to_vec();
    args.extend(["follow", "general", "--cursor-file", file.to_str().unwrap()]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(2));
    assert!(stderr_str(&out).contains("different"));
    assert!(server.recorded().is_empty());
    let _ = fs::remove_file(&file);
}

#[test]
fn follow_retries_503() {
    let page = r#"{"messages":[{"id":1}],"nextCursor":1,"hasMore":false}"#;
    let server = MockServer::spawn(vec![
        Scripted::json(503, r#"{"error":{"code":"x","message":"busy"}}"#),
        Scripted::json(200, page),
    ]);
    let url = server.url();
    let mut child = bin()
        .args(tenant_args(&url))
        .args(["follow", "general", "--wait", "1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");
    let stdout = child.stdout.take().expect("stdout");
    let lines = read_lines_timeout(stdout, 1, Duration::from_secs(5));
    assert_eq!(lines.len(), 1, "follow printed {:?}", lines);
    let line = &lines[0];
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(line).unwrap()["id"],
        1
    );
    interrupt(child.id());
    let waited = child.wait_with_output().expect("wait");
    assert_eq!(waited.status.code(), Some(0));
    let rec = server.recorded();
    assert!(rec.len() >= 2, "expected retry, got {}", rec.len());
    assert!(rec[0].path.contains("after=0"));
    let gap = rec[1].at.duration_since(rec[0].at);
    assert!(gap >= Duration::from_millis(900), "backoff was {gap:?}");
    let err = String::from_utf8_lossy(&waited.stderr);
    assert!(err.contains("reconnecting from cursor 0"), "{err}");
}

#[test]
fn follow_fatal_404() {
    let server = MockServer::spawn(vec![Scripted::json(
        404,
        r#"{"error":{"code":"channel_not_found","message":"Channel not found."}}"#,
    )]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend(["follow", "general", "--wait", "1"]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(4));
    assert_eq!(server.recorded().len(), 1);
    assert!(stderr_str(&out).contains("Channel not found"));
}

#[test]
fn admin_routes_use_admin_token() {
    let server = MockServer::spawn(vec![
        Scripted::json(201, r#"{"tenant":"new","token":"t"}"#),
        Scripted::json(200, r#"{"tenant":"new","token":"n"}"#),
        Scripted::empty(204),
    ]);
    let url = server.url();
    let cases: &[(&[&str], &str, &str)] = &[
        (&["provision", "new"], "PUT", "/api/admin/tenants/new"),
        (&["rotate", "new"], "POST", "/api/admin/tenants/new/token"),
        (
            &["delete", "general", "5"],
            "DELETE",
            "/api/admin/tenants/team/channels/general/messages/5",
        ),
    ];
    for (args, method, path) in cases {
        let mut cmd = tenant_args(&url).to_vec();
        cmd.extend(["--admin-token", "admin-secret"]);
        cmd.extend(*args);
        let out = output_of(&cmd);
        assert_eq!(out.status.code(), Some(0), "{args:?} {}", stderr_str(&out));
        let rec = server.recorded();
        let last = rec.last().unwrap();
        assert_eq!(last.method, *method);
        assert_eq!(last.path, *path);
        assert_eq!(
            last.headers.get("authorization").map(String::as_str),
            Some("Bearer admin-secret")
        );
    }
}

#[test]
fn missing_admin_token_exits_2() {
    let server = MockServer::spawn(vec![Scripted::empty(204)]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend(["delete", "general", "5"]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(2));
    assert!(stderr_str(&out).contains("MSN_ADMIN_TOKEN"));
    assert!(server.recorded().is_empty());
}

#[test]
fn status_401_exits_3() {
    let server = MockServer::spawn(vec![Scripted::json(
        401,
        r#"{"error":{"code":"unauthorized","message":"denied"}}"#,
    )]);
    let url = server.url();
    let out = output_of(&[&tenant_args(&url)[..], &["channels"]].concat());
    assert_eq!(out.status.code(), Some(3));
    assert!(stderr_str(&out).contains("denied"));
}

#[test]
fn status_404_exits_4() {
    let server = MockServer::spawn(vec![Scripted::json(
        404,
        r#"{"error":{"code":"x","message":"gone"}}"#,
    )]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend(["poll", "missing"]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(4));
}

#[test]
fn network_refusal_exits_6() {
    // Port 1 is not used by the mock servers (those bind :0). Binding then
    // dropping a port races other tests that reuse it and can yield exit 0.
    let out = output_of(&["--url", "http://127.0.0.1:1", "health"]);
    assert_eq!(out.status.code(), Some(6), "{}", stderr_str(&out));
}

#[test]
fn delete_204() {
    let server = MockServer::spawn(vec![Scripted::empty(204)]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend(["--admin-token", "admin-secret", "delete", "general", "9"]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    assert_eq!(stdout_str(&out).trim(), r#"{"deleted":true}"#);
}

#[test]
fn invalid_slug_exits_2() {
    let server = MockServer::spawn(vec![Scripted::json(200, r#"{}"#)]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend(["create", "UPPER"]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(2));
    assert!(server.recorded().is_empty());
    let out = output_of(&["--url", &url, "--admin-token", "a", "provision", "BAD"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(server.recorded().is_empty());
}

#[test]
fn help_lists_commands_and_env() {
    let out = output_of(&["--help"]);
    assert_eq!(out.status.code(), Some(0));
    let text = format!("{}{}", stdout_str(&out), stderr_str(&out));
    for needle in [
        "health",
        "channels",
        "create",
        "send",
        "poll",
        "wait",
        "follow",
        "provision",
        "rotate",
        "delete",
        "MSN_URL",
        "MSN_WORKSPACE_TENANT",
        "MSN_WORKSPACE_TOKEN",
        "MSN_ADMIN_TOKEN",
        "MSN_USERNAME",
        "EXAMPLES",
        "--reply-to",
        "--correlation-id",
    ] {
        assert!(text.contains(needle), "help missing {needle}\n{text}");
    }
    let ver = output_of(&["--version"]);
    assert_eq!(ver.status.code(), Some(0));
    assert!(stdout_str(&ver).contains(env!("CARGO_PKG_VERSION")));
}

#[test]
fn send_text_from_stdin() {
    let server = MockServer::spawn(vec![Scripted::json(201, r#"{"message":{"id":2}}"#)]);
    let url = server.url();
    let mut child = bin()
        .args(tenant_args(&url))
        .args(["--username", "pipe", "send", "general", "--text", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"hello from stdin")
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let payload: serde_json::Value = serde_json::from_slice(&server.recorded()[0].body).unwrap();
    assert_eq!(payload["text"], "hello from stdin");
}

#[test]
fn empty_response_body() {
    // Whitespace-only 200: some HTTP/1.1 clients treat a 200 with no bytes as a
    // transport error (exit 6). trim() still yields an empty JSON payload.
    let server = MockServer::spawn(vec![Scripted::json(200, " \n")]);
    let url = server.url();
    let out = output_of(&[&tenant_args(&url)[..], &["channels"]].concat());
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr_str(&out).contains("Empty"));
}

#[test]
fn non_json_error_body() {
    let server = MockServer::spawn(vec![Scripted {
        status: 401,
        headers: vec![("Content-Type".into(), "text/plain".into())],
        body: "denied".into(),
        delay: Duration::ZERO,
    }]);
    let url = server.url();
    let out = output_of(&[&tenant_args(&url)[..], &["channels"]].concat());
    assert_eq!(out.status.code(), Some(3));
    assert!(stderr_str(&out).contains("401: denied"));
}

#[test]
fn follow_sigint_exits_0() {
    let server = MockServer::spawn(vec![
        Scripted::json(200, r#"{"messages":[],"nextCursor":0}"#).delayed(Duration::from_secs(20)),
    ]);
    let url = server.url();
    let mut child = bin()
        .args(tenant_args(&url))
        .args(["follow", "general", "--wait", "1"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_millis(150));
    interrupt(child.id());
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(0));
}

#[test]
fn follow_redirect_exits_6() {
    let server = MockServer::spawn(vec![Scripted::redirect("https://evil.example/")]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend(["follow", "general", "--wait", "1"]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(6), "{}", stderr_str(&out));
    assert!(stderr_str(&out).contains("Redirect"));
    assert_eq!(server.recorded().len(), 1);
}

#[test]
fn redirect_is_error() {
    let server = MockServer::spawn(vec![Scripted::redirect("https://evil.example/")]);
    let url = server.url();
    let out = output_of(&[&tenant_args(&url)[..], &["channels"]].concat());
    assert_eq!(out.status.code(), Some(6));
    assert!(stderr_str(&out).contains("Redirect"));
    assert_eq!(server.recorded().len(), 1);
}

#[test]
fn health_ok() {
    let body = r#"{"ok":true,"service":"msn"}"#;
    let server = MockServer::spawn(vec![Scripted::json(200, body)]);
    let url = server.url();
    let out = output_of(&["--url", &url, "health"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(stdout_str(&out).trim(), body);
    assert_eq!(server.recorded()[0].path, "/api/health");
    assert!(!server.recorded()[0].headers.contains_key("authorization"));
}

#[test]
fn create_prints_server_json() {
    let body = r#"{"channel":"general","created":true}"#;
    let server = MockServer::spawn(vec![Scripted::json(201, body)]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend(["create", "general"]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    assert_eq!(stdout_str(&out).trim(), body);
    assert_eq!(server.recorded()[0].method, "PUT");
    assert_eq!(
        server.recorded()[0].path,
        "/api/tenants/team/channels/general"
    );
}

#[test]
fn follow_rejects_zero_wait_or_limit() {
    let server = MockServer::spawn(vec![Scripted::json(200, r#"{"messages":[]}"#)]);
    let url = server.url();
    for extra in [
        ["follow", "general", "--wait", "0"].as_slice(),
        ["follow", "general", "--limit", "0"].as_slice(),
    ] {
        let mut args = tenant_args(&url).to_vec();
        args.extend(extra.iter().copied());
        let out = output_of(&args);
        assert_eq!(out.status.code(), Some(2), "{extra:?} {}", stderr_str(&out));
    }
    assert!(server.recorded().is_empty());
}

#[test]
fn follow_and_poll_accept_limit_one() {
    let server = MockServer::spawn(vec![
        Scripted::json(200, r#"{"messages":[],"nextCursor":0,"hasMore":false}"#),
        Scripted::json(200, r#"{"messages":[],"nextCursor":0,"hasMore":false}"#),
    ]);
    let url = server.url();
    let mut poll_args = tenant_args(&url).to_vec();
    poll_args.extend(["poll", "general", "--limit", "1"]);
    let out = output_of(&poll_args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    assert!(server.recorded()[0].path.contains("limit=1"));

    let mut follow = bin()
        .args(tenant_args(&url))
        .args(["follow", "general", "--wait", "1", "--limit", "1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_millis(200));
    interrupt(follow.id());
    let status = follow.wait().unwrap();
    assert_eq!(status.code(), Some(0));
    assert!(
        server
            .recorded()
            .iter()
            .any(|r| r.path.contains("limit=1") && r.path.contains("/messages"))
    );
}

#[test]
fn follow_after_and_cursor_file_conflict() {
    let server = MockServer::spawn(vec![Scripted::json(200, r#"{"messages":[]}"#)]);
    let url = server.url();
    let file = tmp_file("msn-both");
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "follow",
        "general",
        "--after",
        "1",
        "--cursor-file",
        file.to_str().unwrap(),
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(2));
    assert!(stderr_str(&out).contains("either"));
    assert!(server.recorded().is_empty());
}

#[test]
fn status_403_exits_3() {
    let server = MockServer::spawn(vec![Scripted::json(
        403,
        r#"{"error":{"code":"forbidden","message":"nope"}}"#,
    )]);
    let url = server.url();
    let out = output_of(&[&tenant_args(&url)[..], &["channels"]].concat());
    assert_eq!(out.status.code(), Some(3));
}

#[test]
fn status_410_exits_5() {
    let server = MockServer::spawn(vec![Scripted::json(
        410,
        r#"{"error":{"code":"message_deleted","message":"gone forever"}}"#,
    )]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "--username",
        "u",
        "send",
        "general",
        "--text",
        "x",
        "--key",
        "k",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(5));
    assert!(stderr_str(&out).contains("gone forever"));
}

#[test]
fn flags_override_env_token() {
    let server = MockServer::spawn(vec![Scripted::json(200, r#"{"channels":[]}"#)]);
    let url = server.url();
    let out = bin()
        .env("MSN_WORKSPACE_TOKEN", "from-env")
        .env("MSN_WORKSPACE_TENANT", "team")
        .args(["--url", &url, "--token", "from-flag", "channels"])
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        server.recorded()[0]
            .headers
            .get("authorization")
            .map(String::as_str),
        Some("Bearer from-flag")
    );
}

const EMPTY_PAGE: &str = r#"{"messages":[],"nextCursor":0,"hasMore":false}"#;
const PAGE_7_8: &str = r#"{"messages":[{"id":7},{"id":8}],"nextCursor":8,"hasMore":false}"#;

fn wait_args<'a>(url: &'a str, extra: &[&'a str]) -> Vec<&'a str> {
    let mut args = tenant_args(url).to_vec();
    args.extend(["wait", "general"]);
    args.extend_from_slice(extra);
    args
}

fn assert_mode_0600(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{}", path.display());
    }
}

fn read_cursor(path: &std::path::Path) -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn wait_prints_first_non_empty_page_then_exits() {
    // Given an empty long-poll timeout followed by a page with new rows
    let server = MockServer::spawn(vec![
        Scripted::json(200, EMPTY_PAGE),
        Scripted::json(200, PAGE_7_8),
    ]);
    let url = server.url();
    let file = tmp_file("msn-wait-cursor");
    // When wait runs with an explicit cursor file
    let out = output_of(&wait_args(
        &url,
        &["--cursor-file", file.to_str().unwrap(), "--wait", "1"],
    ));
    // Then it keeps polling through the empty page, prints the page verbatim and exits 0
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    assert_eq!(stdout_str(&out).trim(), PAGE_7_8);
    let rec = server.recorded();
    assert_eq!(rec.len(), 2, "{rec:?}");
    assert_eq!(
        rec[0].path,
        "/api/tenants/team/channels/general/messages?after=0&wait=1&limit=100"
    );
    assert_eq!(rec[1].path, rec[0].path);
    let saved = read_cursor(&file);
    assert_eq!(saved["server"], url);
    assert_eq!(saved["tenant"], "team");
    assert_eq!(saved["channel"], "general");
    assert_eq!(saved["after"], 8);
    assert_mode_0600(&file);
    let _ = fs::remove_file(&file);
}

#[test]
fn wait_default_cursor_file_resumes_after_previous_run() {
    // Given a fresh HOME and two consecutive pages on the same server
    let first = r#"{"messages":[{"id":3}],"nextCursor":3,"hasMore":false}"#;
    let second = r#"{"messages":[{"id":4}],"nextCursor":"4","hasMore":false}"#;
    let server = MockServer::spawn(vec![
        Scripted::json(200, first),
        Scripted::json(200, second),
    ]);
    let url = server.url();
    let home = tmp_file("msn-wait-home");
    fs::create_dir_all(&home).unwrap();
    let run = || {
        let mut cmd = bin();
        cmd.env("HOME", &home)
            .args(wait_args(&url, &["--wait", "1"]));
        output_capped(cmd, Duration::from_secs(8))
    };
    // When wait runs twice with no cursor flags
    let out1 = run();
    assert_eq!(
        out1.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out1.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out1.stdout).trim(), first);
    // Then the cursor lives at ~/.local/state/msn/<origin-hash>/<tenant>/<channel>.json, mode 0600
    let msn_dir = home.join(".local").join("state").join("msn");
    let origins: Vec<_> = fs::read_dir(&msn_dir)
        .unwrap()
        .map(|e| e.unwrap())
        .collect();
    assert_eq!(origins.len(), 1, "{origins:?}");
    let hash = origins[0].file_name().to_string_lossy().into_owned();
    assert_eq!(hash.len(), 16, "{hash}");
    assert!(hash.bytes().all(|b| b.is_ascii_hexdigit()), "{hash}");
    let file = origins[0].path().join("team").join("general.json");
    let saved = read_cursor(&file);
    assert_eq!(saved["server"], url);
    assert_eq!(saved["tenant"], "team");
    assert_eq!(saved["channel"], "general");
    assert_eq!(saved["after"], 3);
    assert_mode_0600(&file);
    // And the second run only asks for rows strictly after the first run's nextCursor
    let out2 = run();
    assert_eq!(
        out2.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out2.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out2.stdout).trim(), second);
    let rec = server.recorded();
    assert_eq!(rec.len(), 2);
    assert!(rec[0].path.contains("after=0&"), "{}", rec[0].path);
    assert!(rec[1].path.contains("after=3&"), "{}", rec[1].path);
    assert_eq!(read_cursor(&file)["after"], 4);
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn wait_after_flag_skips_cursor_file() {
    // Given --after and a HOME with no state
    let page = r#"{"messages":[{"id":6}],"nextCursor":6,"hasMore":false}"#;
    let server = MockServer::spawn(vec![Scripted::json(200, page)]);
    let url = server.url();
    let home = tmp_file("msn-wait-home-after");
    fs::create_dir_all(&home).unwrap();
    // When
    let mut cmd = bin();
    cmd.env("HOME", &home)
        .args(wait_args(&url, &["--after", "5", "--wait", "1"]));
    let out = output_capped(cmd, Duration::from_secs(8));
    // Then the explicit cursor is used and nothing is persisted
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), page);
    assert!(server.recorded()[0].path.contains("after=5&"));
    assert!(!home.join(".local").exists(), "state dir was created");
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn wait_after_and_cursor_file_conflict() {
    let server = MockServer::spawn(vec![Scripted::json(200, PAGE_7_8)]);
    let url = server.url();
    let file = tmp_file("msn-wait-both");
    let out = output_of(&wait_args(
        &url,
        &["--after", "1", "--cursor-file", file.to_str().unwrap()],
    ));
    assert_eq!(out.status.code(), Some(2));
    assert!(stderr_str(&out).contains("either"));
    assert!(server.recorded().is_empty());
    assert!(!file.exists());
}

#[test]
fn wait_rejects_foreign_cursor() {
    let server = MockServer::spawn(vec![Scripted::json(200, PAGE_7_8)]);
    let url = server.url();
    for foreign in [
        r#"{"server":"https://other.test","tenant":"team","channel":"general","after":9}"#,
        r#"{"server":"URL","tenant":"other","channel":"general","after":9}"#,
        r#"{"server":"URL","tenant":"team","channel":"other","after":9}"#,
    ] {
        let file = tmp_file("msn-wait-foreign");
        fs::write(&file, foreign.replace("URL", &url)).unwrap();
        let out = output_of(&wait_args(&url, &["--cursor-file", file.to_str().unwrap()]));
        assert_eq!(out.status.code(), Some(2), "{foreign}");
        assert!(stderr_str(&out).contains("different"));
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            foreign.replace("URL", &url)
        );
        let _ = fs::remove_file(&file);
    }
    assert!(server.recorded().is_empty());
}

#[test]
fn wait_retries_503_then_exits() {
    // Given a transient 503 and then a page
    let server = MockServer::spawn(vec![
        Scripted::json(503, r#"{"error":{"code":"x","message":"busy"}}"#),
        Scripted::json(200, PAGE_7_8),
    ]);
    let url = server.url();
    // When
    let out = output_of(&wait_args(&url, &["--after", "0", "--wait", "1"]));
    // Then wait backs off, reconnects from the same cursor and still exits 0 with the page
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    assert_eq!(stdout_str(&out).trim(), PAGE_7_8);
    let rec = server.recorded();
    assert_eq!(rec.len(), 2);
    assert!(rec[1].path.contains("after=0&"));
    let gap = rec[1].at.duration_since(rec[0].at);
    assert!(gap >= Duration::from_millis(900), "backoff was {gap:?}");
    assert!(stderr_str(&out).contains("reconnecting from cursor 0"));
}

#[test]
fn wait_fatal_404() {
    let server = MockServer::spawn(vec![Scripted::json(
        404,
        r#"{"error":{"code":"channel_not_found","message":"Channel not found."}}"#,
    )]);
    let url = server.url();
    let file = tmp_file("msn-wait-404");
    let out = output_of(&wait_args(
        &url,
        &["--cursor-file", file.to_str().unwrap(), "--wait", "1"],
    ));
    assert_eq!(out.status.code(), Some(4));
    assert!(stdout_str(&out).is_empty());
    assert!(stderr_str(&out).contains("Channel not found"));
    assert_eq!(server.recorded().len(), 1);
    assert!(!file.exists(), "cursor written on a fatal error");
}

#[test]
fn wait_sigint_exits_0_and_keeps_cursor() {
    // Given a saved cursor at 3 and a server that holds the long poll open
    let server = MockServer::spawn(vec![
        Scripted::json(200, PAGE_7_8).delayed(Duration::from_secs(20)),
    ]);
    let url = server.url();
    let file = tmp_file("msn-wait-sigint");
    let before = format!(r#"{{"server":"{url}","tenant":"team","channel":"general","after":3}}"#);
    fs::write(&file, &before).unwrap();
    let child = bin()
        .args(wait_args(
            &url,
            &["--cursor-file", file.to_str().unwrap(), "--wait", "1"],
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while server.recorded().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(15));
    }
    // When interrupted mid-request
    interrupt(child.id());
    let out = child.wait_with_output().unwrap();
    // Then it exits 0, printed nothing, and the cursor is untouched (no advance past undelivered ids)
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty());
    assert_eq!(fs::read_to_string(&file).unwrap(), before);
    assert!(server.recorded()[0].path.contains("after=3&"));
    let _ = fs::remove_file(&file);
}

#[test]
fn wait_query_params() {
    let server = MockServer::spawn(vec![Scripted::json(200, PAGE_7_8)]);
    let url = server.url();
    let out = output_of(&wait_args(
        &url,
        &["--after", "5", "--wait", "3", "--limit", "10"],
    ));
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    assert_eq!(
        server.recorded()[0].path,
        "/api/tenants/team/channels/general/messages?after=5&wait=3&limit=10"
    );
}

#[test]
fn wait_rejects_zero_wait_or_limit() {
    let server = MockServer::spawn(vec![Scripted::json(200, PAGE_7_8)]);
    let url = server.url();
    for extra in [["--wait", "0"], ["--limit", "0"], ["--wait", "26"]] {
        let out = output_of(&wait_args(&url, &extra));
        assert_eq!(out.status.code(), Some(2), "{extra:?} {}", stderr_str(&out));
    }
    assert!(server.recorded().is_empty());
}

#[test]
fn follow_once_exits_after_first_non_empty_page() {
    // Given an empty page and then two rows
    let server = MockServer::spawn(vec![
        Scripted::json(200, EMPTY_PAGE),
        Scripted::json(200, PAGE_7_8),
    ]);
    let url = server.url();
    let file = tmp_file("msn-follow-once");
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "follow",
        "general",
        "--cursor-file",
        file.to_str().unwrap(),
        "--wait",
        "1",
        "--once",
    ]);
    // When
    let out = output_of(&args);
    // Then follow prints one JSON line per message, persists the cursor and exits 0 on its own
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    let lines: Vec<serde_json::Value> = stdout_str(&out)
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert_eq!(lines[0]["id"], 7);
    assert_eq!(lines[1]["id"], 8);
    assert_eq!(server.recorded().len(), 2);
    assert_eq!(read_cursor(&file)["after"], 8);
    assert_mode_0600(&file);
    let _ = fs::remove_file(&file);
}

fn regex_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let hex = |i: usize| bytes[i].is_ascii_hexdigit();
    (0..8).all(hex)
        && bytes[8] == b'-'
        && (9..13).all(hex)
        && bytes[13] == b'-'
        && bytes[14] == b'4'
        && (15..18).all(hex)
        && bytes[18] == b'-'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
        && (20..23).all(hex)
        && bytes[23] == b'-'
        && (24..36).all(hex)
}

fn wait_file(path: &std::path::Path) -> String {
    for _ in 0..50 {
        if let Ok(text) = fs::read_to_string(path) {
            if !text.trim().is_empty() {
                return text;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("cursor file not written: {}", path.display());
}
