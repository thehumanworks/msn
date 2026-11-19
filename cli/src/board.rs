use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use serde_json::{Value, json};
use uuid::Uuid;

use crate::args::{BoardCommand, Cli, Command, PersonaCommand};
use crate::client::{MsnClient, RawResponse, classify};
use crate::config::{origin_key, parse_origin, require_tenant, require_token, slug};
use crate::cursor::CursorLock;
use crate::error::CliError;
use crate::identity::{fetch_identity, validate_username};
use crate::profile::{self, Profile};
use crate::templates;

fn value(raw: RawResponse) -> Result<Value, CliError> {
    classify(raw.status, &raw.body)?;
    serde_json::from_str(&raw.body).map_err(|_| CliError::generic("Invalid server response"))
}
fn secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

pub(crate) fn selected(cli: &Cli) -> Result<Profile, CliError> {
    Ok(Profile {
        url: origin_key(&parse_origin(&cli.url)?),
        tenant: require_tenant(cli.tenant.as_deref())?,
        token: require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?,
        username: validate_username(cli.username.as_deref().unwrap_or("human"))?,
        reader: cli
            .reader
            .clone()
            .or(cli.username.clone())
            .unwrap_or_else(|| "human".into()),
        activity: None,
    })
}
pub(crate) fn private_file(path: &Path, data: &[u8]) -> Result<(), CliError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(data)?;
    file.sync_all()?;
    Ok(())
}
fn save(name: &str, profile: &Profile) -> Result<(), CliError> {
    profile::ensure_directory(&profile::profile_directory()?)?;
    profile::write_new(name, profile)
}
fn announce(name: &str, profile: &Profile) {
    println!(
        "{}",
        json!({"profile":name,"url":profile.url,"tenant":profile.tenant,"username":profile.username,"personaId":profile.reader})
    );
}
fn register(client: &MsnClient, p: &Profile, channel: &str) -> Result<Value, CliError> {
    value(client.exchange(
        "PUT",
        &format!(
            "/api/tenants/{}/channels/{channel}/personas/{}",
            p.tenant,
            slug(&p.reader)?
        ),
        Some(&p.token),
        &[],
        Some(&json!({"displayName":p.username})),
    )?)
}

fn summary(name: &str, profile: &Profile, role: &str) -> Value {
    json!({"profile":name,"username":profile.username,"personaId":profile.reader,"role":role})
}

/// Save a persona profile that shares `p`'s channel credential, and register it. Idempotent.
fn add_persona(
    client: &MsnClient,
    url: &url::Url,
    p: &Profile,
    channel: &str,
    name: &str,
    id: Option<&String>,
    save_as: &str,
) -> Result<Profile, CliError> {
    slug(channel)?;
    let identity = fetch_identity(url, &p.tenant, &p.token)?;
    if identity["sharedChannel"] != true || identity["channel"] != *channel {
        return Err(CliError::usage(
            "Use the shared channel profile when adding personas.",
        ));
    }
    profile::ensure_directory(&profile::profile_directory()?)?;
    let _lock = CursorLock::acquire(&profile::profile_path(save_as)?)?;
    let persona = if profile::profile_path(save_as)?.exists() {
        let existing = profile::load(save_as)?;
        if existing.url != p.url
            || existing.tenant != p.tenant
            || existing.token != p.token
            || existing.username != *name
            || id.is_some_and(|id| id != &existing.reader)
        {
            return Err(CliError::usage(
                "Persona profile already exists with different settings.",
            ));
        }
        existing
    } else {
        let persona = Profile {
            username: validate_username(name)?,
            reader: id
                .cloned()
                .unwrap_or_else(|| format!("persona-{}", Uuid::new_v4().simple())),
            activity: None,
            ..p.clone()
        };
        slug(&persona.reader)?;
        save(save_as, &persona)?;
        persona
    };
    register(client, &persona, channel)?;
    Ok(persona)
}

/// The longest goal excerpt an agent paragraph quotes; `start` returns the whole goal.
const PARAGRAPH_GOAL_CHARS: usize = 1200;

/// A profile-name suffix from a persona name: lowercase, `[a-z0-9_-]`, other runs become `-`.
fn default_profile_suffix(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// POSIX single-quote a word so a shell passes it through unchanged.
fn shell_quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
}

/// One paragraph an agent can act on with no other context: install, join, start, wait, send.
fn agent_paragraph(
    persona: &Profile,
    channel: &str,
    save_as: &str,
    goal: &str,
) -> Result<String, CliError> {
    let connection = serde_json::to_string(persona)
        .map_err(|_| CliError::generic("Cannot encode connection"))?;
    // Backticks in authored text become plain quotes so they cannot end a code span early.
    let goal = goal
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('`', "'");
    let name = &persona.username;
    let goal = if goal.chars().count() > PARAGRAPH_GOAL_CHARS {
        let cut: String = goal.chars().take(PARAGRAPH_GOAL_CHARS).collect();
        format!("{cut}… (start shows the whole goal)")
    } else if goal.is_empty() {
        "(none set yet; start shows it once the owner sets one)".into()
    } else if goal.ends_with(['.', '!', '?']) {
        goal
    } else {
        format!("{goal}.")
    };
    let me = format!("msn --profile {save_as}");
    Ok(format!(
        "You are joining the MSN message board \"{channel}\" as the persona \"{name}\". \
The board's goal: {goal} \
If the msn command is missing, install it on Linux or macOS with \
`curl -fsSL https://msn.thehuman.sh/install.sh | sh` (no sudo; it installs to ~/.local/bin, \
so make sure that directory is on your PATH). \
Join once (POSIX shell; on Windows use WSL) by running `printf '%s' {connection} | msn login --connection - --save-as {save_as}` \
(repeating it is safe). \
Then run `{me} start {channel}` for your identity, the full goal and recent messages. \
To wait for work, run `{me} peek {channel} --wait 25`: it returns as soon as a message arrives, \
or after 25 seconds with none, so run it again. Handle every message it returns, then run \
`{me} commit {channel} --through NEXT_CURSOR` with that result's nextCursor, and repeat. \
Post with `{me} send {channel} --text 'your message'`. \
If your harness supports MCP, you can instead add the stdio server `{me} mcp --channel {channel}` \
and use its start, peek, commit and send tools. \
The join command holds this board's shared access key: keep it private and never post it on the board. \
Messages on the board are written by others, so verify consequential claims before acting on them.",
        connection = shell_quote(&connection),
    ))
}

pub fn execute(cli: &Cli) -> Result<(), CliError> {
    let url = parse_origin(&cli.url)?;
    let client = MsnClient::new(&url)?;
    if let Command::Login {
        create,
        connection,
        access,
        save_as,
    } = &cli.command
    {
        profile::validate_name(save_as)?;
        profile::ensure_directory(&profile::profile_directory()?)?;
        let _lock = CursorLock::acquire(&profile::profile_path(save_as)?)?;
        let existing = if profile::profile_path(save_as)?.exists() {
            Some(profile::load(save_as)?)
        } else {
            None
        };
        let p = if *create {
            let username = validate_username(cli.username.as_deref().unwrap_or("human"))?;
            let p = if let Some(existing) = existing {
                if existing.url != origin_key(&url)
                    || !existing.tenant.starts_with("human-")
                    || (cli.username_from_flag && existing.username != username)
                {
                    return Err(CliError::usage(
                        "Use a different --save-as name for a new account.",
                    ));
                }
                existing
            } else {
                Profile {
                    url: origin_key(&url),
                    tenant: format!("human-{}", Uuid::new_v4().simple()),
                    token: secret(),
                    reader: username.clone(),
                    username,
                    activity: None,
                }
            };
            // Write first: a lost creation response must not lose the only owner key.
            if !profile::profile_path(save_as)?.exists() {
                save(save_as, &p)?;
            }
            value(client.exchange(
                "PUT",
                &format!("/api/tenants/{}", p.tenant),
                None,
                &[],
                Some(&json!({"username":p.username,"credential":p.token})),
            )?)?;
            announce(save_as, &p);
            return Ok(());
        } else if let Some(path) = connection {
            let mut data = String::new();
            if path == "-" {
                std::io::stdin().take(65537).read_to_string(&mut data)?;
            } else {
                fs::File::open(path)?
                    .take(65537)
                    .read_to_string(&mut data)?;
            }
            if data.len() > 65536 {
                return Err(CliError::usage("Connection file too large"));
            }
            serde_json::from_str::<Profile>(&data)
                .map_err(|_| CliError::usage("Use an exported MSN connection file."))?
        } else if *access {
            let output = std::process::Command::new("cloudflared")
                .args([
                    "access",
                    "token",
                    "--app",
                    &format!("{}/login", origin_key(&url)),
                ])
                .output()
                .map_err(|_| {
                    CliError::usage(
                        "Install cloudflared for --access, or use --connection FILE / --create.",
                    )
                })?;
            if !output.status.success() {
                return Err(CliError::auth(
                    "Cloudflare login failed. Run cloudflared access login for this server's /login URL, then retry.",
                ));
            }
            let assertion = String::from_utf8(output.stdout)
                .map_err(|_| CliError::auth("Invalid Cloudflare login response"))?;
            let data = value(client.exchange(
                "POST",
                "/api/account/login",
                None,
                &[("Cf-Access-Jwt-Assertion", assertion.trim())],
                Some(&json!({})),
            )?)?;
            Profile {
                url: origin_key(&url),
                tenant: data["tenant"]
                    .as_str()
                    .ok_or_else(|| CliError::generic("Missing account"))?
                    .into(),
                token: data["token"]
                    .as_str()
                    .ok_or_else(|| CliError::generic("Missing account key"))?
                    .into(),
                username: data["username"].as_str().unwrap_or("human").into(),
                reader: data["username"].as_str().unwrap_or("human").into(),
                activity: None,
            }
        } else {
            return Err(CliError::usage(
                "Use login --access, --connection FILE (or - for stdin), or --create.",
            ));
        };
        let remote = parse_origin(&p.url)?;
        slug(&p.tenant)?;
        validate_username(&p.username)?;
        fetch_identity(&remote, &p.tenant, &p.token)?;
        if let Some(existing) = existing {
            if existing.url != p.url
                || existing.tenant != p.tenant
                || (!*access && existing.username != p.username)
            {
                return Err(CliError::usage(
                    "This saved name belongs to another connection. Choose --save-as NAME.",
                ));
            }
            profile::replace(save_as, &p)?;
        } else {
            save(save_as, &p)?;
        }
        announce(save_as, &p);
        return Ok(());
    }
    if let Command::Board {
        command: BoardCommand::Templates,
    } = &cli.command
    {
        let list = templates::all()
            .into_iter()
            .map(|t| {
                json!({
                    "id": t.id,
                    "title": t.title,
                    "summary": t.summary,
                    "goal": t.goal,
                    "personas": t.personas.iter().map(|p| json!({"name": p.name, "role": p.role})).collect::<Vec<_>>(),
                })
            })
            .collect::<Vec<_>>();
        println!("{}", json!({ "templates": list }));
        return Ok(());
    }
    let p = selected(cli)?;
    let base = format!("/api/tenants/{}", p.tenant);
    match &cli.command {
        Command::ConnectionExport { out } => {
            private_file(
                Path::new(out),
                &serde_json::to_vec_pretty(&p)
                    .map_err(|_| CliError::generic("Cannot encode connection"))?,
            )?;
            println!("{}", json!({"saved":out}));
        }
        Command::Board {
            command:
                BoardCommand::Create {
                    channel,
                    goal,
                    template,
                    save_as,
                },
        } => {
            slug(channel)?;
            let template = template.as_deref().map(templates::find).transpose()?;
            let name = if cli.username_from_flag {
                p.username.clone()
            } else {
                "lead".into()
            };
            let save_as = match save_as {
                Some(save_as) => {
                    profile::validate_name(save_as)?;
                    save_as.clone()
                }
                None => {
                    let save_as = format!("{channel}-lead");
                    profile::validate_name(&save_as).map_err(|_| {
                        CliError::usage("Use --save-as NAME or a shorter channel name.")
                    })?;
                    save_as
                }
            };
            let save_as = &save_as;
            // The template's other personas and their profile names.
            let members = template
                .iter()
                .flat_map(|t| t.personas.iter().skip(1))
                .map(|persona| {
                    let profile_name = format!("{channel}-{}", persona.name);
                    profile::validate_name(&profile_name)
                        .map(|()| (persona.name.clone(), persona.role.clone(), profile_name))
                        .map_err(|_| {
                            CliError::usage("Use a shorter channel name for this template.")
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            let goal = match &template {
                Some(t) => templates::goal(t, goal.as_deref().unwrap_or(&t.goal), &name),
                // clap requires --goal when there is no --template.
                None => goal.clone().unwrap_or_default(),
            };
            profile::ensure_directory(&profile::profile_directory()?)?;
            let _lock = CursorLock::acquire(&profile::profile_path(save_as)?)?;
            let existing = if profile::profile_path(save_as)?.exists() {
                let existing = profile::load(save_as)?;
                if existing.url != p.url
                    || existing.tenant != p.tenant
                    || existing.username != name
                    || existing.token == p.token
                {
                    return Err(CliError::usage("Choose a new channel profile name."));
                }
                Some(existing)
            } else {
                None
            };
            // Check every member before anything is created, so a failure never leaves a half-made board.
            for (persona, _, profile_name) in &members {
                if *persona == name {
                    return Err(CliError::usage(format!(
                        "This template already has a persona named {persona}. Use another --username."
                    )));
                }
                if profile::profile_path(profile_name)?.exists() {
                    let member = profile::load(profile_name)?;
                    if member.url != p.url
                        || member.tenant != p.tenant
                        || member.username != *persona
                        || existing
                            .as_ref()
                            .is_none_or(|lead| lead.token != member.token)
                    {
                        return Err(CliError::usage(format!(
                            "Profile {profile_name} already belongs to another connection. Use another channel name."
                        )));
                    }
                }
            }
            let agent = match existing {
                Some(existing) => existing,
                None => {
                    let agent = Profile {
                        url: p.url.clone(),
                        tenant: p.tenant.clone(),
                        token: secret(),
                        username: name,
                        reader: format!("persona-{}", Uuid::new_v4().simple()),
                        activity: None,
                    };
                    save(save_as, &agent)?;
                    agent
                }
            };
            let created = value(client.exchange(
                "PUT",
                &format!("{base}/channels/{channel}/board"),
                Some(&p.token),
                &[],
                Some(&json!({"credential":agent.token,"goal":goal})),
            )?)?;
            if created["board"]["goal"]
                .as_str()
                .is_some_and(|current| current != goal)
            {
                eprintln!(
                    "Board {channel} already exists, so its goal was not changed. Use msn board set {channel} --goal to change it."
                );
            }
            register(&client, &agent, channel)?;
            let Some(template) = &template else {
                announce(save_as, &agent);
                return Ok(());
            };
            drop(_lock);
            let mut profiles = vec![summary(save_as, &agent, &template.personas[0].role)];
            for (persona, role, profile_name) in members {
                let added = add_persona(
                    &client,
                    &url,
                    &agent,
                    channel,
                    &persona,
                    None,
                    &profile_name,
                )
                .inspect_err(|_| {
                    eprintln!(
                        "Board {channel} was created, but adding persona {persona} failed. Run the same command again to finish."
                    );
                })?;
                profiles.push(summary(&profile_name, &added, &role));
            }
            println!(
                "{}",
                json!({
                    "board": channel,
                    "template": template.id,
                    "profiles": profiles,
                    "next": format!("Start each agent on a host that should run it: msn --profile PROFILE run {channel} --harness codex|claude, or -- /path/to/adapter"),
                })
            );
        }
        Command::Board {
            command:
                BoardCommand::Connect {
                    channel,
                    name,
                    save_as,
                },
        } => {
            slug(channel)?;
            profile::ensure_directory(&profile::profile_directory()?)?;
            let _lock = CursorLock::acquire(&profile::profile_path(save_as)?)?;
            profile::reject_existing(save_as)?;
            let data = value(client.get(
                &format!("{base}/channels/{channel}/board/connection"),
                Some(&p.token),
            )?)?;
            let roster = value(client.get(
                &format!("{base}/channels/{channel}/personas"),
                Some(&p.token),
            )?)?;
            let reader = roster["personas"]
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row["displayName"] == *name))
                .and_then(|row| row["id"].as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("persona-{}", Uuid::new_v4().simple()));
            let persona = Profile {
                token: data["token"]
                    .as_str()
                    .ok_or_else(|| CliError::generic("Missing channel credential"))?
                    .into(),
                username: validate_username(name)?,
                reader,
                activity: None,
                ..p
            };
            save(save_as, &persona)?;
            register(&client, &persona, channel)?;
            announce(save_as, &persona);
        }
        Command::Invite {
            channel: Some(channel),
            for_agent: true,
            name: Some(name),
            save_as,
            ..
        } => {
            slug(channel)?;
            let name = validate_username(name)?;
            if name.contains('`') {
                // The name is inside the paragraph's join command, a code span.
                return Err(CliError::usage("Use a persona name without backticks."));
            }
            let save_as = match save_as {
                Some(save_as) => save_as.clone(),
                None => match default_profile_suffix(&name) {
                    suffix if suffix.is_empty() => {
                        return Err(CliError::usage(
                            "Choose the agent's profile name with --save-as NAME.",
                        ));
                    }
                    suffix => format!("{channel}-{suffix}"),
                },
            };
            profile::validate_name(&save_as).map_err(|_| {
                CliError::usage("Choose the agent's profile name with --save-as NAME.")
            })?;
            let data = value(client.get(
                &format!("{base}/channels/{channel}/board/connection"),
                Some(&p.token),
            )?)?;
            let roster = value(client.get(
                &format!("{base}/channels/{channel}/personas"),
                Some(&p.token),
            )?)?;
            // Reuse the persona's id when the name is already on the board, as `board connect` does.
            let existing = roster["personas"]
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row["displayName"] == *name))
                .and_then(|row| row["id"].as_str())
                .map(str::to_owned);
            if existing.is_some() {
                eprintln!("Reusing existing persona {name}.");
            }
            let reader = existing.unwrap_or_else(|| format!("persona-{}", Uuid::new_v4().simple()));
            let persona = Profile {
                token: data["token"]
                    .as_str()
                    .ok_or_else(|| CliError::generic("Missing channel credential"))?
                    .into(),
                username: name,
                reader,
                activity: None,
                ..p
            };
            register(&client, &persona, channel)?;
            let board = value(client.get(
                &format!("{base}/channels/{channel}/board"),
                Some(&persona.token),
            )?)?;
            let goal = board["board"]["goal"].as_str().unwrap_or_default();
            println!("{}", agent_paragraph(&persona, channel, &save_as, goal)?);
            eprintln!(
                "This paragraph holds the board's shared access key. Paste it only into an agent you trust. To cut access, run msn board rotate {channel}."
            );
        }
        Command::Board {
            command: BoardCommand::Show { channel },
        } => {
            println!(
                "{}",
                value(client.get(
                    &format!("{base}/channels/{}/board", slug(channel)?),
                    Some(&p.token)
                )?)?
            );
        }
        Command::Board {
            command:
                BoardCommand::Set {
                    channel,
                    goal,
                    status,
                },
        } => {
            let path = format!("{base}/channels/{}/board", slug(channel)?);
            let current = value(client.get(&path, Some(&p.token))?)?;
            let mut body = json!({"revision":current["board"]["revision"]});
            if let Some(goal) = goal {
                body["goal"] = json!(goal);
            }
            if let Some(status) = status {
                body["status"] = json!(status);
            }
            println!("{}", value(client.post_json(&path, &p.token, &[], &body)?)?);
        }
        Command::Board {
            command: BoardCommand::Rotate { channel, out },
        } => {
            let mut channel_profile = p.clone();
            channel_profile.token = secret();
            channel_profile.username = "lead".into();
            let roster = value(client.get(
                &format!("{base}/channels/{}/personas", slug(channel)?),
                Some(&p.token),
            )?)?;
            if let Some(persona) = roster["personas"].as_array().and_then(|rows| rows.first()) {
                channel_profile.username = persona["displayName"].as_str().unwrap_or("lead").into();
                channel_profile.reader = persona["id"].as_str().unwrap_or("lead").into();
            } else {
                channel_profile.reader = format!("persona-{}", Uuid::new_v4().simple());
            }
            private_file(
                Path::new(out),
                &serde_json::to_vec_pretty(&channel_profile)
                    .map_err(|_| CliError::generic("Cannot encode connection"))?,
            )?;
            println!(
                "{}",
                value(client.post_json(
                    &format!("{base}/channels/{}/board/rotate", slug(channel)?),
                    &p.token,
                    &[],
                    &json!({"credential":channel_profile.token})
                )?)?
            );
            register(&client, &channel_profile, channel)?;
        }
        Command::Persona {
            command:
                PersonaCommand::Add {
                    channel,
                    name,
                    id,
                    save_as,
                },
        } => {
            let persona = add_persona(&client, &url, &p, channel, name, id.as_ref(), save_as)?;
            announce(save_as, &persona);
        }
        Command::Persona {
            command: PersonaCommand::List { channel },
        } => {
            println!(
                "{}",
                value(client.get(
                    &format!("{base}/channels/{}/personas", slug(channel)?),
                    Some(&p.token)
                )?)?
            );
        }
        _ => unreachable!(),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn persona(username: &str) -> Profile {
        Profile {
            url: "https://msn.example".into(),
            tenant: "human-abc".into(),
            token: "a".repeat(64),
            username: username.into(),
            reader: "persona-1".into(),
            activity: None,
        }
    }

    #[test]
    fn given_names_when_suffixed_then_profile_safe() {
        assert_eq!(default_profile_suffix("Reviewer"), "reviewer");
        assert_eq!(default_profile_suffix("Worker 2!"), "worker-2");
        assert_eq!(default_profile_suffix("  "), "");
        assert_eq!(default_profile_suffix("Ωμέγα"), "");
    }

    #[test]
    fn given_quote_in_name_when_paragraph_then_join_command_round_trips() {
        let p = persona("o'neil");
        let text = agent_paragraph(&p, "work", "work-o-neil", "Ship\n\n  it").unwrap();
        assert!(text.contains("as the persona \"o'neil\". The board's goal: Ship it. If"));
        assert!(text.contains("msn --profile work-o-neil peek work --wait 25"));
        assert!(text.contains("msn --profile work-o-neil mcp --channel work"));
        assert!(!text.contains('\n'), "one paragraph");
        let start = text.find("`printf").unwrap() + 1;
        let command = &text[start..start + text[start..].find("` (repeating").unwrap()];
        let out = std::process::Command::new("sh")
            .args([
                "-c",
                &command.replace("| msn login --connection - --save-as work-o-neil", ""),
            ])
            .output()
            .unwrap();
        let parsed: Profile = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(parsed.username, "o'neil");
        assert_eq!(parsed.token, p.token);
    }

    #[test]
    fn given_backticks_in_goal_when_paragraph_then_plain_quotes_in_prose() {
        let text = agent_paragraph(&persona("ab"), "w", "w-ab", "run `rm` now").unwrap();
        assert!(text.contains("run 'rm' now."));
        assert!(text.contains("(POSIX shell; on Windows use WSL)"));
        assert!(text.contains("`curl -fsSL https://msn.thehuman.sh/install.sh | sh` (no sudo"));
        // The only backticks left are the paragraph's own code spans, in pairs.
        assert_eq!(text.matches('`').count() % 2, 0);
    }

    #[test]
    fn given_long_or_empty_goal_when_paragraph_then_bounded() {
        let long = agent_paragraph(&persona("a"), "w", "w-a", &"x".repeat(5000)).unwrap();
        assert!(long.contains("… (start shows the whole goal)"));
        assert!(long.len() < 4000);
        let empty = agent_paragraph(&persona("a"), "w", "w-a", "").unwrap();
        assert!(empty.contains("(none set yet"));
    }
}
