//! Task messages remain canonical. This adapter scans a bounded, revision-consistent
//! history before exposing a board; it never builds state from snapshot prose.
use serde_json::{Value, json};
use url::Url;

use crate::agent::{fetch_json, print_json, show};
use crate::args::TaskCommand;
use crate::client::{MsnClient, classify, print_success};
use crate::config::{MAX_SAFE_INTEGER, parse_int, require_idempotency_key, require_text, slug};
use crate::error::CliError;
use crate::identity;
use crate::tasks;

pub fn execute(
    url: &Url,
    tenant: &str,
    token: &str,
    selected: Option<&str>,
    command: TaskCommand,
) -> Result<(), CliError> {
    let (channel, task, mut event, key) = match command {
        TaskCommand::List {
            channel,
            max_pages,
            after,
            limit,
        } => {
            let channel = slug(&channel)?;
            let max_pages = parse_int(max_pages.as_deref().unwrap_or("100"), 1000)?;
            let limit = parse_int(limit.as_deref().unwrap_or("20"), 100)?;
            if max_pages == 0 || limit == 0 {
                return Err(CliError::usage("max-pages and limit must be positive."));
            }
            if let Some(after) = after.as_deref() {
                slug(after)?;
            }
            return list(
                url,
                tenant,
                token,
                channel,
                max_pages,
                after.as_deref(),
                limit,
            );
        }
        TaskCommand::Open {
            channel,
            task,
            title,
            owner,
            reviewer,
            depends_on,
            acceptance,
            key,
        } => {
            let mut event =
                json!({"action":"open","title":title,"reviewer":reviewer,"dependsOn":depends_on});
            if let Some(owner) = owner {
                event["owner"] = json!(owner);
            }
            if let Some(acceptance) = acceptance {
                event["acceptance"] = json!(acceptance);
            }
            (channel, task, event, key)
        }
        TaskCommand::Claim { channel, task, key } => {
            (channel, task, json!({"action":"claim"}), key)
        }
        TaskCommand::Assign {
            channel,
            task,
            owner,
            key,
        } => (channel, task, json!({"action":"assign","owner":owner}), key),
        TaskCommand::Block {
            channel,
            task,
            reason,
            key,
        } => (
            channel,
            task,
            json!({"action":"block","reason":reason}),
            key,
        ),
        TaskCommand::Ready {
            channel,
            task,
            evidence,
            key,
        } => {
            let ids: Vec<u64> = evidence
                .iter()
                .map(|n| parse_int(n, MAX_SAFE_INTEGER))
                .collect::<Result<_, _>>()?;
            if ids.is_empty() || ids.contains(&0) {
                return Err(CliError::usage(
                    "ready requires positive evidence message IDs.",
                ));
            }
            (channel, task, json!({"action":"ready","evidence":ids}), key)
        }
        TaskCommand::Close { channel, task, key } => {
            (channel, task, json!({"action":"close"}), key)
        }
        TaskCommand::Cancel {
            channel,
            task,
            reason,
            key,
        } => (
            channel,
            task,
            json!({"action":"cancel","reason":reason}),
            key,
        ),
    };
    let channel = slug(&channel)?;
    let task = slug(&task)?;
    event["schema"] = json!("msn.task.v1");
    event["task"] = json!(task);
    tasks::validate_event(&event)?;
    let text = serde_json::to_string(&event).map_err(|e| CliError::generic(e.to_string()))?;
    require_text(&text)?;
    let key = key
        .as_deref()
        .map(require_idempotency_key)
        .transpose()?
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    // Validate syntax and stable key before identity or evidence network requests.
    let username = identity::resolve_username(url, tenant, token, selected)?;
    if let Some(evidence) = event["evidence"].as_array() {
        for id in evidence {
            show(
                url,
                tenant,
                token,
                channel,
                id.as_u64().expect("validated ID"),
            )?;
        }
    }
    eprintln!("Idempotency-Key: {key}");
    let response = MsnClient::new(url)?.post_json(
        &format!("/api/tenants/{tenant}/channels/{channel}/messages"), token,
        &[("Idempotency-Key", &key)],
        &json!({"username":username,"text":text,"contentType":"application/json","correlationId":format!("task:{task}")}),
    )?;
    classify(response.status, &response.body)?;
    print_success(response.status, &response.body)
}

fn integer(value: &Value, field: &str) -> Result<u64, CliError> {
    value[field]
        .as_u64()
        .filter(|n| *n <= MAX_SAFE_INTEGER)
        .ok_or_else(|| CliError::generic(format!("Invalid task history {field}.")))
}

#[allow(clippy::too_many_arguments)]
pub fn list(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    max_pages: u64,
    after_task: Option<&str>,
    limit: u64,
) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    let mut cursor = 0;
    let mut captured_head = None;
    let mut revision = None;
    let mut messages = Vec::new();
    let mut bytes = 0;
    let mut complete = false;
    for _ in 0..max_pages {
        let response = client.get(&format!("/api/tenants/{tenant}/channels/{channel}/catchup?after={cursor}&limit=100&maxBytes=262144"), Some(token))?;
        classify(response.status, &response.body)?;
        bytes += response.body.len();
        if bytes > 32 * 1024 * 1024 {
            return Err(CliError::generic(
                "Task history exceeds the 32 MiB scan budget. Split work into a new channel; no partial board was published.",
            ));
        }
        let page: Value = serde_json::from_str(&response.body)
            .map_err(|_| CliError::generic("Invalid task history JSON."))?;
        let current_revision = integer(&page, "historyRevision")?;
        if revision.is_some_and(|r| r != current_revision) {
            return Err(CliError::conflict(
                "History changed during task scan. Retry from the beginning.",
            ));
        }
        revision = Some(current_revision);
        let current_head = integer(&page, "headCursor")?;
        let head = *captured_head.get_or_insert(current_head);
        if current_head < head {
            return Err(CliError::conflict(
                "Channel head regressed during task scan.",
            ));
        }
        let next = integer(&page, "nextCursor")?;
        let more = page["hasMore"]
            .as_bool()
            .ok_or_else(|| CliError::generic("Invalid task history hasMore."))?;
        let rows = page["messages"]
            .as_array()
            .ok_or_else(|| CliError::generic("Invalid task history messages."))?;
        let mut previous = cursor;
        for row in rows {
            let id = integer(row, "id")?;
            if id <= previous
                || id > current_head
                || row["tenant"].as_str() != Some(tenant)
                || row["channel"].as_str() != Some(channel)
            {
                return Err(CliError::generic(
                    "Task history is unordered or belongs to another channel.",
                ));
            }
            previous = id;
            if id <= head {
                messages.push(row.clone());
            }
        }
        if next != previous || (more && rows.is_empty()) {
            return Err(CliError::generic(
                "Task history cursor did not match delivered rows.",
            ));
        }
        cursor = next;
        if !more || cursor >= head {
            complete = true;
            break;
        }
    }
    if !complete {
        return Err(CliError::generic(
            "Task history exceeds --max-pages. Increase it (up to 1000) or use a smaller channel; no partial board was published.",
        ));
    }
    // Deletion invalidates derived state even if it happened on an earlier page.
    let check = fetch_json(
        &client,
        &format!(
            "/api/tenants/{tenant}/channels/{channel}/catchup?after=0&limit=1&maxBytes=262144"
        ),
        token,
    )?;
    if Some(integer(&check, "historyRevision")?) != revision {
        return Err(CliError::conflict(
            "History changed during task scan. Retry from the beginning.",
        ));
    }
    let mut result = tasks::project(&messages);
    let task_rows = result["tasks"]
        .as_array()
        .ok_or_else(|| CliError::generic("Invalid task projection."))?;
    let mut remaining: Vec<_> = task_rows
        .iter()
        .filter(|t| t["id"].as_str().unwrap_or("") > after_task.unwrap_or(""))
        .cloned()
        .collect();
    remaining.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let more = remaining.len() as u64 > limit;
    let shown: Vec<_> = remaining.into_iter().take(limit as usize).collect();
    let next = shown
        .last()
        .and_then(|r| r["id"].as_str())
        .unwrap_or(after_task.unwrap_or(""))
        .to_owned();
    result["tasks"] = json!(shown);
    result["complete"] = json!(true);
    result["headCursor"] = json!(captured_head.unwrap_or(0));
    result["historyRevision"] = json!(revision.unwrap_or(0));
    result["nextCursor"] = json!(next);
    result["hasMore"] = json!(more);
    // Preserve incompleteness explicitly at the task-output level, independently of
    // canonical history completeness. Huge diagnostic lists must not flood context.
    if serde_json::to_vec(&result)
        .map_err(|e| CliError::generic(e.to_string()))?
        .len()
        > 262144
    {
        return Err(CliError::generic(
            "Task output exceeds 256 KiB. Reduce --limit or split the channel; no partial board was published.",
        ));
    }
    print_json(&result)
}
