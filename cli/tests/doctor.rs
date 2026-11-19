//! `msn doctor`: read-only setup checks with an exact fix per problem, --json and exit codes.
#[allow(dead_code)]
mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use common::{MockServer, Scripted};
use serde_json::Value;

static SEQ: AtomicU64 = AtomicU64::new(0);

struct Env {
    home: PathBuf,
    bin_dir: PathBuf,
}

impl Env {
    /// A private HOME and a PATH holding only a fake `node` that prints `node_version`.
    fn new(node_version: Option<&str>) -> Self {
        let home = std::env::temp_dir().join(format!(
            "msn-doctor-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        let bin_dir = home.join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        if let Some(version) = node_version {
            let node = bin_dir.join("node");
            fs::write(&node, format!("#!/bin/sh\necho {version}\n")).unwrap();
            set_mode(&node, 0o755);
        }
        Env { home, bin_dir }
    }

    fn config(&self) -> PathBuf {
        self.home.join("config")
    }

    fn save_profile(&self, name: &str, url: &str) {
        let directory = self.config().join("msn/profiles");
        fs::create_dir_all(&directory).unwrap();
        set_mode(&directory, 0o700);
        let path = directory.join(format!("{name}.json"));
        fs::write(
            &path,
            format!(
                r#"{{"url":"{url}","tenant":"team","token":"profile-secret","username":"planner","reader":"planner"}}"#
            ),
        )
        .unwrap();
        set_mode(&path, 0o600);
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_msn"));
        cmd.env_clear()
            .env("HOME", &self.home)
            .env("XDG_CONFIG_HOME", self.config())
            .env("XDG_STATE_HOME", self.home.join("state"))
            .env("PATH", &self.bin_dir)
            .args(args)
            .stdin(Stdio::null());
        cmd
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().expect("run msn")
    }
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn report(out: &Output) -> Value {
    serde_json::from_slice(&out.stdout).unwrap_or_else(|_| {
        panic!(
            "stdout is not JSON: {}\nstderr: {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
    })
}

fn check<'a>(report: &'a Value, id: &str) -> &'a Value {
    report["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["check"] == id)
        .unwrap_or_else(|| panic!("no {id} check in {report}"))
}

fn ok_identity(channel: Option<&str>) -> Scripted {
    let scope = channel
        .map(|c| format!(r#","channel":"{c}","sharedChannel":true"#))
        .unwrap_or_default();
    Scripted::json(
        200,
        &format!(r#"{{"tenant":"team","username":"planner","usernamePrefix":null{scope}}}"#),
    )
}

fn ok_board() -> Scripted {
    Scripted::json(
        200,
        r#"{"board":{"channel":"general","goal":"Ship it","status":"active","revision":1}}"#,
    )
}

fn env_connection<'a>(url: &'a str, extra: &[&'a str]) -> Vec<&'a str> {
    let mut args = vec![
        "--url",
        url,
        "--tenant",
        "team",
        "--token",
        "tenant-secret",
        "doctor",
    ];
    args.extend_from_slice(extra);
    args
}

#[test]
fn healthy_setup_passes_every_check_with_get_requests_only() {
    let env = Env::new(Some("v24.11.0"));
    let server = MockServer::spawn(vec![
        Scripted::json(200, r#"{"ok":true}"#),
        ok_identity(Some("general")),
        ok_board(),
    ]);
    let url = server.url();
    let out = env.run(&env_connection(&url, &["--json"]));
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let report = report(&out);
    assert_eq!(report["ok"], true);
    assert_eq!(report["problems"], 0);
    for id in [
        "login",
        "profile",
        "server",
        "workspace",
        "board",
        "node",
        "runner",
    ] {
        assert_eq!(check(&report, id)["status"], "ok", "{id}: {report}");
    }
    assert!(
        check(&report, "board")["message"]
            .as_str()
            .unwrap()
            .contains("Board general is reachable")
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        !stdout.contains("tenant-secret"),
        "doctor must never print a key"
    );
    let requests = server.recorded();
    let paths: Vec<_> = requests
        .iter()
        .map(|r| (r.method.as_str(), r.path.as_str()))
        .collect();
    assert_eq!(
        paths,
        [
            ("GET", "/api/health"),
            ("GET", "/api/tenants/team"),
            ("GET", "/api/tenants/team/channels/general/board"),
        ]
    );
    assert_eq!(
        requests[1].headers.get("authorization").map(String::as_str),
        Some("Bearer tenant-secret")
    );
    // Read-only: no profile directory, cursor state or runtime cache was created.
    assert!(!env.config().exists());
    assert!(!env.home.join("state").exists());
}

#[test]
fn not_logged_in_fails_with_the_login_fix_and_writes_nothing() {
    let env = Env::new(Some("v24.0.0"));
    let server = MockServer::spawn(vec![Scripted::json(200, r#"{"ok":true}"#)]);
    let out = env.run(&["--url", &server.url(), "doctor", "--json"]);
    assert_eq!(out.status.code(), Some(1));
    let report = report(&out);
    assert_eq!(report["ok"], false);
    let login = check(&report, "login");
    assert_eq!(login["status"], "fail");
    assert!(
        login["fix"]
            .as_str()
            .unwrap()
            .contains("msn login --create")
    );
    assert_eq!(check(&report, "profile")["status"], "skip");
    assert_eq!(check(&report, "workspace")["status"], "skip");
    assert!(!env.config().exists());
}

#[test]
fn missing_selected_profile_is_a_finding_not_a_crash() {
    let env = Env::new(Some("v24.0.0"));
    let server = MockServer::spawn(vec![Scripted::json(200, r#"{"ok":true}"#)]);
    env.save_profile("account", &server.url());
    let out = env
        .command(&["doctor", "--json"])
        .env("MSN_PROFILE", "nope")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let report = report(&out);
    assert_eq!(check(&report, "login")["status"], "ok");
    let profile = check(&report, "profile");
    assert_eq!(profile["status"], "fail");
    assert!(
        profile["message"]
            .as_str()
            .unwrap()
            .contains("\"nope\" does not exist")
    );
    let fix = profile["fix"].as_str().unwrap();
    assert!(
        fix.contains("msn profile list") && fix.contains("unset MSN_PROFILE"),
        "{fix}"
    );
}

#[test]
fn default_account_profile_is_used_and_named() {
    let env = Env::new(Some("v24.0.0"));
    let server = MockServer::spawn(vec![
        Scripted::json(200, r#"{"ok":true}"#),
        ok_identity(None),
    ]);
    env.save_profile("account", &server.url());
    let out = env.run(&["doctor", "--json"]);
    assert_eq!(out.status.code(), Some(0));
    let report = report(&out);
    let profile = check(&report, "profile")["message"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        profile.contains("\"account\" (the default after msn login)"),
        "{profile}"
    );
    // An unscoped key with no BOARD argument has nothing to check.
    let board = check(&report, "board");
    assert_eq!(board["status"], "skip");
    assert!(
        board["message"]
            .as_str()
            .unwrap()
            .contains("msn doctor BOARD")
    );
    assert_eq!(
        server.recorded()[1]
            .headers
            .get("authorization")
            .map(String::as_str),
        Some("Bearer profile-secret")
    );
}

#[test]
fn unsafe_profile_permissions_get_the_exact_chmod() {
    let env = Env::new(Some("v24.0.0"));
    env.save_profile("account", "http://127.0.0.1:9");
    let path = env.config().join("msn/profiles/account.json");
    set_mode(&path, 0o644);
    let out = env.run(&["doctor", "--json"]);
    assert_eq!(out.status.code(), Some(1));
    let report = report(&out);
    let login = check(&report, "login");
    assert_eq!(login["status"], "fail");
    assert!(
        login["fix"].as_str().unwrap().contains("chmod 600"),
        "{login}"
    );
}

#[test]
fn rejected_key_fails_workspace_and_skips_board() {
    let env = Env::new(Some("v24.0.0"));
    let server = MockServer::spawn(vec![
        Scripted::json(200, r#"{"ok":true}"#),
        Scripted::json(
            401,
            r#"{"error":{"code":"unauthorized","message":"Invalid token"}}"#,
        ),
    ]);
    let url = server.url();
    let out = env.run(&env_connection(&url, &["general", "--json"]));
    assert_eq!(out.status.code(), Some(1));
    let report = report(&out);
    let workspace = check(&report, "workspace");
    assert_eq!(workspace["status"], "fail");
    assert!(workspace["message"].as_str().unwrap().contains("rejected"));
    assert!(
        workspace["fix"]
            .as_str()
            .unwrap()
            .contains("msn login --connection FILE")
    );
    assert_eq!(check(&report, "board")["status"], "skip");
}

#[test]
fn missing_board_fails_with_the_create_command() {
    let env = Env::new(Some("v24.0.0"));
    let server = MockServer::spawn(vec![
        Scripted::json(200, r#"{"ok":true}"#),
        ok_identity(None),
        Scripted::json(
            404,
            r#"{"error":{"code":"board_not_found","message":"Create this message board first."}}"#,
        ),
        Scripted::json(
            404,
            r#"{"error":{"code":"channel_not_found","message":"Channel not found."}}"#,
        ),
    ]);
    let url = server.url();
    let out = env.run(&env_connection(&url, &["planning", "--json"]));
    assert_eq!(out.status.code(), Some(1));
    let board = check(&report(&out), "board").clone();
    assert_eq!(board["status"], "fail");
    assert!(
        board["fix"]
            .as_str()
            .unwrap()
            .contains("msn board create planning --goal")
    );
    let recorded = server.recorded();
    assert_eq!(recorded[3].method, "GET");
    assert_eq!(
        recorded[3].path,
        "/api/tenants/team/channels/planning/messages?limit=1"
    );
}

#[test]
fn plain_channel_is_a_warning_not_a_failure() {
    let env = Env::new(Some("v24.0.0"));
    let server = MockServer::spawn(vec![
        Scripted::json(200, r#"{"ok":true}"#),
        ok_identity(None),
        Scripted::json(
            404,
            r#"{"error":{"code":"board_not_found","message":"Create this message board first."}}"#,
        ),
        Scripted::json(200, r#"{"messages":[],"nextCursor":"0"}"#),
    ]);
    let url = server.url();
    let out = env.run(&env_connection(&url, &["general", "--json"]));
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(check(&report(&out), "board")["status"], "warn");
}

#[test]
fn scoped_key_names_its_own_board_when_asked_about_another() {
    let env = Env::new(Some("v24.0.0"));
    let server = MockServer::spawn(vec![
        Scripted::json(200, r#"{"ok":true}"#),
        ok_identity(Some("general")),
    ]);
    let url = server.url();
    let out = env.run(&env_connection(&url, &["other", "--json"]));
    assert_eq!(out.status.code(), Some(1));
    let board = check(&report(&out), "board").clone();
    assert_eq!(board["status"], "fail");
    assert!(
        board["fix"]
            .as_str()
            .unwrap()
            .contains("msn doctor general")
    );
    assert_eq!(
        server.recorded().len(),
        2,
        "no board request for a board the key cannot open"
    );
}

#[test]
fn unreachable_server_fails_and_skips_what_depends_on_it() {
    let env = Env::new(Some("v24.0.0"));
    // Port 9 (discard) is closed on test machines: the connection is refused.
    let out = env.run(&env_connection("http://127.0.0.1:9", &["--json"]));
    assert_eq!(out.status.code(), Some(1));
    let report = report(&out);
    let server = check(&report, "server");
    assert_eq!(server["status"], "fail");
    assert!(server["fix"].as_str().unwrap().contains("MSN_URL"));
    assert_eq!(check(&report, "workspace")["status"], "skip");
    assert_eq!(check(&report, "board")["status"], "skip");
}

#[test]
fn old_or_missing_node_warns_without_failing() {
    for version in [Some("v22.3.0"), None] {
        let env = Env::new(version);
        let server = MockServer::spawn(vec![
            Scripted::json(200, r#"{"ok":true}"#),
            ok_identity(Some("general")),
            ok_board(),
        ]);
        let url = server.url();
        let out = env.run(&env_connection(&url, &["--json"]));
        assert_eq!(out.status.code(), Some(0), "{version:?}");
        let report = report(&out);
        let node = check(&report, "node");
        assert_eq!(node["status"], "warn", "{version:?}");
        assert!(node["fix"].as_str().unwrap().contains("Node 24"));
        assert_eq!(report["warnings"], 1);
    }
}

#[test]
fn broken_custom_runner_fails_with_the_fix() {
    let env = Env::new(Some("v24.0.0"));
    let out = env
        .command(&env_connection("http://127.0.0.1:9", &["--json"]))
        .env("MSN_AGENT_RUNNER", env.home.join("missing.mjs"))
        .output()
        .unwrap();
    let report = report(&out);
    let runner = check(&report, "runner");
    assert_eq!(runner["status"], "fail");
    assert!(
        runner["fix"]
            .as_str()
            .unwrap()
            .contains("unset MSN_AGENT_RUNNER")
    );
}

#[test]
fn text_report_lists_each_check_and_its_fix() {
    let env = Env::new(Some("v22.3.0"));
    let out = env.run(&["--url", "http://127.0.0.1:9", "doctor"]);
    assert_eq!(out.status.code(), Some(1));
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.starts_with("msn doctor (msn "), "{text}");
    assert!(text.contains("  FAIL  login      Not logged in"), "{text}");
    assert!(text.contains("fix: Run msn login --create"), "{text}");
    assert!(
        text.contains("  warn  node       Node v22.3.0 is too old"),
        "{text}"
    );
    assert!(text.contains("problems found. Run each fix"), "{text}");
    assert!(out.stderr.is_empty());
}
