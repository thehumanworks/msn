#[allow(dead_code)]
mod common;

use common::{MockServer, Scripted};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

fn home() -> PathBuf {
    std::env::temp_dir().join(format!("msn-workspace-{}", uuid::Uuid::new_v4()))
}
fn run(home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_msn"))
        .env_clear()
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join("config"))
        .args(args)
        .output()
        .unwrap()
}
fn value(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
fn issued() -> Scripted {
    Scripted::json(
        201,
        &json!({"tenant":"team","username":"alice","token":"a".repeat(64)}).to_string(),
    )
}
fn stats() -> Scripted {
    Scripted::json(
        200,
        r#"{"channels":[{"name":"general","messageCount":3,"participantCount":2,"lastActivityAt":"2026-09-18T10:00:00Z"}],"hasMore":false,"nextCursor":"general"}"#,
    )
}

#[test]
fn create_caches_private_credentials_and_activity_and_selects_saved_profile() {
    let home = home();
    let server = MockServer::spawn(vec![
        issued(),
        stats(),
        Scripted::json(200, r#"{"tenant":"team","username":"alice"}"#),
    ]);
    let out = run(
        &home,
        &[
            "--url",
            &server.url(),
            "--username",
            "alice",
            "workspace",
            "create",
            "team",
            "--save-as",
            "my-team",
        ],
    );
    let result = value(&out);
    assert_eq!(result["activity"]["channels"][0]["messageCount"], 3);
    assert!(!String::from_utf8_lossy(&out.stdout).contains(&"a".repeat(64)));
    let file = home.join("config/msn/profiles/my-team.json");
    let saved: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert_eq!(saved["token"], "a".repeat(64));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(
        value(&run(&home, &["workspace", "list", "--offline"]))["workspaces"][0]["status"],
        "cached"
    );
    assert_eq!(
        value(&run(&home, &["--profile", "my-team", "whoami"]))["username"],
        "alice"
    );
    let requests = server.recorded();
    assert_eq!(requests[0].path, "/api/tenants/team");
    assert!(!requests[0].headers.contains_key("authorization"));
    assert_eq!(
        requests[2].headers["authorization"],
        format!("Bearer {}", "a".repeat(64))
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn joining_a_link_uses_its_origin_and_never_sends_existing_credentials() {
    let home = home();
    let server = MockServer::spawn(vec![issued(), stats()]);
    let link = format!("{}/#invite=team.{}", server.url(), "b".repeat(64));
    let result = value(&run(
        &home,
        &[
            "--url",
            "https://unused.test",
            "--token",
            "existing-secret",
            "join",
            &link,
            "--username",
            "alice",
        ],
    ));
    assert_eq!(result["tenant"], "team");
    assert_eq!(result["status"], "current");
    let requests = server.recorded();
    assert_eq!(requests[0].path, "/api/tenants/team/invites/redeem");
    assert!(!requests[0].headers.contains_key("authorization"));
    assert_eq!(
        serde_json::from_slice::<Value>(&requests[0].body).unwrap()["code"],
        format!("team.{}", "b".repeat(64))
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn join_code_and_invite_options_follow_the_shared_api() {
    let home = home();
    let server = MockServer::spawn(vec![
        issued(),
        stats(),
        Scripted::json(201, r#"{"url":"https://example.test/#invite=code"}"#),
        Scripted::empty(204),
    ]);
    value(&run(
        &home,
        &[
            "--url",
            &server.url(),
            "join",
            &format!("team.{}", "b".repeat(64)),
            "--username",
            "alice",
            "--save-as",
            "agent",
        ],
    ));
    value(&run(
        &home,
        &[
            "--profile",
            "agent",
            "invite",
            "general",
            "--uses",
            "2",
            "--expires-in",
            "300",
        ],
    ));
    value(&run(
        &home,
        &[
            "--profile",
            "agent",
            "invite-revoke",
            "11111111-1111-4111-8111-111111111111",
        ],
    ));
    let requests = server.recorded();
    assert_eq!(
        serde_json::from_slice::<Value>(&requests[2].body).unwrap(),
        json!({"channel":"general","maxUses":2,"expiresIn":300})
    );
    assert_eq!(requests[3].method, "DELETE");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn watch_invite_asks_for_read_only_and_revokes_a_full_access_fallback() {
    let home = home();
    let id = "11111111-1111-4111-8111-111111111111";
    let server = MockServer::spawn(vec![
        issued(),
        stats(),
        Scripted::json(
            201,
            &format!(r#"{{"id":"{id}","url":"https://example.test/#invite=code","watch":true}}"#),
        ),
        // An older server ignores `watch` and answers with an ordinary invitation.
        Scripted::json(
            201,
            &format!(r#"{{"id":"{id}","url":"https://example.test/#invite=code"}}"#),
        ),
        Scripted::empty(204),
        // Older server again, and this time the revoke fails.
        Scripted::json(
            201,
            &format!(r#"{{"id":"{id}","url":"https://example.test/#invite=code"}}"#),
        ),
        Scripted::json(503, "{}"),
    ]);
    value(&run(
        &home,
        &[
            "--url",
            &server.url(),
            "join",
            &format!("team.{}", "b".repeat(64)),
            "--username",
            "alice",
            "--save-as",
            "agent",
        ],
    ));
    let watch = ["--profile", "agent", "invite", "board", "--watch"];
    assert_eq!(value(&run(&home, &watch))["watch"], json!(true));
    let refused = run(&home, &watch);
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("was revoked"));
    let stuck = run(&home, &watch);
    assert!(!stuck.status.success());
    let stuck = String::from_utf8_lossy(&stuck.stderr);
    assert!(
        stuck.contains(id) && stuck.contains("may still be valid"),
        "{stuck}"
    );
    let requests = server.recorded();
    assert_eq!(
        serde_json::from_slice::<Value>(&requests[2].body).unwrap(),
        json!({"channel":"board","maxUses":25,"expiresIn":86400,"watch":true})
    );
    assert_eq!(requests[4].method, "DELETE");
    assert_eq!(requests[4].path, format!("/api/tenants/team/invites/{id}"));
    assert!(
        !run(
            &home,
            &[
                "--profile",
                "agent",
                "invite",
                "board",
                "--watch",
                "--for-agent",
                "--name",
                "x"
            ]
        )
        .status
        .success()
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn failed_refresh_keeps_issued_credentials_and_revocation_clears_cached_activity() {
    let home = home();
    let server = MockServer::spawn(vec![
        issued(),
        Scripted::json(503, "{}"),
        stats(),
        Scripted::json(401, "{}"),
    ]);
    let result = value(&run(
        &home,
        &[
            "--url",
            &server.url(),
            "--username",
            "alice",
            "workspace",
            "create",
            "team",
            "--save-as",
            "team",
        ],
    ));
    assert_eq!(result["status"], "unavailable");
    assert_eq!(
        value(&run(&home, &["workspace", "list"]))["workspaces"][0]["status"],
        "current"
    );
    let rejected = value(&run(&home, &["workspace", "list"]));
    assert_eq!(rejected["workspaces"][0]["status"], "access_denied");
    assert!(rejected["workspaces"][0]["activity"].is_null());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn existing_cache_or_invalid_input_prevents_mutating_the_server() {
    let home = home();
    let server = MockServer::spawn(vec![issued(), stats()]);
    let args = [
        "--url",
        &server.url(),
        "--username",
        "alice",
        "workspace",
        "create",
        "team",
        "--save-as",
        "team",
    ];
    value(&run(&home, &args));
    assert_eq!(run(&home, &args).status.code(), Some(5));
    for bad in [
        "not-an-invite",
        "https://user:pass@example.test/#invite=x",
        "http://example.test/#invite=x",
        "https://example.test/path#invite=x",
    ] {
        assert_eq!(
            run(&home, &["join", bad, "--username", "alice"])
                .status
                .code(),
            Some(2)
        );
    }
    assert_eq!(server.recorded().len(), 2);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn caches_existing_access_and_lists_multiple_workspaces_without_secrets() {
    let home = home();
    let server = MockServer::spawn(vec![
        issued(),
        stats(),
        Scripted::json(
            200,
            r#"{"tenant":"second","username":"bob","usernamePrefix":null}"#,
        ),
        stats(),
    ]);
    value(&run(
        &home,
        &[
            "--url",
            &server.url(),
            "--username",
            "alice",
            "workspace",
            "create",
            "team",
        ],
    ));
    value(&run(
        &home,
        &[
            "--url",
            &server.url(),
            "--tenant",
            "second",
            "--token",
            "second-secret",
            "workspace",
            "connect",
        ],
    ));
    let out = run(&home, &["workspace", "list", "--offline"]);
    assert_eq!(value(&out)["workspaces"].as_array().unwrap().len(), 2);
    assert!(!String::from_utf8_lossy(&out.stdout).contains("second-secret"));
    fs::remove_dir_all(home).unwrap();
}
