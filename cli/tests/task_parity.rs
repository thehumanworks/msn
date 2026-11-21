//! Parity corpus for the web copy of the reducer (ADR 0067).
//!
//! `tests/fixtures/task-projection.json` holds message logs and the board this reducer projects
//! from each. The web app's `public/tasks.js` is tested against the same file
//! (`tests/tasks-web.test.mjs`). When this test fails, the reducer's output changed: update
//! `public/tasks.js` to match, then regenerate the expected boards with
//! `MSN_TASK_FIXTURES_WRITE=1 cargo test --test task_parity`.
use std::path::PathBuf;

use msn_cli::tasks;
use serde_json::Value;

fn corpus_path() -> PathBuf {
    std::env::var_os("MSN_TASK_FIXTURES")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/task-projection.json")
        })
}

#[test]
fn given_parity_corpus_when_projected_then_matches_expected_boards() {
    let path = corpus_path();
    let text = std::fs::read_to_string(&path).expect("read the task parity corpus");
    let mut corpus: Value = serde_json::from_str(&text).expect("corpus is JSON");
    let write = std::env::var_os("MSN_TASK_FIXTURES_WRITE").is_some();
    let cases = corpus["cases"].as_array_mut().expect("corpus has cases");
    assert!(!cases.is_empty(), "the corpus must not be empty");
    let mut failures = Vec::new();
    for case in cases.iter_mut() {
        let messages = case["messages"]
            .as_array()
            .expect("case has messages")
            .clone();
        let board = tasks::project(&messages);
        if write {
            case["expected"] = board;
        } else if case["expected"] != board {
            failures.push(case["name"].as_str().unwrap_or("?").to_string());
        }
    }
    if write {
        // One case per line, like tests/task-fixtures.mjs writes it.
        let lines: Vec<String> = corpus["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .map(|case| serde_json::to_string(case).expect("serialize case"))
            .collect();
        let out = format!(
            "{{\"seed\":{},\"cases\":[\n{}\n]}}\n",
            corpus["seed"],
            lines.join(",\n")
        );
        std::fs::write(&path, out).expect("write the task parity corpus");
        return;
    }
    assert!(
        failures.is_empty(),
        "{} case(s) differ from the reducer, first: {:?}. Update public/tasks.js, then \
         regenerate with MSN_TASK_FIXTURES_WRITE=1.",
        failures.len(),
        failures.first()
    );
}

#[test]
fn given_parity_corpus_then_it_covers_every_state_and_conflict() {
    let text = std::fs::read_to_string(corpus_path()).expect("read the task parity corpus");
    let corpus: Value = serde_json::from_str(&text).expect("corpus is JSON");
    let mut seen = std::collections::BTreeSet::new();
    for case in corpus["cases"].as_array().expect("cases") {
        let board = tasks::project(case["messages"].as_array().expect("messages"));
        for task in board["tasks"].as_array().expect("tasks") {
            seen.insert(format!("state:{}", task["state"].as_str().unwrap_or("")));
            for code in task["conflicts"].as_array().expect("conflicts") {
                seen.insert(format!("conflict:{}", code.as_str().unwrap_or("")));
            }
        }
        for warning in board["warnings"].as_array().expect("warnings") {
            seen.insert(format!(
                "warning:{}",
                warning["code"].as_str().unwrap_or("")
            ));
        }
    }
    for needed in [
        "state:open",
        "state:ready",
        "state:blocked",
        "state:closed",
        "state:cancelled",
        "state:conflict",
        "state:unknown",
        "conflict:duplicate-open",
        "conflict:claim-conflict",
        "conflict:dependency-cycle",
        "conflict:dependency-missing",
        "conflict:unsatisfied-dependencies",
        "conflict:orphan-evidence",
        "warning:deleted-or-redacted",
        "warning:malformed-event",
        "warning:unknown-schema",
        "warning:unknown-task",
        "warning:unauthorized",
        "warning:invalid-transition",
        "warning:unknown-evidence",
        "warning:duplicate-open",
    ] {
        assert!(
            seen.contains(needed),
            "the parity corpus never reaches {needed}"
        );
    }
}
