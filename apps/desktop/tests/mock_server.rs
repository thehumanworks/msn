//! End-to-end tests of the desktop network layer over real HTTP against a stateful fake of the
//! msn Worker (see `support/mod.rs`). No GUI is opened; these drive the same worker/reducer the
//! GUI drives.

mod support;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use msn_cli::Correlation;
use msn_cli::client::MsnClient;
use msn_cli::error::CliError;

use msn_desktop::net::client_ops::{self, SendError};
use msn_desktop::net::events::{self, EventKind, EventsError};
use msn_desktop::net::worker::{Command, UiEvent, connect};
use msn_desktop::profile::{ProfileStore, SaveOutcome, SaveRequest};
use msn_desktop::state::AppState;

use support::rig::{Pump, rig};
use support::{MockServer, TENANT, TOKEN};

fn client(server: &MockServer) -> MsnClient {
    MsnClient::new(&server.url()).unwrap()
}

fn never() -> bool {
    false
}

fn send(server: &MockServer, key: &str, text: &str) -> Result<client_ops::SendOutcome, SendError> {
    client_ops::send_message(
        &client(server),
        TENANT,
        TOKEN,
        "general",
        "alice",
        text,
        key,
        Correlation::default(),
        &never,
    )
}

// ---------------------------------------------------------------- connect / auth

#[test]
fn missing_events_endpoint_stops_sync_with_deployment_guidance_and_reconnect_recovers() {
    let server = MockServer::start();
    server.fake.missing_events.store(true, Ordering::SeqCst);
    let r = rig();
    let mut pump = Pump {
        rig: &r,
        state: AppState::default(),
    };
    let generation = r.connect(server.url().as_str(), TENANT, TOKEN);
    pump.state.begin_connect(generation, TENANT.into());
    assert!(pump.until(5, |s| s.events_stopped));
    assert!(!pump.state.events_ready);
    assert!(
        pump.state.status.is_none(),
        "a terminal error must stop the synchronising status"
    );
    let notice = pump.state.events_notice.as_deref().unwrap();
    assert!(notice.contains("Deploy the coordination API"));
    assert!(notice.contains("Disconnect and Connect"));
    assert!(!notice.contains("Message deletion"));
    assert!(
        server
            .fake
            .logged("GET", "/api/tenants/acme/channels")
            .is_empty(),
        "failed cursor establishment must not release canonical reads"
    );
    assert!(
        r.quiet_for(200).is_empty(),
        "terminal errors must not spin or retry"
    );

    // The same connection workflow succeeds after the server is updated.
    server.fake.missing_events.store(false, Ordering::SeqCst);
    let generation = r.connect(server.url().as_str(), TENANT, TOKEN);
    pump.state.begin_connect(generation, TENANT.into());
    assert!(pump.until(5, |s| s.events_ready));
    assert!(!pump.state.events_stopped);
    assert!(pump.state.events_notice.is_none());
}

#[test]
fn connect_always_authenticates_even_with_an_explicit_username() {
    let server = MockServer::start();
    server.fake.revoke_token();
    let error = connect(&server.url(), TENANT, TOKEN, Some("alice"))
        .err()
        .unwrap();
    assert!(
        matches!(error, CliError::Auth(_)),
        "explicit username must not skip authentication"
    );
    let first = &server.fake.logged("GET", "/api/tenants/acme")[0];
    assert_eq!(
        first.path, "/api/tenants/acme",
        "the identity endpoint was called"
    );
}

#[test]
fn connect_enforces_the_key_binding() {
    let server = MockServer::start();
    assert!(matches!(
        connect(&server.url(), TENANT, TOKEN, Some("mallory"))
            .err()
            .unwrap(),
        CliError::Auth(_)
    ));
    assert_eq!(
        connect(&server.url(), TENANT, TOKEN, None).unwrap().1,
        "alice"
    );
    assert_eq!(
        connect(&server.url(), TENANT, TOKEN, Some("alice"))
            .unwrap()
            .1,
        "alice"
    );

    *server.fake.bound_username.lock().unwrap() = None;
    assert!(matches!(
        connect(&server.url(), TENANT, TOKEN, None).err().unwrap(),
        CliError::Usage(_)
    ));
    assert_eq!(
        connect(&server.url(), TENANT, TOKEN, Some("bob"))
            .unwrap()
            .1,
        "bob"
    );
}

#[test]
fn slugs_are_validated_before_path_interpolation() {
    let server = MockServer::start();
    let c = client(&server);
    assert!(client_ops::list_channels(&c, "../evil", TOKEN).is_err());
    assert!(client_ops::create_channel(&c, TENANT, TOKEN, "Bad/Channel").is_err());
    assert!(client_ops::fetch_history(&c, TENANT, TOKEN, "a/../b", &never).is_err());
    assert!(events::fetch_events(&c, "acme?x=1", TOKEN, 0, 1, 0, None).is_err());
    assert!(
        server.fake.log.lock().unwrap().is_empty(),
        "no request left the client"
    );
}

// ---------------------------------------------------------------- channels / send

#[test]
fn channels_are_listed_from_the_name_field_and_created_by_put() {
    let server = MockServer::start();
    let c = client(&server);
    client_ops::create_channel(&c, TENANT, TOKEN, "general").unwrap();
    client_ops::create_channel(&c, TENANT, TOKEN, "ops").unwrap();
    assert_eq!(
        client_ops::list_channels(&c, TENANT, TOKEN).unwrap(),
        ["general", "ops"]
    );
}

#[test]
fn send_replay_returns_the_same_message_and_fails_closed_on_conflict() {
    let server = MockServer::start();
    server.fake.create_channel("general");
    let first = send(&server, "key-1", "hello").ok().unwrap();
    let again = send(&server, "key-1", "hello").ok().unwrap();
    assert!(!first.replayed && again.replayed);
    assert_eq!(first.id, again.id);
    let read =
        client_ops::show_message(&client(&server), TENANT, TOKEN, "general", first.id).unwrap();
    assert_eq!(read["message"]["text"], "hello");
    let conflict = send(&server, "key-1", "different body").err().unwrap();
    assert!(
        !conflict.retryable,
        "a changed payload under the same key is not retried"
    );
}

#[test]
fn send_retries_reuse_the_same_key_and_body() {
    let server = MockServer::start();
    server.fake.create_channel("general");
    server.fake.fail_next_posts.store(1, Ordering::SeqCst);
    let outcome = send(&server, "stable-key", "payload").ok().unwrap();
    assert!(!outcome.replayed);
    let posts = server.fake.logged("POST", "/messages");
    assert_eq!(posts.len(), 2, "one 503 then one success");
    assert_eq!(posts[0].idempotency_key, posts[1].idempotency_key);
    assert_eq!(posts[0].body, posts[1].body);
    assert_eq!(posts[0].idempotency_key.as_deref(), Some("stable-key"));
}

#[test]
fn a_send_stops_retrying_once_its_connection_is_cancelled() {
    let server = MockServer::start();
    server.fake.create_channel("general");
    server.fake.fail_next_posts.store(100, Ordering::SeqCst);
    let fake = Arc::clone(&server.fake);
    let cancelled = move || fake.requests("POST", "/messages") >= 1;
    let error = client_ops::send_message(
        &client(&server),
        TENANT,
        TOKEN,
        "general",
        "alice",
        "x",
        "k",
        Correlation::default(),
        &cancelled,
    )
    .err()
    .unwrap();
    assert!(!error.retryable);
    assert_eq!(
        server.fake.requests("POST", "/messages"),
        1,
        "no attempt after cancellation"
    );
}

// ---------------------------------------------------------------- history

#[test]
fn history_scan_pages_and_never_includes_deleted_messages() {
    let server = MockServer::start();
    server.fake.create_channel("general");
    for i in 1..=250 {
        server.fake.add_message("general", "bob", &format!("m{i}"));
    }
    server.fake.delete_message("general", 10);
    let history =
        client_ops::fetch_history(&client(&server), TENANT, TOKEN, "general", &never).unwrap();
    assert_eq!(history.messages.len(), 249);
    assert_eq!((history.head, history.revision), (250, 1));
    assert!(history.messages.iter().all(|m| m["id"] != 10));
    let ids: Vec<u64> = history
        .messages
        .iter()
        .map(|m| m["id"].as_u64().unwrap())
        .collect();
    assert!(ids.windows(2).all(|w| w[0] < w[1]));
}

#[test]
fn a_reply_parent_loads_and_reads_as_gone_when_deleted_or_missing() {
    let server = MockServer::start();
    server.fake.create_channel("general");
    let kept = server.fake.add_message("general", "bob", "plan");
    let deleted = server.fake.add_message("general", "bob", "old plan");
    server.fake.delete_message("general", deleted);
    let load = |id| client_ops::load_parent(&client(&server), TENANT, TOKEN, "general", id);
    assert_eq!(load(kept).unwrap().unwrap()["text"], "plan");
    assert_eq!(load(deleted).unwrap(), None, "410 is gone");
    assert_eq!(load(999).unwrap(), None, "404 is gone");
}

// ---------------------------------------------------------------- events API

#[test]
fn events_are_validated_and_classified_over_http() {
    let server = MockServer::start();
    server.fake.create_channel("general");
    server.fake.add_message("general", "bob", "hi");
    let c = client(&server);
    let page = events::fetch_events(&c, TENANT, TOKEN, 0, 100, 0, None).unwrap();
    assert_eq!(page.events.len(), 2);
    assert!(matches!(page.events[0].kind, EventKind::ChannelCreated));
    assert_eq!(page.events[1].resource_id, Some(1));
    // Cursor-filtered replay is strict: nothing at or before `after`.
    let later = events::fetch_events(&c, TENANT, TOKEN, 1, 100, 0, Some("general")).unwrap();
    assert_eq!(later.events.len(), 1);

    server.fake.corrupt_events.store(true, Ordering::SeqCst);
    assert!(matches!(
        events::fetch_events(&c, TENANT, TOKEN, 0, 100, 0, None),
        Err(EventsError::Terminal(_))
    ));
    server.fake.corrupt_events.store(false, Ordering::SeqCst);

    server.fake.revoke_token();
    assert!(matches!(
        events::fetch_events(&c, TENANT, TOKEN, 0, 100, 0, None),
        Err(EventsError::Auth(_))
    ));

    let dead = MsnClient::new(&url::Url::parse("http://127.0.0.1:1").unwrap()).unwrap();
    assert!(matches!(
        events::fetch_events(&dead, TENANT, TOKEN, 0, 100, 0, None),
        Err(EventsError::Retry(_))
    ));
}

#[test]
fn long_poll_wakes_on_change_with_a_single_request() {
    let server = MockServer::start();
    server.fake.create_channel("general");
    let origin = server.url();
    let waiter = std::thread::spawn(move || {
        let client = MsnClient::new(&origin).unwrap();
        let started = Instant::now();
        let page = events::fetch_events(&client, TENANT, TOKEN, 1, 100, 20, None).unwrap();
        (page, started.elapsed())
    });
    std::thread::sleep(Duration::from_millis(400));
    server.fake.add_message("general", "bob", "wake up");
    let (page, elapsed) = waiter.join().unwrap();
    assert!(
        elapsed < Duration::from_secs(5),
        "woken by the change, not the 20s timeout: {elapsed:?}"
    );
    assert_eq!(page.events.len(), 1);
    assert_eq!(
        server.fake.requests("GET", "/events"),
        1,
        "event-driven, not periodic polling"
    );
}

// ---------------------------------------------------------------- worker + reducer

#[test]
fn drain_is_silent_then_ready_then_only_new_events_stream_and_idle_costs_nothing() {
    let server = MockServer::start();
    server.fake.create_channel("general");
    for i in 0..250 {
        server.fake.add_message("general", "bob", &format!("m{i}"));
    }
    let rig = rig();
    rig.connect(&server.origin, TENANT, TOKEN);
    assert!(
        rig.until(10, |e| matches!(e, UiEvent::Connected { .. }))
            .is_some()
    );
    assert!(
        rig.until(10, |e| matches!(e, UiEvent::EventsReady { .. }))
            .is_some()
    );
    assert!(
        !rig.seen
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, UiEvent::CoordinationEvents { .. })),
        "the 251 historical events are drained silently"
    );
    let idle_baseline = rig.wakes.load(Ordering::SeqCst);
    let idle = rig.quiet_for(800);
    assert!(idle.is_empty(), "no events while nothing changes");
    assert_eq!(
        rig.wakes.load(Ordering::SeqCst),
        idle_baseline,
        "no repaint requests while idle"
    );
    assert_eq!(
        server.fake.requests("GET", "/events"),
        4,
        "3 drain pages + 1 parked long-poll; no periodic scans"
    );

    server.fake.add_message("general", "bob", "live");
    let event = rig
        .until(10, |e| matches!(e, UiEvent::CoordinationEvents { .. }))
        .unwrap();
    let UiEvent::CoordinationEvents { events, .. } = event else {
        unreachable!()
    };
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0].kind, EventKind::MessageCreated));
    assert_eq!(events[0].id, 252);
}

#[test]
fn commands_from_an_old_generation_never_execute() {
    let server = MockServer::start();
    server.fake.create_channel("general");
    let rig = rig();
    let old = rig.connect(&server.origin, TENANT, TOKEN);
    assert!(
        rig.until(10, |e| matches!(e, UiEvent::EventsReady { .. }))
            .is_some()
    );

    rig.worker
        .send(Command::ListChannels { generation: old })
        .ok()
        .unwrap();
    let listed = rig
        .until(10, |e| matches!(e, UiEvent::Channels { .. }))
        .unwrap();
    let UiEvent::Channels { channels, .. } = listed else {
        unreachable!()
    };
    assert_eq!(channels, ["general"]);
    let lists = server.fake.requests("GET", "/channels");

    rig.worker.next_generation(); // disconnect
    rig.worker
        .send(Command::ListChannels { generation: old })
        .ok()
        .unwrap();
    rig.worker
        .send(Command::SendMessage {
            generation: old,
            channel_generation: 1,
            channel: "general".into(),
            username: "alice".into(),
            text: "should never be sent".into(),
            key: "old-key".into(),
            reply_to: None,
            correlation_id: None,
            to: None,
        })
        .ok()
        .unwrap();
    let after = rig.quiet_for(600);
    assert!(
        !after
            .iter()
            .any(|e| matches!(e, UiEvent::Channels { .. } | UiEvent::MessageSent { .. }))
    );
    assert_eq!(server.fake.requests("GET", "/channels"), lists);
    assert_eq!(
        server.fake.requests("POST", "/messages"),
        0,
        "old-connection send was dropped"
    );
}

#[test]
fn revocation_ends_the_pending_poll_reports_auth_failure_and_stops_listening() {
    let server = MockServer::start();
    server.fake.create_channel("general");
    let rig = rig();
    let generation = rig.connect(&server.origin, TENANT, TOKEN);
    assert!(
        rig.until(10, |e| matches!(e, UiEvent::EventsReady { .. }))
            .is_some()
    );
    server.fake.revoke_token();
    let failure = rig
        .until(10, |e| matches!(e, UiEvent::AuthFailed { .. }))
        .unwrap();
    let UiEvent::AuthFailed {
        generation: failed, ..
    } = failure
    else {
        unreachable!()
    };
    assert_eq!(failed, generation);
    let requests = server.fake.requests("GET", "/events");
    rig.quiet_for(1500);
    assert_eq!(
        server.fake.requests("GET", "/events"),
        requests,
        "the listener stopped"
    );

    // The reducer turns it into a signed-out state and asks the app to advance the generation.
    let mut state = AppState::default();
    state.begin_connect(generation, TENANT.into());
    state.apply(UiEvent::Connected {
        generation,
        username: "alice".into(),
        owner: false,
    });
    let commands = state.apply(UiEvent::AuthFailed {
        generation,
        message: "401".into(),
    });
    assert!(matches!(commands.as_slice(), [Command::Disconnect]));
    assert!(state.connection.is_none());
}

#[test]
fn an_invalid_event_page_stops_the_stream_fail_closed_without_skipping() {
    let server = MockServer::start();
    server.fake.create_channel("general");
    server.fake.corrupt_events.store(true, Ordering::SeqCst);
    let rig = rig();
    rig.connect(&server.origin, TENANT, TOKEN);
    let status = rig
        .until(10, |e| {
            matches!(e, UiEvent::EventsStatus { stopped: true, .. })
        })
        .expect("subscription reports it stopped");
    let UiEvent::EventsStatus { notice, .. } = status else {
        unreachable!()
    };
    assert!(notice.unwrap().contains("Invalid events response"));
    assert!(
        !rig.seen
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, UiEvent::EventsReady { .. }))
    );
    let requests = server.fake.requests("GET", "/events");
    rig.quiet_for(1200);
    assert_eq!(
        server.fake.requests("GET", "/events"),
        requests,
        "no retry loop past an invalid page"
    );
}

#[test]
fn live_chat_board_and_deletion_flow_end_to_end() {
    let server = MockServer::start();
    server.fake.create_channel("general");
    let secret = server.fake.add_message("general", "bob", "secret");
    let keep = server.fake.add_message("general", "bob", "keep");
    let open = r#"{"schema":"msn.task.v1","task":"t1","action":"open","title":"Ship it","reviewer":"carol"}"#;
    server.fake.add_message("general", "bob", open);

    let rig = rig();
    let mut pump = Pump {
        rig: &rig,
        state: AppState::default(),
    };
    let generation = rig.connect(&server.origin, TENANT, TOKEN);
    pump.state.begin_connect(generation, TENANT.into());
    assert!(pump.until(10, |s| s.events_ready && s.channels == ["general"]));

    // A message created after the cursor exists but before the canonical read is not lost.
    let racing = server.fake.add_message("general", "dave", "racing");
    let commands = pump.state.select_channel("general".into());
    pump.dispatch(commands);
    assert!(pump.until(10, |s| {
        s.channel
            .as_ref()
            .is_some_and(|c| c.loaded && c.messages.contains_key(&racing))
    }));
    assert!(
        pump.state
            .channel
            .as_ref()
            .unwrap()
            .messages
            .contains_key(&secret)
    );

    // An external plain message refreshes chat via the event; no user action needed.
    let live = server.fake.add_message("general", "erin", "live update");
    assert!(pump.until(10, |s| {
        s.channel
            .as_ref()
            .is_some_and(|c| c.messages.contains_key(&live))
    }));

    // The board comes from the authoritative reducer; a task event from someone else updates it.
    assert!(pump.until(10, |s| {
        s.channel
            .as_ref()
            .and_then(|c| c.task_board.as_ref())
            .is_some_and(|b| b["tasks"][0]["id"] == "t1")
    }));
    let claim = r#"{"schema":"msn.task.v1","task":"t1","action":"claim"}"#;
    server.fake.add_message("general", "frank", claim);
    assert!(
        pump.until(10, |s| {
            s.channel
                .as_ref()
                .and_then(|c| c.task_board.as_ref())
                .is_some_and(|b| b["tasks"][0]["owner"] == "frank")
        }),
        "external task events refresh the board"
    );

    // Deletion: the secret disappears and never comes back; history is replaced, not merged.
    server.fake.delete_message("general", secret);
    assert!(pump.until(10, |s| {
        s.channel
            .as_ref()
            .is_some_and(|c| !c.messages.contains_key(&secret) && c.revision == 1)
    }));
    let channel = pump.state.channel.as_ref().unwrap();
    assert!(channel.messages.contains_key(&keep));
    assert!(!channel.messages.contains_key(&secret));
    assert!(pump.state.events_notice.is_none());
}

#[test]
fn a_full_command_queue_hands_the_command_back_with_its_payload() {
    // A server that accepts but never answers pins the worker inside Connect, so nothing drains.
    let hang = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = url::Url::parse(&format!("http://{}", hang.local_addr().unwrap())).unwrap();
    let rig = rig();
    let generation = rig.worker.next_generation();
    rig.worker
        .send(Command::Connect {
            generation,
            origin,
            tenant: TENANT.into(),
            token: TOKEN.into(),
            chosen_username: None,
            save: None,
        })
        .ok()
        .unwrap();
    std::thread::sleep(Duration::from_millis(300)); // let the worker dequeue Connect and block
    let mut accepted = 0;
    let rejected = loop {
        let command = Command::SendMessage {
            generation,
            channel_generation: 1,
            channel: "general".into(),
            username: "alice".into(),
            text: format!("payload {accepted}"),
            key: format!("key-{accepted}"),
            reply_to: Some(7),
            correlation_id: None,
            to: Some("bob".into()),
        };
        match rig.worker.send(command) {
            Ok(()) => accepted += 1,
            Err(back) => break back,
        }
        assert!(
            accepted <= msn_desktop::net::worker::COMMAND_QUEUE_CAPACITY,
            "queue must be bounded"
        );
    };
    let Command::SendMessage {
        key,
        text,
        reply_to,
        to,
        ..
    } = *rejected
    else {
        panic!("the rejected command comes back intact");
    };
    assert_eq!(key, format!("key-{accepted}"));
    assert_eq!(text, format!("payload {accepted}"));
    assert_eq!((reply_to, to.as_deref()), (Some(7), Some("bob")));
    drop(hang);
}

/// A private, self-cleaning profiles directory so tests never touch the real one.
struct TempProfiles(std::path::PathBuf);

impl TempProfiles {
    fn new(label: &str) -> Self {
        TempProfiles(std::env::temp_dir().join(format!(
            "msn-desktop-profiles-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        )))
    }

    fn store(&self) -> ProfileStore {
        ProfileStore::at(self.0.join("msn/profiles"))
    }
}

impl Drop for TempProfiles {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn an_authenticated_connection_is_saved_as_a_profile_the_cli_can_read() {
    let server = MockServer::start();
    let temp = TempProfiles::new("save");
    let rig = rig();
    let generation = rig.connect_saving(
        server.url().as_str(),
        TENANT,
        TOKEN,
        Some(SaveRequest {
            store: temp.store(),
            name: None,
        }),
    );
    let Some(UiEvent::ProfileSaved {
        generation: saved_generation,
        outcome,
    }) = rig.until(10, |e| matches!(e, UiEvent::ProfileSaved { .. }))
    else {
        panic!("no ProfileSaved event");
    };
    assert_eq!(saved_generation, generation);
    // Named after the identity the server bound the key to, not anything typed locally.
    assert_eq!(outcome, SaveOutcome::Saved("alice-acme".into()));
    assert!(
        !format!("{outcome:?}").contains(TOKEN),
        "events never carry the token"
    );

    let stored = temp.store().load("alice-acme").unwrap();
    assert_eq!(stored.username, "alice");
    assert_eq!(stored.tenant, TENANT);
    assert_eq!(stored.token, TOKEN);
    assert_eq!(
        stored.url,
        server.url().origin().ascii_serialization(),
        "the origin is stored normalised, as the CLI stores it"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let file = temp.0.join("msn/profiles/alice-acme.json");
        assert_eq!(
            std::fs::metadata(file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    // Connecting again with the same key reports the existing profile instead of duplicating it.
    rig.connect_saving(
        server.url().as_str(),
        TENANT,
        TOKEN,
        Some(SaveRequest {
            store: temp.store(),
            name: None,
        }),
    );
    let Some(UiEvent::ProfileSaved { outcome, .. }) =
        rig.until(10, |e| matches!(e, UiEvent::ProfileSaved { .. }))
    else {
        panic!("no second ProfileSaved event");
    };
    assert_eq!(outcome, SaveOutcome::AlreadySaved("alice-acme".into()));
    assert_eq!(temp.store().summaries().unwrap().len(), 1);
}

#[test]
fn a_rejected_key_is_never_written_to_disk() {
    let server = MockServer::start();
    server.fake.revoke_token();
    let temp = TempProfiles::new("rejected");
    let rig = rig();
    rig.connect_saving(
        server.url().as_str(),
        TENANT,
        TOKEN,
        Some(SaveRequest {
            store: temp.store(),
            name: Some("should-not-exist".into()),
        }),
    );
    let outcome = rig.until(10, |e| {
        matches!(e, UiEvent::Error { .. } | UiEvent::AuthFailed { .. })
    });
    assert!(outcome.is_some(), "the connect must fail");
    assert!(
        rig.quiet_for(200)
            .iter()
            .all(|e| !matches!(e, UiEvent::ProfileSaved { .. } | UiEvent::Connected { .. }))
    );
    assert_eq!(temp.store().summaries().unwrap(), Vec::new());
    assert!(!temp.0.exists(), "not even the directory is created");
}

#[test]
fn a_failed_save_keeps_the_connection_and_explains_itself() {
    let server = MockServer::start();
    let temp = TempProfiles::new("taken");
    temp.store()
        .save(
            Some("taken"),
            &msn_desktop::profile::Connection {
                url: "https://other.example.com".into(),
                tenant: "other".into(),
                token: "0123456789abcdef0123456789abcdef".into(),
                username: "bob".into(),
            },
        )
        .unwrap();
    let rig = rig();
    let mut pump = Pump {
        rig: &rig,
        state: AppState::default(),
    };
    let generation = rig.connect_saving(
        server.url().as_str(),
        TENANT,
        TOKEN,
        Some(SaveRequest {
            store: temp.store(),
            name: Some("taken".into()),
        }),
    );
    pump.state.begin_connect(generation, TENANT.into());
    assert!(pump.until(10, |s| s.profile_save.is_some()));
    assert!(pump.state.connection.is_some(), "still connected");
    assert!(matches!(
        pump.state.profile_save,
        Some(SaveOutcome::Failed(ref message)) if message.contains("already exists")
    ));
    // The existing profile is untouched.
    assert_eq!(temp.store().load("taken").unwrap().username, "bob");
}
