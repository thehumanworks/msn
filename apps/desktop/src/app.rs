use std::sync::mpsc::{Receiver, sync_channel};

use eframe::egui;
use serde_json::{Value, json};
use uuid::Uuid;

use msn_cli::config::{MAX_SAFE_INTEGER, is_slug, parse_int, parse_origin, slug};
use msn_cli::identity::validate_username;

use crate::net::worker::{Command, EVENT_QUEUE_CAPACITY, TaskEventRequest, UiEvent, Worker};
use crate::profile;
use crate::state::{AppState, PendingSend, PendingTaskEvent, Screen};
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
}

#[derive(Default)]
struct ConnectForm {
    url: String,
    tenant: String,
    token: String,
    username: String,
    profile_name: String,
    profiles: Vec<String>,
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
    Snapshots,
    Tasks,
}

enum Action {
    Select(String),
    Reload,
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
        let connect_form = ConnectForm {
            url: msn_cli::config::DEFAULT_URL.to_string(),
            profiles: profile::list_profiles(),
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
        }
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
            let commands = self.state.apply(event);
            self.dispatch_all(commands);
        }
        let deferred = self.state.take_deferred();
        self.dispatch_all(deferred);
    }

    fn connect_screen(&mut self, ui: &mut egui::Ui) {
        ui.heading("Connect to msn");
        ui.add_space(8.0);

        if !self.connect_form.profiles.is_empty() {
            ui.horizontal(|ui| {
                ui.label("Saved profile:");
                let mut chosen = None;
                egui::ComboBox::from_id_salt("profile-picker")
                    .selected_text(if self.connect_form.profile_name.is_empty() {
                        "(none)"
                    } else {
                        &self.connect_form.profile_name
                    })
                    .show_ui(ui, |ui| {
                        for name in &self.connect_form.profiles {
                            if ui
                                .selectable_label(self.connect_form.profile_name == *name, name)
                                .clicked()
                            {
                                chosen = Some(name.clone());
                            }
                        }
                    });
                if let Some(name) = chosen {
                    match profile::load_profile(&name) {
                        Ok(loaded) => {
                            self.connect_form.profile_name = name;
                            self.connect_form.url = loaded.url;
                            self.connect_form.tenant = loaded.tenant;
                            self.connect_form.token = loaded.token;
                            self.connect_form.username = loaded.username;
                            self.state.connect_error = None;
                        }
                        Err(error) => self.state.connect_error = Some(error),
                    }
                }
            });
            ui.add_space(8.0);
        }

        egui::Grid::new("connect-grid")
            .num_columns(2)
            .spacing([8.0, 6.0])
            .show(ui, |ui| {
                ui.label("Origin");
                ui.add(
                    egui::TextEdit::singleline(&mut self.connect_form.url)
                        .desired_width(360.0)
                        .hint_text("https://msn.example.workers.dev"),
                );
                ui.end_row();
                ui.label("Workspace");
                ui.add(
                    egui::TextEdit::singleline(&mut self.connect_form.tenant).desired_width(360.0),
                );
                ui.end_row();
                ui.label("Access token");
                ui.add(
                    egui::TextEdit::singleline(&mut self.connect_form.token)
                        .password(true)
                        .desired_width(360.0),
                );
                ui.end_row();
                ui.label("Username");
                ui.add(
                    egui::TextEdit::singleline(&mut self.connect_form.username)
                        .desired_width(360.0)
                        .hint_text("blank = the key's bound identity"),
                );
                ui.end_row();
            });

        ui.add_space(8.0);
        let connecting = self.state.pending_connect.is_some();
        let enter = ui.input(|i| i.key_pressed(egui::Key::Enter));
        ui.add_enabled_ui(!connecting, |ui| {
            if ui.button("Connect").clicked() || (enter && !connecting) {
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
        ui.add_space(12.0);
        ui.weak(
            "The token stays in memory for this session only; it is sent only to the origin above \
             and is never written to disk by this app.",
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
        let generation = self.worker.next_generation();
        self.state.begin_connect(generation, tenant.clone());
        self.dispatch(Command::Connect {
            generation,
            origin,
            tenant,
            token,
            chosen_username,
        });
    }

    fn workspace_screen(&mut self, ui: &mut egui::Ui) {
        let mut actions: Vec<Action> = Vec::new();
        egui::Panel::left("channels")
            .default_size(230.0)
            .min_size(190.0)
            .frame(theme::glass().outer_margin(egui::Margin {
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
        ui.add_space(10.0);
        if let Some(connection) = &self.state.connection {
            ui.strong(&connection.tenant);
            ui.weak(format!("signed in as {}", connection.username));
        }
        if ui.button("Disconnect").clicked() {
            actions.push(Action::Disconnect);
        }
        ui.separator();
        ui.label(
            egui::RichText::new("CHANNELS")
                .size(10.0)
                .color(theme::MUTED),
        );
        ui.horizontal(|ui| {
            let response = ui.add(
                egui::TextEdit::singleline(&mut self.new_channel_name)
                    .hint_text("new-channel")
                    .desired_width((ui.available_width() - 80.0).max(50.0)),
            );
            let enter = response.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
            if ui.button("Create").clicked() || enter {
                self.create_channel();
            }
        });
        if let Some(error) = &self.state.channels_error {
            ui.colored_label(ERROR_COLOR, error);
        }
        ui.separator();
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
            for name in &self.state.channels {
                let selected = self.state.selected_channel.as_deref() == Some(name.as_str());
                if ui.selectable_label(selected, name).clicked() && !selected {
                    actions.push(Action::Select(name.clone()));
                }
            }
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
        ui.horizontal_wrapped(|ui| {
            ui.heading(&channel);
            ui.separator();
            ui.selectable_value(&mut self.active_tab, Tab::Chat, "Chat");
            ui.selectable_value(&mut self.active_tab, Tab::Snapshots, "Snapshots");
            ui.selectable_value(&mut self.active_tab, Tab::Tasks, "Tasks");
            if ui.button("Reload").clicked() {
                actions.push(Action::Reload);
            }
        });
        ui.separator();
        match self.active_tab {
            Tab::Chat => self.chat_tab(ui, actions),
            Tab::Snapshots => self.snapshots_tab(ui),
            Tab::Tasks => self.tasks_tab(ui, actions),
        }
    }

    fn chat_tab(&mut self, ui: &mut egui::Ui, actions: &mut Vec<Action>) {
        // Reserve the composer before laying out the scrollable conversation. Its position
        // never depends on message count, loading state, or pending-send errors.
        egui::Panel::bottom("message-composer")
            .exact_size(
                124.0
                    + if ui.available_width() < 360.0 {
                        40.0
                    } else {
                        0.0
                    }
                    + if self.composer.error.is_some() {
                        40.0
                    } else {
                        0.0
                    },
            )
            .frame(theme::glass().corner_radius(14).inner_margin(12))
            .show(ui, |ui| self.composer_panel(ui, actions));
        egui::CentralPanel::default()
            .frame(egui::Frame::new().inner_margin(egui::Margin {
                bottom: 12,
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
                                ui.weak("Start the conversation.");
                            }
                            for message in state.messages.values() {
                                egui::Frame::new()
                                    .fill(egui::Color32::from_white_alpha(5))
                                    .corner_radius(12)
                                    .inner_margin(12)
                                    .show(ui, |ui| {
                                        ui.set_min_width(ui.available_width());
                                        render_message(ui, message);
                                    });
                                ui.add_space(6.0);
                            }
                        }
                        for (key, pending) in &self.state.pending_sends {
                            ui.horizontal_wrapped(|ui| {
                                ui.weak(format!("sending: {}", truncate(&pending.text, 60)));
                                match &pending.error {
                                    Some(error) => {
                                        ui.colored_label(ERROR_COLOR, error);
                                        if pending.retryable && ui.button("Retry").clicked() {
                                            actions.push(Action::RetrySend(key.clone()));
                                        }
                                        if ui.button("Discard").clicked() {
                                            actions.push(Action::DiscardSend(key.clone()));
                                        }
                                    }
                                    None => {
                                        ui.spinner();
                                    }
                                }
                            });
                        }
                    });
            });
    }

    fn composer_panel(&mut self, ui: &mut egui::Ui, actions: &mut Vec<Action>) {
        if let Some(error) = &self.composer.error {
            ui.colored_label(ERROR_COLOR, error);
        }
        ui.horizontal_wrapped(|ui| {
            ui.label(egui::RichText::new("To").color(theme::MUTED));
            ui.add(
                egui::TextEdit::singleline(&mut self.composer.to)
                    .hint_text("everyone")
                    .desired_width(110.0),
            );
            ui.label(egui::RichText::new("Reply to #").color(theme::MUTED));
            ui.add(egui::TextEdit::singleline(&mut self.composer.reply_to).desired_width(60.0));
        });
        ui.horizontal(|ui| {
            let response = ui.add(
                egui::TextEdit::singleline(&mut self.composer.text)
                    .id(egui::Id::new("message-input"))
                    .hint_text("Message (Enter to send)")
                    .desired_width((ui.available_width() - 70.0).max(80.0)),
            );
            let enter = response.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
            if ui.button("Send").clicked() || enter {
                actions.push(Action::Send);
                response.request_focus();
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
                ui.group(|ui| ui.label(text));
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
        theme::backdrop(ui);
        egui::CentralPanel::default()
            .frame(theme::outer())
            .show(ui, |ui| {
                match self.state.screen() {
                    Screen::Connect => {
                        egui::CentralPanel::default()
                            .frame(theme::glass())
                            .show(ui, |ui| self.connect_screen(ui));
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

/// Renders one canonical message. Message text is only ever displayed, never interpreted or
/// executed. Structured (`application/json`) messages get a labelled one-line summary; the
/// authoritative task state lives in the Tasks tab, not here.
fn render_message(ui: &mut egui::Ui, message: &Value) {
    let id = message["id"].as_u64().unwrap_or(0);
    let username = message["username"].as_str().unwrap_or("?");
    ui.horizontal_wrapped(|ui| {
        ui.weak(format!("#{id}"));
        ui.strong(username);
        if let Some(to) = message["to"].as_str() {
            ui.weak(format!("to {to}"));
        }
        if let Some(reply_to) = message["replyTo"].as_u64() {
            ui.weak(format!("re #{reply_to}"));
        }
        if let Some(created) = message["createdAt"].as_str() {
            ui.weak(created);
        }
    });
    let text = message["text"].as_str().unwrap_or("");
    if message["contentType"].as_str() == Some("application/json") {
        ui.weak(format!("[structured] {}", summarize_json(text)));
    } else {
        ui.label(text);
    }
    ui.add_space(4.0);
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
    ui.group(|ui| {
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
mod layout_tests {
    use super::*;
    use crate::state::ChannelState;

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
        }
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
                positions.push(rect);
            }
            assert_eq!(
                positions[0], positions[1],
                "history must not move the input"
            );
        }
    }
}
