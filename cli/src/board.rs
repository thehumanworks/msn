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
