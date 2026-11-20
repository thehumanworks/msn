use std::sync::mpsc::{Receiver, sync_channel};

use eframe::egui;
use serde_json::{Value, json};
use uuid::Uuid;

use msn_cli::config::{MAX_SAFE_INTEGER, is_slug, parse_int, parse_origin, slug};
use msn_cli::identity::validate_username;

use crate::markdown;
use crate::net::worker::{Command, EVENT_QUEUE_CAPACITY, TaskEventRequest, UiEvent, Worker};
use crate::profile;
use crate::read_marks;
use crate::state::{
    AppState, ChannelState, PendingSend, PendingTaskEvent, Screen, SearchState, ThreadRow,
};
use crate::theme;

const ERROR_COLOR: egui::Color32 = egui::Color32::from_rgb(210, 80, 80);
const WARN_COLOR: egui::Color32 = egui::Color32::from_rgb(210, 140, 40);

pub struct MsnDesktopApp {
    worker: Worker,
    events_rx: Receiver<UiEvent>,
    state: AppState,
    connect_form: ConnectForm,
    composer: Composer,
    new_channel_name: String,
    active_tab: Tab,
    search_input: String,
    /// A reply the chat should scroll to on its next frame (the "New reply in thread" pointer).
    scroll_to: Option<u64>,
    /// The server the current connection talks to; message links (ADR 0042) start with it.
    link_origin: Option<url::Url>,
    /// A link waiting to go to the clipboard on the next frame (the clipboard needs the context).
    copied_link: Option<String>,
    /// When processed-by receipts were last asked for; commits are not channel events, so the
    /// open channel's receipts are reloaded on a timer (ADR 0040).
    receipts_at: Option<std::time::Instant>,
    /// `None` when neither `XDG_CONFIG_HOME` nor `HOME` is set.
    profile_store: Option<profile::ProfileStore>,
    /// This connection's read-mark file (ADR 0045), once the connection's name is known.
    read_marks_path: Option<(u64, Option<std::path::PathBuf>)>,
    /// When unread counts were last asked for; at most one request per `UNREAD_EVERY`.
    unread_at: Option<std::time::Instant>,
}

#[derive(Default)]
struct ConnectForm {
    connection_json: String,
    url: String,
    tenant: String,
    token: String,
    username: String,
    profile_name: String,
    profiles: Vec<profile::Summary>,
    profiles_error: Option<String>,
    /// Opt-in per connection: nothing is written to disk unless this is ticked.
    save_profile: bool,
    save_name: String,
}

#[derive(Default)]
struct Composer {
    text: String,
    to: String,
    reply_to: String,
    error: Option<String>,
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Tab {
    Chat,
    Search,
    Snapshots,
    Tasks,
}

enum Action {
    Select(String),
    Reload,
    Search,
    SearchOlder,
    ToggleThread(u64),
    ShowReply(u64),
    LoadParent(u64),
    CopyLink(u64),
    Send,
    RetrySend(String),
    DiscardSend(String),
    Claim(String),
    RetryTask(String),
    DismissTask(String),
    Disconnect,
}

impl MsnDesktopApp {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        theme::install(&cc.egui_ctx);
        let (events_tx, events_rx) = sync_channel(EVENT_QUEUE_CAPACITY);
        let ctx = cc.egui_ctx.clone();
        let worker = Worker::spawn(events_tx, move || ctx.request_repaint());
        let profile_store = profile::default_store();
        let (profiles, profiles_error) = profile::list(profile_store.as_ref());
        let connect_form = ConnectForm {
            url: msn_cli::config::DEFAULT_URL.to_string(),
            profiles,
            profiles_error,
            ..Default::default()
        };
        MsnDesktopApp {
            worker,
            events_rx,
            state: AppState::default(),
            connect_form,
            composer: Composer::default(),
            new_channel_name: String::new(),
            active_tab: Tab::Chat,
            search_input: String::new(),
            scroll_to: None,
            link_origin: None,
            copied_link: None,
            receipts_at: None,
            read_marks_path: None,
            unread_at: None,
            profile_store,
        }
    }

    fn refresh_profiles(&mut self) {
        let (profiles, error) = profile::list(self.profile_store.as_ref());
        self.connect_form.profiles = profiles;
        self.connect_form.profiles_error = error;
    }

    fn dispatch(&mut self, command: Command) {
        match command {
            Command::Disconnect => {
                self.worker.next_generation();
            }
            command => {
                if let Err(rejected) = self.worker.send(command) {
                    self.state.on_rejected(*rejected);
                }
            }
        }
    }

    fn dispatch_all(&mut self, commands: Vec<Command>) {
        for command in commands {
            self.dispatch(command);
        }
    }

    fn drain_events(&mut self) {
        while let Ok(event) = self.events_rx.try_recv() {
            let saved = matches!(event, UiEvent::ProfileSaved { .. });
            let commands = self.state.apply(event);
            self.dispatch_all(commands);
            if saved {
                // The request is spent: the next connection does not save again by accident.
                self.connect_form.save_profile = false;
                self.connect_form.save_name.clear();
                self.refresh_profiles();
            }
        }
        let deferred = self.state.take_deferred();
        self.dispatch_all(deferred);
        self.load_read_marks();
        if self.unread_at.is_none_or(|at| at.elapsed() >= UNREAD_EVERY)
            && let Some(command) = self.state.unread_command()
        {
            self.unread_at = Some(std::time::Instant::now());
            self.dispatch(command);
        }
        if self.state.channel.is_some()
            && self
                .receipts_at
                .is_none_or(|at| at.elapsed() >= RECEIPTS_EVERY)
        {
            self.receipts_at = Some(std::time::Instant::now());
            let command = self.state.receipts_command();
            self.dispatch_all(command.into_iter().collect());
        }
    }

    fn connect_screen(&mut self, ui: &mut egui::Ui) {
        ui.label(
            egui::RichText::new("msn")
                .size(30.0)
                .strong()
                .color(theme::ACCENT),
        );
        ui.label(egui::RichText::new("Sign in to your workspace").color(theme::MUTED));
        ui.add_space(10.0);
        ui.collapsing("Import account or channel connection", |ui| {
            ui.label("Paste an exported MSN connection to access the same boards on this device.");
            ui.add(
                theme::field(&mut self.connect_form.connection_json)
                    .password(true)
                    .desired_width(f32::INFINITY),
            );
            if ui.button("Use connection").clicked() {
                let parsed =
                    serde_json::from_str::<serde_json::Value>(&self.connect_form.connection_json);
                if let Ok(data) = parsed {
                    if let (Some(url), Some(tenant), Some(token), Some(username)) = (
                        data["url"].as_str(),
                        data["tenant"].as_str(),
                        data["token"].as_str(),
                        data["username"].as_str(),
                    ) {
                        self.connect_form.url = url.into();
                        self.connect_form.tenant = tenant.into();
                        self.connect_form.token = token.into();
                        self.connect_form.username = username.into();
                        self.connect_form.connection_json.clear();
                        self.connect_form.save_profile = true;
                    } else {
                        self.state.connect_error = Some("Invalid MSN connection file.".into());
                    }
                } else {
                    self.state.connect_error = Some("Paste exported MSN connection JSON.".into());
                }
            }
        });

        if !self.connect_form.profiles.is_empty() {
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new("Saved profile").color(theme::MUTED));
                let mut chosen = None;
                egui::ComboBox::from_id_salt("profile-picker")
                    .selected_text(if self.connect_form.profile_name.is_empty() {
                        "(none)"
                    } else {
                        &self.connect_form.profile_name
                    })
                    .show_ui(ui, |ui| {
                        for summary in &self.connect_form.profiles {
                            let label = format!(
                                "{}  —  {} @ {}",
                                summary.name, summary.username, summary.tenant
                            );
                            if ui
                                .selectable_label(
                                    self.connect_form.profile_name == summary.name,
                                    label,
                                )
                                .clicked()
                            {
                                chosen = Some(summary.name.clone());
                            }
                        }
                    });
                if let (Some(name), Some(store)) = (chosen, &self.profile_store) {
                    match store.load(&name) {
                        Ok(loaded) => {
                            self.connect_form.profile_name = name;
                            self.connect_form.url = loaded.url;
                            self.connect_form.tenant = loaded.tenant;
                            self.connect_form.token = loaded.token;
                            self.connect_form.username = loaded.username;
                            // Already saved: do not offer to save it again.
                            self.connect_form.save_profile = false;
                            self.state.connect_error = None;
                        }
                        Err(error) => self.state.connect_error = Some(error.to_string()),
                    }
                }
            });
            ui.add_space(8.0);
        }

        for (label, value, hint, password) in [
            (
                "Origin",
                &mut self.connect_form.url,
                "https://msn.example.workers.dev",
                false,
            ),
            ("Workspace", &mut self.connect_form.tenant, "", false),
            ("Access token", &mut self.connect_form.token, "", true),
            (
                "Username",
                &mut self.connect_form.username,
                "blank = the key's bound identity",
                false,
            ),
        ] {
            ui.label(egui::RichText::new(label).small().color(theme::MUTED));
            ui.add(
                theme::field(value)
                    .password(password)
                    .hint_text(hint)
                    .desired_width(f32::INFINITY),
            );
            ui.add_space(2.0);
        }

        if let Some(error) = &self.connect_form.profiles_error {
            ui.colored_label(WARN_COLOR, error);
        }
        ui.horizontal(|ui| {
            ui.checkbox(&mut self.connect_form.save_profile, "Save as profile");
            ui.add_enabled(
                self.connect_form.save_profile,
                theme::field(&mut self.connect_form.save_name)
                    .id(egui::Id::new("profile-name-input"))
                    .hint_text("name (optional: user-workspace)")
                    .desired_width(f32::INFINITY),
            );
        });

        ui.add_space(8.0);
        let connecting = self.state.pending_connect.is_some();
        let enter = ui.input(|i| i.key_pressed(egui::Key::Enter));
        ui.add_enabled_ui(!connecting, |ui| {
            let connect = egui::Button::new(
                egui::RichText::new("Connect")
                    .strong()
                    .color(egui::Color32::WHITE),
            )
            .fill(theme::MESSENGER_BLUE)
            .min_size(egui::vec2(0.0, 38.0));
            let clicked = ui
                .vertical_centered_justified(|ui| ui.add(connect).clicked())
                .inner;
            if clicked || (enter && !connecting) {
                self.try_connect();
            }
        });
        if connecting {
            ui.horizontal(|ui| {
                ui.spinner();
                ui.label("Connecting…");
            });
        }
        if let Some(error) = &self.state.connect_error {
            ui.colored_label(ERROR_COLOR, error);
        }
        ui.add_space(8.0);
        ui.label(
            egui::RichText::new(
                "The token is sent only to the origin above. It is written to disk only if you \
                 tick Save as profile: a private file in the msn profiles folder, shared with the \
                 msn CLI and readable only by your user.",
            )
            .small()
            .color(theme::MUTED),
        );
    }

    fn try_connect(&mut self) {
        let origin = match parse_origin(self.connect_form.url.trim()) {
            Ok(url) => url,
            Err(err) => {
                self.state.connect_error = Some(err.to_string());
                return;
            }
        };
        let tenant = self.connect_form.tenant.trim().to_string();
        if let Err(err) = slug(&tenant) {
            self.state.connect_error = Some(format!("Workspace: {err}"));
            return;
        }
        let token = self.connect_form.token.trim().to_string();
        if token.is_empty() {
            self.state.connect_error = Some("An access token is required.".into());
            return;
        }
        let username = self.connect_form.username.trim();
        let chosen_username = (!username.is_empty()).then(|| username.to_string());
        let save = if self.connect_form.save_profile {
            let Some(store) = self.profile_store.clone() else {
                self.state.connect_error =
                    Some("Set HOME or XDG_CONFIG_HOME to save profiles.".into());
                return;
            };
            let name = self.connect_form.save_name.trim();
            let name = (!name.is_empty()).then(|| name.to_string());
            // Fail before connecting rather than after: a taken or invalid name is a form error.
            if let Some(name) = &name
                && let Err(err) = store.check_new_name(name)
            {
                self.state.connect_error = Some(err.to_string());
                return;
            }
            Some(profile::SaveRequest { store, name })
        } else {
            None
        };
        let generation = self.worker.next_generation();
        self.state.begin_connect(generation, tenant.clone());
        self.link_origin = Some(origin.clone());
        self.dispatch(Command::Connect {
            generation,
            origin,
            tenant,
            token,
            chosen_username,
            save,
        });
    }

    fn workspace_screen(&mut self, ui: &mut egui::Ui) {
        let mut actions: Vec<Action> = Vec::new();
        egui::Panel::left("channels")
            .default_size(230.0)
            .min_size(190.0)
            .show_separator_line(false)
            .frame(theme::sidebar().outer_margin(egui::Margin {
                right: 12,
                ..Default::default()
            }))
            .show(ui, |ui| self.sidebar(ui, &mut actions));
        egui::CentralPanel::default()
            .frame(theme::glass())
            .show(ui, |ui| self.main_panel(ui, &mut actions));
        for action in actions {
            self.perform(action);
        }
    }

    fn sidebar(&mut self, ui: &mut egui::Ui, actions: &mut Vec<Action>) {
        ui.label(
            egui::RichText::new("msn")
                .size(28.0)
                .strong()
                .color(theme::ACCENT),
        );
        ui.add_space(6.0);
        if let Some(connection) = &self.state.connection {
            // Messenger-style "me" card: the presence dot reflects live synchronisation.
            let presence = if self.state.events_stopped {
                theme::BUSY
            } else if self.state.events_ready {
                theme::ONLINE
            } else {
                theme::AWAY
            };
            ui.horizontal(|ui| {
                theme::avatar(ui, &connection.username, 38.0, Some(presence));
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = 1.0;
                    ui.add(
                        egui::Label::new(egui::RichText::new(&connection.username).strong())
                            .truncate(),
                    );
                    ui.add(
                        egui::Label::new(
                            egui::RichText::new(&connection.tenant)
                                .small()
                                .color(theme::MUTED),
                        )
                        .truncate(),
                    );
                });
            });
        }
        let disconnect = egui::Button::new(
            egui::RichText::new("Disconnect")
                .small()
                .color(theme::MUTED),
        )
        .frame(false);
        if ui.add(disconnect).clicked() {
            actions.push(Action::Disconnect);
        }
        if let Some(outcome) = &self.state.profile_save {
            let (color, text) = match outcome {
                profile::SaveOutcome::Saved(name) => {
                    (theme::MUTED, format!("Saved as profile \"{name}\"."))
                }
                profile::SaveOutcome::AlreadySaved(name) => {
                    (theme::MUTED, format!("Already saved as \"{name}\"."))
                }
                profile::SaveOutcome::Failed(error) => {
                    (WARN_COLOR, format!("Profile not saved: {error}"))
                }
            };
            ui.label(egui::RichText::new(text).small().color(color));
        }
        ui.add_space(10.0);
        ui.label(
            egui::RichText::new("CHANNELS")
                .size(10.0)
                .color(theme::MUTED),
        );
        // The button is placed first, from the right, and the field takes exactly what is
        // left. A guessed button width would make the row wider than the panel and the panel,
        // which sizes itself from its content, would creep on every repaint.
        ui.allocate_ui_with_layout(
            egui::vec2(ui.available_width(), ui.spacing().interact_size.y),
            egui::Layout::right_to_left(egui::Align::Center),
            |ui| {
                ui.spacing_mut().item_spacing.x = 6.0;
                let create = egui::Button::new(egui::RichText::new("+").size(16.0))
                    .min_size(egui::Vec2::splat(32.0));
                let clicked = ui.add(create).on_hover_text("Create channel").clicked();
                let response = ui.add(
                    theme::field(&mut self.new_channel_name)
                        .hint_text("New channel")
                        .desired_width(ui.available_width()),
                );
                let enter = response.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                if clicked || enter {
                    self.create_channel();
                }
            },
        );
        if let Some(error) = &self.state.channels_error {
            ui.colored_label(ERROR_COLOR, error);
        }
        ui.add_space(4.0);
        if self.state.events_stopped && !self.state.events_ready {
            ui.colored_label(
                ERROR_COLOR,
                "Synchronisation stopped. Disconnect and reconnect after resolving the error.",
            );
        } else if !self.state.events_ready {
            ui.horizontal(|ui| {
                ui.spinner();
                ui.label("Synchronising…");
            });
        } else if self.state.channels_flight.inflight && self.state.channels.is_empty() {
            ui.spinner();
        } else if self.state.channels.is_empty() {
            ui.weak("No channels yet. Create one above.");
        }
        egui::ScrollArea::vertical().show(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 2.0;
            ui.with_layout(egui::Layout::top_down_justified(egui::Align::Min), |ui| {
                for name in &self.state.channels {
                    let selected = self.state.selected_channel.as_deref() == Some(name.as_str());
                    let unread = self.state.unread_for(name);
                    let response = ui.selectable_label(selected, channel_label(name, unread));
                    let response = match unread {
                        Some(entry) => response.on_hover_text(entry.label()),
                        None => response,
                    };
                    if response.clicked() && !selected {
                        actions.push(Action::Select(name.clone()));
                    }
                }
            });
        });
    }

    fn create_channel(&mut self) {
        let Some(generation) = self.state.connection.as_ref().map(|c| c.generation) else {
            return;
        };
        let name = self.new_channel_name.trim().to_string();
        if name.is_empty() {
            return;
        }
        if !is_slug(&name) {
            self.state.channels_error = Some(
                "Channel names use 1–64 lowercase letters, digits, _ or -, starting with a letter or digit."
                    .into(),
            );
            return;
        }
        self.state.channels_error = None;
        self.new_channel_name.clear();
        self.dispatch(Command::CreateChannel { generation, name });
    }

    fn main_panel(&mut self, ui: &mut egui::Ui, actions: &mut Vec<Action>) {
        if let Some(notice) = &self.state.events_notice {
            let color = if self.state.events_stopped {
                ERROR_COLOR
            } else {
                WARN_COLOR
            };
            ui.colored_label(color, notice);
        }
        if let Some(status) = &self.state.status {
            ui.weak(status);
        }
        let Some(channel) = self.state.selected_channel.clone() else {
            ui.centered_and_justified(|ui| {
                ui.weak("Select or create a channel to begin.");
            });
            return;
        };
        // One row when there is room; the tabs drop below the channel name when there is not.
        let stacked = ui.available_width() < 540.0;
        ui.horizontal(|ui| {
            // Reload is placed first, from the right, so the channel name truncates into
            // whatever width remains instead of pushing it out of the card.
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let reload = egui::Button::new(egui::RichText::new("Reload").color(theme::MUTED))
                    .frame(false);
                if ui.add(reload).clicked() {
                    actions.push(Action::Reload);
                }
                ui.with_layout(egui::Layout::left_to_right(egui::Align::Center), |ui| {
                    ui.add(egui::Label::new(egui::RichText::new(&channel).heading()).truncate());
                    if !stacked {
                        ui.add_space(6.0);
                        self.tab_bar(ui);
                    }
                });
            });
        });
        if stacked {
            ui.horizontal(|ui| self.tab_bar(ui));
        }
        ui.add_space(4.0);
        match self.active_tab {
            Tab::Chat => self.chat_tab(ui, actions),
            Tab::Search => self.search_tab(ui, actions),
            Tab::Snapshots => self.snapshots_tab(ui),
            Tab::Tasks => self.tasks_tab(ui, actions),
        }
    }

    /// Segmented control for the channel views.
    fn tab_bar(&mut self, ui: &mut egui::Ui) {
        egui::Frame::new()
            .fill(egui::Color32::from_white_alpha(9))
            .corner_radius(12)
            .inner_margin(3)
            .show(ui, |ui| {
                ui.spacing_mut().item_spacing.x = 2.0;
                ui.spacing_mut().interact_size.y = 28.0;
                ui.spacing_mut().button_padding = egui::vec2(12.0, 5.0);
                ui.selectable_value(&mut self.active_tab, Tab::Chat, "Chat");
                ui.selectable_value(&mut self.active_tab, Tab::Search, "Search");
                ui.selectable_value(&mut self.active_tab, Tab::Snapshots, "Snapshots");
                ui.selectable_value(&mut self.active_tab, Tab::Tasks, "Tasks");
            });
    }

    fn chat_tab(&mut self, ui: &mut egui::Ui, actions: &mut Vec<Action>) {
        // Reserve the composer before laying out the scrollable conversation. Its position
        // never depends on message count, loading state, or pending-send errors.
        egui::Panel::bottom("message-composer")
            .exact_size(
                90.0 + if self.composer.error.is_some() {
                    40.0
                } else {
                    0.0
                },
            )
            .show_separator_line(false)
            .frame(egui::Frame::new())
            .show(ui, |ui| self.composer_panel(ui, actions));
        if let Some(state) = self.state.channel.as_ref().filter(|s| !s.pins.is_empty()) {
            egui::Panel::top("pinned-messages")
                .show_separator_line(false)
                .frame(egui::Frame::new())
                .show(ui, |ui| render_pins(ui, &state.pins));
        }
        let me = self
            .state
            .connection
            .as_ref()
            .map(|connection| connection.username.clone())
            .unwrap_or_default();
        let scroll_to = self.scroll_to.take();
        // A reply that landed in a folded thread: point at it, since the log does not show it.
        if let Some((root, id)) = self.state.channel.as_ref().and_then(|s| s.first_unseen()) {
            egui::Panel::bottom("thread-pointer")
                .show_separator_line(false)
                .frame(egui::Frame::new().inner_margin(egui::Margin::symmetric(8, 4)))
                .show(ui, |ui| {
                    let label =
                        egui::RichText::new(format!("New reply in thread #{root} \u{b7} Show"))
                            .small()
                            .color(theme::ACCENT);
                    if ui.button(label).clicked() {
                        actions.push(Action::ShowReply(id));
                    }
                });
        }
        // The newest message whose top reached the visible conversation (ADR 0045).
        let mut seen = 0u64;
        egui::CentralPanel::default()
            .frame(egui::Frame::new().inner_margin(egui::Margin {
                bottom: 8,
                top: 8,
                ..Default::default()
            }))
            .show(ui, |ui| {
                egui::ScrollArea::vertical()
                    .id_salt("conversation-history")
                    .stick_to_bottom(true)
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        if let Some(state) = &self.state.channel {
                            if !state.loaded && state.error.is_none() {
                                ui.horizontal(|ui| {
                                    ui.spinner();
                                    ui.label("Loading history…");
                                });
                            }
                            if let Some(error) = &state.error {
                                ui.colored_label(ERROR_COLOR, error);
                            }
                            if state.loaded && state.messages.is_empty() {
                                ui.vertical_centered(|ui| {
                                    ui.add_space(24.0);
                                    ui.weak("Start the conversation.");
                                });
                            }
                            let mut day = "";
                            let rows = state.thread_rows();
                            for row in rows.iter() {
                                match *row {
                                    ThreadRow::Message {
                                        id,
                                        replies,
                                        open,
                                        unseen,
                                    } => {
                                        let message = &state.messages[&id];
                                        let created = message["createdAt"].as_str().unwrap_or("");
                                        let date = created.get(..10).unwrap_or("");
                                        if date != day {
                                            day = date;
                                            ui.vertical_centered(|ui| {
                                                ui.label(
                                                    egui::RichText::new(format_day(date))
                                                        .small()
                                                        .color(theme::MUTED),
                                                );
                                            });
                                        }
                                        if ui.cursor().top() < ui.clip_rect().bottom() {
                                            seen = seen.max(id);
                                        }
                                        render_message(ui, message, &me, actions);
                                        render_receipts(ui, message, &me, &state.receipts);
                                        render_parent(ui, state, message, actions);
                                        if replies > 0 {
                                            render_thread_toggle(
                                                ui,
                                                message,
                                                &me,
                                                ThreadToggle {
                                                    id,
                                                    replies,
                                                    open,
                                                    unseen,
                                                },
                                                actions,
                                            );
                                        }
                                    }
                                    ThreadRow::Reply { id } => {
                                        if ui.cursor().top() < ui.clip_rect().bottom() {
                                            seen = seen.max(id);
                                        }
                                        let shown = ui.indent(("thread-reply", id), |ui| {
                                            let reply = &state.messages[&id];
                                            render_message(ui, reply, &me, actions);
                                            render_receipts(ui, reply, &me, &state.receipts);
                                        });
                                        if scroll_to == Some(id) {
                                            shown.response.scroll_to_me(Some(egui::Align::Center));
                                        }
                                    }
                                }
                                ui.add_space(4.0);
                            }
                        }
                        for (key, pending) in &self.state.pending_sends {
                            render_pending(ui, key, pending, actions);
                        }
                    });
            });
        // A window in the background is not being read.
        if ui.input(|input| input.focused) && self.state.mark_read(seen) {
            self.save_read_marks();
        }
    }

    fn composer_panel(&mut self, ui: &mut egui::Ui, actions: &mut Vec<Action>) {
        // Laid out upwards from the bottom edge so the input never moves when an error or a
        // narrow window changes what sits above it.
        ui.with_layout(egui::Layout::bottom_up(egui::Align::Min), |ui| {
            let input_id = egui::Id::new("message-input");
            let focused = ui.memory(|memory| memory.has_focus(input_id));
            theme::message_pill(focused).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 8.0;
                    let response = ui.add(
                        egui::TextEdit::singleline(&mut self.composer.text)
                            .id(input_id)
                            .frame(egui::Frame::new().inner_margin(egui::Margin::symmetric(0, 6)))
                            .hint_text("Type a message…")
                            .desired_width((ui.available_width() - 38.0).max(60.0)),
                    );
                    let enter =
                        response.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                    let armed = !self.composer.text.trim().is_empty();
                    if theme::send_button(ui, armed).clicked() || enter {
                        actions.push(Action::Send);
                        response.request_focus();
                    }
                });
            });
            // Addressing: compact fields whose widths adapt instead of wrapping.
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 6.0;
                let label = |text: &str| egui::RichText::new(text).small().color(theme::MUTED);
                ui.add_space(6.0);
                ui.label(label("To"));
                let to_width = (ui.available_width() - 130.0).clamp(56.0, 150.0);
                ui.add(
                    egui::TextEdit::singleline(&mut self.composer.to)
                        .margin(egui::Margin::symmetric(10, 5))
                        .font(egui::TextStyle::Small)
                        .hint_text(egui::RichText::new("everyone").small())
                        .desired_width(to_width),
                );
                ui.add_space(6.0);
                ui.label(label("Reply to #"));
                ui.add(
                    egui::TextEdit::singleline(&mut self.composer.reply_to)
                        .margin(egui::Margin::symmetric(10, 5))
                        .font(egui::TextStyle::Small)
                        .desired_width(44.0),
                );
            });
            if let Some(error) = &self.composer.error {
                ui.colored_label(ERROR_COLOR, error);
            }
        });
    }

    /// Board search (ADR 0037): words, "a phrase" or from:name; newest matches first.
    fn search_tab(&mut self, ui: &mut egui::Ui, actions: &mut Vec<Action>) {
        let Some(state) = self.state.channel.as_ref() else {
            return;
        };
        ui.horizontal(|ui| {
            let response = ui.add(
                theme::field(&mut self.search_input)
                    .hint_text("Search words, \"a phrase\" or from:name")
                    .desired_width((ui.available_width() - 80.0).max(80.0)),
            );
            let enter = response.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
            if ui.button("Search").clicked() || enter {
                actions.push(Action::Search);
            }
        });
        ui.add_space(4.0);
        let search = &state.search;
        if let Some(error) = &search.error {
            ui.colored_label(ERROR_COLOR, error);
        }
        if !search.active {
            ui.weak("Find earlier messages on this board by words or sender.");
            return;
        }
        ui.horizontal(|ui| {
            if search.inflight {
                ui.spinner();
            }
            ui.label(
                egui::RichText::new(search_summary(search))
                    .small()
                    .color(theme::MUTED),
            );
        });
        let me = self
            .state
            .connection
            .as_ref()
            .map(|connection| connection.username.clone())
            .unwrap_or_default();
        egui::ScrollArea::vertical()
            .id_salt("search-results")
            .auto_shrink([false, false])
            .show(ui, |ui| {
                for message in &search.results {
                    render_message(ui, message, &me, actions);
                    ui.add_space(4.0);
                }
                if search.has_more && !search.inflight && ui.button("Older matches").clicked() {
                    actions.push(Action::SearchOlder);
                }
            });
    }

    fn snapshots_tab(&self, ui: &mut egui::Ui) {
        let Some(state) = self.state.channel.as_ref() else {
            return;
        };
        if let Some(error) = &state.snapshots_error {
            ui.colored_label(ERROR_COLOR, error);
        }
        if state.snapshots_flight.inflight && state.snapshots.entries.is_empty() {
            ui.spinner();
        } else if state.snapshots.entries.is_empty() {
            ui.weak("No snapshots published yet.");
        }
        egui::ScrollArea::vertical().show(ui, |ui| {
            if let Some((version, text)) = &state.snapshots.latest_text {
                ui.strong(format!("Latest valid snapshot (v{version})"));
                theme::card().show(ui, |ui| {
                    ui.set_min_width(ui.available_width());
                    ui.label(text);
                });
                ui.add_space(6.0);
            }
            for entry in state.snapshots.entries.iter().rev() {
                let version = entry["version"].as_u64().unwrap_or(0);
                let author = entry["username"].as_str().unwrap_or("?");
                let covers = entry["coversThrough"].as_u64().unwrap_or(0);
                let invalidated = entry["invalidated"].as_bool().unwrap_or(false);
                ui.horizontal(|ui| {
                    ui.label(format!("v{version} by {author}, covers through #{covers}"));
                    if invalidated {
                        ui.colored_label(WARN_COLOR, "invalidated by deletion");
                    }
                });
            }
        });
    }

    fn tasks_tab(&mut self, ui: &mut egui::Ui, actions: &mut Vec<Action>) {
        let Some(state) = self.state.channel.as_ref() else {
            return;
        };
        ui.weak(
            "Board projected by the CLI's authoritative msn.task.v1 reducer from canonical history. \
             Delivery of a message never implies task completion.",
        );
        if let Some(error) = &state.task_board_error {
            ui.colored_label(ERROR_COLOR, error);
        }
        let Some(board) = state.task_board.as_ref() else {
            if state.error.is_none() && state.task_board_error.is_none() {
                ui.horizontal(|ui| {
                    ui.spinner();
                    ui.label("Refreshing task board…");
                });
            }
            return;
        };
        let tasks = board["tasks"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        let warnings = board["warnings"].as_array().map(Vec::len).unwrap_or(0);
        if tasks.is_empty() {
            ui.weak("No tasks opened in this channel.");
        }
        if warnings > 0 {
            ui.colored_label(
                WARN_COLOR,
                format!("{warnings} projection warning(s) in history"),
            );
        }
        egui::ScrollArea::vertical().show(ui, |ui| {
            for task in tasks {
                render_task(ui, task, actions);
            }
        });
        for (key, pending) in &self.state.pending_task_events {
            if let Some(error) = &pending.error {
                ui.horizontal_wrapped(|ui| {
                    ui.colored_label(ERROR_COLOR, format!("{}: {error}", pending.request.task));
                    if pending.retryable && ui.button("Retry").clicked() {
                        actions.push(Action::RetryTask(key.clone()));
                    }
                    if ui.button("Dismiss").clicked() {
                        actions.push(Action::DismissTask(key.clone()));
                    }
                });
            }
        }
    }

    fn perform(&mut self, action: Action) {
        match action {
            Action::Disconnect => {
                self.worker.next_generation();
                self.state = AppState::default();
                self.composer = Composer::default();
                self.refresh_profiles();
            }
            Action::Select(name) => {
                let commands = self.state.select_channel(name);
                self.dispatch_all(commands);
            }
            Action::Reload => {
                if let Some(name) = self.state.selected_channel.clone() {
                    let commands = self.state.select_channel(name);
                    self.dispatch_all(commands);
                }
            }
            Action::Search => {
                let commands = self.state.search(&self.search_input);
                self.dispatch_all(commands);
            }
            Action::SearchOlder => {
                let commands = self.state.search_older();
                self.dispatch_all(commands);
            }
            Action::ToggleThread(root) => self.state.toggle_thread(root),
            Action::ShowReply(id) => {
                self.state.open_thread_of(id);
                self.scroll_to = Some(id);
            }
            Action::LoadParent(id) => {
                let commands = self.state.load_parent(id);
                self.dispatch_all(commands);
            }
            Action::CopyLink(id) => {
                if let Some(link) = self.message_link(id) {
                    self.copied_link = Some(link);
                    self.state.status = Some(format!("Link to message #{id} copied."));
                }
            }
            Action::Send => self.send_composer_message(),
            Action::RetrySend(key) => self.retry_send(&key),
            Action::DiscardSend(key) => {
                self.state.pending_sends.remove(&key);
            }
            Action::Claim(task) => self.send_task_action(&task, json!({"action": "claim"})),
            Action::RetryTask(key) => self.retry_task_event(&key),
            Action::DismissTask(key) => {
                self.state.pending_task_events.remove(&key);
            }
        }
    }

    fn send_composer_message(&mut self) {
        let (Some(connection), Some(channel)) = (
            self.state.connection.clone(),
            self.state.selected_channel.clone(),
        ) else {
            return;
        };
        let text = self.composer.text.trim().to_string();
        if text.is_empty() {
            return;
        }
        let to = match self.composer.to.trim() {
            "" => None,
            name => match validate_username(name) {
                Ok(name) => Some(name),
                Err(err) => {
                    self.composer.error = Some(format!("To: {err}"));
                    return;
                }
            },
        };
        let reply_to = match self.composer.reply_to.trim() {
            "" => None,
            raw => match parse_int(raw, MAX_SAFE_INTEGER) {
                Ok(id) if id >= 1 => Some(id),
                _ => {
                    self.composer.error =
                        Some("Reply to must be a positive message number.".into());
                    return;
                }
            },
        };
        self.composer.error = None;
        self.composer.text.clear();
        // Your reply folds into its thread; open it so the reply does not seem to vanish.
        if let Some(parent) = reply_to {
            self.state.open_thread_of(parent);
        }
        let key = Uuid::new_v4().to_string();
        let channel_generation = self.state.channel_generation;
        self.state.pending_sends.insert(
            key.clone(),
            PendingSend {
                generation: connection.generation,
                channel_generation,
                channel: channel.clone(),
                text: text.clone(),
                reply_to,
                correlation_id: None,
                to: to.clone(),
                error: None,
                retryable: false,
            },
        );
        self.dispatch(Command::SendMessage {
            generation: connection.generation,
            channel_generation,
            channel,
            username: connection.username,
            text,
            key,
            reply_to,
            correlation_id: None,
            to,
        });
    }

    /// Re-sends the *same* key and payload; a new key is only ever minted for a new payload.
    fn retry_send(&mut self, key: &str) {
        let Some(username) = self.state.connection.as_ref().map(|c| c.username.clone()) else {
            return;
        };
        let Some(pending) = self.state.pending_sends.get_mut(key) else {
            return;
        };
        pending.error = None;
        let command = Command::SendMessage {
            generation: pending.generation,
            channel_generation: pending.channel_generation,
            channel: pending.channel.clone(),
            username,
            text: pending.text.clone(),
            key: key.to_string(),
            reply_to: pending.reply_to,
            correlation_id: pending.correlation_id.clone(),
            to: pending.to.clone(),
        };
        self.dispatch(command);
    }

    fn send_task_action(&mut self, task_id: &str, event: Value) {
        let (Some(connection), Some(channel)) = (
            self.state.connection.clone(),
            self.state.selected_channel.clone(),
        ) else {
            return;
        };
        let key = Uuid::new_v4().to_string();
        let request = TaskEventRequest {
            task: task_id.to_string(),
            event,
        };
        let channel_generation = self.state.channel_generation;
        self.state.pending_task_events.insert(
            key.clone(),
            PendingTaskEvent {
                generation: connection.generation,
                channel_generation,
                channel: channel.clone(),
                request: request.clone(),
                error: None,
                retryable: false,
            },
        );
        self.dispatch(Command::SendTaskEvent {
            generation: connection.generation,
            channel_generation,
            channel,
            username: connection.username,
            key,
            request,
        });
    }

    /// Reads this connection's marks from disk once, after the server confirmed the name.
    fn load_read_marks(&mut self) {
        let Some(connection) = self.state.connection.as_ref() else {
            return;
        };
        if self
            .read_marks_path
            .as_ref()
            .is_some_and(|(generation, _)| *generation == connection.generation)
        {
            return;
        }
        let path = self.link_origin.as_ref().and_then(|origin| {
            read_marks::default_path(origin, &connection.tenant, &connection.username)
        });
        self.state.read_marks = path
            .as_deref()
            .map(|path| read_marks::load(path, &connection.username))
            .unwrap_or_default();
        self.state.unread_stale = true;
        self.read_marks_path = Some((connection.generation, path));
    }

    /// Writes the marks after one moved. A failed write only costs counts after a restart.
    fn save_read_marks(&mut self) {
        let Some(connection) = self.state.connection.as_ref() else {
            return;
        };
        if let Some((generation, Some(path))) = &self.read_marks_path
            && *generation == connection.generation
        {
            let _ = read_marks::save(path, &connection.username, &self.state.read_marks);
        }
    }

    /// The web link to message `id` of the open channel (ADR 0042). It carries no credential.
    fn message_link(&self, id: u64) -> Option<String> {
        let origin = self.link_origin.as_ref()?;
        let tenant = &self.state.connection.as_ref()?.tenant;
        let channel = self.state.selected_channel.as_deref()?;
        Some(msn_cli::links::message_link(origin, tenant, channel, id))
    }

    fn retry_task_event(&mut self, key: &str) {
        let Some(username) = self.state.connection.as_ref().map(|c| c.username.clone()) else {
            return;
        };
        let Some(pending) = self.state.pending_task_events.get_mut(key) else {
            return;
        };
        pending.error = None;
        let command = Command::SendTaskEvent {
            generation: pending.generation,
            channel_generation: pending.channel_generation,
            channel: pending.channel.clone(),
            username,
            key: key.to_string(),
            request: pending.request.clone(),
        };
        self.dispatch(command);
    }
}

impl MsnDesktopApp {
    fn draw(&mut self, ui: &mut egui::Ui) {
        self.drain_events();
        if let Some(link) = self.copied_link.take() {
            ui.ctx().copy_text(link);
        }
        if self.state.channel.is_some() {
            // Wakes an idle window so the receipts timer in drain_events can fire.
            ui.ctx().request_repaint_after(RECEIPTS_EVERY);
        }
        theme::backdrop(ui);
        egui::CentralPanel::default()
            .frame(theme::outer())
            .show(ui, |ui| {
                match self.state.screen() {
                    Screen::Connect => {
                        // A sign-in card centred in the window, scrollable when the window
                        // is shorter than the form.
                        let available = ui.max_rect();
                        let width = available.width().min(440.0);
                        let top = available.top() + ((available.height() - 520.0) / 2.0).max(0.0);
                        let rect = egui::Rect::from_min_max(
                            egui::pos2(available.center().x - width / 2.0, top),
                            egui::pos2(available.center().x + width / 2.0, available.bottom()),
                        );
                        ui.scope_builder(egui::UiBuilder::new().max_rect(rect), |ui| {
                            egui::ScrollArea::vertical().show(ui, |ui| {
                                theme::glass()
                                    .inner_margin(24)
                                    .show(ui, |ui| self.connect_screen(ui));
                            });
                        });
                    }
                    Screen::Workspace => {
                        // The token now lives only in the network worker; drop the form's copy.
                        self.connect_form.token.clear();
                        self.workspace_screen(ui);
                    }
                }
            });
    }
}

impl eframe::App for MsnDesktopApp {
    fn clear_color(&self, _visuals: &egui::Visuals) -> [f32; 4] {
        [0.0; 4]
    }
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        self.draw(ui);
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(max_chars).collect::<String>())
    }
}

/// Renders one canonical message as a chat bubble: the user's own on the right, everyone
/// else's on the left behind their avatar. Message text is only ever displayed, never
/// interpreted or executed. Structured (`application/json`) messages get a labelled one-line
/// summary; the authoritative task state lives in the Tasks tab, not here.
/// The owner's pinned messages above the conversation (ADR 0038). Read-only here: pin with the
/// web app or `msn pin`. Long text is shortened to one line; the full message is in history.
fn render_pins(ui: &mut egui::Ui, pins: &[Value]) {
    theme::card().show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        egui::CollapsingHeader::new(
            egui::RichText::new(format!("Pinned · {}", pins.len())).color(theme::ACCENT),
        )
        .id_salt("pinned-header")
        .default_open(true)
        .show(ui, |ui| {
            egui::ScrollArea::vertical()
                .id_salt("pinned-list")
                .max_height(140.0)
                .show(ui, |ui| {
                    for pin in pins {
                        ui.label(pin_line(pin))
                            .on_hover_text(pin["text"].as_str().unwrap_or_default().to_string());
                    }
                });
        });
    });
}

/// A board in the list: its name, then the unread count and how many are to you (ADR 0045).
fn channel_label(name: &str, unread: Option<&read_marks::Unread>) -> egui::WidgetText {
    let Some((count, mine)) = unread.and_then(read_marks::Unread::badge) else {
        return name.into();
    };
    let mut job = egui::text::LayoutJob::default();
    let font = egui::TextStyle::Body.resolve(&egui::Style::default());
    let small = egui::TextStyle::Small.resolve(&egui::Style::default());
    job.append(
        name,
        0.0,
        egui::TextFormat::simple(font, egui::Color32::PLACEHOLDER),
    );
    job.append(
        &count,
        10.0,
        egui::TextFormat::simple(small.clone(), theme::MUTED),
    );
    if let Some(mine) = mine {
        job.append(&mine, 6.0, egui::TextFormat::simple(small, theme::ACCENT));
    }
    job.into()
}

/// `#id name: first line`, at most 160 characters.
fn pin_line(pin: &Value) -> String {
    let id = pin["id"].as_u64().unwrap_or(0);
    let name = pin["username"].as_str().unwrap_or("?");
    let text = pin["text"].as_str().unwrap_or("");
    let first = text.lines().next().unwrap_or("");
    let mut line: String = first.chars().take(160).collect();
    if line.chars().count() < text.chars().count() {
        line.push('…');
    }
    format!("#{id} {name}: {line}")
}

/// "3 messages matching “deploy” from ada, newest first", as the web app words it.
fn search_summary(search: &SearchState) -> String {
    let count = search.results.len();
    let mut summary = format!(
        "{count}{} message{} matching",
        if search.has_more { "+" } else { "" },
        if count == 1 { "" } else { "s" },
    );
    if !search.text.is_empty() {
        summary.push_str(&format!(" \u{201c}{}\u{201d}", search.text));
    }
    if let Some(from) = &search.from {
        summary.push_str(&format!(" from {from}"));
    }
    summary.push_str(", newest first");
    if !search.complete && !search.inflight {
        summary.push_str(" \u{b7} older messages are still being indexed");
    }
    summary
}

/// The shortest gap between two unread-count requests; events in between are coalesced.
const UNREAD_EVERY: std::time::Duration = std::time::Duration::from_secs(10);

/// How often the open channel's processed-by receipts are reloaded.
const RECEIPTS_EVERY: std::time::Duration = std::time::Duration::from_secs(15);

/// "Processed by lead · not yet: worker" under a message, from explicit commits only (ADR 0040).
/// Hovering shows exactly what a receipt proves.
fn render_receipts(
    ui: &mut egui::Ui,
    message: &Value,
    me: &str,
    receipts: &[msn_cli::receipts::Receipt],
) {
    let Some(id) = message["id"].as_u64() else {
        return;
    };
    let sender = message["username"].as_str().unwrap_or("");
    let Some(line) =
        msn_cli::receipts::summary(receipts, id, sender, message["personaId"].as_str())
    else {
        return;
    };
    let own = sender == me;
    let label = egui::Label::new(egui::RichText::new(line).small().color(theme::MUTED));
    let draw = |ui: &mut egui::Ui| {
        ui.add(label).on_hover_text(msn_cli::receipts::MEANING);
    };
    if own {
        ui.with_layout(egui::Layout::top_down(egui::Align::Max), draw);
    } else {
        ui.horizontal_top(|ui| {
            ui.add_space(30.0 + ui.spacing().item_spacing.x);
            draw(ui);
        });
    }
}

/// "Link" beside the header, and the same in the bubble's right-click menu (ADR 0042).
fn link_controls(ui: &mut egui::Ui, id: u64, actions: &mut Vec<Action>) {
    if ui
        .link(egui::RichText::new("Link").small().color(theme::MUTED))
        .on_hover_text(format!("Copy a link to message #{id}"))
        .clicked()
    {
        actions.push(Action::CopyLink(id));
    }
}

fn render_message(ui: &mut egui::Ui, message: &Value, me: &str, actions: &mut Vec<Action>) {
    let id = message["id"].as_u64().unwrap_or(0);
    let username = message["username"].as_str().unwrap_or("?");
    let own = username == me;
    let text = message["text"].as_str().unwrap_or("");
    let body = if message["contentType"].as_str() == Some("application/json") {
        Body::Rich(
            egui::RichText::new(format!("[structured] {}", summarize_json(text)))
                .color(theme::MUTED),
        )
    } else {
        // Formatted text (ADR 0043), parsed once per text; plain text keeps the single wrapped
        // label it had before.
        let parsed = markdown::parse_cached(text);
        match &*parsed {
            markdown::Parsed::Plain(plain) => Body::Rich(egui::RichText::new(plain)),
            markdown::Parsed::Blocks(_) => Body::Markdown(parsed.clone()),
        }
    };
    let header = message_header(ui, message, username, own);
    let shown = if own {
        ui.with_layout(egui::Layout::top_down(egui::Align::Max), |ui| {
            bubble(ui, header, body, true, |ui| link_controls(ui, id, actions))
        })
        .inner
    } else {
        ui.horizontal_top(|ui| {
            theme::avatar(ui, username, 30.0, None);
            ui.vertical(|ui| bubble(ui, header, body, false, |ui| link_controls(ui, id, actions)))
                .inner
        })
        .inner
    };
    // The bubble's frame only senses hover; give it a stable id that senses the right click.
    let shown = ui.interact(
        shown.rect,
        egui::Id::new(("message-bubble", id)),
        egui::Sense::click(),
    );
    shown.context_menu(|ui| {
        if ui.button("Copy link to this message").clicked() {
            actions.push(Action::CopyLink(id));
            ui.close();
        }
    });
}

struct ThreadToggle {
    id: u64,
    replies: usize,
    open: bool,
    unseen: usize,
}

/// Under a thread root: "Show 3 replies · 1 new" or "Hide 3 replies", on the root's side
/// (ADR 0041).
fn render_thread_toggle(
    ui: &mut egui::Ui,
    message: &Value,
    me: &str,
    toggle: ThreadToggle,
    actions: &mut Vec<Action>,
) {
    let ThreadToggle {
        id,
        replies,
        open,
        unseen,
    } = toggle;
    let mut label = format!(
        "{} {replies} repl{}",
        if open { "Hide" } else { "Show" },
        if replies == 1 { "y" } else { "ies" },
    );
    if unseen > 0 {
        label.push_str(&format!(" \u{b7} {unseen} new"));
    }
    let own = message["username"].as_str() == Some(me);
    let align = if own {
        egui::Align::Max
    } else {
        egui::Align::Min
    };
    ui.with_layout(egui::Layout::top_down(align), |ui| {
        let button = egui::Button::new(egui::RichText::new(label).small().color(theme::ACCENT));
        if ui
            .add(button)
            .on_hover_text(format!("Replies to #{id}"))
            .clicked()
        {
            actions.push(Action::ToggleThread(id));
        }
    });
}

/// A reply whose parent is not loaded: a link that fetches the parent, then a short quote of it.
fn render_parent(
    ui: &mut egui::Ui,
    state: &ChannelState,
    message: &Value,
    actions: &mut Vec<Action>,
) {
    let Some(parent) = message["replyTo"].as_u64() else {
        return;
    };
    if state.messages.contains_key(&parent) {
        return;
    }
    ui.horizontal_wrapped(|ui| {
        ui.add_space(38.0);
        match state.parents.get(&parent) {
            Some(Some(found)) => {
                let text = found["text"].as_str().unwrap_or("");
                ui.label(
                    egui::RichText::new(format!(
                        "\u{21aa} {}: {}",
                        found["username"].as_str().unwrap_or("?"),
                        truncate(&text.split_whitespace().collect::<Vec<_>>().join(" "), 140)
                    ))
                    .small()
                    .color(theme::MUTED),
                );
            }
            Some(None) => {
                ui.label(
                    egui::RichText::new(format!("Message #{parent} is no longer available."))
                        .small()
                        .color(theme::MUTED),
                );
            }
            None if state.parents_inflight.contains(&parent) => {
                ui.spinner();
            }
            None => {
                if ui
                    .link(egui::RichText::new(format!("Reply to #{parent}")).small())
                    .on_hover_text("Load the message this replies to")
                    .clicked()
                {
                    actions.push(Action::LoadParent(parent));
                }
            }
        }
    });
}

/// "name says" in the Messenger tradition, then the quieter metadata: time, id, reply target.
fn message_header(
    ui: &egui::Ui,
    message: &Value,
    username: &str,
    own: bool,
) -> egui::text::LayoutJob {
    let small = egui::TextStyle::Small.resolve(ui.style());
    let format = |color| egui::TextFormat {
        font_id: small.clone(),
        color,
        ..Default::default()
    };
    let name_color = if own {
        theme::ACCENT
    } else {
        theme::name_color(username)
    };
    let mut job = egui::text::LayoutJob::default();
    job.append(username, 0.0, format(name_color));
    let says = match message["to"].as_str() {
        Some(to) => format!(" says to {to}"),
        None => " says".to_string(),
    };
    job.append(&says, 0.0, format(theme::MUTED));
    let mut meta = String::new();
    if let Some(time) = message["createdAt"].as_str().and_then(|c| c.get(11..16)) {
        meta.push_str(&format!("{time} · "));
    }
    meta.push_str(&format!("#{}", message["id"].as_u64().unwrap_or(0)));
    if let Some(reply_to) = message["replyTo"].as_u64() {
        meta.push_str(&format!(" · re #{reply_to}"));
    }
    job.append(&meta, 10.0, format(theme::MUTED.gamma_multiply(0.7)));
    job
}

/// The bubble hugs its text and never exceeds most of the row, so long messages wrap inside
/// it. The text is laid out first because a right-aligned bubble must know its width.
enum Body {
    Rich(egui::RichText),
    Markdown(std::rc::Rc<markdown::Parsed>),
}

impl From<egui::RichText> for Body {
    fn from(text: egui::RichText) -> Self {
        Body::Rich(text)
    }
}

fn bubble(
    ui: &mut egui::Ui,
    header: egui::text::LayoutJob,
    body: impl Into<Body>,
    own: bool,
    controls: impl FnOnce(&mut egui::Ui),
) -> egui::Response {
    ui.spacing_mut().item_spacing.y = 3.0;
    let frame = theme::bubble(own);
    let wrap_width = (ui.available_width() * 0.82 - frame.total_margin().sum().x).max(120.0);
    // The header row's direction follows the bubble's side, so "Link" sits beside the name.
    let direction = if own {
        egui::Layout::right_to_left(egui::Align::Center)
    } else {
        egui::Layout::left_to_right(egui::Align::Center)
    };
    ui.allocate_ui_with_layout(egui::vec2(wrap_width, 0.0), direction, |ui| {
        if own {
            controls(ui);
            ui.label(header);
        } else {
            ui.label(header);
            controls(ui);
        }
    });
    match body.into() {
        Body::Rich(text) => {
            let galley = egui::WidgetText::from(text).into_galley(
                ui,
                Some(egui::TextWrapMode::Wrap),
                wrap_width,
                egui::TextStyle::Body,
            );
            frame.show(ui, |ui| ui.label(galley)).response
        }
        // Formatted text (ADR 0043).
        Body::Markdown(parsed) => {
            frame
                .show(ui, |ui| {
                    ui.set_max_width(wrap_width);
                    ui.with_layout(egui::Layout::top_down(egui::Align::Min), |ui| {
                        if let markdown::Parsed::Blocks(blocks) = &*parsed {
                            markdown::show(ui, blocks);
                        }
                    });
                })
                .response
        }
    }
}

/// A send that has not been confirmed yet: a dimmed own-side bubble with its status below.
fn render_pending(ui: &mut egui::Ui, key: &str, pending: &PendingSend, actions: &mut Vec<Action>) {
    ui.with_layout(egui::Layout::top_down(egui::Align::Max), |ui| {
        let small = egui::TextStyle::Small.resolve(ui.style());
        let mut header = egui::text::LayoutJob::default();
        header.append(
            if pending.error.is_some() {
                "not sent"
            } else {
                "sending…"
            },
            0.0,
            egui::TextFormat {
                font_id: small,
                color: theme::MUTED,
                ..Default::default()
            },
        );
        ui.scope(|ui| {
            ui.set_opacity(0.55);
            bubble(ui, header, egui::RichText::new(&pending.text), true, |_| {});
        });
    });
    if let Some(error) = &pending.error {
        ui.with_layout(egui::Layout::top_down(egui::Align::Max), |ui| {
            ui.colored_label(ERROR_COLOR, error);
        });
        ui.allocate_ui_with_layout(
            egui::vec2(ui.available_width(), ui.spacing().interact_size.y),
            egui::Layout::right_to_left(egui::Align::Center),
            |ui| {
                if ui.button("Discard").clicked() {
                    actions.push(Action::DiscardSend(key.to_string()));
                }
                if pending.retryable && ui.button("Retry").clicked() {
                    actions.push(Action::RetrySend(key.to_string()));
                }
            },
        );
    }
    ui.add_space(4.0);
}

/// `2026-09-14` → `14 September 2026`. Timestamps are shown as the server sent them (UTC).
fn format_day(date: &str) -> String {
    const MONTHS: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    let mut parts = date.splitn(3, '-');
    let (Some(year), Some(month), Some(day)) = (parts.next(), parts.next(), parts.next()) else {
        return date.to_string();
    };
    match (month.parse::<usize>(), day.parse::<u8>()) {
        (Ok(month @ 1..=12), Ok(day)) => format!("{day} {} {year}", MONTHS[month - 1]),
        _ => date.to_string(),
    }
}

fn summarize_json(text: &str) -> String {
    match serde_json::from_str::<Value>(text) {
        Ok(value) if value["schema"] == "msn.task.v1" => format!(
            "task activity: {} {} (see Tasks tab for the authoritative state)",
            value["task"].as_str().unwrap_or("?"),
            value["action"].as_str().unwrap_or("?")
        ),
        Ok(_) => truncate(text, 120),
        Err(_) => "invalid JSON payload".into(),
    }
}

fn render_task(ui: &mut egui::Ui, task: &Value, actions: &mut Vec<Action>) {
    let id = task["id"].as_str().unwrap_or("?");
    let state = task["state"].as_str().unwrap_or("?");
    let asserted = task["assertedState"].as_str().unwrap_or(state);
    theme::card().show(ui, |ui| {
        ui.set_min_width(ui.available_width());
        ui.horizontal_wrapped(|ui| {
            ui.strong(format!("{id}: {}", task["title"].as_str().unwrap_or("")));
            ui.label(format!("[{state}]"));
            if state != asserted {
                ui.weak(format!("(asserted {asserted})"));
            }
        });
        ui.horizontal_wrapped(|ui| {
            ui.label(format!(
                "owner: {}",
                task["owner"].as_str().unwrap_or("unassigned")
            ));
            ui.label(format!(
                "reviewer: {}",
                task["reviewer"].as_str().unwrap_or("?")
            ));
        });
        if let Some(blocked) = task["blockedOn"].as_array().filter(|b| !b.is_empty()) {
            let names: Vec<&str> = blocked.iter().filter_map(Value::as_str).collect();
            ui.colored_label(WARN_COLOR, format!("blocked on: {}", names.join(", ")));
        }
        if let Some(conflicts) = task["conflicts"].as_array().filter(|c| !c.is_empty()) {
            let names: Vec<&str> = conflicts.iter().filter_map(Value::as_str).collect();
            ui.colored_label(WARN_COLOR, format!("conflicts: {}", names.join(", ")));
        }
        if let Some(evidence) = task["evidence"].as_array().filter(|e| !e.is_empty()) {
            let ids: Vec<String> = evidence
                .iter()
                .filter_map(Value::as_u64)
                .map(|n| format!("#{n}"))
                .collect();
            ui.label(format!("evidence: {}", ids.join(", ")));
        }
        if let Some(reason) = task["reason"].as_str() {
            ui.label(format!("reason: {reason}"));
        }
        if matches!(state, "open") && ui.button("Claim").clicked() {
            actions.push(Action::Claim(id.to_string()));
        }
    });
}

#[cfg(test)]
mod pin_tests {
    use super::pin_line;
    use serde_json::json;

    #[test]
    fn pin_line_shows_id_author_and_a_short_first_line() {
        let pin = json!({"id": 7, "username": "lead", "text": "Rules\nsecond line"});
        assert_eq!(pin_line(&pin), "#7 lead: Rules…");
        let short = json!({"id": 8, "username": "lead", "text": "Plan"});
        assert_eq!(pin_line(&short), "#8 lead: Plan");
        let long = json!({"id": 9, "username": "x", "text": "é".repeat(200)});
        assert_eq!(pin_line(&long).chars().count(), "#9 x: ".len() + 161);
    }
}

#[cfg(test)]
mod layout_tests {
    use super::*;

    fn fixture(message_count: u64) -> MsnDesktopApp {
        let (tx, rx) = sync_channel(EVENT_QUEUE_CAPACITY);
        let mut state = AppState::default();
        state.begin_connect(1, "design-studio".into());
        state.apply(UiEvent::Connected {
            generation: 1,
            username: "Alex".into(),
        });
        state.apply(UiEvent::EventsReady { generation: 1 });
        state.channels = vec!["general".into(), "design".into()];
        state.selected_channel = Some("general".into());
        state.channel = Some(ChannelState {
            loaded: true,
            messages: (1..=message_count).map(|id| (id, json!({
                "id": id, "username": "Jamie", "text": "The glass workspace is ready for review.",
                "createdAt": "2026-09-20T14:00:00Z"
            }))).collect(),
            ..Default::default()
        });
        MsnDesktopApp {
            worker: Worker::spawn(tx, || {}),
            events_rx: rx,
            state,
            connect_form: ConnectForm::default(),
            composer: Composer::default(),
            new_channel_name: String::new(),
            active_tab: Tab::Chat,
            search_input: String::new(),
            scroll_to: None,
            link_origin: None,
            copied_link: None,
            receipts_at: None,
            read_marks_path: None,
            unread_at: None,
            profile_store: None,
        }
    }

    #[test]
    fn the_save_as_profile_row_fits_the_sign_in_card_at_every_window_size() {
        for size in [egui::vec2(980.0, 640.0), egui::vec2(560.0, 360.0)] {
            let ctx = egui::Context::default();
            theme::install(&ctx);
            let mut app = fixture(0);
            app.state = AppState::default();
            app.connect_form.save_profile = true;
            for _ in 0..3 {
                let mut output = ctx.run_ui(
                    egui::RawInput {
                        screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, size)),
                        ..Default::default()
                    },
                    |ui| app.draw(ui),
                );
                output.textures_delta.clear();
            }
            let rect = ctx
                .read_response(egui::Id::new("profile-name-input"))
                .expect("the profile name field is part of the connect form")
                .rect;
            assert!(
                rect.left() > 0.0 && rect.right() < size.x,
                "profile name field must fit horizontally: {rect:?}, {size:?}"
            );
            assert!(
                rect.width() > 100.0,
                "profile name field must stay usable: {rect:?}, {size:?}"
            );
        }
    }

    /// egui sizes a side panel from the previous frame's content, so content that is even a
    /// pixel wider or narrower than the space it was given makes the panel creep on every
    /// repaint (every mouse move).
    #[test]
    fn sidebar_width_is_stable_across_repaints() {
        let ctx = egui::Context::default();
        theme::install(&ctx);
        let mut app = fixture(3);
        let mut widths = Vec::new();
        for frame in 0..12 {
            let mut output = ctx.run_ui(
                egui::RawInput {
                    screen_rect: Some(egui::Rect::from_min_size(
                        egui::Pos2::ZERO,
                        egui::vec2(980.0, 640.0),
                    )),
                    events: vec![egui::Event::PointerMoved(egui::pos2(
                        40.0 + 50.0 * frame as f32,
                        300.0,
                    ))],
                    ..Default::default()
                },
                |ui| app.draw(ui),
            );
            output.textures_delta.clear();
            let state = egui::containers::panel::PanelState::load(&ctx, egui::Id::new("channels"))
                .expect("sidebar state");
            widths.push(state.size().x);
        }
        assert!(
            widths[2..].iter().all(|width| *width == widths[2]),
            "sidebar width must not drift: {widths:?}"
        );
    }

    #[test]
    fn copy_link_puts_the_message_link_on_the_clipboard() {
        let ctx = egui::Context::default();
        theme::install(&ctx);
        let mut app = fixture(3);
        // No connection origin yet: nothing to copy.
        app.perform(Action::CopyLink(2));
        assert_eq!(app.copied_link, None);
        app.link_origin = Some(url::Url::parse("https://msn.test/").unwrap());
        app.perform(Action::CopyLink(2));
        assert_eq!(
            app.state.status.as_deref(),
            Some("Link to message #2 copied.")
        );
        let mut output = ctx.run_ui(
            egui::RawInput {
                screen_rect: Some(egui::Rect::from_min_size(
                    egui::Pos2::ZERO,
                    egui::vec2(980.0, 640.0),
                )),
                ..Default::default()
            },
            |ui| app.draw(ui),
        );
        output.textures_delta.clear();
        let copied: Vec<_> = output
            .platform_output
            .commands
            .iter()
            .filter_map(|command| match command {
                egui::OutputCommand::CopyText(text) => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            copied,
            ["https://msn.test/#board=design-studio/general&msg=2"]
        );
        assert_eq!(app.copied_link, None);
    }

    #[test]
    fn right_click_on_a_message_opens_the_copy_link_menu() {
        let ctx = egui::Context::default();
        theme::install(&ctx);
        let mut app = fixture(3);
        let screen = Some(egui::Rect::from_min_size(
            egui::Pos2::ZERO,
            egui::vec2(980.0, 640.0),
        ));
        let frame = |events: Vec<egui::Event>, app: &mut MsnDesktopApp| {
            let mut output = ctx.run_ui(
                egui::RawInput {
                    screen_rect: screen,
                    events,
                    ..Default::default()
                },
                |ui| app.draw(ui),
            );
            output.textures_delta.clear();
        };
        frame(vec![], &mut app);
        frame(vec![], &mut app);
        let bubble = ctx
            .read_response(egui::Id::new(("message-bubble", 2_u64)))
            .expect("message 2 is drawn");
        assert!(bubble.sense.senses_click());
        assert!(!ctx.any_popup_open());
        let pos = bubble.rect.center();
        let button = |pressed| egui::Event::PointerButton {
            pos,
            button: egui::PointerButton::Secondary,
            pressed,
            modifiers: Default::default(),
        };
        frame(vec![egui::Event::PointerMoved(pos)], &mut app);
        frame(vec![button(true)], &mut app);
        frame(vec![button(false)], &mut app);
        frame(vec![], &mut app);
        assert!(ctx.any_popup_open(), "the right-click menu opens");
    }

    #[test]
    fn composer_stays_visible_at_bottom_for_empty_and_long_conversations() {
        for size in [egui::vec2(980.0, 640.0), egui::vec2(560.0, 360.0)] {
            let mut positions = Vec::new();
            for count in [0, 200] {
                let ctx = egui::Context::default();
                theme::install(&ctx);
                let mut app = fixture(count);
                for _ in 0..3 {
                    let mut output = ctx.run_ui(
                        egui::RawInput {
                            screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, size)),
                            ..Default::default()
                        },
                        |ui| app.draw(ui),
                    );
                    output.textures_delta.clear();
                }
                let response = ctx.read_response(egui::Id::new("message-input")).unwrap();
                let rect = response.rect;
                assert!(
                    rect.bottom() < size.y,
                    "composer must fit: {rect:?}, {size:?}"
                );
                assert!(
                    rect.right() < size.x,
                    "composer must fit horizontally: {rect:?}, {size:?}"
                );
                assert!(
                    rect.bottom() > size.y - 100.0,
                    "composer must be anchored near the bottom: {rect:?}, {size:?}"
                );
                assert!(
                    response.interact_rect.height() > 10.0,
                    "composer must not be clipped"
                );
                assert!(
                    rect.width() > 120.0,
                    "composer must keep a usable width: {rect:?}, {size:?}"
                );
                positions.push(rect);
            }
            assert_eq!(
                positions[0], positions[1],
                "history must not move the input"
            );
        }
    }
    /// Formatted messages (ADR 0043) render without markup characters, keep the composer in
    /// view, and a long code line scrolls instead of widening the window.
    #[test]
    fn formatted_messages_render_inside_the_window_without_markup() {
        let formatted = format!(
            "## Plan\nShip **bold** and `code` with [docs](https://example.com/docs).\n\n- one\n- two\n\n> quoted\n\n```\n{}\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
            "x".repeat(400)
        );
        let hostile = "[click](javascript:alert(1)) <img src=x onerror=alert(1)> **ok**";
        // Tall windows so both messages are on screen at once.
        for size in [egui::vec2(980.0, 1600.0), egui::vec2(560.0, 1600.0)] {
            let ctx = egui::Context::default();
            theme::install(&ctx);
            let mut app = fixture(0);
            if let Some(channel) = app.state.channel.as_mut() {
                for (id, text) in [(1u64, formatted.as_str()), (2, hostile)] {
                    channel.messages.insert(
                        id,
                        json!({"id": id, "username": "Jamie", "text": text, "createdAt": "2026-11-20T03:00:00Z"}),
                    );
                }
            }
            let mut texts = Vec::new();
            for _ in 0..3 {
                let mut output = ctx.run_ui(
                    egui::RawInput {
                        screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, size)),
                        ..Default::default()
                    },
                    |ui| app.draw(ui),
                );
                output.textures_delta.clear();
                texts = output
                    .shapes
                    .iter()
                    .filter_map(|clipped| match &clipped.shape {
                        egui::Shape::Text(text) => Some(text.galley.job.text.clone()),
                        _ => None,
                    })
                    .collect();
            }
            let all = texts.join("|");
            assert!(all.contains("bold") && !all.contains("**bold**"), "{all}");
            assert!(all.contains("Plan") && !all.contains("## Plan"), "{all}");
            // The unsafe link stays literal text, so a reader sees exactly what was sent.
            assert!(all.contains("[click](javascript:alert(1))"), "{all}");
            let input = ctx
                .read_response(egui::Id::new("message-input"))
                .unwrap()
                .rect;
            assert!(
                input.right() < size.x,
                "composer must fit: {input:?}, {size:?}"
            );
        }
    }
}
