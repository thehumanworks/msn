//! Board templates: one shared file, also served to the web client as /board-templates.json.

use serde::Deserialize;

use crate::error::CliError;

const SOURCE: &str = include_str!("../../public/board-templates.json");

#[derive(Debug, Deserialize)]
pub struct Persona {
    pub name: String,
    pub role: String,
}

#[derive(Debug, Deserialize)]
pub struct Template {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub goal: String,
    pub personas: Vec<Persona>,
}

#[derive(Deserialize)]
struct Catalog {
    templates: Vec<Template>,
}

pub fn all() -> Vec<Template> {
    serde_json::from_str::<Catalog>(SOURCE)
        .expect("public/board-templates.json is valid")
        .templates
}

pub fn find(id: &str) -> Result<Template, CliError> {
    pick(all(), id)
}

fn pick(templates: Vec<Template>, id: &str) -> Result<Template, CliError> {
    let names = templates
        .iter()
        .map(|t| t.id.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    templates
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| CliError::usage(format!("Unknown template. Use one of: {names}.")))
}

/// A built-in template, or else one this workspace saved (fetched only when needed).
pub fn resolve(
    id: &str,
    own: impl FnOnce() -> Result<Vec<Template>, CliError>,
) -> Result<Template, CliError> {
    if let Ok(template) = find(id) {
        return Ok(template);
    }
    let mut every = all();
    every.extend(own()?);
    pick(every, id)
}

/// A name for a saved template: 1–40 of `[a-z0-9_-]`, not a built-in id. The server checks again.
pub fn own_name(name: &str) -> Result<&str, CliError> {
    let valid = !name.is_empty()
        && name.len() <= 40
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if !valid {
        return Err(CliError::usage(
            "Template names are 1-40 lowercase letters, digits, hyphens or underscores.",
        ));
    }
    if all().iter().any(|t| t.id == name) {
        return Err(CliError::usage(format!(
            "{name} is a built-in template. Choose another name."
        )));
    }
    Ok(name)
}

/// The board goal: the objective, then each persona's role. Runners receive it every turn.
/// Must match `templateGoal` in public/app.js.
pub fn goal(template: &Template, objective: &str, lead: &str) -> String {
    let mut text = format!("{}\n\nTeam ({}):", objective.trim(), template.title);
    for (index, persona) in template.personas.iter().enumerate() {
        let name = if index == 0 { lead } else { &persona.name };
        text.push_str(&format!("\n- {name}: {}", persona.role));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::is_slug;

    #[test]
    fn given_shared_file_when_parsed_then_every_template_is_usable() {
        let templates = all();
        assert!(templates.len() >= 3);
        for t in &templates {
            assert!(is_slug(&t.id));
            assert!(!t.personas.is_empty() && !t.goal.trim().is_empty());
            for p in &t.personas {
                assert!(is_slug(&p.name) && !p.role.trim().is_empty());
            }
        }
        let lead_workers = find("lead-workers").unwrap();
        assert_eq!(lead_workers.personas.len(), 4);
    }

    #[test]
    fn given_template_when_goal_then_objective_and_roles_are_listed() {
        let t = find("lead-reviewer").unwrap();
        assert_eq!(
            goal(&t, " Ship the release ", "Tomas"),
            "Ship the release\n\nTeam (Lead and reviewer):\n- Tomas: Plans and does the work, then asks the reviewer to check each result.\n- reviewer: Reviews each result the lead hands over, and approves it or lists what to fix."
        );
    }

    #[test]
    fn given_own_templates_when_resolve_then_built_ins_win_and_own_are_found() {
        let own = || {
            Ok(vec![Template {
                id: "release-team".into(),
                title: "release-team".into(),
                summary: "Saved from board work.".into(),
                goal: "Ship it".into(),
                personas: vec![Persona {
                    name: "lead".into(),
                    role: "Leads.".into(),
                }],
            }])
        };
        assert_eq!(resolve("solo", || panic!("not fetched")).unwrap().id, "solo");
        assert_eq!(resolve("release-team", own).unwrap().goal, "Ship it");
        let error = resolve("nope", own).unwrap_err().to_string();
        assert!(error.contains("lead-workers, release-team"), "{error}");
    }

    #[test]
    fn given_template_name_when_checked_then_slug_and_not_built_in() {
        assert_eq!(own_name("my-team_2").unwrap(), "my-team_2");
        for bad in ["", "My", "-x", "a b", &"x".repeat(41), "solo"] {
            assert!(own_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn given_unknown_template_when_find_then_usage_lists_names() {
        let error = find("nope").unwrap_err().to_string();
        assert!(
            error.contains("solo, lead-reviewer, lead-workers"),
            "{error}"
        );
    }
}
