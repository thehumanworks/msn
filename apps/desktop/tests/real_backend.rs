//! Drives the real worker + reducer against a real msn Worker (for example `wrangler dev` with a
//! test-only tenant). Ignored by default; run with:
//!
//! `MSN_URL=http://127.0.0.1:8799 MSN_WORKSPACE_TENANT=t MSN_WORKSPACE_TOKEN=k MSN_ADMIN_TOKEN=a \
//!  cargo test --test real_backend -- --ignored`
//!
//! It creates a uniquely named channel, sends canonical messages and a task event, deletes a
//! message through the admin API, and requires the desktop state to converge on the canonical
//! result (deleted content purged, board from the authoritative reducer) via the events API.

mod support;

use msn_cli::Correlation;
use msn_cli::client::MsnClient;
use msn_desktop::net::client_ops;
use msn_desktop::net::worker::Command;
use msn_desktop::state::AppState;
use support::rig::{Pump, rig};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name} (see the file header)"))
}

#[test]
#[ignore = "needs a real Worker; see the file header"]
fn real_worker_live_flow_including_admin_deletion() {
    let (url, tenant, token, admin) = (
        env("MSN_URL"),
        env("MSN_WORKSPACE_TENANT"),
        env("MSN_WORKSPACE_TOKEN"),
        env("MSN_ADMIN_TOKEN"),
    );
    let origin = msn_cli::config::parse_origin(&url).unwrap();
    let client = MsnClient::new(&origin).unwrap();
    let channel = format!("real-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let never = || false;

    let rig = rig();
    let mut pump = Pump {
        rig: &rig,
        state: AppState::default(),
    };
    let generation = rig.connect(&url, &tenant, &token);
    pump.state.begin_connect(generation, tenant.clone());
    assert!(pump.until(20, |s| s.events_ready && s.connection.is_some()));
    let username = pump.state.connection.as_ref().unwrap().username.clone();

    // Create through the GUI path; the reducer auto-selects the new channel.
    pump.dispatch(vec![Command::CreateChannel {
        generation,
        name: channel.clone(),
    }]);
    assert!(pump.until(20, |s| {
        s.selected_channel.as_deref() == Some(channel.as_str())
            && s.channel.as_ref().is_some_and(|c| c.loaded)
            && s.channels.contains(&channel)
    }));

    let send = |text: &str, key: &str| {
        client_ops::send_message(
            &client,
            &tenant,
            &token,
            &channel,
            &username,
            text,
            key,
            Correlation::default(),
            &never,
        )
        .ok()
        .expect("send")
    };
    let secret = send("secret", "real-k1").id;
    let keep = send("keep", "real-k2").id;
    assert!(pump.until(20, |s| {
        s.channel
            .as_ref()
            .is_some_and(|c| c.messages.contains_key(&secret) && c.messages.contains_key(&keep))
    }));

    let open = r#"{"schema":"msn.task.v1","task":"t1","action":"open","title":"Real task","reviewer":"carol"}"#;
    client_ops::send_task_event(
        &client,
        &tenant,
        &token,
        &channel,
        &username,
        "t1",
        serde_json::from_str(open).unwrap(),
        "real-task-1",
        &never,
    )
    .ok()
    .expect("task open");
    assert!(pump.until(20, |s| {
        s.channel
            .as_ref()
            .and_then(|c| c.task_board.as_ref())
            .is_some_and(|b| b["tasks"][0]["id"] == "t1")
    }));

    let response = client
        .delete(
            &format!("/api/admin/tenants/{tenant}/channels/{channel}/messages/{secret}"),
            &admin,
        )
        .unwrap();
    assert_eq!(response.status, 204);
    assert!(pump.until(20, |s| {
        s.channel
            .as_ref()
            .is_some_and(|c| !c.messages.contains_key(&secret) && c.revision >= 1)
    }));
    let state = pump.state.channel.as_ref().unwrap();
    assert!(state.messages.contains_key(&keep));
    assert!(
        state.task_board.is_some(),
        "board rebuilt from canonical history after deletion"
    );
    assert!(pump.state.events_notice.is_none() && !pump.state.events_stopped);

    // Unread counts (ADR 0045): another board moves on while this one is open.
    let other = format!("{channel}-b");
    client_ops::create_channel(&client, &tenant, &token, &other).expect("create other");
    let post = |text: &str, key: &str, to: Option<&str>| {
        client_ops::send_message(
            &client,
            &tenant,
            &token,
            &other,
            &username,
            text,
            key,
            Correlation {
                to: to.map(str::to_string),
                ..Correlation::default()
            },
            &never,
        )
        .ok()
        .expect("send to other")
        .id
    };
    let mark = post("read already", "real-u1", None);
    pump.state.read_marks.advance(&other, mark);
    assert!(pump.until(20, |s| s.channels.contains(&other)));
    // The workspace key posts as this reader; the server leaves the reader's own messages out.
    post("mine", "real-u2", None);
    let counts = client_ops::fetch_unread(
        &client,
        &tenant,
        &token,
        "someone-else",
        &[(other.clone(), mark)],
    )
    .expect("unread counts");
    assert_eq!(counts.len(), 1);
    assert_eq!((counts[0].count, counts[0].to_you), (1, 0));
    post("for you", "real-u3", Some("Someone-Else"));
    pump.state.unread_stale = true;
    let command = pump.state.unread_command().expect("a counts request");
    pump.dispatch(vec![command]);
    assert!(pump.until(20, |s| !s.unread_inflight && s.unread.contains_key(&other)));
    // Both new messages were posted under this reader's own name: not news to them.
    assert_eq!(pump.state.unread[&other].count, 0);
    assert!(pump.state.unread_for(&other).is_none());
    let counts = client_ops::fetch_unread(
        &client,
        &tenant,
        &token,
        "someone-else",
        &[(other.clone(), mark)],
    )
    .expect("unread counts");
    assert_eq!((counts[0].count, counts[0].to_you), (2, 1));
}

/// Archived boards (ADR 0046) through the desktop path: archive, the list marks it, the server
/// refuses a send, and unarchive restores it. Needs the owner token as MSN_WORKSPACE_TOKEN.
#[test]
#[ignore = "needs a real Worker; see the file header"]
fn real_worker_archive_and_unarchive_a_board() {
    let (url, tenant, token) = (
        env("MSN_URL"),
        env("MSN_WORKSPACE_TENANT"),
        env("MSN_WORKSPACE_TOKEN"),
    );
    let origin = msn_cli::config::parse_origin(&url).unwrap();
    let client = MsnClient::new(&origin).unwrap();
    let channel = format!("arch-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let never = || false;
    let rig = rig();
    let mut pump = Pump {
        rig: &rig,
        state: AppState::default(),
    };
    let generation = rig.connect(&url, &tenant, &token);
    pump.state.begin_connect(generation, tenant.clone());
    assert!(pump.until(20, |s| s.events_ready && s.connection.is_some()));
    let username = pump.state.connection.as_ref().unwrap().username.clone();
    pump.dispatch(vec![Command::CreateChannel {
        generation,
        name: channel.clone(),
    }]);
    assert!(pump.until(20, |s| s.selected_channel.as_deref()
        == Some(channel.as_str())));

    let commands = pump.state.set_archived(true);
    pump.dispatch(commands);
    assert!(pump.until(20, |s| s.is_archived(&channel)
        && s.channels.contains(&channel)
        && s.visible_channels().all(|name| name != &channel)));
    let refused = client_ops::send_message(
        &client,
        &tenant,
        &token,
        &channel,
        &username,
        "after archive",
        "arch-k1",
        Correlation::default(),
        &never,
    );
    let error = refused
        .err()
        .expect("archived boards refuse sends")
        .cli_error;
    assert!(error.to_string().contains("archived"), "{error}");

    let commands = pump.state.set_archived(false);
    pump.dispatch(commands);
    assert!(pump.until(20, |s| !s.is_archived(&channel)
        && s.visible_channels().any(|name| name == &channel)));
}
