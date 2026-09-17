#[allow(dead_code)]
mod common;
use common::{MockServer, Scripted};
use serde_json::{Value, json};
use std::process::Command;

fn bin(server: &MockServer) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_msn"));
    cmd.env_clear().args([
        "--url",
        &server.url(),
        "--tenant",
        "team",
        "--token",
        "test-token",
    ]);
    cmd
}
fn message(id: u64, task: &str) -> Value {
    json!({"id":id,"tenant":"team","channel":"general","username":"lead","contentType":"application/json","text":json!({"schema":"msn.task.v1","task":task,"action":"open","title":task,"reviewer":"lead","dependsOn":[]}).to_string()})
}
fn page(rows: Value, head: u64, cursor: u64, more: bool, revision: u64) -> Scripted {
    Scripted::json(200,&json!({"messages":rows,"headCursor":head,"nextCursor":cursor,"hasMore":more,"historyRevision":revision,"snapshot":null}).to_string())
}

#[test]
fn board_pins_head_ignores_new_appends_and_paginates_task_output() {
    let first = message(1, "a");
    let second = message(2, "b");
    let appended = message(3, "c");
    let server = MockServer::spawn(vec![
        page(json!([first]), 2, 1, true, 0),
        page(json!([second, appended]), 3, 3, false, 0),
        page(json!([message(1, "a")]), 3, 1, true, 0),
    ]);
    let out = bin(&server)
        .args(["task", "list", "general", "--limit", "1"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let board: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(board["headCursor"], 2);
    assert_eq!(board["complete"], true);
    assert_eq!(board["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(board["tasks"][0]["id"], "a");
    assert_eq!(board["nextCursor"], "a");
    assert_eq!(board["hasMore"], true);
    assert!(server.recorded().iter().all(|r| r.path.contains("after=")));
}

#[test]
fn redaction_during_or_after_scan_rejects_the_whole_board() {
    for during in [true, false] {
        let mut replies = vec![page(json!([message(1, "a")]), 2, 1, true, 0)];
        replies.push(page(
            json!([message(2, "b")]),
            2,
            2,
            false,
            if during { 1 } else { 0 },
        ));
        if !during {
            replies.push(page(json!([]), 2, 0, false, 1));
        }
        let server = MockServer::spawn(replies);
        let out = bin(&server)
            .args(["task", "list", "general"])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(5));
        assert!(out.stdout.is_empty());
    }
}

#[test]
fn bounded_scan_cannot_publish_a_partial_board() {
    let server = MockServer::spawn(vec![page(json!([message(1, "a")]), 2, 1, true, 0)]);
    let out = bin(&server)
        .args(["task", "list", "general", "--max-pages", "1"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("no partial board"));
}

#[test]
fn task_output_cursor_is_sorted_independently_of_open_order() {
    let rows = json!([message(1, "z"), message(2, "a"), message(3, "m")]);
    let server = MockServer::spawn(vec![
        page(rows, 3, 3, false, 0),
        page(json!([]), 3, 0, false, 0),
    ]);
    let out = bin(&server)
        .args(["task", "list", "general", "--after", "a", "--limit", "1"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let board: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(board["tasks"][0]["id"], "m");
    assert_eq!(board["nextCursor"], "m");
    assert_eq!(board["hasMore"], true);
}

#[test]
fn wrong_channel_or_inconsistent_cursor_history_is_rejected() {
    let mut foreign = message(1, "a");
    foreign["channel"] = json!("other");
    for row in [
        page(json!([foreign]), 1, 1, false, 0),
        page(json!([message(1, "a")]), 2, 2, false, 0),
    ] {
        let server = MockServer::spawn(vec![row]);
        let out = bin(&server)
            .args(["task", "list", "general"])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
    }
}

#[test]
fn task_send_uses_readable_event_and_stable_key_with_no_identity_override() {
    let server = MockServer::spawn(vec![Scripted::json(
        201,
        r#"{"message":{"id":1},"replayed":false}"#,
    )]);
    let out = bin(&server)
        .args([
            "--username",
            "lead",
            "task",
            "open",
            "general",
            "build",
            "--title",
            "Build feature",
            "--reviewer",
            "reviewer",
            "--owner",
            "worker",
            "--depends-on",
            "design",
            "--key",
            "stable-task",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let request = &server.recorded()[0];
    let sent: Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(sent["username"], "lead");
    assert_eq!(sent["contentType"], "application/json");
    assert_eq!(
        request.headers.get("idempotency-key").unwrap(),
        "stable-task"
    );
    let event: Value = serde_json::from_str(sent["text"].as_str().unwrap()).unwrap();
    assert_eq!(event["schema"], "msn.task.v1");
    assert_eq!(event["task"], "build");
    assert_eq!(event["dependsOn"], json!(["design"]));
    assert!(event.get("actor").is_none());
}
