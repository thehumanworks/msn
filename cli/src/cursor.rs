use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use url::Url;

use crate::config::{MAX_SAFE_INTEGER, origin_key, parse_int};
use crate::error::CliError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorBinding {
    pub server: String,
    pub tenant: String,
    pub channel: String,
    pub after: u64,
}

impl CursorBinding {
    pub fn new(url: &Url, tenant: &str, channel: &str, after: u64) -> Self {
        Self {
            server: origin_key(url),
            tenant: tenant.to_string(),
            channel: channel.to_string(),
            after,
        }
    }
}

/// `$XDG_STATE_HOME` (or `$HOME/.local/state`) `/msn/<origin-hash>/<tenant>/<channel>.json`.
pub fn default_cursor_path(url: &Url, tenant: &str, channel: &str) -> Result<PathBuf, CliError> {
    let state_home = match std::env::var_os("XDG_STATE_HOME") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => match std::env::var_os("HOME") {
            Some(home) if !home.is_empty() => PathBuf::from(home).join(".local").join("state"),
            _ => {
                return Err(CliError::usage(
                    "Set HOME (or XDG_STATE_HOME), or pass --cursor-file or --after.",
                ));
            }
        },
    };
    Ok(state_home
        .join("msn")
        .join(origin_hash(url))
        .join(tenant)
        .join(format!("{channel}.json")))
}

/// FNV-1a 64 of the ASCII origin, as 16 lowercase hex digits. Stable across releases,
/// unlike `std::hash::DefaultHasher`, so persisted paths keep resolving.
pub fn origin_hash(url: &Url) -> String {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET_BASIS;
    for byte in origin_key(url).bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

pub fn load_cursor(path: &Path, expected: &CursorBinding) -> Result<u64, CliError> {
    let raw = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(expected.after),
        Err(error) => return Err(CliError::generic(error.to_string())),
    };
    let saved: CursorFile = serde_json::from_str(&raw).map_err(|_| {
        CliError::usage("Cursor file belongs to a different server, tenant or channel.")
    })?;
    if saved.server != expected.server
        || saved.tenant != expected.tenant
        || saved.channel != expected.channel
    {
        return Err(CliError::usage(
            "Cursor file belongs to a different server, tenant or channel.",
        ));
    }
    parse_after_value(&saved.after)
}

pub fn write_cursor(path: &Path, binding: &CursorBinding) -> Result<(), CliError> {
    let payload =
        serde_json::to_string(binding).map_err(|error| CliError::generic(error.to_string()))?;
    let tmp = sibling_tmp(path);
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp)?;
    file.write_all(payload.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path)?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(path, perms)?;
    }
    Ok(())
}

fn sibling_tmp(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()))
}

#[derive(Deserialize)]
struct CursorFile {
    server: String,
    tenant: String,
    channel: String,
    after: serde_json::Value,
}

fn parse_after_value(value: &serde_json::Value) -> Result<u64, CliError> {
    match value {
        serde_json::Value::Number(number) => number
            .as_u64()
            .filter(|n| *n <= MAX_SAFE_INTEGER)
            .ok_or_else(|| CliError::usage("Invalid integer: after")),
        serde_json::Value::String(raw) => parse_int(raw, MAX_SAFE_INTEGER),
        _ => Err(CliError::usage("Invalid integer: after")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_path() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!("msn-cursor-unit-{nanos}.json"))
    }

    #[test]
    fn given_missing_file_when_load_then_default_after() {
        let url = Url::parse("https://msn.test").unwrap();
        let binding = CursorBinding::new(&url, "team", "general", 0);
        let after = load_cursor(&tmp_path(), &binding).unwrap();
        assert_eq!(after, 0);
    }

    #[test]
    fn given_foreign_binding_when_load_then_usage() {
        let path = tmp_path();
        let url = Url::parse("https://msn.test").unwrap();
        let written = CursorBinding::new(&url, "team", "general", 8);
        write_cursor(&path, &written).unwrap();
        let mismatches = [
            CursorBinding::new(
                &Url::parse("https://other.test").unwrap(),
                "team",
                "general",
                0,
            ),
            CursorBinding::new(&url, "other", "general", 0),
            CursorBinding::new(&url, "team", "other", 0),
        ];
        for other in mismatches {
            let err = load_cursor(&path, &other).unwrap_err();
            assert_eq!(err.exit_code(), 2, "{other:?}");
        }
        assert_eq!(load_cursor(&path, &written).unwrap(), 8);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn given_string_after_when_load_then_parsed() {
        let path = tmp_path();
        fs::write(
            &path,
            r#"{"server":"https://msn.test","tenant":"team","channel":"general","after":"12"}"#,
        )
        .unwrap();
        let binding = CursorBinding::new(
            &Url::parse("https://msn.test").unwrap(),
            "team",
            "general",
            0,
        );
        assert_eq!(load_cursor(&path, &binding).unwrap(), 12);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn given_known_origin_when_origin_hash_then_fnv1a_vector() {
        // FNV-1a 64 test vector for the exact bytes "https://a.test": computed once from
        // the reference algorithm; also pins that hashing covers the whole origin.
        let url = Url::parse("https://a.test").unwrap();
        let hash = origin_hash(&url);
        assert_eq!(hash.len(), 16);
        assert!(
            hash.bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        );
        assert_eq!(hash, fnv1a_reference(b"https://a.test"));
        assert_ne!(
            hash,
            origin_hash(&Url::parse("https://a.test:8443").unwrap())
        );
    }

    fn fnv1a_reference(bytes: &[u8]) -> String {
        let mut h: u64 = 14_695_981_039_346_656_037;
        for b in bytes {
            h ^= *b as u64;
            h = h.wrapping_mul(1_099_511_628_211);
        }
        format!("{h:016x}")
    }

    #[test]
    fn given_xdg_state_home_when_default_path_then_under_it() {
        let url = Url::parse("https://msn.test").unwrap();
        let path = with_env(
            &[("XDG_STATE_HOME", Some("/xdg")), ("HOME", Some("/home/u"))],
            || default_cursor_path(&url, "team", "general").unwrap(),
        );
        assert_eq!(
            path,
            PathBuf::from(format!("/xdg/msn/{}/team/general.json", origin_hash(&url)))
        );
    }

    #[test]
    fn given_home_only_when_default_path_then_local_state() {
        let url = Url::parse("https://msn.test").unwrap();
        let path = with_env(
            &[("XDG_STATE_HOME", None), ("HOME", Some("/home/u"))],
            || default_cursor_path(&url, "team", "general").unwrap(),
        );
        assert_eq!(
            path,
            PathBuf::from(format!(
                "/home/u/.local/state/msn/{}/team/general.json",
                origin_hash(&url)
            ))
        );
        let other_channel = with_env(
            &[("XDG_STATE_HOME", None), ("HOME", Some("/home/u"))],
            || default_cursor_path(&url, "team", "other").unwrap(),
        );
        let other_tenant = with_env(
            &[("XDG_STATE_HOME", None), ("HOME", Some("/home/u"))],
            || default_cursor_path(&url, "other", "general").unwrap(),
        );
        assert_ne!(path, other_channel);
        assert_ne!(path, other_tenant);
        assert_ne!(other_channel, other_tenant);
    }

    #[test]
    fn given_no_home_when_default_path_then_usage() {
        let url = Url::parse("https://msn.test").unwrap();
        for vars in [
            [("XDG_STATE_HOME", None), ("HOME", None)],
            [("XDG_STATE_HOME", Some("")), ("HOME", Some(""))],
        ] {
            let err = with_env(&vars, || {
                default_cursor_path(&url, "team", "general").unwrap_err()
            });
            assert_eq!(err.exit_code(), 2, "{vars:?}");
            assert!(err.to_string().contains("--cursor-file"));
        }
    }

    #[test]
    fn given_empty_xdg_state_home_when_default_path_then_home_fallback() {
        let url = Url::parse("https://msn.test").unwrap();
        let path = with_env(
            &[("XDG_STATE_HOME", Some("")), ("HOME", Some("/home/u"))],
            || default_cursor_path(&url, "team", "general").unwrap(),
        );
        assert!(
            path.starts_with("/home/u/.local/state/msn"),
            "{}",
            path.display()
        );
    }

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_env<T>(vars: &[(&str, Option<&str>)], f: impl FnOnce() -> T) -> T {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let saved: Vec<(String, Option<std::ffi::OsString>)> = vars
            .iter()
            .map(|(name, _)| ((*name).to_string(), std::env::var_os(name)))
            .collect();
        for (name, value) in vars {
            // SAFETY: serialized by ENV_LOCK; unit tests in this module are the only writers.
            unsafe {
                match value {
                    Some(v) => std::env::set_var(name, v),
                    None => std::env::remove_var(name),
                }
            }
        }
        let result = f();
        for (name, value) in saved {
            unsafe {
                match value {
                    Some(v) => std::env::set_var(&name, v),
                    None => std::env::remove_var(&name),
                }
            }
        }
        result
    }

    #[test]
    fn given_unreadable_cursor_when_load_then_generic() {
        let path = tmp_path();
        fs::write(&path, "{}").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o000);
            fs::set_permissions(&path, perms).unwrap();
            let binding = CursorBinding::new(
                &Url::parse("https://msn.test").unwrap(),
                "team",
                "general",
                0,
            );
            let err = load_cursor(&path, &binding).unwrap_err();
            assert_eq!(err.exit_code(), 1);
            let mut perms = fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o600);
            fs::set_permissions(&path, perms).unwrap();
        }
        let _ = fs::remove_file(&path);
    }
}
