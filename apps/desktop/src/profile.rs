//! Saved connections, shared with the `msn` CLI (`~/.config/msn/profiles/<name>.json`).
//!
//! This is a thin view over `msn_cli::profile::ProfileStore`, the one implementation of the
//! directory, the JSON shape, the permission checks and the never-replace writer (ADR 0021). The
//! UI thread only lists summaries and loads a picked profile into the connect form; saving
//! happens on the network worker, after the identity endpoint has accepted the key, because the
//! worker is the only holder of the token once a connection exists.

pub use msn_cli::profile::{Connection, ProfileStore, Saved, Summary};

/// The default store, or `None` when neither `XDG_CONFIG_HOME` nor `HOME` is set.
pub fn default_store() -> Option<ProfileStore> {
    ProfileStore::default_location().ok()
}

/// Summaries for the picker. An unsafe directory yields an explanation instead of profiles.
pub fn list(store: Option<&ProfileStore>) -> (Vec<Summary>, Option<String>) {
    match store.map(ProfileStore::summaries) {
        Some(Ok(summaries)) => (summaries, None),
        Some(Err(error)) => (
            Vec::new(),
            Some(format!("Saved profiles are unavailable: {error}")),
        ),
        None => (Vec::new(), None),
    }
}

/// What the connect form asks the worker to do once the connection is authenticated.
#[derive(Debug, Clone)]
pub struct SaveRequest {
    pub store: ProfileStore,
    /// `None` names the profile after the user and workspace.
    pub name: Option<String>,
}

/// The outcome shown to the user. Never contains the token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveOutcome {
    Saved(String),
    AlreadySaved(String),
    Failed(String),
}

impl SaveRequest {
    pub fn run(&self, connection: &Connection) -> SaveOutcome {
        match self.store.save(self.name.as_deref(), connection) {
            Ok(Saved::Created(name)) => SaveOutcome::Saved(name),
            Ok(Saved::AlreadySaved(name)) => SaveOutcome::AlreadySaved(name),
            Err(error) => SaveOutcome::Failed(error.to_string()),
        }
    }
}
