//! `msn export`: stream a consistent `msn.channel.archive.v1` file.
//!
//! Verification contract:
//! Goal: write a complete portable archive of one channel's readable history, or
//! leave no `FILE` when the export is incomplete or inconsistent.
//! I1 pin catchup boundary before paging; page messages with after+limit
//! I2 validate every page (ascending ids, after < id <= headCursor, nextCursor,
//!    same tenant/channel) and fail without FILE
//! I3 concurrent appends beyond headCursor are omitted; archive names the boundary
//! I4 historyRevision change after the last page → exit 5, no FILE, .partial left
//! I5 410 snapshot_invalidated → metadata-only record; export still completes
//! I6 stream FILE.partial 0600, fsync, rename only after completion
//! I7 refuse to clobber FILE without --force; never write credentials
//! Out of scope: import, scheduled backups, credential transfer, consumer cursors.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use url::Url;

use crate::archive::{
    ARCHIVE_VERSION, ArchiveBoundary, Completion, ContentHasher, FORMAT, Manifest, MessageRecord,
    SnapshotRecord, SourceIdentity, instance_id,
};
use crate::client::{MsnClient, classify};
use crate::config::{CHANNELS_PAGE_LIMIT, MAX_SAFE_INTEGER, origin_key};
use crate::error::CliError;
use crate::identity::resolve_username;

const PAGE_LIMIT: u64 = 100;
const CATCHUP_PIN: &str = "limit=1&maxBytes=262144";

#[allow(clippy::too_many_arguments)]
pub fn export(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    selected_username: Option<&str>,
    out: &Path,
    after: u64,
    page_limit: u64,
    force: bool,
    stop: &AtomicBool,
) -> Result<(), CliError> {
    if !(1..=PAGE_LIMIT).contains(&page_limit) {
        return Err(CliError::usage("limit must be an integer from 1 to 100."));
    }
    refuse_existing_out(out, force)?;
    let exported_by = resolve_username(url, tenant, token, selected_username)?;
    let client = MsnClient::new(url)?;
    let pin = fetch_catchup(&client, tenant, token, channel)?;
    let created_at = find_channel_created_at(&client, tenant, token, channel)?;
    let origin = origin_key(url);
    let source = SourceIdentity {
        instance_id: instance_id(&origin, tenant, channel, &created_at),
        origin,
        tenant: tenant.to_string(),
        channel: channel.to_string(),
        channel_created_at: created_at,
    };
    let boundary = ArchiveBoundary {
        head_cursor: pin.head_cursor,
        history_revision: pin.history_revision,
        after: Some(after),
        snapshot_version: pin.snapshot_version,
    };
    let mut writer = PartialArchive::create(out, force)?;
    if stop.load(Ordering::SeqCst) {
        return Err(interrupted());
    }
    let manifest = Manifest {
        record: "manifest".to_string(),
        format: FORMAT.to_string(),
        archive_version: ARCHIVE_VERSION,
        exported_at: format_unix_ms(unix_ms()),
        exported_by,
        producer: format!("msn-cli/{}", env!("CARGO_PKG_VERSION")),
        source,
        boundary: boundary.clone(),
    };
    writer.write_hashed(&manifest)?;

    let mut stats = ExportStats::default();
    page_messages(
        &client,
        tenant,
        token,
        channel,
        after,
        page_limit,
        &pin,
        stop,
        &mut writer,
        &mut stats,
    )?;
    page_snapshots(
        &client,
        tenant,
        token,
        channel,
        page_limit,
        &pin,
        stop,
        &mut writer,
        &mut stats,
    )?;

    let check = fetch_catchup(&client, tenant, token, channel)?;
    if check.history_revision != pin.history_revision {
        return Err(CliError::conflict(
            "History changed during export. A redaction or snapshot invalidation intervened; no archive file was written.",
        ));
    }
    if stop.load(Ordering::SeqCst) {
        return Err(interrupted());
    }

    let content_hash = writer.digest();
    let completion = Completion {
        record: "completion".to_string(),
        status: "complete".to_string(),
        message_count: stats.message_count,
        snapshot_count: stats.snapshot_count,
        invalidated_snapshot_count: stats.invalidated_snapshot_count,
        first_source_id: stats.first_source_id,
        last_source_id: stats.last_source_id,
        boundary: ArchiveBoundary {
            head_cursor: pin.head_cursor,
            history_revision: pin.history_revision,
            after: None,
            snapshot_version: pin.snapshot_version,
        },
        content_hash: content_hash.clone(),
    };
    writer.finish(out, &completion)?;

    let mut summary = json!({
        "path": out.display().to_string(),
        "messageCount": stats.message_count,
        "snapshotCount": stats.snapshot_count,
        "invalidatedSnapshotCount": stats.invalidated_snapshot_count,
        "boundary": {
            "headCursor": pin.head_cursor,
            "historyRevision": pin.history_revision,
            "snapshotVersion": pin.snapshot_version,
        },
        "contentHash": content_hash,
        "status": "complete",
    });
    if let Some(first) = stats.first_source_id {
        summary["firstSourceId"] = json!(first);
    }
    if let Some(last) = stats.last_source_id {
        summary["lastSourceId"] = json!(last);
    }
    crate::agent::print_json(&summary)
}

#[derive(Debug, Clone, Copy)]
struct Pin {
    head_cursor: u64,
    history_revision: u64,
    snapshot_version: u64,
}

#[derive(Default)]
struct ExportStats {
    message_count: u64,
    snapshot_count: u64,
    invalidated_snapshot_count: u64,
    first_source_id: Option<u64>,
    last_source_id: Option<u64>,
}

fn interrupted() -> CliError {
    CliError::generic("Export interrupted before completion.")
}

fn refuse_existing_out(dest: &Path, force: bool) -> Result<(), CliError> {
    if dest.file_name().is_none() || dest.as_os_str().is_empty() {
        return Err(CliError::usage("--out must name a file."));
    }
    if dest.is_dir() {
        return Err(CliError::usage("--out must name a file, not a directory."));
    }
    if dest.exists() && !force {
        return Err(CliError::usage(format!(
            "Refusing to overwrite {}; pass --force.",
            dest.display()
        )));
    }
    Ok(())
}

fn fetch_catchup(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
) -> Result<Pin, CliError> {
    let page = fetch_json(
        client,
        &format!("/api/tenants/{tenant}/channels/{channel}/catchup?{CATCHUP_PIN}"),
        token,
    )?;
    Ok(Pin {
        head_cursor: integer(&page, "headCursor")?,
        history_revision: integer(&page, "historyRevision")?,
        snapshot_version: integer(&page, "snapshotVersion")?,
    })
}

fn find_channel_created_at(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
) -> Result<String, CliError> {
    let mut after = String::new();
    loop {
        let query = if after.is_empty() {
            format!("limit={CHANNELS_PAGE_LIMIT}")
        } else {
            format!("after={after}&limit={CHANNELS_PAGE_LIMIT}")
        };
        let page = fetch_json(
            client,
            &format!("/api/tenants/{tenant}/channels?{query}"),
            token,
        )?;
        let rows = page["channels"]
            .as_array()
            .ok_or_else(|| CliError::generic("Channel list was not JSON."))?;
        for row in rows {
            if row["name"].as_str() == Some(channel) {
                return row["createdAt"]
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .ok_or_else(|| CliError::generic("Channel createdAt is missing."));
            }
        }
        let more = page["hasMore"].as_bool().unwrap_or(false);
        let next = page["nextCursor"].as_str().unwrap_or("").to_string();
        if !more || next.is_empty() || next == after {
            return Err(CliError::not_found(format!(
                "Channel {channel} was not listed by the server."
            )));
        }
        after = next;
    }
}

#[allow(clippy::too_many_arguments)]
fn page_messages(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    mut after: u64,
    page_limit: u64,
    pin: &Pin,
    stop: &AtomicBool,
    writer: &mut PartialArchive,
    stats: &mut ExportStats,
) -> Result<(), CliError> {
    if after >= pin.head_cursor {
        return Ok(());
    }
    loop {
        if stop.load(Ordering::SeqCst) {
            return Err(interrupted());
        }
        let page = fetch_json(
            client,
            &format!(
                "/api/tenants/{tenant}/channels/{channel}/messages?after={after}&limit={page_limit}"
            ),
            token,
        )?;
        let rows = page["messages"]
            .as_array()
            .ok_or_else(|| CliError::generic("Message page was not JSON."))?;
        let mut previous = after;
        let mut reached_boundary = false;
        for row in rows {
            let id = integer(row, "id")?;
            if id <= previous
                || row["tenant"].as_str() != Some(tenant)
                || row["channel"].as_str() != Some(channel)
            {
                return Err(CliError::generic(
                    "Message page is unordered or belongs to another channel.",
                ));
            }
            previous = id;
            if id > pin.head_cursor {
                // Concurrent append past the pinned head. Stop; do not include it.
                reached_boundary = true;
                break;
            }
            writer.write_hashed(&message_record(row)?)?;
            if stats.first_source_id.is_none() {
                stats.first_source_id = Some(id);
            }
            stats.last_source_id = Some(id);
            stats.message_count += 1;
            if id == pin.head_cursor {
                reached_boundary = true;
            }
        }
        let next = integer(&page, "nextCursor")?;
        let more = page["hasMore"]
            .as_bool()
            .ok_or_else(|| CliError::generic("Message page is missing hasMore."))?;
        if !rows.is_empty() && next != integer(&rows[rows.len() - 1], "id")? {
            return Err(CliError::generic(
                "Message page nextCursor did not equal the last id.",
            ));
        }
        if rows.is_empty() && next != after {
            return Err(CliError::generic(
                "Empty message page nextCursor did not equal the request after.",
            ));
        }
        if more && rows.is_empty() {
            return Err(CliError::generic(
                "Message page claimed hasMore with no rows.",
            ));
        }
        if reached_boundary || !more {
            return Ok(());
        }
        after = next;
        if after >= pin.head_cursor {
            return Ok(());
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn page_snapshots(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    page_limit: u64,
    pin: &Pin,
    stop: &AtomicBool,
    writer: &mut PartialArchive,
    stats: &mut ExportStats,
) -> Result<(), CliError> {
    if pin.snapshot_version == 0 {
        return Ok(());
    }
    let mut after = 0;
    loop {
        if stop.load(Ordering::SeqCst) {
            return Err(interrupted());
        }
        let page = fetch_json(
            client,
            &format!(
                "/api/tenants/{tenant}/channels/{channel}/snapshots?after={after}&limit={page_limit}"
            ),
            token,
        )?;
        let rows = page["snapshots"]
            .as_array()
            .ok_or_else(|| CliError::generic("Snapshot page was not JSON."))?;
        let mut previous = after;
        let mut reached_boundary = false;
        for row in rows {
            let version = integer(row, "version")?;
            if version <= previous
                || row["tenant"].as_str().is_some_and(|value| value != tenant)
                || row["channel"]
                    .as_str()
                    .is_some_and(|value| value != channel)
            {
                return Err(CliError::generic(
                    "Snapshot page is unordered or belongs to another channel.",
                ));
            }
            previous = version;
            if version > pin.snapshot_version {
                reached_boundary = true;
                break;
            }
            if stop.load(Ordering::SeqCst) {
                return Err(interrupted());
            }
            let record = snapshot_record(client, tenant, token, channel, row)?;
            if record.invalidated {
                stats.invalidated_snapshot_count += 1;
            }
            writer.write_hashed(&record)?;
            stats.snapshot_count += 1;
            if version == pin.snapshot_version {
                reached_boundary = true;
            }
        }
        let next = integer(&page, "nextCursor")?;
        let more = page["hasMore"]
            .as_bool()
            .ok_or_else(|| CliError::generic("Snapshot page is missing hasMore."))?;
        if !rows.is_empty() && next != integer(&rows[rows.len() - 1], "version")? {
            return Err(CliError::generic(
                "Snapshot page nextCursor did not equal the last version.",
            ));
        }
        if rows.is_empty() && next != after {
            return Err(CliError::generic(
                "Empty snapshot page nextCursor did not equal the request after.",
            ));
        }
        if more && rows.is_empty() {
            return Err(CliError::generic(
                "Snapshot page claimed hasMore with no rows.",
            ));
        }
        if reached_boundary || !more {
            return Ok(());
        }
        after = next;
        if after >= pin.snapshot_version {
            return Ok(());
        }
    }
}

fn snapshot_record(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    meta: &Value,
) -> Result<SnapshotRecord, CliError> {
    let version = integer(meta, "version")?;
    let username = meta["username"]
        .as_str()
        .ok_or_else(|| CliError::generic("Snapshot metadata is missing username."))?
        .to_string();
    let covers_through = integer(meta, "coversThrough")?;
    let history_revision = integer(meta, "historyRevision")?;
    let created_at = meta["createdAt"]
        .as_str()
        .ok_or_else(|| CliError::generic("Snapshot metadata is missing createdAt."))?
        .to_string();
    let path = format!("/api/tenants/{tenant}/channels/{channel}/snapshots/{version}");
    let response = client.get(&path, Some(token))?;
    if response.status == 410 {
        // Never treat snapshot 410 as fatal: the body is already gone.
        return Ok(SnapshotRecord {
            record: "snapshot".to_string(),
            version,
            username,
            covers_through,
            history_revision,
            created_at,
            invalidated: true,
            text: None,
        });
    }
    classify(response.status, &response.body)?;
    let body: Value = serde_json::from_str(&response.body)
        .map_err(|_| CliError::generic("Snapshot body was not JSON."))?;
    let snapshot = &body["snapshot"];
    if snapshot["version"].as_u64() != Some(version)
        || snapshot["channel"]
            .as_str()
            .is_some_and(|value| value != channel)
    {
        return Err(CliError::generic(
            "Snapshot body did not match the requested version.",
        ));
    }
    let text = snapshot["text"]
        .as_str()
        .ok_or_else(|| CliError::generic("Valid snapshot is missing text."))?
        .to_string();
    Ok(SnapshotRecord {
        record: "snapshot".to_string(),
        version,
        username,
        covers_through,
        history_revision,
        created_at,
        invalidated: false,
        text: Some(text),
    })
}

fn message_record(row: &Value) -> Result<MessageRecord, CliError> {
    Ok(MessageRecord {
        record: "message".to_string(),
        source_id: integer(row, "id")?,
        username: row["username"]
            .as_str()
            .ok_or_else(|| CliError::generic("Message is missing username."))?
            .to_string(),
        text: row["text"]
            .as_str()
            .ok_or_else(|| CliError::generic("Message is missing text."))?
            .to_string(),
        content_type: row["contentType"]
            .as_str()
            .unwrap_or("text/plain")
            .to_string(),
        created_at: row["createdAt"]
            .as_str()
            .ok_or_else(|| CliError::generic("Message is missing createdAt."))?
            .to_string(),
        reply_to: row.get("replyTo").and_then(Value::as_u64),
        correlation_id: row
            .get("correlationId")
            .and_then(Value::as_str)
            .map(str::to_string),
        to: row.get("to").and_then(Value::as_str).map(str::to_string),
    })
}

fn fetch_json(client: &MsnClient, path: &str, token: &str) -> Result<Value, CliError> {
    let response = client.get(path, Some(token))?;
    classify(response.status, &response.body)?;
    serde_json::from_str(&response.body).map_err(|_| CliError::generic("Response was not JSON."))
}

fn integer(value: &Value, field: &str) -> Result<u64, CliError> {
    value[field]
        .as_u64()
        .filter(|n| *n <= MAX_SAFE_INTEGER)
        .ok_or_else(|| CliError::generic(format!("Invalid export {field}.")))
}

struct PartialArchive {
    file: File,
    hasher: ContentHasher,
}

impl PartialArchive {
    fn create(dest: &Path, force: bool) -> Result<Self, CliError> {
        if dest.file_name().is_none() || dest.as_os_str().is_empty() {
            return Err(CliError::usage("--out must name a file."));
        }
        if dest.is_dir() {
            return Err(CliError::usage("--out must name a file, not a directory."));
        }
        if dest.exists() && !force {
            return Err(CliError::usage(format!(
                "Refusing to overwrite {}; pass --force.",
                dest.display()
            )));
        }
        let partial = partial_path(dest);
        let mut opts = OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let file = opts.open(&partial)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&partial)?.permissions();
            perms.set_mode(0o600);
            fs::set_permissions(&partial, perms)?;
        }
        Ok(Self {
            file,
            hasher: ContentHasher::new(),
        })
    }

    fn write_hashed<T: serde::Serialize>(&mut self, value: &T) -> Result<(), CliError> {
        let line =
            serde_json::to_string(value).map_err(|error| CliError::generic(error.to_string()))?;
        self.file.write_all(line.as_bytes())?;
        self.file.write_all(b"\n")?;
        self.file.flush()?;
        self.hasher.update(line.as_bytes());
        self.hasher.update(b"\n");
        Ok(())
    }

    fn digest(&self) -> String {
        self.hasher.clone().finalize()
    }

    fn finish(mut self, dest: &Path, completion: &Completion) -> Result<(), CliError> {
        let line = serde_json::to_string(completion)
            .map_err(|error| CliError::generic(error.to_string()))?;
        self.file.write_all(line.as_bytes())?;
        self.file.write_all(b"\n")?;
        self.file.sync_all()?;
        drop(self.file);
        let partial = partial_path(dest);
        fs::rename(&partial, dest)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(dest)?.permissions();
            perms.set_mode(0o600);
            fs::set_permissions(dest, perms)?;
        }
        Ok(())
    }
}

pub(crate) fn partial_path(dest: &Path) -> PathBuf {
    PathBuf::from(format!("{}.partial", dest.display()))
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// UTC timestamp `YYYY-MM-DDTHH:MM:SS.sssZ` from Unix milliseconds.
pub(crate) fn format_unix_ms(millis: u64) -> String {
    let secs = millis / 1000;
    let ms = millis % 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{ms:03}Z")
}

/// Howard Hinnant civil-from-days: `z` is days since 1970-01-01.
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_unix_ms_known_instants() {
        assert_eq!(format_unix_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_unix_ms(1), "1970-01-01T00:00:00.001Z");
        // 2026-09-18T00:00:00.000Z
        assert_eq!(
            format_unix_ms(1_789_689_600_000),
            "2026-09-18T00:00:00.000Z"
        );
        assert_eq!(
            format_unix_ms(1_789_689_600_380),
            "2026-09-18T00:00:00.380Z"
        );
    }

    #[test]
    fn partial_path_appends_suffix() {
        assert_eq!(
            partial_path(Path::new("/tmp/channel.msnarchive.jsonl")),
            PathBuf::from("/tmp/channel.msnarchive.jsonl.partial")
        );
    }
}
