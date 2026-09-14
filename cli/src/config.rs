use url::Url;

use crate::error::CliError;

pub const DEFAULT_URL: &str = "https://msn.rodat-human-ada.workers.dev";
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_WAIT: u64 = 25;
pub const MAX_LIMIT: u64 = 100;
pub const CHANNELS_PAGE_LIMIT: u64 = 1000;

pub fn parse_origin(raw: &str) -> Result<Url, CliError> {
    let url = Url::parse(raw).map_err(|_| {
        CliError::usage(
            "MSN_URL must be a server origin without credentials, path, query or fragment.",
        )
    })?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CliError::usage(
            "MSN_URL must be a server origin without credentials, path, query or fragment.",
        ));
    }
    let path = url.path();
    if path != "/" && !path.is_empty() {
        return Err(CliError::usage(
            "MSN_URL must be a server origin without credentials, path, query or fragment.",
        ));
    }
    match url.scheme() {
        "https" => {}
        "http" if is_localhost(url.host_str()) => {}
        "http" => {
            return Err(CliError::usage(
                "Use HTTPS (HTTP is allowed only on localhost).",
            ));
        }
        _ => {
            return Err(CliError::usage(
                "MSN_URL must be a server origin without credentials, path, query or fragment.",
            ));
        }
    }
    Ok(url)
}

pub fn origin_key(url: &Url) -> String {
    url.origin().ascii_serialization()
}

pub fn origin_base(url: &Url) -> String {
    origin_key(url)
}

fn is_localhost(host: Option<&str>) -> bool {
    matches!(host, Some("localhost" | "127.0.0.1" | "::1" | "[::1]"))
}

pub fn slug(value: &str) -> Result<&str, CliError> {
    if is_slug(value) {
        Ok(value)
    } else {
        Err(CliError::usage(
            "Use a lowercase tenant/channel identifier (1–64 letters, digits, _ or -).",
        ))
    }
}

pub fn is_slug(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let first = bytes[0];
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    bytes
        .iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

pub fn parse_int(raw: &str, max: u64) -> Result<u64, CliError> {
    if !is_canonical_uint(raw) {
        return Err(CliError::usage(format!("Invalid integer: {raw}")));
    }
    let parsed: u64 = raw
        .parse()
        .map_err(|_| CliError::usage(format!("Invalid integer: {raw}")))?;
    if parsed > max {
        return Err(CliError::usage(format!("Invalid integer: {raw}")));
    }
    Ok(parsed)
}

pub fn is_canonical_uint(raw: &str) -> bool {
    if raw == "0" {
        return true;
    }
    let mut chars = raw.chars();
    match chars.next() {
        Some(first) if first.is_ascii_digit() && first != '0' => chars.all(|c| c.is_ascii_digit()),
        _ => false,
    }
}

pub fn require_token(value: Option<&str>, env_name: &str) -> Result<String, CliError> {
    match value {
        Some(token) if !token.is_empty() => Ok(token.to_string()),
        _ => Err(CliError::usage(format!("Set {env_name}."))),
    }
}

pub fn require_tenant(value: Option<&str>) -> Result<String, CliError> {
    let raw = value.ok_or_else(|| CliError::usage("Set MSN_WORKSPACE_TENANT."))?;
    slug(raw).map(str::to_string)
}

pub fn require_username(value: Option<&str>) -> Result<String, CliError> {
    match value {
        Some(name) if !name.trim().is_empty() => Ok(name.to_string()),
        _ => Err(CliError::usage("Set MSN_USERNAME and pass --text.")),
    }
}

pub const MAX_CORRELATION_BYTES: usize = 128;

/// Mirrors the Worker's rule: non-blank, at most 128 UTF-8 bytes. Fail before any network call.
pub fn require_correlation_id(value: &str) -> Result<String, CliError> {
    if value.trim().is_empty() || value.len() > MAX_CORRELATION_BYTES {
        return Err(CliError::usage(
            "--correlation-id must be non-blank text of at most 128 UTF-8 bytes.",
        ));
    }
    Ok(value.to_string())
}

pub fn require_text(value: &str) -> Result<String, CliError> {
    if value.trim().is_empty() {
        return Err(CliError::usage("Set MSN_USERNAME and pass --text."));
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn given_http_remote_when_parse_origin_then_usage() {
        let err = parse_origin("http://remote.test").unwrap_err();
        assert_eq!(err.exit_code(), 2);
        assert!(err.to_string().contains("HTTPS"));
    }

    #[test]
    fn given_https_origin_when_parse_origin_then_ok() {
        assert!(parse_origin("https://msn.test").is_ok());
        assert!(parse_origin("https://msn.rodat-human-ada.workers.dev").is_ok());
    }

    #[test]
    fn given_credentials_or_path_when_parse_origin_then_usage() {
        for raw in [
            "https://user:password@msn.test",
            "https://user@msn.test",
            "https://msn.test/path",
            "https://msn.test/?token=secret",
            "https://msn.test/#frag",
        ] {
            assert_eq!(parse_origin(raw).unwrap_err().exit_code(), 2, "{raw}");
        }
    }

    #[test]
    fn given_localhost_http_when_parse_origin_then_ok() {
        assert!(parse_origin("http://127.0.0.1:8787").is_ok());
        assert!(parse_origin("http://localhost:8787").is_ok());
        assert!(parse_origin("http://[::1]:8787").is_ok());
    }

    #[test]
    fn given_uppercase_when_slug_then_usage() {
        assert_eq!(slug("UPPER").unwrap_err().exit_code(), 2);
        assert!(!is_slug(""));
        assert!(!is_slug("_foo"));
        assert!(!is_slug("-x"));
        assert!(!is_slug(&"a".repeat(65)));
        assert!(is_slug(&"a".repeat(64)));
        assert!(is_slug("1abc"));
        assert!(is_slug("a_b-c1"));
        assert!(slug("general").is_ok());
        assert!(slug("a").is_ok());
    }

    #[test]
    fn given_empty_token_or_blank_username_then_usage() {
        assert_eq!(
            require_token(Some(""), "MSN_WORKSPACE_TOKEN")
                .unwrap_err()
                .exit_code(),
            2
        );
        assert_eq!(require_username(Some("   ")).unwrap_err().exit_code(), 2);
        assert_eq!(require_text("   ").unwrap_err().exit_code(), 2);
    }

    #[test]
    fn given_blank_or_long_correlation_id_then_usage() {
        assert_eq!(require_correlation_id("").unwrap_err().exit_code(), 2);
        assert_eq!(require_correlation_id("  ").unwrap_err().exit_code(), 2);
        assert_eq!(
            require_correlation_id(&"x".repeat(129))
                .unwrap_err()
                .exit_code(),
            2
        );
        assert_eq!(
            require_correlation_id(&"x".repeat(128)).unwrap(),
            "x".repeat(128)
        );
        // 33 four-byte characters is 132 bytes; 32 is exactly 128.
        assert_eq!(
            require_correlation_id(&"🙂".repeat(33))
                .unwrap_err()
                .exit_code(),
            2
        );
        assert!(require_correlation_id(&"🙂".repeat(32)).is_ok());
        assert_eq!(require_correlation_id("task-7").unwrap(), "task-7");
    }

    #[test]
    fn given_leading_zero_when_parse_int_then_usage() {
        assert_eq!(parse_int("08", 25).unwrap_err().exit_code(), 2);
        assert_eq!(parse_int("-1", 25).unwrap_err().exit_code(), 2);
        assert_eq!(parse_int("26", 25).unwrap_err().exit_code(), 2);
        assert_eq!(parse_int("0", 25).unwrap(), 0);
        assert_eq!(parse_int("25", 25).unwrap(), 25);
    }
}
