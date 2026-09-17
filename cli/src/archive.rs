//! Portable `msn.channel.archive.v1` record types, digests, and a streaming verifier.
//!
//! This module is shared with `msn import`. It must stay free of export-only I/O
//! (HTTP, `FILE.partial`, rename). See `docs/archive-format.md`.

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Wire `format` string. Readers reject any other value (rule 1).
pub const FORMAT: &str = "msn.channel.archive.v1";
/// Highest `archiveVersion` this reader understands. Greater values are rejected (rule 6).
pub const ARCHIVE_VERSION: u64 = 1;
/// Canonical prefix hashed into [`instance_id`].
pub const INSTANCE_ID_PREFIX: &str = "msn.channel.instance.v1";

/// SHA-256 of `msn.channel.instance.v1\n<origin>\n<tenant>\n<channel>\n<channelCreatedAt>`.
///
/// `origin` must already be scheme+host+port with no trailing slash (the same
/// string `url::Url::origin().ascii_serialization()` produces). A reused URL
/// after a local database reset does **not** collide: `channelCreatedAt` changes,
/// so the digest changes and an importer treats the archive as a new source.
pub fn instance_id(origin: &str, tenant: &str, channel: &str, channel_created_at: &str) -> String {
    let mut material = String::with_capacity(
        INSTANCE_ID_PREFIX.len()
            + origin.len()
            + tenant.len()
            + channel.len()
            + channel_created_at.len()
            + 4,
    );
    material.push_str(INSTANCE_ID_PREFIX);
    material.push('\n');
    material.push_str(origin);
    material.push('\n');
    material.push_str(tenant);
    material.push('\n');
    material.push_str(channel);
    material.push('\n');
    material.push_str(channel_created_at);
    sha256_hex(material.as_bytes())
}

/// Lowercase SHA-256 hex of `bytes`. Used for both `instanceId` and `contentHash`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

/// Destination `Idempotency-Key` for an imported message (`docs/archive-format.md` §6).
///
/// `imp-<first 16 hex of instanceId>-<sourceId>`. A repeated or resumed import is a
/// server-side replay; a changed payload under the same identity is a 409 conflict.
pub fn import_idempotency_key(instance_id: &str, source_id: u64) -> String {
    format!("imp-{}-{source_id}", instance_prefix(instance_id))
}

/// Destination `Idempotency-Key` for an imported snapshot publish.
pub fn import_snapshot_key(instance_id: &str, version: u64) -> String {
    format!("imp-{}-snap-{version}", instance_prefix(instance_id))
}

/// Destination `Idempotency-Key` for an import marker or unavailable-snapshot record.
pub fn import_marker_key(instance_id: &str, marker: &str) -> String {
    format!("imp-{}-{marker}", instance_prefix(instance_id))
}

fn instance_prefix(instance_id: &str) -> &str {
    instance_id.get(..16).unwrap_or(instance_id)
}

/// `contentHash` of the exact concatenated line bytes (each including its `\n`).
///
/// Equivalent to [`ContentHasher`] over the same bytes. The completion line is
/// never part of this digest.
pub fn content_hash(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

/// Incremental SHA-256 used while streaming an archive so a long channel never
/// has to be buffered to compute `contentHash`.
#[derive(Clone, Default)]
pub struct ContentHasher {
    inner: Sha256,
}

impl ContentHasher {
    pub fn new() -> Self {
        Self {
            inner: Sha256::new(),
        }
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.inner.update(bytes);
    }

    pub fn finalize(self) -> String {
        hex_lower(&self.inner.finalize())
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Source workspace identity stored on the manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceIdentity {
    pub origin: String,
    pub tenant: String,
    pub channel: String,
    #[serde(rename = "channelCreatedAt")]
    pub channel_created_at: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
}

/// History boundary pinned before paging. Manifest includes `after`; completion repeats the rest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveBoundary {
    #[serde(rename = "headCursor")]
    pub head_cursor: u64,
    #[serde(rename = "historyRevision")]
    pub history_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<u64>,
    #[serde(rename = "snapshotVersion")]
    pub snapshot_version: u64,
}

/// First line of a complete archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub record: String,
    pub format: String,
    #[serde(rename = "archiveVersion")]
    pub archive_version: u64,
    #[serde(rename = "exportedAt")]
    pub exported_at: String,
    #[serde(rename = "exportedBy")]
    pub exported_by: String,
    pub producer: String,
    pub source: SourceIdentity,
    pub boundary: ArchiveBoundary,
}

/// A live message as stored in the archive. Optional addressing fields are omitted when unset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageRecord {
    pub record: String,
    #[serde(rename = "sourceId")]
    pub source_id: u64,
    pub username: String,
    pub text: String,
    #[serde(rename = "contentType")]
    pub content_type: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "replyTo", skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<u64>,
    #[serde(rename = "correlationId", skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}

/// A snapshot. `text` is present only when `invalidated` is false.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotRecord {
    pub record: String,
    pub version: u64,
    pub username: String,
    #[serde(rename = "coversThrough")]
    pub covers_through: u64,
    #[serde(rename = "historyRevision")]
    pub history_revision: u64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub invalidated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// Last line of a complete archive. `status` is always `"complete"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Completion {
    pub record: String,
    pub status: String,
    #[serde(rename = "messageCount")]
    pub message_count: u64,
    #[serde(rename = "snapshotCount")]
    pub snapshot_count: u64,
    #[serde(rename = "invalidatedSnapshotCount")]
    pub invalidated_snapshot_count: u64,
    #[serde(rename = "firstSourceId", skip_serializing_if = "Option::is_none")]
    pub first_source_id: Option<u64>,
    #[serde(rename = "lastSourceId", skip_serializing_if = "Option::is_none")]
    pub last_source_id: Option<u64>,
    pub boundary: ArchiveBoundary,
    #[serde(rename = "contentHash")]
    pub content_hash: String,
}

/// Successful verification: the raw manifest and completion (unknown keys preserved)
/// plus the unsupported-record count required by rule 4.
#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedArchive {
    pub manifest: Value,
    pub completion: Value,
    pub unsupported_record_count: u64,
}

/// Precise archive-format failure. Never a silent drop.
#[derive(Debug, thiserror::Error)]
pub enum ArchiveError {
    #[error("Cannot read archive: {0}")]
    Io(#[from] std::io::Error),
    #[error("Archive line {line} is not JSON: {message}")]
    Json { line: u64, message: String },
    #[error("Archive line {line} is empty.")]
    EmptyLine { line: u64 },
    #[error("Archive line {line} is not terminated by a single \\n.")]
    MissingNewline { line: u64 },
    #[error("Archive line {line} uses CR line endings.")]
    InvalidLineEnding { line: u64 },
    #[error("First line is not a manifest with format {FORMAT}.")]
    InvalidFormat,
    #[error("Unsupported archiveVersion {version} (reader understands {ARCHIVE_VERSION}).")]
    UnsupportedArchiveVersion { version: u64 },
    #[error("Archive manifest is invalid: {0}")]
    InvalidManifest(&'static str),
    #[error("Archive completion is invalid: {0}")]
    InvalidCompletion(&'static str),
    #[error("Archive has no completion line.")]
    MissingCompletion,
    #[error("Archive has records after the completion line.")]
    RecordsAfterCompletion,
    #[error("Archive contentHash does not match (expected {expected}, computed {actual}).")]
    ContentHashMismatch { expected: String, actual: String },
    #[error("Archive {field} is {expected}, counted {actual}.")]
    CountMismatch {
        field: &'static str,
        expected: u64,
        actual: u64,
    },
    #[error("Archive {kind} identifiers are not strictly ascending ({previous} then {found}).")]
    OutOfOrder {
        kind: &'static str,
        previous: u64,
        found: u64,
    },
    #[error("Archive message {id} is outside boundary.after={after} .. headCursor={head}.")]
    MessageOutsideBoundary { id: u64, after: u64, head: u64 },
    #[error("Archive snapshot version {version} is outside the pinned snapshotVersion {max}.")]
    SnapshotOutsideBoundary { version: u64, max: u64 },
    #[error("Archive instanceId does not match the source identity fields.")]
    InstanceIdMismatch,
    #[error("Archive record {found} appeared after snapshots had started.")]
    MessageAfterSnapshot { found: String },
}

/// Verify an archive against `docs/archive-format.md` §5 rules 1–6.
///
/// `visit` is invoked for every body record (message, snapshot, or unknown) in
/// file order, with the raw JSON object so unknown keys are preserved (rule 5).
/// Unknown `record` values are counted, not dropped (rule 4). The file is never
/// fully buffered: only the current line is resident plus running counts/hash.
pub fn verify_archive<R, F>(reader: R, mut visit: F) -> Result<VerifiedArchive, ArchiveError>
where
    R: Read,
    F: FnMut(&Value) -> Result<(), ArchiveError>,
{
    let mut reader = BufReader::new(reader);
    let mut line_no = 0;
    let first = read_jsonl_line(&mut reader, {
        line_no += 1;
        line_no
    })?
    .ok_or(ArchiveError::InvalidFormat)?;
    let manifest = parse_object(&first, line_no)?;
    validate_manifest(&manifest)?;
    let mut hasher = ContentHasher::new();
    hasher.update(&first);

    let after = integer(&manifest["boundary"]["after"]).ok_or(ArchiveError::InvalidManifest(
        "boundary.after must be an integer.",
    ))?;
    let head = integer(&manifest["boundary"]["headCursor"]).ok_or(
        ArchiveError::InvalidManifest("boundary.headCursor must be an integer."),
    )?;
    let snapshot_max = integer(&manifest["boundary"]["snapshotVersion"]).ok_or(
        ArchiveError::InvalidManifest("boundary.snapshotVersion must be an integer."),
    )?;

    let mut last_message: Option<u64> = None;
    let mut last_snapshot: Option<u64> = None;
    let mut message_count = 0;
    let mut snapshot_count = 0;
    let mut invalidated_snapshot_count = 0;
    let mut unsupported_record_count = 0;
    let mut saw_snapshot = false;
    let mut first_source_id = None;
    let mut last_source_id = None;
    let mut completion: Option<(Value, Vec<u8>)> = None;

    loop {
        line_no += 1;
        let Some(raw) = read_jsonl_line(&mut reader, line_no)? else {
            break;
        };
        let object = parse_object(&raw, line_no)?;
        let record =
            object
                .get("record")
                .and_then(Value::as_str)
                .ok_or(ArchiveError::InvalidCompletion(
                    "body line is missing a record discriminator.",
                ))?;
        if record == "completion" {
            completion = Some((object, raw));
            break;
        }
        hasher.update(&raw);
        match record {
            "manifest" => {
                return Err(ArchiveError::InvalidManifest(
                    "manifest must appear only as the first line.",
                ));
            }
            "message" => {
                if saw_snapshot {
                    return Err(ArchiveError::MessageAfterSnapshot {
                        found: "message".to_string(),
                    });
                }
                let id = integer(&object["sourceId"]).ok_or(ArchiveError::InvalidManifest(
                    "message.sourceId must be an integer.",
                ))?;
                if id <= after || id > head {
                    return Err(ArchiveError::MessageOutsideBoundary { id, after, head });
                }
                if last_message.is_some_and(|prev| id <= prev) {
                    return Err(ArchiveError::OutOfOrder {
                        kind: "message",
                        previous: last_message.unwrap_or(0),
                        found: id,
                    });
                }
                if first_source_id.is_none() {
                    first_source_id = Some(id);
                }
                last_source_id = Some(id);
                last_message = Some(id);
                message_count += 1;
            }
            "snapshot" => {
                saw_snapshot = true;
                let version = integer(&object["version"]).ok_or(ArchiveError::InvalidManifest(
                    "snapshot.version must be an integer.",
                ))?;
                if version == 0 || version > snapshot_max {
                    return Err(ArchiveError::SnapshotOutsideBoundary {
                        version,
                        max: snapshot_max,
                    });
                }
                if last_snapshot.is_some_and(|prev| version <= prev) {
                    return Err(ArchiveError::OutOfOrder {
                        kind: "snapshot",
                        previous: last_snapshot.unwrap_or(0),
                        found: version,
                    });
                }
                last_snapshot = Some(version);
                snapshot_count += 1;
                if object.get("invalidated").and_then(Value::as_bool) == Some(true) {
                    if object.get("text").is_some() {
                        return Err(ArchiveError::InvalidManifest(
                            "invalidated snapshot must omit text.",
                        ));
                    }
                    invalidated_snapshot_count += 1;
                }
            }
            _ => {
                unsupported_record_count += 1;
            }
        }
        visit(&object)?;
    }

    let Some((completion, completion_raw)) = completion else {
        return Err(ArchiveError::MissingCompletion);
    };
    if read_jsonl_line(&mut reader, line_no + 1)?.is_some() {
        return Err(ArchiveError::RecordsAfterCompletion);
    }
    // Any leftover bytes after a well-formed completion line (no trailing blank
    // line is allowed, but neither is a truncated extra record without `\n`).
    let mut tail = [0u8; 1];
    match reader.read(&mut tail) {
        Ok(0) => {}
        Ok(_) => return Err(ArchiveError::RecordsAfterCompletion),
        Err(error) => return Err(error.into()),
    }
    let _ = completion_raw;
    validate_completion(
        &completion,
        &manifest,
        hasher.finalize(),
        message_count,
        snapshot_count,
        invalidated_snapshot_count,
        first_source_id,
        last_source_id,
    )?;
    Ok(VerifiedArchive {
        manifest,
        completion,
        unsupported_record_count,
    })
}

/// Open `path` and verify it. Streaming; does not load the file into a `Vec<Record>`.
pub fn verify_archive_path<F>(path: &Path, visit: F) -> Result<VerifiedArchive, ArchiveError>
where
    F: FnMut(&Value) -> Result<(), ArchiveError>,
{
    verify_archive(File::open(path)?, visit)
}

fn read_jsonl_line(reader: &mut impl BufRead, line: u64) -> Result<Option<Vec<u8>>, ArchiveError> {
    let mut buf = Vec::new();
    let n = reader.read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Ok(None);
    }
    if buf.contains(&b'\r') {
        return Err(ArchiveError::InvalidLineEnding { line });
    }
    if !buf.ends_with(b"\n") {
        return Err(ArchiveError::MissingNewline { line });
    }
    if buf == b"\n" {
        return Err(ArchiveError::EmptyLine { line });
    }
    Ok(Some(buf))
}

fn parse_object(raw: &[u8], line: u64) -> Result<Value, ArchiveError> {
    let json = std::str::from_utf8(raw).map_err(|_| ArchiveError::Json {
        line,
        message: "line is not UTF-8.".to_string(),
    })?;
    let value: Value =
        serde_json::from_str(json.trim_end_matches('\n')).map_err(|error| ArchiveError::Json {
            line,
            message: error.to_string(),
        })?;
    if !value.is_object() {
        return Err(ArchiveError::Json {
            line,
            message: "line is not a JSON object.".to_string(),
        });
    }
    Ok(value)
}

fn integer(value: &Value) -> Option<u64> {
    value.as_u64()
}

fn validate_manifest(manifest: &Value) -> Result<(), ArchiveError> {
    if manifest.get("record").and_then(Value::as_str) != Some("manifest") {
        return Err(ArchiveError::InvalidFormat);
    }
    match manifest.get("format").and_then(Value::as_str) {
        Some(FORMAT) => {}
        _ => return Err(ArchiveError::InvalidFormat),
    }
    let version = integer(&manifest["archiveVersion"]).ok_or(ArchiveError::InvalidManifest(
        "archiveVersion must be an integer.",
    ))?;
    if version > ARCHIVE_VERSION {
        return Err(ArchiveError::UnsupportedArchiveVersion { version });
    }
    if version != ARCHIVE_VERSION {
        return Err(ArchiveError::InvalidManifest(
            "archiveVersion must be 1 for msn.channel.archive.v1.",
        ));
    }
    let source = manifest
        .get("source")
        .and_then(Value::as_object)
        .ok_or(ArchiveError::InvalidManifest("source is required."))?;
    let origin = source
        .get("origin")
        .and_then(Value::as_str)
        .ok_or(ArchiveError::InvalidManifest("source.origin is required."))?;
    let tenant = source
        .get("tenant")
        .and_then(Value::as_str)
        .ok_or(ArchiveError::InvalidManifest("source.tenant is required."))?;
    let channel = source
        .get("channel")
        .and_then(Value::as_str)
        .ok_or(ArchiveError::InvalidManifest("source.channel is required."))?;
    let created = source
        .get("channelCreatedAt")
        .and_then(Value::as_str)
        .ok_or(ArchiveError::InvalidManifest(
            "source.channelCreatedAt is required.",
        ))?;
    let digest =
        source
            .get("instanceId")
            .and_then(Value::as_str)
            .ok_or(ArchiveError::InvalidManifest(
                "source.instanceId is required.",
            ))?;
    if !is_hex64(digest) {
        return Err(ArchiveError::InvalidManifest(
            "source.instanceId must be 64 lowercase hex characters.",
        ));
    }
    if digest != instance_id(origin, tenant, channel, created) {
        return Err(ArchiveError::InstanceIdMismatch);
    }
    let boundary = manifest
        .get("boundary")
        .and_then(Value::as_object)
        .ok_or(ArchiveError::InvalidManifest("boundary is required."))?;
    for key in ["headCursor", "historyRevision", "after", "snapshotVersion"] {
        if integer(&boundary[key]).is_none() {
            return Err(ArchiveError::InvalidManifest(
                "boundary integers are required.",
            ));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_completion(
    completion: &Value,
    manifest: &Value,
    computed_hash: String,
    message_count: u64,
    snapshot_count: u64,
    invalidated_snapshot_count: u64,
    first_source_id: Option<u64>,
    last_source_id: Option<u64>,
) -> Result<(), ArchiveError> {
    if completion.get("record").and_then(Value::as_str) != Some("completion") {
        return Err(ArchiveError::InvalidCompletion(
            "record must be completion.",
        ));
    }
    if completion.get("status").and_then(Value::as_str) != Some("complete") {
        return Err(ArchiveError::InvalidCompletion("status must be complete."));
    }
    let expected_hash = completion
        .get("contentHash")
        .and_then(Value::as_str)
        .ok_or(ArchiveError::InvalidCompletion("contentHash is required."))?;
    if !is_hex64(expected_hash) {
        return Err(ArchiveError::InvalidCompletion(
            "contentHash must be 64 lowercase hex characters.",
        ));
    }
    if expected_hash != computed_hash {
        return Err(ArchiveError::ContentHashMismatch {
            expected: expected_hash.to_string(),
            actual: computed_hash,
        });
    }
    check_count(completion, "messageCount", message_count)?;
    check_count(completion, "snapshotCount", snapshot_count)?;
    check_count(
        completion,
        "invalidatedSnapshotCount",
        invalidated_snapshot_count,
    )?;
    match (
        integer(&completion["firstSourceId"]),
        integer(&completion["lastSourceId"]),
        first_source_id,
        last_source_id,
    ) {
        (None, None, None, None) => {}
        (Some(first), Some(last), Some(got_first), Some(got_last))
            if first == got_first && last == got_last => {}
        _ => {
            return Err(ArchiveError::InvalidCompletion(
                "firstSourceId/lastSourceId must match the exported messages (omitted when none).",
            ));
        }
    }
    let pinned = &manifest["boundary"];
    let repeated = completion
        .get("boundary")
        .and_then(Value::as_object)
        .ok_or(ArchiveError::InvalidCompletion("boundary is required."))?;
    for key in ["headCursor", "historyRevision", "snapshotVersion"] {
        if repeated.get(key) != pinned.get(key) {
            return Err(ArchiveError::InvalidCompletion(
                "completion.boundary must repeat the pinned headCursor, historyRevision and snapshotVersion.",
            ));
        }
    }
    Ok(())
}

fn check_count(completion: &Value, field: &'static str, actual: u64) -> Result<(), ArchiveError> {
    let expected = integer(&completion[field]).ok_or(ArchiveError::InvalidCompletion(
        "count fields must be integers.",
    ))?;
    if expected != actual {
        return Err(ArchiveError::CountMismatch {
            field,
            expected,
            actual,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "https://msn.example.workers.dev";
    const CREATED: &str = "2026-09-17T23:15:08.380Z";

    #[test]
    fn instance_id_is_deterministic_and_changes_after_reset() {
        let a = instance_id(ORIGIN, "main", "swarm-1114", CREATED);
        let b = instance_id(ORIGIN, "main", "swarm-1114", CREATED);
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(is_hex64(&a));
        // Same URL after a database reset: new createdAt ⇒ new instance.
        let reset = instance_id(ORIGIN, "main", "swarm-1114", "2026-09-18T00:00:00.000Z");
        assert_ne!(a, reset);
        assert_ne!(
            a,
            instance_id("https://other.example", "main", "swarm-1114", CREATED)
        );
        // Known vector: SHA-256 of the exact UTF-8 material.
        let material = format!("{INSTANCE_ID_PREFIX}\n{ORIGIN}\nmain\nswarm-1114\n{CREATED}");
        assert_eq!(a, sha256_hex(material.as_bytes()));
    }

    #[test]
    fn content_hash_is_deterministic_and_includes_newlines() {
        let bytes = b"{\"record\":\"manifest\"}\n{\"record\":\"message\"}\n";
        let a = content_hash(bytes);
        let b = content_hash(bytes);
        assert_eq!(a, b);
        assert!(is_hex64(&a));
        let mut hasher = ContentHasher::new();
        hasher.update(b"{\"record\":\"manifest\"}\n");
        hasher.update(b"{\"record\":\"message\"}\n");
        assert_eq!(a, hasher.finalize());
        assert_ne!(a, content_hash(b"{\"record\":\"manifest\"}\n"));
        // FIPS 180-4 SHA-256("abc").
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn import_keys_follow_archive_format_section_6() {
        let instance = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(
            import_idempotency_key(instance, 41),
            "imp-0123456789abcdef-41"
        );
        assert_eq!(
            import_snapshot_key(instance, 2),
            "imp-0123456789abcdef-snap-2"
        );
        assert_eq!(
            import_marker_key(instance, "begin"),
            "imp-0123456789abcdef-begin"
        );
        assert_ne!(
            import_idempotency_key(instance, 1),
            import_idempotency_key(&"ab".repeat(32), 1)
        );
    }

    fn sample_archive() -> (String, String) {
        let instance = instance_id(ORIGIN, "main", "general", CREATED);
        let manifest = serde_json::json!({
            "record": "manifest",
            "format": FORMAT,
            "archiveVersion": 1,
            "exportedAt": "2026-09-18T09:00:00.000Z",
            "exportedBy": "exporter",
            "producer": "msn-cli/0.1.0",
            "source": {
                "origin": ORIGIN,
                "tenant": "main",
                "channel": "general",
                "channelCreatedAt": CREATED,
                "instanceId": instance,
            },
            "boundary": {
                "headCursor": 2,
                "historyRevision": 0,
                "after": 0,
                "snapshotVersion": 1,
            }
        });
        let message = serde_json::json!({
            "record": "message",
            "sourceId": 1,
            "username": "alice",
            "text": "hi",
            "contentType": "text/plain",
            "createdAt": CREATED,
        });
        let snapshot = serde_json::json!({
            "record": "snapshot",
            "version": 1,
            "username": "planner",
            "coversThrough": 1,
            "historyRevision": 0,
            "createdAt": CREATED,
            "invalidated": false,
            "text": "# Checkpoint",
        });
        let mut body = String::new();
        for value in [&manifest, &message, &snapshot] {
            body.push_str(&serde_json::to_string(value).unwrap());
            body.push('\n');
        }
        let hash = content_hash(body.as_bytes());
        let completion = serde_json::json!({
            "record": "completion",
            "status": "complete",
            "messageCount": 1,
            "snapshotCount": 1,
            "invalidatedSnapshotCount": 0,
            "firstSourceId": 1,
            "lastSourceId": 1,
            "boundary": { "headCursor": 2, "historyRevision": 0, "snapshotVersion": 1 },
            "contentHash": hash,
        });
        body.push_str(&serde_json::to_string(&completion).unwrap());
        body.push('\n');
        (body, hash)
    }

    #[test]
    fn verify_archive_accepts_a_complete_stream() {
        let (body, hash) = sample_archive();
        let mut seen = 0;
        let verified = verify_archive(body.as_bytes(), |_| {
            seen += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(seen, 2);
        assert_eq!(verified.unsupported_record_count, 0);
        assert_eq!(verified.completion["contentHash"], hash);
        assert_eq!(verified.manifest["format"], FORMAT);
    }

    #[test]
    fn verify_archive_counts_unknown_records_instead_of_dropping_them() {
        let instance = instance_id(ORIGIN, "main", "general", CREATED);
        let manifest = serde_json::json!({
            "record": "manifest",
            "format": FORMAT,
            "archiveVersion": 1,
            "exportedAt": "2026-09-18T09:00:00.000Z",
            "exportedBy": "exporter",
            "producer": "msn-cli/0.1.0",
            "source": {
                "origin": ORIGIN, "tenant": "main", "channel": "general",
                "channelCreatedAt": CREATED, "instanceId": instance,
            },
            "boundary": { "headCursor": 1, "historyRevision": 0, "after": 0, "snapshotVersion": 0 },
        });
        let extra = serde_json::json!({"record":"future-note","keep":true});
        let mut body = format!(
            "{}\n{}\n",
            serde_json::to_string(&manifest).unwrap(),
            serde_json::to_string(&extra).unwrap()
        );
        let hash = content_hash(body.as_bytes());
        body.push_str(
            &serde_json::to_string(&serde_json::json!({
                "record": "completion",
                "status": "complete",
                "messageCount": 0,
                "snapshotCount": 0,
                "invalidatedSnapshotCount": 0,
                "boundary": { "headCursor": 1, "historyRevision": 0, "snapshotVersion": 0 },
                "contentHash": hash,
            }))
            .unwrap(),
        );
        body.push('\n');
        let mut kinds = Vec::new();
        let verified = verify_archive(body.as_bytes(), |row| {
            kinds.push(row["record"].as_str().unwrap().to_string());
            Ok(())
        })
        .unwrap();
        assert_eq!(kinds, ["future-note"]);
        assert_eq!(verified.unsupported_record_count, 1);
    }

    fn manifest_json(after: u64, head: u64, snapshot_version: u64) -> Value {
        let instance = instance_id(ORIGIN, "main", "general", CREATED);
        serde_json::json!({
            "record": "manifest",
            "format": FORMAT,
            "archiveVersion": 1,
            "exportedAt": "2026-09-18T09:00:00.000Z",
            "exportedBy": "exporter",
            "producer": "msn-cli/0.1.0",
            "source": {
                "origin": ORIGIN, "tenant": "main", "channel": "general",
                "channelCreatedAt": CREATED, "instanceId": instance,
            },
            "boundary": {
                "headCursor": head,
                "historyRevision": 0,
                "after": after,
                "snapshotVersion": snapshot_version,
            }
        })
    }

    fn message_json(id: u64) -> Value {
        serde_json::json!({
            "record": "message",
            "sourceId": id,
            "username": "alice",
            "text": "hi",
            "contentType": "text/plain",
            "createdAt": CREATED,
        })
    }

    fn snapshot_json(version: u64, invalidated: bool, text: Option<&str>) -> Value {
        let mut value = serde_json::json!({
            "record": "snapshot",
            "version": version,
            "username": "planner",
            "coversThrough": 1,
            "historyRevision": 0,
            "createdAt": CREATED,
            "invalidated": invalidated,
        });
        if let Some(text) = text {
            value["text"] = Value::String(text.to_string());
        }
        value
    }

    fn complete(
        manifest: &Value,
        body_rows: &[Value],
        message_count: u64,
        snapshot_count: u64,
    ) -> String {
        let mut body = serde_json::to_string(manifest).unwrap();
        body.push('\n');
        for row in body_rows {
            body.push_str(&serde_json::to_string(row).unwrap());
            body.push('\n');
        }
        let hash = content_hash(body.as_bytes());
        let first = body_rows
            .iter()
            .find(|row| row["record"] == "message")
            .and_then(|row| row["sourceId"].as_u64());
        let last = body_rows
            .iter()
            .rfind(|row| row["record"] == "message")
            .and_then(|row| row["sourceId"].as_u64());
        let mut completion = serde_json::json!({
            "record": "completion",
            "status": "complete",
            "messageCount": message_count,
            "snapshotCount": snapshot_count,
            "invalidatedSnapshotCount": 0,
            "boundary": {
                "headCursor": manifest["boundary"]["headCursor"],
                "historyRevision": 0,
                "snapshotVersion": manifest["boundary"]["snapshotVersion"],
            },
            "contentHash": hash,
        });
        if let (Some(first), Some(last)) = (first, last) {
            completion["firstSourceId"] = json_u64(first);
            completion["lastSourceId"] = json_u64(last);
        }
        body.push_str(&serde_json::to_string(&completion).unwrap());
        body.push('\n');
        body
    }

    fn json_u64(n: u64) -> Value {
        Value::Number(n.into())
    }

    #[test]
    fn verify_archive_reports_1_based_line_numbers() {
        match verify_archive(&b"not-json\n"[..], |_| Ok(())).unwrap_err() {
            ArchiveError::Json { line, .. } => assert_eq!(line, 1),
            other => panic!("{other}"),
        }
        let manifest = serde_json::to_string(&manifest_json(0, 1, 0)).unwrap();
        match verify_archive(format!("{manifest}\nnot-json\n").as_bytes(), |_| Ok(())).unwrap_err()
        {
            ArchiveError::Json { line, .. } => assert_eq!(line, 2),
            other => panic!("{other}"),
        }
    }

    #[test]
    fn verify_archive_enforces_message_and_snapshot_boundaries() {
        let ok = complete(
            &manifest_json(2, 5, 3),
            &[
                message_json(3),
                message_json(5),
                snapshot_json(1, false, Some("a")),
                snapshot_json(3, false, Some("b")),
            ],
            2,
            2,
        );
        verify_archive(ok.as_bytes(), |_| Ok(())).unwrap();

        for (after, head, id) in [(2, 5, 2), (2, 5, 6), (4, 5, 3)] {
            let body = complete(&manifest_json(after, head, 0), &[message_json(id)], 1, 0);
            assert!(
                matches!(
                    verify_archive(body.as_bytes(), |_| Ok(())).unwrap_err(),
                    ArchiveError::MessageOutsideBoundary { id: got, .. } if got == id
                ),
                "id={id} after={after} head={head}"
            );
        }

        for (max, version) in [(2, 0), (2, 3)] {
            let body = complete(
                &manifest_json(0, 1, max),
                &[snapshot_json(version, false, Some("x"))],
                0,
                1,
            );
            assert!(
                matches!(
                    verify_archive(body.as_bytes(), |_| Ok(())).unwrap_err(),
                    ArchiveError::SnapshotOutsideBoundary { version: got, .. } if got == version
                ),
                "version={version} max={max}"
            );
        }
    }

    #[test]
    fn verify_archive_rejects_out_of_order_and_message_after_snapshot() {
        let unordered = complete(
            &manifest_json(0, 5, 0),
            &[message_json(2), message_json(1)],
            2,
            0,
        );
        assert!(matches!(
            verify_archive(unordered.as_bytes(), |_| Ok(())).unwrap_err(),
            ArchiveError::OutOfOrder {
                kind: "message",
                ..
            }
        ));

        let snaps = complete(
            &manifest_json(0, 1, 3),
            &[
                snapshot_json(2, false, Some("a")),
                snapshot_json(1, false, Some("b")),
            ],
            0,
            2,
        );
        assert!(matches!(
            verify_archive(snaps.as_bytes(), |_| Ok(())).unwrap_err(),
            ArchiveError::OutOfOrder {
                kind: "snapshot",
                ..
            }
        ));

        let mixed = complete(
            &manifest_json(0, 2, 1),
            &[snapshot_json(1, false, Some("a")), message_json(1)],
            1,
            1,
        );
        assert!(matches!(
            verify_archive(mixed.as_bytes(), |_| Ok(())).unwrap_err(),
            ArchiveError::MessageAfterSnapshot { .. }
        ));
    }

    #[test]
    fn verify_archive_rejects_invalidated_text_and_count_mismatch() {
        let with_text = complete(
            &manifest_json(0, 1, 1),
            &[snapshot_json(1, true, Some("scrubbed"))],
            0,
            1,
        );
        assert!(
            verify_archive(with_text.as_bytes(), |_| Ok(()))
                .unwrap_err()
                .to_string()
                .contains("text")
        );

        let mut bad_counts = complete(&manifest_json(0, 1, 0), &[message_json(1)], 1, 0);
        bad_counts = bad_counts.replace("\"messageCount\":1", "\"messageCount\":2");
        assert!(matches!(
            verify_archive(bad_counts.as_bytes(), |_| Ok(())).unwrap_err(),
            ArchiveError::CountMismatch {
                field: "messageCount",
                ..
            }
        ));
    }

    #[test]
    fn verify_archive_rejects_a_second_manifest_and_counts_invalidated_snapshots() {
        let manifest = manifest_json(0, 1, 0);
        let mut two = format!(
            "{}\n{}\n",
            serde_json::to_string(&manifest).unwrap(),
            serde_json::to_string(&manifest).unwrap()
        );
        let hash = content_hash(two.as_bytes());
        two.push_str(
            &serde_json::to_string(&serde_json::json!({
                "record": "completion",
                "status": "complete",
                "messageCount": 0,
                "snapshotCount": 0,
                "invalidatedSnapshotCount": 0,
                "boundary": { "headCursor": 1, "historyRevision": 0, "snapshotVersion": 0 },
                "contentHash": hash,
            }))
            .unwrap(),
        );
        two.push('\n');
        assert!(
            verify_archive(two.as_bytes(), |_| Ok(()))
                .unwrap_err()
                .to_string()
                .contains("manifest")
        );

        let mut body = serde_json::to_string(&manifest_json(0, 1, 1)).unwrap();
        body.push('\n');
        body.push_str(&serde_json::to_string(&snapshot_json(1, true, None)).unwrap());
        body.push('\n');
        let hash = content_hash(body.as_bytes());
        body.push_str(
            &serde_json::to_string(&serde_json::json!({
                "record": "completion",
                "status": "complete",
                "messageCount": 0,
                "snapshotCount": 1,
                "invalidatedSnapshotCount": 1,
                "boundary": { "headCursor": 1, "historyRevision": 0, "snapshotVersion": 1 },
                "contentHash": hash,
            }))
            .unwrap(),
        );
        body.push('\n');
        let verified = verify_archive(body.as_bytes(), |_| Ok(())).unwrap();
        assert_eq!(verified.completion["invalidatedSnapshotCount"], 1);
        assert_eq!(verified.completion["snapshotCount"], 1);
    }
}
