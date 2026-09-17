//! Pure task-event projection. Visibility only; no server arbitration.
//!
//! Wire schema: `msn.task.v1`. Actor is always the outer message `username`.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde_json::{Map, Value, json};

use crate::config::{MAX_SAFE_INTEGER, is_canonical_uint, is_slug, parse_int};
use crate::error::CliError;
use crate::identity::validate_username;

pub const SCHEMA: &str = "msn.task.v1";

/// Keep projected task rows bounded inside a 16 KiB channel message.
pub const MAX_TITLE_BYTES: usize = 256;
pub const MAX_ACCEPTANCE_BYTES: usize = 2048;
pub const MAX_REASON_BYTES: usize = 1024;
pub const MAX_DEPENDS_ON: usize = 32;
pub const MAX_EVIDENCE: usize = 32;

const ACTIONS: &[&str] = &[
    "open", "claim", "assign", "block", "ready", "close", "cancel",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Open,
    Blocked,
    Ready,
    Closed,
    Cancelled,
}

impl State {
    fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Blocked => "blocked",
            Self::Ready => "ready",
            Self::Closed => "closed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug)]
struct TaskRec {
    id: String,
    title: String,
    owner: Option<String>,
    reviewer: String,
    creator: String,
    state: State,
    depends_on: Vec<String>,
    evidence: Vec<u64>,
    message_ids: Vec<u64>,
    conflicts: Vec<String>,
    claimants: BTreeSet<String>,
    blocked_on: Vec<String>,
    close_unsatisfied: bool,
    acceptance: Option<String>,
    reason: Option<String>,
}

/// Project canonical channel messages into `{tasks,warnings}`.
///
/// `messages` should be in log order. Non-task rows are ignored. Tombstones and
/// unknown schema versions never become silently completed tasks.
pub fn project(messages: &[Value]) -> Value {
    let live_ids = live_message_ids(messages);
    let mut tasks: Vec<TaskRec> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut warnings = Vec::new();

    for message in messages {
        apply_message(message, &mut tasks, &mut index, &mut warnings);
    }
    finalize_evidence(&mut tasks, &live_ids, &mut warnings);
    finalize_dependencies(&mut tasks);

    let tasks = tasks.iter().map(task_json).collect::<Vec<_>>();
    json!({ "tasks": tasks, "warnings": warnings })
}

/// Outbound syntax check for a task event body. Does not check authority or history.
pub fn validate_event(event: &Value) -> Result<(), CliError> {
    let obj = event
        .as_object()
        .ok_or_else(|| CliError::usage("Task event must be a JSON object."))?;
    if obj.contains_key("actor") || obj.contains_key("username") {
        return Err(CliError::usage(
            "Task event actor comes from the outer message username, not the event body.",
        ));
    }
    match obj.get("schema").and_then(Value::as_str) {
        Some(SCHEMA) => {}
        Some(_) => {
            return Err(CliError::usage("Unsupported task schema. Use msn.task.v1."));
        }
        None => {
            return Err(CliError::usage(
                "Task event requires schema \"msn.task.v1\".",
            ));
        }
    }
    let task = obj
        .get("task")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::usage("Task event requires a task slug."))?;
    require_task_slug(task)?;
    let action = obj
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::usage("Task event requires an action."))?;
    if !ACTIONS.contains(&action) {
        return Err(CliError::usage(
            "Task action must be open, claim, assign, block, ready, close or cancel.",
        ));
    }
    match action {
        "open" => {
            require_bounded_text(
                obj,
                "title",
                true,
                MAX_TITLE_BYTES,
                "Task open requires a non-blank title.",
            )?;
            require_username_field(obj, "reviewer", true)?;
            require_username_field(obj, "owner", false)?;
            require_depends_on(obj)?;
            require_bounded_text(
                obj,
                "acceptance",
                false,
                MAX_ACCEPTANCE_BYTES,
                "Task open acceptance must be a string.",
            )?;
        }
        "assign" => {
            require_username_field(obj, "owner", true)?;
            if obj.contains_key("reason") {
                require_bounded_text(
                    obj,
                    "reason",
                    true,
                    MAX_REASON_BYTES,
                    "Task assign reason must be non-blank when present.",
                )?;
            }
        }
        "block" => {
            require_bounded_text(
                obj,
                "reason",
                true,
                MAX_REASON_BYTES,
                "Task block requires a non-blank reason.",
            )?;
        }
        "cancel" => {
            require_bounded_text(
                obj,
                "reason",
                true,
                MAX_REASON_BYTES,
                "Task cancel requires a non-blank reason.",
            )?;
        }
        "ready" => {
            require_evidence(obj)?;
        }
        _ => {}
    }
    Ok(())
}

fn require_task_slug(value: &str) -> Result<(), CliError> {
    if is_slug(value) {
        Ok(())
    } else {
        Err(CliError::usage(
            "Task id must be a lowercase slug (1–64 letters, digits, _ or -).",
        ))
    }
}

fn require_bounded_text(
    obj: &Map<String, Value>,
    key: &str,
    required: bool,
    max_bytes: usize,
    message: &str,
) -> Result<Option<String>, CliError> {
    match obj.get(key) {
        None | Some(Value::Null) if !required => Ok(None),
        None | Some(Value::Null) => Err(CliError::usage(message.to_string())),
        Some(Value::String(text)) => {
            if required && text.trim().is_empty() {
                return Err(CliError::usage(message.to_string()));
            }
            if !required && text.trim().is_empty() {
                return Ok(None);
            }
            if text.len() > max_bytes {
                return Err(CliError::usage(format!(
                    "Task {key} must be at most {max_bytes} UTF-8 bytes."
                )));
            }
            Ok(Some(text.clone()))
        }
        Some(_) => Err(CliError::usage(message.to_string())),
    }
}

fn require_username_field(
    obj: &Map<String, Value>,
    key: &str,
    required: bool,
) -> Result<Option<String>, CliError> {
    match obj.get(key) {
        None if required => Err(CliError::usage(format!("Task event requires {key}."))),
        None => Ok(None),
        Some(Value::Null) if !required => Ok(None),
        Some(value) => {
            let name = value.as_str().ok_or_else(|| {
                CliError::usage(format!("Task {key} must be a non-blank username."))
            })?;
            Ok(Some(validate_username(name)?))
        }
    }
}

fn require_depends_on(obj: &Map<String, Value>) -> Result<Vec<String>, CliError> {
    match obj.get("dependsOn") {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => {
            if items.len() > MAX_DEPENDS_ON {
                return Err(CliError::usage(format!(
                    "Task dependsOn must have at most {MAX_DEPENDS_ON} slugs."
                )));
            }
            let mut slugs = Vec::new();
            for item in items {
                let slug = item.as_str().ok_or_else(|| {
                    CliError::usage("Task dependsOn must be an array of task slugs.")
                })?;
                require_task_slug(slug)?;
                if slugs.iter().any(|existing| existing == slug) {
                    return Err(CliError::usage(
                        "Task dependsOn must not contain duplicate slugs.",
                    ));
                }
                slugs.push(slug.to_string());
            }
            Ok(slugs)
        }
        Some(_) => Err(CliError::usage(
            "Task dependsOn must be an array of task slugs.",
        )),
    }
}

fn require_evidence(obj: &Map<String, Value>) -> Result<Vec<u64>, CliError> {
    let items = obj
        .get("evidence")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CliError::usage("Task ready requires evidence: an array of positive message ids.")
        })?;
    if items.is_empty() {
        return Err(CliError::usage(
            "Task ready requires at least one positive evidence message id.",
        ));
    }
    if items.len() > MAX_EVIDENCE {
        return Err(CliError::usage(format!(
            "Task evidence must have at most {MAX_EVIDENCE} ids."
        )));
    }
    let mut ids = Vec::new();
    for item in items {
        let id = item
            .as_u64()
            .filter(|id| *id >= 1 && *id <= MAX_SAFE_INTEGER);
        let Some(id) = id else {
            return Err(CliError::usage(
                "Task evidence ids must be positive canonical integers.",
            ));
        };
        if ids.contains(&id) {
            return Err(CliError::usage(
                "Task evidence must not contain duplicate ids.",
            ));
        }
        ids.push(id);
    }
    Ok(ids)
}

fn positive_id(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => number
            .as_u64()
            .filter(|id| *id >= 1 && *id <= MAX_SAFE_INTEGER),
        Value::String(raw) if is_canonical_uint(raw) => {
            parse_int(raw, MAX_SAFE_INTEGER).ok().filter(|id| *id >= 1)
        }
        _ => None,
    }
}

fn live_message_ids(messages: &[Value]) -> HashSet<u64> {
    let mut live = HashSet::new();
    let mut dead = HashSet::new();
    for message in messages {
        let Some(id) = message_id(message) else {
            continue;
        };
        if is_tombstone(message) {
            dead.insert(id);
            live.remove(&id);
        } else if !dead.contains(&id) {
            live.insert(id);
        }
    }
    live
}

fn message_id(message: &Value) -> Option<u64> {
    message.get("id").and_then(positive_id)
}

fn message_username(message: &Value) -> Option<String> {
    message
        .get("username")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::usage("missing"))
        .and_then(validate_username)
        .ok()
}

fn is_tombstone(message: &Value) -> bool {
    if message.get("deleted").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    let username = message
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or("");
    let text = match message.get("text") {
        Some(Value::String(text)) => text.as_str(),
        Some(Value::Null) | None => "",
        Some(_) => return false,
    };
    username.trim().is_empty() && text.trim().is_empty()
}

fn apply_message(
    message: &Value,
    tasks: &mut Vec<TaskRec>,
    index: &mut HashMap<String, usize>,
    warnings: &mut Vec<Value>,
) {
    if !message.is_object() {
        return;
    }
    let id = message_id(message);
    if is_tombstone(message) {
        warn(
            warnings,
            "deleted-or-redacted",
            id,
            None,
            "Deleted or redacted message is not a task event.",
        );
        return;
    }
    if message.get("contentType").and_then(Value::as_str) != Some("application/json") {
        return;
    }
    let Some(id) = id else {
        warn(
            warnings,
            "malformed-event",
            None,
            None,
            "Task-bearing message is missing a positive id.",
        );
        return;
    };
    let Some(actor) = message_username(message) else {
        warn(
            warnings,
            "malformed-event",
            Some(id),
            None,
            "Task-bearing message is missing a usable username.",
        );
        return;
    };
    let text = match message.get("text") {
        Some(value) => value,
        None => return,
    };
    let parsed = match parse_event_object(text) {
        ParseResult::NotEvent => return,
        ParseResult::InvalidJson => {
            warn(
                warnings,
                "malformed-event",
                Some(id),
                None,
                "application/json text was not valid JSON.",
            );
            return;
        }
        ParseResult::Event(event) => event,
    };
    let Some(obj) = parsed.as_object() else {
        return;
    };
    match obj.get("schema").and_then(Value::as_str) {
        None => return,
        Some(SCHEMA) => {}
        Some(other) => {
            warn(
                warnings,
                "unknown-schema",
                Some(id),
                None,
                format!("Unsupported task schema {other}."),
            );
            return;
        }
    }
    apply_event(id, &actor, obj, tasks, index, warnings);
}

enum ParseResult {
    NotEvent,
    InvalidJson,
    Event(Value),
}

fn parse_event_object(text: &Value) -> ParseResult {
    match text {
        Value::Object(_) => ParseResult::Event(text.clone()),
        Value::String(raw) => match serde_json::from_str::<Value>(raw) {
            Ok(Value::Object(map)) => ParseResult::Event(Value::Object(map)),
            Ok(_) => ParseResult::NotEvent,
            Err(_) => ParseResult::InvalidJson,
        },
        _ => ParseResult::NotEvent,
    }
}

fn apply_event(
    message_id: u64,
    actor: &str,
    event: &Map<String, Value>,
    tasks: &mut Vec<TaskRec>,
    index: &mut HashMap<String, usize>,
    warnings: &mut Vec<Value>,
) {
    let Some(task_id) = event.get("task").and_then(Value::as_str) else {
        warn(
            warnings,
            "malformed-event",
            Some(message_id),
            None,
            "Task event is missing a task slug.",
        );
        return;
    };
    if !is_slug(task_id) {
        warn(
            warnings,
            "malformed-event",
            Some(message_id),
            Some(task_id),
            "Task id is not a valid slug.",
        );
        return;
    }
    let Some(action) = event.get("action").and_then(Value::as_str) else {
        warn(
            warnings,
            "malformed-event",
            Some(message_id),
            Some(task_id),
            "Task event is missing an action.",
        );
        return;
    };
    if !ACTIONS.contains(&action) {
        warn(
            warnings,
            "malformed-event",
            Some(message_id),
            Some(task_id),
            format!("Unknown task action {action}."),
        );
        return;
    }
    if action == "open" {
        apply_open(message_id, actor, task_id, event, tasks, index, warnings);
        return;
    }
    let Some(&pos) = index.get(task_id) else {
        warn(
            warnings,
            "unknown-task",
            Some(message_id),
            Some(task_id),
            "Task event refers to a task that was never opened.",
        );
        return;
    };
    match action {
        "claim" => apply_claim(message_id, actor, pos, tasks, warnings),
        "assign" => apply_assign(message_id, actor, event, pos, tasks, warnings),
        "block" => apply_block(message_id, actor, event, pos, tasks, warnings),
        "ready" => apply_ready(message_id, actor, event, pos, tasks, warnings),
        "close" => apply_close(message_id, actor, pos, tasks, warnings),
        "cancel" => apply_cancel(message_id, actor, event, pos, tasks, warnings),
        _ => {}
    }
}

fn apply_open(
    message_id: u64,
    actor: &str,
    task_id: &str,
    event: &Map<String, Value>,
    tasks: &mut Vec<TaskRec>,
    index: &mut HashMap<String, usize>,
    warnings: &mut Vec<Value>,
) {
    if let Some(&pos) = index.get(task_id) {
        record_message(&mut tasks[pos], message_id);
        add_conflict(&mut tasks[pos], "duplicate-open");
        warn(
            warnings,
            "duplicate-open",
            Some(message_id),
            Some(task_id),
            "Duplicate open does not overwrite the original task.",
        );
        return;
    }
    let title = match bounded_required(event.get("title"), MAX_TITLE_BYTES) {
        Some(title) => title,
        None => {
            warn(
                warnings,
                "malformed-event",
                Some(message_id),
                Some(task_id),
                "Task open is missing a non-blank title.",
            );
            return;
        }
    };
    let acceptance = match bounded_optional(event.get("acceptance"), MAX_ACCEPTANCE_BYTES) {
        Ok(value) => value,
        Err(()) => {
            warn(
                warnings,
                "malformed-event",
                Some(message_id),
                Some(task_id),
                "Task open acceptance is malformed or too long.",
            );
            return;
        }
    };
    let reviewer = match event
        .get("reviewer")
        .and_then(Value::as_str)
        .and_then(|name| validate_username(name).ok())
    {
        Some(name) => name,
        None => {
            warn(
                warnings,
                "malformed-event",
                Some(message_id),
                Some(task_id),
                "Task open is missing a valid reviewer.",
            );
            return;
        }
    };
    let owner = match event.get("owner") {
        None | Some(Value::Null) => None,
        Some(value) => match value.as_str().and_then(|name| validate_username(name).ok()) {
            Some(name) => Some(name),
            None => {
                warn(
                    warnings,
                    "malformed-event",
                    Some(message_id),
                    Some(task_id),
                    "Task open owner is not a valid username.",
                );
                return;
            }
        },
    };
    let depends_on = match parse_depends_on(event) {
        Some(deps) => deps,
        None => {
            warn(
                warnings,
                "malformed-event",
                Some(message_id),
                Some(task_id),
                "Task open dependsOn is malformed.",
            );
            return;
        }
    };
    let mut rec = TaskRec {
        id: task_id.to_string(),
        title,
        owner,
        reviewer,
        creator: actor.to_string(),
        state: State::Open,
        depends_on,
        evidence: Vec::new(),
        message_ids: Vec::new(),
        conflicts: Vec::new(),
        claimants: BTreeSet::new(),
        blocked_on: Vec::new(),
        close_unsatisfied: false,
        acceptance,
        reason: None,
    };
    record_message(&mut rec, message_id);
    index.insert(task_id.to_string(), tasks.len());
    tasks.push(rec);
}

fn parse_depends_on(event: &Map<String, Value>) -> Option<Vec<String>> {
    match event.get("dependsOn") {
        None => Some(Vec::new()),
        Some(Value::Array(items)) => {
            if items.len() > MAX_DEPENDS_ON {
                return None;
            }
            let mut slugs = Vec::new();
            for item in items {
                let slug = item.as_str()?;
                if !is_slug(slug) {
                    return None;
                }
                if slugs.iter().any(|existing| existing == slug) {
                    return None;
                }
                slugs.push(slug.to_string());
            }
            Some(slugs)
        }
        Some(_) => None,
    }
}

fn bounded_required(value: Option<&Value>, max_bytes: usize) -> Option<String> {
    let text = value?.as_str()?;
    if text.trim().is_empty() || text.len() > max_bytes {
        None
    } else {
        Some(text.to_string())
    }
}

fn bounded_optional(value: Option<&Value>, max_bytes: usize) -> Result<Option<String>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.trim().is_empty() => Ok(None),
        Some(Value::String(text)) if text.len() <= max_bytes => Ok(Some(text.clone())),
        _ => Err(()),
    }
}

fn bounded_present_text(value: Option<&Value>, max_bytes: usize) -> Result<Option<String>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if !text.trim().is_empty() && text.len() <= max_bytes => {
            Ok(Some(text.clone()))
        }
        _ => Err(()),
    }
}

fn apply_claim(
    message_id: u64,
    actor: &str,
    pos: usize,
    tasks: &mut [TaskRec],
    warnings: &mut Vec<Value>,
) {
    let task = &mut tasks[pos];
    if matches!(task.state, State::Closed | State::Cancelled) {
        warn(
            warnings,
            "invalid-transition",
            Some(message_id),
            Some(&task.id),
            "Claim cannot reopen a closed or cancelled task.",
        );
        return;
    }
    let first_claimant = task.claimants.is_empty() && task.owner.is_none();
    if first_claimant {
        task.owner = Some(actor.to_string());
    }
    task.claimants.insert(actor.to_string());
    sync_claim_conflict(task);
    record_message(task, message_id);
}

fn apply_assign(
    message_id: u64,
    actor: &str,
    event: &Map<String, Value>,
    pos: usize,
    tasks: &mut [TaskRec],
    warnings: &mut Vec<Value>,
) {
    let authorized = {
        let task = &tasks[pos];
        actor == task.creator || actor == task.reviewer
    };
    if !authorized {
        warn(
            warnings,
            "unauthorized",
            Some(message_id),
            Some(tasks[pos].id.as_str()),
            "Only the creator or reviewer may assign.",
        );
        return;
    }
    let owner = match event
        .get("owner")
        .and_then(Value::as_str)
        .and_then(|name| validate_username(name).ok())
    {
        Some(name) => name,
        None => {
            warn(
                warnings,
                "malformed-event",
                Some(message_id),
                Some(tasks[pos].id.as_str()),
                "Task assign is missing a valid owner.",
            );
            return;
        }
    };
    let reason = match bounded_present_text(event.get("reason"), MAX_REASON_BYTES) {
        Ok(value) => value,
        Err(()) => {
            warn(
                warnings,
                "malformed-event",
                Some(message_id),
                Some(tasks[pos].id.as_str()),
                "Task assign reason must be non-blank when present.",
            );
            return;
        }
    };
    let task = &mut tasks[pos];
    task.owner = Some(owner.clone());
    task.claimants.clear();
    task.claimants.insert(owner);
    // A new assignment starts fresh work. Prior evidence remains addressable in
    // messageIds/history, but must not look like the new owner's current result.
    task.reason = reason;
    task.evidence.clear();
    remove_conflict(task, "claim-conflict");
    if matches!(
        task.state,
        State::Closed | State::Cancelled | State::Blocked | State::Ready
    ) {
        task.state = State::Open;
        task.close_unsatisfied = false;
    }
    record_message(task, message_id);
}

fn apply_block(
    message_id: u64,
    actor: &str,
    event: &Map<String, Value>,
    pos: usize,
    tasks: &mut [TaskRec],
    warnings: &mut Vec<Value>,
) {
    if !is_owner(tasks, pos, actor) {
        warn(
            warnings,
            "unauthorized",
            Some(message_id),
            Some(tasks[pos].id.as_str()),
            "Only the current owner may block.",
        );
        return;
    }
    if tasks[pos].state != State::Open {
        warn(
            warnings,
            "invalid-transition",
            Some(message_id),
            Some(tasks[pos].id.as_str()),
            "Block is only valid from open.",
        );
        return;
    }
    let reason = match require_reason(event) {
        Some(reason) => reason,
        None => {
            warn(
                warnings,
                "malformed-event",
                Some(message_id),
                Some(tasks[pos].id.as_str()),
                "Task block requires a non-blank reason.",
            );
            return;
        }
    };
    let task = &mut tasks[pos];
    task.state = State::Blocked;
    task.reason = Some(reason);
    record_message(task, message_id);
}

fn apply_ready(
    message_id: u64,
    actor: &str,
    event: &Map<String, Value>,
    pos: usize,
    tasks: &mut [TaskRec],
    warnings: &mut Vec<Value>,
) {
    if !is_owner(tasks, pos, actor) {
        warn(
            warnings,
            "unauthorized",
            Some(message_id),
            Some(tasks[pos].id.as_str()),
            "Only the current owner may mark ready.",
        );
        return;
    }
    if has_claim_conflict(&tasks[pos]) {
        warn(
            warnings,
            "invalid-transition",
            Some(message_id),
            Some(tasks[pos].id.as_str()),
            "Ready does not clear unresolved claim conflicts.",
        );
        return;
    }
    if !matches!(tasks[pos].state, State::Open | State::Blocked) {
        warn(
            warnings,
            "invalid-transition",
            Some(message_id),
            Some(tasks[pos].id.as_str()),
            "Ready is only valid from open or blocked.",
        );
        return;
    }
    let evidence = match parse_evidence(event, message_id) {
        Some(ids) if !ids.is_empty() => ids,
        _ => {
            warn(
                warnings,
                "malformed-event",
                Some(message_id),
                Some(tasks[pos].id.as_str()),
                "Task ready requires at least one earlier positive evidence id.",
            );
            return;
        }
    };
    let task = &mut tasks[pos];
    task.state = State::Ready;
    task.evidence = evidence;
    record_message(task, message_id);
}

fn apply_close(
    message_id: u64,
    actor: &str,
    pos: usize,
    tasks: &mut [TaskRec],
    warnings: &mut Vec<Value>,
) {
    if actor != tasks[pos].reviewer {
        warn(
            warnings,
            "unauthorized",
            Some(message_id),
            Some(tasks[pos].id.as_str()),
            "Only the named reviewer may close.",
        );
        return;
    }
    if has_claim_conflict(&tasks[pos]) {
        warn(
            warnings,
            "invalid-transition",
            Some(message_id),
            Some(tasks[pos].id.as_str()),
            "Close is blocked while claim conflicts are unresolved.",
        );
        return;
    }
    if tasks[pos].state != State::Ready {
        warn(
            warnings,
            "invalid-transition",
            Some(message_id),
            Some(tasks[pos].id.as_str()),
            "Close is only valid after ready.",
        );
        return;
    }
    let close_unsatisfied = !deps_clean_now(tasks, pos);
    let task = &mut tasks[pos];
    task.state = State::Closed;
    task.close_unsatisfied = close_unsatisfied;
    record_message(task, message_id);
}

fn apply_cancel(
    message_id: u64,
    actor: &str,
    event: &Map<String, Value>,
    pos: usize,
    tasks: &mut [TaskRec],
    warnings: &mut Vec<Value>,
) {
    let authorized = actor == tasks[pos].creator || actor == tasks[pos].reviewer;
    if !authorized {
        warn(
            warnings,
            "unauthorized",
            Some(message_id),
            Some(tasks[pos].id.as_str()),
            "Only the creator or reviewer may cancel.",
        );
        return;
    }
    if !matches!(
        tasks[pos].state,
        State::Open | State::Blocked | State::Ready
    ) {
        warn(
            warnings,
            "invalid-transition",
            Some(message_id),
            Some(tasks[pos].id.as_str()),
            "Cancel is only valid from open, blocked or ready.",
        );
        return;
    }
    let reason = match require_reason(event) {
        Some(reason) => reason,
        None => {
            warn(
                warnings,
                "malformed-event",
                Some(message_id),
                Some(tasks[pos].id.as_str()),
                "Task cancel requires a non-blank reason.",
            );
            return;
        }
    };
    let task = &mut tasks[pos];
    task.state = State::Cancelled;
    task.reason = Some(reason);
    record_message(task, message_id);
}

fn is_owner(tasks: &[TaskRec], pos: usize, actor: &str) -> bool {
    tasks[pos].owner.as_deref() == Some(actor)
}

fn has_claim_conflict(task: &TaskRec) -> bool {
    task.conflicts.iter().any(|code| code == "claim-conflict")
}

fn require_reason(event: &Map<String, Value>) -> Option<String> {
    bounded_required(event.get("reason"), MAX_REASON_BYTES)
}

fn parse_evidence(event: &Map<String, Value>, ready_id: u64) -> Option<Vec<u64>> {
    let items = event.get("evidence")?.as_array()?;
    if items.is_empty() || items.len() > MAX_EVIDENCE {
        return None;
    }
    let mut ids = Vec::new();
    for item in items {
        let id = positive_id(item)?;
        if id >= ready_id || ids.contains(&id) {
            return None;
        }
        ids.push(id);
    }
    Some(ids)
}

fn record_message(task: &mut TaskRec, message_id: u64) {
    if !task.message_ids.contains(&message_id) {
        task.message_ids.push(message_id);
    }
}

fn add_conflict(task: &mut TaskRec, code: &str) {
    if !task.conflicts.iter().any(|existing| existing == code) {
        task.conflicts.push(code.to_string());
    }
}

fn remove_conflict(task: &mut TaskRec, code: &str) {
    task.conflicts.retain(|existing| existing != code);
}

fn sync_claim_conflict(task: &mut TaskRec) {
    let contested = match &task.owner {
        None => task.claimants.len() > 1,
        Some(owner) => task.claimants.iter().any(|claimant| claimant != owner),
    };
    if contested {
        add_conflict(task, "claim-conflict");
    } else {
        remove_conflict(task, "claim-conflict");
    }
}

fn finalize_dependencies(tasks: &mut [TaskRec]) {
    let ids: HashSet<String> = tasks.iter().map(|task| task.id.clone()).collect();
    let cyclic = cyclic_tasks(tasks);
    let snapshot: HashMap<String, TaskSnap> = tasks
        .iter()
        .map(|task| (task.id.clone(), TaskSnap::from(task)))
        .collect();

    for task in tasks.iter_mut() {
        remove_conflict(task, "dependency-cycle");
        remove_conflict(task, "dependency-missing");
        remove_conflict(task, "unsatisfied-dependencies");
        let depends_on = task.depends_on.clone();
        let mut blocked_on = Vec::new();
        for dep in &depends_on {
            if !ids.contains(dep) {
                add_conflict(task, "dependency-missing");
                push_unique(&mut blocked_on, dep);
                continue;
            }
            if !is_clean_closed_dep(dep, &snapshot, &ids) {
                push_unique(&mut blocked_on, dep);
            }
        }
        if cyclic.contains(&task.id) {
            add_conflict(task, "dependency-cycle");
        }
        if task.close_unsatisfied
            || (matches!(task.state, State::Ready | State::Closed) && !blocked_on.is_empty())
        {
            add_conflict(task, "unsatisfied-dependencies");
        }
        task.blocked_on = blocked_on;
    }
}

#[derive(Clone)]
struct TaskSnap {
    state: State,
    depends_on: Vec<String>,
    close_unsatisfied: bool,
    conflicts: Vec<String>,
}

impl From<&TaskRec> for TaskSnap {
    fn from(task: &TaskRec) -> Self {
        Self {
            state: task.state,
            depends_on: task.depends_on.clone(),
            close_unsatisfied: task.close_unsatisfied,
            conflicts: task.conflicts.clone(),
        }
    }
}

fn inherent_unclean(task: &TaskSnap) -> bool {
    task.state != State::Closed
        || task.close_unsatisfied
        || task.conflicts.iter().any(|code| {
            matches!(
                code.as_str(),
                "orphan-evidence" | "claim-conflict" | "duplicate-open"
            )
        })
}

fn push_unique(items: &mut Vec<String>, value: &str) {
    if !items.iter().any(|existing| existing == value) {
        items.push(value.to_string());
    }
}

fn is_clean_closed_dep(
    id: &str,
    snapshot: &HashMap<String, TaskSnap>,
    ids: &HashSet<String>,
) -> bool {
    let mut visiting = HashSet::new();
    let mut memo = HashMap::new();
    clean_closed_rec(id, snapshot, ids, &mut visiting, &mut memo)
}

fn clean_closed_rec(
    id: &str,
    snapshot: &HashMap<String, TaskSnap>,
    ids: &HashSet<String>,
    visiting: &mut HashSet<String>,
    memo: &mut HashMap<String, bool>,
) -> bool {
    if let Some(&cached) = memo.get(id) {
        return cached;
    }
    if !ids.contains(id) {
        return false;
    }
    if !visiting.insert(id.to_string()) {
        return false;
    }
    let Some(task) = snapshot.get(id) else {
        visiting.remove(id);
        return false;
    };
    if inherent_unclean(task) {
        visiting.remove(id);
        memo.insert(id.to_string(), false);
        return false;
    }
    let ok = task
        .depends_on
        .iter()
        .all(|dep| clean_closed_rec(dep, snapshot, ids, visiting, memo));
    visiting.remove(id);
    memo.insert(id.to_string(), ok);
    ok
}

fn deps_clean_now(tasks: &[TaskRec], pos: usize) -> bool {
    let depends_on = tasks[pos].depends_on.clone();
    if depends_on.is_empty() {
        return true;
    }
    let by_id: HashMap<&str, &TaskRec> =
        tasks.iter().map(|task| (task.id.as_str(), task)).collect();
    let mut visiting = HashSet::new();
    let mut memo = HashMap::new();
    depends_on
        .iter()
        .all(|dep| clean_closed_now_rec(dep, &by_id, &mut visiting, &mut memo))
}

fn clean_closed_now_rec(
    id: &str,
    by_id: &HashMap<&str, &TaskRec>,
    visiting: &mut HashSet<String>,
    memo: &mut HashMap<String, bool>,
) -> bool {
    if let Some(&cached) = memo.get(id) {
        return cached;
    }
    if !visiting.insert(id.to_string()) {
        return false;
    }
    let Some(task) = by_id.get(id) else {
        visiting.remove(id);
        return false;
    };
    if inherent_unclean(&TaskSnap::from(*task)) {
        visiting.remove(id);
        memo.insert(id.to_string(), false);
        return false;
    }
    let ok = task
        .depends_on
        .iter()
        .all(|dep| clean_closed_now_rec(dep, by_id, visiting, memo));
    visiting.remove(id);
    memo.insert(id.to_string(), ok);
    ok
}

fn cyclic_tasks(tasks: &[TaskRec]) -> HashSet<String> {
    let graph: HashMap<String, Vec<String>> = tasks
        .iter()
        .map(|task| (task.id.clone(), task.depends_on.clone()))
        .collect();
    let mut cyclic = HashSet::new();
    let mut marks: HashMap<String, u8> = HashMap::new();
    let mut stack = Vec::new();
    for task in tasks {
        visit_cycle(&task.id, &graph, &mut marks, &mut stack, &mut cyclic);
    }
    cyclic
}

fn visit_cycle(
    id: &str,
    graph: &HashMap<String, Vec<String>>,
    marks: &mut HashMap<String, u8>,
    stack: &mut Vec<String>,
    cyclic: &mut HashSet<String>,
) {
    match marks.get(id).copied().unwrap_or(0) {
        2 => return,
        1 => {
            if let Some(start) = stack.iter().position(|item| item == id) {
                for item in &stack[start..] {
                    cyclic.insert(item.clone());
                }
            }
            cyclic.insert(id.to_string());
            return;
        }
        _ => {}
    }
    marks.insert(id.to_string(), 1);
    stack.push(id.to_string());
    if let Some(deps) = graph.get(id) {
        for dep in deps {
            visit_cycle(dep, graph, marks, stack, cyclic);
        }
    }
    stack.pop();
    marks.insert(id.to_string(), 2);
}

fn finalize_evidence(tasks: &mut [TaskRec], live_ids: &HashSet<u64>, warnings: &mut Vec<Value>) {
    for task in tasks {
        remove_conflict(task, "orphan-evidence");
        let mut unknown = Vec::new();
        for evidence_id in &task.evidence {
            if !live_ids.contains(evidence_id) {
                unknown.push(*evidence_id);
            }
        }
        if !unknown.is_empty() {
            add_conflict(task, "orphan-evidence");
            for evidence_id in unknown {
                warn(
                    warnings,
                    "unknown-evidence",
                    Some(evidence_id),
                    Some(&task.id),
                    "Evidence id is missing or deleted in the supplied messages.",
                );
            }
        }
    }
}

fn task_json(task: &TaskRec) -> Value {
    let owner = if has_claim_conflict(task) {
        Value::Null
    } else {
        json!(task.owner)
    };
    json!({
        "id": task.id,
        "title": task.title,
        "owner": owner,
        "reviewer": task.reviewer,
        "creator": task.creator,
        "state": effective_state(task),
        "assertedState": task.state.as_str(),
        "dependsOn": task.depends_on,
        "blockedOn": task.blocked_on,
        "evidence": task.evidence,
        "messageIds": task.message_ids,
        "conflicts": task.conflicts,
        "acceptance": task.acceptance,
        "reason": task.reason,
    })
}

fn effective_state(task: &TaskRec) -> &'static str {
    let has = |code: &str| task.conflicts.iter().any(|existing| existing == code);
    match task.state {
        State::Closed => {
            if has("orphan-evidence") {
                "unknown"
            } else if has("claim-conflict")
                || has("unsatisfied-dependencies")
                || has("dependency-cycle")
                || has("dependency-missing")
                || has("duplicate-open")
                || !task.blocked_on.is_empty()
            {
                "conflict"
            } else {
                "closed"
            }
        }
        State::Ready => {
            if has("orphan-evidence") {
                "unknown"
            } else if has("claim-conflict") || has("duplicate-open") {
                "conflict"
            } else if has("unsatisfied-dependencies")
                || has("dependency-cycle")
                || has("dependency-missing")
                || !task.blocked_on.is_empty()
            {
                "blocked"
            } else {
                "ready"
            }
        }
        State::Cancelled => "cancelled",
        State::Blocked => {
            if has("claim-conflict") {
                "conflict"
            } else {
                "blocked"
            }
        }
        State::Open => {
            if has("claim-conflict") {
                "conflict"
            } else if !task.blocked_on.is_empty() {
                "blocked"
            } else {
                "open"
            }
        }
    }
}

fn warn(
    warnings: &mut Vec<Value>,
    code: &str,
    message_id: Option<u64>,
    task: Option<&str>,
    detail: impl Into<String>,
) {
    warnings.push(json!({
        "code": code,
        "messageId": message_id,
        "task": task,
        "detail": detail.into(),
    }));
}
