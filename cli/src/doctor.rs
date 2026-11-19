//! `msn doctor`: read-only setup checks, each problem paired with the exact command that fixes it.
//!
//! Doctor never writes a file, never moves a cursor and only sends GET requests. It resolves the
//! connection exactly like every other command (`profile::prepare`), but reports a broken
//! selection as a finding instead of exiting on it.
use std::io::Write;
use std::path::Path;
use std::process::Command as Process;

use clap::ArgMatches;
use clap::parser::ValueSource;
use serde::Serialize;
use serde_json::{Value, json};
use url::Url;

use crate::args::{Cli, Command};
use crate::client::{MsnClient, error_message};
use crate::config::{DEFAULT_URL, is_slug, parse_origin};
use crate::error::CliError;
use crate::identity::fetch_identity;
use crate::profile;
use crate::runner::{RuntimeHealth, runtime_health};

/// The oldest Node major that `msn run` accepts (scripts/agent-runner.mjs).
const MIN_NODE_MAJOR: u64 = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Warn,
    Fail,
    Skip,
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub check: &'static str,
    pub status: Status,
    pub message: String,
    /// The exact next step. Present for every `fail` and `warn`.
    pub fix: Option<String>,
}

impl Check {
    fn ok(check: &'static str, message: impl Into<String>) -> Self {
        Self::new(check, Status::Ok, message, None)
    }
    fn skip(check: &'static str, message: impl Into<String>) -> Self {
        Self::new(check, Status::Skip, message, None)
    }
    fn fail(check: &'static str, message: impl Into<String>, fix: impl Into<String>) -> Self {
        Self::new(check, Status::Fail, message, Some(fix.into()))
    }
    fn warn(check: &'static str, message: impl Into<String>, fix: impl Into<String>) -> Self {
        Self::new(check, Status::Warn, message, Some(fix.into()))
    }
    fn new(
        check: &'static str,
        status: Status,
        message: impl Into<String>,
        fix: Option<String>,
    ) -> Self {
        Check {
            check,
            status,
            message: message.into(),
            fix,
        }
    }
}

/// Runs every check, prints the report and returns the process exit code: 1 when any check
/// failed, otherwise 0. Warnings never change the exit code.
pub fn run(mut cli: Cli, matches: &ArgMatches) -> i32 {
    let Command::Doctor { channel, json } = &cli.command else {
        unreachable!("doctor::run is only called for msn doctor")
    };
    let (channel, json) = (channel.clone(), *json);
    let checks = collect(&mut cli, matches, channel.as_deref());
    let failed = checks.iter().any(|check| check.status == Status::Fail);
    let mut out = std::io::stdout().lock();
    let _ = if json {
        writeln!(out, "{}", report_json(&checks))
    } else {
        write!(out, "{}", report_text(&checks))
    };
    let _ = out.flush();
    i32::from(failed)
}

pub fn report_json(checks: &[Check]) -> Value {
    let count = |status| checks.iter().filter(|c| c.status == status).count();
    json!({
        "ok": count(Status::Fail) == 0,
        "version": env!("CARGO_PKG_VERSION"),
        "problems": count(Status::Fail),
        "warnings": count(Status::Warn),
        "checks": checks,
    })
}

pub fn report_text(checks: &[Check]) -> String {
    let mut text = format!("msn doctor (msn {})\n\n", env!("CARGO_PKG_VERSION"));
    for check in checks {
        let tag = match check.status {
            Status::Ok => "ok",
            Status::Warn => "warn",
            Status::Fail => "FAIL",
            Status::Skip => "skip",
        };
        text.push_str(&format!(
            "  {tag:<5} {:<10} {}\n",
            check.check, check.message
        ));
        if let Some(fix) = &check.fix {
            text.push_str(&format!("  {:<5} {:<10} fix: {fix}\n", "", ""));
        }
    }
    let problems = checks.iter().filter(|c| c.status == Status::Fail).count();
    let warnings = checks.iter().filter(|c| c.status == Status::Warn).count();
    text.push('\n');
    text.push_str(&match (problems, warnings) {
        (0, 0) => "No problems found.\n".to_string(),
        (0, w) => format!("No problems found; {w} {}.\n", plural(w, "warning")),
        (p, _) => format!(
            "{p} {} found. Run each fix, then run msn doctor again.\n",
            plural(p, "problem")
        ),
    });
    text
}

fn plural(count: usize, word: &str) -> String {
    if count == 1 {
        word.to_string()
    } else {
        format!("{word}s")
    }
}

fn collect(cli: &mut Cli, matches: &ArgMatches, channel: Option<&str>) -> Vec<Check> {
    let mut checks = Vec::new();
    let explicit = match matches.value_source("profile") {
        Some(ValueSource::CommandLine) => Some("--profile"),
        Some(ValueSource::EnvVariable) => Some("MSN_PROFILE"),
        _ => None,
    };
    let env_connection = cli.tenant.is_some() || cli.token.is_some();

    let login = check_login(env_connection);
    let logged_in = login.status == Status::Ok;
    checks.push(login);

    let prepared = profile::prepare(cli, matches);
    let profile = check_profile(cli, prepared, explicit, logged_in);
    let connected = profile.status == Status::Ok;
    checks.push(profile);

    let server = check_server(&cli.url);
    let url = (server.status == Status::Ok)
        .then(|| parse_origin(&cli.url).ok())
        .flatten();
    checks.push(server);

    let identity = match (&url, connected) {
        (Some(url), true) => {
            let (check, identity) = check_workspace(
                url,
                cli.tenant.as_deref().unwrap_or_default(),
                cli.token.as_deref().unwrap_or_default(),
                cli.username.as_deref(),
            );
            checks.push(check);
            identity
        }
        (None, true) => {
            checks.push(Check::skip("workspace", "Needs a reachable server."));
            None
        }
        _ => {
            checks.push(Check::skip("workspace", "Needs an active connection."));
            None
        }
    };

    checks.push(match (&url, &identity) {
        (Some(url), Some(identity)) => check_board(
            url,
            cli.tenant.as_deref().unwrap_or_default(),
            cli.token.as_deref().unwrap_or_default(),
            identity,
            channel,
        ),
        _ => Check::skip("board", "Needs a working workspace connection."),
    });

    checks.push(check_node());
    checks.push(check_runner());
    checks
}

fn check_login(env_connection: bool) -> Check {
    let directory = profile::profile_directory().ok();
    match profile::names() {
        Err(error) => Check::fail(
            "login",
            format!("Cannot read saved profiles: {error}"),
            permission_fix(directory.as_deref(), None, &error),
        ),
        Ok(names) if names.is_empty() && env_connection => Check::ok(
            "login",
            "No saved profiles; using a connection from flags or environment variables.",
        ),
        Ok(names) if names.is_empty() => Check::fail(
            "login",
            "Not logged in: no saved profiles and no MSN_WORKSPACE_TENANT/MSN_WORKSPACE_TOKEN.",
            "Run msn login --create to start your own account, or msn login --connection FILE --save-as NAME with a connection file from the board owner. An agent with an invite paragraph runs its join command instead.",
        ),
        Ok(names) => {
            let shown: Vec<&str> = names.iter().take(5).map(String::as_str).collect();
            let more = if names.len() > shown.len() {
                ", …"
            } else {
                ""
            };
            Check::ok(
                "login",
                format!(
                    "{} saved {}: {}{more}",
                    names.len(),
                    plural(names.len(), "profile"),
                    shown.join(", ")
                ),
            )
        }
    }
}

fn check_profile(
    cli: &Cli,
    prepared: Result<bool, CliError>,
    explicit: Option<&str>,
    logged_in: bool,
) -> Check {
    if let Err(error) = prepared {
        let name = cli.profile.as_deref().unwrap_or("NAME");
        let clear = match explicit {
            Some("MSN_PROFILE") => "run unset MSN_PROFILE",
            Some(_) => "drop --profile",
            None => "pass --profile NAME",
        };
        let fix = match &error {
            CliError::NotFound(_) => format!(
                "Run msn profile list to see saved profiles, then select one with --profile NAME or export MSN_PROFILE=NAME. To use no profile, {clear}."
            ),
            CliError::Usage(message) if message.starts_with("Do not combine --profile") => {
                "Drop --url, --tenant and --token, or drop --profile: a saved profile is a complete connection.".into()
            }
            CliError::Usage(message) if message.starts_with("Profile names use") => {
                "Profile names are 1-64 lowercase letters, digits, _ or -. Run msn profile list to see saved names.".into()
            }
            _ => {
                let path = profile::profile_path(name).ok();
                let directory = profile::profile_directory().ok();
                permission_fix(directory.as_deref(), path.as_deref(), &error)
            }
        };
        let message = error.to_string();
        let message = if message.contains(&format!("\"{name}\"")) {
            message
        } else {
            format!("Cannot use profile \"{name}\": {message}")
        };
        return Check::fail("profile", message, fix);
    }
    if let Some(name) = &cli.profile {
        let source = explicit.unwrap_or("the default after msn login");
        return Check::ok(
            "profile",
            format!(
                "Using profile \"{name}\" ({source}): {} in workspace {} at {}",
                cli.username.as_deref().unwrap_or("(no name)"),
                cli.tenant.as_deref().unwrap_or_default(),
                cli.url
            ),
        );
    }
    match (cli.tenant.as_deref(), cli.token.as_deref()) {
        (Some(tenant), Some(token)) if !tenant.is_empty() && !token.is_empty() => Check::ok(
            "profile",
            format!(
                "No saved profile; using workspace {tenant} at {} from flags or environment variables.",
                cli.url
            ),
        ),
        (None, None) if !logged_in => Check::skip("profile", "Log in first."),
        (None, None) => Check::fail(
            "profile",
            "No profile is selected, and there is no default profile \"account\".",
            "Select a saved profile with --profile NAME or export MSN_PROFILE=NAME (msn profile list shows the names).",
        ),
        (tenant, _) => {
            let missing = if tenant.is_none_or(str::is_empty) {
                "MSN_WORKSPACE_TENANT"
            } else {
                "MSN_WORKSPACE_TOKEN"
            };
            Check::fail(
                "profile",
                format!(
                    "The connection is incomplete: {missing} (or its flag) is missing or empty."
                ),
                "Set both MSN_WORKSPACE_TENANT and MSN_WORKSPACE_TOKEN, or unset both and select a saved profile with --profile NAME.",
            )
        }
    }
}

/// A fix for a profile-store error: the exact chmod when a mode is wrong, else the message.
fn permission_fix(directory: Option<&Path>, file: Option<&Path>, error: &CliError) -> String {
    let message = error.to_string();
    if message.contains("profiles directory permissions")
        && let Some(directory) = directory
    {
        return format!("Run chmod 700 '{}'.", directory.display());
    }
    if message.contains("profile file permissions") {
        if let Some(file) = file.filter(|file| file.exists()) {
            return format!("Run chmod 600 '{}'.", file.display());
        }
        if let Some(directory) = directory {
            return format!(
                "Run chmod 600 '{}'/*.json so only you can read saved keys.",
                directory.display()
            );
        }
    }
    if message.contains("not valid JSON") {
        return "Save the connection again with msn login --connection FILE --save-as NAME under a new name.".into();
    }
    if message.contains("must be a real directory") || message.contains("regular file") {
        return "Replace the symlink with a real file or directory under ~/.config/msn/profiles; msn never follows symlinks for keys.".into();
    }
    format!("Repair the profile store, then run msn doctor again ({message}).")
}

fn check_server(raw: &str) -> Check {
    let url = match parse_origin(raw) {
        Ok(url) => url,
        Err(error) => {
            return Check::fail(
                "server",
                format!("Server address {raw} is not usable: {error}"),
                format!(
                    "Run unset MSN_URL to use {DEFAULT_URL}, or set MSN_URL to a bare origin such as {DEFAULT_URL}."
                ),
            );
        }
    };
    let fix = format!(
        "Check your network, and that {raw} is the MSN server (set by MSN_URL, --url or the profile). msn does not use HTTP proxies."
    );
    match MsnClient::new(&url).and_then(|client| client.get("/api/health", None)) {
        Ok(response) if (200..300).contains(&response.status) => {
            Check::ok("server", format!("{raw} is reachable."))
        }
        Ok(response) => Check::fail(
            "server",
            format!(
                "{raw} answered /api/health with {}; it may not be an MSN server.",
                error_message(response.status, &response.body)
            ),
            fix,
        ),
        Err(error) => Check::fail("server", format!("Cannot reach {raw}: {error}"), fix),
    }
}

fn check_workspace(
    url: &Url,
    tenant: &str,
    token: &str,
    username: Option<&str>,
) -> (Check, Option<Value>) {
    match fetch_identity(url, tenant, token) {
        Ok(identity) => {
            let name = identity["username"]
                .as_str()
                .or(username)
                .map(|name| format!(" as {name}"))
                .unwrap_or_default();
            let mut message = format!("Workspace {tenant} accepts this key{name}");
            if identity["owner"] == true {
                message.push_str(" (owner)");
            }
            if let Some(channel) = identity["channel"].as_str() {
                message.push_str(&format!("; it opens only board {channel}"));
            }
            message.push('.');
            (Check::ok("workspace", message), Some(identity))
        }
        Err(CliError::Auth(message)) => (
            Check::fail(
                "workspace",
                format!("The server rejected this access key for workspace {tenant} ({message})."),
                "The key was revoked or rotated. Ask the board owner for a fresh connection (msn invite BOARD --for-agent --name NAME, or msn connection-export --out FILE), then save it with msn login --connection FILE --save-as NAME.",
            ),
            None,
        ),
        Err(CliError::NotFound(_)) => (
            Check::fail(
                "workspace",
                format!(
                    "Workspace {tenant} does not exist on {}.",
                    url.origin().ascii_serialization()
                ),
                "Check that the profile or MSN_URL points at the right server. To start your own workspace, run msn login --create.",
            ),
            None,
        ),
        Err(error) => (
            Check::fail(
                "workspace",
                format!("Cannot check workspace {tenant}: {error}"),
                "Run msn doctor again in a minute. If it keeps failing, run msn health and check MSN_URL.",
            ),
            None,
        ),
    }
}

fn check_board(
    url: &Url,
    tenant: &str,
    token: &str,
    identity: &Value,
    channel: Option<&str>,
) -> Check {
    let scope = identity["channel"].as_str();
    let Some(channel) = channel.or(scope) else {
        return Check::skip(
            "board",
            "This key opens the whole workspace. Pass a board to check it: msn doctor BOARD.",
        );
    };
    if !is_slug(channel) {
        return Check::fail(
            "board",
            format!("\"{channel}\" is not a valid board name."),
            "Board names are 1-64 lowercase letters, digits, _ or -. Run msn channels to list them.",
        );
    }
    if let Some(scope) = scope.filter(|scope| *scope != channel) {
        return Check::fail(
            "board",
            format!("This key opens only board {scope}, not {channel}."),
            format!(
                "Run msn doctor {scope}, or select the profile saved for {channel} (msn profile list shows them)."
            ),
        );
    }
    let client = match MsnClient::new(url) {
        Ok(client) => client,
        Err(error) => return Check::fail("board", error.to_string(), "Run msn doctor again."),
    };
    let base = format!("/api/tenants/{tenant}/channels/{channel}");
    let response = match client.get(&format!("{base}/board"), Some(token)) {
        Ok(response) => response,
        Err(error) => {
            return Check::fail(
                "board",
                format!("Cannot reach board {channel}: {error}"),
                "Check your network and run msn doctor again.",
            );
        }
    };
    let body: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
    match response.status {
        200..=299 => {
            let status = body["board"]["status"].as_str().unwrap_or("unknown");
            let goal = if body["board"]["goal"]
                .as_str()
                .is_some_and(|goal| !goal.trim().is_empty())
            {
                "has a goal"
            } else {
                "has no goal yet"
            };
            Check::ok(
                "board",
                format!("Board {channel} is reachable (status {status}; {goal})."),
            )
        }
        404 if body["error"]["code"] == "board_not_found" => {
            // A plain channel works with peek/commit/send but has no board goal or personas.
            match client.get(&format!("{base}/messages?limit=1"), Some(token)) {
                Ok(probe) if (200..300).contains(&probe.status) => Check::warn(
                    "board",
                    format!(
                        "{channel} is a plain channel, not a message board: it has no goal or personas."
                    ),
                    format!(
                        "Nothing to fix to read and send. To make it a board, its owner runs msn board create {channel} --goal 'GOAL' --save-as {channel}-lead."
                    ),
                ),
                _ => Check::fail(
                    "board",
                    format!("Workspace {tenant} has no board or channel named {channel}."),
                    format!(
                        "Check the name with msn channels. To create it, run msn board create {channel} --goal 'GOAL' --save-as {channel}-lead."
                    ),
                ),
            }
        }
        401 | 403 => Check::fail(
            "board",
            format!(
                "This key cannot open board {channel} ({}).",
                error_message(response.status, &response.body)
            ),
            format!(
                "Select the profile saved for {channel} (msn profile list), or ask its owner for an invite: msn invite {channel} --for-agent --name NAME."
            ),
        ),
        status => Check::fail(
            "board",
            format!(
                "Board {channel} answered {}.",
                error_message(status, &response.body)
            ),
            "Run msn doctor again in a minute.",
        ),
    }
}

fn check_node() -> Check {
    let fix = format!(
        "Install Node {MIN_NODE_MAJOR} or newer from https://nodejs.org and put it on PATH. Only msn run needs Node; peek, commit, send and mcp do not."
    );
    let output = match Process::new("node").arg("--version").output() {
        Ok(output) if output.status.success() => output,
        Ok(_) | Err(_) => {
            return Check::warn("node", "Node is not on PATH.", fix);
        }
    };
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    match parse_node_major(&version) {
        Some(major) if major >= MIN_NODE_MAJOR => Check::ok("node", format!("Node {version}.")),
        Some(_) => Check::warn(
            "node",
            format!("Node {version} is too old for msn run (needs {MIN_NODE_MAJOR}+)."),
            fix,
        ),
        None => Check::warn(
            "node",
            format!("Cannot read the Node version from \"{version}\"."),
            fix,
        ),
    }
}

pub fn parse_node_major(version: &str) -> Option<u64> {
    version
        .trim()
        .strip_prefix('v')?
        .split('.')
        .next()?
        .parse()
        .ok()
}

fn check_runner() -> Check {
    match runtime_health() {
        RuntimeHealth::Custom(path) => Check::ok(
            "runner",
            format!(
                "MSN_AGENT_RUNNER runtime is complete at {}.",
                path.display()
            ),
        ),
        RuntimeHealth::Unpacked(path) => Check::ok(
            "runner",
            format!(
                "Listener runtime at {} matches this msn. See a listener with msn run BOARD --status.",
                path.display()
            ),
        ),
        RuntimeHealth::NotUnpacked(path) => Check::ok(
            "runner",
            format!(
                "Listener runtime is bundled; the first msn run unpacks it to {}.",
                path.display()
            ),
        ),
        RuntimeHealth::Broken { problem, fix } => Check::fail("runner", problem, fix),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_major_parses_release_strings_only() {
        assert_eq!(parse_node_major("v24.11.1\n"), Some(24));
        assert_eq!(parse_node_major("v8.0.0"), Some(8));
        assert_eq!(parse_node_major("24.1.0"), None);
        assert_eq!(parse_node_major("vx"), None);
    }

    #[test]
    fn text_report_prints_a_fix_under_each_problem_and_a_summary() {
        let checks = vec![
            Check::ok("login", "1 saved profile: account"),
            Check::fail("workspace", "rejected", "msn login --connection FILE"),
            Check::warn("node", "old", "install Node 24"),
            Check::skip("board", "Needs a working workspace connection."),
        ];
        let text = report_text(&checks);
        assert!(text.contains("  FAIL  workspace  rejected\n"), "{text}");
        assert!(
            text.contains("fix: msn login --connection FILE\n"),
            "{text}"
        );
        assert!(text.contains("fix: install Node 24\n"), "{text}");
        assert!(text.ends_with("1 problem found. Run each fix, then run msn doctor again.\n"));
        let report = report_json(&checks);
        assert_eq!(report["ok"], false);
        assert_eq!(report["problems"], 1);
        assert_eq!(report["warnings"], 1);
        assert_eq!(report["checks"][1]["status"], "fail");
        assert_eq!(report["checks"][0]["fix"], Value::Null);
    }

    #[test]
    fn clean_report_says_so() {
        let text = report_text(&[Check::ok("login", "x"), Check::warn("node", "y", "z")]);
        assert!(text.ends_with("No problems found; 1 warning.\n"), "{text}");
        assert!(report_text(&[Check::ok("login", "x")]).ends_with("No problems found.\n"));
    }
}
