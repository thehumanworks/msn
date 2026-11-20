//! `msn pin`, `msn unpin` and `msn pins` (ADR 0038).
#[allow(dead_code)]
mod common;

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use common::{MockServer, Scripted};

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn tmp_dir(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{prefix}-{}-{nanos}-{seq}", std::process::id()))
}

fn bin(state: &PathBuf) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_msn"));
    cmd.env_clear()
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .env("HOME", state)
        .env("XDG_STATE_HOME", state.join("state"))
        .env("XDG_CONFIG_HOME", state.join("config"));
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }
    cmd
}

fn run(server: &MockServer, args: &[&str]) -> std::process::Output {
    bin(&tmp_dir("msn-pins"))
        .args([
            "--url",
            &server.url(),
            "--tenant",
            "team",
            "--token",
            "owner-secret",
        ])
        .args(args)
        .output()
        .expect("run msn")
}

#[test]
fn pin_puts_and_prints_the_server_result() {
    let body = r#"{"pin":{"id":42,"pinnedAt":"2026-11-19T00:00:00.000Z"},"created":true}"#;
    let server = MockServer::spawn(vec![Scripted::json(201, body)]);
    let out = run(&server, &["pin", "work", "42"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), body);
    let recorded = server.recorded();
    assert_eq!(recorded[0].method, "PUT");
    assert_eq!(recorded[0].path, "/api/tenants/team/channels/work/pins/42");
}

#[test]
fn unpin_deletes_and_says_unpinned() {
    let server = MockServer::spawn(vec![Scripted::empty(204)]);
    let out = run(&server, &["unpin", "work", "42"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let printed: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        printed,
        serde_json::json!({"unpinned": true, "channel": "work", "id": 42})
    );
    let recorded = server.recorded();
    assert_eq!(recorded[0].method, "DELETE");
    assert_eq!(recorded[0].path, "/api/tenants/team/channels/work/pins/42");
}

#[test]
fn pins_lists_and_errors_keep_their_exit_codes() {
    let list = r#"{"pins":[],"limit":10}"#;
    let server = MockServer::spawn(vec![
        Scripted::json(200, list),
        Scripted::json(
            403,
            r#"{"error":{"code":"owner_required","message":"Owner only."}}"#,
        ),
        Scripted::json(
            409,
            r#"{"error":{"code":"pin_limit","message":"At most 10."}}"#,
        ),
    ]);
    let out = run(&server, &["pins", "work"]);
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), list);
    let denied = run(&server, &["pin", "work", "1"]);
    assert!(!denied.status.success());
    assert!(String::from_utf8_lossy(&denied.stderr).contains("Owner only."));
    let full = run(&server, &["pin", "work", "2"]);
    assert!(!full.status.success());
    assert!(String::from_utf8_lossy(&full.stderr).contains("At most 10."));
    assert_eq!(
        server.recorded()[0].path,
        "/api/tenants/team/channels/work/pins"
    );
}

#[test]
fn bad_message_ids_fail_before_any_request() {
    let server = MockServer::spawn(vec![]);
    for id in ["0", "x", "-1"] {
        let out = run(&server, &["pin", "work", id]);
        assert_eq!(out.status.code(), Some(2), "{id}");
    }
    assert!(server.recorded().is_empty());
}
