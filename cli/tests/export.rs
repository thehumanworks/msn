//! Verification contract (issue #11)
//!
//! Goal: `msn export CHANNEL --out FILE` writes `msn.channel.archive.v1` or leaves no FILE.
//! I1 multi-page pagination and correct boundary handling
//!    -> given_two_message_pages_when_export_then_archive_contains_both_and_stops_at_head
//! I2 concurrent append beyond headCursor is omitted; archive names the boundary
//!    -> given_page_past_head_when_export_then_archive_stops_at_boundary
//! I3 historyRevision change mid-export → exit 5, no FILE, .partial left
//!    -> given_revision_change_when_export_then_exit_5_and_no_file
//! I4 410 snapshot_invalidated → metadata-only record; export still completes
//!    -> given_invalidated_snapshot_when_export_then_metadata_only_and_complete
//! I5 server page that violates ordering/identity → failure, no FILE
//!    -> given_unordered_or_foreign_page_when_export_then_no_file
//! I6 interruption before trailer → no FILE; verifier rejects .partial
//!    -> given_interrupt_before_trailer_when_export_then_no_file_and_partial_rejected
//! I7 verifier rejects malformed archives (rules 1–6)
//!    -> given_malformed_archive_when_verify_then_rejected
//! I8 output mode 0600 and no credential material
//!    -> given_successful_export_when_inspect_file_then_mode_0600_and_no_secrets
//! I9 instanceId / contentHash determinism (unit)
//!    -> cli/src/archive.rs::instance_id_is_deterministic_and_changes_after_reset
//!    -> cli/src/archive.rs::content_hash_is_deterministic_and_includes_newlines
//! Edge: refuse overwrite without --force; --after exclusive bound; empty channel.
//! Out of scope: import, scheduled backups, credential transfer.

#[allow(dead_code)]
mod common;

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use msn_cli::archive::{FORMAT, instance_id, verify_archive, verify_archive_path};
use serde_json::{Value, json};

use common::{MockServer, Scripted};

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

const CREATED: &str = "2026-09-17T23:15:08.380Z";
const TOKEN: &str = "tenant-secret";

fn tmp_dir(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}-{seq}", std::process::id()));
    fs::create_dir_all(&path).unwrap();
    path
}

fn bin(state: &Path) -> Command {
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

fn tenant_args(url: &str) -> [&str; 8] {
    [
        "--url",
        url,
        "--tenant",
        "team",
        "--token",
        TOKEN,
        "--username",
        "exporter",
    ]
}

fn catchup(head: u64, revision: u64, snapshot: u64) -> Scripted {
    Scripted::json(
        200,
        &json!({
            "headCursor": head,
            "historyRevision": revision,
            "snapshotVersion": snapshot,
            "messages": [],
            "nextCursor": 0,
            "hasMore": false,
        })
        .to_string(),
    )
}

fn channels() -> Scripted {
    Scripted::json(
        200,
        &json!({
            "channels": [{"name": "general", "createdAt": CREATED}],
            "nextCursor": "general",
            "hasMore": false,
        })
        .to_string(),
    )
}

fn msg(id: u64, text: &str) -> Value {
    let mut row = json!({
        "id": id,
        "tenant": "team",
        "channel": "general",
        "username": "alice",
        "text": text,
        "contentType": "text/plain",
        "createdAt": CREATED,
    });
    // Message 3 was edited by its sender (ADR 0052).
    if id == 3 {
        row["editedAt"] = json!("2026-11-20T10:00:00.000Z");
    }
    // Message 1 is a question that message 2 answers (ADR 0065).
    if id == 1 {
        row["to"] = json!("alice");
        row["choices"] = json!(["yes", "no"]);
        row["answerer"] = json!("alice");
        row["answered"] =
            json!({"id": 2, "choice": "yes", "username": "alice", "answeredAt": CREATED});
    }
    // Message 3 replaced message 4's sender's earlier words (ADR 0067).
    if id == 3 {
        row["replacedBy"] = json!(4);
    }
    if id == 4 {
        row["replaces"] = json!(3);
    }
    if id == 2 {
        row["replyTo"] = json!(1);
        row["answer"] = json!("yes");
    }
    row
}

fn messages_page(ids: &[u64], more: bool) -> Scripted {
    let rows: Vec<Value> = ids.iter().map(|id| msg(*id, &format!("m{id}"))).collect();
    let next = ids.last().copied().unwrap_or(0);
    Scripted::json(
        200,
        &json!({
            "messages": rows,
            "nextCursor": next,
            "hasMore": more,
        })
        .to_string(),
    )
}

fn snapshot_meta(version: u64, invalidated: bool) -> Value {
    json!({
        "tenant": "team",
        "channel": "general",
        "version": version,
        "username": "planner",
        "coversThrough": 1,
        "historyRevision": 0,
        "createdAt": CREATED,
        "invalidated": invalidated,
    })
}

fn snapshots_page(versions: &[u64], invalidated: bool, more: bool) -> Scripted {
    let rows: Vec<Value> = versions
        .iter()
        .map(|v| snapshot_meta(*v, invalidated))
        .collect();
    let next = versions.last().copied().unwrap_or(0);
    Scripted::json(
        200,
        &json!({
            "snapshots": rows,
            "nextCursor": next,
            "hasMore": more,
            "snapshotVersion": versions.last().copied().unwrap_or(0),
            "historyRevision": 0,
        })
        .to_string(),
    )
}

fn snapshot_show(version: u64, text: &str) -> Scripted {
    Scripted::json(
        200,
        &json!({
            "snapshot": {
                "tenant": "team",
                "channel": "general",
                "version": version,
                "username": "planner",
                "text": text,
                "coversThrough": 1,
                "historyRevision": 0,
                "createdAt": CREATED,
                "invalidated": false,
            },
            "historyRevision": 0,
        })
        .to_string(),
    )
}

fn snapshot_gone() -> Scripted {
    Scripted::json(
        410,
        r#"{"error":{"code":"snapshot_invalidated","message":"Snapshot invalidated by history redaction."}}"#,
    )
}

fn run(server: &MockServer, dest: &Path, extra: &[&str]) -> std::process::Output {
    let state = tmp_dir("msn-export-home");
    let mut cmd = bin(&state);
    cmd.args(tenant_args(&server.url()))
        .args(["export", "general", "--out"])
        .arg(dest)
        .args(extra);
    output_capped(cmd, Duration::from_secs(8))
}

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

fn stdout_json(out: &std::process::Output) -> Value {
    serde_json::from_slice(&out.stdout).unwrap_or(Value::Null)
}

fn records(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn dest(dir: &Path) -> PathBuf {
    dir.join("channel.msnarchive.jsonl")
}

#[test]
fn given_two_message_pages_when_export_then_archive_contains_both_and_stops_at_head() {
    let server = MockServer::spawn(vec![
        catchup(4, 0, 0),
        channels(),
        messages_page(&[1, 2], true),
        messages_page(&[3, 4], false),
        catchup(4, 0, 0),
    ]);
    let dir = tmp_dir("msn-export-pages");
    let out = dest(&dir);
    let result = run(&server, &out, &["--limit", "2"]);
    assert_eq!(
        result.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let summary = stdout_json(&result);
    assert_eq!(summary["status"], "complete");
    assert_eq!(summary["messageCount"], 4);
    assert_eq!(summary["firstSourceId"], 1);
    assert_eq!(summary["lastSourceId"], 4);
    assert_eq!(summary["boundary"]["headCursor"], 4);

    let lines = records(&out);
    assert_eq!(lines[0]["record"], "manifest");
    assert_eq!(lines[0]["format"], FORMAT);
    assert_eq!(lines[0]["boundary"]["after"], 0);
    assert_eq!(lines[0]["boundary"]["headCursor"], 4);
    let ids: Vec<u64> = lines
        .iter()
        .filter(|row| row["record"] == "message")
        .map(|row| row["sourceId"].as_u64().unwrap())
        .collect();
    assert_eq!(ids, [1, 2, 3, 4]);
    let edited: Vec<&Value> = lines
        .iter()
        .filter(|row| row["record"] == "message")
        .map(|row| &row["editedAt"])
        .collect();
    assert_eq!(
        edited,
        [
            &Value::Null,
            &Value::Null,
            &json!("2026-11-20T10:00:00.000Z"),
            &Value::Null
        ]
    );
    // A question keeps its choices and first answer, and the answer keeps its choice (ADR 0065).
    let question = lines.iter().find(|row| row["sourceId"] == 1).unwrap();
    assert_eq!(question["choices"], json!(["yes", "no"]));
    assert_eq!(question["answered"]["id"], 2);
    assert_eq!(question["answerer"], "alice");
    assert!(question.get("answer").is_none());
    let answer = lines.iter().find(|row| row["sourceId"] == 2).unwrap();
    assert_eq!(answer["answer"], "yes");
    assert!(answer.get("choices").is_none() && answer.get("answered").is_none());
    // Replacement links are kept on both ends (ADR 0067) and omitted elsewhere.
    let replaced = lines.iter().find(|row| row["sourceId"] == 3).unwrap();
    assert_eq!(replaced["replacedBy"], 4);
    assert!(replaced.get("replaces").is_none());
    if let Some(newer) = lines.iter().find(|row| row["sourceId"] == 4) {
        assert_eq!(newer["replaces"], 3);
    }
    assert!(answer.get("replaces").is_none() && answer.get("replacedBy").is_none());
    assert!(
        lines
            .iter()
            .find(|row| row["sourceId"] == 3)
            .unwrap()
            .get("choices")
            .is_none()
    );
    assert_eq!(lines.last().unwrap()["record"], "completion");
    verify_archive_path(&out, |_| Ok(())).unwrap();

    let paths: Vec<String> = server.recorded().iter().map(|r| r.path.clone()).collect();
    assert_eq!(
        paths[0],
        "/api/tenants/team/channels/general/catchup?limit=1&maxBytes=262144"
    );
    assert_eq!(paths[1], "/api/tenants/team/channels?limit=1000");
    assert!(
        paths[2].starts_with("/api/tenants/team/channels/general/messages?after=0&limit=2"),
        "{}",
        paths[2]
    );
    assert!(paths[3].contains("after=2&limit=2"), "{}", paths[3]);
    assert_eq!(paths[4], paths[0]);
}

#[test]
fn given_page_past_head_when_export_then_archive_stops_at_boundary() {
    // Server includes a concurrent append (id 5) past the pinned head (4).
    let server = MockServer::spawn(vec![
        catchup(4, 0, 0),
        channels(),
        messages_page(&[1, 2], true),
        messages_page(&[3, 4, 5], false),
        catchup(5, 0, 0),
    ]);
    let dir = tmp_dir("msn-export-append");
    let out = dest(&dir);
    let result = run(&server, &out, &["--limit", "3"]);
    assert_eq!(
        result.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let summary = stdout_json(&result);
    assert_eq!(summary["messageCount"], 4);
    assert_eq!(summary["lastSourceId"], 4);
    assert_eq!(summary["boundary"]["headCursor"], 4);
    let ids: Vec<u64> = records(&out)
        .iter()
        .filter(|row| row["record"] == "message")
        .map(|row| row["sourceId"].as_u64().unwrap())
        .collect();
    assert_eq!(ids, [1, 2, 3, 4]);
    assert!(!records(&out).iter().any(|row| row["sourceId"] == 5));
}

#[test]
fn given_revision_change_when_export_then_exit_5_and_no_file() {
    let server = MockServer::spawn(vec![
        catchup(2, 0, 0),
        channels(),
        messages_page(&[1, 2], false),
        catchup(2, 1, 0),
    ]);
    let dir = tmp_dir("msn-export-revision");
    let out = dest(&dir);
    let result = run(&server, &out, &[]);
    assert_eq!(
        result.status.code(),
        Some(5),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        String::from_utf8_lossy(&result.stderr).contains("History changed"),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!out.exists(), "FILE must not be published");
    let partial = PathBuf::from(format!("{}.partial", out.display()));
    assert!(partial.exists(), ".partial must remain for inspection");
    let err = verify_archive_path(&partial, |_| Ok(())).unwrap_err();
    assert!(
        err.to_string().contains("completion") || err.to_string().contains("no completion"),
        "{err}"
    );
}

#[test]
fn given_invalidated_snapshot_when_export_then_metadata_only_and_complete() {
    let server = MockServer::spawn(vec![
        catchup(1, 0, 1),
        channels(),
        messages_page(&[1], false),
        snapshots_page(&[1], true, false),
        snapshot_gone(),
        catchup(1, 0, 1),
    ]);
    let dir = tmp_dir("msn-export-410");
    let out = dest(&dir);
    let result = run(&server, &out, &[]);
    assert_eq!(
        result.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let summary = stdout_json(&result);
    assert_eq!(summary["snapshotCount"], 1);
    assert_eq!(summary["invalidatedSnapshotCount"], 1);
    let snap = records(&out)
        .into_iter()
        .find(|row| row["record"] == "snapshot")
        .unwrap();
    assert_eq!(snap["invalidated"], true);
    assert!(snap.get("text").is_none(), "{snap}");
    verify_archive_path(&out, |_| Ok(())).unwrap();
}

#[test]
fn given_unordered_or_foreign_page_when_export_then_no_file() {
    let descending = json!({
        "messages": [msg(2, "b"), msg(1, "a")],
        "nextCursor": 1,
        "hasMore": false,
    });
    let foreign = json!({
        "messages": [{
            "id": 1,
            "tenant": "other",
            "channel": "general",
            "username": "alice",
            "text": "x",
            "contentType": "text/plain",
            "createdAt": CREATED,
        }],
        "nextCursor": 1,
        "hasMore": false,
    });
    for body in [descending, foreign] {
        let server = MockServer::spawn(vec![
            catchup(2, 0, 0),
            channels(),
            Scripted::json(200, &body.to_string()),
        ]);
        let dir = tmp_dir("msn-export-bad-page");
        let out = dest(&dir);
        let result = run(&server, &out, &[]);
        assert_ne!(result.status.code(), Some(0), "{}", body);
        assert!(!out.exists(), "FILE must not be published for {body}");
    }
}

#[test]
fn given_interrupt_before_trailer_when_export_then_no_file_and_partial_rejected() {
    let server = MockServer::spawn(vec![
        catchup(4, 0, 0),
        channels(),
        messages_page(&[1, 2], true),
        messages_page(&[3, 4], false).delayed(Duration::from_secs(3)),
        catchup(4, 0, 0),
    ]);
    let dir = tmp_dir("msn-export-interrupt");
    let out = dest(&dir);
    let partial = PathBuf::from(format!("{}.partial", out.display()));
    let state = tmp_dir("msn-export-interrupt-home");
    let mut child = bin(&state)
        .args(tenant_args(&server.url()))
        .args(["export", "general", "--out"])
        .arg(&out)
        .args(["--limit", "2"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let start = Instant::now();
    loop {
        if partial.exists() {
            if let Ok(text) = fs::read_to_string(&partial) {
                if text.contains("\"record\":\"message\"") {
                    break;
                }
            }
        }
        if start.elapsed() > Duration::from_secs(2) {
            let _ = child.kill();
            panic!("timed out waiting for .partial body");
        }
        thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
    assert!(!out.exists(), "interrupted export must not publish FILE");
    assert!(partial.exists());
    let err = verify_archive_path(&partial, |_| Ok(())).unwrap_err();
    assert!(
        format!("{err}").contains("completion") || format!("{err}").contains("no completion"),
        "{err}"
    );
}

#[test]
fn given_malformed_archive_when_verify_then_rejected() {
    let instance = instance_id(
        "https://msn.example.workers.dev",
        "main",
        "general",
        CREATED,
    );
    let manifest = json!({
        "record": "manifest",
        "format": FORMAT,
        "archiveVersion": 1,
        "exportedAt": "2026-09-18T09:00:00.000Z",
        "exportedBy": "exporter",
        "producer": "msn-cli/0.1.0",
        "source": {
            "origin": "https://msn.example.workers.dev",
            "tenant": "main",
            "channel": "general",
            "channelCreatedAt": CREATED,
            "instanceId": instance,
        },
        "boundary": {
            "headCursor": 1,
            "historyRevision": 0,
            "after": 0,
            "snapshotVersion": 0,
        }
    });
    let message = json!({
        "record": "message",
        "sourceId": 1,
        "username": "alice",
        "text": "hi",
        "contentType": "text/plain",
        "createdAt": CREATED,
    });
    let mut good = format!(
        "{}\n{}\n",
        serde_json::to_string(&manifest).unwrap(),
        serde_json::to_string(&message).unwrap()
    );
    let hash = msn_cli::archive::content_hash(good.as_bytes());
    let completion = json!({
        "record": "completion",
        "status": "complete",
        "messageCount": 1,
        "snapshotCount": 0,
        "invalidatedSnapshotCount": 0,
        "firstSourceId": 1,
        "lastSourceId": 1,
        "boundary": { "headCursor": 1, "historyRevision": 0, "snapshotVersion": 0 },
        "contentHash": hash,
    });
    good.push_str(&serde_json::to_string(&completion).unwrap());
    good.push('\n');
    verify_archive(good.as_bytes(), |_| Ok(())).unwrap();

    let mut bad_format = good.clone();
    bad_format = bad_format.replace(FORMAT, "msn.channel.archive.v0");
    assert!(
        verify_archive(bad_format.as_bytes(), |_| Ok(())).is_err(),
        "bad format"
    );

    let without_trailer = good
        .lines()
        .filter(|line| !line.contains("\"record\":\"completion\""))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let err = verify_archive(without_trailer.as_bytes(), |_| Ok(())).unwrap_err();
    assert!(
        err.to_string().contains("completion"),
        "missing trailer: {err}"
    );

    let bad_hash = good.replace(&hash, &"ab".repeat(32));
    let err = verify_archive(bad_hash.as_bytes(), |_| Ok(())).unwrap_err();
    assert!(err.to_string().contains("contentHash"), "bad hash: {err}");

    let mut after_trailer = good.clone();
    after_trailer.push_str("{\"record\":\"message\",\"sourceId\":2}\n");
    let err = verify_archive(after_trailer.as_bytes(), |_| Ok(())).unwrap_err();
    assert!(
        err.to_string().contains("after") || err.to_string().contains("completion"),
        "records after trailer: {err}"
    );

    let future = good.replace("\"archiveVersion\":1", "\"archiveVersion\":2");
    let err = verify_archive(future.as_bytes(), |_| Ok(())).unwrap_err();
    assert!(
        err.to_string().contains("archiveVersion") || err.to_string().contains("Unsupported"),
        "future version: {err}"
    );
}

#[test]
fn given_successful_export_when_inspect_file_then_mode_0600_and_no_secrets() {
    let server = MockServer::spawn(vec![
        catchup(1, 0, 0),
        channels(),
        messages_page(&[1], false),
        catchup(1, 0, 0),
    ]);
    let dir = tmp_dir("msn-export-mode");
    let out = dest(&dir);
    let result = run(&server, &out, &[]);
    assert_eq!(
        result.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let text = fs::read_to_string(&out).unwrap();
    assert!(!text.contains(TOKEN), "archive leaked the workspace token");
    assert!(!text.contains("Authorization"), "{text}");
    assert!(!text.contains("MSN_WORKSPACE_TOKEN"), "{text}");
    assert!(!text.contains("admin"), "{text}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&out).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "mode {mode:o}");
    }
}

#[test]
fn given_existing_file_when_export_without_force_then_usage() {
    let server = MockServer::spawn(vec![catchup(1, 0, 0), channels()]);
    let dir = tmp_dir("msn-export-force");
    let out = dest(&dir);
    fs::write(&out, "keep\n").unwrap();
    let result = run(&server, &out, &[]);
    assert_eq!(result.status.code(), Some(2));
    assert_eq!(fs::read_to_string(&out).unwrap(), "keep\n");
    assert!(
        server.recorded().is_empty(),
        "must refuse an existing FILE before any request"
    );
}

#[test]
fn given_existing_file_when_export_with_force_then_replaced() {
    let server = MockServer::spawn(vec![
        catchup(1, 0, 0),
        channels(),
        messages_page(&[1], false),
        catchup(1, 0, 0),
    ]);
    let dir = tmp_dir("msn-export-force-ok");
    let out = dest(&dir);
    fs::write(&out, "stale\n").unwrap();
    let result = run(&server, &out, &["--force"]);
    assert_eq!(
        result.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let text = fs::read_to_string(&out).unwrap();
    assert!(!text.contains("stale"));
    assert!(text.contains("\"record\":\"manifest\""));
}

#[test]
fn given_after_bound_when_export_then_messages_start_after_it() {
    let server = MockServer::spawn(vec![
        catchup(4, 0, 0),
        channels(),
        messages_page(&[3, 4], false),
        catchup(4, 0, 0),
    ]);
    let dir = tmp_dir("msn-export-after");
    let out = dest(&dir);
    let result = run(&server, &out, &["--after", "2"]);
    assert_eq!(
        result.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        server.recorded()[2].path.contains("after=2"),
        "{}",
        server.recorded()[2].path
    );
    let manifest = &records(&out)[0];
    assert_eq!(manifest["boundary"]["after"], 2);
    let ids: Vec<u64> = records(&out)
        .iter()
        .filter(|row| row["record"] == "message")
        .map(|row| row["sourceId"].as_u64().unwrap())
        .collect();
    assert_eq!(ids, [3, 4]);
}

#[test]
fn given_empty_channel_when_export_then_complete_archive_with_zero_counts() {
    let server = MockServer::spawn(vec![catchup(0, 0, 0), channels(), catchup(0, 0, 0)]);
    let dir = tmp_dir("msn-export-empty");
    let out = dest(&dir);
    let result = run(&server, &out, &[]);
    assert_eq!(
        result.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let summary = stdout_json(&result);
    assert_eq!(summary["messageCount"], 0);
    assert_eq!(summary["snapshotCount"], 0);
    assert!(summary.get("firstSourceId").is_none());
    verify_archive_path(&out, |_| Ok(())).unwrap();
}

#[test]
fn given_valid_snapshot_when_export_then_text_is_present() {
    let server = MockServer::spawn(vec![
        catchup(1, 0, 1),
        channels(),
        messages_page(&[1], false),
        snapshots_page(&[1], false, false),
        snapshot_show(1, "# Checkpoint"),
        catchup(1, 0, 1),
    ]);
    let dir = tmp_dir("msn-export-snap");
    let out = dest(&dir);
    let result = run(&server, &out, &[]);
    assert_eq!(
        result.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let snap = records(&out)
        .into_iter()
        .find(|row| row["record"] == "snapshot")
        .unwrap();
    assert_eq!(snap["invalidated"], false);
    assert_eq!(snap["text"], "# Checkpoint");
    assert_eq!(
        server.recorded()[4].path,
        "/api/tenants/team/channels/general/snapshots/1"
    );
}

#[test]
fn export_help_lists_out_after_limit_force() {
    let state = tmp_dir("msn-export-help");
    let out = bin(&state).args(["export", "--help"]).output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    for needle in ["--out", "--after", "--limit", "--force", "FILE.partial"] {
        assert!(text.contains(needle), "help missing {needle}\n{text}");
    }
}

#[test]
fn given_wrong_next_cursor_when_export_then_no_file() {
    let server = MockServer::spawn(vec![
        catchup(2, 0, 0),
        channels(),
        Scripted::json(
            200,
            &json!({
                "messages": [msg(1, "a"), msg(2, "b")],
                "nextCursor": 99,
                "hasMore": false,
            })
            .to_string(),
        ),
    ]);
    let dir = tmp_dir("msn-export-cursor");
    let out = dest(&dir);
    let result = run(&server, &out, &[]);
    assert_ne!(result.status.code(), Some(0));
    assert!(!out.exists());
}
