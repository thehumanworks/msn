//! Links to a single message (ADR 0042).
//!
//! `ORIGIN/#board=TENANT/CHANNEL&msg=ID` opens the web app on that board, scrolled to the message
//! and highlighted. A link names a message, never a credential: whoever opens it reads with their
//! own access. The CLI, `msn mcp` and the desktop client build links here; the web app and the iOS
//! client build the same form.
use serde_json::{Value, json};
use url::Url;

use crate::agent;
use crate::config::origin_base;
use crate::error::CliError;

/// The link for message `id` of `channel` in `tenant`, on the server at `url`.
pub fn message_link(url: &Url, tenant: &str, channel: &str, id: u64) -> String {
    format!("{}/#board={tenant}/{channel}&msg={id}", origin_base(url))
}

/// Checks the message exists (404 not found and 410 deleted are errors, as for `msn show`), then
/// returns `{link, channel, id}`.
pub fn checked_link(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    id: u64,
) -> Result<Value, CliError> {
    agent::show(url, tenant, token, channel, id)?;
    Ok(json!({
        "link": message_link(url, tenant, channel, id),
        "channel": channel,
        "id": id,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_uses_the_origin_and_names_no_credential() {
        let url = Url::parse("https://msn.example/some/path?x=1").unwrap();
        assert_eq!(
            message_link(&url, "acme", "general", 42),
            "https://msn.example/#board=acme/general&msg=42"
        );
        let local = Url::parse("http://127.0.0.1:8787").unwrap();
        assert_eq!(
            message_link(&local, "acme", "ops", 7),
            "http://127.0.0.1:8787/#board=acme/ops&msg=7"
        );
    }
}
