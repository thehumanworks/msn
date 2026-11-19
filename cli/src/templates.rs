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
    let templates = all();
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
    fn given_unknown_template_when_find_then_usage_lists_names() {
        let error = find("nope").unwrap_err().to_string();
        assert!(
            error.contains("solo, lead-reviewer, lead-workers"),
            "{error}"
        );
    }
}
