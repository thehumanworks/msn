//! Read-only reuse of `msn` CLI profiles (`~/.config/msn/profiles/<name>.json`).
//!
//! The CLI's own `Profile` type and loader are private to `msn-cli` (`pub(crate)`), so this is a
//! narrow, compatible reimplementation of the read path only: same directory, same JSON shape,
//! same permission checks. The desktop app never writes or rotates these files — `msn profile
//! save` remains the one writer, and this app can then be pointed at an existing profile without
//! retyping a token.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The connection fields of a CLI profile; `reader`, `activity` and any future fields are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct StoredProfile {
    pub url: String,
    pub tenant: String,
    pub token: String,
    pub username: String,
}

pub fn profile_directory() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(path).join("msn/profiles"));
    }
    let home = std::env::var_os("HOME").filter(|value| !value.is_empty())?;
    Some(PathBuf::from(home).join(".config/msn/profiles"))
}

/// Lists saved profile names, skipping anything that fails an ownership/permission sanity check
/// rather than surfacing a partially-trusted profile.
pub fn list_profiles() -> Vec<String> {
    let Some(directory) = profile_directory() else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&directory) else {
        return Vec::new();
    };
    if !is_safe_directory(&directory) {
        return Vec::new();
    }
    let mut names = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str())
            && is_safe_file(&path)
        {
            names.push(stem.to_string());
        }
    }
    names.sort();
    names
}

pub fn load_profile(name: &str) -> Result<StoredProfile, String> {
    let directory = profile_directory().ok_or("Set HOME or XDG_CONFIG_HOME to use profiles.")?;
    let path = directory.join(format!("{name}.json"));
    if !is_safe_file(&path) {
        return Err(format!(
            "Profile \"{name}\" is missing or has unsafe file permissions."
        ));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| format!("Profile \"{name}\" is not valid JSON."))
}

#[cfg(unix)]
fn is_safe_directory(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        !metadata.file_type().is_symlink()
            && metadata.is_dir()
            && metadata.permissions().mode() & 0o777 == 0o700
    })
}

#[cfg(unix)]
fn is_safe_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        !metadata.file_type().is_symlink()
            && metadata.is_file()
            && metadata.permissions().mode() & 0o777 == 0o600
    })
}

#[cfg(not(unix))]
fn is_safe_directory(path: &Path) -> bool {
    path.is_dir()
}

#[cfg(not(unix))]
fn is_safe_file(path: &Path) -> bool {
    path.is_file()
}
