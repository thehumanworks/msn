//! Verification contract (2026-09-17)
//!
//! Goal: project() / validate_event() implement the msn.task.v1 visibility ledger.
//!
//! Invariants:
//!  I1 schema msn.task.v1; actor is outer message.username only
//!     -> given_event_username_when_project_then_envelope_actor_wins
//!     -> given_actor_key_when_validate_then_usage
//!  I2 assertedState is open|blocked|ready|closed|cancelled; effective state
//!     never stays closed/ready with unresolved issues (lead #425)
//!     -> given_owner_ready_when_reviewer_closes_then_closed
//!  I3 uncontested claim sets owner; competing claims expose owner=null + conflict
//!     -> given_two_claimants_when_project_then_no_last_write_win
//!  I4 assign by creator/reviewer names owner and clears claim-conflict
//!     -> given_claim_conflict_when_reviewer_assigns_then_owner_named
//!  I5 block/ready owner-only; close reviewer-only after ready; cancel creator/reviewer
//!     -> given_unauthorized_actors_when_transition_then_state_unchanged
//!  I6 ready/close rejected while claim-conflict stands
//!     -> given_claim_conflict_when_owner_readies_then_state_stays_open
//!  I7 assign by creator/reviewer reopens closed/cancelled; others cannot
//!     -> given_closed_task_when_authorized_assign_then_reopened
//!     -> given_closed_task_when_outsider_assigns_then_stays_closed
//!  I8 missing/cycle/cancelled/malformed deps never look completed
//!     -> given_missing_dep_when_closed_then_unsatisfied
//!     -> given_cycle_when_project_then_blocked_on_cycle
//!     -> given_cancelled_dep_when_dependent_closed_then_unsatisfied
//!  I9 duplicate open / unknown schema / invalid transition are warnings, not overwrites
//!     -> given_duplicate_open_when_project_then_original_title_kept
//!     -> given_unknown_schema_when_project_then_no_task
//!  I10 evidence keeps raw ids; missing/deleted rows mark orphan-evidence + unknown-evidence
//!     -> given_deleted_evidence_when_ready_then_orphan
//!     -> given_missing_evidence_when_ready_then_orphan
//!  I11 deleted open never yields a silently completed task
//!     -> given_deleted_open_when_later_close_then_no_task
//!  I12 validate_event is outbound syntax only (exit 2); ready requires >=1 positive id
//!     -> given_invalid_ready_when_validate_then_usage
//!  I13 board retains creator, acceptance, and latest assign/block/cancel reason (#441)
//!     -> given_open_block_when_project_then_acceptance_reason_creator
//!  I14 title/acceptance/reason/dependsOn/evidence stay bounded
//!     -> given_oversized_fields_when_validate_then_usage
//!     -> given_oversized_title_when_project_then_no_task
//!  I15 dependency satisfaction requires recursively clean effective closed (#453)
//!     -> given_parent_evidence_deleted_when_child_closed_then_conflict
//!     -> given_parent_duplicate_open_when_child_closed_then_conflict
//!  I16 ready evidence must be earlier than the ready event, not self/future
//!     -> given_self_or_future_evidence_when_ready_then_stays_open
//!  I17 diamond dependency walks are memoized and still close cleanly
//!     -> given_diamond_deps_when_all_closed_then_clean
//!
//! Edge: empty page, ordinary text, spoofed event.username, self-dependency,
//!       claim on cancelled, close before ready, blank reason, oversized fields.
//! Out of scope: CLI argv/network, Worker arbitration, binary wiring (root),
//!               cargo-mutants / scratch worktrees.
//!
//! QA:
//!  - cargo test --manifest-path cli/Cargo.toml --locked --test tasks
//!  - rustfmt cli/src/tasks.rs cli/tests/tasks.rs

use msn_cli::tasks::{
    MAX_ACCEPTANCE_BYTES, MAX_DEPENDS_ON, MAX_EVIDENCE, MAX_REASON_BYTES, MAX_TITLE_BYTES, SCHEMA,
    project, validate_event,
};
use serde_json::{Value, json};

fn msg(id: u64, username: &str, event: Value) -> Value {
    json!({
        "id": id,
        "username": username,
        "contentType": "application/json",
        "text": event.to_string(),
    })
}

fn open(task: &str, title: &str, reviewer: &str) -> Value {
    json!({
        "schema": SCHEMA,
        "task": task,
        "action": "open",
        "title": title,
        "reviewer": reviewer,
    })
}

fn open_owned(task: &str, title: &str, reviewer: &str, owner: &str) -> Value {
    let mut event = open(task, title, reviewer);
    event["owner"] = json!(owner);
    event
}

fn event(task: &str, action: &str) -> Value {
    json!({ "schema": SCHEMA, "task": task, "action": action })
}

fn task<'a>(board: &'a Value, id: &str) -> &'a Value {
    board["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .find(|row| row["id"] == id)
        .unwrap_or_else(|| panic!("missing task {id}"))
}

fn warning_codes(board: &Value) -> Vec<String> {
    board["warnings"]
        .as_array()
        .expect("warnings")
        .iter()
        .map(|row| row["code"].as_str().unwrap().to_string())
        .collect()
}

fn conflicts(board: &Value, id: &str) -> Vec<String> {
    task(board, id)["conflicts"]
        .as_array()
        .expect("conflicts")
        .iter()
        .map(|row| row.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn given_owner_ready_when_reviewer_closes_then_closed() {
    let board = project(&[
        msg(
            1,
            "lead",
            open_owned("alpha", "Ship projector", "reviewer", "owner"),
        ),
        msg(10, "note", json!({"hello":"ignore"})),
        msg(
            11,
            "owner",
            json!({
                "schema": SCHEMA,
                "task": "alpha",
                "action": "ready",
                "evidence": [10]
            }),
        ),
        msg(12, "reviewer", event("alpha", "close")),
    ]);
    let alpha = task(&board, "alpha");
    assert_eq!(alpha["title"], "Ship projector");
    assert_eq!(alpha["owner"], "owner");
    assert_eq!(alpha["reviewer"], "reviewer");
    assert_eq!(alpha["creator"], "lead");
    assert_eq!(alpha["acceptance"], Value::Null);
    assert_eq!(alpha["reason"], Value::Null);
    assert_eq!(alpha["state"], "closed");
    assert_eq!(alpha["assertedState"], "closed");
    assert_eq!(alpha["evidence"], json!([10]));
    assert_eq!(alpha["messageIds"], json!([1, 11, 12]));
    assert!(alpha["conflicts"].as_array().unwrap().is_empty());
    assert!(alpha["blockedOn"].as_array().unwrap().is_empty());
}

#[test]
fn given_event_username_when_project_then_envelope_actor_wins() {
    let mut spoofed = open("alpha", "T", "reviewer");
    spoofed["username"] = json!("spoofed-creator");
    spoofed["actor"] = json!("spoofed-actor");
    let board = project(&[
        msg(1, "real-creator", spoofed),
        msg(
            2,
            "eve",
            json!({
                "schema": SCHEMA,
                "task": "alpha",
                "action": "assign",
                "owner": "eve",
                "username": "real-creator"
            }),
        ),
    ]);
    let alpha = task(&board, "alpha");
    assert_eq!(alpha["owner"], Value::Null);
    assert_eq!(alpha["creator"], "real-creator");
    assert_eq!(alpha["state"], "open");
    assert!(warning_codes(&board).contains(&"unauthorized".into()));
}

#[test]
fn given_two_claimants_when_project_then_no_last_write_win() {
    let board = project(&[
        msg(1, "lead", open("alpha", "T", "reviewer")),
        msg(2, "alice", event("alpha", "claim")),
        msg(3, "bob", event("alpha", "claim")),
        msg(4, "bob", event("alpha", "claim")),
    ]);
    let alpha = task(&board, "alpha");
    assert_eq!(alpha["owner"], Value::Null);
    assert_eq!(alpha["state"], "conflict");
    assert_eq!(alpha["assertedState"], "open");
    assert!(conflicts(&board, "alpha").contains(&"claim-conflict".into()));
    assert_eq!(alpha["messageIds"], json!([1, 2, 3, 4]));
}

#[test]
fn given_claim_conflict_when_reviewer_assigns_then_owner_named() {
    let board = project(&[
        msg(1, "lead", open("alpha", "T", "reviewer")),
        msg(2, "alice", event("alpha", "claim")),
        msg(3, "bob", event("alpha", "claim")),
        msg(
            4,
            "reviewer",
            json!({
                "schema": SCHEMA,
                "task": "alpha",
                "action": "assign",
                "owner": "carol",
                "reason": "clear the race"
            }),
        ),
    ]);
    let alpha = task(&board, "alpha");
    assert_eq!(alpha["owner"], "carol");
    assert_eq!(alpha["state"], "open");
    assert_eq!(alpha["reason"], "clear the race");
    assert!(!conflicts(&board, "alpha").contains(&"claim-conflict".into()));
}

#[test]
fn given_claim_conflict_when_owner_readies_then_state_stays_open() {
    let board = project(&[
        msg(1, "lead", open("alpha", "T", "reviewer")),
        msg(2, "alice", event("alpha", "claim")),
        msg(3, "bob", event("alpha", "claim")),
        msg(
            4,
            "alice",
            json!({
                "schema": SCHEMA,
                "task": "alpha",
                "action": "ready",
                "evidence": [1]
            }),
        ),
        msg(5, "reviewer", event("alpha", "close")),
    ]);
    let alpha = task(&board, "alpha");
    assert_eq!(alpha["owner"], Value::Null);
    assert_eq!(alpha["state"], "conflict");
    assert_eq!(alpha["assertedState"], "open");
    assert_eq!(alpha["evidence"], json!([]));
    assert!(conflicts(&board, "alpha").contains(&"claim-conflict".into()));
    let codes = warning_codes(&board);
    assert_eq!(
        codes
            .iter()
            .filter(|code| *code == "invalid-transition")
            .count(),
        2
    );
}

#[test]
fn given_unauthorized_actors_when_transition_then_state_unchanged() {
    let board = project(&[
        msg(1, "lead", open_owned("alpha", "T", "reviewer", "owner")),
        msg(
            2,
            "eve",
            json!({ "schema": SCHEMA, "task": "alpha", "action": "block", "reason": "no" }),
        ),
        msg(
            3,
            "reviewer",
            json!({
                "schema": SCHEMA,
                "task": "alpha",
                "action": "ready",
                "evidence": [1]
            }),
        ),
        msg(4, "owner", event("alpha", "close")),
        msg(
            5,
            "eve",
            json!({ "schema": SCHEMA, "task": "alpha", "action": "cancel", "reason": "no" }),
        ),
        msg(
            6,
            "owner",
            json!({ "schema": SCHEMA, "task": "alpha", "action": "block", "reason": "waiting" }),
        ),
    ]);
    let alpha = task(&board, "alpha");
    assert_eq!(alpha["state"], "blocked");
    assert_eq!(alpha["owner"], "owner");
    let codes = warning_codes(&board);
    assert_eq!(
        codes.iter().filter(|code| *code == "unauthorized").count(),
        4
    );
}

#[test]
fn given_closed_task_when_authorized_assign_then_reopened() {
    let board = project(&[
        msg(1, "lead", open_owned("alpha", "T", "reviewer", "owner")),
        msg(
            2,
            "owner",
            json!({ "schema": SCHEMA, "task": "alpha", "action": "ready", "evidence": [1] }),
        ),
        msg(3, "reviewer", event("alpha", "close")),
        msg(
            4,
            "lead",
            json!({
                "schema": SCHEMA,
                "task": "alpha",
                "action": "assign",
                "owner": "other",
                "reason": "reopen after review"
            }),
        ),
    ]);
    let alpha = task(&board, "alpha");
    assert_eq!(alpha["state"], "open");
    assert_eq!(alpha["owner"], "other");
    assert_eq!(alpha["evidence"], json!([]));
    assert_eq!(alpha["messageIds"], json!([1, 2, 3, 4]));
    assert_eq!(alpha["reason"], "reopen after review");
}

#[test]
fn given_closed_task_when_outsider_assigns_then_stays_closed() {
    let board = project(&[
        msg(1, "lead", open_owned("alpha", "T", "reviewer", "owner")),
        msg(
            2,
            "owner",
            json!({ "schema": SCHEMA, "task": "alpha", "action": "ready", "evidence": [1] }),
        ),
        msg(3, "reviewer", event("alpha", "close")),
        msg(
            4,
            "eve",
            json!({ "schema": SCHEMA, "task": "alpha", "action": "assign", "owner": "eve" }),
        ),
        msg(5, "eve", event("alpha", "claim")),
    ]);
    let alpha = task(&board, "alpha");
    assert_eq!(alpha["state"], "closed");
    assert_eq!(alpha["owner"], "owner");
    assert!(warning_codes(&board).contains(&"unauthorized".into()));
    assert!(warning_codes(&board).contains(&"invalid-transition".into()));
}

#[test]
fn given_missing_dep_when_closed_then_unsatisfied() {
    let mut opening = open_owned("alpha", "T", "reviewer", "owner");
    opening["dependsOn"] = json!(["missing-dep"]);
    let board = project(&[
        msg(1, "lead", opening),
        msg(
            2,
            "owner",
            json!({ "schema": SCHEMA, "task": "alpha", "action": "ready", "evidence": [1] }),
        ),
        msg(3, "reviewer", event("alpha", "close")),
    ]);
    let alpha = task(&board, "alpha");
    assert_eq!(alpha["state"], "conflict");
    assert_eq!(alpha["assertedState"], "closed");
    assert_eq!(alpha["blockedOn"], json!(["missing-dep"]));
    let codes = conflicts(&board, "alpha");
    assert!(codes.contains(&"dependency-missing".into()));
    assert!(codes.contains(&"unsatisfied-dependencies".into()));
}

#[test]
fn given_cycle_when_project_then_blocked_on_cycle() {
    let mut a = open_owned("alpha", "A", "reviewer", "owner");
    a["dependsOn"] = json!(["beta"]);
    let mut b = open_owned("beta", "B", "reviewer", "owner");
    b["dependsOn"] = json!(["alpha"]);
    let board = project(&[
        msg(1, "lead", a),
        msg(2, "lead", b),
        msg(
            3,
            "owner",
            json!({ "schema": SCHEMA, "task": "alpha", "action": "ready", "evidence": [1] }),
        ),
        msg(4, "reviewer", event("alpha", "close")),
        msg(
            5,
            "owner",
            json!({ "schema": SCHEMA, "task": "beta", "action": "ready", "evidence": [2] }),
        ),
        msg(6, "reviewer", event("beta", "close")),
    ]);
    for id in ["alpha", "beta"] {
        let row = task(&board, id);
        assert_eq!(row["state"], "conflict", "{id}");
        assert_eq!(row["assertedState"], "closed", "{id}");
        assert!(!row["blockedOn"].as_array().unwrap().is_empty(), "{id}");
        let codes = conflicts(&board, id);
        assert!(codes.contains(&"dependency-cycle".into()), "{id}");
        assert!(codes.contains(&"unsatisfied-dependencies".into()), "{id}");
    }
    assert_eq!(task(&board, "alpha")["blockedOn"], json!(["beta"]));
    assert_eq!(task(&board, "beta")["blockedOn"], json!(["alpha"]));
}

#[test]
fn given_cancelled_dep_when_dependent_closed_then_unsatisfied() {
    let mut child = open_owned("child", "C", "reviewer", "owner");
    child["dependsOn"] = json!(["parent"]);
    let board = project(&[
        msg(1, "lead", open_owned("parent", "P", "reviewer", "owner")),
        msg(2, "lead", child),
        msg(
            3,
            "lead",
            json!({ "schema": SCHEMA, "task": "parent", "action": "cancel", "reason": "dropped" }),
        ),
        msg(
            4,
            "owner",
            json!({ "schema": SCHEMA, "task": "child", "action": "ready", "evidence": [2] }),
        ),
        msg(5, "reviewer", event("child", "close")),
    ]);
    let child = task(&board, "child");
    assert_eq!(child["state"], "conflict");
    assert_eq!(child["assertedState"], "closed");
    assert_eq!(child["blockedOn"], json!(["parent"]));
    assert!(conflicts(&board, "child").contains(&"unsatisfied-dependencies".into()));
    assert_eq!(task(&board, "parent")["state"], "cancelled");
}

#[test]
fn given_duplicate_open_when_project_then_original_title_kept() {
    let board = project(&[
        msg(1, "lead", open("alpha", "Original", "reviewer")),
        msg(2, "eve", open_owned("alpha", "Hijack", "eve", "eve")),
    ]);
    let alpha = task(&board, "alpha");
    assert_eq!(alpha["title"], "Original");
    assert_eq!(alpha["reviewer"], "reviewer");
    assert_eq!(alpha["owner"], Value::Null);
    assert!(conflicts(&board, "alpha").contains(&"duplicate-open".into()));
    assert_eq!(alpha["messageIds"], json!([1, 2]));
}

#[test]
fn given_unknown_schema_when_project_then_no_task() {
    let board = project(&[msg(
        1,
        "lead",
        json!({
            "schema": "msn.task.v0",
            "task": "alpha",
            "action": "open",
            "title": "Old",
            "reviewer": "reviewer"
        }),
    )]);
    assert_eq!(board["tasks"], json!([]));
    assert!(warning_codes(&board).contains(&"unknown-schema".into()));
}

#[test]
fn given_deleted_evidence_when_ready_then_orphan() {
    let board = project(&[
        msg(1, "lead", open_owned("alpha", "T", "reviewer", "owner")),
        json!({"id": 9, "deleted": true, "username": "", "text": ""}),
        msg(
            10,
            "owner",
            json!({
                "schema": SCHEMA,
                "task": "alpha",
                "action": "ready",
                "evidence": [9]
            }),
        ),
    ]);
    let alpha = task(&board, "alpha");
    assert_eq!(alpha["state"], "unknown");
    assert_eq!(alpha["assertedState"], "ready");
    assert_eq!(alpha["evidence"], json!([9]));
    assert!(conflicts(&board, "alpha").contains(&"orphan-evidence".into()));
    assert!(warning_codes(&board).contains(&"deleted-or-redacted".into()));
    assert!(warning_codes(&board).contains(&"unknown-evidence".into()));
}

#[test]
fn given_missing_evidence_when_ready_then_orphan() {
    let board = project(&[
        msg(1, "lead", open_owned("alpha", "T", "reviewer", "owner")),
        msg(
            3,
            "owner",
            json!({
                "schema": SCHEMA,
                "task": "alpha",
                "action": "ready",
                "evidence": [2]
            }),
        ),
    ]);
    assert_eq!(task(&board, "alpha")["evidence"], json!([2]));
    assert_eq!(task(&board, "alpha")["state"], "unknown");
    assert_eq!(task(&board, "alpha")["assertedState"], "ready");
    assert!(conflicts(&board, "alpha").contains(&"orphan-evidence".into()));
    let unknown = board["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["code"] == "unknown-evidence")
        .expect("unknown-evidence");
    assert_eq!(unknown["messageId"], 2);
    assert_eq!(unknown["task"], "alpha");
}

#[test]
fn given_deleted_open_when_later_close_then_no_task() {
    let board = project(&[
        json!({"id": 1, "deleted": true, "username": "", "text": ""}),
        msg(
            2,
            "owner",
            json!({
                "schema": SCHEMA,
                "task": "alpha",
                "action": "ready",
                "evidence": [2]
            }),
        ),
        msg(3, "reviewer", event("alpha", "close")),
    ]);
    assert_eq!(board["tasks"], json!([]));
    let codes = warning_codes(&board);
    assert!(codes.contains(&"deleted-or-redacted".into()));
    assert_eq!(
        codes.iter().filter(|code| *code == "unknown-task").count(),
        2
    );
}

#[test]
fn given_ordinary_text_when_project_then_empty_board() {
    let board = project(&[json!({
        "id": 1,
        "username": "lead",
        "contentType": "text/plain",
        "text": "not a task"
    })]);
    assert_eq!(board, json!({"tasks": [], "warnings": []}));
}

#[test]
fn given_self_dependency_when_project_then_cycle() {
    let mut opening = open("loop", "T", "reviewer");
    opening["dependsOn"] = json!(["loop"]);
    let board = project(&[msg(1, "lead", opening)]);
    assert_eq!(task(&board, "loop")["blockedOn"], json!(["loop"]));
    assert!(conflicts(&board, "loop").contains(&"dependency-cycle".into()));
}

#[test]
fn given_creator_cancel_when_blocked_then_cancelled() {
    let board = project(&[
        msg(1, "lead", open_owned("alpha", "T", "reviewer", "owner")),
        msg(
            2,
            "owner",
            json!({ "schema": SCHEMA, "task": "alpha", "action": "block", "reason": "wait" }),
        ),
        msg(
            3,
            "reviewer",
            json!({ "schema": SCHEMA, "task": "alpha", "action": "cancel", "reason": "obsolete" }),
        ),
    ]);
    assert_eq!(task(&board, "alpha")["state"], "cancelled");
    assert_eq!(task(&board, "alpha")["reason"], "obsolete");
    assert_eq!(task(&board, "alpha")["creator"], "lead");
}

#[test]
fn given_malformed_json_when_project_then_warning_not_task() {
    let board = project(&[json!({
        "id": 1,
        "username": "lead",
        "contentType": "application/json",
        "text": "{not-json"
    })]);
    assert_eq!(board["tasks"], json!([]));
    assert!(warning_codes(&board).contains(&"malformed-event".into()));
}

#[test]
fn given_actor_key_when_validate_then_usage() {
    let mut event = open("alpha", "T", "reviewer");
    event["actor"] = json!("x");
    let err = validate_event(&event).unwrap_err();
    assert_eq!(err.exit_code(), 2);
    assert!(err.to_string().contains("username"));
}

#[test]
fn given_invalid_ready_when_validate_then_usage() {
    for evidence in [
        json!([]),
        json!([0]),
        json!([-1]),
        json!([1.5]),
        json!("1"),
        json!((1..=MAX_EVIDENCE + 1).collect::<Vec<_>>()),
        json!([1, 1]),
    ] {
        let event = json!({
            "schema": SCHEMA,
            "task": "alpha",
            "action": "ready",
            "evidence": evidence,
        });
        let err = validate_event(&event).unwrap_err();
        assert_eq!(err.exit_code(), 2, "{event}");
    }
}

#[test]
fn given_valid_events_when_validate_then_ok() {
    assert!(validate_event(&open("alpha", "T", "reviewer")).is_ok());
    assert!(validate_event(&event("alpha", "claim")).is_ok());
    assert!(
        validate_event(&json!({
            "schema": SCHEMA,
            "task": "alpha",
            "action": "assign",
            "owner": "carol"
        }))
        .is_ok()
    );
    assert!(
        validate_event(&json!({
            "schema": SCHEMA,
            "task": "alpha",
            "action": "ready",
            "evidence": [1, 2]
        }))
        .is_ok()
    );
    assert!(
        validate_event(&json!({
            "schema": SCHEMA,
            "task": "alpha",
            "action": "block",
            "reason": "need review"
        }))
        .is_ok()
    );
}

#[test]
fn given_bad_slug_or_schema_when_validate_then_usage() {
    assert_eq!(
        validate_event(&json!({
            "schema": "msn.task.v2",
            "task": "alpha",
            "action": "claim"
        }))
        .unwrap_err()
        .exit_code(),
        2
    );
    assert_eq!(
        validate_event(&json!({
            "schema": SCHEMA,
            "task": "ALPHA",
            "action": "claim"
        }))
        .unwrap_err()
        .exit_code(),
        2
    );
    assert_eq!(
        validate_event(&json!({
            "schema": SCHEMA,
            "task": "alpha",
            "action": "explode"
        }))
        .unwrap_err()
        .exit_code(),
        2
    );
}

#[test]
fn given_clean_dep_when_parent_closed_then_unblocked() {
    let mut child = open_owned("child", "C", "reviewer", "owner");
    child["dependsOn"] = json!(["parent"]);
    let board = project(&[
        msg(1, "lead", open_owned("parent", "P", "reviewer", "owner")),
        msg(2, "lead", child),
        msg(
            3,
            "owner",
            json!({ "schema": SCHEMA, "task": "parent", "action": "ready", "evidence": [1] }),
        ),
        msg(4, "reviewer", event("parent", "close")),
        msg(
            5,
            "owner",
            json!({ "schema": SCHEMA, "task": "child", "action": "ready", "evidence": [2] }),
        ),
        msg(6, "reviewer", event("child", "close")),
    ]);
    assert_eq!(task(&board, "parent")["state"], "closed");
    assert_eq!(task(&board, "child")["state"], "closed");
    assert_eq!(task(&board, "child")["assertedState"], "closed");
    assert!(
        task(&board, "child")["blockedOn"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(conflicts(&board, "child").is_empty());
}

#[test]
fn given_object_text_and_string_ids_when_project_then_applied() {
    let board = project(&[json!({
        "id": "1",
        "username": "lead",
        "contentType": "application/json",
        "text": {
            "schema": SCHEMA,
            "task": "alpha",
            "action": "open",
            "title": "Object body",
            "reviewer": "reviewer"
        }
    })]);
    assert_eq!(task(&board, "alpha")["title"], "Object body");
    assert_eq!(task(&board, "alpha")["messageIds"], json!([1]));
}

#[test]
fn given_premature_close_when_dep_later_closes_then_still_conflict() {
    let mut child = open_owned("child", "C", "reviewer", "owner");
    child["dependsOn"] = json!(["parent"]);
    let board = project(&[
        msg(1, "lead", open_owned("parent", "P", "reviewer", "owner")),
        msg(2, "lead", child),
        msg(
            3,
            "owner",
            json!({ "schema": SCHEMA, "task": "child", "action": "ready", "evidence": [2] }),
        ),
        msg(4, "reviewer", event("child", "close")),
        msg(
            5,
            "owner",
            json!({ "schema": SCHEMA, "task": "parent", "action": "ready", "evidence": [1] }),
        ),
        msg(6, "reviewer", event("parent", "close")),
    ]);
    let child = task(&board, "child");
    assert_eq!(child["assertedState"], "closed");
    assert_eq!(child["state"], "conflict");
    assert!(conflicts(&board, "child").contains(&"unsatisfied-dependencies".into()));
    assert_eq!(task(&board, "parent")["state"], "closed");
}

#[test]
fn given_valid_close_when_dep_reopens_then_conflict() {
    let mut child = open_owned("child", "C", "reviewer", "owner");
    child["dependsOn"] = json!(["parent"]);
    let board = project(&[
        msg(1, "lead", open_owned("parent", "P", "reviewer", "owner")),
        msg(2, "lead", child),
        msg(
            3,
            "owner",
            json!({ "schema": SCHEMA, "task": "parent", "action": "ready", "evidence": [1] }),
        ),
        msg(4, "reviewer", event("parent", "close")),
        msg(
            5,
            "owner",
            json!({ "schema": SCHEMA, "task": "child", "action": "ready", "evidence": [2] }),
        ),
        msg(6, "reviewer", event("child", "close")),
        msg(
            7,
            "lead",
            json!({
                "schema": SCHEMA,
                "task": "parent",
                "action": "assign",
                "owner": "owner",
                "reason": "reopen parent"
            }),
        ),
    ]);
    assert_eq!(task(&board, "parent")["state"], "open");
    assert_eq!(task(&board, "child")["assertedState"], "closed");
    assert_eq!(task(&board, "child")["state"], "conflict");
    assert_eq!(task(&board, "child")["blockedOn"], json!(["parent"]));
}

#[test]
fn given_closed_task_when_evidence_deleted_then_unknown() {
    let board = project(&[
        msg(1, "lead", open_owned("alpha", "T", "reviewer", "owner")),
        msg(2, "note", json!({"ok":true})),
        msg(
            3,
            "owner",
            json!({ "schema": SCHEMA, "task": "alpha", "action": "ready", "evidence": [2] }),
        ),
        msg(4, "reviewer", event("alpha", "close")),
        json!({"id": 2, "deleted": true, "username": "", "text": ""}),
    ]);
    let alpha = task(&board, "alpha");
    assert_eq!(alpha["assertedState"], "closed");
    assert_eq!(alpha["state"], "unknown");
    assert_eq!(alpha["evidence"], json!([2]));
    assert!(conflicts(&board, "alpha").contains(&"orphan-evidence".into()));
}

#[test]
fn given_open_block_when_project_then_acceptance_reason_creator() {
    let mut opening = open_owned("alpha", "Ship", "reviewer", "owner");
    opening["acceptance"] = json!("tests pass and board shows why");
    let board = project(&[
        msg(1, "lead", opening),
        msg(
            2,
            "owner",
            json!({
                "schema": SCHEMA,
                "task": "alpha",
                "action": "block",
                "reason": "waiting on review"
            }),
        ),
    ]);
    let alpha = task(&board, "alpha");
    assert_eq!(alpha["creator"], "lead");
    assert_eq!(alpha["acceptance"], "tests pass and board shows why");
    assert_eq!(alpha["reason"], "waiting on review");
    assert_eq!(alpha["state"], "blocked");
    assert_eq!(alpha["assertedState"], "blocked");
}

#[test]
fn given_oversized_fields_when_validate_then_usage() {
    let mut long_title = open("alpha", &"t".repeat(MAX_TITLE_BYTES + 1), "reviewer");
    assert_eq!(validate_event(&long_title).unwrap_err().exit_code(), 2);
    long_title["title"] = json!("t".repeat(MAX_TITLE_BYTES));
    assert!(validate_event(&long_title).is_ok());

    let mut long_acceptance = open("alpha", "T", "reviewer");
    long_acceptance["acceptance"] = json!("a".repeat(MAX_ACCEPTANCE_BYTES + 1));
    assert_eq!(validate_event(&long_acceptance).unwrap_err().exit_code(), 2);

    assert_eq!(
        validate_event(&json!({
            "schema": SCHEMA,
            "task": "alpha",
            "action": "block",
            "reason": "r".repeat(MAX_REASON_BYTES + 1)
        }))
        .unwrap_err()
        .exit_code(),
        2
    );

    let mut many_deps = open("alpha", "T", "reviewer");
    many_deps["dependsOn"] = json!(
        (0..=MAX_DEPENDS_ON)
            .map(|i| format!("dep-{i}"))
            .collect::<Vec<_>>()
    );
    assert_eq!(validate_event(&many_deps).unwrap_err().exit_code(), 2);

    let mut dup_deps = open("alpha", "T", "reviewer");
    dup_deps["dependsOn"] = json!(["beta", "beta"]);
    assert_eq!(validate_event(&dup_deps).unwrap_err().exit_code(), 2);
}

#[test]
fn given_oversized_title_when_project_then_no_task() {
    let board = project(&[msg(
        1,
        "lead",
        open("alpha", &"t".repeat(MAX_TITLE_BYTES + 1), "reviewer"),
    )]);
    assert_eq!(board["tasks"], json!([]));
    assert!(warning_codes(&board).contains(&"malformed-event".into()));
}

#[test]
fn given_parent_evidence_deleted_when_child_closed_then_conflict() {
    let mut child = open_owned("child", "C", "reviewer", "owner");
    child["dependsOn"] = json!(["parent"]);
    let board = project(&[
        msg(1, "lead", open_owned("parent", "P", "reviewer", "owner")),
        msg(2, "note", json!({"ok": true})),
        msg(3, "lead", child),
        msg(
            4,
            "owner",
            json!({ "schema": SCHEMA, "task": "parent", "action": "ready", "evidence": [2] }),
        ),
        msg(5, "reviewer", event("parent", "close")),
        msg(
            6,
            "owner",
            json!({ "schema": SCHEMA, "task": "child", "action": "ready", "evidence": [3] }),
        ),
        msg(7, "reviewer", event("child", "close")),
        json!({"id": 2, "deleted": true, "username": "", "text": ""}),
    ]);
    let parent = task(&board, "parent");
    assert_eq!(parent["assertedState"], "closed");
    assert_eq!(parent["state"], "unknown");
    assert!(conflicts(&board, "parent").contains(&"orphan-evidence".into()));
    let child = task(&board, "child");
    assert_eq!(child["assertedState"], "closed");
    assert_eq!(child["state"], "conflict");
    assert_eq!(child["blockedOn"], json!(["parent"]));
    assert!(conflicts(&board, "child").contains(&"unsatisfied-dependencies".into()));
}

#[test]
fn given_parent_duplicate_open_when_child_closed_then_conflict() {
    let mut child = open_owned("child", "C", "reviewer", "owner");
    child["dependsOn"] = json!(["parent"]);
    let board = project(&[
        msg(1, "lead", open_owned("parent", "P", "reviewer", "owner")),
        msg(2, "eve", open("parent", "Hijack", "eve")),
        msg(3, "note", json!({"ok": true})),
        msg(4, "lead", child),
        msg(
            5,
            "owner",
            json!({ "schema": SCHEMA, "task": "parent", "action": "ready", "evidence": [3] }),
        ),
        msg(6, "reviewer", event("parent", "close")),
        msg(
            7,
            "owner",
            json!({ "schema": SCHEMA, "task": "child", "action": "ready", "evidence": [4] }),
        ),
        msg(8, "reviewer", event("child", "close")),
    ]);
    assert_eq!(task(&board, "parent")["state"], "conflict");
    assert!(conflicts(&board, "parent").contains(&"duplicate-open".into()));
    let child = task(&board, "child");
    assert_eq!(child["assertedState"], "closed");
    assert_eq!(child["state"], "conflict");
    assert_eq!(child["blockedOn"], json!(["parent"]));
}

#[test]
fn given_self_or_future_evidence_when_ready_then_stays_open() {
    let self_cite = project(&[
        msg(1, "lead", open_owned("alpha", "T", "reviewer", "owner")),
        msg(
            2,
            "owner",
            json!({
                "schema": SCHEMA,
                "task": "alpha",
                "action": "ready",
                "evidence": [2]
            }),
        ),
    ]);
    assert_eq!(task(&self_cite, "alpha")["state"], "open");
    assert_eq!(task(&self_cite, "alpha")["assertedState"], "open");
    assert_eq!(task(&self_cite, "alpha")["evidence"], json!([]));
    assert!(warning_codes(&self_cite).contains(&"malformed-event".into()));

    let future = project(&[
        msg(1, "lead", open_owned("alpha", "T", "reviewer", "owner")),
        msg(
            2,
            "owner",
            json!({
                "schema": SCHEMA,
                "task": "alpha",
                "action": "ready",
                "evidence": [5]
            }),
        ),
    ]);
    assert_eq!(task(&future, "alpha")["state"], "open");
    assert_eq!(task(&future, "alpha")["evidence"], json!([]));
    assert!(!conflicts(&future, "alpha").contains(&"orphan-evidence".into()));
}

#[test]
fn given_diamond_deps_when_all_closed_then_clean() {
    let mut b = open_owned("beta", "B", "reviewer", "owner");
    b["dependsOn"] = json!(["alpha"]);
    let mut c = open_owned("gamma", "C", "reviewer", "owner");
    c["dependsOn"] = json!(["alpha"]);
    let mut d = open_owned("delta", "D", "reviewer", "owner");
    d["dependsOn"] = json!(["beta", "gamma"]);
    let board = project(&[
        msg(1, "lead", open_owned("alpha", "A", "reviewer", "owner")),
        msg(2, "note", json!({"ok": true})),
        msg(3, "lead", b),
        msg(4, "lead", c),
        msg(5, "lead", d),
        msg(
            6,
            "owner",
            json!({ "schema": SCHEMA, "task": "alpha", "action": "ready", "evidence": [2] }),
        ),
        msg(7, "reviewer", event("alpha", "close")),
        msg(
            8,
            "owner",
            json!({ "schema": SCHEMA, "task": "beta", "action": "ready", "evidence": [3] }),
        ),
        msg(9, "reviewer", event("beta", "close")),
        msg(
            10,
            "owner",
            json!({ "schema": SCHEMA, "task": "gamma", "action": "ready", "evidence": [4] }),
        ),
        msg(11, "reviewer", event("gamma", "close")),
        msg(
            12,
            "owner",
            json!({ "schema": SCHEMA, "task": "delta", "action": "ready", "evidence": [5] }),
        ),
        msg(13, "reviewer", event("delta", "close")),
    ]);
    for id in ["alpha", "beta", "gamma", "delta"] {
        let row = task(&board, id);
        assert_eq!(row["state"], "closed", "{id}");
        assert_eq!(row["assertedState"], "closed", "{id}");
        assert!(row["blockedOn"].as_array().unwrap().is_empty(), "{id}");
        assert!(conflicts(&board, id).is_empty(), "{id}");
    }
}
