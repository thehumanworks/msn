//! Verification contract (issue #12)
//!
//! Goal: `msn import FILE --channel DEST` copies a verified archive without impersonating,
//! duplicating, writing cursors, or publishing invalidated snapshots as valid.
//! I1 given_archive_when_dry_run_then_no_writes
//! I2 given_archive_when_import_then_destination_receives_wrapped_messages
//! I3 given_already_imported_when_import_again_then_no_duplicates
//! I4 given_partial_map_when_import_resumes_then_no_duplicates
//! I5 given_409_payload_conflict_when_import_then_conflict
//! I6 given_missing_reply_or_evidence_when_import_then_unresolved
//! I7 given_existing_channel_when_import_without_allow_then_refused
//! I8 given_bound_name_rejection_when_import_then_auth
//! I9 given_invalidated_snapshot_when_import_then_not_published_as_valid
//! I10 given_deleted_evidence_when_import_then_not_resurrected
//! I11 given_malformed_or_unknown_schema_when_import_then_rejected
//! I12 given_unknown_record_when_import_then_surfaced
//! I13 given_import_when_complete_then_no_cursor_or_processing_files
//! I14 given_replay_tasks_when_import_then_warns_and_sends_unwrapped
//! I15 given_conflicting_task_slugs_when_replay_then_reported
//! Out of scope: mirroring, account provisioning, bidirectional sync.

#[allow(dead_code)]
mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use msn_cli::archive::{FORMAT, content_hash, import_idempotency_key, instance_id};
use serde_json::{Value, json};

use common::{MockServer, Scripted};

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

const CREATED: &str = "2026-09-17T23:15:08.380Z";
const SOURCE_ORIGIN: &str = "https://msn.example.workers.dev";
const DEST_TOKEN: &str = "dest-secret";
const ARCHIVE_TOKEN: &str = "archive-must-never-be-used";

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
        DEST_TOKEN,
        "--username",
        "importer",
    ]
}

fn channels(names: &[&str]) -> Scripted {
    let rows: Vec<Value> = names
        .iter()
        .map(|name| json!({"name": name, "createdAt": CREATED}))
        .collect();
    let next = names.last().copied().unwrap_or("");
    Scripted::json(
        200,
        &json!({
            "channels": rows,
            "nextCursor": next,
            "hasMore": false,
        })
        .to_string(),
    )
}

fn created() -> Scripted {
    Scripted::json(201, &json!({"channel":"dest","created":true}).to_string())
}

fn sent(id: u64, replayed: bool) -> Scripted {
    Scripted::json(
        200,
        &json!({
            "message": {
                "id": id,
                "tenant": "team",
                "channel": "dest",
                "username": "importer",
                "text": "{}",
                "contentType": "application/json",
                "createdAt": CREATED,
            },
            "replayed": replayed,
        })
        .to_string(),
    )
}

fn catchup(head: u64, snapshot: u64) -> Scripted {
    Scripted::json(
        200,
        &json!({
            "headCursor": head,
            "historyRevision": 0,
            "snapshotVersion": snapshot,
            "messages": [],
            "nextCursor": head,
            "hasMore": false,
        })
        .to_string(),
    )
}

fn snapshot_created(version: u64, replayed: bool) -> Scripted {
    Scripted::json(
        200,
        &json!({
            "snapshot": {
                "tenant": "team",
                "channel": "dest",
                "version": version,
                "username": "importer",
                "text": "# Checkpoint",
                "coversThrough": 2,
                "historyRevision": 0,
                "createdAt": CREATED,
                "invalidated": false,
            },
            "replayed": replayed,
        })
        .to_string(),
    )
}

fn dest_messages(rows: Vec<Value>) -> Scripted {
    let next = rows.last().and_then(|row| row["id"].as_u64()).unwrap_or(0);
    Scripted::json(
        200,
        &json!({
            "messages": rows,
            "nextCursor": next,
            "hasMore": false,
        })
        .to_string(),
    )
}

fn write_archive(path: &Path, rows: &[Value], head: u64, snapshot_version: u64, revision: u64) {
    let instance = instance_id(SOURCE_ORIGIN, "main", "general", CREATED);
    let mut manifest = json!({
        "record": "manifest",
        "format": FORMAT,
        "archiveVersion": 1,
        "exportedAt": "2026-09-18T09:00:00.000Z",
        "exportedBy": "exporter",
        "producer": "msn-cli/0.1.0",
        "token": ARCHIVE_TOKEN,
        "source": {
            "origin": SOURCE_ORIGIN,
            "tenant": "main",
            "channel": "general",
            "channelCreatedAt": CREATED,
            "instanceId": instance,
        },
        "boundary": {
            "headCursor": head,
            "historyRevision": revision,
            "after": 0,
            "snapshotVersion": snapshot_version,
        }
    });
    if revision > 0 {
        manifest["boundary"]["historyRevision"] = json!(revision);
    }
    let mut body = serde_json::to_string(&manifest).unwrap();
    body.push('\n');
    let mut message_count = 0u64;
    let mut snapshot_count = 0u64;
    let mut invalidated = 0u64;
    let mut first = None;
    let mut last = None;
    for row in rows {
        body.push_str(&serde_json::to_string(row).unwrap());
        body.push('\n');
        match row["record"].as_str() {
            Some("message") => {
                message_count += 1;
                let id = row["sourceId"].as_u64().unwrap();
                if first.is_none() {
                    first = Some(id);
                }
                last = Some(id);
            }
            Some("snapshot") => {
                snapshot_count += 1;
                if row["invalidated"].as_bool() == Some(true) {
                    invalidated += 1;
                }
            }
            _ => {}
        }
    }
    let hash = content_hash(body.as_bytes());
    let mut completion = json!({
        "record": "completion",
        "status": "complete",
        "messageCount": message_count,
        "snapshotCount": snapshot_count,
        "invalidatedSnapshotCount": invalidated,
        "boundary": {
            "headCursor": head,
            "historyRevision": revision,
            "snapshotVersion": snapshot_version,
        },
        "contentHash": hash,
    });
    if let (Some(first), Some(last)) = (first, last) {
        completion["firstSourceId"] = json!(first);
        completion["lastSourceId"] = json!(last);
    }
    body.push_str(&serde_json::to_string(&completion).unwrap());
    body.push('\n');
    fs::write(path, body).unwrap();
}

fn msg(id: u64, text: &str) -> Value {
    json!({
        "record": "message",
        "sourceId": id,
        "username": "alice",
        "text": text,
        "contentType": "text/plain",
        "createdAt": CREATED,
    })
}

fn reply(id: u64, to: u64, text: &str) -> Value {
    let mut value = msg(id, text);
    value["replyTo"] = json!(to);
    value
}

fn json_msg(id: u64, payload: Value) -> Value {
    json!({
        "record": "message",
        "sourceId": id,
        "username": "alice",
        "text": payload.to_string(),
        "contentType": "application/json",
        "createdAt": CREATED,
    })
}

fn snapshot(version: u64, covers: u64, invalidated: bool) -> Value {
    let mut value = json!({
        "record": "snapshot",
        "version": version,
        "username": "planner",
        "coversThrough": covers,
        "historyRevision": 0,
        "createdAt": CREATED,
        "invalidated": invalidated,
    });
    if !invalidated {
        value["text"] = json!("# Checkpoint");
    }
    value
}

fn run(server: &MockServer, archive: &Path, state: &Path, extra: &[&str]) -> std::process::Output {
    bin(state)
        .args(tenant_args(&server.url()))
        .args(["import"])
        .arg(archive)
        .args(["--channel", "dest"])
        .args(extra)
        .output()
        .unwrap()
}

fn stdout_json(out: &std::process::Output) -> Value {
    serde_json::from_slice(&out.stdout).unwrap_or_else(|_| {
        panic!(
            "stdout not JSON: {} / stderr {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
    })
}

fn posts(server: &MockServer) -> Vec<common::Recorded> {
    server
        .recorded()
        .into_iter()
        .filter(|row| row.method == "POST" || row.method == "PUT")
        .collect()
}

fn json_body(row: &common::Recorded) -> Value {
    serde_json::from_slice(&row.body).unwrap_or(Value::Null)
}

#[test]
fn given_archive_when_dry_run_then_no_writes() {
    let home = tmp_dir("msn-import-dry");
    let archive = home.join("src.msnarchive.jsonl");
    write_archive(&archive, &[msg(1, "hi"), snapshot(1, 1, false)], 1, 1, 0);
    let state_file = home.join("map.json");
    let server = MockServer::spawn(vec![channels(&[])]);
    let out = run(
        &server,
        &archive,
        &home,
        &["--dry-run", "--state-file", state_file.to_str().unwrap()],
    );
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report = stdout_json(&out);
    assert_eq!(report["dryRun"], true);
    assert_eq!(report["writes"], false);
    assert_eq!(report["messageCount"], 1);
    assert_eq!(report["snapshotCount"], 1);
    assert_eq!(report["trust"], "provenance");
    assert_eq!(report["destination"]["wouldCreate"], true);
    assert!(posts(&server).is_empty(), "{:?}", posts(&server));
    assert!(!state_file.exists());
    assert!(!home.join("state/msn").exists() || no_cursor_dirs(&home.join("state")));
}

#[test]
fn given_archive_when_import_then_destination_receives_wrapped_messages() {
    let home = tmp_dir("msn-import-clean");
    let archive = home.join("src.msnarchive.jsonl");
    write_archive(
        &archive,
        &[
            msg(10, "hello"),
            reply(11, 10, "world"),
            snapshot(1, 11, false),
        ],
        11,
        1,
        0,
    );
    let state_file = home.join("map.json");
    let server = MockServer::spawn(vec![
        channels(&[]),
        created(),
        sent(1, false),
        sent(2, false),
        sent(3, false),
        catchup(3, 0),
        snapshot_created(1, false),
        sent(4, false),
    ]);
    let out = run(
        &server,
        &archive,
        &home,
        &["--state-file", state_file.to_str().unwrap()],
    );
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report = stdout_json(&out);
    assert_eq!(report["status"], "complete");
    assert_eq!(report["destination"]["username"], "importer");
    let recorded = server.recorded();
    assert!(
        recorded.iter().all(|row| {
            row.headers.get("authorization").map(String::as_str)
                != Some(&format!("Bearer {ARCHIVE_TOKEN}"))
        }),
        "archive token must never be sent"
    );
    assert!(
        recorded
            .iter()
            .filter(|row| row.headers.contains_key("authorization"))
            .all(|row| row.headers.get("authorization") == Some(&format!("Bearer {DEST_TOKEN}"))),
        "{recorded:?}"
    );
    let messages: Vec<Value> = recorded
        .iter()
        .filter(|row| row.method == "POST" && row.path.ends_with("/messages"))
        .map(json_body)
        .collect();
    assert_eq!(messages[0]["username"], "importer");
    let begin: Value = serde_json::from_str(messages[0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(begin["schema"], "msn.import.v1");
    assert_eq!(begin["payload"]["kind"], "import-begin");
    let first: Value = serde_json::from_str(messages[1]["text"].as_str().unwrap()).unwrap();
    assert_eq!(first["schema"], "msn.import.v1");
    assert_eq!(first["source"]["username"], "alice");
    assert_eq!(first["source"]["messageId"], 10);
    assert_eq!(first["payload"]["text"], "hello");
    assert_eq!(messages[1]["username"], "importer");
    let reply_body = &messages[2];
    assert_eq!(reply_body["replyTo"], 2);
    let reply_env: Value = serde_json::from_str(reply_body["text"].as_str().unwrap()).unwrap();
    assert_eq!(reply_env["provenance"]["replyTo"], 10);
    let snap = recorded
        .iter()
        .find(|row| row.path.ends_with("/snapshots"))
        .map(json_body)
        .unwrap();
    assert_eq!(snap["username"], "importer");
    assert_eq!(snap["coversThrough"], 3);
    assert_eq!(snap["text"], "# Checkpoint");
    let complete: Value =
        serde_json::from_str(messages.last().unwrap()["text"].as_str().unwrap()).unwrap();
    assert_eq!(complete["payload"]["kind"], "import-complete");
    let key = recorded
        .iter()
        .find(|row| row.path.ends_with("/messages") && json_body(row)["replyTo"] == 2)
        .unwrap()
        .headers
        .get("idempotency-key")
        .cloned()
        .unwrap();
    let instance = instance_id(SOURCE_ORIGIN, "main", "general", CREATED);
    assert_eq!(key, import_idempotency_key(&instance, 11));
    let map: Value = serde_json::from_str(&fs::read_to_string(&state_file).unwrap()).unwrap();
    assert_eq!(map["status"], "complete");
    assert_eq!(map["map"]["10"], 2);
    assert_eq!(map["map"]["11"], 3);
    assert_eq!(
        fs::metadata(&state_file).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn given_already_imported_when_import_again_then_no_duplicates() {
    let home = tmp_dir("msn-import-dup");
    let archive = home.join("src.msnarchive.jsonl");
    write_archive(&archive, &[msg(1, "hi")], 1, 0, 0);
    let state_file = home.join("map.json");
    let server = MockServer::spawn(vec![
        channels(&[]),
        created(),
        sent(1, false),
        sent(2, false),
        sent(3, false),
        channels(&["dest"]),
        sent(1, true),
        sent(2, true),
        sent(3, true),
    ]);
    let out = run(
        &server,
        &archive,
        &home,
        &["--state-file", state_file.to_str().unwrap()],
    );
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let keys: Vec<String> = server
        .recorded()
        .iter()
        .filter_map(|row| row.headers.get("idempotency-key").cloned())
        .collect();
    let out = run(
        &server,
        &archive,
        &home,
        &["--state-file", state_file.to_str().unwrap()],
    );
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report = stdout_json(&out);
    assert_eq!(report["status"], "complete");
    assert!(report["replayedMessages"].as_u64().unwrap() >= 1);
    let keys2: Vec<String> = server
        .recorded()
        .iter()
        .filter_map(|row| row.headers.get("idempotency-key").cloned())
        .skip(keys.len())
        .collect();
    assert_eq!(keys, keys2);
    assert_eq!(
        server
            .recorded()
            .iter()
            .filter(|row| row.method == "PUT")
            .count(),
        1
    );
}

#[test]
fn given_partial_map_when_import_resumes_then_no_duplicates() {
    let home = tmp_dir("msn-import-resume");
    let archive = home.join("src.msnarchive.jsonl");
    write_archive(&archive, &[msg(1, "one"), msg(2, "two")], 2, 0, 0);
    let state_file = home.join("map.json");
    let server = MockServer::spawn(vec![
        channels(&[]),
        created(),
        sent(1, false),
        sent(2, false),
        sent(3, false).delayed(Duration::from_secs(3)),
        channels(&["dest"]),
        sent(1, true),
        sent(2, true),
        sent(3, true),
        sent(4, false),
    ]);
    let mut child = bin(&home)
        .args(tenant_args(&server.url()))
        .args(["import"])
        .arg(&archive)
        .args(["--channel", "dest", "--state-file"])
        .arg(&state_file)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let start = Instant::now();
    loop {
        if let Ok(text) = fs::read_to_string(&state_file)
            && text.contains("\"lastSourceId\":1")
        {
            break;
        }
        if start.elapsed() > Duration::from_secs(2) {
            let _ = child.kill();
            panic!("timed out waiting for partial import map");
        }
        thread::sleep(Duration::from_millis(20));
    }
    let _ = Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status();
    let _ = child.wait();
    let lock = PathBuf::from(format!("{}.lock", state_file.display()));
    let _ = fs::remove_file(&lock);
    let map: Value = serde_json::from_str(&fs::read_to_string(&state_file).unwrap()).unwrap();
    assert_eq!(map["status"], "in-progress");
    assert!(map.get("completionMarkerId").is_none());

    let out = run(
        &server,
        &archive,
        &home,
        &["--state-file", state_file.to_str().unwrap()],
    );
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report = stdout_json(&out);
    assert_eq!(report["status"], "complete");
    let map: Value = serde_json::from_str(&fs::read_to_string(&state_file).unwrap()).unwrap();
    assert_eq!(map["status"], "complete");
    assert!(map["map"].get("1").and_then(Value::as_u64).is_some());
    assert!(map["map"].get("2").and_then(Value::as_u64).is_some());
    assert_ne!(map["map"]["1"], map["map"]["2"]);
}

#[test]
fn given_409_payload_conflict_when_import_then_conflict() {
    let home = tmp_dir("msn-import-409");
    let archive = home.join("src.msnarchive.jsonl");
    write_archive(&archive, &[msg(1, "hi")], 1, 0, 0);
    let server = MockServer::spawn(vec![
        channels(&[]),
        created(),
        sent(1, false),
        Scripted::json(
            409,
            r#"{"error":{"code":"idempotency_conflict","message":"This idempotency key was used for different content."}}"#,
        ),
    ]);
    let out = run(&server, &archive, &home, &[]);
    assert_eq!(
        out.status.code(),
        Some(5),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("CONFLICT"), "{err}");
    assert!(err.contains("not rewritten"), "{err}");
}

#[test]
fn given_missing_reply_or_evidence_when_import_then_unresolved() {
    let home = tmp_dir("msn-import-refs");
    let archive = home.join("src.msnarchive.jsonl");
    let task = json!({
        "schema": "msn.task.v1",
        "action": "ready",
        "task": "issue-1",
        "evidence": [99],
    });
    write_archive(&archive, &[reply(5, 4, "late"), json_msg(6, task)], 6, 0, 0);
    let state_file = home.join("map.json");
    let server = MockServer::spawn(vec![
        channels(&[]),
        created(),
        sent(1, false),
        sent(2, false),
        sent(3, false),
        sent(4, false),
    ]);
    let out = run(
        &server,
        &archive,
        &home,
        &["--state-file", state_file.to_str().unwrap()],
    );
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report = stdout_json(&out);
    let kinds: Vec<&str> = report["unresolvedReferences"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row["kind"].as_str())
        .collect();
    assert!(kinds.contains(&"replyTo"), "{report}");
    assert!(kinds.contains(&"evidence"), "{report}");
    let messages: Vec<Value> = server
        .recorded()
        .iter()
        .filter(|row| row.method == "POST" && row.path.ends_with("/messages"))
        .map(json_body)
        .collect();
    assert!(messages.iter().all(|body| body.get("replyTo").is_none()));
}

#[test]
fn given_existing_channel_when_import_without_allow_then_refused() {
    let home = tmp_dir("msn-import-exists");
    let archive = home.join("src.msnarchive.jsonl");
    write_archive(&archive, &[msg(1, "hi")], 1, 0, 0);
    let server = MockServer::spawn(vec![channels(&["dest"])]);
    let out = run(&server, &archive, &home, &[]);
    assert_eq!(
        out.status.code(),
        Some(5),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("already exists"), "{err}");
    assert!(err.contains("--allow-existing"), "{err}");
    assert!(posts(&server).is_empty());
}

#[test]
fn given_bound_name_rejection_when_import_then_auth() {
    let home = tmp_dir("msn-import-bound");
    let archive = home.join("src.msnarchive.jsonl");
    write_archive(&archive, &[msg(1, "hi")], 1, 0, 0);
    let server = MockServer::spawn(vec![
        channels(&[]),
        created(),
        Scripted::json(
            403,
            r#"{"error":{"code":"username_bound","message":"This key may only send as bound-user."}}"#,
        ),
    ]);
    let out = run(&server, &archive, &home, &[]);
    assert_eq!(
        out.status.code(),
        Some(3),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("403") || err.contains("bound"), "{err}");
}

#[test]
fn given_invalidated_snapshot_when_import_then_not_published_as_valid() {
    let home = tmp_dir("msn-import-invalid");
    let archive = home.join("src.msnarchive.jsonl");
    write_archive(&archive, &[msg(1, "hi"), snapshot(1, 1, true)], 1, 1, 1);
    let server = MockServer::spawn(vec![
        channels(&[]),
        created(),
        sent(1, false),
        sent(2, false),
        sent(3, false),
        sent(4, false),
    ]);
    let out = run(&server, &archive, &home, &[]);
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report = stdout_json(&out);
    assert_eq!(report["unavailableSnapshots"], 1);
    assert_eq!(report["redactionsNotReconstructible"], true);
    assert!(
        report["losses"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str().unwrap().contains("not reconstructible"))
    );
    assert!(
        server
            .recorded()
            .iter()
            .all(|row| !row.path.ends_with("/snapshots")),
        "invalidated snapshot must not be published"
    );
    let unavailable = server
        .recorded()
        .iter()
        .map(json_body)
        .filter_map(|body| body.get("text").and_then(Value::as_str).map(str::to_string))
        .find(|text| text.contains("snapshot-unavailable"))
        .unwrap();
    assert!(unavailable.contains("\"invalidated\":true"));
}

#[test]
fn given_deleted_evidence_when_import_then_not_resurrected() {
    let home = tmp_dir("msn-import-deleted");
    let archive = home.join("src.msnarchive.jsonl");
    let task = json!({
        "schema": "msn.task.v1",
        "action": "ready",
        "task": "gone",
        "evidence": [7],
    });
    write_archive(&archive, &[json_msg(8, task)], 8, 0, 1);
    let server = MockServer::spawn(vec![
        channels(&[]),
        created(),
        sent(1, false),
        sent(2, false),
        sent(3, false),
    ]);
    let out = run(&server, &archive, &home, &[]);
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report = stdout_json(&out);
    assert!(
        report["unresolvedReferences"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["kind"] == "evidence" && row["target"] == 7)
    );
    assert!(server.recorded().iter().all(|row| {
        let Ok(body) = serde_json::from_slice::<Value>(&row.body) else {
            return true;
        };
        body.get("text")
            .and_then(Value::as_str)
            .is_none_or(|text| !text.contains("\"id\":7") || text.contains("evidence"))
    }));
}

#[test]
fn given_malformed_or_unknown_schema_when_import_then_rejected() {
    let home = tmp_dir("msn-import-bad");
    let bad = home.join("bad.msnarchive.jsonl");
    fs::write(&bad, "{\"record\":\"manifest\",\"format\":\"nope\"}\n").unwrap();
    let server = MockServer::spawn(vec![channels(&[])]);
    let out = run(&server, &bad, &home, &[]);
    assert_eq!(
        out.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(server.recorded().is_empty());

    let instance = instance_id(SOURCE_ORIGIN, "main", "general", CREATED);
    let future = json!({
        "record": "manifest",
        "format": FORMAT,
        "archiveVersion": 2,
        "exportedAt": "2026-09-18T09:00:00.000Z",
        "exportedBy": "exporter",
        "producer": "msn-cli/0.1.0",
        "source": {
            "origin": SOURCE_ORIGIN,
            "tenant": "main",
            "channel": "general",
            "channelCreatedAt": CREATED,
            "instanceId": instance,
        },
        "boundary": { "headCursor": 0, "historyRevision": 0, "after": 0, "snapshotVersion": 0 },
    });
    let future_path = home.join("future.msnarchive.jsonl");
    fs::write(&future_path, format!("{}\n", future)).unwrap();
    let server = MockServer::spawn(vec![channels(&[])]);
    let out = run(&server, &future_path, &home, &[]);
    assert_eq!(out.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("archiveVersion")
            || String::from_utf8_lossy(&out.stderr).contains("Unsupported")
    );
}

#[test]
fn given_unknown_record_when_import_then_surfaced() {
    let home = tmp_dir("msn-import-unknown");
    let archive = home.join("src.msnarchive.jsonl");
    write_archive(
        &archive,
        &[json!({"record":"future-note","keep":true}), msg(1, "hi")],
        1,
        0,
        0,
    );
    let server = MockServer::spawn(vec![
        channels(&[]),
        created(),
        sent(1, false),
        sent(2, false),
        sent(3, false),
    ]);
    let dry = MockServer::spawn(vec![channels(&[])]);
    let dry_out = run(&dry, &archive, &home, &["--dry-run"]);
    assert_eq!(dry_out.status.code(), Some(0));
    let dry_report = stdout_json(&dry_out);
    assert_eq!(dry_report["unsupportedRecordCount"], 1);
    assert_eq!(dry_report["unsupportedRecords"][0]["record"], "future-note");
    let out = run(&server, &archive, &home, &[]);
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report = stdout_json(&out);
    assert_eq!(report["unsupportedRecords"][0]["record"], "future-note");
}

#[test]
fn given_import_when_complete_then_no_cursor_or_processing_files() {
    let home = tmp_dir("msn-import-nocursor");
    let archive = home.join("src.msnarchive.jsonl");
    write_archive(&archive, &[msg(1, "hi")], 1, 0, 0);
    let server = MockServer::spawn(vec![
        channels(&[]),
        created(),
        sent(1, false),
        sent(2, false),
        sent(3, false),
    ]);
    let out = run(&server, &archive, &home, &[]);
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        no_cursor_dirs(&home.join("state")),
        "import wrote reader/processing state"
    );
    let imports = find_named(&home.join("state"), "imports");
    assert!(!imports.is_empty(), "expected an imports map under state");
}

#[test]
fn given_replay_tasks_when_import_then_warns_and_sends_unwrapped() {
    let home = tmp_dir("msn-import-replay");
    let archive = home.join("src.msnarchive.jsonl");
    let task = json!({
        "schema": "msn.task.v1",
        "action": "open",
        "task": "issue-9",
        "title": "Do it",
        "reviewer": "planner",
    });
    write_archive(&archive, &[json_msg(1, task.clone())], 1, 0, 0);
    let server = MockServer::spawn(vec![
        channels(&[]),
        created(),
        sent(1, false),
        sent(2, false),
        sent(3, false),
    ]);
    let out = run(&server, &archive, &home, &["--trust", "replay-tasks"]);
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("re-attributes actorship"), "{err}");
    assert!(err.contains("never implied"), "{err}");
    let task_send = server
        .recorded()
        .iter()
        .map(json_body)
        .find(|body| {
            body.get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.contains("msn.task.v1") && text.contains("issue-9"))
        })
        .unwrap();
    let payload: Value = serde_json::from_str(task_send["text"].as_str().unwrap()).unwrap();
    assert_eq!(payload["schema"], "msn.task.v1");
    assert_eq!(payload["action"], "open");
    assert!(payload.get("source").is_none());
}

#[test]
fn given_conflicting_task_slugs_when_replay_then_reported() {
    let home = tmp_dir("msn-import-slug");
    let archive = home.join("src.msnarchive.jsonl");
    let task = json!({
        "schema": "msn.task.v1",
        "action": "open",
        "task": "shared",
        "title": "Other",
        "reviewer": "planner",
    });
    write_archive(&archive, &[json_msg(1, task)], 1, 0, 0);
    let existing = json!({
        "id": 9,
        "tenant": "team",
        "channel": "dest",
        "username": "local",
        "text": "{\"schema\":\"msn.task.v1\",\"action\":\"open\",\"task\":\"shared\",\"title\":\"Live\",\"reviewer\":\"planner\"}",
        "contentType": "application/json",
        "createdAt": CREATED,
    });
    let server = MockServer::spawn(vec![
        channels(&["dest"]),
        dest_messages(vec![existing]),
        sent(10, false),
        sent(11, false),
        sent(12, false),
    ]);
    let out = run(
        &server,
        &archive,
        &home,
        &["--trust", "replay-tasks", "--allow-existing"],
    );
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report = stdout_json(&out);
    assert!(
        report["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["kind"] == "task-slug" && row["task"] == "shared"),
        "{report}"
    );
    let imported = server
        .recorded()
        .iter()
        .map(json_body)
        .find(|body| {
            body.get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.contains("shared") && text.contains("Other"))
        })
        .unwrap();
    let payload: Value = serde_json::from_str(imported["text"].as_str().unwrap()).unwrap();
    assert_eq!(payload["schema"], "msn.import.v1");
}

fn no_cursor_dirs(root: &Path) -> bool {
    if !root.exists() {
        return true;
    }
    for entry in walk(root) {
        let name = entry.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == "readers" || name == "processing" {
            return false;
        }
    }
    true
}

fn find_named(root: &Path, needle: &str) -> Vec<PathBuf> {
    walk(root)
        .into_iter()
        .filter(|path| path.file_name().and_then(|n| n.to_str()) == Some(needle))
        .collect()
}

fn walk(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path.clone());
            }
            out.push(path);
        }
    }
    out
}
