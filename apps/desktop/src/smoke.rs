//! `msn-desktop --smoke`: a headless integration check that drives the same client code the GUI
//! uses (authenticated connect, channel create/list, an idempotent send, exact read-back, history
//! scan and the mandatory events API) against a real server, without opening a window. It is a
//! terminal/CI diagnostic and is **not** GUI execution.
//!
//! Configuration comes from the environment so the token never appears in argv:
//! `MSN_URL` and `MSN_WORKSPACE_TENANT` and `MSN_WORKSPACE_TOKEN` (required), `MSN_USERNAME`
//! (optional), `MSN_SMOKE_CHANNEL` (default `desktop-smoke`). Every check must PASS; there is no
//! SKIP-as-success.

use std::process::ExitCode;
use std::time::{Duration, Instant};

use msn_cli::Correlation;
use msn_cli::client::MsnClient;
use msn_cli::config::{parse_origin, slug};

use crate::net::worker::{MAX_DRAIN_PAGES, connect};
use crate::net::{client_ops, events};

struct Report {
    failed: bool,
}

impl Report {
    fn pass(&self, check: &str, detail: impl AsRef<str>) {
        println!("  PASS  {check}: {}", detail.as_ref());
    }

    fn fail(&mut self, check: &str, detail: impl AsRef<str>) {
        println!("  FAIL  {check}: {}", detail.as_ref());
        self.failed = true;
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

pub fn run() -> ExitCode {
    println!("msn-desktop smoke test (headless, no window opened; not GUI execution)");
    let mut report = Report { failed: false };
    let (Some(url), Some(tenant), Some(token)) = (
        env("MSN_URL"),
        env("MSN_WORKSPACE_TENANT"),
        env("MSN_WORKSPACE_TOKEN"),
    ) else {
        eprintln!(
            "Set MSN_URL, MSN_WORKSPACE_TENANT and MSN_WORKSPACE_TOKEN (token is never taken from argv)."
        );
        return ExitCode::FAILURE;
    };
    let channel = env("MSN_SMOKE_CHANNEL").unwrap_or_else(|| "desktop-smoke".into());
    let username = env("MSN_USERNAME");
    if let Err(err) = slug(&tenant).and_then(|_| slug(&channel)) {
        eprintln!("{err}");
        return ExitCode::FAILURE;
    }
    let origin = match parse_origin(&url) {
        Ok(origin) => origin,
        Err(err) => {
            report.fail("origin", err.to_string());
            return ExitCode::FAILURE;
        }
    };

    let (client, username, _owner) = match connect(&origin, &tenant, &token, username.as_deref()) {
        Ok(ok) => ok,
        Err(err) => {
            report.fail("connect", err.to_string());
            return ExitCode::FAILURE;
        }
    };
    report.pass("connect", format!("authenticated as \"{username}\""));

    // Establish the event cursor first (same drain the GUI performs) so later reads cannot race it.
    match drain_events(&client, &tenant, &token) {
        Ok(cursor) => {
            report.pass(
                "events-drain",
                format!("journal drained to cursor {cursor}"),
            );
        }
        Err(err) => {
            report.fail("events-drain", err);
            return ExitCode::FAILURE;
        }
    };

    match client_ops::create_channel(&client, &tenant, &token, &channel) {
        Ok(()) => report.pass("create-channel", &channel),
        Err(err) => {
            report.fail("create-channel", err.to_string());
            return ExitCode::FAILURE;
        }
    }
    match client_ops::list_channels(&client, &tenant, &token) {
        Ok(names) if names.contains(&channel) => {
            report.pass(
                "list-channels",
                format!("{} channel(s); \"{channel}\" listed by name", names.len()),
            );
        }
        Ok(names) => report.fail(
            "list-channels",
            format!("\"{channel}\" missing from {names:?}"),
        ),
        Err(err) => report.fail("list-channels", err.to_string()),
    }

    // Channel creation is itself an event. Advance past setup before starting the waiter;
    // otherwise a newly created channel returns immediately and never observes the later send.
    let cursor = match drain_events(&client, &tenant, &token) {
        Ok(cursor) => cursor,
        Err(err) => {
            report.fail("events-setup-cursor", err);
            return ExitCode::FAILURE;
        }
    };

    // A long-poll started before the send must be woken by the server, not by a timer.
    let waiter = {
        let (origin, tenant, token, channel) = (
            origin.clone(),
            tenant.clone(),
            token.clone(),
            channel.clone(),
        );
        std::thread::spawn(move || {
            let client = MsnClient::new(&origin).map_err(|e| e.to_string())?;
            let started = Instant::now();
            events::fetch_events(&client, &tenant, &token, cursor, 100, 15, Some(&channel))
                .map(|page| (page, started.elapsed()))
                .map_err(|e| e.to_string())
        })
    };
    std::thread::sleep(Duration::from_millis(500));

    let key = uuid::Uuid::new_v4().to_string();
    let text = format!("msn-desktop smoke {key}");
    let correlation = || Correlation::default();
    let never = || false;
    let sent = client_ops::send_message(
        &client,
        &tenant,
        &token,
        &channel,
        &username,
        &text,
        &key,
        correlation(),
        &never,
    );
    let id = match sent {
        Ok(outcome) if !outcome.replayed => {
            report.pass(
                "send",
                format!("message id {} (Idempotency-Key {key})", outcome.id),
            );
            outcome.id
        }
        Ok(_) => {
            report.fail("send", "first send unexpectedly reported replayed=true");
            return ExitCode::FAILURE;
        }
        Err(err) => {
            report.fail("send", err.cli_error.to_string());
            return ExitCode::FAILURE;
        }
    };

    match client_ops::send_message(
        &client,
        &tenant,
        &token,
        &channel,
        &username,
        &text,
        &key,
        correlation(),
        &never,
    ) {
        Ok(outcome) if outcome.replayed && outcome.id == id => {
            report.pass(
                "send-replay",
                "same key and body replayed the same message id",
            );
        }
        Ok(outcome) => report.fail(
            "send-replay",
            format!(
                "expected replayed id {id}, got id {} replayed={}",
                outcome.id, outcome.replayed
            ),
        ),
        Err(err) => report.fail("send-replay", err.cli_error.to_string()),
    }

    match client_ops::show_message(&client, &tenant, &token, &channel, id) {
        Ok(value) if value["message"]["text"].as_str() == Some(text.as_str()) => {
            report.pass(
                "read-back",
                format!("point-read of #{id} matched the sent text"),
            );
        }
        Ok(_) => report.fail("read-back", "point-read text differs from what was sent"),
        Err(err) => report.fail("read-back", err.to_string()),
    }

    match client_ops::fetch_history(&client, &tenant, &token, &channel, &never) {
        Ok(history) => {
            let listed = history
                .messages
                .iter()
                .any(|m| m["id"].as_u64() == Some(id));
            if listed && history.head >= id {
                let board = client_ops::project_board(&history);
                report.pass(
                    "history",
                    format!(
                        "{} message(s), head {}, revision {}, task board {}",
                        history.messages.len(),
                        history.head,
                        history.revision,
                        if board.is_ok() {
                            "projected"
                        } else {
                            "refused"
                        }
                    ),
                );
            } else {
                report.fail(
                    "history",
                    "revision-consistent scan did not include the sent message",
                );
            }
        }
        Err(err) => report.fail("history", err.to_string()),
    }

    match waiter.join() {
        Ok(Ok((page, waited))) => {
            let created: Vec<_> = page
                .events
                .iter()
                .filter(|e| {
                    e.kind == events::EventKind::MessageCreated && e.resource_id == Some(id)
                })
                .collect();
            if created.len() == 1 && waited < Duration::from_secs(10) {
                report.pass(
                    "events-wake",
                    format!("long-poll woke in {waited:.1?} with message.created for #{id}"),
                );
            } else {
                report.fail(
                    "events-wake",
                    format!("expected exactly one message.created for #{id} in <10s, saw {} after {waited:.1?}", created.len()),
                );
            }
        }
        Ok(Err(err)) => report.fail("events-wake", err),
        Err(_) => report.fail("events-wake", "events thread panicked"),
    }

    // The replayed send must not have produced a second event.
    match events::fetch_events(&client, &tenant, &token, cursor, 100, 0, Some(&channel)) {
        Ok(page) => {
            let count = page
                .events
                .iter()
                .filter(|e| {
                    e.kind == events::EventKind::MessageCreated && e.resource_id == Some(id)
                })
                .count();
            if count == 1 {
                report.pass(
                    "events-no-duplicate",
                    "idempotent replay emitted no duplicate event",
                );
            } else {
                report.fail(
                    "events-no-duplicate",
                    format!("{count} message.created events for #{id}"),
                );
            }
        }
        Err(err) => report.fail("events-no-duplicate", err.to_string()),
    }

    if report.failed {
        println!("RESULT: FAIL");
        ExitCode::FAILURE
    } else {
        println!("RESULT: PASS");
        ExitCode::SUCCESS
    }
}

fn drain_events(client: &MsnClient, tenant: &str, token: &str) -> Result<u64, String> {
    let mut cursor = 0;
    for _ in 0..MAX_DRAIN_PAGES {
        let page = events::fetch_events(client, tenant, token, cursor, 100, 0, None)
            .map_err(|e| e.to_string())?;
        cursor = page.next_cursor;
        if !page.has_more {
            return Ok(cursor);
        }
    }
    Err("event journal too large to drain".into())
}
