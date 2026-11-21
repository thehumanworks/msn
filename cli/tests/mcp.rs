//! Binary verification for `msn mcp` over stdio against a scripted Worker.
//!
//! I5 send_returns_key_and_posts_once
//! I6 peek_then_commit_moves_processing_progress (shared with `msn peek`)
//! I7 every stdout line is a JSON-RPC message (checked in `session`)
//! Also: start returns the same identity page as `msn start`; the server exits on stdin EOF.

#[allow(dead_code)]
mod common;

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use common::{MockServer, Scripted};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A private HOME, plus an optional MSN_RESUMABLE for the processing mode (ADR 0053).
struct Home(PathBuf, Option<&'static str>);

impl Home {
    fn new() -> Self {
        Self(Self::fresh(), None)
    }

    fn fresh() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "msn-mcp-{}-{nanos}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    /// Progress kept on this machine only (`MSN_RESUMABLE=0`).
    fn local() -> Self {
        Self(Self::fresh(), Some("0"))
    }

    fn msn(&self, server: &MockServer) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_msn"));
        command
            .env_clear()
            .env("HOME", &self.0)
            .env("XDG_STATE_HOME", self.0.join("state"))
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .args([
                "--url",
                &server.url(),
                "--tenant",
                "team",
                "--token",
                "test-token",
                "--username",
                "alice",
            ]);
        if let Some(mode) = self.1 {
            command.env("MSN_RESUMABLE", mode);
        }
        command
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn call(id: u64, name: &str, arguments: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":arguments}})
}

/// Runs one MCP session: initialize, then `requests`, then EOF. Returns replies by id order.
fn session(home: &Home, server: &MockServer, requests: &[Value]) -> Vec<Value> {
    let mut child = home
        .msn(server)
        .args(["mcp", "--channel", "general"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut stdin = child.stdin.take().unwrap();
        let mut lines = vec![
            json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        ];
        lines.extend_from_slice(requests);
        for line in lines {
            writeln!(stdin, "{line}").unwrap();
        }
    }
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let replies: Vec<Value> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).expect("stdout carries only JSON-RPC"))
        .collect();
    assert_eq!(replies.len(), requests.len() + 1, "{replies:?}");
    assert_eq!(replies[0]["result"]["protocolVersion"], "2025-06-18");
    for reply in &replies {
        assert_eq!(reply["jsonrpc"], "2.0");
    }
    replies
}

fn ok(reply: &Value) -> &Value {
    assert_eq!(reply["result"]["isError"], false, "{reply}");
    let structured = &reply["result"]["structuredContent"];
    let text: Value =
        serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(&text, structured);
    structured
}

#[test]
fn send_returns_key_and_posts_once() {
    let home = Home::new();
    let server = MockServer::spawn(vec![Scripted::json(
        201,
        r#"{"message":{"id":9,"tenant":"team","channel":"general","username":"alice","text":"hi"}}"#,
    )]);
    let replies = session(
        &home,
        &server,
        &[call(
            1,
            "send",
            json!({"text":"hi","key":"turn-1","replyTo":4,"to":"bob"}),
        )],
    );
    let result = ok(&replies[1]);
    assert_eq!(result["idempotencyKey"], "turn-1");
    assert_eq!(result["message"]["id"], 9);
    let requests = server.recorded();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(
        requests[0].path,
        "/api/tenants/team/channels/general/messages"
    );
    assert_eq!(requests[0].headers["idempotency-key"], "turn-1");
    assert_eq!(
        serde_json::from_slice::<Value>(&requests[0].body).unwrap(),
        json!({"username":"alice","text":"hi","replyTo":4,"to":"bob"})
    );
}

#[test]
fn send_addresses_a_list_of_names() {
    // Several names (ADR 0067): `to` may be a list; it is sent as given.
    let home = Home::new();
    let server = MockServer::spawn(vec![Scripted::json(
        201,
        r#"{"message":{"id":9,"to":"bob","recipients":["bob","carol"]}}"#,
    )]);
    let replies = session(
        &home,
        &server,
        &[
            call(
                1,
                "send",
                json!({"text":"hi","key":"k-1","to":["bob","carol"]}),
            ),
            call(2, "send", json!({"text":"hi","to":[]})),
            call(
                3,
                "send",
                json!({"text":"hi","to":["a","b","c","d","e","f","g","h","i"]}),
            ),
        ],
    );
    assert_eq!(
        ok(&replies[1])["message"]["recipients"],
        json!(["bob", "carol"])
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&server.recorded()[0].body).unwrap(),
        json!({"username":"alice","text":"hi","to":["bob","carol"]})
    );
    assert_eq!(server.recorded().len(), 1);
}

#[test]
fn send_carries_a_quote_and_refuses_one_without_reply_to() {
    // Quote in a reply (ADR 0059).
    let home = Home::new();
    let server = MockServer::spawn(vec![Scripted::json(
        201,
        r#"{"message":{"id":9,"tenant":"team","channel":"general","username":"alice","text":"yes","replyTo":4,"quote":"Ship it?"}}"#,
    )]);
    let replies = session(
        &home,
        &server,
        &[
            call(
                1,
                "send",
                json!({"text":"yes","key":"q-1","replyTo":4,"quote":"Ship it?"}),
            ),
            call(
                2,
                "send",
                json!({"text":"yes","key":"q-2","quote":"Ship it?"}),
            ),
        ],
    );
    assert_eq!(ok(&replies[1])["message"]["quote"], "Ship it?");
    assert_eq!(replies[2]["result"]["isError"], true);
    let requests = server.recorded();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        serde_json::from_slice::<Value>(&requests[0].body).unwrap(),
        json!({"username":"alice","text":"yes","replyTo":4,"quote":"Ship it?"})
    );
}

#[test]
fn send_carries_replaces() {
    // Replace an instruction (ADR 0068).
    let home = Home::new();
    let server = MockServer::spawn(vec![Scripted::json(
        201,
        r#"{"message":{"id":9,"tenant":"team","channel":"general","username":"alice","text":"new","replaces":4}}"#,
    )]);
    let replies = session(
        &home,
        &server,
        &[call(
            1,
            "send",
            json!({"text":"new","key":"r-1","replaces":4}),
        )],
    );
    assert_eq!(ok(&replies[1])["message"]["replaces"], 4);
    assert_eq!(
        serde_json::from_slice::<Value>(&server.recorded()[0].body).unwrap(),
        json!({"username":"alice","text":"new","replaces":4})
    );
}

#[test]
fn peek_then_commit_moves_processing_progress() {
    let home = Home::local();
    let page = r#"{"messages":[{"id":5,"tenant":"team","channel":"general"},{"id":7,"tenant":"team","channel":"general"}],"nextCursor":7,"hasMore":false}"#;
    // Progress is bound to the origin, so the CLI check below uses the same server.
    let server = MockServer::spawn(vec![
        Scripted::json(200, page),
        Scripted::json(200, r#"{"messages":[],"nextCursor":7,"hasMore":false}"#),
    ]);
    let replies = session(
        &home,
        &server,
        &[
            call(1, "peek", json!({"wait":0})),
            call(2, "commit", json!({"through":8})),
            call(3, "commit", json!({"through":7})),
        ],
    );
    let peeked = ok(&replies[1]);
    assert_eq!(peeked["committedThrough"], 0);
    assert_eq!(peeked["highestFetched"], 7);
    assert_eq!(peeked["nextCursor"], 7);
    assert_eq!(replies[2]["result"]["isError"], true);
    assert!(
        replies[2]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("ahead of highestFetched")
    );
    assert_eq!(
        ok(&replies[3]),
        &json!({"committedThrough":7,"highestFetched":7})
    );
    assert!(
        server.recorded()[0]
            .path
            .starts_with("/api/tenants/team/channels/general/messages?after=0&wait=0")
    );

    // The CLI's own peek continues from the progress the MCP session committed.
    let out = home
        .msn(&server)
        .args(["peek", "general"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(server.recorded()[1].path.contains("after=7&"));
}

#[test]
fn peek_and_commit_go_to_the_server_by_default() {
    let home = Home::new();
    let server = MockServer::spawn(vec![
        Scripted::json(
            201,
            r#"{"reader":"alice","generation":1,"committedThrough":0,"holder":"h"}"#,
        ),
        Scripted::json(
            200,
            r#"{"messages":[{"id":5,"tenant":"team","channel":"general"}],"nextCursor":5,"hasMore":false,"committedThrough":0,"generation":1}"#,
        ),
        Scripted::json(
            200,
            r#"{"reader":"alice","generation":1,"committedThrough":5,"holder":"h"}"#,
        ),
    ]);
    let replies = session(
        &home,
        &server,
        &[
            call(1, "peek", json!({"wait":0})),
            call(2, "commit", json!({"through":5})),
        ],
    );
    assert_eq!(ok(&replies[1])["generation"], 1);
    assert_eq!(
        ok(&replies[2]),
        &json!({"committedThrough":5,"highestFetched":5,"generation":1})
    );
    let recorded = server.recorded();
    assert!(recorded[0].path.ends_with("/processing/alice/claim"));
    assert!(recorded[2].path.ends_with("/processing/alice/commit"));
}

#[test]
fn start_returns_identity_and_page() {
    let home = Home::new();
    let server = MockServer::spawn(vec![
        Scripted::json(200, r#"{"tenant":"team","username":"alice"}"#),
        Scripted::json(
            200,
            r#"{"snapshot":null,"messages":[],"nextCursor":0,"hasMore":false,"historyRevision":0,"headCursor":0}"#,
        ),
    ]);
    let replies = session(&home, &server, &[call(1, "start", json!({"limit":5}))]);
    let page = ok(&replies[1]);
    assert_eq!(page["protocolVersion"], 1);
    assert_eq!(page["identity"]["username"], "alice");
    assert_eq!(page["identity"]["tenant"], "team");
    assert!(
        server.recorded()[1]
            .path
            .starts_with("/api/tenants/team/channels/general/catchup?limit=5&maxBytes=")
    );
}

#[test]
fn catch_up_rejects_a_page_from_another_channel() {
    let home = Home::new();
    let server = MockServer::spawn(vec![Scripted::json(
        200,
        r#"{"snapshot":null,"messages":[{"id":3,"tenant":"team","channel":"other"}],"nextCursor":3,"hasMore":false,"historyRevision":0,"headCursor":3}"#,
    )]);
    let replies = session(&home, &server, &[call(1, "catch_up", json!({"after":2}))]);
    assert_eq!(replies[1]["result"]["isError"], true);
}

#[test]
fn uncertain_send_returns_its_key_and_a_retry_reuses_it() {
    let home = Home::new();
    let server = MockServer::spawn(vec![
        Scripted::json(
            503,
            r#"{"error":{"code":"unavailable","message":"try again"}}"#,
        ),
        Scripted::json(
            201,
            r#"{"message":{"id":9,"tenant":"team","channel":"general","username":"alice","text":"hi"}}"#,
        ),
    ]);
    let replies = session(&home, &server, &[call(1, "send", json!({"text":"hi"}))]);
    let failed = &replies[1]["result"];
    assert_eq!(failed["isError"], true);
    let key = failed["structuredContent"]["idempotencyKey"]
        .as_str()
        .unwrap()
        .to_owned();
    let replies = session(
        &home,
        &server,
        &[call(1, "send", json!({"text":"hi","key":key}))],
    );
    assert_eq!(ok(&replies[1])["idempotencyKey"], key.as_str());
    let requests = server.recorded();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].headers["idempotency-key"], key);
    assert_eq!(requests[1].headers["idempotency-key"], key);
}

#[test]
fn ask_posts_a_question_and_wait_answer_finds_the_reply() {
    // Ask a question with buttons (ADR 0065).
    let home = Home::new();
    let server = MockServer::spawn(vec![
        Scripted::json(
            201,
            r#"{"message":{"id":5,"username":"alice","text":"Ship it?","to":"tomas","choices":["yes","no"]}}"#,
        ),
        // wait_answer: the question, not yet answered, then a page with the answer.
        Scripted::json(
            200,
            r#"{"message":{"id":5,"to":"tomas","choices":["yes","no"]}}"#,
        ),
        Scripted::json(
            200,
            r#"{"messages":[{"id":6,"replyTo":5,"answer":"yes","username":"tomas","createdAt":"t6"}],"nextCursor":6}"#,
        ),
    ]);
    let replies = session(
        &home,
        &server,
        &[
            call(
                1,
                "ask",
                json!({"text":"Ship it?","to":"tomas","choices":["yes","no"],"key":"ask-1"}),
            ),
            call(2, "wait_answer", json!({"id":5,"wait":5})),
            call(
                3,
                "ask",
                json!({"text":"Ship?","to":"tomas","choices":["only"]}),
            ),
        ],
    );
    let asked = ok(&replies[1]);
    assert_eq!(asked["answered"], false);
    assert_eq!(asked["idempotencyKey"], "ask-1");
    assert_eq!(asked["message"]["choices"], json!(["yes", "no"]));
    assert_eq!(
        *ok(&replies[2]),
        json!({"question":5,"answered":true,"answer":{"question":5,"answer":"yes","username":"tomas","messageId":6,"answeredAt":"t6"}})
    );
    assert_eq!(replies[3]["result"]["isError"], true);
    let requests = server.recorded();
    assert_eq!(requests.len(), 3);
    assert_eq!(
        serde_json::from_slice::<Value>(&requests[0].body).unwrap(),
        json!({"username":"alice","text":"Ship it?","to":"tomas","choices":["yes","no"]})
    );
    assert!(requests[1].path.ends_with("/channels/general/messages/5"));
    assert!(
        requests[2]
            .path
            .contains("messages?thread=5&after=5&wait=5"),
        "{}",
        requests[2].path
    );
}

#[test]
fn answer_posts_the_choice_as_a_reply() {
    let home = Home::new();
    let server = MockServer::spawn(vec![Scripted::json(
        201,
        r#"{"message":{"id":6,"replyTo":5,"answer":"no"}}"#,
    )]);
    let replies = session(
        &home,
        &server,
        &[call(1, "answer", json!({"id":5,"choice":"no"}))],
    );
    assert_eq!(ok(&replies[1])["message"]["answer"], "no");
    assert_eq!(
        serde_json::from_slice::<Value>(&server.recorded()[0].body).unwrap(),
        json!({"username":"alice","text":"no","replyTo":5,"answer":"no"})
    );
}
