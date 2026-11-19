//! key=value message labels (ADR 0032): local validation, request bodies and query strings.
//! The server re-validates everything; checking here turns typos into usage errors (exit 2)
//! before any network call.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::error::CliError;

pub type Labels = BTreeMap<String, String>;

pub const MAX_LABELS: usize = 16;
const MAX_FILTERS: usize = 8;
const MAX_VALUE_BYTES: usize = 256;

pub fn validate_key(key: &str) -> Result<&str, CliError> {
    let bytes = key.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.-".contains(b));
    if valid {
        Ok(key)
    } else {
        Err(CliError::usage(format!(
            "Label key {key:?} must be 1-64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit."
        )))
    }
}

pub fn validate_value<'a>(key: &str, value: &'a str) -> Result<&'a str, CliError> {
    if value.is_empty() || value.len() > MAX_VALUE_BYTES || value.chars().any(char::is_control) {
        return Err(CliError::usage(format!(
            "Label {key} needs a value of 1-256 UTF-8 bytes without control characters such as newlines."
        )));
    }
    Ok(value)
}

/// Parses one `key=value` argument.
pub fn parse_pair(raw: &str) -> Result<(String, String), CliError> {
    let (key, value) = raw
        .split_once('=')
        .ok_or_else(|| CliError::usage(format!("Write the label as key=value, not {raw:?}.")))?;
    Ok((
        validate_key(key)?.to_owned(),
        validate_value(key, value)?.to_owned(),
    ))
}

/// Parses repeated `key=value` arguments. A key given twice is a usage error, not a silent overwrite.
pub fn parse_labels(raws: &[String]) -> Result<Labels, CliError> {
    let mut labels = Labels::new();
    for raw in raws {
        let (key, value) = parse_pair(raw)?;
        if labels.insert(key.clone(), value).is_some() {
            return Err(CliError::usage(format!("Label {key} is given twice.")));
        }
    }
    if labels.len() > MAX_LABELS {
        return Err(CliError::usage(format!(
            "A message can carry at most {MAX_LABELS} labels."
        )));
    }
    Ok(labels)
}

/// Validates a filter: `key`, `key=value` or `key=a|b`.
pub fn validate_filter(raw: &str) -> Result<&str, CliError> {
    match raw.split_once('=') {
        None => {
            validate_key(raw)?;
        }
        Some((key, values)) => {
            validate_key(key)?;
            let values: Vec<&str> = values.split('|').collect();
            if values.len() > 8 {
                return Err(CliError::usage("Use at most 8 values per label filter."));
            }
            for value in values {
                validate_value(key, value)?;
            }
        }
    }
    Ok(raw)
}

/// `&label=…` query parameters for validated filters, percent-encoded.
pub fn filter_query(filters: &[String]) -> Result<String, CliError> {
    if filters.len() > MAX_FILTERS {
        return Err(CliError::usage("Use at most 8 label filters."));
    }
    let mut query = String::new();
    for filter in filters {
        validate_filter(filter)?;
        query.push_str("&label=");
        query.extend(url::form_urlencoded::byte_serialize(filter.as_bytes()));
    }
    Ok(query)
}

/// Body of POST …/messages/{id}/labels.
pub fn change_body(
    set: &Labels,
    unset: &[String],
    if_equal: &Labels,
    if_unset: &[String],
) -> Result<Value, CliError> {
    if set.is_empty() && unset.is_empty() {
        return Err(CliError::usage(
            "Give at least one key=value to set or one --unset KEY.",
        ));
    }
    for key in unset {
        validate_key(key)?;
        if set.contains_key(key) {
            return Err(CliError::usage(format!(
                "Label {key} cannot be both set and unset."
            )));
        }
    }
    let mut condition = Map::new();
    for (key, value) in if_equal {
        condition.insert(key.clone(), json!(value));
    }
    for key in if_unset {
        validate_key(key)?;
        if condition.insert(key.clone(), Value::Null).is_some() {
            return Err(CliError::usage(format!(
                "Label {key} is in both --if and --if-unset."
            )));
        }
    }
    let mut body = json!({ "set": set });
    if !unset.is_empty() {
        body["unset"] = json!(unset);
    }
    if !condition.is_empty() {
        body["if"] = Value::Object(condition);
    }
    Ok(body)
}

/// A failed `if` condition answers 409 label_conflict with the current labels; keep them in the
/// error so a caller sees who holds a claim without another request.
pub fn conflict_message(status: u16, body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    if status != 409 || value["error"]["code"] != "label_conflict" {
        return None;
    }
    Some(format!(
        "409: The if condition did not match; nothing changed. Current labels: {}",
        value.get("labels").unwrap_or(&json!({}))
    ))
}

/// One filtered long poll. With `message`, only that message can match (after=id-1, before=id+1).
pub fn wait_path(
    tenant: &str,
    channel: &str,
    filters: &[String],
    message: Option<u64>,
    wait: u64,
) -> Result<String, CliError> {
    if filters.is_empty() {
        return Err(CliError::usage("Give at least one label to wait for."));
    }
    let range = match message {
        Some(id) => format!("after={}&before={}", id - 1, id + 1),
        None => "after=0".to_string(),
    };
    Ok(format!(
        "/api/tenants/{tenant}/channels/{channel}/messages?{range}&limit=1&wait={wait}{}",
        filter_query(filters)?
    ))
}

/// The first message of a filtered page, if any.
pub fn first_match(body: &str) -> Result<Option<Value>, CliError> {
    let page: Value =
        serde_json::from_str(body).map_err(|_| CliError::generic("Response was not JSON."))?;
    let messages = page["messages"]
        .as_array()
        .ok_or_else(|| CliError::generic("Response had no messages array."))?;
    Ok(messages.first().cloned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn pairs_need_a_valid_key_and_value() {
        assert_eq!(
            parse_pair("state=open").unwrap(),
            ("state".into(), "open".into())
        );
        assert_eq!(parse_pair("pr=a=b").unwrap().1, "a=b");
        for bad in ["state", "State=open", "-x=y", "k=", "k=a\nb", "=v"] {
            assert_eq!(parse_pair(bad).unwrap_err().exit_code(), 2, "{bad}");
        }
        assert!(parse_pair(&format!("k={}", "x".repeat(256))).is_ok());
        assert!(parse_pair(&format!("k={}", "x".repeat(257))).is_err());
    }

    #[test]
    fn repeated_keys_and_too_many_labels_are_usage_errors() {
        assert!(parse_labels(&strings(&["a=1", "a=2"])).is_err());
        let many: Vec<String> = (0..17).map(|i| format!("k{i}=v")).collect();
        assert!(parse_labels(&many).is_err());
        assert_eq!(parse_labels(&many[..16]).unwrap().len(), 16);
    }

    #[test]
    fn filters_are_validated_and_encoded() {
        assert_eq!(
            filter_query(&strings(&["state", "state=open|draft"])).unwrap(),
            "&label=state&label=state%3Dopen%7Cdraft"
        );
        assert!(filter_query(&strings(&["Bad"])).is_err());
        assert!(filter_query(&strings(&["k=a||b"])).is_err());
    }

    #[test]
    fn change_body_carries_set_unset_and_conditions() {
        let set = parse_labels(&strings(&["owner=ana"])).unwrap();
        let body = change_body(
            &set,
            &strings(&["draft"]),
            &parse_labels(&strings(&["state=open"])).unwrap(),
            &strings(&["reviewer"]),
        )
        .unwrap();
        assert_eq!(
            body,
            json!({"set":{"owner":"ana"},"unset":["draft"],"if":{"state":"open","reviewer":null}})
        );
        assert!(change_body(&Labels::new(), &[], &Labels::new(), &[]).is_err());
        assert!(change_body(&set, &strings(&["owner"]), &Labels::new(), &[]).is_err());
        let both = parse_labels(&strings(&["x=1"])).unwrap();
        assert!(change_body(&set, &[], &both, &strings(&["x"])).is_err());
    }

    #[test]
    fn conflicts_report_current_labels() {
        let body = r#"{"error":{"code":"label_conflict","message":"x"},"labels":{"owner":"ana"}}"#;
        assert!(
            conflict_message(409, body)
                .unwrap()
                .contains(r#"{"owner":"ana"}"#)
        );
        assert!(conflict_message(409, r#"{"error":{"code":"other"}}"#).is_none());
    }

    #[test]
    fn wait_path_targets_one_message_or_the_whole_channel() {
        let filters = strings(&["state=done"]);
        assert_eq!(
            wait_path("t", "c", &filters, Some(42), 25).unwrap(),
            "/api/tenants/t/channels/c/messages?after=41&before=43&limit=1&wait=25&label=state%3Ddone"
        );
        assert!(
            wait_path("t", "c", &filters, None, 0)
                .unwrap()
                .contains("?after=0&")
        );
        assert!(wait_path("t", "c", &[], None, 0).is_err());
    }
}
