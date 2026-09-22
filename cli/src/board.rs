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
                    save_as,
                },
        } => {
            slug(channel)?;
            profile::validate_name(save_as)?;
            let name = if cli.username_from_flag {
                p.username.clone()
            } else {
                "lead".into()
            };
            profile::ensure_directory(&profile::profile_directory()?)?;
            let _lock = CursorLock::acquire(&profile::profile_path(save_as)?)?;
            let agent = if profile::profile_path(save_as)?.exists() {
                let existing = profile::load(save_as)?;
                if existing.url != p.url
                    || existing.tenant != p.tenant
                    || existing.username != name
                    || existing.token == p.token
                {
                    return Err(CliError::usage("Choose a new channel profile name."));
                }
                existing
            } else {
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
            };
            value(client.exchange(
                "PUT",
                &format!("{base}/channels/{channel}/board"),
                Some(&p.token),
                &[],
                Some(&json!({"credential":agent.token,"goal":goal})),
            )?)?;
            register(&client, &agent, channel)?;
            announce(save_as, &agent);
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
            slug(channel)?;
            let identity = fetch_identity(&url, &p.tenant, &p.token)?;
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
                    || id.as_ref().is_some_and(|id| id != &existing.reader)
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
                        .clone()
                        .unwrap_or_else(|| format!("persona-{}", Uuid::new_v4().simple())),
                    activity: None,
                    ..p
                };
                slug(&persona.reader)?;
                save(save_as, &persona)?;
                persona
            };
            register(&client, &persona, channel)?;
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
