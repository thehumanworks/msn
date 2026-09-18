use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use clap::ArgMatches;
use clap::parser::ValueSource;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::args::{Cli, Command, ProfileCommand, Shell};
use crate::config::{origin_key, parse_origin, require_tenant, require_token};
use crate::cursor::reader_hash;
use crate::error::CliError;
use crate::identity::{fetch_identity, validate_username};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Profile {
    pub(crate) url: String,
    pub(crate) tenant: String,
    pub(crate) token: String,
    pub(crate) username: String,
    pub(crate) reader: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) activity: Option<serde_json::Value>,
}

/// Apply the selected profile or handle a local profile/shell command.
///
/// `true` means the command was fully handled and normal command execution should stop.
pub fn prepare(cli: &mut Cli, matches: &ArgMatches) -> Result<bool, CliError> {
    match &cli.command {
        Command::Profile { command } => {
            match command {
                ProfileCommand::Save { name } => {
                    if cli.profile.is_some() {
                        return Err(CliError::usage(
                            "Unset MSN_PROFILE and omit --profile before saving a profile; saved profiles cannot be composed.",
                        ));
                    }
                    save(cli, name)?
                }
                ProfileCommand::List => list()?,
                ProfileCommand::Show { name } => show(name)?,
            }
            return Ok(true);
        }
        Command::Activate { name } => {
            activate(name)?;
            return Ok(true);
        }
        Command::Deactivate => {
            println!("unset MSN_PROFILE");
            return Ok(true);
        }
        Command::ShellInit { shell } => {
            shell_init(*shell);
            return Ok(true);
        }
        _ => {}
    }

    let Some(name) = cli.profile.clone() else {
        return Ok(false);
    };
    validate_name(&name)?;
    for argument in ["url", "tenant", "token"] {
        if matches.value_source(argument) == Some(ValueSource::CommandLine) {
            return Err(CliError::usage(format!(
                "Do not combine --profile with --{argument}; the selected profile is a complete connection."
            )));
        }
    }

    let profile = load(&name)?;
    let explicit_username = (matches.value_source("username") == Some(ValueSource::CommandLine))
        .then(|| cli.username.clone())
        .flatten();
    let explicit_reader = (matches.value_source("reader") == Some(ValueSource::CommandLine))
        .then(|| cli.reader.clone())
        .flatten();
    cli.url = profile.url;
    cli.tenant = Some(profile.tenant);
    cli.token = Some(profile.token);
    cli.username = explicit_username.or(Some(profile.username));
    cli.reader = explicit_reader.or(Some(profile.reader));
    Ok(false)
}

fn save(cli: &Cli, name: &str) -> Result<(), CliError> {
    validate_name(name)?;
    reject_existing(name)?;
    let url = parse_origin(&cli.url)?;
    let tenant = require_tenant(cli.tenant.as_deref())?;
    let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
    let username = resolve_username(&url, &tenant, &token, cli.username.as_deref())?;
    let reader = cli.reader.clone().unwrap_or_else(|| username.clone());
    reader_hash(&reader)?;
    let profile = Profile {
        url: origin_key(&url),
        tenant,
        token,
        username,
        reader,
        activity: None,
    };
    write_new(name, &profile)?;
    print_public(name, &profile)
}

fn activate(name: &str) -> Result<(), CliError> {
    validate_name(name)?;
    let profile = load(name)?;
    let url = parse_origin(&profile.url)?;
    let resolved = resolve_username(
        &url,
        &profile.tenant,
        &profile.token,
        Some(&profile.username),
    )?;
    if resolved != profile.username {
        return Err(CliError::auth(
            "The profile identity no longer matches its access key.",
        ));
    }
    println!("export MSN_PROFILE='{name}'");
    Ok(())
}

fn list() -> Result<(), CliError> {
    println!("{}", json!({ "profiles": names()? }));
    Ok(())
}

pub(crate) fn names() -> Result<Vec<String>, CliError> {
    let directory = profile_directory()?;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    check_directory(&directory)?;
    let mut names = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if validate_name(name).is_ok() {
            check_file(&path)?;
            names.push(name.to_string());
        }
    }
    names.sort();
    Ok(names)
}

/// Replace one profile atomically while its caller holds the per-profile lock.
pub(crate) fn replace(name: &str, profile: &Profile) -> Result<(), CliError> {
    let path = profile_path(name)?;
    check_file(&path)?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        set_create_mode(&mut options, 0o600);
        let mut file = options.open(&temp)?;
        serde_json::to_writer(&mut file, profile)
            .map_err(|_| CliError::generic("Could not serialize profile."))?;
        file.sync_all()?;
        fs::rename(&temp, &path)?;
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}

fn show(name: &str) -> Result<(), CliError> {
    validate_name(name)?;
    let profile = load(name)?;
    print_public(name, &profile)
}

fn print_public(name: &str, profile: &Profile) -> Result<(), CliError> {
    let value = json!({
        "name": name,
        "url": profile.url,
        "tenant": profile.tenant,
        "username": profile.username,
        "reader": profile.reader,
    });
    println!("{value}");
    Ok(())
}

fn shell_init(shell: Shell) {
    let label = match shell {
        Shell::Bash => "bash",
        Shell::Zsh => "zsh",
    };
    println!(
        r#"# msn shell integration for {label}
msn() {{
  case "${{1-}}" in
    activate|deactivate)
      local _msn_activation
      _msn_activation="$(command msn "$@")" || return $?
      eval "$_msn_activation"
      ;;
    *) command msn "$@" ;;
  esac
}}"#
    );
}

pub(crate) fn resolve_username(
    url: &url::Url,
    tenant: &str,
    token: &str,
    chosen: Option<&str>,
) -> Result<String, CliError> {
    let identity = fetch_identity(url, tenant, token)?;
    let chosen = chosen.map(validate_username).transpose()?;
    let bound = identity
        .get("username")
        .and_then(serde_json::Value::as_str)
        .map(validate_username)
        .transpose()?;
    let prefix = identity
        .get("usernamePrefix")
        .and_then(serde_json::Value::as_str);
    match (bound, prefix) {
        (Some(bound), None) => {
            if chosen.as_deref().is_some_and(|value| value != bound) {
                return Err(CliError::auth(format!(
                    "This access key may only send as \"{bound}\"."
                )));
            }
            Ok(bound)
        }
        (None, Some(prefix)) => match chosen {
            Some(value) if value.starts_with(prefix) => Ok(value),
            _ => Err(CliError::usage(format!(
                "Set --username to a name starting with \"{prefix}\" before saving this profile."
            ))),
        },
        (None, None) => chosen
            .ok_or_else(|| CliError::usage("Set --username before saving an unbound-key profile.")),
        (Some(_), Some(_)) => Err(CliError::generic(
            "Identity response had conflicting bindings.",
        )),
    }
}

pub(crate) fn validate_name(name: &str) -> Result<(), CliError> {
    if crate::config::is_slug(name) {
        Ok(())
    } else {
        Err(CliError::usage(
            "Profile names use 1–64 lowercase letters, digits, _ or -, starting with a letter or digit.",
        ))
    }
}

pub(crate) fn profile_directory() -> Result<PathBuf, CliError> {
    if let Some(path) = std::env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path).join("msn/profiles"));
    }
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::usage("Set XDG_CONFIG_HOME or HOME for local profiles."))?;
    Ok(PathBuf::from(home).join(".config/msn/profiles"))
}

pub(crate) fn profile_path(name: &str) -> Result<PathBuf, CliError> {
    Ok(profile_directory()?.join(format!("{name}.json")))
}

pub(crate) fn ensure_directory(path: &Path) -> Result<(), CliError> {
    if path.exists() {
        return check_directory(path);
    }
    fs::create_dir_all(path)?;
    set_mode(path, 0o700)?;
    check_directory(path)
}

fn check_directory(path: &Path) -> Result<(), CliError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CliError::usage(
            "The MSN profiles path must be a real directory.",
        ));
    }
    check_mode(&metadata, 0o700, "profiles directory")
}

fn check_file(path: &Path) -> Result<(), CliError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CliError::usage(
            "An MSN profile must be a regular file, not a symlink.",
        ));
    }
    check_mode(&metadata, 0o600, "profile file")
}

pub(crate) fn write_new(name: &str, profile: &Profile) -> Result<(), CliError> {
    let path = profile_path(name)?;
    let parent = path.parent().expect("profile has parent");
    ensure_directory(parent)?;
    let serialized =
        serde_json::to_vec(profile).map_err(|error| CliError::generic(error.to_string()))?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    set_create_mode(&mut options, 0o600);
    let mut file = options.open(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            CliError::conflict(format!("Profile \"{name}\" already exists."))
        } else {
            CliError::from(error)
        }
    })?;
    set_mode(&path, 0o600)?;
    file.write_all(&serialized)?;
    file.sync_all()?;
    check_file(&path)
}

pub(crate) fn reject_existing(name: &str) -> Result<(), CliError> {
    let path = profile_path(name)?;
    match fs::symlink_metadata(path) {
        Ok(_) => Err(CliError::conflict(format!(
            "Profile \"{name}\" already exists."
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn load(name: &str) -> Result<Profile, CliError> {
    let path = profile_path(name)?;
    let parent = path.parent().expect("profile has parent");
    check_directory(parent).map_err(|error| {
        if !parent.exists() {
            CliError::not_found(format!("Profile \"{name}\" does not exist."))
        } else {
            error
        }
    })?;
    check_file(&path).map_err(|error| {
        if !path.exists() {
            CliError::not_found(format!("Profile \"{name}\" does not exist."))
        } else {
            error
        }
    })?;
    let bytes = fs::read(path)?;
    let profile: Profile = serde_json::from_slice(&bytes)
        .map_err(|_| CliError::usage(format!("Profile \"{name}\" is not valid JSON.")))?;
    parse_origin(&profile.url)?;
    require_tenant(Some(&profile.tenant))?;
    require_token(Some(&profile.token), "profile token")?;
    validate_username(&profile.username)?;
    reader_hash(&profile.reader)?;
    Ok(profile)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), CliError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<(), CliError> {
    Ok(())
}

#[cfg(unix)]
fn set_create_mode(options: &mut OpenOptions, mode: u32) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(mode);
}

#[cfg(not(unix))]
fn set_create_mode(_options: &mut OpenOptions, _mode: u32) {}

#[cfg(unix)]
fn check_mode(metadata: &fs::Metadata, expected: u32, label: &str) -> Result<(), CliError> {
    use std::os::unix::fs::PermissionsExt;
    let actual = metadata.permissions().mode() & 0o777;
    if actual != expected {
        return Err(CliError::usage(format!(
            "Unsafe {label} permissions {actual:o}; expected {expected:o}."
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_mode(_metadata: &fs::Metadata, _expected: u32, _label: &str) -> Result<(), CliError> {
    Ok(())
}
