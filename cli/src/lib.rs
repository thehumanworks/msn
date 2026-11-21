pub mod address;
pub mod agent;
pub mod archive;
pub mod args;
pub mod ask;
pub mod attachments;
pub mod board;
pub mod client;
pub mod config;
pub mod cursor;
pub mod doctor;
pub mod error;
pub mod events;
pub mod export;
pub mod gather;
pub mod identity;
pub mod import;
pub mod labels;
pub mod links;
pub mod mcp;
pub mod mutes;
pub mod processing;
pub mod profile;
pub mod reactions;
pub mod receipts;
pub mod resumable;
pub mod runner;
pub mod scheduled;
pub mod search;
pub mod since;
pub mod status;
pub mod task_client;
pub mod tasks;
pub mod templates;
pub mod transcript;
pub mod watch;
pub mod workspace;

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use url::Url;
use uuid::Uuid;

use args::{Cli, Command, ExportFormat, ScheduledCommand, SnapshotCommand};
use client::{
    MsnClient, classify, error_message, is_retryable_status, print_success, status_error,
};
use config::{
    CHANNELS_PAGE_LIMIT, DEFAULT_CATCHUP_MAX_BYTES, DEFAULT_SNAPSHOT_LIMIT, MAX_CATCHUP_MAX_BYTES,
    MAX_LIMIT, MAX_SAFE_INTEGER, MAX_SNAPSHOT_TEXT_BYTES, MAX_WAIT, MIN_CATCHUP_MAX_BYTES,
    parse_int, require_correlation_id, require_idempotency_key, require_quote, require_tenant,
    require_text, require_token, slug,
};
use cursor::{CursorBinding, CursorLock, default_cursor_path, load_cursor, write_cursor};
use error::CliError;

const BACKOFF_START_MS: u64 = 1000;
const BACKOFF_MAX_MS: u64 = 15000;

pub fn execute(cli: Cli, stop: Arc<AtomicBool>) -> Result<(), CliError> {
    if matches!(&cli.command, Command::Run { .. }) {
        return runner::execute(&cli);
    }
    if matches!(&cli.command, Command::Mcp { .. }) {
        return mcp::execute(&cli);
    }
    if matches!(
        &cli.command,
        Command::Login { .. }
            | Command::Board { .. }
            | Command::Github { .. }
            | Command::Persona { .. }
            | Command::ConnectionExport { .. }
            | Command::Invite {
                for_agent: true,
                ..
            }
    ) {
        return board::execute(&cli);
    }

    if matches!(
        &cli.command,
        Command::Workspace { .. }
            | Command::Invite { .. }
            | Command::Join { .. }
            | Command::InviteRevoke { .. }
    ) {
        return workspace::execute(&cli);
    }
    if matches!(
        &cli.command,
        Command::Snapshot {
            command: SnapshotCommand::Template
        }
    ) {
        return snapshot_template();
    }
    let url = config::parse_origin(&cli.url)?;
    match cli.command {
        Command::Login { .. }
        | Command::Board { .. }
        | Command::Github { .. }
        | Command::Persona { .. }
        | Command::ConnectionExport { .. }
        | Command::Run { .. }
        | Command::Mcp { .. } => unreachable!(),
        Command::Doctor { .. } => Err(CliError::generic(
            "msn doctor runs before connection setup; call doctor::run.",
        )),
        Command::Workspace { .. }
        | Command::Invite { .. }
        | Command::Join { .. }
        | Command::InviteRevoke { .. } => unreachable!(),
        Command::Start {
            channel,
            after,
            edits_after,
            limit,
            max_bytes,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let after = after
                .as_deref()
                .map(|v| parse_int(v, MAX_SAFE_INTEGER))
                .transpose()?;
            let edits_after = edits_after
                .as_deref()
                .map(|v| parse_int(v, MAX_SAFE_INTEGER))
                .transpose()?;
            let limit = parse_optional_int(limit.as_deref(), DEFAULT_SNAPSHOT_LIMIT, MAX_LIMIT)?;
            require_positive_limit(limit)?;
            let budget = parse_optional_int(
                max_bytes.as_deref(),
                DEFAULT_CATCHUP_MAX_BYTES,
                MAX_CATCHUP_MAX_BYTES,
            )?;
            agent::start(
                &url,
                &tenant,
                &token,
                channel,
                cli.username.as_deref(),
                cli.reader.as_deref(),
                after,
                edits_after,
                limit,
                budget,
            )
        }
        Command::Show {
            channel,
            message_id,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let id = parse_int(&message_id, MAX_SAFE_INTEGER)?;
            if id == 0 {
                return Err(CliError::usage("message ID must be positive."));
            }
            agent::print_json(&agent::show(&url, &tenant, &token, channel, id)?)
        }
        Command::Mute {
            channel,
            duration,
            everything,
            json,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let Some(channel) = channel else {
                if duration.is_some() || everything {
                    return Err(CliError::usage("--for and --everything need a CHANNEL."));
                }
                let listed = mutes::list(&url, &tenant, &token)?;
                if json {
                    return agent::print_json(&listed);
                }
                let mut stdout = std::io::stdout().lock();
                let rows = listed["mutes"].as_array().cloned().unwrap_or_default();
                if rows.is_empty() {
                    writeln!(stdout, "No boards muted.")?;
                }
                for row in rows {
                    writeln!(stdout, "{}", mutes::describe(&row))?;
                }
                return Ok(());
            };
            let channel = slug(&channel)?;
            let muted = mutes::mute(
                &url,
                &tenant,
                &token,
                channel,
                duration.as_deref(),
                everything,
            )?;
            if json {
                agent::print_json(&muted)
            } else {
                let mut stdout = std::io::stdout().lock();
                writeln!(stdout, "{}", mutes::describe(&muted))?;
                Ok(())
            }
        }
        Command::Unmute { channel } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            mutes::unmute(&url, &tenant, &token, channel)?;
            let mut stdout = std::io::stdout().lock();
            writeln!(stdout, "#{channel} notifications are back on.")?;
            Ok(())
        }
        Command::Link {
            channel,
            message_id,
            json,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let id = parse_int(&message_id, MAX_SAFE_INTEGER)?;
            if id == 0 {
                return Err(CliError::usage("message ID must be positive."));
            }
            let link = links::checked_link(&url, &tenant, &token, channel, id)?;
            if json {
                agent::print_json(&link)
            } else {
                let mut stdout = std::io::stdout().lock();
                writeln!(stdout, "{}", link["link"].as_str().unwrap_or_default())?;
                Ok(())
            }
        }
        Command::Peek {
            channel,
            thread,
            wait,
            limit,
            cursor_file,
            resumable,
            local,
        } => {
            let thread = parse_thread(thread.as_deref())?;
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let wait = parse_optional_int(wait.as_deref(), 0, MAX_WAIT)?;
            let limit = parse_optional_int(limit.as_deref(), 100, MAX_LIMIT)?;
            require_positive_limit(limit)?;
            let reader = identity::resolve_username(
                &url,
                &tenant,
                &token,
                cli.reader.as_deref().or(cli.username.as_deref()),
            )?;
            if let Some(thread) = thread {
                // A thread's progress always stays on this machine (ADR 0063).
                return processing::peek_scoped(
                    &mut io::stdout().lock(),
                    &url,
                    &tenant,
                    &token,
                    channel,
                    Some(thread),
                    &reader,
                    cursor_file.as_deref().map(Path::new),
                    wait,
                    limit,
                    &stop,
                );
            }
            resumable::peek(
                resumable::mode(resumable, local),
                &url,
                &tenant,
                &token,
                channel,
                &reader,
                cursor_file.as_deref().map(Path::new),
                wait,
                limit,
                stop,
            )
        }
        Command::Commit {
            channel,
            through,
            thread,
            cursor_file,
            resumable,
            local,
        } => {
            let thread = parse_thread(thread.as_deref())?;
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let through = parse_int(&through, MAX_SAFE_INTEGER)?;
            let reader = identity::resolve_username(
                &url,
                &tenant,
                &token,
                cli.reader.as_deref().or(cli.username.as_deref()),
            )?;
            if let Some(thread) = thread {
                return processing::commit_scoped(
                    &mut io::stdout().lock(),
                    &url,
                    &tenant,
                    channel,
                    Some(thread),
                    &reader,
                    cursor_file.as_deref().map(Path::new),
                    through,
                );
            }
            resumable::commit(
                resumable::mode(resumable, local),
                &url,
                &tenant,
                &token,
                channel,
                &reader,
                cursor_file.as_deref().map(Path::new),
                through,
            )
        }
        Command::Takeover {
            channel,
            cursor_file,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let reader = identity::resolve_username(
                &url,
                &tenant,
                &token,
                cli.reader.as_deref().or(cli.username.as_deref()),
            )?;
            resumable::takeover(
                &url,
                &tenant,
                &token,
                channel,
                &reader,
                cursor_file.as_deref().map(Path::new),
            )
        }
        Command::Task { command } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            task_client::execute(&url, &tenant, &token, cli.username.as_deref(), command)
        }
        Command::Profile { .. }
        | Command::Activate { .. }
        | Command::Deactivate
        | Command::ShellInit { .. } => Err(CliError::generic(
            "Local profile commands must be prepared before execution.",
        )),
        Command::Health => health(&url),
        Command::Whoami => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            finish(&MsnClient::new(&url)?.get(&format!("/api/tenants/{tenant}"), Some(&token))?)
        }
        Command::KeyCreate {
            key,
            username_prefix,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.admin_token.as_deref(), "MSN_ADMIN_TOKEN")?;
            let key = slug(&key)?;
            let bound = cli
                .username_from_flag
                .then_some(cli.username.as_deref())
                .flatten();
            let bind = binding(bound, username_prefix.as_deref(), false)?.ok_or_else(|| {
                CliError::usage("key-create requires an explicit --username or --username-prefix flag; MSN_USERNAME never binds a key.")
            })?;
            // A participant key must have a usable binding. Do not change provision/rotate.
            if bound
                .or(username_prefix.as_deref())
                .is_some_and(|name| name.trim().is_empty())
            {
                return Err(CliError::usage("Key username/prefix must be non-blank."));
            }
            admin_key(
                &url,
                "PUT",
                &format!("/api/admin/tenants/{tenant}/keys/{key}"),
                &token,
                Some(bind),
            )
        }
        Command::Keys => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.admin_token.as_deref(), "MSN_ADMIN_TOKEN")?;
            finish(
                &MsnClient::new(&url)?
                    .get(&format!("/api/admin/tenants/{tenant}/keys"), Some(&token))?,
            )
        }
        Command::KeyRevoke { key } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.admin_token.as_deref(), "MSN_ADMIN_TOKEN")?;
            let key = slug(&key)?;
            finish(
                &MsnClient::new(&url)?
                    .delete(&format!("/api/admin/tenants/{tenant}/keys/{key}"), &token)?,
            )
        }
        Command::Channels { archived } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            channels(&url, &tenant, &token, archived)
        }
        Command::Create { channel } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            create(&url, &tenant, &token, channel)
        }
        Command::Send {
            channel,
            text,
            json,
            key,
            reply_to,
            quote,
            correlation_id,
            to,
            labels,
            attach,
            at,
            repeat,
            until,
            tz,
            replaces,
        } => {
            let replaces = replaces.as_deref().map(parse_message_id).transpose()?;
            let later = scheduled::plan(
                at.as_deref(),
                repeat.as_deref(),
                until.as_deref(),
                tz.as_deref(),
                scheduled::now_secs(),
            )?;
            let labels = labels::parse_labels(&labels)?;
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let reply_to = reply_to
                .as_deref()
                .map(|raw| parse_int(raw, MAX_SAFE_INTEGER))
                .transpose()?;
            let quote = quote.as_deref().map(require_quote).transpose()?;
            let correlation_id = correlation_id
                .as_deref()
                .map(require_correlation_id)
                .transpose()?;
            let to = address::validate_names(&to, "--to")?;
            let payload = match (text, json) {
                (Some(text), None) => Payload {
                    text: read_text(&text)?,
                    content_type: None,
                },
                (None, Some(json)) => Payload {
                    text: read_json(&json)?,
                    content_type: Some(JSON_CONTENT_TYPE),
                },
                // clap enforces exactly one of --text / --json.
                _ => return Err(CliError::usage("Pass either --text or --json, not both.")),
            };
            // Read every file before any network call: a bad path fails without side effects.
            let files = attachments::read_files(&attach)?;
            let username =
                identity::resolve_username(&url, &tenant, &token, cli.username.as_deref())?;
            send(
                &url,
                &tenant,
                &token,
                channel,
                &username,
                &payload,
                key.as_deref(),
                Correlation {
                    reply_to,
                    quote,
                    correlation_id,
                    to,
                    replaces,
                },
                &labels,
                &files,
                &later,
            )
        }
        Command::Ask {
            channel,
            text,
            to,
            choices,
            key,
            reply_to,
            wait,
        } => {
            let choices = ask::validate_choices(&choices)?;
            let to = identity::validate_username(&to).map_err(|_| {
                CliError::usage("--to must be a non-blank username of at most 128 UTF-8 bytes.")
            })?;
            let wait = wait
                .as_deref()
                .map(|raw| parse_int(raw, 86_400))
                .transpose()?;
            if wait == Some(0) {
                return Err(CliError::usage("--wait must be 1 to 86400 seconds."));
            }
            let reply_to = reply_to.as_deref().map(parse_message_id).transpose()?;
            let text = read_text(&text)?;
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let username =
                identity::resolve_username(&url, &tenant, &token, cli.username.as_deref())?;
            let mut body = ask::question_body(&username, &text, &to, &choices);
            if let Some(reply_to) = reply_to {
                body["replyTo"] = json!(reply_to);
            }
            ask_question(
                &url,
                &tenant,
                &token,
                channel,
                &body,
                key.as_deref(),
                wait,
                stop,
            )
        }
        Command::Gather(args::GatherArgs {
            channel,
            text,
            to,
            question,
            key,
            reply_to,
            timeout,
        }) => {
            let timeout = parse_int(&timeout, 86_400)?;
            if timeout == 0 {
                return Err(CliError::usage("--timeout must be 1 to 86400 seconds."));
            }
            let question = question.as_deref().map(parse_message_id).transpose()?;
            let ask = match (question, text) {
                (Some(_), _) => None,
                (None, Some(text)) => {
                    let names = gather::validate_names(&to, "--to")?;
                    let reply_to = reply_to.as_deref().map(parse_message_id).transpose()?;
                    Some((read_text(&text)?, names, reply_to))
                }
                (None, None) => {
                    return Err(CliError::usage("Pass the question text, or --question ID."));
                }
            };
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let client = Arc::new(MsnClient::new(&url)?);
            let question = match (question, ask) {
                (Some(question), _) => question,
                (None, Some((text, names, reply_to))) => {
                    let username =
                        identity::resolve_username(&url, &tenant, &token, cli.username.as_deref())?;
                    gather::refuse_self(&names, &username, "--to")?;
                    let key = key.unwrap_or_else(|| Uuid::new_v4().to_string());
                    eprintln!("Idempotency-Key: {key}");
                    let response = client.post_json(
                        &format!("/api/tenants/{tenant}/channels/{channel}/messages"),
                        &token,
                        &[("Idempotency-Key", key.as_str())],
                        &gather::question_body(&username, &text, &names, reply_to),
                    )?;
                    classify(response.status, &response.body)?;
                    let posted: Value = serde_json::from_str(&response.body)
                        .map_err(|_| CliError::generic("Response was not JSON."))?;
                    posted["message"]["id"].as_u64().ok_or_else(|| {
                        CliError::generic("The server did not return the question's id.")
                    })?
                }
                (None, None) => unreachable!("checked above"),
            };
            gather_answers(client, &tenant, &token, channel, question, timeout, &stop)
        }
        Command::Answer {
            channel,
            message_id,
            choice,
            key,
        } => {
            let question = parse_message_id(&message_id)?;
            let choice = ask::validate_answer(&choice)?;
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let username =
                identity::resolve_username(&url, &tenant, &token, cli.username.as_deref())?;
            let key = key.unwrap_or_else(|| Uuid::new_v4().to_string());
            eprintln!("Idempotency-Key: {key}");
            finish(&MsnClient::new(&url)?.post_json(
                &format!("/api/tenants/{tenant}/channels/{channel}/messages"),
                &token,
                &[("Idempotency-Key", key.as_str())],
                &ask::answer_body(&username, question, &choice),
            )?)
        }
        Command::Scheduled { command } => scheduled_command(
            [
                cli.tenant.as_deref(),
                cli.token.as_deref(),
                cli.username.as_deref(),
            ],
            &url,
            command,
        ),
        Command::Attachment {
            channel,
            message_id,
            index,
            output,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let id = parse_int(&message_id, MAX_SAFE_INTEGER)?;
            if id == 0 {
                return Err(CliError::usage("message ID must be positive."));
            }
            let index = parse_optional_int(index.as_deref(), 0, 1000)?;
            let file =
                attachments::download(&MsnClient::new(&url)?, &tenant, &token, channel, id, index)?;
            match output.as_deref() {
                None | Some("-") => {
                    let mut stdout = io::stdout().lock();
                    stdout.write_all(&file.data)?;
                    stdout.flush()?;
                }
                Some(path) => {
                    let mut out = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(path)
                        .map_err(|error| {
                            CliError::usage(format!("Cannot create {path}: {error}"))
                        })?;
                    out.write_all(&file.data)?;
                    eprintln!(
                        "Saved {} bytes ({}) to {path}",
                        file.data.len(),
                        file.media_type
                    );
                }
            }
            Ok(())
        }
        Command::Poll {
            channel,
            thread,
            labels: filters,
            after,
            wait,
            limit,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let after = parse_optional_int(after.as_deref(), 0, MAX_SAFE_INTEGER)?;
            let wait = parse_optional_int(wait.as_deref(), 0, MAX_WAIT)?;
            let limit = parse_optional_int(limit.as_deref(), 100, MAX_LIMIT)?;
            if limit < 1 {
                return Err(CliError::usage("limit must be an integer from 1 to 100."));
            }
            labels::filter_query(&filters)?;
            let thread = parse_thread(thread.as_deref())?;
            poll(
                &url, &tenant, &token, channel, thread, after, wait, limit, &filters,
            )
        }
        Command::Receipts {
            channel,
            message_id,
        } => {
            let id = parse_message_id(&message_id)?;
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let path = receipts::message_path(&tenant, channel, id);
            finish(&MsnClient::new(&url)?.get(&path, Some(&token))?)
        }
        Command::Since {
            channel,
            after,
            format,
        } => {
            let after = after
                .as_deref()
                .map(|value| parse_int(value, MAX_SAFE_INTEGER))
                .transpose()?;
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let reader = identity::resolve_username(
                &url,
                &tenant,
                &token,
                cli.reader.as_deref().or(cli.username.as_deref()),
            )?;
            let start = match after {
                Some(after) => since::Start::Given(after),
                None => since::local_start(&url, &tenant, channel, &reader),
            };
            let value = since::fetch(&url, &tenant, &token, channel, &reader, start)?;
            if format == "text" {
                let mut stdout = std::io::stdout().lock();
                writeln!(stdout, "{}", since::render(&value))?;
                Ok(())
            } else {
                agent::print_json(&value)
            }
        }
        Command::Search {
            channel,
            text,
            from,
            kind,
            labels: filters,
            before,
            limit,
        } => {
            let before = before.as_deref().map(parse_message_id).transpose()?;
            let limit = parse_optional_int(limit.as_deref(), search::DEFAULT_LIMIT, MAX_LIMIT)?;
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let path = search::path(
                &tenant,
                channel,
                &search::Search {
                    text: text.as_deref(),
                    from: from.as_deref(),
                    kind: kind.as_deref(),
                    labels: &filters,
                    before,
                    limit,
                },
            )?;
            finish(&MsnClient::new(&url)?.get(&path, Some(&token))?)
        }
        Command::Label {
            channel,
            message_id,
            set,
            unset,
            if_equal,
            if_unset,
        } => {
            let body = labels::change_body(
                &labels::parse_labels(&set)?,
                &unset,
                &labels::parse_labels(&if_equal)?,
                &if_unset,
            )?;
            let id = parse_message_id(&message_id)?;
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            label(&url, &tenant, &token, channel, id, &body)
        }
        Command::Pin {
            channel,
            message_id,
        } => {
            let id = parse_message_id(&message_id)?;
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            set_pin(&url, &tenant, &token, channel, id, true)
        }
        Command::Unpin {
            channel,
            message_id,
        } => {
            let pin = false;
            let id = parse_message_id(&message_id)?;
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            set_pin(&url, &tenant, &token, channel, id, pin)
        }
        Command::React {
            channel,
            message_id,
            kind,
        } => react(
            [
                cli.tenant.as_deref(),
                cli.token.as_deref(),
                cli.username.as_deref(),
            ],
            &url,
            &channel,
            &message_id,
            &kind,
            false,
        ),
        Command::Edit {
            channel,
            message_id,
            text,
        } => edit(
            [
                cli.tenant.as_deref(),
                cli.token.as_deref(),
                cli.username.as_deref(),
            ],
            &url,
            &channel,
            &message_id,
            &text,
        ),
        Command::Unreact {
            channel,
            message_id,
            kind,
        } => react(
            [
                cli.tenant.as_deref(),
                cli.token.as_deref(),
                cli.username.as_deref(),
            ],
            &url,
            &channel,
            &message_id,
            &kind,
            true,
        ),
        Command::Reactions {
            channel,
            after,
            before,
        } => {
            let after = after
                .as_deref()
                .map(|raw| parse_int(raw, MAX_SAFE_INTEGER))
                .transpose()?;
            let before = before.as_deref().map(parse_message_id).transpose()?;
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            finish(&MsnClient::new(&url)?.get(
                &reactions::list_path(&tenant, channel, after, before),
                Some(&token),
            )?)
        }
        Command::Status {
            channel,
            text,
            clear,
        } => set_status(
            [
                cli.tenant.as_deref(),
                cli.token.as_deref(),
                cli.username.as_deref(),
            ],
            &url,
            &channel,
            text.as_deref(),
            clear,
        ),
        Command::Pins { channel } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            finish(&MsnClient::new(&url)?.get(
                &format!("/api/tenants/{tenant}/channels/{channel}/pins"),
                Some(&token),
            )?)
        }
        Command::WaitLabel {
            channel,
            filters,
            message,
            timeout,
        } => {
            labels::filter_query(&filters)?;
            let message = message.as_deref().map(parse_message_id).transpose()?;
            let timeout = timeout
                .as_deref()
                .map(|raw| parse_int(raw, 86_400))
                .transpose()?;
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            wait_label(
                &url, &tenant, &token, channel, &filters, message, timeout, stop,
            )
        }
        Command::Events {
            channel,
            after,
            wait,
            limit,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = channel.as_deref().map(slug).transpose()?;
            let after = parse_optional_int(after.as_deref(), 0, MAX_SAFE_INTEGER)?;
            let wait = parse_optional_int(wait.as_deref(), 0, MAX_WAIT)?;
            let limit = parse_optional_int(limit.as_deref(), 100, MAX_LIMIT)?;
            if limit < 1 {
                return Err(CliError::usage("limit must be an integer from 1 to 100."));
            }
            events(&url, &tenant, &token, channel, after, wait, limit)
        }
        Command::Watch { channel, after } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = channel.as_deref().map(slug).transpose()?;
            let after = parse_optional_int(after.as_deref(), 0, MAX_SAFE_INTEGER)?;
            watch(&url, &tenant, &token, channel, after, stop)
        }
        Command::Snapshot { command } => match command {
            SnapshotCommand::Template => unreachable!("handled before connection parsing"),
            SnapshotCommand::Publish {
                channel,
                text,
                covers_through,
                base_version,
                history_revision,
                key,
            } => {
                let tenant = require_tenant(cli.tenant.as_deref())?;
                let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
                let channel = slug(&channel)?;
                let text = read_snapshot_text(&text)?;
                let covers_through = parse_int(&covers_through, MAX_SAFE_INTEGER)?;
                let base_version = parse_int(&base_version, MAX_SAFE_INTEGER)?;
                let history_revision = parse_int(&history_revision, MAX_SAFE_INTEGER)?;
                let key = key.as_deref().map(require_idempotency_key).transpose()?;
                let username =
                    identity::resolve_username(&url, &tenant, &token, cli.username.as_deref())?;
                publish_snapshot(
                    &url,
                    &tenant,
                    &token,
                    channel,
                    &username,
                    &text,
                    covers_through,
                    base_version,
                    history_revision,
                    key,
                )
            }
            SnapshotCommand::List {
                channel,
                after,
                limit,
            } => {
                let tenant = require_tenant(cli.tenant.as_deref())?;
                let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
                let channel = slug(&channel)?;
                let after = parse_optional_int(after.as_deref(), 0, MAX_SAFE_INTEGER)?;
                let limit =
                    parse_optional_int(limit.as_deref(), DEFAULT_SNAPSHOT_LIMIT, MAX_LIMIT)?;
                require_positive_limit(limit)?;
                list_snapshots(&url, &tenant, &token, channel, after, limit)
            }
            SnapshotCommand::Show { channel, version } => {
                let tenant = require_tenant(cli.tenant.as_deref())?;
                let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
                let channel = slug(&channel)?;
                let version = parse_int(&version, MAX_SAFE_INTEGER)?;
                if version == 0 {
                    return Err(CliError::usage("version must be an integer from 1."));
                }
                show_snapshot(&url, &tenant, &token, channel, version)
            }
        },
        Command::Catchup {
            channel,
            after,
            limit,
            max_bytes,
            edits_after,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let after = after
                .as_deref()
                .map(|raw| parse_int(raw, MAX_SAFE_INTEGER))
                .transpose()?;
            let edits_after = edits_after
                .as_deref()
                .map(|raw| parse_int(raw, MAX_SAFE_INTEGER))
                .transpose()?;
            let limit = parse_optional_int(limit.as_deref(), DEFAULT_SNAPSHOT_LIMIT, MAX_LIMIT)?;
            require_positive_limit(limit)?;
            let max_bytes = parse_optional_int(
                max_bytes.as_deref(),
                DEFAULT_CATCHUP_MAX_BYTES,
                MAX_CATCHUP_MAX_BYTES,
            )?;
            if max_bytes < MIN_CATCHUP_MAX_BYTES {
                return Err(CliError::usage(
                    "max-bytes must be an integer from 1024 to 262144.",
                ));
            }
            catchup(
                &url,
                &tenant,
                &token,
                channel,
                after,
                edits_after,
                limit,
                max_bytes,
            )
        }
        Command::Export {
            channel,
            out,
            format,
            after,
            limit,
            force,
        } => {
            let channel = slug(&channel)?;
            if format == ExportFormat::Jsonl && out.is_none() {
                return Err(CliError::usage(
                    "--out is required for the jsonl archive; use --format md to print a transcript.",
                ));
            }
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let after = parse_optional_int(after.as_deref(), 0, MAX_SAFE_INTEGER)?;
            let limit = parse_optional_int(limit.as_deref(), 100, MAX_LIMIT)?;
            require_positive_limit(limit)?;
            if format == ExportFormat::Md {
                return export::export_markdown(
                    &url,
                    &tenant,
                    &token,
                    channel,
                    out.as_deref().map(Path::new),
                    after,
                    limit,
                    force,
                    &stop,
                );
            }
            let out = out.unwrap_or_default();
            export::export(
                &url,
                &tenant,
                &token,
                channel,
                cli.username.as_deref(),
                Path::new(&out),
                after,
                limit,
                force,
                &stop,
            )
        }
        Command::Import {
            file,
            channel,
            dry_run,
            trust,
            state_file,
            allow_existing,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            import::import(import::ImportRequest {
                url: &url,
                tenant: &tenant,
                token: &token,
                dest_channel: channel,
                selected_username: cli.username.as_deref(),
                archive: Path::new(&file),
                dry_run,
                trust,
                state_file: state_file.as_deref().map(Path::new),
                allow_existing,
                stop: &stop,
            })
        }
        Command::Read {
            channel,
            after,
            wait,
            limit,
            cursor_file,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let wait = parse_optional_int(wait.as_deref(), 0, MAX_WAIT)?;
            let limit = parse_optional_int(limit.as_deref(), 100, MAX_LIMIT)?;
            if limit < 1 {
                return Err(CliError::usage("limit must be an integer from 1 to 100."));
            }
            if after.is_some() && cursor_file.is_some() {
                return Err(CliError::usage(
                    "Use either --after or --cursor-file, not both.",
                ));
            }
            let reader = if after.is_none() && cursor_file.is_none() {
                Some(identity::resolve_username(
                    &url,
                    &tenant,
                    &token,
                    cli.reader.as_deref().or(cli.username.as_deref()),
                )?)
            } else {
                None
            };
            let file = match cursor_file {
                Some(path) => Some(PathBuf::from(path)),
                None if after.is_none() => {
                    let path = default_cursor_path(
                        &url,
                        &tenant,
                        reader.as_deref().expect("automatic reader"),
                        channel,
                    )?;
                    if let Some(parent) = path.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    Some(path)
                }
                None => None,
            };
            let lock = file.as_deref().map(CursorLock::acquire).transpose()?;
            let file = lock.as_ref().map(CursorLock::cursor_path);
            let cursor_after = resolve_cursor(
                &url,
                &tenant,
                channel,
                None,
                after.as_deref(),
                file,
                reader.as_deref(),
            )?;
            read_once(
                &url,
                &tenant,
                &token,
                channel,
                cursor_after,
                wait,
                limit,
                file,
                reader.as_deref(),
                &stop,
            )
        }
        Command::Wait {
            channel,
            all,
            thread,
            after,
            wait,
            limit,
            cursor_file,
        } => {
            if all {
                let tenant = require_tenant(cli.tenant.as_deref())?;
                let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
                let (wait, _) = parse_loop_bounds(wait.as_deref(), None)?;
                let name =
                    identity::resolve_username(&url, &tenant, &token, cli.username.as_deref())?;
                let reader = match cli.reader.as_deref() {
                    Some(reader) => {
                        identity::resolve_username(&url, &tenant, &token, Some(reader))?
                    }
                    None => name.clone(),
                };
                return wait_all(&url, &tenant, &token, &name, &reader, wait, &stop);
            }
            let channel =
                channel.ok_or_else(|| CliError::usage("Name a CHANNEL, or pass --all."))?;
            let thread = parse_thread(thread.as_deref())?;
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let (wait, limit) = parse_loop_bounds(wait.as_deref(), limit.as_deref())?;
            let reader = if after.is_none() && cursor_file.is_none() {
                Some(identity::resolve_username(
                    &url,
                    &tenant,
                    &token,
                    cli.reader.as_deref().or(cli.username.as_deref()),
                )?)
            } else {
                None
            };
            let file = match (&after, cursor_file) {
                (Some(_), Some(_)) => {
                    return Err(CliError::usage(
                        "Use either --after or --cursor-file, not both.",
                    ));
                }
                (Some(_), None) => None,
                (None, Some(path)) => Some(PathBuf::from(path)),
                (None, None) => {
                    // A thread keeps its own cursor beside the board's (ADR 0063).
                    let path = default_cursor_path(
                        &url,
                        &tenant,
                        reader.as_deref().expect("automatic reader"),
                        channel,
                    )?
                    .with_file_name(cursor::state_file_name(channel, thread));
                    if let Some(parent) = path.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    Some(path)
                }
            };
            // Acquire before reading and hold until all output and cursor writes are finished.
            let lock = file.as_deref().map(CursorLock::acquire).transpose()?;
            let file = lock.as_ref().map(CursorLock::cursor_path);
            let cursor_after = resolve_cursor(
                &url,
                &tenant,
                channel,
                thread,
                after.as_deref(),
                file,
                reader.as_deref(),
            )?;
            let target = LoopTarget {
                url: &url,
                tenant: &tenant,
                token: &token,
                channel,
                thread,
                wait,
                limit,
                cursor_file: file,
                reader: reader.as_deref(),
            };
            wait_for_messages(&target, cursor_after, stop)
        }
        Command::Follow {
            channel,
            thread,
            after,
            wait,
            limit,
            cursor_file,
            once,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.token.as_deref(), "MSN_WORKSPACE_TOKEN")?;
            let channel = slug(&channel)?;
            let (wait, limit) = parse_loop_bounds(wait.as_deref(), limit.as_deref())?;
            let thread = parse_thread(thread.as_deref())?;
            if after.is_some() && cursor_file.is_some() {
                return Err(CliError::usage(
                    "Use either --after or --cursor-file, not both.",
                ));
            }
            let file = cursor_file.map(PathBuf::from);
            // Acquire before reading and hold until all output and cursor writes are finished.
            let lock = file.as_deref().map(CursorLock::acquire).transpose()?;
            let file = lock.as_ref().map(CursorLock::cursor_path);
            let cursor_after =
                resolve_cursor(&url, &tenant, channel, thread, after.as_deref(), file, None)?;
            let target = LoopTarget {
                url: &url,
                tenant: &tenant,
                token: &token,
                channel,
                thread,
                wait,
                limit,
                cursor_file: file,
                reader: None,
            };
            follow(&target, cursor_after, once, stop)
        }
        Command::Provision {
            tenant,
            username_prefix,
        } => {
            let token = require_token(cli.admin_token.as_deref(), "MSN_ADMIN_TOKEN")?;
            let tenant = slug(&tenant)?;
            let bound = cli
                .username_from_flag
                .then_some(cli.username.as_deref())
                .flatten();
            let bind = binding(bound, username_prefix.as_deref(), false)?;
            admin_key(
                &url,
                "PUT",
                &format!("/api/admin/tenants/{tenant}"),
                &token,
                bind,
            )
        }
        Command::Rotate {
            tenant,
            username_prefix,
            unbind,
        } => {
            let token = require_token(cli.admin_token.as_deref(), "MSN_ADMIN_TOKEN")?;
            let tenant = slug(&tenant)?;
            let bound = cli
                .username_from_flag
                .then_some(cli.username.as_deref())
                .flatten();
            let bind = binding(bound, username_prefix.as_deref(), unbind)?;
            admin_key(
                &url,
                "POST",
                &format!("/api/admin/tenants/{tenant}/token"),
                &token,
                bind,
            )
        }
        Command::Delete {
            channel,
            message_id,
        } => {
            let tenant = require_tenant(cli.tenant.as_deref())?;
            let token = require_token(cli.admin_token.as_deref(), "MSN_ADMIN_TOKEN")?;
            let channel = slug(&channel)?;
            let id = parse_int(&message_id, MAX_SAFE_INTEGER)?;
            delete(&url, &tenant, &token, channel, id)
        }
    }
}

/// `--thread ID` (ADR 0063): a positive message id, or `None` for the whole board.
fn parse_thread(raw: Option<&str>) -> Result<Option<u64>, CliError> {
    raw.map(parse_message_id).transpose()
}

fn parse_message_id(raw: &str) -> Result<u64, CliError> {
    match parse_int(raw, MAX_SAFE_INTEGER)? {
        0 => Err(CliError::usage("Message id must be a positive integer.")),
        id => Ok(id),
    }
}

fn parse_optional_int(raw: Option<&str>, default: u64, max: u64) -> Result<u64, CliError> {
    match raw {
        None => Ok(default),
        Some(value) => parse_int(value, max),
    }
}

fn require_positive_limit(limit: u64) -> Result<(), CliError> {
    if limit < 1 {
        return Err(CliError::usage("limit must be an integer from 1 to 100."));
    }
    Ok(())
}

/// `--wait` (default 25) and `--limit` (default 100) for the long-poll loops; both must be ≥ 1.
fn parse_loop_bounds(wait: Option<&str>, limit: Option<&str>) -> Result<(u64, u64), CliError> {
    let wait = parse_optional_int(wait, 25, MAX_WAIT)?;
    let limit = parse_optional_int(limit, 100, MAX_LIMIT)?;
    if wait < 1 || limit < 1 {
        return Err(CliError::usage("limit and follow wait must be positive."));
    }
    Ok((wait, limit))
}

/// `--after` when given, else the bound cursor file's value (0 when the file is absent).
fn resolve_cursor(
    url: &Url,
    tenant: &str,
    channel: &str,
    thread: Option<u64>,
    after: Option<&str>,
    cursor_file: Option<&Path>,
    reader: Option<&str>,
) -> Result<u64, CliError> {
    let after = parse_optional_int(after, 0, MAX_SAFE_INTEGER)?;
    match cursor_file {
        Some(path) => load_cursor(
            path,
            &CursorBinding::new(url, tenant, channel, after)
                .with_reader(reader)
                .with_thread(thread),
        ),
        None => Ok(after),
    }
}

const JSON_CONTENT_TYPE: &str = "application/json";

/// A send body: `text` plus an optional payload type (omitted means text/plain on the Worker).
pub struct Payload {
    pub text: String,
    pub content_type: Option<&'static str>,
}

fn read_text(text: &str) -> Result<String, CliError> {
    if text == "-" {
        let mut buf = String::new();
        io::stdin().read_to_string(&mut buf)?;
        return require_text(&buf);
    }
    require_text(text)
}

fn read_snapshot_text(text: &str) -> Result<String, CliError> {
    let text = read_text(text)?;
    if text.len() > MAX_SNAPSHOT_TEXT_BYTES {
        return Err(CliError::usage(
            "Snapshot text must be at most 16384 UTF-8 bytes.",
        ));
    }
    Ok(text)
}

fn snapshot_template() -> Result<(), CliError> {
    const TEMPLATE: &str = "## Objective\n\n## Decisions\n\n## Open tasks\n\n## Blockers\n\n## Artifacts\n\n## Next actions\n\n## Unresolved\n\n## Evidence\n";
    print!("{TEMPLATE}");
    io::stdout()
        .flush()
        .map_err(|error| CliError::generic(error.to_string()))
}

/// Validates `--json` locally (UTF-8, then JSON) so an invalid payload never reaches the Worker.
fn read_json(json: &str) -> Result<String, CliError> {
    let raw = if json == "-" {
        let mut bytes = Vec::new();
        io::stdin().read_to_end(&mut bytes)?;
        String::from_utf8(bytes).map_err(|_| CliError::usage("--json must be valid UTF-8 JSON."))?
    } else {
        json.to_string()
    };
    validate_json(&raw)?;
    Ok(raw)
}

fn validate_json(raw: &str) -> Result<(), CliError> {
    serde_json::from_str::<Value>(raw)
        .map(|_| ())
        .map_err(|_| CliError::usage("--json must be valid UTF-8 JSON."))
}

fn health(url: &Url) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    finish(&client.get("/api/health", None)?)
}

fn channels(url: &Url, tenant: &str, token: &str, archived: bool) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    let include = if archived { "&include=archived" } else { "" };
    let path = format!("/api/tenants/{tenant}/channels?limit={CHANNELS_PAGE_LIMIT}{include}");
    finish(&client.get(&path, Some(token))?)
}

fn create(url: &Url, tenant: &str, token: &str, channel: &str) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    finish(&client.put(&format!("/api/tenants/{tenant}/channels/{channel}"), token)?)
}

/// Optional message annotations for `send`; `None` leaves the field out of the JSON body entirely.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Correlation {
    pub reply_to: Option<u64>,
    /// The part of the `reply_to` message this reply quotes (ADR 0059); needs `reply_to`.
    pub quote: Option<String>,
    pub correlation_id: Option<String>,
    /// The names the message is addressed to (ADR 0067); empty for everyone.
    pub to: Vec<String>,
    /// The sender's earlier message this one replaces (ADR 0068); the old one then carries
    /// `replacedBy`.
    pub replaces: Option<u64>,
}

/// The POST body for a send. Unset annotation fields are omitted, so a plain send is byte-for-byte
/// what older CLIs produced and idempotency replays keep matching.
pub fn send_body(username: &str, payload: &Payload, correlation: &Correlation) -> Value {
    send_body_with(username, payload, correlation, &[])
}

/// `send_body` plus the uploaded `attachments` list; an empty list leaves the field out.
pub fn send_body_with(
    username: &str,
    payload: &Payload,
    correlation: &Correlation,
    attachments: &[Value],
) -> Value {
    let mut body = json!({ "username": username, "text": payload.text });
    if let Some(content_type) = payload.content_type {
        body["contentType"] = Value::String(content_type.to_string());
    }
    if let Some(reply_to) = correlation.reply_to {
        body["replyTo"] = json!(reply_to);
    }
    if let Some(quote) = &correlation.quote {
        body["quote"] = json!(quote);
    }
    if let Some(correlation_id) = &correlation.correlation_id {
        body["correlationId"] = json!(correlation_id);
    }
    if let Some(to) = address::to_field(&correlation.to) {
        body["to"] = to;
    }
    if let Some(replaces) = correlation.replaces {
        body["replaces"] = json!(replaces);
    }
    if !attachments.is_empty() {
        body["attachments"] = json!(attachments);
    }
    body
}

/// Adds `labels` to a send body only when there are some, so unlabeled sends keep their bytes.
pub fn with_labels(body: &mut Value, labels: &labels::Labels) {
    if !labels.is_empty() {
        body["labels"] = json!(labels);
    }
}

#[allow(clippy::too_many_arguments)]
fn send(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    username: &str,
    payload: &Payload,
    key: Option<&str>,
    correlation: Correlation,
    labels: &labels::Labels,
    files: &[attachments::LocalFile],
    later: &scheduled::Later,
) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    let key = key
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    eprintln!("Idempotency-Key: {key}");
    // A delay like 10m resolves once (ADR 0060); a retry passes this absolute time with the key.
    if let Some(send_at) = &later.send_at {
        eprintln!("sendAt: {send_at}");
    }
    // The zone was not given (ADR 0072): say which one the times are read in.
    if let Some(zone) = &later.guessed_zone {
        eprintln!(
            "timeZone: {zone} (this computer's zone, or UTC when it is not known; set --tz to choose)"
        );
    }
    let _ = io::stderr().flush();
    // Uploads are content-addressed, so a retry with the same files and key replays one message.
    let uploaded = attachments::upload(&client, tenant, token, channel, files)?;
    let mut body = send_body_with(username, payload, &correlation, &uploaded);
    with_labels(&mut body, labels);
    later.apply(&mut body);
    let response = client.post_json(
        &format!("/api/tenants/{tenant}/channels/{channel}/messages"),
        token,
        &[("Idempotency-Key", key.as_str())],
        &body,
    )?;
    finish(&response)
}

#[allow(clippy::too_many_arguments)]
fn poll(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    thread: Option<u64>,
    after: u64,
    wait: u64,
    limit: u64,
    filters: &[String],
) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    let path = format!(
        "/api/tenants/{tenant}/channels/{channel}/messages?after={after}&wait={wait}&limit={limit}{}{}",
        processing::thread_query(thread),
        labels::filter_query(filters)?
    );
    finish(&client.get(&path, Some(token))?)
}

fn label(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    id: u64,
    body: &Value,
) -> Result<(), CliError> {
    let response = MsnClient::new(url)?.post_json(
        &format!("/api/tenants/{tenant}/channels/{channel}/messages/{id}/labels"),
        token,
        &[],
        body,
    )?;
    if let Some(message) = labels::conflict_message(response.status, &response.body) {
        return Err(CliError::conflict(message));
    }
    finish(&response)
}

/// Replaces the text of a message the caller sent (ADR 0052). Prints `{message, changed}`.
/// `who` is the global `--tenant`, `--token` and `--username` options.
fn edit(
    who: [Option<&str>; 3],
    url: &Url,
    channel: &str,
    message_id: &str,
    text: &str,
) -> Result<(), CliError> {
    let id = parse_message_id(message_id)?;
    let text = read_text(text)?;
    let [tenant, token, username] = who;
    let tenant = require_tenant(tenant)?;
    let token = require_token(token, "MSN_WORKSPACE_TOKEN")?;
    let channel = slug(channel)?;
    let username = identity::resolve_username(url, &tenant, &token, username)?;
    finish(&MsnClient::new(url)?.send_optional_json(
        "PATCH",
        &format!("/api/tenants/{tenant}/channels/{channel}/messages/{id}"),
        &token,
        Some(&json!({ "username": username, "text": text })),
    )?)
}

/// `msn scheduled list|change|cancel` (ADR 0060). `who` is the global `--tenant`, `--token` and
/// `--username` options; change and cancel act as this key's name, or `--username` when unbound.
fn scheduled_command(
    who: [Option<&str>; 3],
    url: &Url,
    command: ScheduledCommand,
) -> Result<(), CliError> {
    let [tenant, token, username] = who;
    let tenant = require_tenant(tenant)?;
    let token = require_token(token, "MSN_WORKSPACE_TOKEN")?;
    let client = MsnClient::new(url)?;
    match command {
        ScheduledCommand::List { channel } => {
            let channel = slug(&channel)?;
            finish(&client.get(
                &format!("/api/tenants/{tenant}/channels/{channel}/scheduled"),
                Some(&token),
            )?)
        }
        ScheduledCommand::Change {
            channel,
            id,
            text,
            at,
        } => {
            let channel = slug(&channel)?;
            let id = parse_message_id(&id)?;
            if text.is_none() && at.is_none() {
                return Err(CliError::usage("Pass --text, --at or both."));
            }
            let mut body = json!({});
            if let Some(text) = text {
                body["text"] = json!(read_text(&text)?);
            }
            if let Some(at) = at {
                body["sendAt"] = json!(scheduled::parse_when(&at, scheduled::now_secs())?);
            }
            body["username"] = json!(identity::resolve_username(url, &tenant, &token, username)?);
            finish(&client.send_optional_json(
                "PATCH",
                &format!("/api/tenants/{tenant}/channels/{channel}/scheduled/{id}"),
                &token,
                Some(&body),
            )?)
        }
        ScheduledCommand::Cancel { channel, id } => {
            let channel = slug(&channel)?;
            let id = parse_message_id(&id)?;
            let username = identity::resolve_username(url, &tenant, &token, username)?;
            let mut path = Url::parse("http://x/").expect("static url");
            path.query_pairs_mut().append_pair("username", &username);
            finish(&client.delete(
                &format!(
                    "/api/tenants/{tenant}/channels/{channel}/scheduled/{id}?{}",
                    path.query().unwrap_or_default()
                ),
                &token,
            )?)
        }
    }
}

/// Adds or removes one reaction (ADR 0047) as this key's name, or `--username` when unbound.
/// Both directions are idempotent; the result says whether anything `changed`.
/// `who` is the global `--tenant`, `--token` and `--username` options.
fn react(
    who: [Option<&str>; 3],
    url: &Url,
    channel: &str,
    message_id: &str,
    kind: &str,
    remove: bool,
) -> Result<(), CliError> {
    let kind = reactions::parse_kind(kind)?;
    let id = parse_message_id(message_id)?;
    let [tenant, token, username] = who;
    let tenant = require_tenant(tenant)?;
    let token = require_token(token, "MSN_WORKSPACE_TOKEN")?;
    let channel = slug(channel)?;
    let username = identity::resolve_username(url, &tenant, &token, username)?;
    finish(&MsnClient::new(url)?.post_json(
        &format!("/api/tenants/{tenant}/channels/{channel}/messages/{id}/reactions"),
        &token,
        &[],
        &reactions::body(&username, kind, remove),
    )?)
}

/// Sets, clears or lists agent status (ADR 0064). Setting and clearing act as this key's name,
/// or `--username` when unbound; with neither text nor `--clear` it lists the board's statuses.
fn set_status(
    who: [Option<&str>; 3],
    url: &Url,
    channel: &str,
    text: Option<&str>,
    clear: bool,
) -> Result<(), CliError> {
    let [tenant, token, username] = who;
    let tenant = require_tenant(tenant)?;
    let token = require_token(token, "MSN_WORKSPACE_TOKEN")?;
    let channel = slug(channel)?;
    let client = MsnClient::new(url)?;
    if text.is_none() && !clear {
        return finish(&client.get(&status::list_path(&tenant, channel), Some(&token))?);
    }
    let text = text.map(status::parse_text).transpose()?;
    let username = identity::resolve_username(url, &tenant, &token, username)?;
    finish(&client.send_optional_json(
        "PUT",
        &status::set_path(&tenant, channel),
        &token,
        Some(&status::body(&username, text.as_deref())),
    )?)
}

/// Pins or unpins one message (ADR 0038). Unpin prints a small JSON result instead of 204's
/// generic `deleted`, so scripts can tell the two apart.
fn set_pin(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    id: u64,
    pin: bool,
) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    let path = format!("/api/tenants/{tenant}/channels/{channel}/pins/{id}");
    if pin {
        return finish(&client.put(&path, token)?);
    }
    let response = client.delete(&path, token)?;
    classify(response.status, &response.body)?;
    agent::print_json(&json!({ "unpinned": true, "channel": channel, "id": id }))
}

/// Long-polls a label filter until a message matches, `timeout` passes or a signal stops it.
/// Transient failures retry with the same backoff as `msn follow`.
#[allow(clippy::too_many_arguments)]
fn wait_label(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    filters: &[String],
    message: Option<u64>,
    timeout: Option<u64>,
    stop: Arc<AtomicBool>,
) -> Result<(), CliError> {
    labels::wait_path(tenant, channel, filters, message, 0)?;
    let client = Arc::new(MsnClient::new(url)?);
    let deadline = timeout.map(|seconds| std::time::Instant::now() + Duration::from_secs(seconds));
    let mut backoff = BACKOFF_START_MS;
    loop {
        // Round the remaining time up, so the last poll still waits instead of spinning at wait=0.
        let wait = match deadline {
            Some(deadline) => {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                (left.as_secs() + u64::from(left.subsec_nanos() > 0)).min(MAX_WAIT)
            }
            None => MAX_WAIT,
        };
        let path = labels::wait_path(tenant, channel, filters, message, wait)?;
        let Some(result) = get_interruptible(client.clone(), path, token.to_string(), &stop)?
        else {
            return Err(CliError::generic("Interrupted before the label appeared."));
        };
        match result {
            Ok(response) if (200..300).contains(&response.status) => {
                backoff = BACKOFF_START_MS;
                if let Some(found) = labels::first_match(&response.body)? {
                    println!("{found}");
                    return io::stdout()
                        .flush()
                        .map_err(|error| CliError::generic(error.to_string()));
                }
            }
            Ok(response) if !is_retryable_status(response.status) => {
                return Err(status_error(response.status, &response.body));
            }
            Ok(_) | Err(CliError::Network(_)) => {
                if interruptible_sleep(backoff, &stop, "Label wait failed; retrying", 0) {
                    return Err(CliError::generic("Interrupted before the label appeared."));
                }
                backoff = (backoff * 2).min(BACKOFF_MAX_MS);
            }
            Err(error) => return Err(error),
        }
        if deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
            return Err(CliError::generic(format!(
                "Timed out after {}s; no message has {}.",
                timeout.unwrap_or(0),
                filters.join(" ")
            )));
        }
    }
}

/// Posts a question (ADR 0065). Without `wait`, prints the posted message like `msn send`. With
/// it, prints the answer as JSON once the addressed name taps a choice, or exits 2 on timeout.
#[allow(clippy::too_many_arguments)]
fn ask_question(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    body: &Value,
    key: Option<&str>,
    wait: Option<u64>,
    stop: Arc<AtomicBool>,
) -> Result<(), CliError> {
    let client = Arc::new(MsnClient::new(url)?);
    let key = key
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    eprintln!("Idempotency-Key: {key}");
    let _ = io::stderr().flush();
    let response = client.post_json(
        &format!("/api/tenants/{tenant}/channels/{channel}/messages"),
        token,
        &[("Idempotency-Key", key.as_str())],
        body,
    )?;
    let Some(timeout) = wait else {
        return finish(&response);
    };
    classify(response.status, &response.body)?;
    let posted: Value = serde_json::from_str(&response.body)
        .map_err(|_| CliError::generic("Response was not JSON."))?;
    let question = posted["message"]["id"]
        .as_u64()
        .ok_or_else(|| CliError::generic("The server did not return the question's id."))?;
    eprintln!("Asked as message {question}; waiting up to {timeout}s for the answer.");
    let _ = io::stderr().flush();
    // A retried ask (same key) may replay a question that was answered already.
    if let Some(found) = ask::recorded_answer(&posted["message"]) {
        return agent::print_json(&found);
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout);
    let mut after = question;
    let mut backoff = BACKOFF_START_MS;
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            agent::print_json(&json!({ "question": question, "answered": false }))?;
            return Err(CliError::timeout(format!(
                "Timed out after {timeout}s; nobody answered message {question}."
            )));
        }
        // Round the remaining time up, so the last poll still waits instead of spinning at wait=0.
        let wait = (left.as_secs() + u64::from(left.subsec_nanos() > 0)).min(MAX_WAIT);
        let path = format!(
            "/api/tenants/{tenant}/channels/{channel}/messages?thread={question}&after={after}&wait={wait}&limit=100"
        );
        let Some(result) = get_interruptible(client.clone(), path, token.to_string(), &stop)?
        else {
            return Err(CliError::generic("Interrupted before the answer arrived."));
        };
        match result {
            Ok(response) if (200..300).contains(&response.status) => {
                backoff = BACKOFF_START_MS;
                let page: Value = serde_json::from_str(&response.body)
                    .map_err(|_| CliError::generic("Response was not JSON."))?;
                if let Some(found) = ask::find_answer(&page, question) {
                    return agent::print_json(&found);
                }
                after = ask::next_cursor(&page, after);
            }
            Ok(response) if !is_retryable_status(response.status) => {
                return Err(status_error(response.status, &response.body));
            }
            Ok(_) | Err(CliError::Network(_)) => {
                if interruptible_sleep(backoff, &stop, "Answer wait failed; retrying", 0) {
                    return Err(CliError::generic("Interrupted before the answer arrived."));
                }
                backoff = (backoff * 2).min(BACKOFF_MAX_MS);
            }
            Err(error) => return Err(error),
        }
    }
}

/// Waits for every name a question is addressed to, then prints the gathered answers (ADR 0071).
/// Prints what it has on timeout or interrupt too, so no answer that was posted is lost.
fn gather_answers(
    client: Arc<MsnClient>,
    tenant: &str,
    token: &str,
    channel: &str,
    question: u64,
    timeout: u64,
    stop: &AtomicBool,
) -> Result<(), CliError> {
    const INTERRUPTED: &str = "Interrupted before every answer arrived.";
    let deadline = gather::deadline_in(timeout);
    // Retries a failed read only until the deadline, then gives up as a timeout (exit 2).
    let mut get = |path: &str| -> Result<Value, CliError> {
        let mut backoff = BACKOFF_START_MS;
        loop {
            let Some(result) =
                get_interruptible(client.clone(), path.to_string(), token.to_string(), stop)?
            else {
                return Err(CliError::generic(INTERRUPTED));
            };
            match result {
                Ok(response) if (200..300).contains(&response.status) => {
                    return serde_json::from_str(&response.body)
                        .map_err(|_| CliError::generic("Response was not JSON."));
                }
                Ok(response) if !is_retryable_status(response.status) => {
                    return Err(status_error(response.status, &response.body));
                }
                Ok(_) | Err(CliError::Network(_)) => {
                    if std::time::Instant::now() + Duration::from_millis(backoff) >= deadline {
                        return Err(CliError::timeout(format!(
                            "Timed out after {timeout}s; the server could not be read."
                        )));
                    }
                    if interruptible_sleep(backoff, stop, "Gather read failed; retrying", 0) {
                        return Err(CliError::generic(INTERRUPTED));
                    }
                    backoff = (backoff * 2).min(BACKOFF_MAX_MS);
                }
                Err(error) => return Err(error),
            }
        }
    };
    let mut gathered = gather::start(&mut get, tenant, channel, question)?;
    eprintln!(
        "Gathering answers to message {question} from {}; waiting up to {timeout}s.",
        gathered.pending().join(", ")
    );
    let _ = io::stderr().flush();
    let waited = gather::wait(&mut get, &mut gathered, tenant, channel, deadline);
    // Printed in every case, so no answer that was posted is lost.
    agent::print_json(&gathered.result())?;
    waited?;
    if let Some(new) = gathered.replaced_by() {
        return Err(CliError::generic(format!(
            "Message {question} was replaced by message {new}; gather answers to it with --question {new}."
        )));
    }
    let pending = gathered.pending();
    if !pending.is_empty() {
        return Err(CliError::timeout(format!(
            "Timed out after {timeout}s; no reply yet from {}.",
            pending.join(", ")
        )));
    }
    Ok(())
}

fn events_path(tenant: &str, channel: Option<&str>, after: u64, wait: u64, limit: u64) -> String {
    let channel_param = channel
        .map(|value| format!("&channel={value}"))
        .unwrap_or_default();
    format!("/api/tenants/{tenant}/events?after={after}&wait={wait}&limit={limit}{channel_param}")
}

fn events(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: Option<&str>,
    after: u64,
    wait: u64,
    limit: u64,
) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    let path = events_path(tenant, channel, after, wait, limit);
    let response = client.get(&path, Some(token))?;
    classify(response.status, &response.body)?;
    // Fail closed: an unrecognized or malformed event page is rejected, never passed through.
    events::validate_events_page(&response.body, tenant, channel, after, limit)?;
    print_success(response.status, &response.body)
}

const WATCH_WAIT_SECONDS: u64 = 25;
const WATCH_PAGE_LIMIT: u64 = 100;

/// Long-poll reconnect loop over the event journal. Never writes a cursor file and never
/// acknowledges processing: it only prints what the server durably recorded.
fn watch(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: Option<&str>,
    after: u64,
    stop: Arc<AtomicBool>,
) -> Result<(), CliError> {
    let client = Arc::new(MsnClient::new(url)?);
    let mut after = after;
    let mut backoff_ms = BACKOFF_START_MS;
    while !stop.load(Ordering::SeqCst) {
        let path = events_path(tenant, channel, after, WATCH_WAIT_SECONDS, WATCH_PAGE_LIMIT);
        let Some(response) =
            get_interruptible(Arc::clone(&client), path, token.to_string(), &stop)?
        else {
            return Ok(());
        };
        match response {
            Ok(response) if (200..300).contains(&response.status) => {
                let (raw_events, next_cursor) = events::validate_events_page(
                    &response.body,
                    tenant,
                    channel,
                    after,
                    WATCH_PAGE_LIMIT,
                )?;
                for event in &raw_events {
                    writeln!(
                        io::stdout().lock(),
                        "{}",
                        serde_json::to_string(event)
                            .map_err(|e| CliError::generic(e.to_string()))?
                    )?;
                }
                io::stdout()
                    .flush()
                    .map_err(|error| CliError::generic(error.to_string()))?;
                if !raw_events.is_empty() {
                    after = next_cursor;
                }
                backoff_ms = BACKOFF_START_MS;
            }
            Ok(response) if (300..400).contains(&response.status) => {
                return Err(CliError::network("Redirects are not allowed"));
            }
            Ok(response) if is_retryable_status(response.status) => {
                let message = error_message(response.status, &response.body);
                if interruptible_sleep(backoff_ms, &stop, &message, after) {
                    return Ok(());
                }
                backoff_ms = (backoff_ms.saturating_mul(2)).min(BACKOFF_MAX_MS);
            }
            Ok(response) => return Err(status_error(response.status, &response.body)),
            Err(error) => {
                // MsnClient maps transport failures to exit 6; retry those.
                if interruptible_sleep(backoff_ms, &stop, &error.to_string(), after) {
                    return Ok(());
                }
                backoff_ms = (backoff_ms.saturating_mul(2)).min(BACKOFF_MAX_MS);
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn publish_snapshot(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    username: &str,
    text: &str,
    covers_through: u64,
    base_version: u64,
    history_revision: u64,
    key: Option<&str>,
) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    let key = key
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    eprintln!("Idempotency-Key: {key}");
    let _ = io::stderr().flush();
    let body = json!({
        "username": username,
        "text": text,
        "coversThrough": covers_through,
        "baseVersion": base_version,
        "historyRevision": history_revision,
    });
    finish(&client.post_json(
        &format!("/api/tenants/{tenant}/channels/{channel}/snapshots"),
        token,
        &[("Idempotency-Key", key.as_str())],
        &body,
    )?)
}

fn list_snapshots(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    after: u64,
    limit: u64,
) -> Result<(), CliError> {
    finish(&MsnClient::new(url)?.get(
        &format!("/api/tenants/{tenant}/channels/{channel}/snapshots?after={after}&limit={limit}"),
        Some(token),
    )?)
}

fn show_snapshot(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    version: u64,
) -> Result<(), CliError> {
    finish(&MsnClient::new(url)?.get(
        &format!("/api/tenants/{tenant}/channels/{channel}/snapshots/{version}"),
        Some(token),
    )?)
}

#[allow(clippy::too_many_arguments)]
fn catchup(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    after: Option<u64>,
    edits_after: Option<u64>,
    limit: u64,
    max_bytes: u64,
) -> Result<(), CliError> {
    let continuation = agent::catchup_query(after, edits_after.map(Some));
    finish(&MsnClient::new(url)?.get(
        &format!(
            "/api/tenants/{tenant}/channels/{channel}/catchup?limit={limit}&maxBytes={max_bytes}{continuation}"
        ),
        Some(token),
    )?)
}

#[allow(clippy::too_many_arguments)]
fn read_once(
    url: &Url,
    tenant: &str,
    token: &str,
    channel: &str,
    after: u64,
    wait: u64,
    limit: u64,
    cursor_file: Option<&Path>,
    reader: Option<&str>,
    stop: &AtomicBool,
) -> Result<(), CliError> {
    let client = Arc::new(MsnClient::new(url)?);
    let path = format!(
        "/api/tenants/{tenant}/channels/{channel}/messages?after={after}&wait={wait}&limit={limit}"
    );
    let Some(response) = get_interruptible(client, path, token.to_string(), stop)? else {
        return Ok(());
    };
    let response = response?;
    classify(response.status, &response.body)?;
    let (messages, next_cursor) = parse_page(&response.body)?;
    writeln!(io::stdout().lock(), "{}", response.body.trim())?;
    io::stdout()
        .flush()
        .map_err(|error| CliError::generic(error.to_string()))?;
    if !messages.is_empty() {
        if let Some(path) = cursor_file {
            write_cursor(
                path,
                &CursorBinding::new(url, tenant, channel, next_cursor.unwrap_or(after))
                    .with_reader(reader),
            )?;
        }
    }
    Ok(())
}

/// Body for provision/rotate: `None` leaves the bind alone (provision: unbound; rotate: kept).
fn binding(
    username: Option<&str>,
    prefix: Option<&str>,
    unbind: bool,
) -> Result<Option<Value>, CliError> {
    let chosen = [username.is_some(), prefix.is_some(), unbind]
        .iter()
        .filter(|set| **set)
        .count();
    if chosen > 1 {
        return Err(CliError::usage(
            "Use only one of --username, --username-prefix or --unbind.",
        ));
    }
    if let Some(name) = username {
        return Ok(Some(json!({ "username": name })));
    }
    if let Some(prefix) = prefix {
        return Ok(Some(json!({ "usernamePrefix": prefix })));
    }
    if unbind {
        return Ok(Some(json!({ "username": null })));
    }
    Ok(None)
}

fn admin_key(
    url: &Url,
    method: &str,
    path: &str,
    token: &str,
    bind: Option<Value>,
) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    finish(&client.send_optional_json(method, path, token, bind.as_ref())?)
}

fn delete(url: &Url, tenant: &str, token: &str, channel: &str, id: u64) -> Result<(), CliError> {
    let client = MsnClient::new(url)?;
    finish(&client.delete(
        &format!("/api/admin/tenants/{tenant}/channels/{channel}/messages/{id}"),
        token,
    )?)
}

fn finish(response: &client::RawResponse) -> Result<(), CliError> {
    classify(response.status, &response.body)?;
    print_success(response.status, &response.body)
}

/// Everything a long-poll loop needs besides the moving cursor.
struct LoopTarget<'a> {
    url: &'a Url,
    tenant: &'a str,
    token: &'a str,
    channel: &'a str,
    /// Only this thread (ADR 0063); its cursor file is bound to it.
    thread: Option<u64>,
    wait: u64,
    limit: u64,
    cursor_file: Option<&'a Path>,
    reader: Option<&'a str>,
}

/// A successfully fetched, validated `{messages,nextCursor,hasMore}` page.
struct Page<'a> {
    raw: &'a str,
    messages: &'a [Value],
    next_cursor: u64,
}

enum Flow {
    Continue,
    Stop,
}

fn follow(
    target: &LoopTarget<'_>,
    after: u64,
    once: bool,
    stop: Arc<AtomicBool>,
) -> Result<(), CliError> {
    poll_loop(target, after, stop, |page| {
        for message in page.messages {
            writeln!(
                io::stdout().lock(),
                "{}",
                serde_json::to_string(message).map_err(|e| CliError::generic(e.to_string()))?
            )?;
            io::stdout()
                .flush()
                .map_err(|error| CliError::generic(error.to_string()))?;
        }
        if once && !page.messages.is_empty() {
            Ok(Flow::Stop)
        } else {
            Ok(Flow::Continue)
        }
    })
}

/// `msn wait --all` (ADR 0069): blocks until a message addressed to `name` arrives on any board
/// the key can read, prints `{channel, message, messages, nextCursor}` and moves that board's
/// reader cursor to the message, exactly as `msn wait CHANNEL` would have after printing
/// `messages`. Other boards' cursors do not move.
fn wait_all(
    url: &Url,
    tenant: &str,
    token: &str,
    name: &str,
    reader: &str,
    poll: u64,
    stop: &AtomicBool,
) -> Result<(), CliError> {
    let client = Arc::new(MsnClient::new(url)?);
    let boards = watch::Boards::new(client, tenant, token, stop);
    let cursor_path = |channel: &str| default_cursor_path(url, tenant, reader, channel);
    let load = |channel: &str| -> Result<u64, CliError> {
        load_cursor(
            &cursor_path(channel)?,
            &CursorBinding::new(url, tenant, channel, 0).with_reader(Some(reader)),
        )
    };
    let mut memo = watch::Memo::default();
    loop {
        let mut progress = |channel: &str| load(channel);
        let Some(hit) =
            watch::first_addressed(&boards, name, &mut progress, &mut memo, poll, None)?
        else {
            return Ok(());
        };
        let path = cursor_path(&hit.channel)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        // Hold the board's cursor while printing and writing, as `msn wait CHANNEL` does.
        let lock = CursorLock::acquire(&path)?;
        let after = load(&hit.channel)?;
        let message = if after == hit.progress {
            Some(hit.message)
        } else {
            // Someone read the board meanwhile: look again from where they stopped.
            match boards.scan(&hit.channel, after, name)? {
                Some(watch::Scan::Found(message)) => Some(message),
                Some(_) => None,
                None => return Ok(()),
            }
        };
        let Some(message) = message else {
            continue;
        };
        let id = message["id"]
            .as_u64()
            .ok_or_else(|| CliError::generic("Message has no id."))?;
        let Some(messages) = boards.through(&hit.channel, after, id)? else {
            return Ok(());
        };
        let printed = json!({
            "channel": hit.channel,
            "message": message,
            "messages": messages,
            "nextCursor": id,
        });
        writeln!(io::stdout().lock(), "{printed}")?;
        io::stdout()
            .flush()
            .map_err(|error| CliError::generic(error.to_string()))?;
        write_cursor(
            lock.cursor_path(),
            &CursorBinding::new(url, tenant, &hit.channel, id).with_reader(Some(reader)),
        )?;
        return Ok(());
    }
}

fn wait_for_messages(
    target: &LoopTarget<'_>,
    after: u64,
    stop: Arc<AtomicBool>,
) -> Result<(), CliError> {
    poll_loop(target, after, stop, |page| {
        if page.messages.is_empty() {
            return Ok(Flow::Continue);
        }
        writeln!(io::stdout().lock(), "{}", page.raw)?;
        io::stdout()
            .flush()
            .map_err(|error| CliError::generic(error.to_string()))?;
        Ok(Flow::Stop)
    })
}

/// GET pages from `after` until `on_page` says stop or a signal flips `stop`. Each 2xx page is
/// delivered to `on_page` first and only then persisted to the cursor file, so an interrupt can
/// replay a page but never skips one. 429/5xx/transport errors retry with 1s→15s backoff.
fn poll_loop(
    target: &LoopTarget<'_>,
    mut after: u64,
    stop: Arc<AtomicBool>,
    mut on_page: impl FnMut(&Page<'_>) -> Result<Flow, CliError>,
) -> Result<(), CliError> {
    let LoopTarget {
        url,
        tenant,
        token,
        channel,
        thread,
        wait,
        limit,
        cursor_file,
        reader,
    } = *target;
    let client = Arc::new(MsnClient::new(url)?);
    let mut backoff_ms = BACKOFF_START_MS;
    while !stop.load(Ordering::SeqCst) {
        let path = format!(
            "/api/tenants/{tenant}/channels/{channel}/messages?after={after}&wait={wait}&limit={limit}{}",
            processing::thread_query(thread)
        );
        let Some(response) =
            get_interruptible(Arc::clone(&client), path, token.to_string(), &stop)?
        else {
            return Ok(());
        };
        match response {
            Ok(response) if (200..300).contains(&response.status) => {
                let parsed = parse_page(&response.body)?;
                // An archived board (ADR 0046) gets no new messages: stop instead of polling forever.
                if parsed.0.is_empty() && page_archived(&response.body) {
                    return Err(archived_error(channel));
                }
                let page = Page {
                    raw: response.body.trim(),
                    messages: &parsed.0,
                    next_cursor: parsed.1.unwrap_or(after),
                };
                let flow = on_page(&page)?;
                if stop.load(Ordering::SeqCst) {
                    return Ok(());
                }
                // An empty page prints nothing. Do not acknowledge its cursor implicitly.
                if !page.messages.is_empty() {
                    after = page.next_cursor;
                    if let Some(path) = cursor_file {
                        write_cursor(
                            path,
                            &CursorBinding::new(url, tenant, channel, after)
                                .with_reader(reader)
                                .with_thread(thread),
                        )?;
                    }
                }
                if matches!(flow, Flow::Stop) {
                    return Ok(());
                }
                backoff_ms = BACKOFF_START_MS;
            }
            Ok(response) if (300..400).contains(&response.status) => {
                return Err(CliError::network("Redirects are not allowed"));
            }
            Ok(response) if is_retryable_status(response.status) => {
                let message = error_message(response.status, &response.body);
                if interruptible_sleep(backoff_ms, &stop, &message, after) {
                    return Ok(());
                }
                backoff_ms = (backoff_ms.saturating_mul(2)).min(BACKOFF_MAX_MS);
            }
            Ok(response) => return Err(status_error(response.status, &response.body)),
            Err(error) => {
                // MsnClient maps transport failures to exit 6; retry those.
                if interruptible_sleep(backoff_ms, &stop, &error.to_string(), after) {
                    return Ok(());
                }
                backoff_ms = (backoff_ms.saturating_mul(2)).min(BACKOFF_MAX_MS);
            }
        }
    }
    Ok(())
}

/// True when a page says its board is archived (ADR 0046); absent on active boards.
pub fn page_archived(body: &str) -> bool {
    serde_json::from_str::<Value>(body.trim())
        .is_ok_and(|page| page.get("archived").and_then(Value::as_bool) == Some(true))
}

/// Exit 5 (conflict): a waiting reader stops; the board cannot get new messages until unarchived.
pub fn archived_error(channel: &str) -> CliError {
    CliError::conflict(format!(
        "board_archived: Board {channel} is archived and read-only, so no new messages will arrive. Stop waiting; the board owner can run msn board unarchive {channel}."
    ))
}

/// Validates a messages page and returns its rows plus `nextCursor` (absent → `None`).
fn parse_page(body: &str) -> Result<(Vec<Value>, Option<u64>), CliError> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(CliError::generic("Empty response body"));
    }
    let mut page: Value =
        serde_json::from_str(trimmed).map_err(|_| CliError::generic("Response was not JSON"))?;
    let next_cursor = match page.get("nextCursor") {
        Some(Value::String(s)) => Some(parse_int(s, MAX_SAFE_INTEGER)?),
        Some(other) => other.as_u64(),
        None => None,
    };
    let messages = match page.get_mut("messages").map(Value::take) {
        Some(Value::Array(messages)) => messages,
        _ => return Err(CliError::generic("Response was not JSON")),
    };
    Ok((messages, next_cursor))
}

fn interruptible_sleep(backoff_ms: u64, stop: &AtomicBool, message: &str, after: u64) -> bool {
    eprintln!("{message}; reconnecting from cursor {after}");
    let _ = io::stderr().flush();
    let total = Duration::from_millis(backoff_ms);
    let start = std::time::Instant::now();
    while start.elapsed() < total {
        if stop.load(Ordering::SeqCst) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    stop.load(Ordering::SeqCst)
}

/// Only the HTTP exchange runs in the background: it cannot print or mutate cursors.
/// Cancellation returns through the owning stack so cursor lock guards always drop.
fn get_interruptible(
    client: Arc<MsnClient>,
    path: String,
    token: String,
    stop: &AtomicBool,
) -> Result<Option<Result<client::RawResponse, CliError>>, CliError> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    thread::Builder::new()
        .name("msn-poll".into())
        .spawn(move || {
            let _ = tx.send(client.get(&path, Some(&token)));
        })?;
    loop {
        if stop.load(Ordering::SeqCst) {
            return Ok(None);
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(response) => return Ok((!stop.load(Ordering::SeqCst)).then_some(response)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(CliError::generic("Polling worker stopped unexpectedly."));
            }
        }
    }
}

pub fn install_stop_signals() -> Result<Arc<AtomicBool>, CliError> {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    ctrlc::set_handler(move || {
        flag.store(true, Ordering::SeqCst);
    })
    .map_err(|error| CliError::generic(format!("Cannot install stop signal handler: {error}")))?;
    Ok(stop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn given_invalid_json_when_validate_then_usage_exit_2() {
        for raw in ["{\"op\":", "not json", "{'op':'ping'}", "", "  "] {
            let err = validate_json(raw).unwrap_err();
            assert_eq!(err.exit_code(), 2, "{raw:?}");
            assert!(err.to_string().contains("JSON"));
        }
    }

    #[test]
    fn given_any_json_value_when_validate_then_ok() {
        for raw in [
            "{\"op\":\"ping\"}",
            "[1,2]",
            "\"quoted\"",
            "42",
            "null",
            " {} ",
        ] {
            assert!(validate_json(raw).is_ok(), "{raw:?}");
        }
    }

    #[test]
    fn given_inline_json_when_read_json_then_raw_text_is_preserved() {
        assert_eq!(
            read_json(" {\"op\": \"ping\"} ").unwrap(),
            " {\"op\": \"ping\"} "
        );
        assert_eq!(read_json("{\"op\":").unwrap_err().exit_code(), 2);
    }
}
