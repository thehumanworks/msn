//! Message attachments (ADR 0087): upload local files before a send, download a message's file.
//!
//! The server names each object with a UUID and treats identical bytes as the same object, so
//! re-running a send with the same files and the same Idempotency-Key replays the same message.

use std::fs;
use std::path::Path;

use serde_json::{Value, json};

use crate::client::{MsnClient, classify, status_error};
use crate::error::CliError;

/// Server limits (ADR 0087), checked locally first so a too-large file fails before any network call.
pub const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_ATTACHMENTS_PER_MESSAGE: usize = 10;

/// A local file read and checked, ready to upload.
pub struct LocalFile {
    pub name: String,
    pub data: Vec<u8>,
}

/// Reads every path, enforcing the per-file size, the per-message count and distinct names.
pub fn read_files(paths: &[String]) -> Result<Vec<LocalFile>, CliError> {
    if paths.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(CliError::usage(format!(
            "A message can carry at most {MAX_ATTACHMENTS_PER_MESSAGE} attachments."
        )));
    }
    let mut files: Vec<LocalFile> = Vec::with_capacity(paths.len());
    for raw in paths {
        let path = Path::new(raw);
        let metadata = fs::metadata(path)
            .map_err(|error| CliError::usage(format!("Cannot read attachment {raw}: {error}")))?;
        if !metadata.is_file() {
            return Err(CliError::usage(format!("Attachment {raw} is not a file.")));
        }
        if metadata.len() == 0 || metadata.len() > MAX_ATTACHMENT_BYTES {
            return Err(CliError::usage(format!(
                "Attachment {raw} must be 1 byte to 25 MiB (it is {} bytes).",
                metadata.len()
            )));
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.chars().any(char::is_control))
            .ok_or_else(|| CliError::usage(format!("Attachment {raw} needs a UTF-8 file name.")))?
            .to_string();
        if files.iter().any(|file| file.name == name) {
            return Err(CliError::usage(format!(
                "Two attachments are named {name}; names must be distinct within a message."
            )));
        }
        let data = fs::read(path)
            .map_err(|error| CliError::usage(format!("Cannot read attachment {raw}: {error}")))?;
        files.push(LocalFile { name, data });
    }
    Ok(files)
}

/// A new id is a UUID. An object stored before ADR 0087 is 64 hex characters.
fn attachment_id(id: &str) -> bool {
    if id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return true;
    }
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12]
            == [
                parts[0].len(),
                parts[1].len(),
                parts[2].len(),
                parts[3].len(),
                parts[4].len(),
            ]
        && parts
            .iter()
            .all(|part| part.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// Uploads each file to the channel and returns the `attachments` list for the send body.
pub fn upload(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    files: &[LocalFile],
) -> Result<Vec<Value>, CliError> {
    files
        .iter()
        .map(|file| {
            let response = client.post_bytes(
                &format!("/api/tenants/{tenant}/channels/{channel}/attachments"),
                token,
                &file.data,
            )?;
            classify(response.status, &response.body)?;
            let body: Value = serde_json::from_str(&response.body)
                .map_err(|_| CliError::generic("Upload response was not JSON."))?;
            let id = body["attachment"]["id"]
                .as_str()
                .filter(|id| attachment_id(id))
                .ok_or_else(|| CliError::generic("Upload response had no attachment id."))?;
            Ok(json!({"id": id, "name": file.name}))
        })
        .collect()
}

/// One downloaded file with what the server said about it.
pub struct Download {
    pub media_type: String,
    pub data: Vec<u8>,
}

pub fn download(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    message: u64,
    index: u64,
) -> Result<Download, CliError> {
    let response = client.get_bytes(
        &format!("/api/tenants/{tenant}/channels/{channel}/messages/{message}/attachments/{index}"),
        token,
    )?;
    if !(200..300).contains(&response.status) {
        return Err(status_error(
            response.status,
            &String::from_utf8_lossy(&response.body),
        ));
    }
    Ok(Download {
        media_type: response
            .content_type
            .unwrap_or_else(|| "application/octet-stream".into()),
        data: response.body,
    })
}

/// Text a model can read inline: a text or JSON type that is valid UTF-8.
pub fn as_text(file: &Download) -> Option<&str> {
    let base = file.media_type.split(';').next().unwrap_or("").trim();
    let textual = base.starts_with("text/")
        || base == "application/json"
        || base.ends_with("+json")
        || base == "application/xml";
    if textual {
        std::str::from_utf8(&file.data).ok()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("msn-attach-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn given_files_when_read_then_names_and_bytes_kept() {
        let dir = temp_dir();
        fs::write(dir.join("build.log"), b"ok\n").unwrap();
        let files = read_files(&[dir.join("build.log").display().to_string()]).unwrap();
        assert_eq!(files[0].name, "build.log");
        assert_eq!(files[0].data, b"ok\n");
    }

    #[test]
    fn given_limits_when_read_then_rejected_locally() {
        let dir = temp_dir();
        fs::write(dir.join("empty"), b"").unwrap();
        fs::write(
            dir.join("big"),
            vec![0u8; MAX_ATTACHMENT_BYTES as usize + 1],
        )
        .unwrap();
        fs::write(dir.join("a"), b"a").unwrap();
        let path = |name: &str| dir.join(name).display().to_string();
        assert!(read_files(&[path("empty")]).is_err());
        assert!(read_files(&[path("big")]).is_err());
        assert!(read_files(&[path("missing")]).is_err());
        assert!(read_files(&[dir.display().to_string()]).is_err());
        assert!(read_files(&vec![path("a"); 11]).is_err());
        // Same name twice is ambiguous for readers.
        assert!(read_files(&[path("a"), path("a")]).is_err());
    }

    #[test]
    fn given_media_types_when_as_text_then_only_utf8_text_inline() {
        let file = |media_type: &str, data: &[u8]| Download {
            media_type: media_type.into(),
            data: data.to_vec(),
        };
        assert_eq!(as_text(&file("text/plain", b"hi")), Some("hi"));
        assert_eq!(as_text(&file("application/json", b"{}")), Some("{}"));
        assert_eq!(as_text(&file("text/plain", &[0xff])), None);
        assert_eq!(as_text(&file("image/png", b"hi")), None);
    }
}
