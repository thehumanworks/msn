//! Board mutes (ADR 0044): `msn mute` and `msn unmute`.
//!
//! A mute holds back one board's push notifications for the person behind the owner credential,
//! on every device they turned notifications on. Messages keep arriving on the board. Messages
//! addressed to that person still notify unless `--everything` is set.
use serde_json::{Value, json};
use url::Url;

use crate::client::{MsnClient, classify};
use crate::error::CliError;

/// `--for` values the Worker accepts; leaving it out mutes until `msn unmute`.
pub const DURATIONS: [&str; 2] = ["1h", "1d"];

fn path(tenant: &str, channel: &str) -> String {
    format!("/api/tenants/{tenant}/push/mutes/{channel}")
}

fn parse(body: &str) -> Result<Value, CliError> {
    serde_json::from_str(body).map_err(|_| CliError::generic("Response was not JSON."))
}

/// Mutes `channel`; returns `{channel, until, everything}`.
pub fn mute(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    duration: Option<&str>,
    everything: bool,
) -> Result<Value, CliError> {
    if let Some(value) = duration
        && !DURATIONS.contains(&value)
    {
        return Err(CliError::usage(
            "--for must be 1h or 1d; leave it out to mute until msn unmute.",
        ));
    }
    let mut body = json!({ "everything": everything });
    if let Some(value) = duration {
        body["for"] = json!(value);
    }
    let response = MsnClient::new(url)?.send_optional_json(
        "PUT",
        &path(tenant, channel),
        token,
        Some(&body),
    )?;
    classify(response.status, &response.body)?;
    parse(&response.body)
}

/// Removes the mute on `channel`; succeeds when there was none.
pub fn unmute(url: &Url, tenant: &str, token: &str, channel: &str) -> Result<(), CliError> {
    let response = MsnClient::new(url)?.delete(&path(tenant, channel), token)?;
    classify(response.status, &response.body)
}

/// This person's active mutes: `{mutes: [{channel, until, everything}]}`.
pub fn list(url: &Url, tenant: &str, token: &str) -> Result<Value, CliError> {
    let response =
        MsnClient::new(url)?.get(&format!("/api/tenants/{tenant}/push/mutes"), Some(token))?;
    classify(response.status, &response.body)?;
    parse(&response.body)
}

/// One human line for a mute, such as `#ops muted until 2026-11-20T04:00:00.000Z`.
pub fn describe(mute: &Value) -> String {
    let channel = mute["channel"].as_str().unwrap_or_default();
    let until = match mute["until"].as_str() {
        Some(until) => format!("until {until}"),
        None => "until you unmute it".to_string(),
    };
    let scope = if mute["everything"].as_bool() == Some(true) {
        "everything muted"
    } else {
        "messages to you still notify"
    };
    format!("#{channel} muted {until} ({scope})")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_forever_and_timed_mutes() {
        assert_eq!(
            describe(&json!({"channel":"ops","until":null,"everything":false})),
            "#ops muted until you unmute it (messages to you still notify)"
        );
        assert_eq!(
            describe(
                &json!({"channel":"ops","until":"2026-11-20T04:00:00.000Z","everything":true})
            ),
            "#ops muted until 2026-11-20T04:00:00.000Z (everything muted)"
        );
    }

    #[test]
    fn rejects_other_durations_before_any_request() {
        let url = Url::parse("http://127.0.0.1:9").unwrap();
        let error = mute(&url, "team", "t", "ops", Some("2h"), false).unwrap_err();
        assert!(error.to_string().contains("1h or 1d"), "{error}");
    }
}
