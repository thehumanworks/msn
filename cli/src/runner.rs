//! Thin process bridge: persistence and supervision belong to the existing Node host.
use crate::{
    args::{Cli, Command},
    config,
    error::CliError,
};
use std::path::PathBuf;
use std::process::Command as Process;

fn runtime_path() -> Result<PathBuf, CliError> {
    if let Some(path) = std::env::var_os("MSN_AGENT_RUNNER") {
        return custom_runtime(PathBuf::from(path));
    }
    materialize_runtime(&config_base()?)
}

/// `MSN_AGENT_RUNNER`: a trusted, complete runtime tree outside the bundled cache.
fn custom_runtime(path: PathBuf) -> Result<PathBuf, CliError> {
    let path = path.canonicalize().ok().filter(|p| p.is_file()).ok_or_else(|| CliError::usage(
        "MSN_AGENT_RUNNER is missing; point it at scripts/agent-runner.mjs from a complete MSN checkout."))?;
    if !RUNTIME
        .iter()
        .all(|(name, _)| path.parent().unwrap().join(name).is_file())
    {
        return Err(CliError::usage(
            "MSN_AGENT_RUNNER runtime is incomplete. Keep the complete scripts/host tree, host-runner.mjs, event-runner.mjs, and onboarding-check.mjs beside agent-runner.mjs.",
        ));
    }
    Ok(path)
}

fn config_base() -> Result<PathBuf, CliError> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .ok_or_else(|| {
            CliError::usage("Set HOME or XDG_CONFIG_HOME for the bundled listener runtime.")
        })?;
    if !base.is_absolute() {
        return Err(CliError::usage("HOME/XDG_CONFIG_HOME must be absolute."));
    }
    Ok(base)
}

/// The content-addressed cache directory this binary unpacks its listener runtime into.
fn runtime_root(base: &std::path::Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for (name, bytes) in RUNTIME {
        hash.update(name.as_bytes());
        hash.update(bytes);
    }
    base.join("msn/runners")
        .join(format!("runtime-{:x}", hash.finalize()))
}

/// What `msn doctor` reports about the listener runtime.
#[derive(Debug)]
pub(crate) enum RuntimeHealth {
    /// `MSN_AGENT_RUNNER` points at a complete runtime.
    Custom(PathBuf),
    /// The bundled runtime is unpacked and matches this binary. `missing` files are still to
    /// be unpacked (an interrupted first run); the next `msn run` adds them.
    Unpacked { root: PathBuf, missing: usize },
    /// Nothing unpacked yet; the first `msn run` does it.
    NotUnpacked(PathBuf),
    /// `msn run` would refuse to start. `fix` is the exact repair.
    Broken { problem: String, fix: String },
}

/// Read-only twin of `runtime_path`: it never creates, repairs or removes a file.
pub(crate) fn runtime_health() -> RuntimeHealth {
    if let Some(path) = std::env::var_os("MSN_AGENT_RUNNER") {
        return match custom_runtime(PathBuf::from(&path)) {
            Ok(path) => RuntimeHealth::Custom(path),
            Err(error) => RuntimeHealth::Broken {
                problem: error.to_string(),
                fix: "Point MSN_AGENT_RUNNER at scripts/agent-runner.mjs in a complete MSN checkout, or run unset MSN_AGENT_RUNNER to use the runtime bundled in msn.".into(),
            },
        };
    }
    let base = match config_base() {
        Ok(base) => base,
        Err(error) => {
            return RuntimeHealth::Broken {
                problem: error.to_string(),
                fix: "Set HOME (or XDG_CONFIG_HOME) to an absolute directory, for example export HOME=/home/you.".into(),
            };
        }
    };
    let root = runtime_root(&base);
    if std::fs::symlink_metadata(&root).is_err() {
        return RuntimeHealth::NotUnpacked(root);
    }
    let broken = |problem: String| RuntimeHealth::Broken {
        problem,
        fix: format!(
            "Remove the runtime cache with rm -rf '{}'. The next msn run unpacks it again.",
            root.display()
        ),
    };
    for directory in [root.clone(), root.join("host")] {
        let Ok(metadata) = std::fs::symlink_metadata(&directory) else {
            continue;
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return broken("Bundled runtime directory must not be a symlink.".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return broken("Bundled runtime directory must be private (0700).".into());
            }
        }
    }
    let mut missing = 0;
    for (name, bytes) in RUNTIME {
        let path = root.join(name);
        if std::fs::symlink_metadata(&path).is_err() {
            missing += 1;
            continue;
        }
        if let Err(error) = verify_runtime_file(&path, bytes) {
            return broken(error.to_string());
        }
    }
    RuntimeHealth::Unpacked { root, missing }
}

const RUNTIME: &[(&str, &[u8])] = &[
    (
        "agent-runner.mjs",
        include_bytes!("../../scripts/agent-runner.mjs"),
    ),
    (
        "host-runner.mjs",
        include_bytes!("../../scripts/host-runner.mjs"),
    ),
    (
        "event-runner.mjs",
        include_bytes!("../../scripts/event-runner.mjs"),
    ),
    (
        "onboarding-check.mjs",
        include_bytes!("../../scripts/onboarding-check.mjs"),
    ),
    (
        "host/process.mjs",
        include_bytes!("../../scripts/host/process.mjs"),
    ),
    (
        "host/prompt-adapter.mjs",
        include_bytes!("../../scripts/host/prompt-adapter.mjs"),
    ),
    (
        "host/protocol.mjs",
        include_bytes!("../../scripts/host/protocol.mjs"),
    ),
    (
        "host/runtime.mjs",
        include_bytes!("../../scripts/host/runtime.mjs"),
    ),
    (
        "host/server-commits.mjs",
        include_bytes!("../../scripts/host/server-commits.mjs"),
    ),
    (
        "host/store.mjs",
        include_bytes!("../../scripts/host/store.mjs"),
    ),
    (
        "host/transport.mjs",
        include_bytes!("../../scripts/host/transport.mjs"),
    ),
    (
        "host/turn-worker.mjs",
        include_bytes!("../../scripts/host/turn-worker.mjs"),
    ),
];

fn materialize_runtime(base: &std::path::Path) -> Result<PathBuf, CliError> {
    use std::io::Write;
    let root = runtime_root(base);
    for directory in [root.clone(), root.join("host")] {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory)?;
        let metadata = std::fs::symlink_metadata(&directory)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(CliError::usage(
                "Bundled runtime directory must not be a symlink.",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(CliError::usage(
                    "Bundled runtime directory must be private (0700).",
                ));
            }
        }
    }
    for (name, bytes) in RUNTIME {
        let path = root.join(name);
        if std::fs::symlink_metadata(&path).is_ok() {
            verify_runtime_file(&path, bytes)?;
            continue;
        }
        // Publish complete bytes without overwriting a winner from a concurrent first run.
        let temporary = root.join(format!(".runtime-{}.tmp", uuid::Uuid::new_v4()));
        let outcome = (|| -> Result<(), CliError> {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            match std::fs::hard_link(&temporary, &path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    verify_runtime_file(&path, bytes)
                }
                Err(error) => Err(error.into()),
            }
        })();
        let _ = std::fs::remove_file(&temporary);
        outcome?;
    }
    Ok(root.join("agent-runner.mjs"))
}

fn verify_runtime_file(path: &std::path::Path, bytes: &[u8]) -> Result<(), CliError> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || std::fs::read(path)? != bytes {
        return Err(CliError::usage(
            "Bundled runtime cache differs from this binary. Remove only its runtime cache directory and retry, or set MSN_AGENT_RUNNER to a trusted complete runtime.",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(CliError::usage(
                "Bundled runtime files must be private (0600).",
            ));
        }
    }
    Ok(())
}

pub fn execute(cli: &Cli) -> Result<(), CliError> {
    let Command::Run {
        channel,
        state_dir,
        status,
        install_service,
        harness,
        prompt,
        local,
        command,
    } = &cli.command
    else {
        unreachable!()
    };
    config::slug(channel)?;
    let runtime = runtime_path()?;
    let mut child = Process::new("node");
    child.arg(runtime).arg(channel);
    if let Some(state_dir) = state_dir {
        child.args(["--state-dir", state_dir]);
    }
    if *status {
        child.arg("--status");
    }
    if *install_service {
        child.arg("--install-service");
    }
    if let Some(harness) = harness {
        child.args(["--harness", harness]);
    }
    if *prompt {
        child.arg("--prompt");
    }
    if *local {
        child.arg("--local");
    }
    if !command.is_empty() {
        child.arg("--").args(command);
    }
    // Connection secrets cross only the environment, never argv or persisted configuration.
    child.env(
        "MSN_URL",
        config::origin_base(&config::parse_origin(&cli.url)?),
    );
    for (key, value) in [
        ("MSN_PROFILE", &cli.profile),
        ("MSN_WORKSPACE_TENANT", &cli.tenant),
        ("MSN_WORKSPACE_TOKEN", &cli.token),
        ("MSN_USERNAME", &cli.username),
        ("MSN_READER", &cli.reader),
    ] {
        if let Some(value) = value {
            child.env(key, value);
        } else {
            child.env_remove(key);
        }
    }
    child.env_remove("MSN_ADMIN_TOKEN");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let _error = child.exec();
        Err(CliError::usage(
            "Cannot launch Node. Install Node 24+ on PATH and the complete MSN runtime scripts.",
        ))
    }
    #[cfg(not(unix))]
    {
        Err(CliError::usage(
            "Persistent listeners require Linux or macOS; systemd user services require Linux.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    #[test]
    fn bundled_runtime_is_source_independent_and_verified() {
        let base = std::env::temp_dir().join(format!("msn-runtime-{}", uuid::Uuid::new_v4()));
        let path = materialize_runtime(&base).unwrap();
        assert!(path.is_file());
        let output = Process::new("node")
            .arg(&path)
            .args(["work", "--status"])
            .env_clear()
            // Keep only PATH so `node` resolves the same way it does for
            // `msn run`; no other caller state may leak into the runtime.
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("XDG_CONFIG_HOME", &base)
            .output()
            .expect("Node 24+ required");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("not-configured"));
        assert_eq!(path, materialize_runtime(&base).unwrap());
        std::fs::write(&path, "tampered").unwrap();
        assert!(materialize_runtime(&base).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn concurrent_first_runs_publish_only_complete_runtime_files() {
        let base = std::env::temp_dir().join(format!("msn-runtime-race-{}", uuid::Uuid::new_v4()));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let base = base.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    materialize_runtime(&base).unwrap()
                })
            })
            .collect();
        let paths: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert!(paths.iter().all(|path| path == &paths[0]));
        for (name, bytes) in RUNTIME {
            verify_runtime_file(&paths[0].parent().unwrap().join(name), bytes).unwrap();
        }
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn run_defaults_to_resume() {
        let cli = Cli::try_parse_from(["msn", "run", "work"]).unwrap();
        assert!(
            matches!(cli.command, Command::Run { status: false, install_service: false, command, .. } if command.is_empty())
        );
    }
    #[test]
    fn explicit_state_directory_can_resume_or_inspect() {
        for extra in [vec![], vec!["--status"], vec!["--install-service"]] {
            let mut args = vec!["msn", "run", "work", "--state-dir", "/state with spaces"];
            args.extend(extra);
            let cli = Cli::try_parse_from(args).unwrap();
            assert!(
                matches!(cli.command, Command::Run { state_dir: Some(path), .. } if path == "/state with spaces")
            );
        }
    }
    #[test]
    fn preserves_trusted_argv() {
        let cli = Cli::try_parse_from([
            "msn",
            "run",
            "work",
            "--prompt",
            "--",
            "/a b/agent",
            "--flag",
            "$literal",
        ])
        .unwrap();
        assert!(
            matches!(cli.command, Command::Run { prompt: true, command, .. } if command == ["/a b/agent", "--flag", "$literal"])
        );
    }
    #[test]
    fn status_cannot_configure_or_install() {
        for args in [
            vec!["--status", "--harness", "codex"],
            vec!["--status", "--install-service"],
            vec!["--status", "--", "agent"],
        ] {
            assert!(Cli::try_parse_from([vec!["msn", "run", "work"], args].concat()).is_err());
        }
    }
    #[test]
    fn adapters_and_service_parse() {
        for harness in ["codex", "claude", "tny"] {
            assert!(
                Cli::try_parse_from([
                    "msn",
                    "run",
                    "work",
                    "--install-service",
                    "--harness",
                    harness
                ])
                .is_ok()
            );
        }
        assert!(Cli::try_parse_from(["msn", "run", "work", "--prompt"]).is_err());
        assert!(
            Cli::try_parse_from(["msn", "run", "work", "--harness", "codex", "--", "agent"])
                .is_err()
        );
    }
}
