#[allow(dead_code)]
mod common;

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
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

fn tenant_args(url: &str) -> [&str; 6] {
    ["--url", url, "--tenant", "team", "--token", "tenant-secret"]
}

#[test]
fn snapshot_template_is_offline_and_has_protocol_sections() {
    let state = tmp_dir("msn-snapshot-template");
    let out = bin(&state)
        .args(["--url", "not-a-server-origin", "snapshot", "template"])
        .output()
        .expect("run template");
    assert!(out.status.success());
    assert!(out.stderr.is_empty());
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert_eq!(
        stdout,
        "## Objective\n\n## Decisions\n\n## Open tasks\n\n## Blockers\n\n## Artifacts\n\n## Next actions\n\n## Unresolved\n\n## Evidence\n"
    );
}

#[test]
fn snapshot_publish_from_stdin_sends_cas_body_and_retry_key() {
    let response = r#"{"snapshot":{"version":2},"replayed":false}"#;
    let server = MockServer::spawn(vec![Scripted::json(201, response)]);
    let state = tmp_dir("msn-snapshot-publish");
    let mut child = bin(&state)
        .args(tenant_args(&server.url()))
        .args([
            "--username",
            "planner",
            "snapshot",
            "publish",
            "swarm",
            "--text",
            "-",
            "--covers-through",
            "42",
            "--base-version",
            "1",
            "--history-revision",
            "3",
            "--key",
            "snapshot-retry-1",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn publish");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"## Objective\nResume safely.\n")
        .unwrap();
    let out = child.wait_with_output().expect("publish output");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), response);
    assert!(String::from_utf8_lossy(&out.stderr).contains("snapshot-retry-1"));

    let recorded = server.recorded();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].method, "POST");
    assert_eq!(
        recorded[0].path,
        "/api/tenants/team/channels/swarm/snapshots"
    );
    assert_eq!(
        recorded[0].headers.get("authorization").map(String::as_str),
        Some("Bearer tenant-secret")
    );
    assert_eq!(
        recorded[0]
            .headers
            .get("idempotency-key")
            .map(String::as_str),
        Some("snapshot-retry-1")
    );
    let body: serde_json::Value = serde_json::from_slice(&recorded[0].body).unwrap();
    assert_eq!(body["username"], "planner");
    assert_eq!(body["text"], "## Objective\nResume safely.\n");
    assert_eq!(body["coversThrough"], 42);
    assert_eq!(body["baseVersion"], 1);
    assert_eq!(body["historyRevision"], 3);
}

#[test]
fn snapshot_publish_rejects_invalid_fields_before_network() {
    let server = MockServer::spawn(Vec::new());
    let state = tmp_dir("msn-snapshot-invalid");
    let cases = [
        (" ".to_string(), "1", "0", "0"),
        ("x".repeat(16_385), "1", "0", "0"),
        ("ok".to_string(), "9007199254740992", "0", "0"),
        ("ok".to_string(), "1", "01", "0"),
        ("ok".to_string(), "1", "0", "-1"),
    ];
    for (text, covers, base, revision) in cases {
        let out = bin(&state)
            .args(tenant_args(&server.url()))
            .args([
                "--username",
                "planner",
                "snapshot",
                "publish",
                "swarm",
                "--text",
                &text,
                "--covers-through",
                covers,
                "--base-version",
                base,
                "--history-revision",
                revision,
                "--key",
                "never-sent",
            ])
            .output()
            .expect("invalid publish");
        assert_eq!(out.status.code(), Some(2), "text length={}", text.len());
    }
    assert!(server.recorded().is_empty());
}

#[test]
fn snapshot_publish_rejects_invalid_key_before_identity_lookup() {
    let server = MockServer::spawn(Vec::new());
    let state = tmp_dir("msn-snapshot-invalid-key");
    for key in ["", "contains space", "slash/key", &"x".repeat(129)] {
        let out = bin(&state)
            .args(tenant_args(&server.url()))
            .args([
                "snapshot",
                "publish",
                "swarm",
                "--text",
                "valid checkpoint",
                "--covers-through",
                "1",
                "--base-version",
                "0",
                "--history-revision",
                "0",
                "--key",
                key,
            ])
            .output()
            .expect("invalid snapshot key");
        assert_eq!(out.status.code(), Some(2));
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("Idempotency-Key"),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    assert!(
        server.recorded().is_empty(),
        "invalid keys must fail before the identity GET"
    );
}

#[test]
fn snapshot_list_and_show_use_frozen_routes() {
    let list_body = r#"{"snapshots":[],"nextCursor":4,"hasMore":false}"#;
    let show_body = r#"{"snapshot":{"version":5},"historyRevision":2}"#;
    let server = MockServer::spawn(vec![
        Scripted::json(200, list_body),
        Scripted::json(200, show_body),
    ]);
    let state = tmp_dir("msn-snapshot-reads");
    let list = bin(&state)
        .args(tenant_args(&server.url()))
        .args(["snapshot", "list", "swarm", "--after", "4", "--limit", "7"])
        .output()
        .unwrap();
    assert!(list.status.success());
    assert_eq!(String::from_utf8_lossy(&list.stdout).trim(), list_body);
    let show = bin(&state)
        .args(tenant_args(&server.url()))
        .args(["snapshot", "show", "swarm", "5"])
        .output()
        .unwrap();
    assert!(show.status.success());
    assert_eq!(String::from_utf8_lossy(&show.stdout).trim(), show_body);
    let recorded = server.recorded();
    assert_eq!(
        recorded[0].path,
        "/api/tenants/team/channels/swarm/snapshots?after=4&limit=7"
    );
    assert_eq!(
        recorded[1].path,
        "/api/tenants/team/channels/swarm/snapshots/5"
    );
}

#[test]
fn catchup_is_raw_bounded_and_never_creates_reader_state() {
    let initial = r#"{"snapshot":{"version":2},"messages":[],"nextCursor":42,"hasMore":false,"incomplete":false}"#;
    let continued =
        r#"{"snapshot":null,"messages":[],"nextCursor":42,"hasMore":false,"incomplete":false}"#;
    let server = MockServer::spawn(vec![
        Scripted::json(200, initial),
        Scripted::json(200, continued),
    ]);
    let state = tmp_dir("msn-catchup-state");
    let first = bin(&state)
        .args(tenant_args(&server.url()))
        .args(["--reader", "returning", "catchup", "swarm"])
        .output()
        .unwrap();
    assert!(first.status.success());
    assert_eq!(String::from_utf8_lossy(&first.stdout).trim(), initial);
    let second = bin(&state)
        .args(tenant_args(&server.url()))
        .args([
            "--reader",
            "returning",
            "catchup",
            "swarm",
            "--after",
            "42",
            "--limit",
            "9",
            "--max-bytes",
            "4096",
        ])
        .output()
        .unwrap();
    assert!(second.status.success());
    assert_eq!(String::from_utf8_lossy(&second.stdout).trim(), continued);
    let recorded = server.recorded();
    assert_eq!(
        recorded[0].path,
        "/api/tenants/team/channels/swarm/catchup?limit=20&maxBytes=32768&reader=returning",
        "an explicit --reader asks whether the board's brief is new to it (ADR 0074)"
    );
    assert_eq!(
        recorded[1].path,
        "/api/tenants/team/channels/swarm/catchup?limit=9&maxBytes=4096&after=42"
    );
    assert!(
        !state.exists() || fs::read_dir(&state).unwrap().next().is_none(),
        "catchup must not create cursor or profile state"
    );
}

#[test]
fn catchup_bounds_are_rejected_offline() {
    let server = MockServer::spawn(Vec::new());
    let state = tmp_dir("msn-catchup-invalid");
    for args in [
        vec!["catchup", "swarm", "--limit", "0"],
        vec!["catchup", "swarm", "--limit", "101"],
        vec!["catchup", "swarm", "--max-bytes", "1023"],
        vec!["catchup", "swarm", "--max-bytes", "262145"],
        vec!["catchup", "swarm", "--after", "01"],
    ] {
        let out = bin(&state)
            .args(tenant_args(&server.url()))
            .args(args)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2));
    }
    assert!(server.recorded().is_empty());
}

#[test]
fn catchup_help_uses_the_actual_default_budget() {
    let state = tmp_dir("msn-catchup-help");
    let catchup = bin(&state)
        .args(["catchup", "--help"])
        .output()
        .expect("catchup help");
    assert!(catchup.status.success());
    let catchup_help = String::from_utf8(catchup.stdout).unwrap();
    assert!(catchup_help.contains("default 32768"));
    assert!(!catchup_help.contains("default 65536"));

    let top = bin(&state).arg("--help").output().expect("top-level help");
    assert!(top.status.success());
    let top_help = String::from_utf8(top.stdout).unwrap();
    assert!(top_help.contains("--max-bytes 32768"));
    assert!(!top_help.contains("--max-bytes 65536"));
}
