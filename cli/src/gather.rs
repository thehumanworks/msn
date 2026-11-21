//! Gather answers from several agents (ADR 0071). One question is sent as a normal message to
//! several names (ADR 0067); each named agent's answer is its first reply anywhere in the
//! question's thread (ADR 0063). Gathering reads the thread after the question, so it needs no
//! special server route, and a name counts as answered only when a reply was actually posted:
//! silence never counts. The asker's own replies never count.
//!
//! Before it reports, a gather re-reads each recorded reply, so the answer is that reply as it is
//! now: edited text, and, when its author replaced it (ADR 0068), the newest message of its
//! replacement chain, wherever that was posted. A deleted reply no longer counts, and the agent's
//! next reply in the thread (if any) takes its place. When the asker replaces the question itself,
//! gathering stops and reports `replacedBy`; only replies posted before the replacement count, so
//! a resumed gather of the old question gives the same answers.

use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use crate::address;
use crate::error::CliError;

/// The most replacement links followed from one reply; a longer chain keeps the last one read.
const MAX_CHAIN: usize = 16;
/// Messages per thread page.
const PAGE: usize = 100;

/// The state of one gather: the question, the names it waits on, and what has been seen so far.
#[derive(Debug, Clone)]
pub struct Gather {
    question: u64,
    asker: Option<String>,
    names: Vec<String>,
    /// Per name, in order: the ids of its replies in the thread, oldest first.
    replies: Vec<Vec<u64>>,
    /// Per name: the answer as last re-read, if any.
    answers: Vec<Option<Value>>,
    /// The id of the message that replaced the question, once seen.
    replaced_by: Option<u64>,
    /// The thread cursor: the highest message id read.
    after: u64,
}

fn same_name(a: &str, b: &str) -> bool {
    crate::status::js_trim(a) == crate::status::js_trim(b)
}

impl Gather {
    /// Starts from the question as read back from the server (`{"id", "username", "to",
    /// "recipients", "replacedBy"?, …}`). Fails when the question names nobody.
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
            replies: vec![Vec::new(); names.len()],
            answers: vec![None; names.len()],
            names,
            replaced_by: question["replacedBy"].as_u64(),
            after: id,
        })
    }

    pub fn question(&self) -> u64 {
        self.question
    }

    /// The thread cursor to read after next.
    pub fn after(&self) -> u64 {
        self.after
    }

    pub fn replaced_by(&self) -> Option<u64> {
        self.replaced_by
    }

    /// Takes in the question as read again, to see whether it was replaced.
    pub fn update_question(&mut self, question: &Value) {
        if self.replaced_by.is_none() {
            self.replaced_by = question["replacedBy"].as_u64();
        }
    }

    /// True when every name has at least one reply seen (before re-reading them).
    pub fn all_replied(&self) -> bool {
        self.replies.iter().all(|ids| !ids.is_empty())
    }

    /// True when every name has a current answer.
    pub fn complete(&self) -> bool {
        self.answers.iter().all(Option::is_some)
    }

    /// The names with no current answer, in the order the question lists them.
    pub fn pending(&self) -> Vec<&str> {
        self.names
            .iter()
            .zip(&self.answers)
            .filter(|(_, answer)| answer.is_none())
            .map(|(name, _)| name.as_str())
            .collect()
    }

    /// Takes in one page of `GET …/messages?thread=Q&after=…` (messages in id order) and moves
    /// the cursor. Returns how many messages the page held.
    pub fn observe_page(&mut self, page: &Value) -> usize {
        let messages = page["messages"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        for message in messages {
            self.observe(message);
        }
        if let Some(next) = page["nextCursor"].as_u64() {
            self.after = self.after.max(next);
        }
        messages.len()
    }

    /// Takes in one message of the question's thread. Messages must arrive in id order.
    pub fn observe(&mut self, message: &Value) {
        let Some(id) = message["id"].as_u64() else {
            return;
        };
        if id <= self.question {
            return;
        }
        self.after = self.after.max(id);
        // Only replies posted before the question was replaced answer it.
        if self.replaced_by.is_some_and(|newer| id >= newer) {
            return;
        }
        let author = message["username"].as_str().unwrap_or_default();
        if self
            .asker
            .as_deref()
            .is_some_and(|asker| same_name(asker, author))
        {
            return;
        }
        if let Some(index) = self.names.iter().position(|name| same_name(name, author))
            && !self.replies[index].contains(&id)
        {
            self.replies[index].push(id);
            if self.answers[index].is_none() && self.replies[index].len() == 1 {
                self.answers[index] = Some(answer_of(message, &[]));
            }
        }
    }

    /// Re-reads every name's replies: the first one not deleted is its answer, followed along
    /// `replacedBy` to the newest message. `get` reads one message; `None` means deleted.
    pub fn refresh(
        &mut self,
        mut get: impl FnMut(u64) -> Result<Option<Value>, CliError>,
    ) -> Result<(), CliError> {
        for index in 0..self.names.len() {
            let mut answer = None;
            let mut kept = Vec::new();
            for &id in &self.replies[index] {
                if answer.is_some() {
                    kept.push(id);
                    continue;
                }
                let Some(mut message) = get(id)? else {
                    continue; // Deleted: no longer an answer.
                };
                kept.push(id);
                let mut replaced = Vec::new();
                while let Some(newer) = message["replacedBy"].as_u64() {
                    if replaced.len() >= MAX_CHAIN {
                        break;
                    }
                    let Some(next) = get(newer)? else { break };
                    replaced.push(message["id"].clone());
                    message = next;
                }
                answer = Some(answer_of(&message, &replaced));
            }
            self.replies[index] = kept;
            self.answers[index] = answer;
        }
        Ok(())
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
            "complete": self.complete(),
            "answers": answers,
            "pending": self.pending(),
        });
        if let Some(replaced_by) = self.replaced_by {
            out["replacedBy"] = json!(replaced_by);
        }
        out
    }
}

/// One answer: the message's author, id, text and time, plus the ids it replaced.
fn answer_of(message: &Value, replaced: &[Value]) -> Value {
    let mut answer = json!({
        "username": message["username"],
        "messageId": message["id"],
        "text": message["text"],
        "createdAt": message["createdAt"],
    });
    if let Some(content_type) = message["contentType"].as_str() {
        answer["contentType"] = json!(content_type);
    }
    if message["editedAt"].is_string() {
        answer["editedAt"] = message["editedAt"].clone();
    }
    if !replaced.is_empty() {
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

/// Refuses a gather whose names include the asker: its own replies never count.
pub fn refuse_self(names: &[String], username: &str, field: &str) -> Result<(), CliError> {
    match names.iter().find(|name| same_name(name, username)) {
        Some(name) => Err(CliError::usage(format!(
            "{field} names {name:?}, which is you; your own replies never count as an answer."
        ))),
        None => Ok(()),
    }
}

fn messages_path(tenant: &str, channel: &str) -> String {
    format!("/api/tenants/{tenant}/channels/{channel}/messages")
}

/// One read of the question's thread after `after`, waiting up to `wait` seconds.
pub fn page_path(tenant: &str, channel: &str, question: u64, after: u64, wait: u64) -> String {
    format!(
        "{}?thread={question}&after={after}&wait={wait}&limit={PAGE}",
        messages_path(tenant, channel)
    )
}

/// The path of one message.
pub fn message_path(tenant: &str, channel: &str, id: u64) -> String {
    format!("{}/{id}", messages_path(tenant, channel))
}

/// Reads one message; `None` when it was deleted (404, or 410 gone).
fn read_message(
    get: &mut impl FnMut(&str) -> Result<Value, CliError>,
    tenant: &str,
    channel: &str,
    id: u64,
) -> Result<Option<Value>, CliError> {
    match get(&message_path(tenant, channel, id)) {
        Ok(read) => Ok(Some(read["message"].clone())),
        Err(CliError::NotFound(_) | CliError::Conflict(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Reads the question: the start of every gather, also a resumed one.
pub fn start(
    mut get: impl FnMut(&str) -> Result<Value, CliError>,
    tenant: &str,
    channel: &str,
    question: u64,
) -> Result<Gather, CliError> {
    let read = get(&message_path(tenant, channel, question))?;
    Gather::new(&read["message"])
}

/// Reads the question's thread until every name has a current answer, the question is replaced,
/// or `deadline` passes, then re-reads the answers. At least one page is always read, without
/// waiting when the deadline has passed. `get` does one GET of an API path and returns its JSON.
pub fn wait(
    mut get: impl FnMut(&str) -> Result<Value, CliError>,
    gather: &mut Gather,
    tenant: &str,
    channel: &str,
    deadline: Instant,
) -> Result<(), CliError> {
    let question = gather.question();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let wait =
            (left.as_secs() + u64::from(left.subsec_nanos() > 0)).min(crate::config::MAX_WAIT);
        let page = get(&page_path(tenant, channel, question, gather.after(), wait))?;
        let full = gather.observe_page(&page) >= PAGE;
        let over = Instant::now() >= deadline;
        if full && !over {
            continue;
        }
        if let Some(read) = read_message(&mut get, tenant, channel, question)? {
            gather.update_question(&read);
        }
        if gather.replaced_by().is_some() || gather.all_replied() || over {
            gather.refresh(|id| read_message(&mut get, tenant, channel, id))?;
            if gather.replaced_by().is_some() || gather.complete() || over {
                return Ok(());
            }
        }
    }
}

/// The deadline `seconds` from now.
pub fn deadline_in(seconds: u64) -> Instant {
    Instant::now() + Duration::from_secs(seconds)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn question() -> Value {
        json!({"id": 10, "username": "lead", "to": "a", "recipients": ["a", "b", "c"], "text": "Estimate?"})
    }

    fn reply(id: u64, username: &str, reply_to: u64, text: &str) -> Value {
        json!({"id": id, "username": username, "replyTo": reply_to, "text": text, "createdAt": "2026-11-21T12:00:00Z"})
    }

    /// A fake board: messages by id; a missing id reads as deleted.
    fn refresh_from(gather: &mut Gather, board: &HashMap<u64, Value>) {
        gather.refresh(|id| Ok(board.get(&id).cloned())).unwrap();
    }

    #[test]
    fn given_replies_in_thread_when_observed_then_answers_keyed_by_name() {
        let mut gather = Gather::new(&question()).unwrap();
        gather.observe(&reply(11, "a", 10, "2 days"));
        // A reply to a reply is still in the thread (the thread read returns it).
        gather.observe(&reply(12, "z", 11, "why?"));
        gather.observe(&reply(13, "b", 12, "3 days"));
        assert!(!gather.all_replied());
        assert_eq!(gather.pending(), vec!["c"]);
        let result = gather.result();
        assert_eq!(result["answers"]["a"]["text"], "2 days");
        assert_eq!(result["answers"]["b"]["messageId"], 13);
        assert_eq!(result["complete"], false);
        assert_eq!(result["pending"], json!(["c"]));
        gather.observe(&reply(14, "c", 10, "1 day"));
        assert!(gather.all_replied());
        assert_eq!(gather.result()["complete"], true);
        assert_eq!(gather.result()["pending"], json!([]));
    }

    #[test]
    fn given_names_when_matched_then_exact_after_trimming_and_never_the_asker() {
        let mut gather = Gather::new(
            &json!({"id": 10, "username": "lead", "to": "a", "recipients": ["a", "lead"]}),
        )
        .unwrap();
        // Another case is another name on a shared board (ADR 0065).
        gather.observe(&reply(11, "A", 10, "not a"));
        // The asker's own reply never counts, even when it named itself.
        gather.observe(&reply(12, "lead", 10, "self"));
        gather.observe(&reply(13, " a ", 10, "trimmed"));
        assert_eq!(gather.pending(), vec!["lead"]);
        assert_eq!(gather.result()["answers"]["a"]["messageId"], 13);
        assert!(refuse_self(&["a".into(), "lead ".into()], "lead", "--to").is_err());
        assert!(refuse_self(&["a".into()], "lead", "--to").is_ok());
    }

    #[test]
    fn given_two_replies_from_one_agent_when_observed_then_first_counts() {
        let mut gather = Gather::new(&question()).unwrap();
        gather.observe(&reply(11, "a", 10, "first"));
        gather.observe(&reply(12, "a", 10, "second"));
        assert_eq!(gather.result()["answers"]["a"]["text"], "first");
        // Before the question, or the same message twice, changes nothing.
        gather.observe(&reply(9, "b", 10, "time travel"));
        gather.observe(&reply(12, "a", 10, "second"));
        assert_eq!(gather.pending(), vec!["b", "c"]);
        assert_eq!(gather.after(), 12);
    }

    #[test]
    fn given_replaced_edited_or_deleted_replies_when_refreshed_then_current_answers() {
        let mut gather = Gather::new(&question()).unwrap();
        gather.observe(&reply(11, "a", 10, "2 days"));
        gather.observe(&reply(12, "b", 10, "3 days"));
        gather.observe(&reply(13, "b", 10, "my second"));
        gather.observe(&reply(14, "c", 10, "1 day"));
        let mut board = HashMap::new();
        // a replaced its reply twice, the middle link deleted: the server links 11 to 30.
        board.insert(
            11,
            json!({"id": 11, "username": "a", "text": "2 days", "replacedBy": 30}),
        );
        board.insert(
            30,
            json!({"id": 30, "username": "a", "text": "5 days", "replaces": 20}),
        );
        // b's first reply is deleted: its next reply counts.
        board.insert(13, json!({"id": 13, "username": "b", "text": "my second"}));
        // c edited its reply.
        board.insert(
            14,
            json!({"id": 14, "username": "c", "text": "1.5 days", "editedAt": "t"}),
        );
        refresh_from(&mut gather, &board);
        let result = gather.result();
        assert_eq!(result["answers"]["a"]["text"], "5 days");
        assert_eq!(result["answers"]["a"]["replaced"], json!([11]));
        assert_eq!(result["answers"]["b"]["messageId"], 13);
        assert_eq!(result["answers"]["c"]["text"], "1.5 days");
        assert_eq!(result["answers"]["c"]["editedAt"], "t");
        assert_eq!(result["complete"], true);
        // Every reply deleted: pending again.
        board.remove(&13);
        refresh_from(&mut gather, &board);
        assert_eq!(gather.pending(), vec!["b"]);
    }

    #[test]
    fn given_a_replaced_question_when_observed_then_only_earlier_replies_count() {
        let mut gather = Gather::new(&question()).unwrap();
        gather.observe(&reply(11, "a", 10, "2 days"));
        gather.update_question(&json!({"id": 10, "replacedBy": 13}));
        gather.observe(&reply(12, "b", 10, "before"));
        gather.observe(&reply(14, "c", 10, "after"));
        let result = gather.result();
        assert_eq!(result["replacedBy"], 13);
        assert_eq!(result["pending"], json!(["c"]));
        // A resumed gather of an already replaced question gives the same answers.
        let mut read = question();
        read["replacedBy"] = json!(13);
        let mut resumed = Gather::new(&read).unwrap();
        for message in [
            reply(11, "a", 10, "2 days"),
            reply(12, "b", 10, "before"),
            reply(14, "c", 10, "after"),
        ] {
            resumed.observe(&message);
        }
        assert_eq!(resumed.result(), result);
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

    /// Answers GETs from a fake board: thread pages are scripted, single messages come from it.
    fn fake(
        pages: Vec<Value>,
        board: HashMap<u64, Value>,
        paths: &mut Vec<String>,
    ) -> impl FnMut(&str) -> Result<Value, CliError> + '_ {
        let mut pages = pages.into_iter();
        move |path: &str| {
            paths.push(path.to_string());
            if path.contains("?thread=") {
                return Ok(pages.next().unwrap_or_else(|| json!({"messages": []})));
            }
            let id: u64 = path.rsplit('/').next().unwrap().parse().unwrap();
            board
                .get(&id)
                .map(|message| json!({ "message": message }))
                .ok_or_else(|| CliError::not_found("404: gone"))
        }
    }

    #[test]
    fn given_pages_when_wait_then_reads_the_thread_until_everyone_replied() {
        let mut gather = Gather::new(&question()).unwrap();
        let replies = [
            reply(11, "a", 10, "x"),
            reply(12, "b", 10, "y"),
            reply(13, "c", 12, "z"),
        ];
        let mut board: HashMap<u64, Value> = replies
            .iter()
            .map(|message| (message["id"].as_u64().unwrap(), message.clone()))
            .collect();
        board.insert(10, question());
        let pages = vec![
            json!({"messages": [replies[0], replies[1]], "nextCursor": 12}),
            json!({"messages": [replies[2]], "nextCursor": 13}),
        ];
        let mut paths = Vec::new();
        wait(
            fake(pages, board, &mut paths),
            &mut gather,
            "t",
            "general",
            deadline_in(5),
        )
        .unwrap();
        assert!(gather.complete());
        assert!(paths[0].contains("?thread=10&after=10&wait=5"), "{paths:?}");
        assert!(
            paths
                .iter()
                .any(|path| path.contains("?thread=10&after=12")),
            "{paths:?}"
        );
    }

    #[test]
    fn given_no_time_when_wait_then_one_page_without_waiting() {
        let mut gather = Gather::new(&question()).unwrap();
        let board = HashMap::from([(10, question())]);
        let mut paths = Vec::new();
        wait(
            fake(vec![], board, &mut paths),
            &mut gather,
            "t",
            "general",
            Instant::now(),
        )
        .unwrap();
        let threads: Vec<&String> = paths.iter().filter(|p| p.contains("?thread=")).collect();
        assert_eq!(threads.len(), 1, "{paths:?}");
        assert!(threads[0].contains("wait=0"), "{paths:?}");
        assert_eq!(gather.pending(), vec!["a", "b", "c"]);
    }

    #[test]
    fn given_the_question_replaced_while_waiting_when_wait_then_stops() {
        let mut gather = Gather::new(&question()).unwrap();
        let mut replaced = question();
        replaced["replacedBy"] = json!(20);
        let board = HashMap::from([(10, replaced), (11, reply(11, "a", 10, "x"))]);
        let pages = vec![json!({"messages": [reply(11, "a", 10, "x")], "nextCursor": 11})];
        let mut paths = Vec::new();
        wait(
            fake(pages, board, &mut paths),
            &mut gather,
            "t",
            "general",
            deadline_in(30),
        )
        .unwrap();
        assert_eq!(gather.replaced_by(), Some(20));
        assert_eq!(gather.pending(), vec!["b", "c"]);
    }
}
