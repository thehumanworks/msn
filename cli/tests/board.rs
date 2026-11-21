//! Merge regression: account/board/persona commands coexist with persistent listeners.
#[allow(dead_code)]
mod common;

use common::{MockServer, Scripted};
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Command};

struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("msn-board-{}", uuid::Uuid::new_v4())))
    }
    fn run(&self, args: &[&str]) -> Value {
        let out = Command::new(env!("CARGO_BIN_EXE_msn"))
            .env_clear()
            .env("HOME", &self.0)
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env("XDG_STATE_HOME", self.0.join("state"))
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let value: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert!(value.get("token").is_none());
        value
    }
    fn profile(&self, name: &str) -> Value {
        serde_json::from_slice(
            &fs::read(self.0.join(format!("config/msn/profiles/{name}.json"))).unwrap(),
        )
        .unwrap()
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn portable_account_creation_retry_export_and_import_preserve_credentials() {
    let home = Home::new();
    let server = MockServer::spawn(vec![Scripted::json(200, "{}"), Scripted::json(200, "{}")]);
    home.run(&[
        "--url",
        &server.url(),
        "--username",
        "human",
        "login",
        "--create",
    ]);
    let account = home.profile("account");
    home.run(&[
        "--url",
        &server.url(),
        "--username",
        "human",
        "login",
        "--create",
    ]);
    assert_eq!(account, home.profile("account"));
    let requests = server.recorded();
    assert_eq!(requests.len(), 2);
    for request in requests {
        assert_eq!(request.method, "PUT");
        assert_eq!(
            request.path,
            format!("/api/tenants/{}", account["tenant"].as_str().unwrap())
        );
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["credential"], account["token"]);
    }
    let exported = home.0.join("connection.json");
    home.run(&["connection-export", "--out", exported.to_str().unwrap()]);
    let exported_value: Value = serde_json::from_slice(&fs::read(&exported).unwrap()).unwrap();
    assert_eq!(exported_value["token"], account["token"]);
    // Imported connection chooses its own origin, never forwards an ambient token.
    let identity = json!({"tenant": account["tenant"], "username": "human"});
    let import_server = MockServer::spawn(vec![Scripted::json(200, &identity.to_string())]);
    let mut connection = exported_value;
    connection["url"] = json!(import_server.url());
    fs::write(&exported, serde_json::to_vec(&connection).unwrap()).unwrap();
    home.run(&[
        "login",
        "--connection",
        exported.to_str().unwrap(),
        "--save-as",
        "second-device",
    ]);
    assert_eq!(home.profile("second-device")["token"], account["token"]);
    assert_eq!(
        import_server.recorded()[0].headers["authorization"],
        format!("Bearer {}", account["token"].as_str().unwrap())
    );
}

#[test]
fn board_and_persona_dispatch_keep_shared_channel_key_and_distinct_reader() {
    let home = Home::new();
    let server = MockServer::spawn(vec![
        Scripted::json(200, "{}"),
        Scripted::json(200, "{}"),
        Scripted::json(
            200,
            r#"{"tenant":"team","sharedChannel":true,"channel":"work"}"#,
        ),
        Scripted::json(200, "{}"),
        Scripted::json(
            200,
            r#"{"personas":[{"id":"reviewer","displayName":"Reviewer"}]}"#,
        ),
        Scripted::json(200, r#"{"board":{"goal":"Verify release","revision":1}}"#),
    ]);
    home.run(&[
        "--url",
        &server.url(),
        "--tenant",
        "team",
        "--token",
        "owner-secret",
        "board",
        "create",
        "work",
        "--goal",
        "Verify release",
        "--save-as",
        "lead",
    ]);
    home.run(&[
        "--profile",
        "lead",
        "persona",
        "add",
        "work",
        "Reviewer",
        "--id",
        "reviewer",
        "--save-as",
        "reviewer",
    ]);
    let lead = home.profile("lead");
    let reviewer = home.profile("reviewer");
    assert_eq!(lead["token"], reviewer["token"]);
    assert_ne!(lead["token"], "owner-secret");
    assert_ne!(lead["reader"], reviewer["reader"]);
    let roster = home.run(&["--profile", "reviewer", "persona", "list", "work"]);
    assert_eq!(roster["personas"][0]["id"], "reviewer");
    let board = home.run(&["--profile", "lead", "board", "show", "work"]);
    assert_eq!(board["board"]["goal"], "Verify release");
    let requests = server.recorded();
    assert_eq!(requests.len(), 6);
    assert_eq!(requests[0].path, "/api/tenants/team/channels/work/board");
    assert_eq!(requests[0].headers["authorization"], "Bearer owner-secret");
    assert_eq!(
        requests[3].path,
        "/api/tenants/team/channels/work/personas/reviewer"
    );
    assert_eq!(
        requests[3].headers["authorization"],
        format!("Bearer {}", lead["token"].as_str().unwrap())
    );
}

#[test]
fn board_archive_unarchive_and_archived_listing_use_the_archive_route() {
    let home = Home::new();
    let server = MockServer::spawn(vec![
        Scripted::json(
            200,
            r#"{"channel":"work","archived":true,"archivedAt":"2026-11-20T00:00:00.000Z"}"#,
        ),
        Scripted::json(200, r#"{"channel":"work","archived":false}"#),
        Scripted::json(200, r#"{"channels":[],"nextCursor":"","hasMore":false}"#),
    ]);
    let owner = [
        "--url",
        &server.url(),
        "--tenant",
        "team",
        "--token",
        "owner-secret",
    ];
    let archived = home.run(&[&owner[..], &["board", "archive", "work"]].concat());
    assert_eq!(archived["archived"], true);
    let restored = home.run(&[&owner[..], &["board", "unarchive", "work"]].concat());
    assert_eq!(restored["archived"], false);
    home.run(&[&owner[..], &["channels", "--archived"]].concat());
    let requests = server.recorded();
    assert_eq!(requests[0].method, "PUT");
    assert_eq!(requests[0].path, "/api/tenants/team/channels/work/archive");
    assert_eq!(requests[0].headers["authorization"], "Bearer owner-secret");
    assert_eq!(requests[1].method, "DELETE");
    assert_eq!(requests[1].path, "/api/tenants/team/channels/work/archive");
    assert!(
        requests[2].path.ends_with("&include=archived"),
        "{}",
        requests[2].path
    );
}

#[test]
fn wait_on_an_archived_board_stops_with_a_conflict_instead_of_polling_forever() {
    let home = Home::new();
    let server = MockServer::spawn(vec![Scripted::json(
        200,
        r#"{"messages":[],"nextCursor":7,"hasMore":false,"archived":true}"#,
    )]);
    let out = Command::new(env!("CARGO_BIN_EXE_msn"))
        .env_clear()
        .env("HOME", &home.0)
        .env("XDG_CONFIG_HOME", home.0.join("config"))
        .env("XDG_STATE_HOME", home.0.join("state"))
        .args([
            "--url",
            &server.url(),
            "--tenant",
            "team",
            "--token",
            "agent-secret",
            "wait",
            "work",
            "--after",
            "7",
        ])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(5));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("board_archived"), "{stderr}");
    assert!(stderr.contains("msn board unarchive work"), "{stderr}");
    assert!(out.stdout.is_empty());
    assert_eq!(server.recorded().len(), 1);
}

#[test]
fn persona_webhook_commands_use_the_owner_key_and_webhook_routes() {
    let home = Home::new();
    let server = MockServer::spawn(vec![
        Scripted::json(
            201,
            r#"{"webhook":{"persona":"reviewer","url":"https://agent.example.com/wake","bearer":false}}"#,
        ),
        Scripted::json(200, r#"{"webhook":{"persona":"reviewer"}}"#),
        Scripted::json(200, r#"{"webhooks":[]}"#),
        Scripted::json(202, r#"{"queued":true,"noticeId":"n1"}"#),
        Scripted::json(204, ""),
    ]);
    let base = [
        "--url",
        &server.url(),
        "--tenant",
        "team",
        "--token",
        "owner-secret",
        "persona",
        "webhook",
    ];
    let run = |rest: &[&str]| home.run(&[&base[..], rest].concat());
    let made = run(&["set", "work", "reviewer", "https://agent.example.com/wake"]);
    assert_eq!(made["webhook"]["bearer"], false);
    run(&["show", "work", "reviewer"]);
    run(&["list", "work"]);
    assert_eq!(run(&["test", "work", "reviewer"])["queued"], true);
    assert_eq!(run(&["remove", "work", "reviewer"])["removed"], "reviewer");
    let requests = server.recorded();
    let hook = "/api/tenants/team/channels/work/personas/reviewer/webhook";
    let expected = [
        ("PUT", hook.to_string()),
        ("GET", hook.to_string()),
        (
            "GET",
            "/api/tenants/team/channels/work/webhooks".to_string(),
        ),
        ("POST", format!("{hook}/test")),
        ("DELETE", hook.to_string()),
    ];
    assert_eq!(requests.len(), expected.len());
    for (request, (method, path)) in requests.iter().zip(expected) {
        assert_eq!(request.method, method);
        assert_eq!(request.path, path);
        assert_eq!(request.headers["authorization"], "Bearer owner-secret");
    }
    let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(body, json!({"url": "https://agent.example.com/wake"}));
}

#[test]
fn persona_webhook_set_reads_the_bearer_key_from_the_environment() {
    let home = Home::new();
    let server = MockServer::spawn(vec![Scripted::json(
        201,
        r#"{"webhook":{"persona":"reviewer","bearer":true}}"#,
    )]);
    let out = Command::new(env!("CARGO_BIN_EXE_msn"))
        .env_clear()
        .env("HOME", &home.0)
        .env("XDG_CONFIG_HOME", home.0.join("config"))
        .env("XDG_STATE_HOME", home.0.join("state"))
        .env("RECEIVER_KEY", "rcv_secret_key_123")
        .args([
            "--url",
            &server.url(),
            "--tenant",
            "team",
            "--token",
            "owner-secret",
            "persona",
            "webhook",
            "set",
            "work",
            "reviewer",
            "https://agent.example.com/wake",
            "--bearer-env",
            "RECEIVER_KEY",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!String::from_utf8_lossy(&out.stdout).contains("rcv_secret_key_123"));
    let body: Value = serde_json::from_slice(&server.recorded()[0].body).unwrap();
    assert_eq!(
        body,
        json!({"url": "https://agent.example.com/wake", "bearer": "rcv_secret_key_123"})
    );
    // A missing variable is a usage error and sends nothing.
    let missing = Command::new(env!("CARGO_BIN_EXE_msn"))
        .env_clear()
        .env("HOME", &home.0)
        .args([
            "--url",
            &server.url(),
            "--tenant",
            "team",
            "--token",
            "owner-secret",
            "persona",
            "webhook",
            "set",
            "work",
            "reviewer",
            "https://agent.example.com/wake",
            "--bearer-env",
            "NOPE",
        ])
        .output()
        .unwrap();
    assert!(!missing.status.success());
    assert_eq!(server.recorded().len(), 1);
}
