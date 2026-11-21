//! Waiting on every board a key can read at once (ADR 0069). One process lists the boards,
//! catches each one up from its own progress, then long-polls the workspace event feed and reads
//! only the boards an event names. It finds the first message addressed to one name, using the
//! shared addressee rule (ADR 0067), so a message addressed to several names counts for each.
//!
//! The module never moves progress itself: the caller says where each board starts (`msn wait
//! --all` uses its reader cursors, the MCP `wait_all` tool uses processing progress) and decides
//! what to do with a hit. That keeps it reusable by anything else that watches boards.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::client::{MsnClient, RawResponse, error_message, is_retryable_status, status_error};
use crate::config::{MAX_SAFE_INTEGER, MAX_WAIT};
use crate::error::CliError;
use crate::processing::get_interruptible;

const PAGE: u64 = 100;
const BACKOFF_START_MS: u64 = 1000;
const BACKOFF_MAX_MS: u64 = 15000;

/// A message addressed to the watched name, and the board it is on.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub channel: String,
    pub message: Value,
    /// The board progress the search started from; the caller rechecks it under its lock.
    pub progress: u64,
}

/// What reading one board from its progress found.
#[derive(Debug, PartialEq)]
pub enum Scan {
    Found(Value),
    /// Nothing addressed through this message id (the progress itself when the board is quiet).
    Clear(u64),
    /// The board is archived (ADR 0046): nothing new will arrive there.
    Archived,
}

/// True when `message` is addressed to `name` and someone else sent it. Names match trimmed and
/// ignoring case, as unread counts do (ADR 0045); a message to everyone is not addressed.
pub fn addressed_to(message: &Value, name: &str) -> bool {
    // The sender is folded too, so `--username Reviewer` ignores its own messages as "reviewer".
    let fold = |value: &str| crate::status::js_trim(value).to_lowercase();
    let me = fold(name);
    let sender = message.get("username").and_then(Value::as_str).map(fold);
    if me.is_empty() || sender.as_deref() == Some(me.as_str()) {
        return false;
    }
    crate::address::addressees(message)
        .iter()
        .any(|to| fold(to) == me)
}

/// One workspace as seen by one key.
pub struct Boards<'a> {
    client: Arc<MsnClient>,
    tenant: &'a str,
    token: &'a str,
    stop: &'a AtomicBool,
    /// After this, failures are no longer retried and the catch-up stops (the MCP tool's bound).
    give_up: Option<Instant>,
}

impl<'a> Boards<'a> {
    pub fn new(
        client: Arc<MsnClient>,
        tenant: &'a str,
        token: &'a str,
        stop: &'a AtomicBool,
    ) -> Self {
        Self {
            client,
            tenant,
            token,
            stop,
            give_up: None,
        }
    }

    /// Bounds retries and the catch-up: once `at` passes, a failure is returned instead of
    /// retried, and `first_addressed` stops catching up. `msn wait --all` has no bound.
    pub fn give_up_at(mut self, at: Instant) -> Self {
        self.give_up = Some(at);
        self
    }

    fn given_up(&self, after: Duration) -> bool {
        self.give_up.is_some_and(|at| Instant::now() + after >= at)
    }

    /// A GET that retries 429, 5xx and transport failures with backoff. `None` means stopped.
    fn get(&self, path: &str) -> Result<Option<RawResponse>, CliError> {
        let mut backoff = BACKOFF_START_MS;
        loop {
            let Some(result) = get_interruptible(
                Arc::clone(&self.client),
                path.to_string(),
                self.token.to_string(),
                self.stop,
            )?
            else {
                return Ok(None);
            };
            let reason = match result {
                Ok(response) if (300..400).contains(&response.status) => {
                    return Err(CliError::network("Redirects are not allowed"));
                }
                Ok(response) if is_retryable_status(response.status) => {
                    error_message(response.status, &response.body)
                }
                Ok(response) => return Ok(Some(response)),
                Err(CliError::Network(message)) => message,
                Err(error) => return Err(error),
            };
            if self.given_up(Duration::from_millis(backoff)) {
                return Err(CliError::network(reason));
            }
            eprintln!("{reason}; retrying in {}s", backoff / 1000);
            let until = Instant::now() + Duration::from_millis(backoff);
            while Instant::now() < until {
                if self.stop.load(Ordering::SeqCst) {
                    return Ok(None);
                }
                thread::sleep(Duration::from_millis(50));
            }
            backoff = (backoff * 2).min(BACKOFF_MAX_MS);
        }
    }

    fn get_json(&self, path: &str) -> Result<Option<Value>, CliError> {
        let Some(response) = self.get(path)? else {
            return Ok(None);
        };
        if !(200..300).contains(&response.status) {
            return Err(status_error(response.status, &response.body));
        }
        serde_json::from_str(&response.body)
            .map(Some)
            .map_err(|_| CliError::generic("Response was not JSON."))
    }

    /// Every active board the key can read, by name. Archived boards are left out, as in the
    /// default board list.
    pub fn list(&self) -> Result<Option<Vec<String>>, CliError> {
        let mut names = Vec::new();
        let mut after = String::new();
        loop {
            let path = format!(
                "/api/tenants/{}/channels?limit=1000&after={after}",
                self.tenant
            );
            let Some(page) = self.get_json(&path)? else {
                return Ok(None);
            };
            let rows = page["channels"]
                .as_array()
                .ok_or_else(|| CliError::generic("Invalid channel list."))?;
            for row in rows {
                let name = row["name"]
                    .as_str()
                    .ok_or_else(|| CliError::generic("Invalid channel list."))?;
                crate::config::slug(name)?;
                names.push(name.to_string());
            }
            match (page["hasMore"].as_bool(), rows.last()) {
                (Some(true), Some(last)) => after = last["name"].as_str().unwrap_or("").into(),
                _ => return Ok(Some(names)),
            }
        }
    }

    /// The newest event id this key can see. A server before ADR 0069 has no head route, so the
    /// journal is paged to its end instead (slower, same answer).
    pub fn event_head(&self) -> Result<Option<u64>, CliError> {
        let Some(response) = self.get(&format!("/api/tenants/{}/events/head", self.tenant))? else {
            return Ok(None);
        };
        if (200..300).contains(&response.status) {
            let page: Value = serde_json::from_str(&response.body)
                .map_err(|_| CliError::generic("Response was not JSON."))?;
            return page["head"]
                .as_u64()
                .filter(|head| *head <= MAX_SAFE_INTEGER)
                .map(Some)
                .ok_or_else(|| CliError::generic("Invalid event head."));
        }
        if response.status != 404 {
            return Err(status_error(response.status, &response.body));
        }
        let mut after = 0;
        loop {
            let Some((_, next, more)) = self.events(after, 0)? else {
                return Ok(None);
            };
            after = next;
            if !more {
                return Ok(Some(after));
            }
        }
    }

    /// One event page after `after`, waiting up to `wait` seconds: the boards that got a new
    /// message or were created, in event order and without repeats, the next cursor, and hasMore.
    pub fn events(
        &self,
        after: u64,
        wait: u64,
    ) -> Result<Option<(Vec<String>, u64, bool)>, CliError> {
        let path = format!(
            "/api/tenants/{}/events?after={after}&wait={wait}&limit={PAGE}",
            self.tenant
        );
        let Some(response) = self.get(&path)? else {
            return Ok(None);
        };
        if !(200..300).contains(&response.status) {
            return Err(status_error(response.status, &response.body));
        }
        let (rows, next) =
            crate::events::validate_events_page(&response.body, self.tenant, None, after, PAGE)?;
        let more = serde_json::from_str::<Value>(&response.body)
            .ok()
            .and_then(|page| page["hasMore"].as_bool())
            .unwrap_or(false);
        let mut touched: Vec<String> = Vec::new();
        for event in &rows {
            let kind = event["type"].as_str().unwrap_or_default();
            let channel = event["channel"].as_str().unwrap_or_default();
            if matches!(kind, "message.created" | "channel.created")
                && !touched.iter().any(|seen| seen == channel)
            {
                touched.push(channel.to_string());
            }
        }
        Ok(Some((touched, next, more)))
    }

    /// One page of `channel` after `after` (no waiting).
    fn messages(&self, channel: &str, after: u64) -> Result<Option<Value>, CliError> {
        self.get_json(&format!(
            "/api/tenants/{}/channels/{channel}/messages?after={after}&wait=0&limit={PAGE}",
            self.tenant
        ))
    }

    /// Reads `channel` after `after` until the first message addressed to `name`, or its end.
    pub fn scan(&self, channel: &str, after: u64, name: &str) -> Result<Option<Scan>, CliError> {
        let mut after = after;
        loop {
            let Some(page) = self.messages(channel, after)? else {
                return Ok(None);
            };
            let messages = page["messages"]
                .as_array()
                .ok_or_else(|| CliError::generic("Response was not JSON."))?;
            if messages.is_empty() && page["archived"].as_bool() == Some(true) {
                return Ok(Some(Scan::Archived));
            }
            if let Some(found) = messages.iter().find(|m| addressed_to(m, name)) {
                return Ok(Some(Scan::Found(found.clone())));
            }
            let next = page["nextCursor"].as_u64().unwrap_or(after);
            if messages.is_empty() || page["hasMore"].as_bool() != Some(true) || next <= after {
                return Ok(Some(Scan::Clear(next.max(after))));
            }
            after = next;
        }
    }

    /// Every message on `channel` after `after` up to and including `through`, in id order.
    pub fn through(
        &self,
        channel: &str,
        after: u64,
        through: u64,
    ) -> Result<Option<Vec<Value>>, CliError> {
        let mut out = Vec::new();
        let mut after = after;
        while after < through {
            let Some(page) = self.messages(channel, after)? else {
                return Ok(None);
            };
            let messages = page["messages"]
                .as_array()
                .ok_or_else(|| CliError::generic("Response was not JSON."))?;
            for message in messages {
                if message["id"].as_u64().is_some_and(|id| id <= through) {
                    out.push(message.clone());
                }
            }
            let next = page["nextCursor"].as_u64().unwrap_or(after);
            if messages.is_empty() || next <= after {
                break;
            }
            after = next;
        }
        Ok(Some(out))
    }
}

/// Remembers, per board, how far a search already read past the board's progress, so an event
/// rereads only what is new. Reset for a board whenever its progress moves.
#[derive(Debug, Default)]
pub struct Memo(HashMap<String, (u64, u64)>);

impl Memo {
    fn start(&self, channel: &str, progress: u64) -> u64 {
        match self.0.get(channel) {
            Some((seen, through)) if *seen == progress => (*through).max(progress),
            _ => progress,
        }
    }
}

/// Finds the first message addressed to `name` on any board, starting each board at
/// `progress(channel)`. Boards are caught up first (in name order), then the event feed is
/// long-polled and only the boards it names are read again. Returns `None` when `deadline`
/// passes (a `None` deadline waits until `boards` is stopped) or when stopped.
pub fn first_addressed(
    boards: &Boards<'_>,
    name: &str,
    progress: &mut dyn FnMut(&str) -> Result<u64, CliError>,
    memo: &mut Memo,
    poll: u64,
    deadline: Option<Instant>,
) -> Result<Option<Hit>, CliError> {
    let poll = poll.clamp(1, MAX_WAIT);
    // The head is read before catching up, so a message sent during the catch-up still has an
    // event after the cursor.
    let Some(mut cursor) = boards.event_head()? else {
        return Ok(None);
    };
    let Some(names) = boards.list()? else {
        return Ok(None);
    };
    let mut check = |channel: &str, memo: &mut Memo| -> Result<Option<Hit>, CliError> {
        let start = progress(channel)?;
        let from = memo.start(channel, start);
        match boards.scan(channel, from, name)? {
            None => Ok(None),
            Some(Scan::Found(message)) => Ok(Some(Hit {
                channel: channel.to_string(),
                message,
                progress: start,
            })),
            Some(Scan::Clear(through)) => {
                memo.0.insert(channel.to_string(), (start, through));
                Ok(None)
            }
            Some(Scan::Archived) => {
                memo.0.remove(channel);
                Ok(None)
            }
        }
    };
    for channel in &names {
        if boards.given_up(Duration::ZERO) {
            return Ok(None);
        }
        if let Some(hit) = check(channel, memo)? {
            return Ok(Some(hit));
        }
    }
    loop {
        let wait = match deadline {
            Some(deadline) => {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Ok(None);
                }
                // Round up, so the last poll still waits instead of spinning at wait=0.
                (left.as_secs() + u64::from(left.subsec_nanos() > 0)).min(poll)
            }
            None => poll,
        };
        let Some((touched, next, _)) = boards.events(cursor, wait)? else {
            return Ok(None);
        };
        cursor = next;
        for channel in &touched {
            if let Some(hit) = check(channel, memo)? {
                return Ok(Some(hit));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn addressed_to_uses_every_name_trimmed_and_ignoring_case() {
        let several =
            json!({"username": "lead", "to": "reviewer", "recipients": ["reviewer", " Tester "]});
        assert!(addressed_to(&several, "reviewer"));
        assert!(addressed_to(&several, "tester"));
        assert!(!addressed_to(&several, "lead"));
        assert!(addressed_to(
            &json!({"username": "lead", "to": "Bob"}),
            " bob"
        ));
        // A message to everyone, or one's own message to oneself, is not news.
        assert!(!addressed_to(&json!({"username": "lead"}), "bob"));
        assert!(!addressed_to(
            &json!({"username": "bob", "to": "bob"}),
            "bob"
        ));
        assert!(!addressed_to(
            &json!({"username": " Bob", "to": "bob"}),
            "BOB"
        ));
        assert!(!addressed_to(
            &json!({"username": "lead", "to": "bob"}),
            " "
        ));
    }

    #[test]
    fn a_bound_stops_retrying_and_catching_up() {
        let stop = AtomicBool::new(false);
        let url = url::Url::parse("http://127.0.0.1:9").unwrap();
        let client = Arc::new(MsnClient::new(&url).unwrap());
        let boards = Boards::new(Arc::clone(&client), "team", "t", &stop);
        assert!(
            !boards.given_up(Duration::from_secs(3600)),
            "no bound by default"
        );
        let bounded = Boards::new(client, "team", "t", &stop).give_up_at(Instant::now());
        assert!(bounded.given_up(Duration::ZERO));
        // A refused connection is not retried past the bound: it returns the failure.
        let started = Instant::now();
        assert!(matches!(bounded.get("/x"), Err(CliError::Network(_))));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn memo_resumes_only_while_progress_is_unchanged() {
        let mut memo = Memo::default();
        assert_eq!(memo.start("general", 4), 4);
        memo.0.insert("general".into(), (4, 9));
        assert_eq!(memo.start("general", 4), 9);
        // Progress moved (someone read or committed): read again from the new progress.
        assert_eq!(memo.start("general", 6), 6);
        assert_eq!(memo.start("general", 12), 12);
    }
}
