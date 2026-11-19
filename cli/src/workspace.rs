use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use url::Url;

use crate::args::{Cli, Command, WorkspaceCommand};
use crate::client::{MsnClient, RawResponse, classify, print_success};
use crate::config::{origin_key, parse_origin, require_tenant, require_token, slug};
use crate::cursor::{CursorLock, reader_hash};
use crate::error::CliError;
use crate::identity::validate_username;
use crate::profile::{self, Profile};

fn response(raw: RawResponse) -> Result<Value, CliError> {
    classify(raw.status, &raw.body)?;
    serde_json::from_str(&raw.body).map_err(|_| CliError::generic("Response was not JSON."))
}

/// Full links select their own origin. No existing credentials are sent to an invitation server.
fn invitation(raw: &str, default_url: &str) -> Result<(Url, String, String), CliError> {
    let (url, code) = if raw.contains("://") {
        let link = Url::parse(raw).map_err(|_| CliError::usage("Invalid invitation link."))?;
        if !link.username().is_empty()
            || link.password().is_some()
            || link.path() != "/"
            || link.query().is_some()
        {
            return Err(CliError::usage("Invalid invitation link."));
        }
        let code = url::form_urlencoded::parse(link.fragment().unwrap_or("").as_bytes())
            .find(|(key, _)| key == "invite")
            .map(|(_, value)| value.into_owned())
            .ok_or_else(|| CliError::usage("Invitation link has no invite code."))?;
        (parse_origin(&origin_key(&link))?, code)
    } else {
        (parse_origin(default_url)?, raw.to_string())
    };
    let (tenant, secret) = code
        .split_once('.')
        .ok_or_else(|| CliError::usage("Use a complete invitation link or code."))?;
    slug(tenant)?;
    if secret.len() != 64
        || !secret
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(CliError::usage("Invalid invitation code."));
    }
    Ok((url, tenant.to_string(), code))
}

fn cache_name(
    url: &Url,
    tenant: &str,
    username: &str,
    chosen: Option<&str>,
) -> Result<String, CliError> {
    let name = match chosen {
        Some(name) => name.to_string(),
        None => format!(
            "{}-{}",
            &tenant[..tenant.len().min(40)],
            &format!(
                "{:x}",
                Sha256::digest(format!("{}\n{tenant}\n{username}", origin_key(url)))
            )[..16]
        ),
    };
    profile::validate_name(&name)?;
    Ok(name)
}

fn reserve(name: &str) -> Result<CursorLock, CliError> {
    profile::ensure_directory(&profile::profile_directory()?)?;
    let lock = CursorLock::acquire(&profile::profile_path(name)?)?;
    profile::reject_existing(name)?;
    Ok(lock)
}

fn activity(profile: &Profile) -> Result<Value, CliError> {
    let client = MsnClient::new(&parse_origin(&profile.url)?)?;
    let mut channels = Vec::new();
    let mut after = String::new();
    loop {
        let data = response(client.get(
            &format!(
                "/api/tenants/{}/channels?limit=1000&after={after}",
                profile.tenant
            ),
            Some(&profile.token),
        )?)?;
        let rows = data["channels"]
            .as_array()
            .ok_or_else(|| CliError::generic("Invalid channel list."))?;
        channels.extend(rows.iter().cloned());
        if data["hasMore"] == false {
            break;
        }
        let next = data["nextCursor"]
            .as_str()
            .ok_or_else(|| CliError::generic("Invalid channel cursor."))?;
        slug(next)?;
        if next <= after.as_str() || channels.len() >= 1000 {
            return Err(CliError::generic("Channel listing exceeded its bound."));
        }
        after = next.to_string();
    }
    let checked_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| CliError::generic("System clock is before Unix epoch."))?
        .as_secs();
    Ok(json!({ "checkedAt": checked_at, "channels": channels }))
}

fn public(name: &str, profile: &Profile, state: &str) -> Value {
    json!({ "profile": name, "url": profile.url, "tenant": profile.tenant, "username": profile.username,
        "activity": profile.activity, "status": state })
}

fn save(name: &str, mut profile: Profile) -> Result<(), CliError> {
    reader_hash(&profile.reader)?;
    // Persist the issued key before any optional stats request, including network failures.
    profile::write_new(name, &profile)?;
    let state = match activity(&profile) {
        Ok(stats) => {
            profile.activity = Some(stats);
            profile::replace(name, &profile)?;
            "current"
        }
        Err(_) => "unavailable",
    };
    println!("{}", public(name, &profile, state));
    eprintln!("Saved locally. Use msn --profile {name} channels (or any other command).");
    Ok(())
}

fn list(offline: bool) -> Result<(), CliError> {
    let mut workspaces = Vec::new();
    for name in profile::names()? {
        let _lock = CursorLock::acquire(&profile::profile_path(&name)?)?;
        let mut profile = profile::load(&name)?;
        let state = if offline {
            "cached"
        } else {
            match activity(&profile) {
                Ok(stats) => {
                    profile.activity = Some(stats);
                    profile::replace(&name, &profile)?;
                    "current"
                }
                Err(CliError::Auth(_)) => {
                    profile.activity = None;
                    profile::replace(&name, &profile)?;
                    "access_denied"
                }
                Err(_) => "unavailable",
            }
        };
        workspaces.push(public(&name, &profile, state));
    }
    println!("{}", json!({ "workspaces": workspaces }));
    Ok(())
}

pub fn execute(cli: &Cli) -> Result<(), CliError> {
    match &cli.command {
        Command::Workspace {
            command: WorkspaceCommand::List { offline },
        } => list(*offline),
        Command::Workspace {
            command:
                WorkspaceCommand::Create {
                    tenant,
                    channel,
                    save_as,
                },
        } => {
            let url = parse_origin(&cli.url)?;
            slug(tenant)?;
            slug(channel)?;
            let username = validate_username(
                cli.username
                    .as_deref()
                    .ok_or_else(|| CliError::usage("Choose --username NAME."))?,
            )?;
            let name = cache_name(&url, tenant, &username, save_as.as_deref())?;
            let _lock = reserve(&name)?;
            let data = response(MsnClient::new(&url)?.exchange(
                "PUT",
                &format!("/api/tenants/{tenant}"),
                None,
                &[],
                Some(&json!({ "username": username, "channel": channel })),
            )?)?;
            save(&name, issued_profile(&url, tenant, &username, &data)?)
        }
        Command::Workspace {
            command: WorkspaceCommand::Connect { save_as },
        } => {
            let url = parse_origin(&cli.url)?;
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let username =
                profile::resolve_username(&url, &tenant, &token, cli.username.as_deref())?;
            let name = cache_name(&url, &tenant, &username, save_as.as_deref())?;
            let _lock = reserve(&name)?;
            save(
                &name,
                Profile {
                    url: origin_key(&url),
                    tenant,
                    token,
                    reader: cli.reader.clone().unwrap_or_else(|| username.clone()),
                    username,
                    activity: None,
                },
            )
        }
        Command::Join {
            invitation: raw,
            save_as,
        } => {
            let (url, tenant, code) = invitation(raw, &cli.url)?;
            let username = validate_username(
                cli.username
                    .as_deref()
                    .ok_or_else(|| CliError::usage("Choose --username NAME."))?,
            )?;
            let name = cache_name(&url, &tenant, &username, save_as.as_deref())?;
            let _lock = reserve(&name)?;
            let data = response(MsnClient::new(&url)?.exchange(
                "POST",
                &format!("/api/tenants/{tenant}/invites/redeem"),
                None,
                &[],
                Some(&json!({ "username": username, "code": code })),
            )?)?;
            save(&name, issued_profile(&url, &tenant, &username, &data)?)
        }
        Command::Invite {
            channel,
            uses,
            expires_in,
            for_agent: false,
            ..
        } => {
            if *uses == 0 || *uses > 100 || !(60..=604800).contains(expires_in) {
                return Err(CliError::usage(
                    "Use 1–100 recipients and an expiry of 60–604800 seconds.",
                ));
            }
            if let Some(channel) = channel {
                slug(channel)?;
            }
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let data = response(MsnClient::new(&parse_origin(&cli.url)?)?.post_json(
                &format!("/api/tenants/{tenant}/invites"),
                &token,
                &[],
                &json!({ "channel": channel, "maxUses": uses, "expiresIn": expires_in }),
            )?)?;
            println!("{data}");
            Ok(())
        }
        Command::InviteRevoke { id } => {
            uuid::Uuid::parse_str(id).map_err(|_| CliError::usage("Use the invitation's id."))?;
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let result = MsnClient::new(&parse_origin(&cli.url)?)?
                .delete(&format!("/api/tenants/{tenant}/invites/{id}"), &token)?;
            classify(result.status, &result.body)?;
            print_success(result.status, &result.body)
        }
        _ => unreachable!(),
    }
}

fn issued_profile(
    url: &Url,
    tenant: &str,
    username: &str,
    data: &Value,
) -> Result<Profile, CliError> {
    if data["tenant"] != tenant || data["username"] != username {
        return Err(CliError::generic(
            "Issued identity does not match the requested workspace and name.",
        ));
    }
    Ok(Profile {
        url: origin_key(url),
        tenant: tenant.to_string(),
        token: require_token(data["token"].as_str(), "issued access token")?,
        username: username.to_string(),
        reader: username.to_string(),
        activity: None,
    })
}
