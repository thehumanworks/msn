//! `msn wait --all` (ADR 0069) against a scripted server: a server without the event-head route,
//! the agent's own message, and a cursor that moves while the board is being read.
#[allow(dead_code)]
mod common;

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use common::{MockServer, Scripted};
use serde_json::Value;

/// FNV-1a 64, as `cursor.rs` names state directories.
fn fnv(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[test]
fn falls_back_without_the_head_route_skips_own_messages_and_rechecks_a_moved_cursor() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let home = std::env::temp_dir().join(format!("msn-wait-all-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&home).unwrap();
    let server = MockServer::spawn(vec![
        // A server before ADR 0069: no head route, so the journal is paged to its end.
        Scripted::json(
            404,
            r#"{"error":{"code":"route_not_found","message":"Not found."}}"#,
        ),
        Scripted::json(
            200,
            r#"{"events":[{"id":3,"tenant":"team","channel":"general","type":"message.created","resourceId":5,"historyRevision":0,"createdAt":"2026-11-21T00:00:00.000Z"}],"nextCursor":3,"hasMore":false}"#,
        ),
        Scripted::json(
            200,
            r#"{"channels":[{"name":"general"}],"nextCursor":"general","hasMore":false}"#,
        ),
        // The catch-up: the agent's own message (sender folded) is skipped, 5 is addressed.
        // Delayed, so the test can move the board's cursor before the CLI takes its lock.
        Scripted::json(
            200,
            r#"{"messages":[{"id":4,"username":" REV","to":"rev","text":"mine"},{"id":5,"username":"lead","to":"Rev","text":"first"}],"nextCursor":5,"hasMore":false}"#,
        )
        .delayed(Duration::from_millis(800)),
        // The cursor moved to 5 meanwhile: look again from there.
        Scripted::json(
            200,
            r#"{"messages":[{"id":6,"username":"lead","text":"for all"},{"id":8,"username":"lead","to":"x","recipients":["x","rev"],"text":"second"}],"nextCursor":8,"hasMore":false}"#,
        ),
        // The board's new messages through the hit.
        Scripted::json(
            200,
            r#"{"messages":[{"id":6,"username":"lead","text":"for all"},{"id":8,"username":"lead","to":"x","recipients":["x","rev"],"text":"second"}],"nextCursor":8,"hasMore":false}"#,
        ),
    ]);
    let url = server.url();
    let cursor: PathBuf = home
        .join("state/msn")
        .join(fnv(&url))
        .join("team/readers")
        .join(fnv("rev"))
        .join("general.json");
    let child = Command::new(env!("CARGO_BIN_EXE_msn"))
        .env_clear()
        .env("HOME", &home)
        .env("XDG_STATE_HOME", home.join("state"))
        .args([
            "--url",
            &url,
            "--tenant",
            "team",
            "--token",
            "secret",
            "--username",
            "rev",
            "wait",
            "--all",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while server.recorded().len() < 4 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    fs::create_dir_all(cursor.parent().unwrap()).unwrap();
    fs::write(
        &cursor,
        format!(
            r#"{{"server":"{url}","tenant":"team","channel":"general","after":5,"reader":"rev"}}"#
        ),
    )
    .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let printed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(printed["channel"], "general");
    assert_eq!(printed["message"]["id"], 8);
    assert_eq!(printed["nextCursor"], 8);
    let ids: Vec<u64> = printed["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_u64().unwrap())
        .collect();
    assert_eq!(ids, vec![6, 8]);
    let saved: Value = serde_json::from_str(&fs::read_to_string(&cursor).unwrap()).unwrap();
    assert_eq!(saved["after"], 8);
    let paths: Vec<String> = server.recorded().into_iter().map(|r| r.path).collect();
    assert_eq!(paths[0], "/api/tenants/team/events/head");
    assert!(paths[1].starts_with("/api/tenants/team/events?after=0&wait=0"));
    assert!(paths[4].contains("/channels/general/messages?after=5"));
    fs::remove_dir_all(&home).unwrap();
}
