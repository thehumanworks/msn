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
