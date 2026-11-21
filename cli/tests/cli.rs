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
//! I15 provision_binds_username_flag_only / provision_binds_prefix / rotate_unbind_and_keep
//! I16 bind_flags_are_exclusive / send_username_bound_exits_3
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
//! Addendum (2026-09-20): coordination event journal (`msn events` / `msn watch`, ADR 0017)
//! J1 events_query_params / events_without_channel_omits_the_query_param
//!    / events_rejects_invalid_wait_limit
//! J2 events_fails_closed_on_a_malformed_page (event cursor vs. message cursor never confused)
//! J3 watch_prints_one_json_event_per_line_and_reconnects_from_the_last_cursor
//! J4 watch_retries_503_then_continues_from_the_same_cursor / watch_fatal_404
//! J5 watch_sigint_exits_0
//! H2 help_lists_commands_and_env (adds `events`, `watch`)
//!
//! Reader/key workflow addendum:
//! R1 automatic cursors require a reader, stay independent under shared HOME, and survive token rotation
//! R2 cursor sidecar exclusion; ordinary/signal cleanup; SIGKILL/stale-lock manual recovery
//! R3 stdout failure and empty pages never advance cursor progress
//! K1 whoami and participant-key admin routes, explicit binding only, correct credentials/statuses
//! E1 legacy env fallbacks, canonical env precedence (even empty), explicit flag precedence
//!
//! Historical mutation run before reader/key changes (cargo mutants -f src/lib.rs -f src/cursor.rs -f src/args.rs -f src/main.rs):
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
    let home = tmp_file("msn-test-home");
    cmd.env("HOME", &home);
    cmd.env("XDG_STATE_HOME", home.join("state"));
    cmd.env("XDG_CONFIG_HOME", home.join("config"));
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
fn send_forwards_a_quote_with_its_reply_target() {
    // Quote in a reply (ADR 0059): --quote goes out as `quote`, next to replyTo.
    let body = r#"{"message":{"id":43,"replyTo":42,"quote":"Then tag the CLI."},"replayed":false}"#;
    let server = MockServer::spawn(vec![Scripted::json(201, body)]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "--username",
        "responder",
        "send",
        "general",
        "--text",
        "Tagging now",
        "--reply-to",
        "42",
        "--quote",
        "Then tag the CLI.",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    let payload: serde_json::Value = serde_json::from_slice(&server.recorded()[0].body).unwrap();
    assert_eq!(
        payload,
        serde_json::json!({
            "username": "responder",
            "text": "Tagging now",
            "replyTo": 42,
            "quote": "Then tag the CLI."
        })
    );
    // A quote needs a reply target, and must be non-blank and at most 2,048 bytes.
    let server = MockServer::spawn(vec![]);
    let url = server.url();
    let long = "x".repeat(2049);
    for extra in [
        vec!["--quote", "orphan"],
        vec!["--reply-to", "42", "--quote", " "],
        vec!["--reply-to", "42", "--quote", &long],
    ] {
        let mut args = tenant_args(&url).to_vec();
        args.extend(["--username", "u", "send", "general", "--text", "x"]);
        args.extend(extra.iter().copied());
        let out = output_of(&args);
        assert_eq!(
            out.status.code(),
            Some(2),
            "{extra:?}: {}",
            stderr_str(&out)
        );
    }
    assert!(server.recorded().is_empty());
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

fn json_content_type(rec: &common::Recorded) -> bool {
    rec.headers
        .get("content-type")
        .map(|value| value.split(';').next().unwrap_or("").trim() == "application/json")
        .unwrap_or(false)
}

#[test]
fn provision_binds_username_flag_only() {
    let bound = r#"{"tenant":"team","token":"t","username":"thehuman","usernamePrefix":null}"#;
    let server = MockServer::spawn(vec![
        Scripted::json(201, bound),
        Scripted::json(201, bound),
        Scripted::json(
            201,
            r#"{"tenant":"team","token":"t","username":null,"usernamePrefix":null}"#,
        ),
    ]);
    let url = server.url();
    // Flag after the subcommand, as documented in the issue.
    let out = output_of(&[
        "--url",
        &url,
        "--admin-token",
        "admin-secret",
        "provision",
        "team",
        "--username",
        "thehuman",
    ]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    assert_eq!(stdout_str(&out).trim(), bound);
    // Flag before the subcommand (global) binds too.
    let out = output_of(&[
        "--url",
        &url,
        "--admin-token",
        "admin-secret",
        "--username",
        "thehuman",
        "provision",
        "team",
    ]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    // MSN_USERNAME from the environment must not bind a token.
    let out = bin()
        .env("MSN_USERNAME", "agent-from-env")
        .args([
            "--url",
            &url,
            "--admin-token",
            "admin-secret",
            "provision",
            "team",
        ])
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let rec = server.recorded();
    assert_eq!(rec.len(), 3);
    for bound_call in &rec[..2] {
        assert_eq!(bound_call.method, "PUT");
        assert_eq!(bound_call.path, "/api/admin/tenants/team");
        assert!(json_content_type(bound_call));
        let payload: serde_json::Value = serde_json::from_slice(&bound_call.body).unwrap();
        assert_eq!(payload, serde_json::json!({ "username": "thehuman" }));
    }
    assert!(
        rec[2].body.is_empty(),
        "env-only run sent {:?}",
        rec[2].body
    );
    assert!(!json_content_type(&rec[2]));
}

#[test]
fn provision_binds_prefix() {
    let server = MockServer::spawn(vec![Scripted::json(
        201,
        r#"{"tenant":"agents","token":"t","username":null,"usernamePrefix":"agent-"}"#,
    )]);
    let url = server.url();
    let out = output_of(&[
        "--url",
        &url,
        "--admin-token",
        "admin-secret",
        "provision",
        "agents",
        "--username-prefix",
        "agent-",
    ]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    let rec = server.recorded();
    let payload: serde_json::Value = serde_json::from_slice(&rec[0].body).unwrap();
    assert_eq!(payload, serde_json::json!({ "usernamePrefix": "agent-" }));
}

#[test]
fn rotate_unbind_and_keep() {
    let server = MockServer::spawn(vec![
        Scripted::json(
            200,
            r#"{"tenant":"team","token":"n","username":null,"usernamePrefix":null}"#,
        ),
        Scripted::json(
            200,
            r#"{"tenant":"team","token":"n","username":"thehuman","usernamePrefix":null}"#,
        ),
        Scripted::json(
            200,
            r#"{"tenant":"team","token":"n","username":"other","usernamePrefix":null}"#,
        ),
    ]);
    let url = server.url();
    let base = [
        "--url",
        &url,
        "--admin-token",
        "admin-secret",
        "rotate",
        "team",
    ];
    let out = output_of(&[&base[..], &["--unbind"]].concat());
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    let out = output_of(&base);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    let out = output_of(&[&base[..], &["--username", "other"]].concat());
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    let rec = server.recorded();
    assert_eq!(rec.len(), 3);
    assert!(rec.iter().all(|r| r.method == "POST"));
    assert!(
        rec.iter()
            .all(|r| r.path == "/api/admin/tenants/team/token")
    );
    let cleared: serde_json::Value = serde_json::from_slice(&rec[0].body).unwrap();
    assert_eq!(cleared, serde_json::json!({ "username": null }));
    assert!(rec[1].body.is_empty(), "plain rotate must send no body");
    assert!(!json_content_type(&rec[1]));
    let rebound: serde_json::Value = serde_json::from_slice(&rec[2].body).unwrap();
    assert_eq!(rebound, serde_json::json!({ "username": "other" }));
}

#[test]
fn bind_flags_are_exclusive() {
    let server = MockServer::spawn(vec![Scripted::json(200, r#"{}"#)]);
    let url = server.url();
    let admin = ["--url", &url, "--admin-token", "admin-secret"];
    for extra in [
        &[
            "provision",
            "team",
            "--username",
            "a",
            "--username-prefix",
            "b",
        ][..],
        &["rotate", "team", "--unbind", "--username", "a"][..],
        &["rotate", "team", "--unbind", "--username-prefix", "b"][..],
    ] {
        let out = output_of(&[&admin[..], extra].concat());
        assert_eq!(out.status.code(), Some(2), "{extra:?} {}", stderr_str(&out));
        assert!(
            stderr_str(&out).contains("only one of"),
            "{}",
            stderr_str(&out)
        );
    }
    assert!(server.recorded().is_empty());
}

#[test]
fn send_username_bound_exits_3() {
    let server = MockServer::spawn(vec![Scripted::json(
        403,
        r#"{"error":{"code":"username_bound","message":"This access key may only send as \"thehuman\"."}}"#,
    )]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend(["--username", "impostor", "send", "general", "--text", "hi"]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(3), "{}", stderr_str(&out));
    assert!(stderr_str(&out).contains("only send as \"thehuman\""));
    let payload: serde_json::Value = serde_json::from_slice(&server.recorded()[0].body).unwrap();
    assert_eq!(payload["username"], "impostor");
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
        "export",
        "import",
        "MSN_URL",
        "MSN_WORKSPACE_TENANT",
        "MSN_WORKSPACE_TOKEN",
        "MSN_ADMIN_TOKEN",
        "MSN_USERNAME",
        "MSN_READER",
        "MSN_TENANT",
        "MSN_TOKEN",
        "whoami",
        "key-create",
        "key-revoke",
        "keys",
        "replays history",
        "Legacy shared cursors",
        "revokes all participant keys",
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

fn read_args<'a>(url: &'a str, extra: &[&'a str]) -> Vec<&'a str> {
    let mut args = tenant_args(url).to_vec();
    args.extend(["read", "general"]);
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
fn read_empty_page_prints_once_without_advancing_cursor() {
    let server = MockServer::spawn(vec![Scripted::json(200, EMPTY_PAGE)]);
    let url = server.url();
    let file = tmp_file("msn-read-empty-cursor");
    let out = output_of(&read_args(&url, &["--cursor-file", file.to_str().unwrap()]));

    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    assert_eq!(stdout_str(&out).trim(), EMPTY_PAGE);
    assert_eq!(server.recorded().len(), 1);
    assert_eq!(
        server.recorded()[0].path,
        "/api/tenants/team/channels/general/messages?after=0&wait=0&limit=100"
    );
    assert!(!file.exists(), "an empty page must not advance the cursor");
}

#[test]
fn read_does_not_retry_server_errors() {
    let server = MockServer::spawn(vec![Scripted::json(503, r#"{"error":"busy"}"#)]);
    let url = server.url();
    let out = output_of(&read_args(&url, &["--after", "4", "--wait", "1"]));

    assert_eq!(out.status.code(), Some(1));
    assert!(stderr_str(&out).contains("503"), "{}", stderr_str(&out));
    assert_eq!(server.recorded().len(), 1);
}

#[test]
fn read_rejects_out_of_range_bounds_before_network() {
    let server = MockServer::spawn(vec![]);
    let url = server.url();
    for flags in [["--wait", "26"].as_slice(), ["--limit", "0"].as_slice()] {
        let out = output_of(&read_args(&url, flags));
        assert_eq!(out.status.code(), Some(2), "{}", stderr_str(&out));
    }
    assert!(server.recorded().is_empty());
}

#[test]
fn read_default_cursor_resumes_after_previous_run() {
    let first = r#"{"messages":[{"id":3}],"nextCursor":3,"hasMore":false}"#;
    let second = r#"{"messages":[{"id":4}],"nextCursor":4,"hasMore":false}"#;
    let server = MockServer::spawn(vec![
        Scripted::json(200, first),
        Scripted::json(200, second),
    ]);
    let url = server.url();
    let home = tmp_file("msn-read-home");
    fs::create_dir_all(&home).unwrap();
    let run = || {
        let mut cmd = bin();
        cmd.env("HOME", &home)
            .env_remove("XDG_STATE_HOME")
            .args(read_args(&url, &["--reader", "alice"]));
        output_capped(cmd, Duration::from_secs(8))
    };

    let out1 = run();
    assert_eq!(out1.status.code(), Some(0), "{}", stderr_str(&out1));
    assert_eq!(stdout_str(&out1).trim(), first);
    let out2 = run();
    assert_eq!(out2.status.code(), Some(0), "{}", stderr_str(&out2));
    assert_eq!(stdout_str(&out2).trim(), second);

    let rec = server.recorded();
    assert_eq!(rec.len(), 2);
    assert!(rec[0].path.contains("after=0&wait=0"), "{}", rec[0].path);
    assert!(rec[1].path.contains("after=3&wait=0"), "{}", rec[1].path);
    let msn_dir = home.join(".local").join("state").join("msn");
    let origin = fs::read_dir(msn_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let file = origin
        .join("team")
        .join("readers")
        .join(msn_cli::cursor::reader_hash("alice").unwrap())
        .join("general.json");
    assert_eq!(read_cursor(&file)["after"], 4);
    assert_mode_0600(&file);
    let _ = fs::remove_dir_all(&home);
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
            .env_remove("XDG_STATE_HOME")
            .args(wait_args(&url, &["--wait", "1", "--reader", "alice"]));
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
    let file = origins[0]
        .path()
        .join("team")
        .join("readers")
        .join(msn_cli::cursor::reader_hash("alice").unwrap())
        .join("general.json");
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
        .env_remove("XDG_STATE_HOME")
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

#[test]
fn whoami_uses_workspace_token_and_prints_binding() {
    for body in [
        r#"{"tenant":"team","username":"alice","usernamePrefix":null}"#,
        r#"{"tenant":"team","username":null,"usernamePrefix":"agent-"}"#,
        r#"{"tenant":"team","username":null,"usernamePrefix":null}"#,
    ] {
        let server = MockServer::spawn(vec![Scripted::json(200, body)]);
        let out = output_of(&[&tenant_args(&server.url())[..], &["whoami"]].concat());
        assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
        assert_eq!(stdout_str(&out).trim(), body);
        let rec = server.recorded();
        assert_eq!(rec[0].method, "GET");
        assert_eq!(rec[0].path, "/api/tenants/team");
        assert_eq!(rec[0].headers["authorization"], "Bearer tenant-secret");
    }
}

#[test]
fn participant_key_workflow_uses_admin_routes_without_workspace_token() {
    let created = r#"{"id":"alice","token":"participant-secret","username":"alice","usernamePrefix":null,"createdAt":"t"}"#;
    let listed =
        r#"{"keys":[{"id":"alice","username":"alice","usernamePrefix":null,"createdAt":"t"}]}"#;
    let server = MockServer::spawn(vec![
        Scripted::json(201, created),
        Scripted::json(200, listed),
        Scripted::empty(204),
    ]);
    let url = server.url();
    let base = [
        "--url",
        &url,
        "--tenant",
        "team",
        "--admin-token",
        "admin-secret",
    ];
    for (args, method, path, body) in [
        (
            &["key-create", "alice", "--username", "alice"][..],
            "PUT",
            "/api/admin/tenants/team/keys/alice",
            created,
        ),
        (&["keys"][..], "GET", "/api/admin/tenants/team/keys", listed),
        (
            &["key-revoke", "alice"][..],
            "DELETE",
            "/api/admin/tenants/team/keys/alice",
            r#"{"deleted":true}"#,
        ),
    ] {
        let out = output_of(&[&base[..], args].concat());
        assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
        assert_eq!(stdout_str(&out).trim(), body);
        let rec = server.recorded();
        let last = rec.last().unwrap();
        assert_eq!(last.method, method);
        assert_eq!(last.path, path);
        assert_eq!(last.headers["authorization"], "Bearer admin-secret");
        if method == "PUT" {
            assert!(json_content_type(last));
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&last.body).unwrap(),
                serde_json::json!({"username":"alice"})
            );
        } else {
            assert!(last.body.is_empty());
            assert!(!stdout_str(&out).contains("participant-secret"));
        }
    }
}

#[test]
fn key_create_only_explicit_binding_flags_count() {
    let server = MockServer::spawn(vec![Scripted::json(201, "{}"), Scripted::json(201, "{}")]);
    let url = server.url();
    let base = [
        "--url",
        &url,
        "--tenant",
        "team",
        "--admin-token",
        "admin-secret",
    ];
    // Global username flag before the subcommand also binds; env never does.
    for (args, expected) in [
        (
            &["--username", "alice", "key-create", "one"][..],
            serde_json::json!({"username":"alice"}),
        ),
        (
            &["key-create", "two", "--username-prefix", "agent-"][..],
            serde_json::json!({"usernamePrefix":"agent-"}),
        ),
    ] {
        let mut cmd = bin();
        cmd.env("MSN_USERNAME", "ambient").args(base).args(args);
        let out = output_capped(cmd, Duration::from_secs(3));
        assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
        let rec = server.recorded();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&rec.last().unwrap().body).unwrap(),
            expected
        );
    }
    for args in [
        &["key-create", "one"][..],
        &[
            "key-create",
            "one",
            "--username",
            "alice",
            "--username-prefix",
            "agent-",
        ],
        &["key-create", "one", "--username", "   "],
        &["key-create", "one", "--username-prefix", ""],
        &["key-create", "BAD", "--username", "alice"],
        &["key-revoke", "../bad"],
    ] {
        let mut cmd = bin();
        cmd.env("MSN_USERNAME", "ambient").args(base).args(args);
        let out = output_capped(cmd, Duration::from_secs(3));
        assert_eq!(out.status.code(), Some(2), "{args:?}: {}", stderr_str(&out));
        if args.len() == 2 && args[0] == "key-create" {
            assert!(stderr_str(&out).contains("explicit --username"));
        }
    }
    assert_eq!(
        server.recorded().len(),
        2,
        "invalid commands reached network"
    );
}

#[test]
fn participant_commands_require_the_correct_credentials_and_tenant() {
    let server = MockServer::spawn(vec![]);
    let url = server.url();
    for command in [
        &["keys"][..],
        &["key-create", "alice", "--username", "alice"],
        &["key-revoke", "alice"],
    ] {
        let out = output_of(&[&tenant_args(&url)[..], command].concat());
        assert_eq!(out.status.code(), Some(2));
        assert!(stderr_str(&out).contains("MSN_ADMIN_TOKEN"));
        let out = output_of(&[&["--url", &url, "--admin-token", "admin"][..], command].concat());
        assert_eq!(out.status.code(), Some(2));
        assert!(stderr_str(&out).contains("MSN_WORKSPACE_TENANT"));
    }
    let out = output_of(&[
        "--url",
        &url,
        "--tenant",
        "team",
        "--admin-token",
        "admin",
        "whoami",
    ]);
    assert_eq!(out.status.code(), Some(2));
    assert!(stderr_str(&out).contains("MSN_WORKSPACE_TOKEN"));
    assert!(server.recorded().is_empty());
}

#[test]
fn participant_commands_preserve_status_exit_codes() {
    for (args, status, exit) in [
        (&["key-create", "alice", "--username", "alice"][..], 409, 5),
        (&["key-revoke", "missing"][..], 404, 4),
        (&["keys"][..], 403, 3),
        (&["whoami"][..], 401, 3),
    ] {
        let server = MockServer::spawn(vec![Scripted::json(
            status,
            r#"{"error":{"message":"denied"}}"#,
        )]);
        let out = output_of(
            &[
                &tenant_args(&server.url())[..],
                &["--admin-token", "admin"],
                args,
            ]
            .concat(),
        );
        assert_eq!(out.status.code(), Some(exit), "{}", stderr_str(&out));
        assert!(out.stdout.is_empty());
        assert!(stderr_str(&out).contains("denied"));
    }
}

#[test]
fn legacy_env_aliases_canonical_and_flag_precedence() {
    let server = MockServer::spawn(
        (0..3)
            .map(|_| Scripted::json(200, r#"{"channels":[]}"#))
            .collect(),
    );
    let url = server.url();
    for (canonical, flags, expected_tenant, expected_token) in [
        (false, false, "legacy", "legacy-token"),
        (true, false, "canonical", "canonical-token"),
        (true, true, "flag", "flag-token"),
    ] {
        let mut cmd = bin();
        cmd.env("MSN_TENANT", "legacy")
            .env("MSN_TOKEN", "legacy-token")
            .args(["--url", &url]);
        if canonical {
            cmd.env("MSN_WORKSPACE_TENANT", "canonical")
                .env("MSN_WORKSPACE_TOKEN", "canonical-token");
        }
        if flags {
            cmd.args(["--tenant", "flag", "--token", "flag-token"]);
        }
        cmd.arg("channels");
        let out = output_capped(cmd, Duration::from_secs(3));
        assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
        let rec = server.recorded();
        let last = rec.last().unwrap();
        assert_eq!(
            last.path,
            format!("/api/tenants/{expected_tenant}/channels?limit=1000")
        );
        assert_eq!(
            last.headers["authorization"],
            format!("Bearer {expected_token}")
        );
    }
    for canonical in ["MSN_WORKSPACE_TENANT", "MSN_WORKSPACE_TOKEN"] {
        let mut cmd = bin();
        cmd.env("MSN_TENANT", "legacy")
            .env("MSN_TOKEN", "legacy-token")
            .env(canonical, "")
            .args(["--url", &url, "channels"]);
        let out = output_capped(cmd, Duration::from_secs(3));
        assert_eq!(out.status.code(), Some(2), "{}", stderr_str(&out));
    }
    assert_eq!(server.recorded().len(), 3);
}

struct StateHome(PathBuf);

impl StateHome {
    fn new() -> Self {
        let path = tmp_file("msn-reader-home");
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn command(&self) -> Command {
        let mut cmd = bin();
        cmd.env("HOME", &self.0)
            .env("XDG_STATE_HOME", self.0.join("state"));
        cmd
    }

    fn cursor(&self, url: &str, reader: &str) -> PathBuf {
        self.0
            .join("state/msn")
            .join(msn_cli::cursor::origin_hash(&url::Url::parse(url).unwrap()))
            .join("team/readers")
            .join(msn_cli::cursor::reader_hash(reader).unwrap())
            .join("general.json")
    }
}

impl Drop for StateHome {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn distinct_readers_share_home_but_each_replays_history_and_rotation_preserves_progress() {
    let next = r#"{"messages":[{"id":9}],"nextCursor":9,"hasMore":false}"#;
    let server = MockServer::spawn(vec![
        Scripted::json(200, PAGE_7_8),
        Scripted::json(200, PAGE_7_8),
        Scripted::json(200, next),
    ]);
    let url = server.url();
    let home = StateHome::new();
    let legacy = home
        .cursor(&url, "alice")
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("general.json");
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    let old = format!(r#"{{"server":"{url}","tenant":"team","channel":"general","after":999}}"#);
    fs::write(&legacy, &old).unwrap();
    for (reader, token, page) in [
        ("alice", "first-token", PAGE_7_8),
        ("bob", "first-token", PAGE_7_8),
        ("alice", "rotated-token", next),
    ] {
        let mut cmd = home.command();
        cmd.args([
            "--url", &url, "--tenant", "team", "--token", token, "wait", "general", "--reader",
            reader,
        ]);
        let out = output_capped(cmd, Duration::from_secs(3));
        assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
        assert_eq!(stdout_str(&out).trim(), page);
        assert_eq!(read_cursor(&home.cursor(&url, reader))["reader"], reader);
        assert_mode_0600(&home.cursor(&url, reader));
    }
    let rec = server.recorded();
    assert!(rec[0].path.contains("after=0&"));
    assert!(rec[1].path.contains("after=0&"));
    assert!(rec[2].path.contains("after=8&"));
    assert_eq!(rec[2].headers["authorization"], "Bearer rotated-token");
    assert_eq!(
        fs::read_to_string(legacy).unwrap(),
        old,
        "legacy state changed"
    );
}

#[test]
fn reader_precedence_flag_then_env_then_username_flag_or_env() {
    let server = MockServer::spawn((0..4).map(|_| Scripted::json(200, PAGE_7_8)).collect());
    let url = server.url();
    let home = StateHome::new();
    for (flags, env_reader, expected) in [
        (
            &["--reader", "reader-flag", "--username", "username-flag"][..],
            Some("reader-env"),
            "reader-flag",
        ),
        (
            &["--username", "username-flag"][..],
            Some("reader-env"),
            "reader-env",
        ),
        (&["--username", "username-flag"][..], None, "username-flag"),
        (&[][..], None, "username-env"),
    ] {
        let mut cmd = home.command();
        cmd.env("MSN_USERNAME", "username-env")
            .args(wait_args(&url, flags));
        if let Some(reader) = env_reader {
            cmd.env("MSN_READER", reader);
        }
        let out = output_capped(cmd, Duration::from_secs(3));
        assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
        assert_eq!(
            read_cursor(&home.cursor(&url, expected))["reader"],
            expected
        );
    }
    assert!(
        server
            .recorded()
            .iter()
            .all(|rec| rec.path.contains("after=0&"))
    );
}

#[test]
fn automatic_wait_infers_an_exact_reader_or_requires_a_valid_override() {
    let server = MockServer::spawn(vec![Scripted::json(
        200,
        r#"{"tenant":"team","username":null,"usernamePrefix":null}"#,
    )]);
    let url = server.url();
    let out = output_of(&wait_args(&url, &[]));
    assert_eq!(out.status.code(), Some(2));
    for option in ["--reader", "--username"] {
        assert!(stderr_str(&out).contains(option), "{}", stderr_str(&out));
    }
    for invalid in [
        "".to_string(),
        " \t".to_string(),
        "x".repeat(129),
        "🙂".repeat(33),
    ] {
        let out = output_of(&wait_args(
            &url,
            &["--reader", &invalid, "--username", "valid-fallback"],
        ));
        assert_eq!(out.status.code(), Some(2), "{}", stderr_str(&out));
        assert!(stderr_str(&out).contains("128 UTF-8 bytes"));
    }
    let mut cmd = bin();
    cmd.env("MSN_USERNAME", " ").args(wait_args(&url, &[]));
    let out = output_capped(cmd, Duration::from_secs(3));
    assert_eq!(out.status.code(), Some(2));
    let recorded = server.recorded();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].path, "/api/tenants/team");
}

#[test]
fn explicit_cursor_and_after_do_not_require_reader_or_home() {
    let server = MockServer::spawn(vec![
        Scripted::json(200, PAGE_7_8),
        Scripted::json(200, PAGE_7_8),
    ]);
    let home = StateHome::new();
    let file = home.0.join("explicit.json");
    for flags in [
        &["--cursor-file", file.to_str().unwrap()][..],
        &["--after", "0"],
    ] {
        let mut cmd = bin();
        cmd.env_remove("HOME")
            .env_remove("XDG_STATE_HOME")
            .env("MSN_READER", " ")
            .args(wait_args(&server.url(), flags));
        let out = output_capped(cmd, Duration::from_secs(3));
        assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    }
    assert_eq!(read_cursor(&file)["after"], 8);
    assert!(read_cursor(&file).get("reader").is_none());
}

fn lock_path(path: &std::path::Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".lock");
    PathBuf::from(name)
}

fn wait_for_request(server: &MockServer) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while server.recorded().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(!server.recorded().is_empty(), "child did not start polling");
}

fn exit_capped(child: &mut std::process::Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() > deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("child did not exit promptly");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[cfg(unix)]
fn same_cursor_excludes_competitors_and_signal_cleanup_allows_resume() {
    for signal in ["-INT", "-TERM", "-HUP"] {
        let server = MockServer::spawn(vec![
            Scripted::json(200, PAGE_7_8).delayed(Duration::from_secs(30)),
        ]);
        let url = server.url();
        let home = StateHome::new();
        let file = home.0.join("cursor.json");
        let before =
            format!(r#"{{"server":"{url}","tenant":"team","channel":"general","after":3}}"#);
        fs::write(&file, &before).unwrap();
        let mut first = home
            .command()
            .args(wait_args(&url, &["--cursor-file", file.to_str().unwrap()]))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        wait_for_request(&server);
        assert!(lock_path(&file).exists());
        assert_mode_0600(&lock_path(&file));
        // A follow process competes with wait; both use the same lock protocol.
        let out = output_of(
            &[
                &tenant_args(&url)[..],
                &[
                    "follow",
                    "general",
                    "--once",
                    "--cursor-file",
                    file.to_str().unwrap(),
                ],
            ]
            .concat(),
        );
        assert_eq!(out.status.code(), Some(5), "{}", stderr_str(&out));
        assert!(stderr_str(&out).contains("manually remove"));
        assert!(lock_path(&file).exists(), "competitor removed owner's lock");
        assert_eq!(server.recorded().len(), 1);
        assert!(
            Command::new("kill")
                .args([signal, &first.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
        assert_eq!(exit_capped(&mut first).code(), Some(0));
        assert!(!lock_path(&file).exists(), "lock survived {signal}");
        assert_eq!(fs::read_to_string(&file).unwrap(), before);
        let lock = msn_cli::cursor::CursorLock::acquire(&file).unwrap();
        drop(lock);
        assert!(!lock_path(&file).exists());
    }
}

#[test]
fn stale_lock_is_never_automatically_removed() {
    let server = MockServer::spawn(vec![]);
    let home = StateHome::new();
    let file = home.0.join("cursor.json");
    let stale = "{\"pid\":99999999}\n";
    fs::write(lock_path(&file), stale).unwrap();
    let out = output_of(&wait_args(
        &server.url(),
        &["--cursor-file", file.to_str().unwrap()],
    ));
    assert_eq!(out.status.code(), Some(5));
    assert!(stderr_str(&out).contains("confirming the owner"));
    assert_eq!(fs::read_to_string(lock_path(&file)).unwrap(), stale);
    assert!(server.recorded().is_empty());
}

#[test]
fn cursor_lock_cleanup_on_success_and_error() {
    for (status, body, code) in [(200, PAGE_7_8, 0), (404, "{}", 4), (200, "invalid-json", 1)] {
        let server = MockServer::spawn(vec![Scripted::json(status, body)]);
        let home = StateHome::new();
        let file = home.0.join("cursor.json");
        let out = output_of(&wait_args(
            &server.url(),
            &["--cursor-file", file.to_str().unwrap()],
        ));
        assert_eq!(out.status.code(), Some(code), "{}", stderr_str(&out));
        assert!(!lock_path(&file).exists());
    }
    let server = MockServer::spawn(vec![]);
    let home = StateHome::new();
    let file = home.0.join("cursor.json");
    fs::write(&file, "invalid-json").unwrap();
    let out = output_of(&wait_args(
        &server.url(),
        &["--cursor-file", file.to_str().unwrap()],
    ));
    assert_eq!(out.status.code(), Some(2));
    assert!(!lock_path(&file).exists());
    assert!(server.recorded().is_empty());
}

#[test]
#[cfg(unix)]
fn failed_stdout_never_advances_cursor_and_releases_lock() {
    for command in ["wait", "follow"] {
        let server = MockServer::spawn(vec![
            Scripted::json(200, PAGE_7_8).delayed(Duration::from_millis(150)),
        ]);
        let url = server.url();
        let home = StateHome::new();
        let file = home.0.join("cursor.json");
        let before =
            format!(r#"{{"server":"{url}","tenant":"team","channel":"general","after":3}}"#);
        fs::write(&file, &before).unwrap();
        let mut child = home
            .command()
            .args(tenant_args(&url))
            .args([command, "general", "--cursor-file", file.to_str().unwrap()])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        drop(child.stdout.take()); // Close the only read end before the response arrives.
        assert!(!exit_capped(&mut child).success());
        assert_eq!(fs::read_to_string(&file).unwrap(), before);
        assert!(!lock_path(&file).exists());
    }
}

#[test]
#[cfg(unix)]
fn empty_pages_do_not_acknowledge_progress_without_stdout() {
    for command in ["wait", "follow"] {
        let server = MockServer::spawn(vec![
            Scripted::json(200, r#"{"messages":[],"nextCursor":100,"hasMore":false}"#),
            Scripted::json(200, PAGE_7_8).delayed(Duration::from_secs(30)),
        ]);
        let url = server.url();
        let home = StateHome::new();
        let file = home.0.join("cursor.json");
        let before =
            format!(r#"{{"server":"{url}","tenant":"team","channel":"general","after":3}}"#);
        fs::write(&file, &before).unwrap();
        let mut child = home
            .command()
            .args(tenant_args(&url))
            .args([command, "general", "--cursor-file", file.to_str().unwrap()])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while server.recorded().len() < 2 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(server.recorded().len(), 2);
        interrupt(child.id());
        assert_eq!(exit_capped(&mut child).code(), Some(0));
        let mut output = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        assert!(output.is_empty());
        assert!(server.recorded()[1].path.contains("after=3&"));
        assert_eq!(fs::read_to_string(&file).unwrap(), before);
        assert!(!lock_path(&file).exists());
    }
}

#[test]
#[cfg(unix)]
fn automatic_same_reader_is_locked_and_sigkill_requires_manual_recovery() {
    let server = MockServer::spawn(vec![
        Scripted::json(200, PAGE_7_8).delayed(Duration::from_secs(30)),
    ]);
    let url = server.url();
    let home = StateHome::new();
    let file = home.cursor(&url, "alice");
    let mut child = home
        .command()
        .args(wait_args(&url, &["--reader", "alice"]))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    wait_for_request(&server);
    let mut cmd = home.command();
    cmd.args(wait_args(&url, &["--reader", "alice"]));
    let out = output_capped(cmd, Duration::from_secs(3));
    assert_eq!(out.status.code(), Some(5));
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(lock_path(&file).exists());
    let mut cmd = home.command();
    cmd.args(wait_args(&url, &["--reader", "alice"]));
    let out = output_capped(cmd, Duration::from_secs(3));
    assert_eq!(out.status.code(), Some(5));
    assert!(lock_path(&file).exists());
    assert_eq!(server.recorded().len(), 1);
    assert!(!file.exists(), "undelivered response advanced cursor");
}

#[test]
fn events_query_params() {
    let server = MockServer::spawn(vec![Scripted::json(
        200,
        r#"{"events":[],"nextCursor":5,"hasMore":false}"#,
    )]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "events",
        "--after",
        "5",
        "--wait",
        "3",
        "--limit",
        "10",
        "--channel",
        "general",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    assert_eq!(
        server.recorded()[0].path,
        "/api/tenants/team/events?after=5&wait=3&limit=10&channel=general"
    );
}

#[test]
fn events_without_channel_omits_the_query_param() {
    let server = MockServer::spawn(vec![Scripted::json(
        200,
        r#"{"events":[],"nextCursor":0,"hasMore":false}"#,
    )]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.push("events");
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    assert_eq!(
        server.recorded()[0].path,
        "/api/tenants/team/events?after=0&wait=0&limit=100"
    );
}

#[test]
fn events_rejects_invalid_wait_limit() {
    let server = MockServer::spawn(vec![Scripted::json(200, r#"{}"#)]);
    let url = server.url();
    for extra in [["events", "--wait", "26"], ["events", "--limit", "0"]] {
        let mut args = tenant_args(&url).to_vec();
        args.extend(extra);
        let out = output_of(&args);
        assert_eq!(out.status.code(), Some(2), "{extra:?} {}", stderr_str(&out));
    }
    assert!(server.recorded().is_empty());
}

#[test]
fn events_fails_closed_on_a_malformed_page() {
    // A message page shape (`messages`, not `events`) must be rejected, not silently accepted:
    // the event cursor and the message cursor must never be confused.
    let server = MockServer::spawn(vec![Scripted::json(
        200,
        r#"{"messages":[],"nextCursor":0,"hasMore":false}"#,
    )]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.push("events");
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(1), "{}", stderr_str(&out));
}

#[test]
fn watch_prints_one_json_event_per_line_and_reconnects_from_the_last_cursor() {
    let page = r#"{"events":[{"id":7,"tenant":"team","channel":"general","type":"message.created","resourceId":3,"historyRevision":0,"createdAt":"2026-09-20T00:00:00.000Z"},{"id":8,"tenant":"team","channel":"general","type":"message.created","resourceId":4,"historyRevision":0,"createdAt":"2026-09-20T00:00:01.000Z"}],"nextCursor":8,"hasMore":false}"#;
    let server = MockServer::spawn(vec![Scripted::json(200, page)]);
    let url = server.url();
    let mut child = bin()
        .args(tenant_args(&url))
        .args(["watch", "--channel", "general"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn watch");
    let stdout = child.stdout.take().expect("stdout");
    let lines = read_lines_timeout(stdout, 2, Duration::from_secs(3));
    assert_eq!(lines.len(), 2, "watch printed {:?}", lines);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&lines[0]).unwrap()["id"],
        7
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&lines[1]).unwrap()["id"],
        8
    );
    interrupt(child.id());
    let status = child.wait().expect("wait");
    assert_eq!(status.code(), Some(0));
    assert_eq!(
        server.recorded()[0].path,
        "/api/tenants/team/events?after=0&wait=25&limit=100&channel=general"
    );
}

#[test]
fn watch_retries_503_then_continues_from_the_same_cursor() {
    let page = r#"{"events":[{"id":1,"tenant":"team","channel":"general","type":"channel.created","resourceId":null,"historyRevision":0,"createdAt":"2026-09-20T00:00:00.000Z"}],"nextCursor":1,"hasMore":false}"#;
    let server = MockServer::spawn(vec![
        Scripted::json(503, r#"{"error":{"code":"x","message":"busy"}}"#),
        Scripted::json(200, page),
    ]);
    let url = server.url();
    let mut child = bin()
        .args(tenant_args(&url))
        .args(["watch"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");
    let stdout = child.stdout.take().expect("stdout");
    let lines = read_lines_timeout(stdout, 1, Duration::from_secs(5));
    assert_eq!(lines.len(), 1, "watch printed {:?}", lines);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&lines[0]).unwrap()["id"],
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
}

#[test]
fn watch_fatal_404() {
    let server = MockServer::spawn(vec![Scripted::json(
        404,
        r#"{"error":{"code":"tenant_not_found","message":"Tenant not found."}}"#,
    )]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.push("watch");
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(4));
    assert_eq!(server.recorded().len(), 1);
    assert!(stderr_str(&out).contains("Tenant not found"));
}

#[test]
fn watch_sigint_exits_0() {
    let server = MockServer::spawn(vec![
        Scripted::json(200, r#"{"events":[],"nextCursor":0,"hasMore":false}"#)
            .delayed(Duration::from_secs(20)),
    ]);
    let url = server.url();
    let mut child = bin()
        .args(tenant_args(&url))
        .args(["watch"])
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
fn help_lists_events_and_watch() {
    let out = output_of(&["--help"]);
    assert_eq!(out.status.code(), Some(0));
    let text = format!("{}{}", stdout_str(&out), stderr_str(&out));
    for needle in ["events", "watch", "channel.created", "message.created"] {
        assert!(text.contains(needle), "help missing {needle}\n{text}");
    }
}

#[test]
fn ask_posts_a_question_with_choices_and_prints_it() {
    // Ask a question with buttons (ADR 0065): --to and each --choice go out in order.
    let body = r#"{"message":{"id":5,"to":"tomas","choices":["yes","no"]},"replayed":false}"#;
    let server = MockServer::spawn(vec![Scripted::json(201, body)]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "--username",
        "agent",
        "ask",
        "general",
        "Ship it?",
        "--to",
        "tomas",
        "--choice",
        "yes",
        "--choice",
        "no",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    assert!(String::from_utf8_lossy(&out.stdout).contains(r#""choices":["yes","no"]"#));
    let payload: serde_json::Value = serde_json::from_slice(&server.recorded()[0].body).unwrap();
    assert_eq!(
        payload,
        serde_json::json!({"username": "agent", "text": "Ship it?", "to": "tomas", "choices": ["yes", "no"]})
    );
    // Bad choices or a missing --to fail before the network.
    let server = MockServer::spawn(vec![]);
    let url = server.url();
    let long = "x".repeat(129);
    for extra in [
        vec!["--to", "tomas", "--choice", "only"],
        vec!["--to", "tomas", "--choice", "a", "--choice", "a"],
        vec!["--to", "tomas", "--choice", "a", "--choice", &long],
        vec!["--choice", "a", "--choice", "b"],
        vec![
            "--to", "tomas", "--choice", "a", "--choice", "b", "--wait", "0",
        ],
    ] {
        let mut args = tenant_args(&url).to_vec();
        args.extend(["--username", "u", "ask", "general", "Q?"]);
        args.extend(extra.iter().copied());
        let out = output_of(&args);
        assert_eq!(
            out.status.code(),
            Some(2),
            "{extra:?}: {}",
            stderr_str(&out)
        );
    }
    assert!(server.recorded().is_empty());
}

#[test]
fn ask_wait_prints_the_answer_once_the_addressed_name_replies() {
    let server = MockServer::spawn(vec![
        Scripted::json(
            201,
            r#"{"message":{"id":5,"to":"tomas","choices":["yes","no"]},"replayed":false}"#,
        ),
        // An unrelated reply and a plain reply to the question do not count.
        Scripted::json(
            200,
            r#"{"messages":[{"id":6,"replyTo":2,"answer":"x"},{"id":7,"replyTo":5,"text":"hmm"}],"nextCursor":7,"hasMore":false}"#,
        ),
        Scripted::json(
            200,
            r#"{"messages":[{"id":8,"replyTo":5,"answer":"no","text":"no","username":"tomas","createdAt":"2026-11-21T02:00:00Z"}],"nextCursor":8,"hasMore":false}"#,
        ),
    ]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "--username",
        "agent",
        "ask",
        "general",
        "Ship it?",
        "--to",
        "tomas",
        "--choice",
        "yes",
        "--choice",
        "no",
        "--wait",
        "60",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    let printed: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        printed,
        serde_json::json!({"question": 5, "answer": "no", "username": "tomas", "messageId": 8, "answeredAt": "2026-11-21T02:00:00Z"})
    );
    let recorded = server.recorded();
    assert!(
        recorded[1]
            .path
            .contains("/channels/general/messages?thread=5&after=5&wait=25"),
        "{}",
        recorded[1].path
    );
    assert!(
        recorded[2].path.contains("messages?thread=5&after=7&"),
        "{}",
        recorded[2].path
    );
}

#[test]
fn ask_wait_exits_2_with_answered_false_on_timeout() {
    let server = MockServer::spawn(vec![
        Scripted::json(
            201,
            r#"{"message":{"id":5,"to":"tomas","choices":["yes","no"]},"replayed":false}"#,
        ),
        Scripted::json(200, r#"{"messages":[],"nextCursor":5,"hasMore":false}"#)
            .delayed(Duration::from_millis(1200)),
    ]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "--username",
        "agent",
        "ask",
        "general",
        "Ship it?",
        "--to",
        "tomas",
        "--choice",
        "yes",
        "--choice",
        "no",
        "--wait",
        "1",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(2), "{}", stderr_str(&out));
    let printed: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        printed,
        serde_json::json!({"question": 5, "answered": false})
    );
    assert!(stderr_str(&out).contains("Timed out after 1s"));
    assert!(server.recorded()[1].path.contains("wait=1"));
}

#[test]
fn answer_posts_a_reply_whose_text_and_answer_are_the_choice() {
    let server = MockServer::spawn(vec![Scripted::json(
        201,
        r#"{"message":{"id":8},"replayed":false}"#,
    )]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend(["--username", "tomas", "answer", "general", "5", "no"]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    let payload: serde_json::Value = serde_json::from_slice(&server.recorded()[0].body).unwrap();
    assert_eq!(
        payload,
        serde_json::json!({"username": "tomas", "text": "no", "replyTo": 5, "answer": "no"})
    );
}

#[test]
fn send_forwards_replaces_and_refuses_a_bad_id_or_a_schedule() {
    // Replace an instruction (ADR 0068): --replaces goes out as `replaces`.
    let body = r#"{"message":{"id":44,"replaces":43},"replayed":false}"#;
    let server = MockServer::spawn(vec![Scripted::json(201, body)]);
    let url = server.url();
    let mut args = tenant_args(&url).to_vec();
    args.extend([
        "--username",
        "lead",
        "send",
        "general",
        "--text",
        "Deploy to production instead",
        "--replaces",
        "43",
    ]);
    let out = output_of(&args);
    assert_eq!(out.status.code(), Some(0), "{}", stderr_str(&out));
    let payload: serde_json::Value = serde_json::from_slice(&server.recorded()[0].body).unwrap();
    assert_eq!(
        payload,
        serde_json::json!({
            "username": "lead",
            "text": "Deploy to production instead",
            "replaces": 43
        })
    );
    let server = MockServer::spawn(vec![]);
    let url = server.url();
    for extra in [
        vec!["--replaces", "0"],
        vec!["--replaces", "x"],
        vec!["--replaces", "4", "--at", "10m"],
    ] {
        let mut args = tenant_args(&url).to_vec();
        args.extend(["--username", "u", "send", "general", "--text", "x"]);
        args.extend(extra.iter().copied());
        let out = output_of(&args);
        assert_eq!(
            out.status.code(),
            Some(2),
            "{extra:?}: {}",
            stderr_str(&out)
        );
    }
    assert!(server.recorded().is_empty());
}
