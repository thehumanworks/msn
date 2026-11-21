//! Gather answers from several agents (ADR 0071). One question is sent as a normal message to
//! several names (ADR 0067); each named agent's answer is its first reply anywhere in the
//! question's thread (ADR 0063). Gathering reads the board after the question, in order, so it
//! needs no special server route, and a name counts as answered only when a reply was actually
//! posted: silence never counts.
//!
//! Replaced messages (ADR 0068): when an agent replaces its answer, the replacement becomes its
//! answer, even if the replacement was posted outside the thread. When the asker replaces the
//! question itself, gathering stops and reports `replacedBy`: answers to the old question may be
//! stale, so the new question is gathered on its own (`msn gather --question NEW`).

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::address;
use crate::ask::addressed_to;
use crate::error::CliError;

/// The state of one gather: the question, the names it waits on, and what has been seen so far.
#[derive(Debug, Clone)]
pub struct Gather {
    question: u64,
    asker: Option<String>,
    names: Vec<String>,
    /// One slot per name, in order: the answering message once one is seen.
    answers: Vec<Option<Value>>,
    /// Ids in the question's thread: the question and every reply seen to a member.
    thread: HashSet<u64>,
    /// The id of the message that replaced the question, once seen.
    replaced_by: Option<u64>,
    /// The highest message id observed, so a resumed read continues after it.
    after: u64,
}

impl Gather {
    /// Starts from the question as read back from the server (`{"id", "username", "to",
    /// "recipients", …}`). Fails when the question names nobody.
    pub fn new(question: &Value) -> Result<Self, CliError> {
        let id = question["id"]
            .as_u64()
            .ok_or_else(|| CliError::generic("The server did not return the question's id."))?;
        let names: Vec<String> = address::addressees(question)
            .into_iter()
            .map(str::to_owned)
            .collect();
        if names.is_empty() {
            return Err(CliError::usage(format!(
                "Message {id} is not addressed to anyone, so there is nobody to gather answers from."
            )));
        }
        Ok(Self {
            question: id,
            asker: question["username"].as_str().map(str::to_owned),
            answers: vec![None; names.len()],
            names,
            thread: HashSet::from([id]),
            replaced_by: question["replacedBy"].as_u64(),
            after: id,
        })
    }

    pub fn question(&self) -> u64 {
        self.question
    }

    /// The cursor to read after next.
    pub fn after(&self) -> u64 {
        self.after
    }

    /// True when every name has answered, or the question was replaced: nothing more to wait for.
    pub fn finished(&self) -> bool {
        self.replaced_by.is_some() || self.answers.iter().all(Option::is_some)
    }

    pub fn replaced_by(&self) -> Option<u64> {
        self.replaced_by
    }

    /// The names that have not replied yet, in the order the question lists them.
    pub fn pending(&self) -> Vec<&str> {
        self.names
            .iter()
            .zip(&self.answers)
            .filter(|(_, answer)| answer.is_none())
            .map(|(name, _)| name.as_str())
            .collect()
    }

    /// Takes in one page of `GET …/messages?after=…` (messages in id order), and moves the cursor.
    pub fn observe_page(&mut self, page: &Value) {
        if let Some(messages) = page["messages"].as_array() {
            for message in messages {
                self.observe(message);
                if self.replaced_by.is_some() {
                    break;
                }
            }
        }
        if let Some(next) = page["nextCursor"].as_u64() {
            self.after = self.after.max(next);
        }
    }

    /// Takes in one message read after the question. Messages must arrive in id order.
    pub fn observe(&mut self, message: &Value) {
        let Some(id) = message["id"].as_u64() else {
            return;
        };
        if id <= self.question || self.replaced_by.is_some() {
            return;
        }
        self.after = self.after.max(id);
        let author = message["username"].as_str().unwrap_or_default();
        let replaces = message["replaces"].as_u64();
        // The server only lets the sender replace a message (ADR 0068); check it here too.
        if replaces == Some(self.question) && self.asker.as_deref().is_none_or(|a| a == author) {
            self.replaced_by = Some(id);
            return;
        }
        // An agent replacing its recorded answer: the replacement is its answer now.
        if let Some(old) = replaces
            && let Some(slot) = self.answers.iter_mut().find(|slot| {
                slot.as_ref()
                    .is_some_and(|answer| answer["messageId"].as_u64() == Some(old))
            })
            && slot
                .as_ref()
                .is_some_and(|answer| answer["username"].as_str() == Some(author))
        {
            *slot = Some(answer_of(message, slot.as_ref()));
            self.thread.insert(id);
            return;
        }
        let in_thread = message["replyTo"]
            .as_u64()
            .is_some_and(|parent| self.thread.contains(&parent))
            || replaces.is_some_and(|old| self.thread.contains(&old));
        if !in_thread {
            return;
        }
        self.thread.insert(id);
        if let Some(index) = self
            .names
            .iter()
            .zip(&self.answers)
            .position(|(name, answer)| answer.is_none() && addressed_to(author, name))
        {
            self.answers[index] = Some(answer_of(message, None));
        }
    }

    /// The result printed by `msn gather` and returned by the MCP tools.
    pub fn result(&self) -> Value {
        let mut answers = Map::new();
        for (name, answer) in self.names.iter().zip(&self.answers) {
            if let Some(answer) = answer {
                answers.insert(name.clone(), answer.clone());
            }
        }
        let mut out = json!({
            "question": self.question,
            "names": self.names,
            "complete": self.answers.iter().all(Option::is_some),
            "answers": answers,
            "pending": self.pending(),
        });
        if let Some(replaced_by) = self.replaced_by {
            out["replacedBy"] = json!(replaced_by);
        }
        out
    }
}

/// One answer: the reply's author, id, text and time. `previous` is the answer it replaces.
fn answer_of(message: &Value, previous: Option<&Value>) -> Value {
    let mut answer = json!({
        "username": message["username"],
        "messageId": message["id"],
        "text": message["text"],
        "createdAt": message["createdAt"],
    });
    if let Some(content_type) = message["contentType"].as_str() {
        answer["contentType"] = json!(content_type);
    }
    if let Some(previous) = previous {
        let mut replaced: Vec<Value> = previous["replaced"].as_array().cloned().unwrap_or_default();
        replaced.push(previous["messageId"].clone());
        answer["replaced"] = json!(replaced);
    }
    answer
}

/// The POST body of the question: a normal message to several names.
pub fn question_body(username: &str, text: &str, names: &[String], reply_to: Option<u64>) -> Value {
    let mut body = json!({ "username": username, "text": text });
    if let Some(to) = address::to_field(names) {
        body["to"] = to;
    }
    if let Some(reply_to) = reply_to {
        body["replyTo"] = json!(reply_to);
    }
    body
}

/// Checks the names to gather from: 1 to 8, as a send to several names allows.
pub fn validate_names(names: &[String], field: &str) -> Result<Vec<String>, CliError> {
    if names.is_empty() {
        return Err(CliError::usage(format!(
            "{field} must name at least one agent to gather answers from."
        )));
    }
    address::validate_names(names, field)
}

/// The path of one read after `after`, waiting up to `wait` seconds.
pub fn page_path(tenant: &str, channel: &str, after: u64, wait: u64) -> String {
    format!("/api/tenants/{tenant}/channels/{channel}/messages?after={after}&wait={wait}&limit=100")
}

/// The path of the question itself.
pub fn question_path(tenant: &str, channel: &str, question: u64) -> String {
    format!("/api/tenants/{tenant}/channels/{channel}/messages/{question}")
}

/// One bounded gather, for the MCP tools: reads the board after the question until every name has
/// replied, the question is replaced, or `seconds` pass. Pages already waiting are read even when
/// `seconds` is 0. `get` does one GET of an API path and returns its JSON.
pub fn wait(
    mut get: impl FnMut(&str) -> Result<Value, CliError>,
    gather: &mut Gather,
    tenant: &str,
    channel: &str,
    seconds: u64,
) -> Result<(), CliError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(seconds);
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        let wait =
            (left.as_secs() + u64::from(left.subsec_nanos() > 0)).min(crate::config::MAX_WAIT);
        let before = gather.after();
        let page = get(&page_path(tenant, channel, before, wait))?;
        gather.observe_page(&page);
        if gather.finished() {
            return Ok(());
        }
        let caught_up =
            gather.after() == before || page["messages"].as_array().is_none_or(|m| m.len() < 100);
        if caught_up && deadline <= std::time::Instant::now() {
            return Ok(());
        }
    }
}

/// Reads the question and replays the board after it: the start of every gather, also a resumed one.
pub fn start(
    mut get: impl FnMut(&str) -> Result<Value, CliError>,
    tenant: &str,
    channel: &str,
    question: u64,
) -> Result<Gather, CliError> {
    let read = get(&question_path(tenant, channel, question))?;
    Gather::new(&read["message"])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question() -> Value {
        json!({"id": 10, "username": "lead", "to": "a", "recipients": ["a", "b", "c"], "text": "Estimate?"})
    }

    fn reply(id: u64, username: &str, reply_to: u64, text: &str) -> Value {
        json!({"id": id, "username": username, "replyTo": reply_to, "text": text, "createdAt": "2026-11-21T12:00:00Z"})
    }

    #[test]
    fn given_replies_in_thread_when_observed_then_answers_keyed_by_name() {
        let mut gather = Gather::new(&question()).unwrap();
        gather.observe(&reply(11, "a", 10, "2 days"));
        // A reply to a reply is still in the thread.
        gather.observe(&reply(12, "lead", 11, "why?"));
        gather.observe(&reply(13, "B", 12, "3 days"));
        assert!(!gather.finished());
        assert_eq!(gather.pending(), vec!["c"]);
        let result = gather.result();
        assert_eq!(result["answers"]["a"]["text"], "2 days");
        assert_eq!(result["answers"]["b"]["messageId"], 13);
        assert_eq!(result["complete"], false);
        assert_eq!(result["pending"], json!(["c"]));
        gather.observe(&reply(14, "c", 10, "1 day"));
        assert!(gather.finished());
        assert_eq!(gather.result()["complete"], true);
        assert_eq!(gather.result()["pending"], json!([]));
    }

    #[test]
    fn given_messages_outside_the_thread_or_from_others_when_observed_then_ignored() {
        let mut gather = Gather::new(&question()).unwrap();
        // A top-level message from a named agent is not a reply to the question.
        gather.observe(&json!({"id": 11, "username": "a", "text": "unrelated"}));
        // A reply to another thread.
        gather.observe(&reply(12, "b", 5, "elsewhere"));
        // Someone not named.
        gather.observe(&reply(13, "z", 10, "me too"));
        // Messages at or before the question.
        gather.observe(&reply(9, "c", 10, "time travel"));
        assert_eq!(gather.pending(), vec!["a", "b", "c"]);
        assert_eq!(gather.after(), 13);
    }

    #[test]
    fn given_two_replies_from_one_agent_when_observed_then_first_counts() {
        let mut gather = Gather::new(&question()).unwrap();
        gather.observe(&reply(11, "a", 10, "first"));
        gather.observe(&reply(12, "a", 10, "second"));
        assert_eq!(gather.result()["answers"]["a"]["text"], "first");
    }

    #[test]
    fn given_a_replaced_answer_when_observed_then_the_replacement_counts() {
        let mut gather = Gather::new(&question()).unwrap();
        gather.observe(&reply(11, "a", 10, "2 days"));
        // The replacement is posted outside the thread; it still counts.
        gather.observe(&json!({"id": 12, "username": "a", "replaces": 11, "text": "4 days"}));
        gather.observe(&json!({"id": 13, "username": "a", "replaces": 12, "text": "5 days"}));
        let answer = &gather.result()["answers"]["a"];
        assert_eq!(answer["text"], "5 days");
        assert_eq!(answer["replaced"], json!([11, 12]));
        // Someone else cannot replace it (the server refuses that too).
        gather.observe(&json!({"id": 14, "username": "b", "replaces": 13, "text": "no"}));
        assert_eq!(gather.result()["answers"]["a"]["text"], "5 days");
    }

    #[test]
    fn given_a_replaced_question_when_observed_then_gather_stops_with_replaced_by() {
        let mut gather = Gather::new(&question()).unwrap();
        gather.observe(&reply(11, "a", 10, "2 days"));
        gather.observe(&json!({"id": 12, "username": "lead", "replaces": 10, "to": "a", "recipients": ["a", "b", "c"], "text": "Estimate v2?"}));
        assert!(gather.finished());
        let result = gather.result();
        assert_eq!(result["replacedBy"], 12);
        assert_eq!(result["complete"], false);
        assert_eq!(result["pending"], json!(["b", "c"]));
        // Nothing after the replacement counts.
        gather.observe(&reply(13, "b", 10, "late"));
        assert_eq!(gather.pending(), vec!["b", "c"]);
        // A question read back already replaced is finished at once.
        let mut read = question();
        read["replacedBy"] = json!(12);
        assert_eq!(Gather::new(&read).unwrap().replaced_by(), Some(12));
    }

    #[test]
    fn given_a_one_name_question_when_new_then_to_is_the_name() {
        let gather = Gather::new(&json!({"id": 3, "username": "lead", "to": "a"})).unwrap();
        assert_eq!(gather.pending(), vec!["a"]);
        assert!(Gather::new(&json!({"id": 3, "username": "lead"})).is_err());
    }

    #[test]
    fn given_names_when_validated_then_one_to_eight() {
        assert!(validate_names(&[], "--to").is_err());
        assert!(validate_names(&["a".into()], "--to").is_ok());
        assert!(validate_names(&["a".into(), "A".into()], "--to").is_err());
    }

    #[test]
    fn given_question_when_body_then_a_normal_several_name_send() {
        let names = vec!["a".to_string(), "b".to_string()];
        assert_eq!(
            question_body("lead", "Estimate?", &names, Some(4)),
            json!({"username": "lead", "text": "Estimate?", "to": ["a", "b"], "replyTo": 4})
        );
        assert_eq!(
            question_body("lead", "Q", &names[..1], None),
            json!({"username": "lead", "text": "Q", "to": "a"})
        );
    }

    #[test]
    fn given_pages_when_wait_then_reads_until_everyone_replied() {
        let mut gather = Gather::new(&question()).unwrap();
        let pages = [
            json!({"messages": [reply(11, "a", 10, "x"), reply(12, "b", 10, "y")], "nextCursor": 12}),
            json!({"messages": [reply(13, "c", 10, "z")], "nextCursor": 13}),
        ];
        let mut paths = Vec::new();
        let mut index = 0;
        wait(
            |path| {
                paths.push(path.to_string());
                index += 1;
                Ok(pages[index - 1].clone())
            },
            &mut gather,
            "t",
            "general",
            5,
        )
        .unwrap();
        assert!(gather.finished());
        assert!(paths[0].contains("after=10&wait=5"), "{paths:?}");
        assert!(paths[1].contains("after=12"), "{paths:?}");
    }

    #[test]
    fn given_no_time_when_wait_then_one_read_without_waiting() {
        let mut gather = Gather::new(&question()).unwrap();
        let mut calls = 0;
        wait(
            |path| {
                calls += 1;
                assert!(path.contains("wait=0"), "{path}");
                Ok(json!({"messages": [], "nextCursor": 10}))
            },
            &mut gather,
            "t",
            "general",
            0,
        )
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(gather.pending(), vec!["a", "b", "c"]);
    }
}
