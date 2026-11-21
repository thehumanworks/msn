//! Addressing a message to one or several names (ADR 0067). A send's `to` is one name, or a list
//! of up to [`MAX_RECIPIENTS`] different names. A message read back has `to` (the first name) and,
//! when it names several, `recipients` (every name, in order). Every CLI path that writes or reads
//! addressees goes through this module, and the desktop app reuses it.

use serde_json::{Value, json};

use crate::error::CliError;

/// The most names one message can be addressed to; the server refuses more.
pub const MAX_RECIPIENTS: usize = 8;

/// Checks the names a send is addressed to: 0 to 8 names, each non-blank and at most 128 UTF-8
/// bytes, none repeated. `field` names the flag or argument in the error (`--to` or `to`).
pub fn validate_names(names: &[String], field: &str) -> Result<Vec<String>, CliError> {
    if names.len() > MAX_RECIPIENTS {
        return Err(CliError::usage(format!(
            "{field} names at most {MAX_RECIPIENTS} people; send separate messages for more."
        )));
    }
    for (index, name) in names.iter().enumerate() {
        if name.trim().is_empty() || name.len() > 128 {
            return Err(CliError::usage(format!(
                "{field} must be a non-blank username of at most 128 UTF-8 bytes."
            )));
        }
        if names[..index].contains(name) {
            return Err(CliError::usage(format!("{field} names {name:?} twice.")));
        }
    }
    Ok(names.to_vec())
}

/// The `to` field of a send body: nothing, one name as a string (today's shape, so idempotency
/// replays of older sends still match), or several as a list.
pub fn to_field(names: &[String]) -> Option<Value> {
    match names {
        [] => None,
        [one] => Some(json!(one)),
        many => Some(json!(many)),
    }
}

/// Reads an MCP `to` argument: absent, one name as a string, or a list of names.
pub fn from_argument(value: Option<&Value>) -> Result<Vec<String>, CliError> {
    let names = match value {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::String(name)) => vec![name.clone()],
        Some(Value::Array(items)) => {
            let names = items
                .iter()
                .map(|item| item.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| CliError::usage("to must be a name or a list of names."))?;
            if names.is_empty() {
                return Err(CliError::usage(
                    "to must name at least one person when it is a list.",
                ));
            }
            names
        }
        Some(_) => return Err(CliError::usage("to must be a name or a list of names.")),
    };
    validate_names(&names, "to")
}

/// Every name a message is addressed to: `recipients` when it lists several, else `to` alone,
/// else none (a message for everyone).
pub fn addressees(message: &Value) -> Vec<&str> {
    if let Some(list) = message.get("recipients").and_then(Value::as_array)
        && !list.is_empty()
    {
        let names: Vec<&str> = list.iter().filter_map(Value::as_str).collect();
        if names.len() == list.len() {
            return names;
        }
    }
    message
        .get("to")
        .and_then(Value::as_str)
        .into_iter()
        .collect()
}

/// The addressees as one line, `reviewer, worker`, or `None` for a message to everyone.
pub fn names_line(message: &Value) -> Option<String> {
    let names = addressees(message);
    (!names.is_empty()).then(|| names.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn given_one_name_when_to_field_then_a_string_as_before() {
        assert_eq!(to_field(&names(&["reviewer"])), Some(json!("reviewer")));
        assert_eq!(to_field(&[]), None);
        assert_eq!(
            to_field(&names(&["reviewer", "worker"])),
            Some(json!(["reviewer", "worker"]))
        );
    }

    #[test]
    fn given_bad_names_when_validated_then_usage_errors() {
        let nine: Vec<String> = (0..9).map(|i| format!("agent-{i}")).collect();
        assert!(validate_names(&nine, "--to").is_err());
        assert!(validate_names(&nine[..8], "--to").is_ok());
        assert!(validate_names(&names(&["a", "a"]), "--to").is_err());
        assert!(validate_names(&names(&["a", " "]), "--to").is_err());
        assert!(validate_names(&["x".repeat(129)], "--to").is_err());
        assert!(validate_names(&[], "--to").unwrap().is_empty());
    }

    #[test]
    fn given_mcp_to_when_read_then_text_or_list() {
        assert_eq!(from_argument(None).unwrap(), Vec::<String>::new());
        assert_eq!(from_argument(Some(&json!("a"))).unwrap(), names(&["a"]));
        assert_eq!(
            from_argument(Some(&json!(["a", "b"]))).unwrap(),
            names(&["a", "b"])
        );
        assert!(from_argument(Some(&json!([]))).is_err());
        assert!(from_argument(Some(&json!(["a", 1]))).is_err());
        assert!(from_argument(Some(&json!(3))).is_err());
    }

    #[test]
    fn given_messages_when_addressees_then_recipients_else_to() {
        let several = json!({"to": "a", "recipients": ["a", "b"]});
        assert_eq!(addressees(&several), vec!["a", "b"]);
        assert_eq!(addressees(&json!({"to": "a"})), vec!["a"]);
        assert!(addressees(&json!({})).is_empty());
        assert_eq!(names_line(&several).as_deref(), Some("a, b"));
        assert_eq!(names_line(&json!({})), None);
    }
}
