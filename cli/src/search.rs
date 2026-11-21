//! Message search (ADR 0037): local validation and the request path. The server re-validates;
//! checking here turns typos into usage errors (exit 2) before any network call.

use serde_json::Value;
use url::Url;

use crate::error::CliError;
use crate::labels;
use crate::links;

pub const MAX_QUERY_CHARS: usize = 256;
pub const DEFAULT_LIMIT: u64 = 20;

/// What to look for. At least one of `text`, `from`, `kind` or `labels` must be given.
#[derive(Debug, Default)]
pub struct Search<'a> {
    pub text: Option<&'a str>,
    pub from: Option<&'a str>,
    pub kind: Option<&'a str>,
    pub labels: &'a [String],
    pub before: Option<u64>,
    pub limit: u64,
}

/// GET path for one page of one channel's results, newest first.
pub fn path(tenant: &str, channel: &str, search: &Search<'_>) -> Result<String, CliError> {
    Ok(format!(
        "/api/tenants/{tenant}/channels/{channel}/search?{}",
        query(search)?
    ))
}

/// GET path for one page of results from every board the key can read (ADR 0072), newest first.
/// The server chooses the boards from the key: a board's shared key or an invited key gets only
/// its own board. Archived boards are left out unless `archived`.
pub fn path_all(tenant: &str, search: &Search<'_>, archived: bool) -> Result<String, CliError> {
    Ok(format!(
        "/api/tenants/{tenant}/search?{}{}",
        query(search)?,
        if archived { "&include=archived" } else { "" }
    ))
}

/// Adds `link` (ADR 0042) to every message of an every-board answer, so a reader can open a match
/// without knowing which board it is on. A message without a channel or id is left as it is.
pub fn with_links(url: &Url, tenant: &str, mut answer: Value) -> Value {
    if let Some(messages) = answer.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            let link = match (
                message.get("channel").and_then(Value::as_str),
                message.get("id").and_then(Value::as_u64),
            ) {
                (Some(channel), Some(id)) => links::message_link(url, tenant, channel, id),
                _ => continue,
            };
            if let Some(fields) = message.as_object_mut() {
                fields.insert("link".to_owned(), Value::String(link));
            }
        }
    }
    answer
}

fn query(search: &Search<'_>) -> Result<String, CliError> {
    let text = search.text.map(str::trim).filter(|text| !text.is_empty());
    if text.is_none() && search.from.is_none() && search.kind.is_none() && search.labels.is_empty()
    {
        return Err(CliError::usage(
            "Give words to search for, or --from, --kind or --label.",
        ));
    }
    if search.limit < 1 || search.limit > 100 {
        return Err(CliError::usage("limit must be an integer from 1 to 100."));
    }
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    if let Some(text) = text {
        if text.chars().count() > MAX_QUERY_CHARS {
            return Err(CliError::usage(format!(
                "Search text must be at most {MAX_QUERY_CHARS} characters."
            )));
        }
        if !text.chars().any(|c| c.is_alphanumeric() || c == '_') {
            return Err(CliError::usage("Search text has no words to search for."));
        }
        query.append_pair("q", text);
    }
    if let Some(from) = search.from {
        if from.is_empty() || from.len() > 128 {
            return Err(CliError::usage(
                "--from must be a display name of 1-128 bytes.",
            ));
        }
        query.append_pair("from", from);
    }
    if let Some(kind) = search.kind {
        if !["text", "json"].contains(&kind) {
            return Err(CliError::usage("--kind must be text or json."));
        }
        query.append_pair("kind", kind);
    }
    if let Some(before) = search.before {
        query.append_pair("before", &before.to_string());
    }
    query.append_pair("limit", &search.limit.to_string());
    Ok(format!(
        "{}{}",
        query.finish(),
        labels::filter_query(search.labels)?
    ))
}

/// Splits what a person typed into search words and a `from:name` sender, as the web, desktop and
/// iOS search boxes do. The last `from:` wins; the rest is the search text.
pub fn split_from(input: &str) -> (String, Option<String>) {
    let mut from = None;
    let mut words = Vec::new();
    for word in input.split_whitespace() {
        match word.strip_prefix("from:") {
            Some(name) if !name.is_empty() => from = Some(name.to_owned()),
            _ => words.push(word),
        }
    }
    (words.join(" "), from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn given_from_word_when_split_then_sender_and_text() {
        assert_eq!(
            split_from("deploy from:ada  \"on friday\""),
            ("deploy \"on friday\"".to_owned(), Some("ada".to_owned()))
        );
        assert_eq!(split_from("from: plain"), ("from: plain".to_owned(), None));
        assert_eq!(
            split_from("from:a from:b"),
            (String::new(), Some("b".to_owned()))
        );
    }

    fn search(text: Option<&str>) -> Search<'_> {
        Search {
            text,
            limit: DEFAULT_LIMIT,
            ..Search::default()
        }
    }

    #[test]
    fn given_words_when_path_then_query_is_encoded() {
        let path = path("t", "general", &search(Some("deploy \"on friday\""))).unwrap();
        assert_eq!(
            path,
            "/api/tenants/t/channels/general/search?q=deploy+%22on+friday%22&limit=20"
        );
    }

    #[test]
    fn given_filters_only_when_path_then_no_q() {
        let labels = vec!["state=open".to_owned()];
        let path = path(
            "t",
            "general",
            &Search {
                from: Some("ada lovelace"),
                kind: Some("json"),
                labels: &labels,
                before: Some(42),
                limit: 5,
                ..Search::default()
            },
        )
        .unwrap();
        assert_eq!(
            path,
            "/api/tenants/t/channels/general/search?from=ada+lovelace&kind=json&before=42&limit=5&label=state%3Dopen"
        );
    }

    #[test]
    fn given_every_board_when_path_then_no_channel_in_it() {
        let labels = vec!["state=open".to_owned()];
        let all = Search {
            text: Some("deploy"),
            labels: &labels,
            limit: 5,
            ..Search::default()
        };
        assert_eq!(
            path_all("t", &all, false).unwrap(),
            "/api/tenants/t/search?q=deploy&limit=5&label=state%3Dopen"
        );
        assert_eq!(
            path_all("t", &all, true).unwrap(),
            "/api/tenants/t/search?q=deploy&limit=5&label=state%3Dopen&include=archived"
        );
        assert_eq!(
            path_all("t", &search(None), false).unwrap_err().exit_code(),
            2
        );
    }

    #[test]
    fn given_every_board_answer_when_with_links_then_each_message_has_its_board_link() {
        let url = Url::parse("https://msn.example/x").unwrap();
        let answer = serde_json::json!({
            "messages": [
                {"id": 9, "channel": "ops", "text": "a"},
                {"id": 4, "channel": "general", "text": "b"},
                {"text": "no id"}
            ],
            "hasMore": false,
            "complete": true
        });
        let linked = with_links(&url, "acme", answer);
        assert_eq!(
            linked["messages"][0]["link"],
            "https://msn.example/#board=acme/ops&msg=9"
        );
        assert_eq!(
            linked["messages"][1]["link"],
            "https://msn.example/#board=acme/general&msg=4"
        );
        assert!(linked["messages"][2].get("link").is_none());
        assert_eq!(linked["hasMore"], false);
        assert_eq!(
            with_links(&url, "acme", serde_json::json!({"x": 1}))["x"],
            1
        );
    }

    #[test]
    fn given_nothing_to_search_when_path_then_usage() {
        for text in [None, Some("   "), Some("!!!")] {
            assert_eq!(path("t", "c", &search(text)).unwrap_err().exit_code(), 2);
        }
        let long = "a".repeat(257);
        assert_eq!(
            path("t", "c", &search(Some(&long)))
                .unwrap_err()
                .exit_code(),
            2
        );
        let bad_kind = Search {
            kind: Some("xml"),
            limit: 20,
            ..Search::default()
        };
        assert_eq!(path("t", "c", &bad_kind).unwrap_err().exit_code(), 2);
    }
}
