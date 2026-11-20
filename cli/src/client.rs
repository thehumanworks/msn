use std::io::{self, Write};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use ureq::Agent;
use url::Url;

use crate::config::origin_base;
use crate::error::CliError;

pub struct MsnClient {
    agent: Agent,
    origin: String,
}

/// Largest file body the CLI will read; the server caps attachments well below this.
const BINARY_LIMIT: u64 = 8 * 1024 * 1024;

pub struct BinaryResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub disposition: Option<String>,
    pub body: Vec<u8>,
}

pub struct RawResponse {
    pub status: u16,
    pub body: String,
}

impl MsnClient {
    pub fn new(url: &Url) -> Result<Self, CliError> {
        Self::with_timeouts(url, Duration::from_secs(10), Duration::from_secs(40))
    }

    /// A client whose every request gives up after `total` (connecting after `connect`).
    /// Long polls need the default; quick checks such as `msn doctor` use a short one.
    pub fn with_timeouts(url: &Url, connect: Duration, total: Duration) -> Result<Self, CliError> {
        let config = Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_connect(Some(connect.min(total)))
            .timeout_recv_response(Some(total))
            .timeout_global(Some(total))
            .proxy(None)
            .build();
        Ok(Self {
            agent: Agent::from(config),
            origin: origin_base(url),
        })
    }

    pub fn get(&self, path: &str, token: Option<&str>) -> Result<RawResponse, CliError> {
        self.exchange("GET", path, token, &[], None::<&Value>)
    }

    pub fn put(&self, path: &str, token: &str) -> Result<RawResponse, CliError> {
        self.exchange("PUT", path, Some(token), &[], None::<&Value>)
    }

    /// PUT/POST with an optional JSON body; `None` sends an empty body without a Content-Type.
    pub fn send_optional_json(
        &self,
        method: &str,
        path: &str,
        token: &str,
        body: Option<&Value>,
    ) -> Result<RawResponse, CliError> {
        self.exchange(method, path, Some(token), &[], body)
    }

    pub fn post_json<T: Serialize>(
        &self,
        path: &str,
        token: &str,
        extra: &[(&str, &str)],
        body: &T,
    ) -> Result<RawResponse, CliError> {
        self.exchange("POST", path, Some(token), extra, Some(body))
    }

    pub fn delete(&self, path: &str, token: &str) -> Result<RawResponse, CliError> {
        self.exchange("DELETE", path, Some(token), &[], None::<&Value>)
    }

    /// POST raw bytes (an attachment upload); the server reads them as an opaque file.
    pub fn post_bytes(
        &self,
        path: &str,
        token: &str,
        data: &[u8],
    ) -> Result<RawResponse, CliError> {
        let url = format!("{}{path}", self.origin);
        let req = apply_headers(
            self.agent.post(&url),
            Some(token),
            &[("Content-Type", "application/octet-stream")],
        );
        match req.send(data) {
            Ok(mut response) => {
                let status = response.status().as_u16();
                let body = response.body_mut().read_to_string().map_err(map_ureq)?;
                Ok(RawResponse { status, body })
            }
            Err(error) => Err(map_ureq(error)),
        }
    }

    /// GET a file. On success returns its bytes and response headers; errors keep the JSON body.
    pub fn get_bytes(&self, path: &str, token: &str) -> Result<BinaryResponse, CliError> {
        let url = format!("{}{path}", self.origin);
        let mut response = apply_headers(self.agent.get(&url), Some(token), &[])
            .call()
            .map_err(map_ureq)?;
        let status = response.status().as_u16();
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        };
        let content_type = header("content-type");
        let disposition = header("content-disposition");
        let body = response
            .body_mut()
            .with_config()
            .limit(BINARY_LIMIT)
            .read_to_vec()
            .map_err(map_ureq)?;
        Ok(BinaryResponse {
            status,
            content_type,
            disposition,
            body,
        })
    }

    pub(crate) fn exchange<T: Serialize>(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        extra: &[(&str, &str)],
        body: Option<&T>,
    ) -> Result<RawResponse, CliError> {
        let url = format!("{}{path}", self.origin);
        let result = match method {
            "GET" => apply_headers(self.agent.get(&url), token, extra).call(),
            "DELETE" => apply_headers(self.agent.delete(&url), token, extra).call(),
            "PUT" => {
                let req = apply_headers(self.agent.put(&url), token, extra);
                if let Some(payload) = body {
                    req.send_json(payload)
                } else {
                    req.send_empty()
                }
            }
            "POST" => {
                let req = apply_headers(self.agent.post(&url), token, extra);
                if let Some(payload) = body {
                    req.send_json(payload)
                } else {
                    req.send_empty()
                }
            }
            "PATCH" => {
                let req = apply_headers(self.agent.patch(&url), token, extra);
                if let Some(payload) = body {
                    req.send_json(payload)
                } else {
                    req.send_empty()
                }
            }
            other => return Err(CliError::generic(format!("Unsupported method {other}"))),
        };
        match result {
            Ok(mut response) => {
                let status = response.status().as_u16();
                let body = response.body_mut().read_to_string().map_err(map_ureq)?;
                Ok(RawResponse { status, body })
            }
            Err(error) => Err(map_ureq(error)),
        }
    }
}

fn apply_headers<B>(
    mut req: ureq::RequestBuilder<B>,
    token: Option<&str>,
    extra: &[(&str, &str)],
) -> ureq::RequestBuilder<B> {
    if let Some(token) = token {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    for (name, value) in extra {
        req = req.header(*name, *value);
    }
    req
}

fn map_ureq(error: ureq::Error) -> CliError {
    CliError::network(error.to_string())
}

pub fn print_success(status: u16, body: &str) -> Result<(), CliError> {
    if status == 204 {
        println!("{{\"deleted\":true}}");
        return io::stdout()
            .flush()
            .map_err(|error| CliError::generic(error.to_string()));
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(CliError::generic("Empty response body"));
    }
    serde_json::from_str::<Value>(trimmed)
        .map_err(|_| CliError::generic("Response was not JSON"))?;
    println!("{trimmed}");
    io::stdout()
        .flush()
        .map_err(|error| CliError::generic(error.to_string()))
}

pub fn classify(status: u16, body: &str) -> Result<(), CliError> {
    if (300..400).contains(&status) {
        return Err(CliError::network("Redirects are not allowed"));
    }
    if (200..300).contains(&status) {
        return Ok(());
    }
    Err(status_error(status, body))
}

pub fn status_error(status: u16, body: &str) -> CliError {
    let message = error_message(status, body);
    match status {
        401 | 403 => CliError::auth(message),
        404 => CliError::not_found(message),
        409 | 410 => CliError::conflict(message),
        _ => CliError::generic(message),
    }
}

pub fn error_message(status: u16, body: &str) -> String {
    let detail = match serde_json::from_str::<Value>(body) {
        Ok(value) => value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| fallback_body(body)),
        Err(_) => fallback_body(body),
    };
    format!("{status}: {detail}")
}

fn fallback_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        "Request failed".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn is_retryable_status(status: u16) -> bool {
    status == 429 || (500..600).contains(&status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn given_409_envelope_when_classify_then_conflict() {
        let err = classify(409, r#"{"error":{"code":"x","message":"nope"}}"#).unwrap_err();
        assert_eq!(err.exit_code(), 5);
        assert!(err.to_string().contains("nope"));
    }

    #[test]
    fn given_401_plain_when_classify_then_auth() {
        let err = classify(401, "denied").unwrap_err();
        assert_eq!(err.exit_code(), 3);
        assert_eq!(err.to_string(), "401: denied");
    }

    #[test]
    fn given_302_when_classify_then_network() {
        assert_eq!(classify(302, "").unwrap_err().exit_code(), 6);
    }

    #[test]
    fn retryable_is_429_and_5xx_only() {
        assert!(is_retryable_status(429));
        assert!(is_retryable_status(503));
        assert!(!is_retryable_status(404));
        assert!(!is_retryable_status(401));
        assert!(!is_retryable_status(200));
    }
}
