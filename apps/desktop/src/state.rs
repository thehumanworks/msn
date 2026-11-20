//! Pure UI state and the reducer that folds [`UiEvent`]s into it.
//!
//! `AppState::apply` never touches the network; it mutates state and returns the follow-up
//! [`Command`]s to dispatch. That keeps generation guards, coalescing, deletion handling and the
//! history/subscription ordering unit-testable without a server (`tests/mock_server.rs` covers
//! the same behaviour end to end over real HTTP).

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use serde_json::Value;

use crate::net::client_ops::SnapshotView;
use crate::net::events::{CoordinationEvent, EventKind};
use crate::net::worker::{Command, TaskEventRequest, UiEvent};
use crate::profile::SaveOutcome;
use crate::read_marks::{Marks, Unread};

/// Bound on how many messages a channel keeps in memory. Oldest are evicted first.
pub const MAX_CACHED_MESSAGES: usize = 2000;
/// A sync that keeps landing behind the events we already saw is abandoned after this many tries.
const MAX_STALE_SYNCS: u32 = 5;

#[derive(Debug, PartialEq, Eq)]
pub enum Screen {
    Connect,
    Workspace,
}

/// Deliberately holds no credentials: the token lives only in the network worker.
#[derive(Debug, Clone)]
pub struct PendingConnect {
    pub generation: u64,
    pub tenant: String,
}

#[derive(Debug, Clone)]
pub struct Connection {
    pub generation: u64,
    pub tenant: String,
    pub username: String,
}

#[derive(Debug, Clone)]
pub struct PendingSend {
    pub generation: u64,
    pub channel_generation: u64,
    pub channel: String,
    pub text: String,
    pub reply_to: Option<u64>,
    pub correlation_id: Option<String>,
    pub to: Option<String>,
    pub error: Option<String>,
    pub retryable: bool,
}

#[derive(Debug, Clone)]
pub struct PendingTaskEvent {
    pub generation: u64,
    pub channel_generation: u64,
    pub channel: String,
    pub request: TaskEventRequest,
    pub error: Option<String>,
    pub retryable: bool,
}

/// Coalesces repeated invalidations: at most one request in flight plus one queued rerun.
#[derive(Debug, Default, Clone, Copy)]
pub struct Flight {
    pub inflight: bool,
    pub dirty: bool,
}

impl Flight {
    /// `true` if the caller should issue the request now.
    fn request(&mut self) -> bool {
        if self.inflight {
            self.dirty = true;
            false
        } else {
            self.inflight = true;
            true
        }
    }

    /// The request finished; `true` if a rerun was queued meanwhile (it is marked in flight).
    fn finish(&mut self) -> bool {
        self.inflight = false;
        if self.dirty {
            self.dirty = false;
            self.inflight = true;
            true
        } else {
            false
        }
    }

    fn fail(&mut self) {
        self.inflight = false;
        self.dirty = false;
    }
}

/// The channel's search view (ADR 0037): the words asked for and the matches loaded so far.
#[derive(Debug, Default)]
pub struct SearchState {
    /// Numbers each search; only the answer to the newest one is shown.
    pub query: u64,
    pub text: String,
    pub from: Option<String>,
    pub results: Vec<Value>,
    pub has_more: bool,
    pub next_before: Option<u64>,
    pub complete: bool,
    pub inflight: bool,
    pub error: Option<String>,
    /// A search has been asked for since the channel opened (or the view was cleared).
    pub active: bool,
}

#[derive(Debug, Default)]
pub struct ChannelState {
    pub messages: BTreeMap<u64, Value>,
    pub head: u64,
    pub revision: u64,
    pub loaded: bool,
    pub error: Option<String>,
    pub sync: Flight,
    pub stale_streak: u32,
    /// Lower bounds implied by events already seen: a sync older than these is rejected.
    pub required_head: u64,
    pub required_revision: u64,
    pub snapshots: SnapshotView,
    pub snapshots_flight: Flight,
    pub snapshots_error: Option<String>,
    pub task_board: Option<Value>,
    pub task_board_error: Option<String>,
    /// The owner's pinned messages, shown above the conversation (ADR 0038).
    pub pins: Vec<Value>,
    pub search: SearchState,
    /// Explicit commit positions (ADR 0040); empty until loaded or on a server without them.
    pub receipts: Vec<msn_cli::receipts::Receipt>,
    pub receipts_flight: Flight,
    /// Thread roots the person opened (ADR 0041). Display only; kept across syncs.
    pub expanded: BTreeSet<u64>,
    /// Parents fetched for replies whose parent is not loaded; `None` means it no longer exists.
    pub parents: BTreeMap<u64, Option<Value>>,
    pub parents_inflight: BTreeSet<u64>,
    /// Someone else's replies that arrived after the first load into a folded thread, and have
    /// not been shown yet. Cleared when their thread opens.
    pub unseen: BTreeSet<u64>,
    /// `thread_rows` for the key it was built for; the chat tab asks every frame.
    pub(crate) rows_cache: RefCell<Option<(RowsKey, Rc<Vec<ThreadRow>>)>>,
}

/// What `thread_rows` depends on. Messages are only ever added, replaced or removed, so their
/// count and bounds with the sync revision and head identify a set of messages.
type RowsKey = (usize, u64, u64, u64, u64, Vec<u64>, Vec<u64>);

/// One row of the conversation as the chat tab draws it (ADR 0041).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThreadRow {
    /// A message in the log: not a reply, or a reply whose parent is not loaded. `replies`
    /// counts every loaded reply folded under it, replies to replies included.
    Message {
        id: u64,
        replies: usize,
        open: bool,
        /// Replies in this folded thread that arrived since the first load and are unseen.
        unseen: usize,
    },
    /// A reply shown under its open thread root.
    Reply { id: u64 },
}

impl ChannelState {
    /// Folds replies under the message they answer. A reply to a reply joins the same thread,
    /// so threads are one level deep. Rows keep id order, and replies keep id order within a
    /// thread; the messages themselves, and the cursors, are untouched.
    pub fn thread_rows(&self) -> Rc<Vec<ThreadRow>> {
        let key: RowsKey = (
            self.messages.len(),
            self.messages.keys().next().copied().unwrap_or(0),
            self.messages.keys().next_back().copied().unwrap_or(0),
            self.revision,
            self.head,
            self.expanded.iter().copied().collect(),
            self.unseen.iter().copied().collect(),
        );
        if let Some((cached, rows)) = self.rows_cache.borrow().as_ref()
            && *cached == key
        {
            return Rc::clone(rows);
        }
        let rows = Rc::new(self.build_rows());
        *self.rows_cache.borrow_mut() = Some((key, Rc::clone(&rows)));
        rows
    }

    /// The root each loaded message is drawn under (itself when it is not a folded reply).
    pub fn roots(&self) -> BTreeMap<u64, u64> {
        let mut root_of: BTreeMap<u64, u64> = BTreeMap::new();
        for (&id, message) in &self.messages {
            let root = message["replyTo"]
                .as_u64()
                .and_then(|parent| root_of.get(&parent).copied())
                .unwrap_or(id);
            root_of.insert(id, root);
        }
        root_of
    }

    /// The oldest unseen reply and its root: what "New reply in thread" points at.
    pub fn first_unseen(&self) -> Option<(u64, u64)> {
        let id = *self.unseen.iter().next()?;
        Some((*self.roots().get(&id)?, id))
    }

    /// Opens the thread that holds `id` (its root, or `id` itself when it is a root).
    pub fn open_thread_of(&mut self, id: u64) {
        let Some(&root) = self.roots().get(&id) else {
            return;
        };
        self.expanded.insert(root);
        self.clear_unseen(root);
    }

    fn clear_unseen(&mut self, root: u64) {
        let roots = self.roots();
        self.unseen.retain(|id| roots.get(id) != Some(&root));
    }

    fn build_rows(&self) -> Vec<ThreadRow> {
        let mut root_of: BTreeMap<u64, u64> = BTreeMap::new();
        let mut replies: BTreeMap<u64, Vec<u64>> = BTreeMap::new();
        let mut top = Vec::new();
        for (&id, message) in &self.messages {
            let parent = message["replyTo"]
                .as_u64()
                .and_then(|parent| root_of.get(&parent).copied());
            match parent {
                Some(root) => {
                    root_of.insert(id, root);
                    replies.entry(root).or_default().push(id);
                }
                None => {
                    root_of.insert(id, id);
                    top.push(id);
                }
            }
        }
        let mut rows = Vec::with_capacity(self.messages.len());
        for id in top {
            let thread = replies.remove(&id).unwrap_or_default();
            let open = !thread.is_empty() && self.expanded.contains(&id);
            let unseen = if open {
                0
            } else {
                thread.iter().filter(|r| self.unseen.contains(r)).count()
            };
            rows.push(ThreadRow::Message {
                id,
                replies: thread.len(),
                open,
                unseen,
            });
            if open {
                rows.extend(thread.into_iter().map(|id| ThreadRow::Reply { id }));
            }
        }
        rows
    }

    fn replace_messages(&mut self, messages: Vec<Value>) {
        self.messages.clear();
        for message in messages {
            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                self.messages.insert(id, message);
            }
        }
        while self.messages.len() > MAX_CACHED_MESSAGES {
            let Some(&smallest) = self.messages.keys().next() else {
                break;
            };
            self.messages.remove(&smallest);
        }
    }
}

#[derive(Debug, Default)]
pub struct AppState {
    pub pending_connect: Option<PendingConnect>,
    pub connection: Option<Connection>,
    pub connect_error: Option<String>,
    pub events_ready: bool,
    pub events_notice: Option<String>,
    pub events_stopped: bool,

    pub channels: Vec<String>,
    pub channels_flight: Flight,
    pub channels_error: Option<String>,

    pub selected_channel: Option<String>,
    pub channel_generation: u64,
    pub channel: Option<ChannelState>,

    pub pending_sends: BTreeMap<String, PendingSend>,
    pub pending_task_events: BTreeMap<String, PendingTaskEvent>,
    deferred: Vec<Command>,

    pub status: Option<String>,
    /// Outcome of "Save as profile" for the current connection.
    pub profile_save: Option<SaveOutcome>,

    /// Where this reader stopped on each board, on this computer only (ADR 0045).
    pub read_marks: Marks,
    /// The last counts the server gave, each for the mark it was asked about.
    pub unread: BTreeMap<String, Unread>,
    /// The list reloaded or the marks were loaded: every board's count needs asking again.
    pub unread_stale: bool,
    /// Boards whose count changed since it was asked (an event there, or the person left it).
    pub unread_stale_boards: BTreeSet<String>,
    pub unread_inflight: bool,
    /// The boards the request in flight asks about; `None` while it asks about every board.
    unread_asked: Option<Vec<String>>,
}

impl AppState {
    pub fn screen(&self) -> Screen {
        if self.connection.is_some() {
            Screen::Workspace
        } else {
            Screen::Connect
        }
    }

    pub fn begin_connect(&mut self, generation: u64, tenant: String) {
        *self = AppState {
            pending_connect: Some(PendingConnect { generation, tenant }),
            ..AppState::default()
        };
    }

    fn generation(&self) -> Option<u64> {
        self.connection.as_ref().map(|c| c.generation)
    }

    fn is_current_channel(&self, generation: u64, channel_generation: u64, channel: &str) -> bool {
        self.generation() == Some(generation)
            && self.channel_generation == channel_generation
            && self.selected_channel.as_deref() == Some(channel)
    }

    fn list_command(&mut self) -> Option<Command> {
        let generation = self.generation()?;
        self.channels_flight
            .request()
            .then_some(Command::ListChannels { generation })
    }

    fn sync_command(&mut self) -> Option<Command> {
        let generation = self.generation()?;
        let channel = self.selected_channel.clone()?;
        let channel_generation = self.channel_generation;
        let state = self.channel.as_mut()?;
        state.sync.request().then_some(Command::SyncChannel {
            generation,
            channel_generation,
            channel,
        })
    }

    /// Reloads processed-by receipts for the open channel; the app also calls this on a timer,
    /// because a commit is not a channel event.
    pub fn receipts_command(&mut self) -> Option<Command> {
        let generation = self.generation()?;
        let channel = self.selected_channel.clone()?;
        let channel_generation = self.channel_generation;
        let state = self.channel.as_mut()?;
        state
            .receipts_flight
            .request()
            .then_some(Command::LoadReceipts {
                generation,
                channel_generation,
                channel,
            })
    }

    fn snapshots_command(&mut self) -> Option<Command> {
        let generation = self.generation()?;
        let channel = self.selected_channel.clone()?;
        let channel_generation = self.channel_generation;
        let state = self.channel.as_mut()?;
        state
            .snapshots_flight
            .request()
            .then_some(Command::LoadSnapshots {
                generation,
                channel_generation,
                channel,
            })
    }

    pub fn request_channels(&mut self) -> Vec<Command> {
        self.list_command().into_iter().collect()
    }

    /// The counts request when they are stale and none is in flight. The app calls this on a
    /// throttle; it is only ever made stale by the list loading or by events, never by a timer.
    pub fn unread_command(&mut self) -> Option<Command> {
        if !self.unread_pending() || self.unread_inflight || !self.events_ready {
            return None;
        }
        let connection = self.connection.as_ref()?;
        let all = self.unread_stale;
        let mut marks = self.read_marks.for_listed(&self.channels);
        if !all {
            // Only the boards that changed: the others' counts still hold.
            marks.retain(|(name, _)| self.unread_stale_boards.contains(name));
        }
        self.unread_stale = false;
        self.unread_stale_boards.clear();
        if marks.is_empty() {
            if all {
                self.unread.clear();
            }
            return None;
        }
        self.unread_inflight = true;
        self.unread_asked = (!all).then(|| marks.iter().map(|(name, _)| name.clone()).collect());
        Some(Command::LoadUnread {
            generation: connection.generation,
            me: connection.username.clone(),
            marks,
        })
    }

    /// Whether some count is waiting to be asked for.
    pub fn unread_pending(&self) -> bool {
        self.unread_stale || !self.unread_stale_boards.is_empty()
    }

    /// The count to show beside a board: none for the open board (it is being read), and none
    /// once the board's mark has moved past what was counted.
    pub fn unread_for(&self, channel: &str) -> Option<&Unread> {
        if self.selected_channel.as_deref() == Some(channel) {
            return None;
        }
        self.unread
            .get(channel)
            .filter(|entry| self.read_marks.get(channel) == Some(entry.after) && entry.count > 0)
    }

    /// Moves the open board's mark to `seen`, the newest message whose top reached the visible
    /// conversation. The app calls this only while the window has focus and the conversation is
    /// showing. A reply still folded away is not read: the mark waits just below it. Returns
    /// whether the mark moved.
    pub fn mark_read(&mut self, seen: u64) -> bool {
        let (Some(channel), Some(state)) = (self.selected_channel.as_deref(), &self.channel) else {
            return false;
        };
        if !state.loaded || !state.messages.contains_key(&seen) {
            return false;
        }
        let mut newest = seen;
        if let Some(&unseen) = state.unseen.iter().next() {
            newest = newest.min(unseen.saturating_sub(1));
        }
        if newest == 0 {
            return false;
        }
        self.read_marks.advance(channel, newest)
    }

    /// Starts (or restarts) a channel: bumps `channel_generation` so any in-flight response for
    /// the previous channel or earlier load is rejected when it lands, then issues a fresh
    /// history sync and snapshot load. Refuses until the event cursor is established.
    pub fn select_channel(&mut self, channel: String) -> Vec<Command> {
        if self.generation().is_none() || !self.events_ready {
            return Vec::new();
        }
        self.channel_generation += 1;
        // The board being left was read up to now; its count is asked again from the new mark.
        if let Some(previous) = self.selected_channel.take() {
            self.unread_stale_boards.insert(previous);
        }
        self.selected_channel = Some(channel);
        self.channel = Some(ChannelState::default());
        [self.sync_command(), self.snapshots_command()]
            .into_iter()
            .flatten()
            .collect()
    }

    /// Starts a new search of the selected channel. `input` is what the person typed; a
    /// `from:name` word becomes the sender filter. Empty input clears the view.
    pub fn search(&mut self, input: &str) -> Vec<Command> {
        let (text, from) = msn_cli::search::split_from(input);
        let Some(state) = self.channel.as_mut() else {
            return Vec::new();
        };
        if text.is_empty() && from.is_none() {
            state.search = SearchState::default();
            return Vec::new();
        }
        let query = state.search.query + 1;
        state.search = SearchState {
            query,
            text,
            from,
            active: true,
            ..SearchState::default()
        };
        self.search_command(None).into_iter().collect()
    }

    /// Loads the next page of older matches for the current search.
    pub fn search_older(&mut self) -> Vec<Command> {
        let Some(before) = self
            .channel
            .as_ref()
            .filter(|state| state.search.has_more && !state.search.inflight)
            .and_then(|state| state.search.next_before)
        else {
            return Vec::new();
        };
        self.search_command(Some(before)).into_iter().collect()
    }

    fn search_command(&mut self, before: Option<u64>) -> Option<Command> {
        let generation = self.generation()?;
        let channel = self.selected_channel.clone()?;
        let channel_generation = self.channel_generation;
        let search = &mut self.channel.as_mut()?.search;
        search.inflight = true;
        search.error = None;
        Some(Command::Search {
            generation,
            channel_generation,
            channel,
            query: search.query,
            text: search.text.clone(),
            from: search.from.clone(),
            before,
        })
    }

    /// Opens or folds the thread under `root` in the selected channel.
    pub fn toggle_thread(&mut self, root: u64) {
        if let Some(state) = self.channel.as_mut()
            && !state.expanded.remove(&root)
        {
            state.expanded.insert(root);
            state.clear_unseen(root);
        }
    }

    /// Opens the thread holding `id` in the selected channel: after sending a reply to it, or
    /// to show an unseen reply.
    pub fn open_thread_of(&mut self, id: u64) {
        if let Some(state) = self.channel.as_mut() {
            state.open_thread_of(id);
        }
    }

    /// Fetches the parent of a reply whose parent is not loaded, once (ADR 0041).
    pub fn load_parent(&mut self, id: u64) -> Vec<Command> {
        let Some(generation) = self.generation() else {
            return Vec::new();
        };
        let Some(channel) = self.selected_channel.clone() else {
            return Vec::new();
        };
        let channel_generation = self.channel_generation;
        let Some(state) = self.channel.as_mut() else {
            return Vec::new();
        };
        if state.messages.contains_key(&id)
            || state.parents.contains_key(&id)
            || !state.parents_inflight.insert(id)
        {
            return Vec::new();
        }
        vec![Command::LoadMessage {
            generation,
            channel_generation,
            channel,
            id,
        }]
    }

    /// Commands that could not be queued earlier (worker queue full); retry when convenient.
    pub fn take_deferred(&mut self) -> Vec<Command> {
        let generation = self.generation();
        let channel_generation = self.channel_generation;
        std::mem::take(&mut self.deferred)
            .into_iter()
            .filter(|command| match command {
                Command::ListChannels { generation: g } => Some(*g) == generation,
                Command::SyncChannel {
                    generation: g,
                    channel_generation: c,
                    ..
                }
                | Command::LoadSnapshots {
                    generation: g,
                    channel_generation: c,
                    ..
                }
                | Command::LoadReceipts {
                    generation: g,
                    channel_generation: c,
                    ..
                } => Some(*g) == generation && *c == channel_generation,
                _ => false,
            })
            .collect()
    }

    /// A command was refused by the bounded queue. Nothing is dropped silently: user intents
    /// surface a retryable error with their key/payload intact; invalidations are deferred.
    pub fn on_rejected(&mut self, command: Command) {
        const BUSY: &str = "The app is busy (request queue full). Try again in a moment.";
        match command {
            Command::Connect { .. } => {
                self.pending_connect = None;
                self.connect_error = Some(BUSY.into());
            }
            Command::SendMessage { key, .. } => {
                if let Some(pending) = self.pending_sends.get_mut(&key) {
                    pending.error = Some(BUSY.into());
                    pending.retryable = true;
                }
            }
            Command::SendTaskEvent { key, .. } => {
                if let Some(pending) = self.pending_task_events.get_mut(&key) {
                    pending.error = Some(BUSY.into());
                    pending.retryable = true;
                }
            }
            Command::CreateChannel { .. } => self.channels_error = Some(BUSY.into()),
            Command::LoadUnread { marks, .. } => {
                self.unread_inflight = false;
                match self.unread_asked.take() {
                    None => self.unread_stale = true,
                    Some(_) => self
                        .unread_stale_boards
                        .extend(marks.into_iter().map(|(name, _)| name)),
                }
            }
            Command::Search { query, .. } => {
                if let Some(search) = self
                    .channel
                    .as_mut()
                    .map(|state| &mut state.search)
                    .filter(|search| search.query == query)
                {
                    search.inflight = false;
                    search.error = Some(BUSY.into());
                }
            }
            Command::LoadMessage { id, .. } => {
                if let Some(state) = self.channel.as_mut() {
                    state.parents_inflight.remove(&id);
                }
                self.status = Some(BUSY.into());
            }
            Command::Disconnect => {}
            invalidation => {
                let duplicate = self
                    .deferred
                    .iter()
                    .any(|d| std::mem::discriminant(d) == std::mem::discriminant(&invalidation));
                if !duplicate {
                    self.deferred.push(invalidation);
                }
            }
        }
    }

    /// Folds one background event into state, returning any follow-up commands to issue.
    pub fn apply(&mut self, event: UiEvent) -> Vec<Command> {
        match event {
            UiEvent::Connected {
                generation,
                username,
            } => {
                let Some(pending) = self.pending_connect.take_if(|p| p.generation == generation)
                else {
                    return Vec::new();
                };
                self.connection = Some(Connection {
                    generation,
                    tenant: pending.tenant,
                    username,
                });
                self.events_ready = false;
                self.status = Some("Synchronising with the event stream…".into());
                Vec::new()
            }
            UiEvent::ProfileSaved {
                generation,
                outcome,
            } => {
                if self.generation() == Some(generation) {
                    self.profile_save = Some(outcome);
                }
                Vec::new()
            }
            UiEvent::EventsReady { generation } => {
                if self.generation() != Some(generation) {
                    return Vec::new();
                }
                self.events_ready = true;
                self.status = None;
                self.request_channels()
            }
            UiEvent::EventsStatus {
                generation,
                notice,
                stopped,
            } => {
                if self.generation() == Some(generation) {
                    self.events_notice = notice;
                    self.events_stopped = stopped;
                    if stopped {
                        self.status = None;
                    }
                }
                Vec::new()
            }
            UiEvent::Channels {
                generation,
                channels,
            } => {
                if self.generation() != Some(generation) {
                    return Vec::new();
                }
                self.channels = channels;
                self.channels_error = None;
                self.unread_stale = true;
                self.channels_flight
                    .finish()
                    .then_some(Command::ListChannels { generation })
                    .into_iter()
                    .collect()
            }
            UiEvent::ChannelCreated {
                generation,
                channel,
            } => {
                if self.generation() != Some(generation) {
                    return Vec::new();
                }
                let mut commands = self.request_channels();
                commands.extend(self.select_channel(channel));
                commands
            }
            UiEvent::ChannelSynced {
                generation,
                channel_generation,
                channel,
                messages,
                head,
                revision,
                board,
                pins,
            } => {
                if !self.is_current_channel(generation, channel_generation, &channel) {
                    return Vec::new();
                }
                self.apply_sync(
                    generation,
                    channel_generation,
                    channel,
                    messages,
                    head,
                    revision,
                    board,
                    pins,
                )
            }
            UiEvent::Receipts {
                generation,
                channel_generation,
                channel,
                receipts,
            } => {
                if !self.is_current_channel(generation, channel_generation, &channel) {
                    return Vec::new();
                }
                let Some(state) = self.channel.as_mut() else {
                    return Vec::new();
                };
                state.receipts = receipts;
                if state.receipts_flight.finish() {
                    vec![Command::LoadReceipts {
                        generation,
                        channel_generation,
                        channel,
                    }]
                } else {
                    Vec::new()
                }
            }
            UiEvent::Snapshots {
                generation,
                channel_generation,
                channel,
                view,
            } => {
                if !self.is_current_channel(generation, channel_generation, &channel) {
                    return Vec::new();
                }
                let Some(state) = self.channel.as_mut() else {
                    return Vec::new();
                };
                let rerun = state.snapshots_flight.finish();
                state.snapshots = view;
                state.snapshots_error = None;
                if rerun {
                    vec![Command::LoadSnapshots {
                        generation,
                        channel_generation,
                        channel,
                    }]
                } else {
                    Vec::new()
                }
            }
            UiEvent::MessageSent {
                generation,
                channel_generation,
                channel,
                key,
                id,
            } => {
                self.pending_sends.remove(&key);
                if !self.is_current_channel(generation, channel_generation, &channel) {
                    return Vec::new();
                }
                if let Some(state) = self.channel.as_mut() {
                    state.required_head = state.required_head.max(id);
                }
                self.sync_command().into_iter().collect()
            }
            UiEvent::TaskEventSent {
                generation,
                channel_generation,
                channel,
                key,
            } => {
                self.pending_task_events.remove(&key);
                if !self.is_current_channel(generation, channel_generation, &channel) {
                    return Vec::new();
                }
                self.sync_command().into_iter().collect()
            }
            UiEvent::CoordinationEvents { generation, events } => {
                self.apply_coordination_events(generation, &events)
            }
            UiEvent::Unread { generation, counts } => {
                if self.generation() != Some(generation) {
                    return Vec::new();
                }
                self.unread_inflight = false;
                let asked = self.unread_asked.take();
                if let Some(counts) = counts {
                    match asked {
                        None => self.unread.clear(),
                        Some(asked) => {
                            for name in asked {
                                self.unread.remove(&name);
                            }
                        }
                    }
                    self.unread.extend(
                        counts
                            .into_iter()
                            .map(|entry| (entry.channel.clone(), entry)),
                    );
                }
                Vec::new()
            }
            UiEvent::SearchResults {
                generation,
                channel_generation,
                channel,
                query,
                page,
            } => {
                if !self.is_current_channel(generation, channel_generation, &channel) {
                    return Vec::new();
                }
                if let Some(search) = self
                    .channel
                    .as_mut()
                    .map(|state| &mut state.search)
                    .filter(|search| search.query == query && search.active)
                {
                    search.inflight = false;
                    search.error = None;
                    search.results.extend(page.messages);
                    search.has_more = page.has_more;
                    search.next_before = page.next_before;
                    search.complete = page.complete;
                }
                Vec::new()
            }
            UiEvent::MessageLoaded {
                generation,
                channel_generation,
                channel,
                id,
                message,
            } => {
                if !self.is_current_channel(generation, channel_generation, &channel) {
                    return Vec::new();
                }
                if let Some(state) = self.channel.as_mut() {
                    state.parents_inflight.remove(&id);
                    state.parents.insert(id, message);
                }
                Vec::new()
            }
            UiEvent::Error {
                generation,
                channel_generation,
                context,
                message,
                retryable,
                key,
            } => {
                self.apply_error(
                    generation,
                    channel_generation,
                    context,
                    message,
                    retryable,
                    key,
                );
                Vec::new()
            }
            UiEvent::AuthFailed {
                generation,
                message,
            } => {
                let pending = self
                    .pending_connect
                    .as_ref()
                    .is_some_and(|p| p.generation == generation);
                if !pending && self.generation() != Some(generation) {
                    return Vec::new();
                }
                *self = AppState {
                    connect_error: Some(format!("Session ended: {message}")),
                    ..AppState::default()
                };
                vec![Command::Disconnect]
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_sync(
        &mut self,
        generation: u64,
        channel_generation: u64,
        channel: String,
        messages: Vec<Value>,
        head: u64,
        revision: u64,
        board: Result<Value, String>,
        pins: Vec<Value>,
    ) -> Vec<Command> {
        let Some(state) = self.channel.as_mut() else {
            return Vec::new();
        };
        let rerun = state.sync.finish();
        let again = Command::SyncChannel {
            generation,
            channel_generation,
            channel,
        };
        if revision < state.required_revision || head < state.required_head {
            state.stale_streak += 1;
            if state.stale_streak > MAX_STALE_SYNCS {
                state.sync.fail();
                state.error = Some(
                    "The server's history is behind its own event stream; try reloading.".into(),
                );
                return Vec::new();
            }
            state.sync.inflight = true;
            return vec![again];
        }
        state.stale_streak = 0;
        let before: BTreeSet<u64> = if state.loaded {
            state.messages.keys().copied().collect()
        } else {
            BTreeSet::new()
        };
        let first = !state.loaded;
        state.replace_messages(messages);
        // Someone else's reply that lands in a folded thread after the first load is unseen.
        let roots = state.roots();
        let me = self.connection.as_ref().map(|c| c.username.as_str());
        state.unseen.retain(|id| roots.contains_key(id));
        if !first {
            for (&id, message) in &state.messages {
                let root = roots[&id];
                if root != id
                    && !before.contains(&id)
                    && !state.expanded.contains(&root)
                    && message["username"].as_str() != me
                {
                    state.unseen.insert(id);
                }
            }
        }
        state.head = head;
        state.revision = revision;
        state.loaded = true;
        state.error = None;
        state.pins = pins;
        match board {
            Ok(board) => {
                state.task_board = Some(board);
                state.task_board_error = None;
            }
            Err(message) => {
                state.task_board = None;
                state.task_board_error = Some(message);
            }
        }
        let mut commands = if rerun { vec![again] } else { Vec::new() };
        commands.extend(self.receipts_command());
        commands
    }

    fn apply_coordination_events(
        &mut self,
        generation: u64,
        events: &[CoordinationEvent],
    ) -> Vec<Command> {
        if self.generation() != Some(generation) || !self.events_ready {
            return Vec::new();
        }
        let mut list = false;
        let mut sync = false;
        let mut snapshots = false;
        for event in events {
            // A message added to or removed from another board changes its count.
            if matches!(
                event.kind,
                EventKind::MessageCreated | EventKind::MessageDeleted
            ) && self.selected_channel.as_deref() != Some(event.channel.as_str())
            {
                self.unread_stale_boards.insert(event.channel.clone());
            }
            match event.kind {
                EventKind::ChannelCreated => list = true,
                _ if self.selected_channel.as_deref() != Some(event.channel.as_str()) => {}
                EventKind::MessageCreated => {
                    if let Some(state) = self.channel.as_mut() {
                        state.required_head =
                            state.required_head.max(event.resource_id.unwrap_or(0));
                        state.required_revision =
                            state.required_revision.max(event.history_revision);
                    }
                    sync = true;
                }
                EventKind::MessageDeleted => {
                    if let Some(state) = self.channel.as_mut() {
                        // Purge immediately: deleted content must not linger while re-fetching,
                        // and everything derived from history is invalid until the rescan lands.
                        if let Some(id) = event.resource_id {
                            state.messages.remove(&id);
                        }
                        state.task_board = None;
                        state.snapshots = SnapshotView::default();
                        state.required_revision =
                            state.required_revision.max(event.history_revision);
                    }
                    sync = true;
                    snapshots = true;
                }
                EventKind::SnapshotPublished => snapshots = true,
            }
        }
        let mut commands = Vec::new();
        if list {
            commands.extend(self.list_command());
        }
        if sync {
            commands.extend(self.sync_command());
        }
        if snapshots {
            commands.extend(self.snapshots_command());
        }
        commands
    }

    fn apply_error(
        &mut self,
        generation: u64,
        channel_generation: Option<u64>,
        context: &'static str,
        message: String,
        retryable: bool,
        key: Option<String>,
    ) {
        let pending_connect = self
            .pending_connect
            .as_ref()
            .is_some_and(|p| p.generation == generation);
        if self.generation() != Some(generation) && !pending_connect {
            return;
        }
        if let Some(key) = key {
            if let Some(pending) = self.pending_sends.get_mut(&key) {
                pending.error = Some(message);
                pending.retryable = retryable;
            } else if let Some(pending) = self.pending_task_events.get_mut(&key) {
                pending.error = Some(message);
                pending.retryable = retryable;
            }
            return;
        }
        match context {
            "connect" => {
                self.pending_connect = None;
                self.connect_error = Some(message);
            }
            "list-channels" => {
                self.channels_flight.fail();
                self.channels_error = Some(message);
            }
            "create-channel" => self.channels_error = Some(message),
            "search" => {
                if channel_generation != Some(self.channel_generation) {
                    return;
                }
                if let Some(state) = self.channel.as_mut() {
                    state.search.inflight = false;
                    state.search.error = Some(message);
                }
            }
            "load-message" => {
                if channel_generation != Some(self.channel_generation) {
                    return;
                }
                if let Some(state) = self.channel.as_mut() {
                    state.parents_inflight.clear();
                }
                self.status = Some(message);
            }
            // Receipts are an extra: an older server or a failed load keeps the last line shown.
            "receipts" => {
                if channel_generation == Some(self.channel_generation)
                    && let Some(state) = self.channel.as_mut()
                {
                    state.receipts_flight.fail();
                }
            }
            "sync-channel" | "load-snapshots" => {
                if channel_generation != Some(self.channel_generation) {
                    return;
                }
                let Some(state) = self.channel.as_mut() else {
                    return;
                };
                if context == "sync-channel" {
                    state.sync.fail();
                    state.error = Some(message);
                } else {
                    state.snapshots_flight.fail();
                    state.snapshots_error = Some(message);
                }
            }
            _ => self.status = Some(message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::client_ops::SearchPage;
    use serde_json::json;
    use url::Url;

    fn ready_state(generation: u64) -> AppState {
        let mut state = AppState::default();
        state.begin_connect(generation, "acme".into());
        state.apply(UiEvent::Connected {
            generation,
            username: "alice".into(),
        });
        state.apply(UiEvent::EventsReady { generation });
        state
    }

    fn msg(id: u64, text: &str) -> Value {
        json!({"id": id, "text": text})
    }

    fn synced(
        state: &mut AppState,
        messages: Vec<Value>,
        head: u64,
        revision: u64,
    ) -> Vec<Command> {
        let (generation, cg) = (state.generation().unwrap(), state.channel_generation);
        let channel = state.selected_channel.clone().unwrap();
        state.apply(UiEvent::ChannelSynced {
            generation,
            channel_generation: cg,
            channel,
            messages,
            head,
            revision,
            board: Ok(json!({"tasks": [], "warnings": []})),
            pins: Vec::new(),
        })
    }

    fn search_reply(state: &mut AppState, query: u64, ids: &[u64], has_more: bool) -> Vec<Command> {
        let (generation, cg) = (state.generation().unwrap(), state.channel_generation);
        state.apply(UiEvent::SearchResults {
            generation,
            channel_generation: cg,
            channel: state.selected_channel.clone().unwrap(),
            query,
            page: SearchPage {
                messages: ids.iter().map(|id| msg(*id, "found")).collect(),
                has_more,
                next_before: has_more.then(|| *ids.last().unwrap()),
                complete: true,
            },
        })
    }

    #[test]
    fn search_splits_sender_pages_older_and_ignores_stale_answers() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        let commands = state.search("deploy from:ada");
        let [
            Command::Search {
                query,
                text,
                from,
                before,
                ..
            },
        ] = commands.as_slice()
        else {
            panic!("expected one search command, got {commands:?}");
        };
        assert_eq!(
            (text.as_str(), from.as_deref(), *before),
            ("deploy", Some("ada"), None)
        );
        let first = *query;
        // A newer search replaces the first; the first's late answer is ignored.
        let second = match state.search("deploy").as_slice() {
            [Command::Search { query, .. }] => *query,
            other => panic!("expected a search, got {other:?}"),
        };
        search_reply(&mut state, first, &[9], false);
        assert!(state.channel.as_ref().unwrap().search.results.is_empty());
        search_reply(&mut state, second, &[8, 5], true);
        match state.search_older().as_slice() {
            [Command::Search { query, before, .. }] => {
                assert_eq!((*query, *before), (second, Some(5)))
            }
            other => panic!("expected an older page, got {other:?}"),
        }
        // Only one older page in flight at a time.
        assert!(state.search_older().is_empty());
        search_reply(&mut state, second, &[3], false);
        let search = &state.channel.as_ref().unwrap().search;
        let ids: Vec<_> = search
            .results
            .iter()
            .map(|m| m["id"].as_u64().unwrap())
            .collect();
        assert_eq!(ids, [8, 5, 3]);
        assert!(!search.has_more && !search.inflight);
        assert!(state.search_older().is_empty());
        // Empty input clears the view; switching channels starts empty too.
        assert!(state.search("  ").is_empty());
        assert!(!state.channel.as_ref().unwrap().search.active);
        state.search("x");
        state.select_channel("other".into());
        assert!(!state.channel.as_ref().unwrap().search.active);
    }

    fn event(
        kind: EventKind,
        channel: &str,
        resource: Option<u64>,
        revision: u64,
    ) -> CoordinationEvent {
        CoordinationEvent {
            id: 1,
            tenant: "acme".into(),
            channel: channel.into(),
            kind,
            resource_id: resource,
            history_revision: revision,
            created_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn unread_counts_follow_read_marks_and_other_boards_events() {
        let mut state = ready_state(1);
        state.apply(UiEvent::Channels {
            generation: 1,
            channels: vec!["general".into(), "ops".into(), "never".into()],
        });
        // No board has a mark yet: nothing to ask.
        assert!(state.unread_command().is_none());
        assert!(!state.unread_stale);

        // Reading general moves its mark to what reached the screen, and not past it.
        state.select_channel("general".into());
        synced(
            &mut state,
            vec![msg(1, "a"), msg(2, "b"), msg(3, "c")],
            3,
            0,
        );
        assert!(!state.mark_read(9), "only a loaded message can be seen");
        assert!(state.mark_read(2));
        assert!(!state.mark_read(1), "marks only move forward");
        assert_eq!(state.read_marks.get("general"), Some(2));
        state.read_marks.advance("ops", 10);

        // Another board's message makes the counts stale; the open board's does not.
        state.apply(UiEvent::CoordinationEvents {
            generation: 1,
            events: vec![event(EventKind::MessageCreated, "general", Some(4), 0)],
        });
        assert!(!state.unread_pending());
        state.apply(UiEvent::CoordinationEvents {
            generation: 1,
            events: vec![event(EventKind::MessageCreated, "ops", Some(11), 0)],
        });
        assert!(state.unread_pending());
        let Some(Command::LoadUnread { me, marks, .. }) = state.unread_command() else {
            panic!("expected a counts request");
        };
        assert_eq!(me, "alice");
        assert_eq!(
            marks,
            vec![("ops".into(), 10)],
            "only the board that changed"
        );
        assert!(state.unread_command().is_none(), "one request at a time");

        let count = |channel: &str, after, count, to_you| Unread {
            channel: channel.into(),
            after,
            count,
            to_you,
            capped: false,
        };
        state.apply(UiEvent::Unread {
            generation: 1,
            counts: Some(vec![count("ops", 10, 3, 1)]),
        });
        assert!(!state.unread_inflight);
        assert_eq!(state.unread_for("ops").map(|u| u.count), Some(3));
        assert!(
            state.unread_for("general").is_none(),
            "the open board shows none"
        );
        assert!(state.unread_for("never").is_none());
        // Reading ops moves its mark; the old count no longer applies.
        state.read_marks.advance("ops", 12);
        assert!(state.unread_for("ops").is_none());

        // A failed request ends quietly; a request the queue refused is retried later.
        state.unread_stale = true;
        let command = state.unread_command().unwrap();
        state.on_rejected(command);
        assert!(state.unread_stale && !state.unread_inflight);
        state.unread_command().unwrap();
        state.apply(UiEvent::Unread {
            generation: 1,
            counts: None,
        });
        assert!(!state.unread_inflight);
        assert_eq!(state.unread.len(), 1, "the last counts stay");
        // Leaving a board makes its count due again, from where the reader stopped.
        state.unread_inflight = false;
        state.select_channel("ops".into());
        let Some(Command::LoadUnread { marks, .. }) = state.unread_command() else {
            panic!("expected a counts request for the board left");
        };
        assert_eq!(marks, vec![("general".into(), 2)]);
        // A partial answer replaces only the boards it asked about.
        state.apply(UiEvent::Unread {
            generation: 1,
            counts: Some(vec![count("general", 2, 4, 0)]),
        });
        assert_eq!(state.unread.len(), 2);
        assert_eq!(state.unread_for("general").map(|u| u.count), Some(4));
        // An answer for an old connection is ignored.
        state.unread_inflight = true;
        state.apply(UiEvent::Unread {
            generation: 7,
            counts: Some(Vec::new()),
        });
        assert!(state.unread_inflight);
    }

    #[test]
    fn a_folded_reply_holds_the_read_mark_below_it() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        synced(
            &mut state,
            vec![msg(1, "a"), msg(2, "b"), msg(5, "c")],
            5,
            0,
        );
        state.channel.as_mut().unwrap().unseen.insert(4);
        assert!(state.mark_read(5));
        assert_eq!(state.read_marks.get("general"), Some(3));
    }

    #[test]
    fn reads_wait_for_the_event_cursor_so_history_cannot_race_the_subscription() {
        let mut state = AppState::default();
        state.begin_connect(1, "acme".into());
        let commands = state.apply(UiEvent::Connected {
            generation: 1,
            username: "alice".into(),
        });
        assert!(
            commands.is_empty(),
            "no canonical read before the cursor exists"
        );
        assert!(state.select_channel("general".into()).is_empty());
        let commands = state.apply(UiEvent::EventsReady { generation: 1 });
        assert!(matches!(
            commands.as_slice(),
            [Command::ListChannels { .. }]
        ));
        assert_eq!(state.select_channel("general".into()).len(), 2);
    }

    #[test]
    fn stale_connection_generation_is_dropped() {
        let mut state = ready_state(2);
        state.select_channel("general".into());
        let cg = state.channel_generation;
        let commands = state.apply(UiEvent::ChannelSynced {
            generation: 1,
            channel_generation: cg,
            channel: "general".into(),
            messages: vec![msg(1, "old")],
            head: 1,
            revision: 0,
            board: Ok(json!({})),
            pins: Vec::new(),
        });
        assert!(commands.is_empty());
        assert!(!state.channel.as_ref().unwrap().loaded);
    }

    #[test]
    fn stale_channel_generation_after_switch_is_dropped() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        let old = state.channel_generation;
        state.select_channel("random".into());
        state.apply(UiEvent::ChannelSynced {
            generation: 1,
            channel_generation: old,
            channel: "general".into(),
            messages: vec![msg(1, "leak")],
            head: 1,
            revision: 0,
            board: Ok(json!({})),
            pins: Vec::new(),
        });
        assert_eq!(state.selected_channel.as_deref(), Some("random"));
        assert!(state.channel.as_ref().unwrap().messages.is_empty());
    }

    #[test]
    fn a_sync_reloads_receipts_once_and_only_the_open_channel_keeps_them() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        let commands = synced(&mut state, vec![msg(1, "a")], 1, 0);
        assert!(
            matches!(commands.as_slice(), [Command::LoadReceipts { channel, .. }] if channel == "general")
        );
        // A second request while one is in flight is coalesced, not sent twice.
        assert!(state.receipts_command().is_none());
        let receipt = msn_cli::receipts::Receipt {
            name: "lead".into(),
            reader: Some("p1".into()),
            persona_id: Some("p1".into()),
            committed_through: Some(1),
            updated_at: None,
        };
        let cg = state.channel_generation;
        let rerun = state.apply(UiEvent::Receipts {
            generation: 1,
            channel_generation: cg,
            channel: "general".into(),
            receipts: vec![receipt.clone()],
        });
        assert!(matches!(rerun.as_slice(), [Command::LoadReceipts { .. }]));
        assert_eq!(
            state.channel.as_ref().unwrap().receipts,
            vec![receipt.clone()]
        );
        // A failed load is quiet and keeps what was shown.
        state.apply(UiEvent::Error {
            generation: 1,
            channel_generation: Some(cg),
            context: "receipts",
            message: "404".into(),
            retryable: false,
            key: None,
        });
        assert_eq!(state.status, None);
        assert_eq!(
            state.channel.as_ref().unwrap().receipts,
            vec![receipt.clone()]
        );
        assert!(state.receipts_command().is_some());
        // An answer for a channel that is no longer open is dropped.
        state.select_channel("random".into());
        state.apply(UiEvent::Receipts {
            generation: 1,
            channel_generation: cg,
            channel: "general".into(),
            receipts: vec![receipt],
        });
        assert!(state.channel.as_ref().unwrap().receipts.is_empty());
    }

    #[test]
    fn sync_replaces_history_instead_of_merging_old_content() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        synced(&mut state, vec![msg(1, "secret"), msg(2, "b")], 2, 0);
        synced(&mut state, vec![msg(2, "b")], 2, 1);
        let messages = &state.channel.as_ref().unwrap().messages;
        assert_eq!(messages.len(), 1);
        assert!(
            !messages.contains_key(&1),
            "deleted content must not survive a resync"
        );
    }

    #[test]
    fn message_deleted_purges_cache_and_derived_state_then_resyncs() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        synced(&mut state, vec![msg(1, "secret"), msg(2, "b")], 2, 0);
        state.apply(UiEvent::Snapshots {
            generation: 1,
            channel_generation: state.channel_generation,
            channel: "general".into(),
            view: SnapshotView {
                entries: vec![json!({"version": 1})],
                latest_text: Some((1, "derived from secret".into())),
            },
        });
        let commands = state.apply(UiEvent::CoordinationEvents {
            generation: 1,
            events: vec![event(EventKind::MessageDeleted, "general", Some(1), 1)],
        });
        let channel = state.channel.as_ref().unwrap();
        assert!(!channel.messages.contains_key(&1), "purged immediately");
        assert!(
            channel.task_board.is_none(),
            "derived task board invalidated"
        );
        assert!(channel.snapshots.entries.is_empty() && channel.snapshots.latest_text.is_none());
        assert!(
            commands
                .iter()
                .any(|c| matches!(c, Command::SyncChannel { .. }))
        );
        assert!(
            commands
                .iter()
                .any(|c| matches!(c, Command::LoadSnapshots { .. }))
        );
        // A scan that started before the deletion lands late with the old revision: rejected,
        // never resurrecting the deleted message.
        let commands = synced(&mut state, vec![msg(1, "secret"), msg(2, "b")], 2, 0);
        assert!(matches!(commands.as_slice(), [Command::SyncChannel { .. }]));
        assert!(!state.channel.as_ref().unwrap().messages.contains_key(&1));
        assert!(
            !state.channel.as_ref().unwrap().loaded
                || state.channel.as_ref().unwrap().messages.len() == 1
        );
    }

    #[test]
    fn message_created_refreshes_history_and_task_board_and_coalesces() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        synced(&mut state, vec![msg(1, "a")], 1, 0);
        let created = |id| event(EventKind::MessageCreated, "general", Some(id), 0);
        let commands = state.apply(UiEvent::CoordinationEvents {
            generation: 1,
            events: vec![created(2), created(3), created(4)],
        });
        assert_eq!(
            commands.len(),
            1,
            "burst coalesces into one sync (which also rebuilds the board)"
        );
        // More events while it is in flight only mark it dirty: no flood of queued commands.
        let commands = state.apply(UiEvent::CoordinationEvents {
            generation: 1,
            events: vec![created(5)],
        });
        assert!(commands.is_empty());
        // The first result predates event 5 (head 4 < required 5): stale, rerun without applying.
        let commands = synced(&mut state, vec![msg(1, "a"), msg(4, "d")], 4, 0);
        assert_eq!(commands.len(), 1);
        assert!(state.channel.as_ref().unwrap().task_board.is_some());
        let commands = synced(&mut state, vec![msg(1, "a"), msg(5, "e")], 5, 0);
        assert!(commands.is_empty());
        assert_eq!(state.channel.as_ref().unwrap().head, 5);
    }

    #[test]
    fn replayed_event_page_is_idempotent() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        synced(&mut state, vec![msg(1, "a")], 1, 0);
        let page = vec![event(EventKind::MessageCreated, "general", Some(2), 0)];
        let first = state.apply(UiEvent::CoordinationEvents {
            generation: 1,
            events: page.clone(),
        });
        let second = state.apply(UiEvent::CoordinationEvents {
            generation: 1,
            events: page,
        });
        assert_eq!(first.len(), 1);
        assert!(
            second.is_empty(),
            "replay while a sync is in flight adds no new command"
        );
        synced(&mut state, vec![msg(1, "a"), msg(2, "b")], 2, 0);
        synced(&mut state, vec![msg(1, "a"), msg(2, "b")], 2, 0);
        assert_eq!(
            state.channel.as_ref().unwrap().messages.len(),
            2,
            "no duplicate rows"
        );
    }

    #[test]
    fn events_for_other_channels_do_not_refresh_the_selected_one() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        let commands = state.apply(UiEvent::CoordinationEvents {
            generation: 1,
            events: vec![event(EventKind::MessageCreated, "random", Some(9), 0)],
        });
        assert!(commands.is_empty());
    }

    #[test]
    fn retry_key_and_payload_survive_failure() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        let cg = state.channel_generation;
        state.pending_sends.insert(
            "fixed-key".into(),
            PendingSend {
                generation: 1,
                channel_generation: cg,
                channel: "general".into(),
                text: "hello".into(),
                reply_to: Some(3),
                correlation_id: None,
                to: Some("bob".into()),
                error: None,
                retryable: false,
            },
        );
        state.apply(UiEvent::Error {
            generation: 1,
            channel_generation: Some(cg),
            context: "send-message",
            message: "503: retry".into(),
            retryable: true,
            key: Some("fixed-key".into()),
        });
        let pending = &state.pending_sends["fixed-key"];
        assert!(pending.retryable);
        assert_eq!(
            (
                pending.text.as_str(),
                pending.reply_to,
                pending.to.as_deref()
            ),
            ("hello", Some(3), Some("bob"))
        );
    }

    #[test]
    fn rejected_send_keeps_key_and_payload_and_is_retryable() {
        let mut state = ready_state(1);
        state.pending_sends.insert(
            "k".into(),
            PendingSend {
                generation: 1,
                channel_generation: 0,
                channel: "general".into(),
                text: "hello".into(),
                reply_to: None,
                correlation_id: None,
                to: None,
                error: None,
                retryable: false,
            },
        );
        state.on_rejected(Command::SendMessage {
            generation: 1,
            channel_generation: 0,
            channel: "general".into(),
            username: "alice".into(),
            text: "hello".into(),
            key: "k".into(),
            reply_to: None,
            correlation_id: None,
            to: None,
        });
        let pending = &state.pending_sends["k"];
        assert!(pending.retryable && pending.error.is_some());
        assert_eq!(pending.text, "hello");
    }

    #[test]
    fn a_profile_save_outcome_only_applies_to_the_connection_that_requested_it() {
        let mut state = AppState::default();
        state.begin_connect(2, "acme".into());
        state.apply(UiEvent::Connected {
            generation: 2,
            username: "alice".into(),
        });
        state.apply(UiEvent::ProfileSaved {
            generation: 1,
            outcome: SaveOutcome::Saved("stale".into()),
        });
        assert_eq!(state.profile_save, None, "an older connection's outcome");
        state.apply(UiEvent::ProfileSaved {
            generation: 2,
            outcome: SaveOutcome::Saved("alice-acme".into()),
        });
        assert_eq!(
            state.profile_save,
            Some(SaveOutcome::Saved("alice-acme".into()))
        );
        // A new connection starts clean.
        state.begin_connect(3, "acme".into());
        assert_eq!(state.profile_save, None);
    }

    #[test]
    fn rejected_connect_and_invalidations_are_never_lost() {
        let mut state = AppState::default();
        state.begin_connect(1, "acme".into());
        state.on_rejected(Command::Connect {
            generation: 1,
            origin: Url::parse("https://msn.test").unwrap(),
            tenant: "acme".into(),
            token: "t".into(),
            chosen_username: None,
            save: None,
        });
        assert!(state.pending_connect.is_none() && state.connect_error.is_some());

        let mut state = ready_state(1);
        state.select_channel("general".into());
        let cg = state.channel_generation;
        let rejected = Command::SyncChannel {
            generation: 1,
            channel_generation: cg,
            channel: "general".into(),
        };
        state.on_rejected(rejected);
        assert_eq!(state.take_deferred().len(), 1, "deferred, then retried");
        // After a channel switch the deferred stale command is discarded, not resurrected.
        state.on_rejected(Command::SyncChannel {
            generation: 1,
            channel_generation: cg,
            channel: "general".into(),
        });
        state.select_channel("random".into());
        assert!(state.take_deferred().is_empty());
    }

    #[test]
    fn connect_error_clears_pending_connect() {
        let mut state = AppState::default();
        state.begin_connect(1, "acme".into());
        state.apply(UiEvent::Error {
            generation: 1,
            channel_generation: None,
            context: "connect",
            message: "nope".into(),
            retryable: false,
            key: None,
        });
        assert!(state.pending_connect.is_none());
        assert_eq!(state.connect_error.as_deref(), Some("nope"));
    }

    #[test]
    fn auth_failure_tears_down_session_and_requests_generation_advance() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        let commands = state.apply(UiEvent::AuthFailed {
            generation: 1,
            message: "401: revoked".into(),
        });
        assert!(state.connection.is_none() && state.channel.is_none());
        assert!(state.pending_sends.is_empty());
        assert!(state.connect_error.as_deref().unwrap().contains("revoked"));
        assert!(matches!(commands.as_slice(), [Command::Disconnect]));
        // Anything still in flight for the dead generation is ignored.
        assert!(
            state
                .apply(UiEvent::Channels {
                    generation: 1,
                    channels: vec!["x".into()]
                })
                .is_empty()
        );
        assert!(state.channels.is_empty());
    }

    #[test]
    fn invalid_event_stream_status_is_surfaced_and_stale_status_ignored() {
        let mut state = ready_state(2);
        state.apply(UiEvent::EventsStatus {
            generation: 1,
            notice: Some("stale".into()),
            stopped: true,
        });
        assert!(state.events_notice.is_none());
        state.apply(UiEvent::EventsStatus {
            generation: 2,
            notice: Some("Live updates stopped".into()),
            stopped: true,
        });
        assert!(state.events_stopped);
    }

    #[test]
    fn repeated_stale_syncs_give_up_with_an_error() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        state.apply(UiEvent::CoordinationEvents {
            generation: 1,
            events: vec![event(EventKind::MessageCreated, "general", Some(50), 0)],
        });
        let mut last = Vec::new();
        for _ in 0..=MAX_STALE_SYNCS {
            last = synced(&mut state, vec![], 1, 0);
        }
        assert!(last.is_empty());
        assert!(state.channel.as_ref().unwrap().error.is_some());
    }

    #[test]
    fn cache_is_bounded() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        let many: Vec<Value> = (1..=(MAX_CACHED_MESSAGES as u64 + 10))
            .map(|i| msg(i, "x"))
            .collect();
        let head = many.len() as u64;
        synced(&mut state, many, head, 0);
        let channel = state.channel.as_ref().unwrap();
        assert_eq!(channel.messages.len(), MAX_CACHED_MESSAGES);
        assert!(channel.messages.contains_key(&head));
    }

    fn reply(id: u64, to: u64) -> Value {
        json!({"id": id, "text": "re", "replyTo": to})
    }

    #[test]
    fn replies_fold_under_their_root_in_id_order_and_open_on_toggle() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        // 1 root; 2 replies to 1; 3 unrelated; 4 replies to 2 (joins 1's thread); 5 replies to 99
        // (not loaded), 6 replies to 5 (folds under the orphan).
        let messages = vec![
            msg(1, "root"),
            reply(2, 1),
            msg(3, "other"),
            reply(4, 2),
            reply(5, 99),
            reply(6, 5),
        ];
        synced(&mut state, messages, 6, 0);
        let rows = state.channel.as_ref().unwrap().thread_rows();
        assert_eq!(
            *rows,
            vec![
                ThreadRow::Message {
                    id: 1,
                    replies: 2,
                    open: false,
                    unseen: 0
                },
                ThreadRow::Message {
                    id: 3,
                    replies: 0,
                    open: false,
                    unseen: 0
                },
                ThreadRow::Message {
                    id: 5,
                    replies: 1,
                    open: false,
                    unseen: 0
                },
            ]
        );
        state.toggle_thread(1);
        let rows = state.channel.as_ref().unwrap().thread_rows();
        assert_eq!(
            &rows[..3],
            &[
                ThreadRow::Message {
                    id: 1,
                    replies: 2,
                    open: true,
                    unseen: 0
                },
                ThreadRow::Reply { id: 2 },
                ThreadRow::Reply { id: 4 },
            ]
        );
        // The messages themselves are untouched: still every id, in order.
        let ids: Vec<u64> = state
            .channel
            .as_ref()
            .unwrap()
            .messages
            .keys()
            .copied()
            .collect();
        assert_eq!(ids, vec![1, 2, 3, 4, 5, 6]);
        // A later sync keeps the open thread.
        synced(
            &mut state,
            vec![msg(1, "root"), reply(2, 1), reply(7, 1)],
            7,
            0,
        );
        let rows = state.channel.as_ref().unwrap().thread_rows();
        assert_eq!(
            *rows,
            vec![
                ThreadRow::Message {
                    id: 1,
                    replies: 2,
                    open: true,
                    unseen: 0
                },
                ThreadRow::Reply { id: 2 },
                ThreadRow::Reply { id: 7 },
            ]
        );
        state.toggle_thread(1);
        assert!(state.channel.as_ref().unwrap().expanded.is_empty());
    }

    #[test]
    fn a_missing_parent_is_fetched_once_and_a_late_answer_is_ignored() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        synced(&mut state, vec![reply(5, 2)], 5, 0);
        let commands = state.load_parent(2);
        assert!(matches!(
            commands.as_slice(),
            [Command::LoadMessage { id: 2, channel, .. }] if channel == "general"
        ));
        assert!(state.load_parent(2).is_empty(), "already in flight");
        assert!(state.load_parent(5).is_empty(), "already loaded");
        let cg = state.channel_generation;
        state.apply(UiEvent::MessageLoaded {
            generation: 1,
            channel_generation: cg,
            channel: "general".into(),
            id: 2,
            message: Some(json!({"id": 2, "username": "ada", "text": "plan"})),
        });
        let channel = state.channel.as_ref().unwrap();
        assert_eq!(channel.parents[&2].as_ref().unwrap()["text"], "plan");
        assert!(channel.parents_inflight.is_empty());
        assert!(state.load_parent(2).is_empty(), "fetched once");
        // An answer for a channel the person has left changes nothing.
        state.load_parent(3);
        state.select_channel("other".into());
        state.apply(UiEvent::MessageLoaded {
            generation: 1,
            channel_generation: cg,
            channel: "general".into(),
            id: 3,
            message: None,
        });
        assert!(state.channel.as_ref().unwrap().parents.is_empty());
    }

    fn reply_from(id: u64, to: u64, username: &str) -> Value {
        json!({"id": id, "text": "re", "replyTo": to, "username": username})
    }

    #[test]
    fn a_reply_that_lands_in_a_folded_thread_is_unseen_until_its_thread_opens() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        let history = vec![msg(1, "root"), reply_from(2, 1, "bob")];
        synced(&mut state, history.clone(), 2, 0);
        // The first load is not news.
        assert!(state.channel.as_ref().unwrap().unseen.is_empty());
        let mut later = history.clone();
        later.extend([
            msg(3, "other"),
            reply_from(4, 2, "bob"),
            reply_from(5, 1, "alice"),
        ]);
        synced(&mut state, later, 5, 0);
        let channel = state.channel.as_ref().unwrap();
        // 4 is bob's, in 1's folded thread; 5 is your own and never unseen.
        assert_eq!(channel.unseen.iter().copied().collect::<Vec<_>>(), vec![4]);
        assert_eq!(channel.first_unseen(), Some((1, 4)));
        assert_eq!(
            channel.thread_rows()[0],
            ThreadRow::Message {
                id: 1,
                replies: 3,
                open: false,
                unseen: 1
            }
        );
        // The pointer opens the thread that holds it.
        state.open_thread_of(4);
        let channel = state.channel.as_ref().unwrap();
        assert!(channel.expanded.contains(&1));
        assert_eq!(channel.first_unseen(), None);
    }

    #[test]
    fn sending_a_reply_opens_the_thread_it_joins() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        synced(
            &mut state,
            vec![msg(1, "root"), reply_from(2, 1, "bob")],
            2,
            0,
        );
        // Replying to the reply 2 joins root 1's thread.
        state.open_thread_of(2);
        assert!(state.channel.as_ref().unwrap().expanded.contains(&1));
        // A parent that is not loaded opens nothing: the reply will stand in the log.
        state.open_thread_of(99);
        assert_eq!(state.channel.as_ref().unwrap().expanded.len(), 1);
    }

    #[test]
    fn thread_rows_are_cached_until_something_they_show_changes() {
        let mut state = ready_state(1);
        state.select_channel("general".into());
        synced(
            &mut state,
            vec![msg(1, "root"), reply_from(2, 1, "bob")],
            2,
            0,
        );
        let channel = state.channel.as_ref().unwrap();
        let first = channel.thread_rows();
        assert!(Rc::ptr_eq(&first, &channel.thread_rows()));
        state.toggle_thread(1);
        let channel = state.channel.as_ref().unwrap();
        assert!(!Rc::ptr_eq(&first, &channel.thread_rows()));
        assert_eq!(channel.thread_rows().len(), 2);
    }
}
