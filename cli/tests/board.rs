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
