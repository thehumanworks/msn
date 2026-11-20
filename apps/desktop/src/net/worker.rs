//! All network I/O runs on background threads. The UI thread sends [`Command`]s through a bounded
//! queue and drains [`UiEvent`]s from another bounded queue; it never calls the HTTP client.
//!
//! Generations: `generation_marker` advances on every Connect, Disconnect and auth failure. Each
//! command and event carries the generation it was issued under. The worker re-checks the marker
//! when a command is dequeued and between retry/scan steps, so work queued for an old connection
//! never executes (or keeps retrying) after disconnect, and the previous events subscription
//! exits. The UI reducer additionally drops anything stale (see `state.rs`).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::thread;
use std::time::Duration;

use serde_json::Value;
use url::Url;

use msn_cli::Correlation;
use msn_cli::client::MsnClient;
use msn_cli::config::slug;
use msn_cli::error::CliError;
use msn_cli::identity::{fetch_identity, validate_username};

use crate::profile::{Connection, SaveOutcome, SaveRequest};

use super::client_ops::{self, SearchPage, SnapshotView};
use super::events::{self, CoordinationEvent};

pub const COMMAND_QUEUE_CAPACITY: usize = 32;
pub const EVENT_QUEUE_CAPACITY: usize = 256;
/// Upper bound on drain pages while establishing the initial event cursor (~250k events, above
/// the server journal capacity). Exceeding it is an explicit error, never a silent skip.
pub const MAX_DRAIN_PAGES: u64 = 2500;
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct TaskEventRequest {
    pub task: String,
    pub event: Value,
}

#[derive(Debug)]
pub enum Command {
    Connect {
        generation: u64,
        origin: Url,
        tenant: String,
        token: String,
        chosen_username: Option<String>,
        /// Persist the connection as a profile once it has been authenticated.
        save: Option<SaveRequest>,
    },
    /// UI-side effect only: the caller invalidates the generation locally; never enqueued.
    Disconnect,
    ListChannels {
        generation: u64,
    },
    CreateChannel {
        generation: u64,
        name: String,
    },
    SyncChannel {
        generation: u64,
        channel_generation: u64,
        channel: String,
    },
    LoadSnapshots {
        generation: u64,
        channel_generation: u64,
        channel: String,
    },
    /// Processed-by receipts (ADR 0040) for the open channel.
    LoadReceipts {
        generation: u64,
        channel_generation: u64,
        channel: String,
    },
    SendMessage {
        generation: u64,
        channel_generation: u64,
        channel: String,
        username: String,
        text: String,
        key: String,
        reply_to: Option<u64>,
        correlation_id: Option<String>,
        to: Option<String>,
    },
    SendTaskEvent {
        generation: u64,
        channel_generation: u64,
        channel: String,
        username: String,
        key: String,
        request: TaskEventRequest,
    },
    /// One page of message search (ADR 0037). `query` numbers the search so a slow answer to
    /// an earlier query never replaces a newer one.
    Search {
        generation: u64,
        channel_generation: u64,
        channel: String,
        query: u64,
        text: String,
        from: Option<String>,
        before: Option<u64>,
    },
    /// Point-read of one message: the parent of a reply whose parent is not loaded (ADR 0041).
    LoadMessage {
        generation: u64,
        channel_generation: u64,
        channel: String,
        id: u64,
    },
    /// The owner's active board mutes (ADR 0044). Only sent for an owner connection.
    LoadMutes {
        generation: u64,
    },
    /// Mutes a board for `duration` (1h or 1d; `None` until unmuted), then reloads the list.
    SetMute {
        generation: u64,
        channel: String,
        duration: Option<String>,
        everything: bool,
    },
    /// Turns a board's notifications back on, then reloads the list.
    ClearMute {
        generation: u64,
        channel: String,
    },
}

impl Command {
    pub fn generation(&self) -> Option<u64> {
        match self {
            Command::Connect { generation, .. }
            | Command::ListChannels { generation }
            | Command::CreateChannel { generation, .. }
            | Command::SyncChannel { generation, .. }
            | Command::LoadSnapshots { generation, .. }
            | Command::LoadReceipts { generation, .. }
            | Command::SendMessage { generation, .. }
            | Command::SendTaskEvent { generation, .. }
            | Command::Search { generation, .. }
            | Command::LoadMessage { generation, .. }
            | Command::LoadMutes { generation }
            | Command::SetMute { generation, .. }
            | Command::ClearMute { generation, .. } => Some(*generation),
            Command::Disconnect => None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum UiEvent {
    Connected {
        generation: u64,
        username: String,
        /// The key is the workspace owner's: it may receive and mute notifications (ADR 0044).
        owner: bool,
    },
    /// The outcome of the save requested with `Connect`. Never carries the token.
    ProfileSaved {
        generation: u64,
        outcome: SaveOutcome,
    },
    /// The initial event cursor is established; canonical reads issued from now on cannot miss
    /// a change (any later change produces an event after this cursor).
    EventsReady {
        generation: u64,
    },
    EventsStatus {
        generation: u64,
        notice: Option<String>,
        stopped: bool,
    },
    Channels {
        generation: u64,
        channels: Vec<String>,
    },
    ChannelCreated {
        generation: u64,
        channel: String,
    },
    ChannelSynced {
        generation: u64,
        channel_generation: u64,
        channel: String,
        messages: Vec<Value>,
        head: u64,
        revision: u64,
        board: Result<Value, String>,
        /// Pinned messages (ADR 0038); empty when the server has none or does not support pins.
        pins: Vec<Value>,
    },
    Snapshots {
        generation: u64,
        channel_generation: u64,
        channel: String,
        view: SnapshotView,
    },
    MessageSent {
        generation: u64,
        channel_generation: u64,
        channel: String,
        key: String,
        id: u64,
    },
    TaskEventSent {
        generation: u64,
        channel_generation: u64,
        channel: String,
        key: String,
    },
    CoordinationEvents {
        generation: u64,
        events: Vec<CoordinationEvent>,
    },
    Receipts {
        generation: u64,
        channel_generation: u64,
        channel: String,
        receipts: Vec<msn_cli::receipts::Receipt>,
    },
    SearchResults {
        generation: u64,
        channel_generation: u64,
        channel: String,
        query: u64,
        page: SearchPage,
    },
    /// A point-read answered; `message` is `None` when the message no longer exists.
    MessageLoaded {
        generation: u64,
        channel_generation: u64,
        channel: String,
        id: u64,
        message: Option<Value>,
    },
    /// The owner's active board mutes, after a load or a change (ADR 0044).
    Mutes {
        generation: u64,
        mutes: Vec<msn_cli::mutes::Mute>,
    },
    Error {
        generation: u64,
        channel_generation: Option<u64>,
        context: &'static str,
        message: String,
        retryable: bool,
        key: Option<String>,
    },
    /// 401/403. The generation has been (or must be) advanced so the subscription stops.
    AuthFailed {
        generation: u64,
        message: String,
    },
}

pub struct Worker {
    commands: SyncSender<Command>,
    generation_marker: Arc<AtomicU64>,
}

impl Worker {
    pub fn spawn(events_tx: SyncSender<UiEvent>, wake: impl Fn() + Send + Sync + 'static) -> Self {
        let (tx, rx) = sync_channel(COMMAND_QUEUE_CAPACITY);
        Self::spawn_with(tx, rx, events_tx, Arc::new(wake))
    }

    fn spawn_with(
        tx: SyncSender<Command>,
        rx: Receiver<Command>,
        events_tx: SyncSender<UiEvent>,
        wake: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        let generation_marker = Arc::new(AtomicU64::new(0));
        let marker = Arc::clone(&generation_marker);
        thread::Builder::new()
            .name("msn-desktop-net".into())
            .spawn(move || command_loop(rx, events_tx, wake, marker))
            .expect("spawn network worker thread");
        Worker {
            commands: tx,
            generation_marker,
        }
    }

    /// Never blocks the UI thread and never silently drops: when the queue is full the command
    /// is handed back so the caller can surface a retryable rejection with its payload intact.
    pub fn send(&self, command: Command) -> Result<(), Box<Command>> {
        self.commands
            .try_send(command)
            .map_err(|error| match error {
                TrySendError::Full(command) | TrySendError::Disconnected(command) => {
                    Box::new(command)
                }
            })
    }

    /// Advances the generation: queued commands of older generations are skipped when dequeued,
    /// in-flight retries/scans stop at their next step, and the old events subscription exits.
    pub fn next_generation(&self) -> u64 {
        self.generation_marker.fetch_add(1, Ordering::SeqCst) + 1
    }
}

struct ConnCtx {
    generation: u64,
    client: MsnClient,
    tenant: String,
    token: String,
}

type Wake = Arc<dyn Fn() + Send + Sync>;

fn command_loop(
    rx: Receiver<Command>,
    tx: SyncSender<UiEvent>,
    wake: Wake,
    marker: Arc<AtomicU64>,
) {
    let mut conn: Option<ConnCtx> = None;
    while let Ok(command) = rx.recv() {
        let current = marker.load(Ordering::SeqCst);
        if conn.as_ref().is_some_and(|c| c.generation != current) {
            conn = None;
        }
        let Some(generation) = command.generation() else {
            continue;
        };
        if generation != current {
            continue;
        }
        match command {
            Command::Connect {
                origin,
                tenant,
                token,
                chosen_username,
                save,
                ..
            } => match connect(&origin, &tenant, &token, chosen_username.as_deref()) {
                Ok((client, username, owner)) => {
                    if marker.load(Ordering::SeqCst) != generation {
                        continue;
                    }
                    conn = Some(ConnCtx {
                        generation,
                        client,
                        tenant: tenant.clone(),
                        token: token.clone(),
                    });
                    // Only an authenticated connection is ever written, and only here: the
                    // worker is the sole holder of the token.
                    let outcome = save.map(|request| {
                        request.run(&Connection {
                            url: origin.to_string(),
                            tenant: tenant.clone(),
                            token: token.clone(),
                            username: username.clone(),
                        })
                    });
                    emit(
                        &tx,
                        &wake,
                        UiEvent::Connected {
                            generation,
                            username,
                            owner,
                        },
                    );
                    if let Some(outcome) = outcome {
                        emit(
                            &tx,
                            &wake,
                            UiEvent::ProfileSaved {
                                generation,
                                outcome,
                            },
                        );
                    }
                    spawn_events_subscription(
                        origin,
                        tenant,
                        token,
                        generation,
                        Arc::clone(&marker),
                        tx.clone(),
                        Arc::clone(&wake),
                    );
                }
                Err(err) => emit_error(&tx, &wake, generation, None, "connect", err, false, None),
            },
            other => {
                let Some(cc) = conn.as_ref() else { continue };
                handle_command(cc, other, &tx, &wake, &marker);
            }
        }
    }
}

/// Always authenticates against the workspace identity endpoint (even with an explicit
/// username, unlike `identity::resolve_username`, which skips the lookup for overrides), then
/// checks the chosen name against the key's binding.
pub fn connect(
    origin: &Url,
    tenant: &str,
    token: &str,
    chosen: Option<&str>,
) -> Result<(MsnClient, String, bool), CliError> {
    slug(tenant)?;
    let identity = fetch_identity(origin, tenant, token)?;
    let owner = identity.get("owner").and_then(Value::as_bool) == Some(true);
    let bound = identity
        .get("username")
        .and_then(Value::as_str)
        .map(validate_username)
        .transpose()?;
    let prefix = identity.get("usernamePrefix").and_then(Value::as_str);
    let chosen = chosen.map(validate_username).transpose()?;
    let username = match (bound, prefix, chosen) {
        (Some(_), Some(_), _) => {
            return Err(CliError::generic(
                "Identity response had conflicting bindings.",
            ));
        }
        (Some(bound), None, chosen) => {
            if chosen.as_deref().is_some_and(|name| name != bound) {
                return Err(CliError::auth(format!(
                    "This access key may only send as \"{bound}\"."
                )));
            }
            bound
        }
        (None, Some(prefix), Some(name)) if name.starts_with(prefix) => name,
        (None, Some(prefix), _) => {
            return Err(CliError::usage(format!(
                "Enter a username starting with \"{prefix}\"."
            )));
        }
        (None, None, Some(name)) => name,
        (None, None, None) => {
            return Err(CliError::usage(
                "This key has no username binding; enter a username.",
            ));
        }
    };
    Ok((MsnClient::new(origin)?, username, owner))
}

fn handle_command(
    cc: &ConnCtx,
    command: Command,
    tx: &SyncSender<UiEvent>,
    wake: &Wake,
    marker: &AtomicU64,
) {
    let generation = cc.generation;
    let cancelled = || marker.load(Ordering::SeqCst) != generation;
    match command {
        Command::Connect { .. } | Command::Disconnect => {}
        Command::LoadMutes { .. } | Command::SetMute { .. } | Command::ClearMute { .. } => {
            let changed = match command {
                Command::SetMute {
                    channel,
                    duration,
                    everything,
                    ..
                } => client_ops::set_mute(
                    &cc.client,
                    &cc.tenant,
                    &cc.token,
                    &channel,
                    duration.as_deref(),
                    everything,
                ),
                Command::ClearMute { channel, .. } => {
                    client_ops::clear_mute(&cc.client, &cc.tenant, &cc.token, &channel)
                }
                _ => Ok(()),
            };
            match changed.and_then(|()| client_ops::list_mutes(&cc.client, &cc.tenant, &cc.token)) {
                Ok(mutes) => emit(tx, wake, UiEvent::Mutes { generation, mutes }),
                Err(err) => emit_error(tx, wake, generation, None, "mute", err, true, None),
            }
        }
        Command::ListChannels { .. } => {
            match client_ops::list_channels(&cc.client, &cc.tenant, &cc.token) {
                Ok(channels) => emit(
                    tx,
                    wake,
                    UiEvent::Channels {
                        generation,
                        channels,
                    },
                ),
                Err(err) => {
                    emit_error(tx, wake, generation, None, "list-channels", err, true, None)
                }
            }
        }
        Command::CreateChannel { name, .. } => {
            match client_ops::create_channel(&cc.client, &cc.tenant, &cc.token, &name) {
                Ok(()) => emit(
                    tx,
                    wake,
                    UiEvent::ChannelCreated {
                        generation,
                        channel: name,
                    },
                ),
                Err(err) => emit_error(
                    tx,
                    wake,
                    generation,
                    None,
                    "create-channel",
                    err,
                    true,
                    None,
                ),
            }
        }
        Command::SyncChannel {
            channel_generation,
            channel,
            ..
        } => {
            match client_ops::fetch_history(&cc.client, &cc.tenant, &cc.token, &channel, &cancelled)
            {
                Ok(history) => {
                    let board = client_ops::project_board(&history);
                    // Pins send no message or event, so every sync re-reads them. A failure
                    // (or an older server) shows none rather than failing the history.
                    let pins = client_ops::fetch_pins(&cc.client, &cc.tenant, &cc.token, &channel)
                        .unwrap_or_default();
                    let mut messages = history.messages;
                    let keep = crate::state::MAX_CACHED_MESSAGES;
                    if messages.len() > keep {
                        messages.drain(..messages.len() - keep);
                    }
                    emit(
                        tx,
                        wake,
                        UiEvent::ChannelSynced {
                            generation,
                            channel_generation,
                            channel,
                            messages,
                            head: history.head,
                            revision: history.revision,
                            board,
                            pins,
                        },
                    );
                }
                Err(err) => emit_error(
                    tx,
                    wake,
                    generation,
                    Some(channel_generation),
                    "sync-channel",
                    err,
                    true,
                    None,
                ),
            }
        }
        Command::LoadReceipts {
            channel_generation,
            channel,
            ..
        } => match client_ops::fetch_receipts(&cc.client, &cc.tenant, &cc.token, &channel) {
            Ok(receipts) => emit(
                tx,
                wake,
                UiEvent::Receipts {
                    generation,
                    channel_generation,
                    channel,
                    receipts,
                },
            ),
            Err(err) => emit_error(
                tx,
                wake,
                generation,
                Some(channel_generation),
                "receipts",
                err,
                false,
                None,
            ),
        },
        Command::Search {
            channel_generation,
            channel,
            query,
            text,
            from,
            before,
            ..
        } => match client_ops::search_messages(
            &cc.client,
            &cc.tenant,
            &cc.token,
            &channel,
            &text,
            from.as_deref(),
            before,
        ) {
            Ok(page) => emit(
                tx,
                wake,
                UiEvent::SearchResults {
                    generation,
                    channel_generation,
                    channel,
                    query,
                    page,
                },
            ),
            Err(err) => emit_error(
                tx,
                wake,
                generation,
                Some(channel_generation),
                "search",
                err,
                false,
                None,
            ),
        },
        Command::LoadMessage {
            channel_generation,
            channel,
            id,
            ..
        } => {
            let message =
                match client_ops::load_parent(&cc.client, &cc.tenant, &cc.token, &channel, id) {
                    Ok(message) => message,
                    Err(err) => {
                        return emit_error(
                            tx,
                            wake,
                            generation,
                            Some(channel_generation),
                            "load-message",
                            err,
                            false,
                            None,
                        );
                    }
                };
            emit(
                tx,
                wake,
                UiEvent::MessageLoaded {
                    generation,
                    channel_generation,
                    channel,
                    id,
                    message,
                },
            );
        }
        Command::LoadSnapshots {
            channel_generation,
            channel,
            ..
        } => match client_ops::fetch_snapshots(&cc.client, &cc.tenant, &cc.token, &channel) {
            Ok(view) => emit(
                tx,
                wake,
                UiEvent::Snapshots {
                    generation,
                    channel_generation,
                    channel,
                    view,
                },
            ),
            Err(err) => emit_error(
                tx,
                wake,
                generation,
                Some(channel_generation),
                "load-snapshots",
                err,
                true,
                None,
            ),
        },
        Command::SendMessage {
            channel_generation,
            channel,
            username,
            text,
            key,
            reply_to,
            correlation_id,
            to,
            ..
        } => {
            let result = client_ops::send_message(
                &cc.client,
                &cc.tenant,
                &cc.token,
                &channel,
                &username,
                &text,
                &key,
                Correlation {
                    reply_to,
                    correlation_id,
                    to,
                },
                &cancelled,
            );
            match result {
                Ok(outcome) => emit(
                    tx,
                    wake,
                    UiEvent::MessageSent {
                        generation,
                        channel_generation,
                        channel,
                        key,
                        id: outcome.id,
                    },
                ),
                Err(send_err) => emit_error(
                    tx,
                    wake,
                    generation,
                    Some(channel_generation),
                    "send-message",
                    send_err.cli_error,
                    send_err.retryable,
                    Some(key),
                ),
            }
        }
        Command::SendTaskEvent {
            channel_generation,
            channel,
            username,
            key,
            request,
            ..
        } => {
            let result = client_ops::send_task_event(
                &cc.client,
                &cc.tenant,
                &cc.token,
                &channel,
                &username,
                &request.task,
                request.event,
                &key,
                &cancelled,
            );
            match result {
                Ok(_) => emit(
                    tx,
                    wake,
                    UiEvent::TaskEventSent {
                        generation,
                        channel_generation,
                        channel,
                        key,
                    },
                ),
                Err(send_err) => emit_error(
                    tx,
                    wake,
                    generation,
                    Some(channel_generation),
                    "send-task-event",
                    send_err.cli_error,
                    send_err.retryable,
                    Some(key),
                ),
            }
        }
    }
}

fn emit(tx: &SyncSender<UiEvent>, wake: &Wake, event: UiEvent) {
    if tx.send(event).is_ok() {
        wake();
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_error(
    tx: &SyncSender<UiEvent>,
    wake: &Wake,
    generation: u64,
    channel_generation: Option<u64>,
    context: &'static str,
    err: CliError,
    retryable: bool,
    key: Option<String>,
) {
    if matches!(err, CliError::Auth(_)) {
        emit(
            tx,
            wake,
            UiEvent::AuthFailed {
                generation,
                message: err.to_string(),
            },
        );
        return;
    }
    emit(
        tx,
        wake,
        UiEvent::Error {
            generation,
            channel_generation,
            context,
            message: err.to_string(),
            retryable,
            key,
        },
    );
}

/// Long-lived per-connection subscription to `GET /api/tenants/:tenant/events`.
///
/// Phase 1 drains the journal from cursor 0 with `wait=0` (bounded) without emitting per-event
/// notifications, then emits `EventsReady`; the UI only starts canonical reads after that, so
/// nothing between the cursor and the reads can be missed. Phase 2 long-polls from the last
/// validated `nextCursor`. A page that fails validation is never applied and the cursor never
/// advances past it; the subscription stops fail-closed with a visible notice.
fn spawn_events_subscription(
    origin: Url,
    tenant: String,
    token: String,
    generation: u64,
    marker: Arc<AtomicU64>,
    tx: SyncSender<UiEvent>,
    wake: Wake,
) {
    thread::Builder::new()
        .name("msn-desktop-events".into())
        .spawn(move || {
            let stop = |notice: String| {
                emit(
                    &tx,
                    &wake,
                    UiEvent::EventsStatus {
                        generation,
                        notice: Some(notice),
                        stopped: true,
                    },
                );
            };
            let client = match MsnClient::new(&origin) {
                Ok(client) => client,
                Err(err) => return stop(err.to_string()),
            };
            let mut cursor = 0u64;
            let mut ready = false;
            let mut drain_pages = 0u64;
            let mut backoff = BACKOFF_START;
            let mut degraded = false;
            loop {
                if marker.load(Ordering::SeqCst) != generation {
                    return;
                }
                let wait = if ready { events::EVENTS_WAIT_SECONDS } else { 0 };
                match events::fetch_events(
                    &client,
                    &tenant,
                    &token,
                    cursor,
                    events::EVENTS_PAGE_LIMIT,
                    wait,
                    None,
                ) {
                    Ok(page) => {
                        if marker.load(Ordering::SeqCst) != generation {
                            return;
                        }
                        backoff = BACKOFF_START;
                        if degraded {
                            degraded = false;
                            emit(
                                &tx,
                                &wake,
                                UiEvent::EventsStatus {
                                    generation,
                                    notice: None,
                                    stopped: false,
                                },
                            );
                        }
                        cursor = page.next_cursor;
                        if !ready {
                            drain_pages += 1;
                            if !page.has_more {
                                ready = true;
                                emit(&tx, &wake, UiEvent::EventsReady { generation });
                            } else if drain_pages >= MAX_DRAIN_PAGES {
                                return stop(
                                    "Event journal is too large to synchronise; live updates are off."
                                        .into(),
                                );
                            }
                        } else if !page.events.is_empty() {
                            emit(
                                &tx,
                                &wake,
                                UiEvent::CoordinationEvents {
                                    generation,
                                    events: page.events,
                                },
                            );
                        }
                    }
                    Err(events::EventsError::Auth(err)) => {
                        emit_error(&tx, &wake, generation, None, "events", err, false, None);
                        return;
                    }
                    Err(events::EventsError::Terminal(err)) => {
                        return stop(format!("Live updates stopped: {err}"));
                    }
                    Err(events::EventsError::Retry(err)) => {
                        degraded = true;
                        emit(
                            &tx,
                            &wake,
                            UiEvent::EventsStatus {
                                generation,
                                notice: Some(format!("Live updates interrupted, retrying: {err}")),
                                stopped: false,
                            },
                        );
                        // Sleep in short slices so a disconnect is noticed promptly.
                        let mut slept = Duration::ZERO;
                        while slept < backoff {
                            if marker.load(Ordering::SeqCst) != generation {
                                return;
                            }
                            thread::sleep(Duration::from_millis(100));
                            slept += Duration::from_millis(100);
                        }
                        backoff = (backoff * 2).min(BACKOFF_MAX);
                    }
                }
            }
        })
        .expect("spawn events subscription thread");
}
