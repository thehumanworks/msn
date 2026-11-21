//! `msn import`: one-way copy of a verified archive into a destination channel.
//!
//! Verification contract:
//! Goal: copy archive history into DEST as `msn.import.v1` (or explicit task replay),
//! remapping references via a durable import map, without impersonating or writing cursors.
//! I1 dry-run writes nothing -> cli/tests/import.rs::given_archive_when_dry_run_then_no_writes
//! I2 clean import wraps as dest participant with remapped replyTo
//!    -> cli/tests/import.rs::given_archive_when_import_then_destination_receives_wrapped_messages
//! I3 duplicate import reuses Idempotency-Key and does not create new dest identities
//!    -> cli/tests/import.rs::given_already_imported_when_import_again_then_no_duplicates
//! I4 interrupted import resumes without duplication
//!    -> cli/tests/import.rs::given_partial_map_when_import_resumes_then_no_duplicates
//! I5 409 payload conflict under a reused identity is exit 5, no rewrite
//!    -> cli/tests/import.rs::given_409_payload_conflict_when_import_then_conflict
//! I6 missing reply/evidence left unset and reported
//!    -> cli/tests/import.rs::given_missing_reply_or_evidence_when_import_then_unresolved
//! I7 existing DEST refused without --allow-existing
//!    -> cli/tests/import.rs::given_existing_channel_when_import_without_allow_then_refused
//! I8 dest 401/403 / username_bound is auth (exit 3)
//!    -> cli/tests/import.rs::given_bound_name_rejection_when_import_then_auth
//! I9 invalidated snapshots are unavailable provenance, never published valid
//!    -> cli/tests/import.rs::given_invalidated_snapshot_when_import_then_not_published_as_valid
//! I10 deleted/missing evidence is not resurrected
//!    -> cli/tests/import.rs::given_deleted_evidence_when_import_then_not_resurrected
//! I11 malformed / unknown-schema archives are rejected
//!    -> cli/tests/import.rs::given_malformed_or_unknown_schema_when_import_then_rejected
//! I12 unknown record types are surfaced, not dropped
//!    -> cli/tests/import.rs::given_unknown_record_when_import_then_surfaced
//! I13 no reader or processing cursor files are created
//!    -> cli/tests/import.rs::given_import_when_complete_then_no_cursor_or_processing_files
//! I14 --trust replay-tasks warns on stderr and is the only live-board path
//!    -> cli/tests/import.rs::given_replay_tasks_when_import_then_warns_and_sends_unwrapped
//! I15 conflicting dest task slugs are reported, not silently replayed
//!    -> cli/tests/import.rs::given_conflicting_task_slugs_when_replay_then_reported
//! Equivalent mutants killed by those cases: omit the dry-run return; send
//! `source.username` or unwrapped `text`; drop the Idempotency-Key; treat 409 as
//! success; skip the existing-DEST refusal; POST invalidated snapshots to
//! `/snapshots`; write readers/processing files; skip the replay-tasks stderr
//! warning. cargo-mutants on this file is best-effort here (159 mutants; /tmp
//! tmpfs is too small for copies — use TMPDIR on disk).
//! Out of scope: mirroring, account provisioning, implicit merge, bidirectional sync.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;

use crate::agent::{fetch_json, print_json};
use crate::archive::{
    ArchiveError, VerifiedArchive, import_idempotency_key, import_marker_key, import_snapshot_key,
    verify_archive_path,
};
use crate::args::TrustPolicy;
use crate::client::{MsnClient, classify, error_message};
use crate::config::{CHANNELS_PAGE_LIMIT, origin_key};
use crate::cursor::{CursorLock, origin_hash};
use crate::error::CliError;
use crate::identity::resolve_username;
use crate::{Correlation, Payload, send_body};

const IMPORT_SCHEMA: &str = "msn.import.v1";
const MAP_SCHEMA: &str = "msn.import.map.v1";
const TASK_SCHEMA: &str = "msn.task.v1";
const REPLAY_TASKS_WARNING: &str = "Warning: --trust replay-tasks re-attributes actorship of imported task events to the importing participant. source.username is an unverified claim. This flag is never implied by another flag.";

pub struct ImportRequest<'a> {
    pub url: &'a Url,
    pub tenant: &'a str,
    pub token: &'a str,
    pub dest_channel: &'a str,
    pub selected_username: Option<&'a str>,
    pub archive: &'a Path,
    pub dry_run: bool,
    pub trust: TrustPolicy,
    pub state_file: Option<&'a Path>,
    pub allow_existing: bool,
    pub stop: &'a AtomicBool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ImportMap {
    schema: String,
    server: String,
    tenant: String,
    channel: String,
    #[serde(rename = "sourceInstanceId")]
    source_instance_id: String,
    trust: String,
    status: String,
    #[serde(rename = "importedCount")]
    imported_count: u64,
    #[serde(rename = "lastSourceId", skip_serializing_if = "Option::is_none")]
    last_source_id: Option<u64>,
    #[serde(rename = "beginMarkerId", skip_serializing_if = "Option::is_none")]
    begin_marker_id: Option<u64>,
    #[serde(rename = "completionMarkerId", skip_serializing_if = "Option::is_none")]
    completion_marker_id: Option<u64>,
    map: BTreeMap<String, u64>,
    #[serde(default)]
    snapshots: BTreeMap<String, SnapshotMapEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending: Option<PendingWrite>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SnapshotMapEntry {
    #[serde(rename = "destVersion")]
    dest_version: u64,
    #[serde(rename = "baseVersion")]
    base_version: u64,
    #[serde(rename = "historyRevision")]
    history_revision: u64,
    #[serde(rename = "coversThrough")]
    covers_through: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingWrite {
    kind: String,
    #[serde(rename = "snapshotVersion")]
    snapshot_version: u64,
    #[serde(rename = "baseVersion")]
    base_version: u64,
    #[serde(rename = "historyRevision")]
    history_revision: u64,
    #[serde(rename = "coversThrough")]
    covers_through: u64,
}

#[derive(Default)]
struct ArchiveBody {
    messages: Vec<Value>,
    snapshots: Vec<Value>,
    unsupported: Vec<Value>,
}

struct LoadedArchive {
    verified: VerifiedArchive,
    body: ArchiveBody,
    source: SourceInfo,
}

struct SourceInfo {
    origin: String,
    tenant: String,
    channel: String,
    instance_id: String,
    history_revision: u64,
}

struct Analysis {
    unresolved: Vec<Value>,
    losses: Vec<String>,
    conflicting_task_slugs: BTreeSet<String>,
    unknown_payloads: u64,
}

struct DestSend {
    id: u64,
    replayed: bool,
}

pub fn import(request: ImportRequest<'_>) -> Result<(), CliError> {
    let loaded = load_archive(request.archive)?;
    if request.trust == TrustPolicy::ReplayTasks {
        eprintln!("{REPLAY_TASKS_WARNING}");
        let _ = io::stderr().flush();
    }
    let username = resolve_username(
        request.url,
        request.tenant,
        request.token,
        request.selected_username,
    )?;
    let dest_exists = destination_exists(
        request.url,
        request.tenant,
        request.token,
        request.dest_channel,
    )?;
    let state_path = match request.state_file {
        Some(path) => path.to_path_buf(),
        None => default_import_path(
            request.url,
            request.tenant,
            request.dest_channel,
            &loaded.source.instance_id,
        )?,
    };
    let continuing = matching_import_map_exists(
        &state_path,
        request.url,
        request.tenant,
        request.dest_channel,
        &loaded.source.instance_id,
    );
    let dest_tasks = if dest_exists && request.trust == TrustPolicy::ReplayTasks {
        destination_task_slugs(
            request.url,
            request.tenant,
            request.token,
            request.dest_channel,
        )?
    } else {
        BTreeSet::new()
    };
    let refuse_existing = dest_exists && !request.allow_existing && !continuing;
    let analysis = analyze(&loaded, request.trust, refuse_existing, &dest_tasks);
    if request.dry_run {
        return print_dry_run(
            &request,
            &loaded,
            dest_exists,
            refuse_existing,
            &username,
            &analysis,
        );
    }
    if refuse_existing {
        return Err(CliError::conflict(existing_channel_message(
            request.dest_channel,
        )));
    }
    run_import(request, loaded, username, dest_exists, analysis, state_path)
}

fn load_archive(path: &Path) -> Result<LoadedArchive, CliError> {
    let mut body = ArchiveBody::default();
    let verified = verify_archive_path(path, |row| {
        match row.get("record").and_then(Value::as_str) {
            Some("message") => body.messages.push(row.clone()),
            Some("snapshot") => body.snapshots.push(row.clone()),
            _ => body.unsupported.push(row.clone()),
        }
        Ok(())
    })
    .map_err(archive_error)?;
    let source = source_info(&verified.manifest)?;
    Ok(LoadedArchive {
        verified,
        body,
        source,
    })
}

fn source_info(manifest: &Value) -> Result<SourceInfo, CliError> {
    let source = manifest
        .get("source")
        .ok_or_else(|| CliError::usage("Archive manifest is missing source."))?;
    Ok(SourceInfo {
        origin: required_str(source, "origin")?,
        tenant: required_str(source, "tenant")?,
        channel: required_str(source, "channel")?,
        instance_id: required_str(source, "instanceId")?,
        history_revision: manifest
            .get("boundary")
            .and_then(|b| b.get("historyRevision"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
    })
}

fn required_str(value: &Value, field: &str) -> Result<String, CliError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| CliError::usage(format!("Archive source.{field} is required.")))
}

fn analyze(
    loaded: &LoadedArchive,
    trust: TrustPolicy,
    refuse_existing: bool,
    dest_tasks: &BTreeSet<String>,
) -> Analysis {
    let source_ids: HashSet<u64> = loaded
        .body
        .messages
        .iter()
        .filter_map(|row| row.get("sourceId").and_then(Value::as_u64))
        .collect();
    let mut unresolved = Vec::new();
    let mut losses = Vec::new();
    let mut archive_task_slugs = BTreeSet::new();
    let mut unknown_payloads = 0;
    let mut task_inert = false;

    if refuse_existing {
        losses.push(existing_channel_message("<DEST>"));
    }

    if loaded.source.history_revision > 0 {
        losses.push(format!(
            "Source historyRevision is {}; redacted or deleted message bodies are not reconstructible.",
            loaded.source.history_revision
        ));
    }
    if !loaded.body.unsupported.is_empty() {
        losses.push(format!(
            "{} unsupported archive record(s) will not be imported.",
            loaded.body.unsupported.len()
        ));
    }

    for message in &loaded.body.messages {
        let source_id = message.get("sourceId").and_then(Value::as_u64).unwrap_or(0);
        if let Some(reply) = message.get("replyTo").and_then(Value::as_u64)
            && !source_ids.contains(&reply)
        {
            unresolved.push(json!({
                "kind": "replyTo",
                "sourceId": source_id,
                "target": reply,
            }));
        }
        if message.get("contentType").and_then(Value::as_str) == Some("application/json")
            && let Some(text) = message.get("text").and_then(Value::as_str)
        {
            match serde_json::from_str::<Value>(text) {
                Ok(payload)
                    if payload.get("schema").and_then(Value::as_str) == Some(TASK_SCHEMA) =>
                {
                    if let Some(slug) = payload.get("task").and_then(Value::as_str) {
                        archive_task_slugs.insert(slug.to_string());
                    }
                    if trust == TrustPolicy::Provenance {
                        task_inert = true;
                    }
                    if let Some(evidence) = payload.get("evidence").and_then(Value::as_array) {
                        for item in evidence {
                            if let Some(id) = item.as_u64()
                                && !source_ids.contains(&id)
                            {
                                unresolved.push(json!({
                                    "kind": "evidence",
                                    "sourceId": source_id,
                                    "target": id,
                                }));
                            }
                        }
                    }
                }
                Ok(_) => {
                    unknown_payloads += 1;
                    losses.push(format!(
                        "Message {source_id} has an unknown structured payload; it will be wrapped as provenance and is not fully restored."
                    ));
                }
                Err(_) => {
                    unknown_payloads += 1;
                    losses.push(format!(
                        "Message {source_id} claims application/json but is not JSON; it will be wrapped as provenance and is not fully restored."
                    ));
                }
            }
        }
    }
    if task_inert {
        losses.push(
            "Imported msn.task.v1 events will not project into the destination task board under --trust provenance.".to_string(),
        );
    }
    let conflicting_task_slugs: BTreeSet<String> = archive_task_slugs
        .intersection(dest_tasks)
        .cloned()
        .collect();
    for slug in &conflicting_task_slugs {
        losses.push(format!(
            "Destination already has task {slug}; imported events for that slug will stay wrapped as provenance."
        ));
    }
    for snapshot in &loaded.body.snapshots {
        let version = snapshot.get("version").and_then(Value::as_u64).unwrap_or(0);
        let covers = snapshot
            .get("coversThrough")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if snapshot.get("invalidated").and_then(Value::as_bool) == Some(true) {
            losses.push(format!(
                "Snapshot {version} is invalidated; it will be recorded as explicitly-unavailable provenance and never published as valid."
            ));
        } else if covers != 0 && !source_ids.contains(&covers) {
            unresolved.push(json!({
                "kind": "coversThrough",
                "snapshotVersion": version,
                "target": covers,
            }));
        }
    }
    Analysis {
        unresolved,
        losses,
        conflicting_task_slugs,
        unknown_payloads,
    }
}

fn existing_channel_message(channel: &str) -> String {
    format!(
        "Destination channel {channel} already exists. Refusing to append into live history. Pass --allow-existing if that is an explicit decision; msn never merges implicitly."
    )
}

fn print_dry_run(
    request: &ImportRequest<'_>,
    loaded: &LoadedArchive,
    dest_exists: bool,
    refuse_existing: bool,
    username: &str,
    analysis: &Analysis,
) -> Result<(), CliError> {
    let invalidated = loaded
        .body
        .snapshots
        .iter()
        .filter(|row| row.get("invalidated").and_then(Value::as_bool) == Some(true))
        .count();
    let unsupported: Vec<Value> = loaded
        .body
        .unsupported
        .iter()
        .map(|row| {
            json!({
                "record": row.get("record"),
            })
        })
        .collect();
    print_json(&json!({
        "dryRun": true,
        "writes": false,
        "source": {
            "origin": loaded.source.origin,
            "tenant": loaded.source.tenant,
            "channel": loaded.source.channel,
            "instanceId": loaded.source.instance_id,
        },
        "destination": {
            "origin": origin_key(request.url),
            "tenant": request.tenant,
            "channel": request.dest_channel,
            "exists": dest_exists,
            "username": username,
            "wouldCreate": !dest_exists,
            "wouldRefuseExisting": refuse_existing,
        },
        "trust": request.trust.as_str(),
        "messageCount": loaded.body.messages.len(),
        "snapshotCount": loaded.body.snapshots.len(),
        "invalidatedSnapshotCount": invalidated,
        "unsupportedRecordCount": loaded.verified.unsupported_record_count,
        "unsupportedRecords": unsupported,
        "unresolvedReferences": analysis.unresolved,
        "anticipatedLosses": analysis.losses,
        "unknownStructuredPayloads": analysis.unknown_payloads,
    }))
}

fn run_import(
    request: ImportRequest<'_>,
    loaded: LoadedArchive,
    username: String,
    dest_exists: bool,
    analysis: Analysis,
    state_path: PathBuf,
) -> Result<(), CliError> {
    if let Some(parent) = state_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let lock = CursorLock::acquire(&state_path)?;
    let state_path = lock.cursor_path().to_path_buf();
    let mut map = load_or_create_map(
        &state_path,
        request.url,
        request.tenant,
        request.dest_channel,
        &loaded.source.instance_id,
        request.trust,
    )?;
    if request.stop.load(Ordering::SeqCst) {
        return interrupted_report(&state_path, &map, &loaded, &request, &analysis);
    }

    let client = MsnClient::new(request.url)?;
    if !dest_exists {
        create_destination(&client, request.tenant, request.token, request.dest_channel)?;
    }

    let mut replayed = 0u64;
    let mut imported = 0u64;
    let mut snapshot_imported = 0u64;
    let mut unavailable = 0u64;
    let mut conflicts = Vec::new();

    if request.stop.load(Ordering::SeqCst) {
        persist_map(&state_path, &map)?;
        return interrupted_report(&state_path, &map, &loaded, &request, &analysis);
    }
    let sent = send_json_message(
        &client,
        request.tenant,
        request.token,
        request.dest_channel,
        &username,
        &begin_envelope(&loaded),
        &import_marker_key(&loaded.source.instance_id, "begin"),
        None,
    )?;
    map.begin_marker_id = Some(sent.id);
    map.status = "in-progress".to_string();
    persist_map(&state_path, &map)?;
    if sent.replayed {
        replayed += 1;
    } else {
        imported += 1;
    }

    for message in &loaded.body.messages {
        if request.stop.load(Ordering::SeqCst) {
            persist_map(&state_path, &map)?;
            return interrupted_report(&state_path, &map, &loaded, &request, &analysis);
        }
        let source_id = message
            .get("sourceId")
            .and_then(Value::as_u64)
            .ok_or_else(|| CliError::usage("Archive message is missing sourceId."))?;
        let key = import_idempotency_key(&loaded.source.instance_id, source_id);
        let (payload, dest_reply, skip_live_task) = message_payload(
            message,
            &loaded.source,
            &map,
            request.trust,
            &analysis.conflicting_task_slugs,
        )?;
        if skip_live_task {
            conflicts.push(json!({
                "kind": "task-slug",
                "sourceId": source_id,
                "task": task_slug(message),
            }));
        }
        let sent = match send_payload(
            &client,
            request.tenant,
            request.token,
            request.dest_channel,
            &username,
            &payload,
            &key,
            dest_reply,
        ) {
            Ok(sent) => sent,
            Err(error) if error.exit_code() == 5 => {
                persist_map(&state_path, &map)?;
                return Err(CliError::conflict(format!(
                    "CONFLICT: destination rejected Idempotency-Key {key} with a different payload. Source id {source_id} was not rewritten."
                )));
            }
            Err(error) => {
                persist_map(&state_path, &map)?;
                return Err(error);
            }
        };
        map.map.insert(source_id.to_string(), sent.id);
        map.last_source_id = Some(source_id);
        map.imported_count = map.map.len() as u64;
        map.status = "in-progress".to_string();
        persist_map(&state_path, &map)?;
        if sent.replayed {
            replayed += 1;
        } else {
            imported += 1;
        }
    }

    for snapshot in &loaded.body.snapshots {
        if request.stop.load(Ordering::SeqCst) {
            persist_map(&state_path, &map)?;
            return interrupted_report(&state_path, &map, &loaded, &request, &analysis);
        }
        let version = snapshot
            .get("version")
            .and_then(Value::as_u64)
            .ok_or_else(|| CliError::usage("Archive snapshot is missing version."))?;
        if snapshot.get("invalidated").and_then(Value::as_bool) == Some(true) {
            let key = import_marker_key(
                &loaded.source.instance_id,
                &format!("snapunavail-{version}"),
            );
            let sent = send_json_message(
                &client,
                request.tenant,
                request.token,
                request.dest_channel,
                &username,
                &unavailable_snapshot_envelope(&loaded.source, snapshot),
                &key,
                None,
            )?;
            unavailable += 1;
            if sent.replayed {
                replayed += 1;
            } else {
                imported += 1;
            }
            continue;
        }
        if map.snapshots.contains_key(&version.to_string()) {
            snapshot_imported += 1;
            continue;
        }
        let covers_source = snapshot
            .get("coversThrough")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let Some(covers_through) = (if covers_source == 0 {
            Some(0)
        } else {
            map.map.get(&covers_source.to_string()).copied()
        }) else {
            continue;
        };
        let pending = match &map.pending {
            Some(pending) if pending.snapshot_version == version => pending.clone(),
            _ => {
                let pin =
                    fetch_dest_pin(&client, request.tenant, request.token, request.dest_channel)?;
                let pending = PendingWrite {
                    kind: "snapshot".to_string(),
                    snapshot_version: version,
                    base_version: pin.0,
                    history_revision: pin.1,
                    covers_through,
                };
                map.pending = Some(pending.clone());
                persist_map(&state_path, &map)?;
                pending
            }
        };
        let text = snapshot
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                CliError::usage(format!("Archive snapshot {version} is missing text."))
            })?;
        let key = import_snapshot_key(&loaded.source.instance_id, version);
        let body = json!({
            "username": username,
            "text": text,
            "coversThrough": pending.covers_through,
            "baseVersion": pending.base_version,
            "historyRevision": pending.history_revision,
        });
        let sent = post_snapshot(
            &client,
            request.tenant,
            request.token,
            request.dest_channel,
            &key,
            &body,
        )?;
        map.snapshots.insert(
            version.to_string(),
            SnapshotMapEntry {
                dest_version: sent.id,
                base_version: pending.base_version,
                history_revision: pending.history_revision,
                covers_through: pending.covers_through,
            },
        );
        map.pending = None;
        persist_map(&state_path, &map)?;
        snapshot_imported += 1;
        if sent.replayed {
            replayed += 1;
        }
    }

    if request.stop.load(Ordering::SeqCst) {
        persist_map(&state_path, &map)?;
        return interrupted_report(&state_path, &map, &loaded, &request, &analysis);
    }
    let sent = send_json_message(
        &client,
        request.tenant,
        request.token,
        request.dest_channel,
        &username,
        &complete_envelope(&loaded, &map),
        &import_marker_key(&loaded.source.instance_id, "done"),
        None,
    )?;
    map.completion_marker_id = Some(sent.id);
    if sent.replayed {
        replayed += 1;
    } else {
        imported += 1;
    }
    map.status = "complete".to_string();
    persist_map(&state_path, &map)?;

    print_json(&final_report(
        &request,
        &loaded,
        &map,
        &state_path,
        &username,
        &analysis,
        dest_exists,
        imported,
        replayed,
        snapshot_imported,
        unavailable,
        conflicts,
        "complete",
        None,
    ))
}

fn message_payload(
    message: &Value,
    source: &SourceInfo,
    map: &ImportMap,
    trust: TrustPolicy,
    conflicting_slugs: &BTreeSet<String>,
) -> Result<(Payload, Option<u64>, bool), CliError> {
    let source_id = message
        .get("sourceId")
        .and_then(Value::as_u64)
        .ok_or_else(|| CliError::usage("Archive message is missing sourceId."))?;
    let dest_reply = message
        .get("replyTo")
        .and_then(Value::as_u64)
        .and_then(|id| map.map.get(&id.to_string()).copied());
    let text = message
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let content_type = message
        .get("contentType")
        .and_then(Value::as_str)
        .unwrap_or("text/plain");
    let parsed_task = (content_type == "application/json")
        .then(|| serde_json::from_str::<Value>(text).ok())
        .flatten()
        .filter(|value| value.get("schema").and_then(Value::as_str) == Some(TASK_SCHEMA));
    let slug = parsed_task
        .as_ref()
        .and_then(|value| value.get("task").and_then(Value::as_str))
        .map(str::to_string);
    let conflict = slug
        .as_ref()
        .is_some_and(|name| conflicting_slugs.contains(name));
    if trust == TrustPolicy::ReplayTasks
        && let Some(mut task) = parsed_task
        && !conflict
    {
        remap_task_evidence(&mut task, map);
        let text =
            serde_json::to_string(&task).map_err(|error| CliError::generic(error.to_string()))?;
        return Ok((
            Payload {
                text,
                content_type: Some("application/json"),
            },
            dest_reply,
            false,
        ));
    }
    let envelope = import_envelope(source, message, source_id, text, content_type);
    let text =
        serde_json::to_string(&envelope).map_err(|error| CliError::generic(error.to_string()))?;
    Ok((
        Payload {
            text,
            content_type: Some("application/json"),
        },
        dest_reply,
        conflict,
    ))
}

fn remap_task_evidence(task: &mut Value, map: &ImportMap) {
    let Some(Value::Array(items)) = task.get("evidence").cloned() else {
        return;
    };
    let remapped: Vec<Value> = items
        .iter()
        .filter_map(Value::as_u64)
        .filter_map(|id| map.map.get(&id.to_string()).copied())
        .map(|id| json!(id))
        .collect();
    if remapped.is_empty() {
        task.as_object_mut().map(|obj| obj.remove("evidence"));
    } else {
        task["evidence"] = Value::Array(remapped);
    }
}

fn task_slug(message: &Value) -> Value {
    message
        .get("text")
        .and_then(Value::as_str)
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|value| value.get("task").cloned())
        .unwrap_or(Value::Null)
}

fn import_envelope(
    source: &SourceInfo,
    message: &Value,
    source_id: u64,
    text: &str,
    content_type: &str,
) -> Value {
    let mut provenance = serde_json::Map::new();
    if let Some(reply) = message.get("replyTo").and_then(Value::as_u64) {
        provenance.insert("replyTo".to_string(), json!(reply));
    }
    if let Some(quote) = message.get("quote").and_then(Value::as_str) {
        provenance.insert("quote".to_string(), json!(quote));
    }
    if let Some(correlation) = message.get("correlationId").and_then(Value::as_str) {
        provenance.insert("correlationId".to_string(), json!(correlation));
    }
    if let Some(to) = message.get("to").and_then(Value::as_str) {
        provenance.insert("to".to_string(), json!(to));
    }
    // A question's choices, an answer and a question's first answer (ADR 0065) are kept as
    // provenance only: the import posts plain messages, so it never asks or answers again.
    if let Some(choices) = message.get("choices").filter(|value| value.is_array()) {
        provenance.insert("choices".to_string(), choices.clone());
    }
    if let Some(answer) = message.get("answer").and_then(Value::as_str) {
        provenance.insert("answer".to_string(), json!(answer));
    }
    if let Some(answered) = message.get("answered").filter(|value| value.is_object()) {
        provenance.insert("answered".to_string(), answered.clone());
    }
    if let Some(answerer) = message.get("answerer").and_then(Value::as_str) {
        provenance.insert("answerer".to_string(), json!(answerer));
    }
    let mut origin = json!({
        "instanceId": source.instance_id,
        "origin": source.origin,
        "tenant": source.tenant,
        "channel": source.channel,
        "messageId": source_id,
        "username": message.get("username").and_then(Value::as_str).unwrap_or(""),
        "createdAt": message.get("createdAt").and_then(Value::as_str).unwrap_or(""),
    });
    // An edited source message (ADR 0052) keeps when its sender last changed it.
    if let Some(edited) = message.get("editedAt").and_then(Value::as_str) {
        origin["editedAt"] = json!(edited);
    }
    json!({
        "schema": IMPORT_SCHEMA,
        "source": origin,
        "payload": {
            "contentType": content_type,
            "text": text,
        },
        "provenance": provenance,
    })
}

fn begin_envelope(loaded: &LoadedArchive) -> Value {
    json!({
        "schema": IMPORT_SCHEMA,
        "source": {
            "instanceId": loaded.source.instance_id,
            "origin": loaded.source.origin,
            "tenant": loaded.source.tenant,
            "channel": loaded.source.channel,
        },
        "payload": {
            "kind": "import-begin",
            "messageCount": loaded.body.messages.len(),
            "snapshotCount": loaded.body.snapshots.len(),
        },
        "provenance": {},
    })
}

fn complete_envelope(loaded: &LoadedArchive, map: &ImportMap) -> Value {
    json!({
        "schema": IMPORT_SCHEMA,
        "source": {
            "instanceId": loaded.source.instance_id,
            "origin": loaded.source.origin,
            "tenant": loaded.source.tenant,
            "channel": loaded.source.channel,
        },
        "payload": {
            "kind": "import-complete",
            "importedCount": map.imported_count,
            "lastSourceId": map.last_source_id,
        },
        "provenance": {},
    })
}

fn unavailable_snapshot_envelope(source: &SourceInfo, snapshot: &Value) -> Value {
    json!({
        "schema": IMPORT_SCHEMA,
        "source": {
            "instanceId": source.instance_id,
            "origin": source.origin,
            "tenant": source.tenant,
            "channel": source.channel,
            "snapshotVersion": snapshot.get("version"),
            "username": snapshot.get("username"),
            "createdAt": snapshot.get("createdAt"),
        },
        "payload": {
            "kind": "snapshot-unavailable",
            "invalidated": true,
            "coversThrough": snapshot.get("coversThrough"),
        },
        "provenance": {},
    })
}

#[allow(clippy::too_many_arguments)]
fn send_payload(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    username: &str,
    payload: &Payload,
    key: &str,
    reply_to: Option<u64>,
) -> Result<DestSend, CliError> {
    let body = send_body(
        username,
        payload,
        &Correlation {
            reply_to,
            ..Correlation::default()
        },
    );
    post_message(client, tenant, token, channel, key, &body)
}

#[allow(clippy::too_many_arguments)]
fn send_json_message(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    username: &str,
    envelope: &Value,
    key: &str,
    reply_to: Option<u64>,
) -> Result<DestSend, CliError> {
    let text =
        serde_json::to_string(envelope).map_err(|error| CliError::generic(error.to_string()))?;
    send_payload(
        client,
        tenant,
        token,
        channel,
        username,
        &Payload {
            text,
            content_type: Some("application/json"),
        },
        key,
        reply_to,
    )
}

fn post_message(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    key: &str,
    body: &Value,
) -> Result<DestSend, CliError> {
    let response = client.post_json(
        &format!("/api/tenants/{tenant}/channels/{channel}/messages"),
        token,
        &[("Idempotency-Key", key)],
        body,
    )?;
    parse_dest_send(response.status, &response.body, "message")
}

fn post_snapshot(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
    key: &str,
    body: &Value,
) -> Result<DestSend, CliError> {
    let response = client.post_json(
        &format!("/api/tenants/{tenant}/channels/{channel}/snapshots"),
        token,
        &[("Idempotency-Key", key)],
        body,
    )?;
    parse_dest_send(response.status, &response.body, "snapshot")
}

fn parse_dest_send(status: u16, body: &str, field: &str) -> Result<DestSend, CliError> {
    if status == 409 {
        return Err(CliError::conflict(error_message(status, body)));
    }
    classify(status, body)?;
    let value: Value = serde_json::from_str(body)
        .map_err(|_| CliError::generic("Destination response was not JSON."))?;
    let id = value
        .get(field)
        .and_then(|row| row.get(if field == "snapshot" { "version" } else { "id" }))
        .and_then(Value::as_u64)
        .ok_or_else(|| CliError::generic(format!("Destination {field} id is missing.")))?;
    Ok(DestSend {
        id,
        replayed: value
            .get("replayed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn create_destination(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
) -> Result<(), CliError> {
    let response = client.put(&format!("/api/tenants/{tenant}/channels/{channel}"), token)?;
    classify(response.status, &response.body)
}

fn destination_exists(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
) -> Result<bool, CliError> {
    let client = MsnClient::new(url)?;
    let mut after = String::new();
    loop {
        let query = if after.is_empty() {
            format!("limit={CHANNELS_PAGE_LIMIT}")
        } else {
            format!("after={after}&limit={CHANNELS_PAGE_LIMIT}")
        };
        let page = fetch_json(
            &client,
            &format!("/api/tenants/{tenant}/channels?{query}"),
            token,
        )?;
        let rows = page
            .get("channels")
            .and_then(Value::as_array)
            .ok_or_else(|| CliError::generic("Channel list was not JSON."))?;
        if rows
            .iter()
            .any(|row| row.get("name").and_then(Value::as_str) == Some(channel))
        {
            return Ok(true);
        }
        let more = page
            .get("hasMore")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let next = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if !more || next.is_empty() || next == after {
            return Ok(false);
        }
        after = next;
    }
}

fn destination_task_slugs(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
) -> Result<BTreeSet<String>, CliError> {
    let client = MsnClient::new(url)?;
    let mut after = 0u64;
    let mut slugs = BTreeSet::new();
    loop {
        let page = fetch_json(
            &client,
            &format!("/api/tenants/{tenant}/channels/{channel}/messages?after={after}&limit=100"),
            token,
        )?;
        let rows = page
            .get("messages")
            .and_then(Value::as_array)
            .ok_or_else(|| CliError::generic("Destination message page was not JSON."))?;
        for row in rows {
            if let Some(text) = row.get("text").and_then(Value::as_str)
                && let Ok(payload) = serde_json::from_str::<Value>(text)
                && payload.get("schema").and_then(Value::as_str) == Some(TASK_SCHEMA)
                && let Some(task) = payload.get("task").and_then(Value::as_str)
            {
                slugs.insert(task.to_string());
            }
            if let Some(id) = row.get("id").and_then(Value::as_u64) {
                after = id;
            }
        }
        if !page
            .get("hasMore")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Ok(slugs);
        }
        if rows.is_empty() {
            return Ok(slugs);
        }
    }
}

fn fetch_dest_pin(
    client: &MsnClient,
    tenant: &str,
    token: &str,
    channel: &str,
) -> Result<(u64, u64), CliError> {
    let page = fetch_json(
        client,
        &format!("/api/tenants/{tenant}/channels/{channel}/catchup?limit=1&maxBytes=262144"),
        token,
    )?;
    Ok((
        page.get("snapshotVersion")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        page.get("historyRevision")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    ))
}

fn matching_import_map_exists(
    path: &Path,
    url: &Url,
    tenant: &str,
    channel: &str,
    instance_id: &str,
) -> bool {
    let Ok(raw) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(map) = serde_json::from_str::<ImportMap>(&raw) else {
        return false;
    };
    map.schema == MAP_SCHEMA
        && map.server == origin_key(url)
        && map.tenant == tenant
        && map.channel == channel
        && map.source_instance_id == instance_id
}

fn default_import_path(
    url: &Url,
    tenant: &str,
    channel: &str,
    instance_id: &str,
) -> Result<PathBuf, CliError> {
    let state_home = match std::env::var_os("XDG_STATE_HOME") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => match std::env::var_os("HOME") {
            Some(home) if !home.is_empty() => PathBuf::from(home).join(".local").join("state"),
            _ => {
                return Err(CliError::usage(
                    "Set HOME (or XDG_STATE_HOME), or pass --state-file.",
                ));
            }
        },
    };
    Ok(state_home
        .join("msn")
        .join(origin_hash(url))
        .join(tenant)
        .join("imports")
        .join(instance_id)
        .join(format!("{channel}.json")))
}

fn load_or_create_map(
    path: &Path,
    url: &Url,
    tenant: &str,
    channel: &str,
    instance_id: &str,
    trust: TrustPolicy,
) -> Result<ImportMap, CliError> {
    match fs::read_to_string(path) {
        Ok(raw) => {
            let map: ImportMap = serde_json::from_str(&raw).map_err(|_| {
                CliError::usage("Import state file is not a valid msn.import.map.v1 document.")
            })?;
            if map.schema != MAP_SCHEMA
                || map.server != origin_key(url)
                || map.tenant != tenant
                || map.channel != channel
                || map.source_instance_id != instance_id
            {
                return Err(CliError::usage(
                    "Import state file belongs to a different destination or source instance.",
                ));
            }
            if map.trust != trust.as_str() && map.status != "complete" {
                return Err(CliError::conflict(format!(
                    "Import state file is in-progress under --trust {}; refusing to continue with --trust {}.",
                    map.trust,
                    trust.as_str()
                )));
            }
            Ok(map)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ImportMap {
            schema: MAP_SCHEMA.to_string(),
            server: origin_key(url),
            tenant: tenant.to_string(),
            channel: channel.to_string(),
            source_instance_id: instance_id.to_string(),
            trust: trust.as_str().to_string(),
            status: "in-progress".to_string(),
            imported_count: 0,
            last_source_id: None,
            begin_marker_id: None,
            completion_marker_id: None,
            map: BTreeMap::new(),
            snapshots: BTreeMap::new(),
            pending: None,
        }),
        Err(error) => Err(error.into()),
    }
}

fn persist_map(path: &Path, map: &ImportMap) -> Result<(), CliError> {
    let payload =
        serde_json::to_string(map).map_err(|error| CliError::generic(error.to_string()))?;
    let tmp = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
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

fn interrupted_report(
    state_path: &Path,
    map: &ImportMap,
    loaded: &LoadedArchive,
    request: &ImportRequest<'_>,
    analysis: &Analysis,
) -> Result<(), CliError> {
    persist_map(state_path, map)?;
    let resume = format!(
        "msn import {} --channel {} --state-file {}",
        request.archive.display(),
        request.dest_channel,
        state_path.display()
    );
    print_json(&final_report(
        request,
        loaded,
        map,
        state_path,
        "",
        analysis,
        false,
        map.imported_count,
        0,
        0,
        0,
        Vec::new(),
        "in-progress",
        Some(resume.clone()),
    ))?;
    Err(CliError::generic(format!(
        "Import interrupted (status in-progress, lastSourceId {:?}). Resume with: {resume}",
        map.last_source_id
    )))
}

#[allow(clippy::too_many_arguments)]
fn final_report(
    request: &ImportRequest<'_>,
    loaded: &LoadedArchive,
    map: &ImportMap,
    state_path: &Path,
    username: &str,
    analysis: &Analysis,
    dest_existed: bool,
    imported: u64,
    replayed: u64,
    snapshot_imported: u64,
    unavailable: u64,
    conflicts: Vec<Value>,
    status: &str,
    resume: Option<String>,
) -> Value {
    let unsupported: Vec<Value> = loaded
        .body
        .unsupported
        .iter()
        .map(|row| json!({ "record": row.get("record") }))
        .collect();
    json!({
        "status": status,
        "source": {
            "origin": loaded.source.origin,
            "tenant": loaded.source.tenant,
            "channel": loaded.source.channel,
            "instanceId": loaded.source.instance_id,
        },
        "destination": {
            "origin": origin_key(request.url),
            "tenant": request.tenant,
            "channel": request.dest_channel,
            "username": username,
            "existed": dest_existed,
        },
        "trust": request.trust.as_str(),
        "importedMessages": imported,
        "replayedMessages": replayed,
        "importedSnapshots": snapshot_imported,
        "unavailableSnapshots": unavailable,
        "unsupportedRecords": unsupported,
        "unresolvedReferences": analysis.unresolved,
        "losses": analysis.losses,
        "conflicts": conflicts,
        "lastSourceId": map.last_source_id,
        "stateFile": state_path.display().to_string(),
        "resume": resume,
        "redactionsNotReconstructible": loaded.source.history_revision > 0,
    })
}

fn archive_error(error: ArchiveError) -> CliError {
    match error {
        ArchiveError::Io(error) => CliError::generic(error.to_string()),
        ArchiveError::UnsupportedArchiveVersion { .. } | ArchiveError::InvalidFormat => {
            CliError::usage(error.to_string())
        }
        other => CliError::usage(other.to_string()),
    }
}
