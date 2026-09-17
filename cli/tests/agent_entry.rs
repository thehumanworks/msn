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
fn identity() -> Scripted {
    Scripted::json(
        200,
        r#"{"tenant":"team","username":"alice","usernamePrefix":null}"#,
    )
}
fn catchup(after: u64) -> Scripted {
    Scripted::json(200, &json!({"snapshot":null,"messages":[],"nextCursor":after,"hasMore":false,"historyRevision":0,"headCursor":after}).to_string())
}

#[test]
fn start_validates_identity_and_keeps_one_bounded_page_without_local_state() {
    let server = MockServer::spawn(vec![identity(), catchup(4)]);
    // No HOME/XDG exists. Entry must not need or create a local cursor directory.
    let out = bin(&server)
        .args([
            "--reader",
            "worker-a",
            "start",
            "general",
            "--after",
            "4",
            "--limit",
            "2",
            "--max-bytes",
            "4096",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    let origin = url::Url::parse(&server.url())
        .unwrap()
        .origin()
        .ascii_serialization();
    assert_eq!(
        value["identity"],
        json!({"tenant":"team","username":"alice","reader":"worker-a","origin":origin})
    );
    assert_eq!(value["protocolVersion"], 1);
    assert_eq!(value["nextCursor"], 4);
    assert!(out.stdout.len() <= 4096);
    let requests = server.recorded();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].path, "/api/tenants/team");
    let url = url::Url::parse(&format!("http://test{}", requests[1].path)).unwrap();
    let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
    assert_eq!(query["after"], "4");
    assert_eq!(query["limit"], "2");
    assert!(query["maxBytes"].parse::<usize>().unwrap() < 4096);
}

#[test]
fn start_rejects_mismatched_selected_identity_before_reading_channel() {
    let server = MockServer::spawn(vec![identity()]);
    let out = bin(&server)
        .args(["--username", "bob", "start", "general"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(3));
    assert!(out.stdout.is_empty());
    assert_eq!(server.recorded().len(), 1);
}

#[test]
fn prefix_key_requires_a_matching_selected_sender() {
    for (name, expected) in [("agent-one", 0), ("outsider", 3)] {
        let server = MockServer::spawn(vec![
            Scripted::json(
                200,
                r#"{"tenant":"team","username":null,"usernamePrefix":"agent-"}"#,
            ),
            catchup(0),
        ]);
        let out = bin(&server)
            .args(["--username", name, "start", "general"])
            .output()
            .unwrap();
        assert_eq!(
            out.status.code(),
            Some(expected),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let server = MockServer::spawn(vec![Scripted::json(
        200,
        r#"{"tenant":"team","username":null,"usernamePrefix":"agent-"}"#,
    )]);
    let out = bin(&server).args(["start", "general"]).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
}

#[test]
fn invalid_start_budget_is_offline_and_oversized_response_emits_nothing() {
    let server = MockServer::spawn(vec![]);
    let out = bin(&server)
        .args(["start", "general", "--max-bytes", "1024"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(server.recorded().is_empty());
    let page = json!({"messages":[],"hasMore":false,"nextCursor":0,"headCursor":0,"historyRevision":0,"snapshot":null,"extra":"x".repeat(5000)});
    let server = MockServer::spawn(vec![identity(), Scripted::json(200, &page.to_string())]);
    let out = bin(&server)
        .args(["start", "general", "--max-bytes", "4096"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
}

#[test]
fn initial_start_omits_after_and_does_not_drain_has_more() {
    let server = MockServer::spawn(vec![
        identity(),
        Scripted::json(
            200,
            r#"{"snapshot":{"version":1,"tenant":"team","channel":"general","invalidated":false,"historyRevision":0,"coversThrough":7},"messages":[{"id":8,"tenant":"team","channel":"general"}],"nextCursor":8,"headCursor":9,"historyRevision":0,"hasMore":true}"#,
        ),
    ]);
    let out = bin(&server).args(["start", "general"]).output().unwrap();
    assert!(out.status.success());
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["hasMore"], true);
    assert_eq!(value["snapshot"]["version"], 1);
    let requests = server.recorded();
    assert_eq!(requests.len(), 2);
    assert!(!requests[1].path.contains("after="));
}

#[test]
fn exact_show_rejects_wrong_row_and_preserves_missing_deleted_exit_codes() {
    for (status, body, code) in [
        (
            200,
            json!({"message":{"id":8,"channel":"general","tenant":"team"}}).to_string(),
            1,
        ),
        (
            404,
            r#"{"error":{"message":"Message not found."}}"#.to_owned(),
            4,
        ),
        (
            410,
            r#"{"error":{"message":"Message deleted."}}"#.to_owned(),
            5,
        ),
    ] {
        let server = MockServer::spawn(vec![Scripted::json(status, &body)]);
        let out = bin(&server)
            .args(["show", "general", "7"])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(code));
        assert!(out.stdout.is_empty());
    }
    let server = MockServer::spawn(vec![Scripted::json(
        200,
        r#"{"message":{"id":7,"channel":"general","tenant":"team"},"historyRevision":2}"#,
    )]);
    let out = bin(&server)
        .args(["show", "general", "7"])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&out.stdout).unwrap()["historyRevision"],
        2
    );
    assert_eq!(
        server.recorded()[0].path,
        "/api/tenants/team/channels/general/messages/7"
    );
}

#[test]
fn start_rejects_wrong_stream_and_bad_continuation_without_stdout() {
    let base = json!({"snapshot":null,"messages":[{"id":2,"tenant":"team","channel":"general"}],"nextCursor":2,"headCursor":4,"historyRevision":0,"hasMore":false});
    for defect in [
        "tenant",
        "channel",
        "nextCursor",
        "regression",
        "empty-more",
    ] {
        let mut page = base.clone();
        match defect {
            "tenant" | "channel" => page["messages"][0][defect] = json!("foreign"),
            "nextCursor" => page["nextCursor"] = json!(4),
            "regression" => {
                page["messages"][0]["id"] = json!(1);
                page["nextCursor"] = json!(1);
            }
            _ => {
                page["messages"] = json!([]);
                page["hasMore"] = json!(true);
                page["nextCursor"] = json!(1);
            }
        }
        let server = MockServer::spawn(vec![identity(), Scripted::json(200, &page.to_string())]);
        let out = bin(&server)
            .args(["start", "general", "--after", "1"])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(1), "{defect}");
        assert!(out.stdout.is_empty());
    }
}

#[test]
fn start_budget_accounts_for_origin_in_the_larger_extra_payload() {
    let server = MockServer::spawn(vec![identity(), catchup(0)]);
    let max_bytes = 4096_u64;
    let out = bin(&server)
        .args(["start", "general", "--max-bytes", &max_bytes.to_string()])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    let origin = url::Url::parse(&server.url())
        .unwrap()
        .origin()
        .ascii_serialization();
    assert_eq!(value["identity"]["origin"], origin);
    assert_eq!(value["protocolVersion"], 1);
    let extra = json!({
        "protocolVersion": value["protocolVersion"],
        "identity": value["identity"],
        "workflow": value["workflow"],
        "warnings": value["warnings"]
    });
    let overhead = serde_json::to_vec(&extra).unwrap().len() as u64;
    assert!(
        overhead > 846,
        "origin must increase the measured extra payload ({overhead})"
    );
    let requests = server.recorded();
    let url = url::Url::parse(&format!("http://test{}", requests[1].path)).unwrap();
    let sent_budget: u64 = url
        .query_pairs()
        .find(|(k, _)| k == "maxBytes")
        .unwrap()
        .1
        .parse()
        .unwrap();
    assert_eq!(sent_budget, max_bytes - overhead);
    assert!(sent_budget >= 1024);
    assert!(out.stdout.len() as u64 <= max_bytes);
}

#[test]
fn start_minimum_budget_still_fits_identity_with_origin() {
    let server = MockServer::spawn(vec![identity(), catchup(0)]);
    let out = bin(&server)
        .args(["start", "general", "--max-bytes", "2048"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        value["identity"]["origin"],
        url::Url::parse(&server.url())
            .unwrap()
            .origin()
            .ascii_serialization()
    );
    assert!(out.stdout.len() <= 2048);
}

#[test]
fn start_budget_error_includes_metadata_in_the_required_total() {
    let server = MockServer::spawn(vec![
        identity(),
        Scripted::json(
            413,
            r#"{"error":{"code":"catchup_budget_too_small","message":"Increase maxBytes","requiredBytes":9000}}"#,
        ),
    ]);
    let out = bin(&server)
        .args(["start", "general", "--max-bytes", "8192"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    let requests = server.recorded();
    let url = url::Url::parse(&format!("http://test{}", requests[1].path)).unwrap();
    let sent_budget: u64 = url
        .query_pairs()
        .find(|(k, _)| k == "maxBytes")
        .unwrap()
        .1
        .parse()
        .unwrap();
    let total = 9000 + 8192 - sent_budget;
    assert!(String::from_utf8_lossy(&out.stderr).contains(&format!("at least {total} bytes")));
}
