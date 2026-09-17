//! Resolve a sender from an exact-name capability without duplicating its name in the shell.
use serde_json::Value;
use url::Url;

use crate::client::{MsnClient, classify};
use crate::error::CliError;

pub fn fetch_identity(url: &Url, tenant: &str, token: &str) -> Result<Value, CliError> {
    let response = MsnClient::new(url)?.get(&format!("/api/tenants/{tenant}"), Some(token))?;
    classify(response.status, &response.body)?;
    let identity: Value = serde_json::from_str(&response.body)
        .map_err(|_| CliError::generic("Identity response was not JSON."))?;
    if identity.get("tenant").and_then(Value::as_str) != Some(tenant) {
        return Err(CliError::generic(
            "Identity response belongs to a different workspace.",
        ));
    }
    Ok(identity)
}

pub fn validate_username(name: &str) -> Result<String, CliError> {
    if name.trim().is_empty() || name.len() > 128 {
        return Err(CliError::usage(
            "Username must be non-blank and at most 128 UTF-8 bytes.",
        ));
    }
    Ok(name.to_owned())
}

pub fn resolve_username(
    url: &Url,
    tenant: &str,
    token: &str,
    selected: Option<&str>,
) -> Result<String, CliError> {
    // Preserve explicit overrides; the server remains the authority on key bindings.
    if let Some(name) = selected {
        return validate_username(name);
    }
    let identity = fetch_identity(url, tenant, token)?;
    if let Some(name) = identity.get("username").and_then(Value::as_str) {
        return validate_username(name);
    }
    Err(CliError::usage(
        "This key has no exact username binding. Choose --username NAME (or save it in an MSN profile). For reads, --reader NAME also selects independent progress.",
    ))
}
