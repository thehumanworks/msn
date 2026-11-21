#[allow(dead_code)]
mod common;

use common::{MockServer, Scripted};
use msn_cli::identity::resolve_username;
use std::process::Command;
use url::Url;

#[test]
fn exact_key_supplies_sender_to_send() {
    let server = MockServer::spawn(vec![
        Scripted::json(
            200,
            r#"{"tenant":"team","username":"planner","usernamePrefix":null}"#,
        ),
        Scripted::json(201, r#"{"message":{"id":1},"replayed":false}"#),
    ]);
    let out = Command::new(env!("CARGO_BIN_EXE_msn"))
        .env_clear()
        .args([
            "--url",
            &server.url(),
            "--tenant",
            "team",
            "--token",
            "key",
            "send",
            "general",
            "--text",
            "ready",
            "--key",
            "retry-1",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let requests = server.recorded();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].path, "/api/tenants/team");
    assert_eq!(requests[1].headers["idempotency-key"], "retry-1");
    let body: serde_json::Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(body["username"], "planner");
    assert_eq!(body["text"], "ready");
}

#[test]
fn prefix_and_unbound_keys_need_a_selected_name() {
    for prefix in ["null", "\"agent-\""] {
        let body = format!(r#"{{"tenant":"team","username":null,"usernamePrefix":{prefix}}}"#);
        let server = MockServer::spawn(vec![Scripted::json(200, &body)]);
        let url = Url::parse(&server.url()).unwrap();
        let error = resolve_username(&url, "team", "key", None).unwrap_err();
        assert_eq!(error.exit_code(), 2);
        assert!(error.to_string().contains("--username"));
        assert_eq!(server.recorded().len(), 1);
    }
}

#[test]
fn explicit_names_are_validated_offline() {
    let server = MockServer::spawn(vec![]);
    let url = Url::parse(&server.url()).unwrap();
    assert_eq!(
        resolve_username(&url, "team", "key", Some("chosen")).unwrap(),
        "chosen"
    );
    for invalid in ["".to_owned(), " ".to_owned(), "😀".repeat(33)] {
        assert_eq!(
            resolve_username(&url, "team", "key", Some(&invalid))
                .unwrap_err()
                .exit_code(),
            2
        );
    }
    assert!(server.recorded().is_empty());
}

#[test]
fn identity_errors_never_guess_a_name() {
    for (status, body, code) in [
        (401, r#"{"error":{"message":"revoked"}}"#, 3),
        (200, r#"{"tenant":"another","username":"other"}"#, 1),
        (200, "not json", 1),
    ] {
        let server = MockServer::spawn(vec![Scripted::json(status, body)]);
        let error =
            resolve_username(&Url::parse(&server.url()).unwrap(), "team", "key", None).unwrap_err();
        assert_eq!(error.exit_code(), code);
    }
}

#[test]
fn malformed_payload_does_not_even_lookup_identity() {
    let server = MockServer::spawn(vec![]);
    let out = Command::new(env!("CARGO_BIN_EXE_msn"))
        .env_clear()
        .args([
            "--url",
            &server.url(),
            "--tenant",
            "team",
            "--token",
            "key",
            "send",
            "general",
            "--json",
            "{",
        ])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(server.recorded().is_empty());
}

#[test]
fn repeated_to_addresses_several_names_and_nine_fail_before_any_request() {
    // Several names (ADR 0067): repeat --to; the body carries them as a list in order.
    let server = MockServer::spawn(vec![Scripted::json(201, r#"{"message":{"id":1}}"#)]);
    let run = |names: &[&str]| {
        let mut args = vec![
            "--url".to_string(),
            server.url(),
            "--tenant".into(),
            "team".into(),
            "--token".into(),
            "key".into(),
            "--username".into(),
            "planner".into(),
            "send".into(),
            "general".into(),
            "--text".into(),
            "review".into(),
        ];
        for name in names {
            args.push("--to".into());
            args.push((*name).into());
        }
        Command::new(env!("CARGO_BIN_EXE_msn"))
            .env_clear()
            .args(args)
            .output()
            .unwrap()
    };
    let out = run(&["reviewer", "worker"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let body: serde_json::Value = serde_json::from_slice(&server.recorded()[0].body).unwrap();
    assert_eq!(body["to"], serde_json::json!(["reviewer", "worker"]));
    for bad in [
        vec!["a", "b", "c", "d", "e", "f", "g", "h", "i"],
        vec!["reviewer", "reviewer"],
    ] {
        let out = run(&bad);
        assert_eq!(out.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&out.stderr).contains("--to"));
    }
    assert_eq!(server.recorded().len(), 1);
}

#[test]
fn recipient_is_independent_of_reply_and_invalid_recipient_fails_before_lookup() {
    let server = MockServer::spawn(vec![Scripted::json(201, r#"{"message":{"id":1}}"#)]);
    let out = Command::new(env!("CARGO_BIN_EXE_msn"))
        .env_clear()
        .args([
            "--url",
            &server.url(),
            "--tenant",
            "team",
            "--token",
            "key",
            "--username",
            "planner",
            "send",
            "general",
            "--text",
            "review",
            "--to",
            "reviewer",
            "--reply-to",
            "42",
            "--correlation-id",
            "task-7",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let body: serde_json::Value = serde_json::from_slice(&server.recorded()[0].body).unwrap();
    assert_eq!(body["to"], "reviewer");
    assert_eq!(body["replyTo"], 42);
    assert_eq!(body["correlationId"], "task-7");
    for to in ["".to_owned(), " ".to_owned(), "😀".repeat(33)] {
        let out = Command::new(env!("CARGO_BIN_EXE_msn"))
            .env_clear()
            .args([
                "--url",
                &server.url(),
                "--tenant",
                "team",
                "--token",
                "key",
                "send",
                "general",
                "--text",
                "review",
                "--to",
                &to,
            ])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&out.stderr).contains("--to"));
    }
    assert_eq!(server.recorded().len(), 1);
}
