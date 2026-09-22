//! The CLI carries the harness-neutral runtime; a source checkout is not needed on the host.
use crate::args::{Cli, Command};
use crate::board::{private_file, selected};
use crate::config::slug;
use crate::error::CliError;
use crate::profile;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

const FILES: &[(&str, &str)] = &[
    (
        "host-runner.mjs",
        include_str!("../../scripts/host-runner.mjs"),
    ),
    (
        "event-runner.mjs",
        include_str!("../../scripts/event-runner.mjs"),
    ),
    (
        "onboarding-check.mjs",
        include_str!("../../scripts/onboarding-check.mjs"),
    ),
    (
        "host/protocol.mjs",
        include_str!("../../scripts/host/protocol.mjs"),
    ),
    (
        "host/transport.mjs",
        include_str!("../../scripts/host/transport.mjs"),
    ),
    (
        "host/store.mjs",
        include_str!("../../scripts/host/store.mjs"),
    ),
    (
        "host/runtime.mjs",
        include_str!("../../scripts/host/runtime.mjs"),
    ),
    (
        "host/process.mjs",
        include_str!("../../scripts/host/process.mjs"),
    ),
    (
        "host/turn-worker.mjs",
        include_str!("../../scripts/host/turn-worker.mjs"),
    ),
    (
        "host/prompt-adapter.mjs",
        include_str!("../../scripts/host/prompt-adapter.mjs"),
    ),
];

pub fn execute(cli: &Cli) -> Result<(), CliError> {
    let Command::Run {
        channel,
        state_dir,
        status,
        install_service,
        harness,
        prompt,
        command,
    } = &cli.command
    else {
        unreachable!()
    };
    slug(channel)?;
    let p = selected(cli)?;
    if !*status {
        let identity = crate::identity::fetch_identity(
            &crate::config::parse_origin(&p.url)?,
            &p.tenant,
            &p.token,
        )?;
        if identity["sharedChannel"] != true || identity["channel"] != *channel {
            return Err(CliError::usage(
                "Run agents using a channel profile created by board create or persona add.",
            ));
        }
    }
    slug(&p.reader)?;
    let key = format!(
        "{:x}",
        Sha256::digest(format!(
            "{}\n{}\n{}\n{}",
            p.url, p.tenant, channel, p.reader
        ))
    );
    let root = profile::profile_directory()?
        .parent()
        .ok_or_else(|| CliError::generic("Invalid profile directory"))?
        .join("runners");
    profile::ensure_directory(&root)?;
    let state = state_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(&key[..24]));
    let state = if state.is_absolute() {
        state
    } else {
        std::env::current_dir()?.join(state)
    };
    profile::ensure_directory(&state)?;
    let mut digest = Sha256::new();
    for (name, source) in FILES {
        digest.update(name);
        digest.update(source);
    }
    let version = format!("{:x}", digest.finalize());
    let bundle = root.join(format!("runtime-{}", &version[..24]));
    profile::ensure_directory(&bundle)?;
    profile::ensure_directory(&bundle.join("host"))?;
    for (name, source) in FILES {
        let file = bundle.join(name);
        match private_file(&file, source.as_bytes()) {
            Ok(()) => {}
            Err(_) if fs::read(&file).ok().as_deref() == Some(source.as_bytes()) => {}
            Err(error) => return Err(error),
        }
    }
    let config = state.join("runner.json");
    if !*status {
        if command.is_empty() && harness.is_none() && !config.exists() {
            return Err(CliError::usage(
                "Use msn run CHANNEL -- COMMAND [ARGS...] on first start.",
            ));
        }
        if !command.is_empty() || harness.is_some() {
            let argv = if let Some(harness) = harness {
                if !command.is_empty() {
                    return Err(CliError::usage("Use either --harness or a custom COMMAND."));
                }
                vec![
                    "node".into(),
                    bundle.join("host/prompt-adapter.mjs").display().to_string(),
                    "--harness".into(),
                    harness.clone(),
                ]
            } else if *prompt {
                let mut args = vec![
                    "node".into(),
                    bundle.join("host/prompt-adapter.mjs").display().to_string(),
                    "--".into(),
                ];
                args.extend(command.iter().cloned());
                args
            } else {
                command.clone()
            };
            let body = json!({"schema":"msn.host.v1","hostId":format!("runner-{}",&key[..24]),"stateDir":state,"maxConcurrent":1,"maxTurnsPerConversation":null,"softTurnsPerConversation":16,"replayHistory":true,
                "agents":[{"id":p.reader,"username":p.username,"connection":{"origin":p.url,"tenant":p.tenant,"tokenEnv":"MSN_RUNNER_CHANNEL_TOKEN"},"command":argv,"cwd":std::env::current_dir()?,"channels":[channel],"permissionMode":"yolo","timeoutMs":null}]});
            let bytes = serde_json::to_vec_pretty(&body)
                .map_err(|_| CliError::generic("Cannot encode runner configuration"))?;
            if config.exists() {
                if fs::read(&config)? != bytes {
                    return Err(CliError::usage(
                        "Runner already configured. Resume without COMMAND, or choose a new --state-dir.",
                    ));
                }
            } else {
                private_file(&config, &bytes)?;
            }
        }
    }
    if *install_service {
        return install_service_unit(cli, channel, &state, &key);
    }
    let mut process = std::process::Command::new("node");
    process
        .arg(bundle.join("host-runner.mjs"))
        .arg("--config")
        .arg(config)
        .env("MSN_RUNNER_CHANNEL_TOKEN", &p.token);
    if *status {
        process.arg("--status");
    }
    // Same PID after exec: supervisors and terminal signals reach the runtime directly.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(CliError::generic(format!(
            "Could not start Node 24+ runtime: {}",
            process.exec()
        )))
    }
    #[cfg(not(unix))]
    {
        let _ = process;
        Err(CliError::usage(
            "Persistent runners currently support Linux and macOS.",
        ))
    }
}

fn unit_quote(value: &str) -> Result<String, CliError> {
    if value.chars().any(|c| c.is_control()) {
        return Err(CliError::usage(
            "Service paths must not contain control characters.",
        ));
    }
    Ok(format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('\"', "\\\"")
            .replace('%', "%%")
            .replace('$', "$$")
    ))
}
fn install_service_unit(
    cli: &Cli,
    channel: &str,
    state: &std::path::Path,
    key: &str,
) -> Result<(), CliError> {
    if !cfg!(target_os = "linux") {
        return Err(CliError::usage(
            "--install-service requires systemd on Linux; use launchd to supervise msn run on macOS.",
        ));
    }
    let profile = cli.profile.as_deref().ok_or_else(|| {
        CliError::usage(
            "Use --profile NAME to install a runner service. Credentials remain in that profile.",
        )
    })?;
    let config_root = profile::profile_directory()?
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| CliError::generic("Invalid config root"))?
        .to_path_buf();
    let units = config_root.join("systemd/user");
    fs::create_dir_all(&units)?;
    let name = format!("msn-agent-{}.service", &key[..24]);
    let exe = std::env::current_exe()?;
    let args = [
        exe.display().to_string(),
        "--profile".into(),
        profile.into(),
        "run".into(),
        channel.into(),
        "--state-dir".into(),
        state.display().to_string(),
    ];
    let command = args
        .iter()
        .map(|v| unit_quote(v))
        .collect::<Result<Vec<_>, _>>()?
        .join(" ");
    let content = format!(
        "[Unit]\nDescription=MSN agent message board runner\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart={command}\nEnvironment={}\nEnvironment={}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=15\n\n[Install]\nWantedBy=default.target\n",
        unit_quote(&format!("XDG_CONFIG_HOME={}", config_root.display()))?,
        unit_quote(&format!(
            "PATH={}",
            std::env::var("PATH").unwrap_or_default()
        ))?
    );
    let path = units.join(&name);
    if path.exists() {
        if fs::read_to_string(&path)? != content {
            return Err(CliError::usage(
                "Service file already exists with different settings.",
            ));
        }
    } else {
        private_file(&path, content.as_bytes())?;
    }
    for arguments in [
        vec!["--user", "daemon-reload"],
        vec!["--user", "enable", "--now", name.as_str()],
    ] {
        let status = std::process::Command::new("systemctl")
            .args(arguments)
            .status()?;
        if !status.success() {
            return Err(CliError::generic(format!(
                "Service saved at {}; systemd user manager is unavailable or rejected startup.",
                path.display()
            )));
        }
    }
    println!("{}", json!({"service":name,"path":path,"started":true}));
    Ok(())
}
