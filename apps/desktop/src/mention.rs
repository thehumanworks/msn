//! Mention someone with @ (ADR 0055). Pure rules, matching `public/mention.js` on the web: which
//! @ is being typed, who it suggests, and how a pick fills the To field. Positions are character
//! indices, as egui's text cursor counts them.

use serde_json::Value;

/// How many suggestions the list shows at most.
pub const MAX_SUGGESTIONS: usize = 6;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Person {
    pub name: String,
    pub listening: bool,
}

fn opens(c: char) -> bool {
    c.is_whitespace() || matches!(c, '(' | '[' | '{' | '"' | '\'' | '“' | '‘')
}

/// The @ being typed at `caret`: `(start, query)`, where `start` is the @'s character index.
/// An @ counts at the start or after a space or an opening bracket, so "a@b.c" never opens the
/// list; a space in the query ends the mention.
pub fn mention_at(text: &str, caret: usize) -> Option<(usize, String)> {
    let chars: Vec<char> = text.chars().collect();
    if caret < 1 || caret > chars.len() {
        return None;
    }
    let start = chars[..caret].iter().rposition(|c| *c == '@')?;
    let query: String = chars[start + 1..caret].iter().collect();
    if query.chars().any(char::is_whitespace) || query.chars().count() > 128 {
        return None;
    }
    if start > 0 && !opens(chars[start - 1]) {
        return None;
    }
    Some((start, query))
}

/// Everyone who can be mentioned, best first and each name once: personas listening now, then
/// senders and recipients of the loaded messages (newest first), then the other personas. `me`
/// is left out. `messages` are in board order (oldest first).
pub fn people<'a>(
    personas: &[(String, bool)],
    messages: impl DoubleEndedIterator<Item = &'a Value>,
    me: &str,
) -> Vec<Person> {
    let mut out: Vec<Person> = Vec::new();
    let mut add = |name: &str, listening: bool| {
        if name.trim().is_empty() || name == me || out.iter().any(|p| p.name == name) {
            return;
        }
        out.push(Person {
            name: name.to_owned(),
            listening,
        });
    };
    for (name, listening) in personas {
        if *listening {
            add(name, true);
        }
    }
    for message in messages.rev() {
        if let Some(name) = message["username"].as_str() {
            add(name, false);
        }
        // Every name a message was addressed to (ADR 0067).
        for name in msn_cli::address::addressees(message) {
            add(name, false);
        }
    }
    for (name, listening) in personas {
        add(name, *listening);
    }
    out
}

/// Names that start with `query` first, then names that contain it, ignoring case.
pub fn suggest(everyone: &[Person], query: &str, limit: usize) -> Vec<Person> {
    let q = query.to_lowercase();
    let (mut starts, mut contains) = (Vec::new(), Vec::new());
    for person in everyone {
        let name = person.name.to_lowercase();
        if name.starts_with(&q) {
            starts.push(person.clone());
        } else if !q.is_empty() && name.contains(&q) {
            contains.push(person.clone());
        }
    }
    starts.extend(contains);
    starts.truncate(limit);
    starts
}

/// Replaces the typed `@query` (characters `start..caret`) with `@name` and one space. Returns
/// the new text and the caret after the space.
pub fn insert_mention(text: &str, start: usize, caret: usize, name: &str) -> (String, usize) {
    let chars: Vec<char> = text.chars().collect();
    let before: String = chars[..start].iter().collect();
    let after: String = chars[caret.min(chars.len())..].iter().collect();
    let mention = format!("@{name} ");
    let caret = start + mention.chars().count();
    let after = after.strip_prefix(' ').unwrap_or(&after);
    (format!("{before}{mention}{after}"), caret)
}

/// True when `text` still holds `@name` as a whole mention.
pub fn has_mention(text: &str, name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let token = format!("@{name}");
    text.match_indices(&token).any(|(at, _)| {
        let start_ok = text[..at].chars().next_back().is_none_or(opens);
        let end_ok = text[at + token.len()..]
            .chars()
            .next()
            .is_none_or(|c| !(c.is_alphanumeric() || c == '_' || c == '-'));
        start_ok && end_ok
    })
}

/// To after a pick: the picked name when To is empty; otherwise To stays. The first mention
/// picked addresses the message. Returns the new To and the name a pick put there.
pub fn address_after_pick(
    to: &str,
    mention_to: Option<String>,
    name: &str,
) -> (String, Option<String>) {
    if to.trim().is_empty() {
        (name.to_owned(), Some(name.to_owned()))
    } else {
        (to.to_owned(), mention_to)
    }
}

/// To after the text changed: a name a pick put there clears once its @name is gone from the
/// text. A name typed into To by hand is never touched.
pub fn address_after_edit(
    to: &str,
    mention_to: Option<String>,
    text: &str,
) -> (String, Option<String>) {
    match mention_to {
        Some(name) if to == name && !has_mention(text, &name) => (String::new(), None),
        Some(name) if to == name => (to.to_owned(), Some(name)),
        _ => (to.to_owned(), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_at_after_a_space_opens_a_mention() {
        assert_eq!(mention_at("@", 1), Some((0, String::new())));
        assert_eq!(mention_at("hi @le", 6), Some((3, "le".into())));
        assert_eq!(mention_at("(@le", 4), Some((1, "le".into())));
        assert_eq!(
            mention_at("é @lé", 5),
            Some((2, "lé".into())),
            "chars, not bytes"
        );
        assert_eq!(mention_at("mail a@b", 8), None);
        assert_eq!(mention_at("@lead ", 6), None);
        assert_eq!(mention_at("hello", 5), None);
        assert_eq!(mention_at("", 0), None);
        assert_eq!(mention_at("@x", 5), None);
    }

    #[test]
    fn people_puts_listening_then_recent_then_other_personas() {
        let personas = vec![
            ("idle-bot".to_owned(), false),
            ("lead".to_owned(), true),
            ("human".to_owned(), true),
        ];
        let messages = [
            json!({"username": "reviewer", "to": "lead"}),
            json!({"username": "human"}),
            json!({"username": "builder", "to": "tester"}),
        ];
        let names: Vec<String> = people(&personas, messages.iter(), "human")
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, ["lead", "builder", "tester", "reviewer", "idle-bot"]);
    }

    #[test]
    fn suggest_ranks_prefix_matches_first() {
        let everyone: Vec<Person> = ["Builder", "lead", "team-lead", "leader"]
            .into_iter()
            .map(|name| Person {
                name: name.into(),
                listening: false,
            })
            .collect();
        let names: Vec<String> = suggest(&everyone, "LEA", MAX_SUGGESTIONS)
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, ["lead", "leader", "team-lead"]);
        assert_eq!(suggest(&everyone, "", 2).len(), 2);
        assert!(suggest(&everyone, "zz", 6).is_empty());
    }

    #[test]
    fn insert_mention_replaces_the_query() {
        assert_eq!(
            insert_mention("hi @le", 3, 6, "lead"),
            ("hi @lead ".into(), 9)
        );
        assert_eq!(
            insert_mention("@le please", 0, 3, "lead"),
            ("@lead please".into(), 6)
        );
        assert_eq!(insert_mention("é @l", 2, 4, "lé"), ("é @lé ".into(), 6));
    }

    #[test]
    fn has_mention_finds_whole_names() {
        assert!(has_mention("ask @lead now", "lead"));
        assert!(has_mention("@lead, please", "lead"));
        assert!(!has_mention("ask @leader", "lead"));
        assert!(!has_mention("me@lead", "lead"));
        assert!(has_mention("x @leader @lead", "lead"));
    }

    #[test]
    fn the_first_pick_addresses_and_deleting_it_clears_to() {
        let (to, by) = address_after_pick("", None, "lead");
        assert_eq!((to.as_str(), by.as_deref()), ("lead", Some("lead")));
        let (to, by) = address_after_pick(&to, by, "builder");
        assert_eq!((to.as_str(), by.as_deref()), ("lead", Some("lead")));
        assert_eq!(
            address_after_pick("ops", None, "lead"),
            ("ops".into(), None)
        );
        assert_eq!(
            address_after_edit("lead", Some("lead".into()), "hi @lead"),
            ("lead".into(), Some("lead".into()))
        );
        assert_eq!(
            address_after_edit("lead", Some("lead".into()), "hi @lea"),
            (String::new(), None)
        );
        assert_eq!(
            address_after_edit("ops", Some("lead".into()), "hi"),
            ("ops".into(), None)
        );
    }
}
