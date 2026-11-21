//! Ask a question with buttons (ADR 0065). A question is a message with `to` and 2 to 6 `choices`;
//! the addressed name answers with a reply that carries `answer`. Waiting for the answer reads the
//! board after the question and matches a reply by `replyTo`, so it needs no special server route.

use serde_json::{Value, json};

use crate::error::CliError;

pub const MIN_CHOICES: usize = 2;
pub const MAX_CHOICES: usize = 6;
pub const MAX_CHOICE_BYTES: usize = 128;

/// Checks choices the way the server does: 2 to 6, each non-blank and at most 128 UTF-8 bytes,
/// all different. Fails before anything is sent.
pub fn validate_choices(choices: &[String]) -> Result<Vec<String>, CliError> {
    if !(MIN_CHOICES..=MAX_CHOICES).contains(&choices.len()) {
        return Err(CliError::usage(format!(
            "Give {MIN_CHOICES} to {MAX_CHOICES} choices (repeat --choice)."
        )));
    }
    for (index, choice) in choices.iter().enumerate() {
        if choice.trim().is_empty() || choice.len() > MAX_CHOICE_BYTES {
            return Err(CliError::usage(format!(
                "Each choice must be non-blank and at most {MAX_CHOICE_BYTES} UTF-8 bytes."
            )));
        }
        if choices[..index].contains(choice) {
            return Err(CliError::usage(format!(
                "Choices must all differ; {choice:?} is repeated."
            )));
        }
    }
    Ok(choices.to_vec())
}

/// Checks one answer's shape; the server checks that it is one of the question's choices.
pub fn validate_answer(choice: &str) -> Result<String, CliError> {
    if choice.trim().is_empty() || choice.len() > MAX_CHOICE_BYTES {
        return Err(CliError::usage(format!(
            "The answer must be non-blank and at most {MAX_CHOICE_BYTES} UTF-8 bytes."
        )));
    }
    Ok(choice.to_string())
}

/// The POST body of a question.
pub fn question_body(username: &str, text: &str, to: &str, choices: &[String]) -> Value {
    json!({ "username": username, "text": text, "to": to, "choices": choices })
}

/// The POST body of an answer: a reply whose text is the choice.
pub fn answer_body(username: &str, question: u64, choice: &str) -> Value {
    json!({ "username": username, "text": choice, "replyTo": question, "answer": choice })
}

/// What `msn ask --wait` and the MCP tools report once the question is answered.
pub fn answer_result(question: u64, reply: &Value) -> Value {
    json!({
        "question": question,
        "answer": reply["answer"],
        "username": reply["username"],
        "messageId": reply["id"],
        "answeredAt": reply["createdAt"],
    })
}

/// The first reply in a messages page that answers `question`. The server keeps at most one.
pub fn find_answer(page: &Value, question: u64) -> Option<Value> {
    page["messages"].as_array()?.iter().find_map(|message| {
        (message["replyTo"].as_u64() == Some(question) && message["answer"].is_string())
            .then(|| answer_result(question, message))
    })
}

/// The answer recorded on a question read with `GET …/messages/ID`, if any.
pub fn recorded_answer(question: &Value) -> Option<Value> {
    let answered = question.get("answered")?;
    Some(json!({
        "question": question["id"],
        "answer": answered["choice"],
        "username": answered["username"],
        "messageId": answered["id"],
        "answeredAt": answered["answeredAt"],
    }))
}

/// The cursor to continue after: `nextCursor` when present, else the last message id, else `after`.
pub fn next_cursor(page: &Value, after: u64) -> u64 {
    page["nextCursor"]
        .as_u64()
        .or_else(|| page["messages"].as_array()?.last()?["id"].as_u64())
        .unwrap_or(after)
        .max(after)
}

/// One bounded wait for an answer, for the MCP tools: reads the question (it may be answered
/// already), then reads the board after it until an answer arrives or `seconds` pass. `get` does
/// one GET of an API path and returns its JSON.
pub fn wait_answer(
    mut get: impl FnMut(&str) -> Result<Value, CliError>,
    tenant: &str,
    channel: &str,
    question: u64,
    seconds: u64,
) -> Result<Option<Value>, CliError> {
    let base = format!("/api/tenants/{tenant}/channels/{channel}/messages");
    let read = get(&format!("{base}/{question}"))?;
    if let Some(found) = recorded_answer(&read["message"]) {
        return Ok(Some(found));
    }
    if !read["message"]["choices"].is_array() {
        return Err(CliError::usage(format!(
            "Message {question} is not a question with choices."
        )));
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(seconds);
    let mut after = question;
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Ok(None);
        }
        let wait =
            (left.as_secs() + u64::from(left.subsec_nanos() > 0)).min(crate::config::MAX_WAIT);
        let page = get(&format!("{base}?thread={question}&after={after}&wait={wait}&limit=100"))?;
        if let Some(found) = find_answer(&page, question) {
            return Ok(Some(found));
        }
        after = next_cursor(&page, after);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn given_choices_when_validate_then_server_rules_apply() {
        assert!(validate_choices(&strings(&["yes", "no"])).is_ok());
        assert!(validate_choices(&strings(&["a", "b", "c", "d", "e", "f"])).is_ok());
        assert!(validate_choices(&strings(&["yes"])).is_err());
        assert!(validate_choices(&strings(&["a", "b", "c", "d", "e", "f", "g"])).is_err());
        assert!(validate_choices(&strings(&["yes", "yes"])).is_err());
        assert!(validate_choices(&strings(&["yes", " "])).is_err());
        assert!(validate_choices(&["x".repeat(129), "no".into()]).is_err());
        assert!(validate_choices(&["x".repeat(128), "no".into()]).is_ok());
    }

    #[test]
    fn given_page_when_find_answer_then_only_an_answer_reply_counts() {
        let page = json!({"messages": [
            {"id": 5, "replyTo": 4, "answer": "yes", "username": "tomas", "createdAt": "t"},
            {"id": 6, "replyTo": 3, "text": "plain reply", "username": "tomas"},
            {"id": 7, "replyTo": 3, "answer": "no", "username": "tomas", "createdAt": "t7"},
        ], "nextCursor": 7});
        assert_eq!(
            find_answer(&page, 3),
            Some(
                json!({"question": 3, "answer": "no", "username": "tomas", "messageId": 7, "answeredAt": "t7"})
            )
        );
        assert_eq!(find_answer(&page, 9), None);
        assert_eq!(next_cursor(&page, 3), 7);
        assert_eq!(next_cursor(&json!({"messages": []}), 3), 3);
    }

    #[test]
    fn given_question_when_recorded_answer_then_reads_answered() {
        let question = json!({"id": 3, "choices": ["yes", "no"], "answered": {"id": 7, "choice": "no", "username": "tomas", "answeredAt": "t7"}});
        assert_eq!(
            recorded_answer(&question),
            Some(
                json!({"question": 3, "answer": "no", "username": "tomas", "messageId": 7, "answeredAt": "t7"})
            )
        );
        assert_eq!(recorded_answer(&json!({"id": 3})), None);
    }
}
