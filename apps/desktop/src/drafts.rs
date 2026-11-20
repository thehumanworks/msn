//! Unsent drafts, one per board, kept on this computer only (ADR 0056).
//!
//! The file lives beside the read marks (ADR 0045):
//! `$XDG_STATE_HOME/msn/<origin-hash>/<tenant>/desktop-drafts/<reader-hash>.json`, mode 0600 in
//! a 0700 directory, written atomically (a temporary file renamed over the old one). It holds
//! `{"reader": name, "drafts": [[channel, {"text", "to", "replyTo"}], …]}`, least recently
//! changed first; at most `MAX_DRAFTS` boards are kept. It never holds a key, and nothing in it
//! goes to the server. A message that failed to send is not a draft: it stays in the pending list
//! with its retry key for this run only, so a restart can never send it twice.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use url::Url;

/// Boards with a kept draft per reader on this computer; the least recently changed go first.
pub const MAX_DRAFTS: usize = 50;
/// The server's message limit. A longer draft cannot be sent, so it is kept in memory only.
pub const MAX_TEXT_BYTES: usize = 16_384;
/// The server's recipient limit.
pub const MAX_TO_BYTES: usize = 128;
/// "Reply to #" holds a message number; anything longer is not one.
const MAX_REPLY_TO_BYTES: usize = 20;

/// What the composer holds for one board: the raw field contents.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Draft {
    pub text: String,
    pub to: String,
    #[serde(rename = "replyTo")]
    pub reply_to: String,
}

impl Draft {
    pub fn is_empty(&self) -> bool {
        self.text.is_empty() && self.to.is_empty() && self.reply_to.is_empty()
    }

    /// Small enough to write down; a longer draft stays in memory for this run.
    fn storable(&self) -> bool {
        !self.is_empty()
            && self.text.len() <= MAX_TEXT_BYTES
            && self.to.len() <= MAX_TO_BYTES
            && self.reply_to.len() <= MAX_REPLY_TO_BYTES
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Drafts {
    /// `(channel, draft)`, least recently changed first.
    entries: Vec<(String, Draft)>,
}

impl Drafts {
    pub fn get(&self, channel: &str) -> Option<&Draft> {
        self.entries
            .iter()
            .find(|(name, _)| name == channel)
            .map(|(_, draft)| draft)
    }

    /// Records the composer for `channel`; an empty draft is removed. Returns whether anything
    /// changed, so an unchanged frame writes nothing.
    pub fn set(&mut self, channel: &str, draft: &Draft) -> bool {
        if self.get(channel) == Some(draft) || (draft.is_empty() && self.get(channel).is_none()) {
            return false;
        }
        self.entries.retain(|(name, _)| name != channel);
        if !draft.is_empty() {
            self.entries.push((channel.to_string(), draft.clone()));
        }
        if self.entries.len() > MAX_DRAFTS {
            let excess = self.entries.len() - MAX_DRAFTS;
            self.entries.drain(..excess);
        }
        true
    }
}

#[derive(Serialize, Deserialize)]
struct Stored {
    reader: String,
    drafts: Vec<(String, Draft)>,
}

/// The file for one reader on one workspace, or `None` without `XDG_STATE_HOME` or `HOME`.
pub fn default_path(origin: &Url, tenant: &str, reader: &str) -> Option<PathBuf> {
    let marks = crate::read_marks::default_path(origin, tenant, reader)?;
    let file = marks.file_name()?.to_owned();
    Some(marks.parent()?.parent()?.join("desktop-drafts").join(file))
}

/// Reads the drafts; a missing, unreadable or malformed file, or one for another reader, is
/// empty. Entries that are not valid boards or are too long are dropped one by one.
pub fn load(path: &Path, reader: &str) -> Drafts {
    let Ok(text) = fs::read_to_string(path) else {
        return Drafts::default();
    };
    let Ok(stored) = serde_json::from_str::<Stored>(&text) else {
        return Drafts::default();
    };
    if stored.reader != reader {
        return Drafts::default();
    }
    let mut drafts = Drafts::default();
    for (channel, draft) in stored.drafts {
        if msn_cli::config::is_slug(&channel) && draft.storable() {
            drafts.set(&channel, &draft);
        }
    }
    drafts
}

/// Writes the drafts atomically, readable only by this user. With nothing worth keeping the file
/// is removed instead. Two windows of the same reader: the last one to write wins.
pub fn save(path: &Path, reader: &str, drafts: &Drafts) -> std::io::Result<()> {
    let kept: Vec<(String, Draft)> = drafts
        .entries
        .iter()
        .filter(|(_, draft)| draft.storable())
        .cloned()
        .collect();
    if kept.is_empty() {
        return remove(path);
    }
    if let Some(parent) = path.parent() {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(parent)?;
    }
    let payload = serde_json::to_string(&Stored {
        reader: reader.to_string(),
        drafts: kept,
    })
    .map_err(std::io::Error::other)?;
    let tmp = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = (|| {
        let mut file = options.open(&tmp)?;
        file.write_all(payload.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

/// Forgets every draft of this reader on this computer (Disconnect).
pub fn remove(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(text: &str, to: &str, reply_to: &str) -> Draft {
        Draft {
            text: text.into(),
            to: to.into(),
            reply_to: reply_to.into(),
        }
    }

    #[test]
    fn set_moves_the_changed_board_last_and_drops_empty_and_oldest() {
        let mut drafts = Drafts::default();
        assert!(!drafts.set("work", &Draft::default()), "empty and absent");
        assert!(drafts.set("work", &draft("a", "", "")));
        assert!(!drafts.set("work", &draft("a", "", "")), "unchanged");
        assert!(drafts.set("ops", &draft("b", "lead", "3")));
        assert!(drafts.set("work", &draft("a2", "", "")));
        assert_eq!(drafts.entries[1].0, "work");
        assert!(drafts.set("work", &Draft::default()));
        assert_eq!(drafts.get("work"), None);
        for i in 0..MAX_DRAFTS + 3 {
            drafts.set(&format!("b{i}"), &draft("x", "", ""));
        }
        assert_eq!(drafts.entries.len(), MAX_DRAFTS);
        assert_eq!(drafts.get("ops"), None);
        assert!(drafts.get(&format!("b{}", MAX_DRAFTS + 2)).is_some());
    }

    #[test]
    fn saves_and_loads_for_the_same_reader_only() {
        let dir = std::env::temp_dir().join(format!("msn-drafts-{}", uuid::Uuid::new_v4()));
        let path = dir.join("nested").join("drafts.json");
        let mut drafts = Drafts::default();
        drafts.set("work", &draft("half a thought\nsecond line", "lead", "7"));
        drafts.set("ops", &draft("", "", "2"));
        // Too long to send: kept in memory for this run, never written.
        drafts.set("long", &draft(&"x".repeat(MAX_TEXT_BYTES + 1), "", ""));
        save(&path, "Tomas", &drafts).unwrap();
        let loaded = load(&path, "Tomas");
        assert_eq!(loaded.get("work"), drafts.get("work"));
        assert_eq!(loaded.get("ops"), drafts.get("ops"));
        assert_eq!(loaded.get("long"), None);
        assert_eq!(load(&path, "someone"), Drafts::default());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
            let mode = fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o700);
        }
        let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from("drafts.json")]);
        fs::write(&path, "not json").unwrap();
        assert_eq!(load(&path, "Tomas"), Drafts::default());
        fs::write(
            &path,
            r#"{"reader":"Tomas","drafts":[["Bad Name",{"text":"a","to":"","replyTo":""}],["ok",{"text":"b","to":"","replyTo":""}],["empty",{"text":"","to":"","replyTo":""}]]}"#,
        )
        .unwrap();
        let loaded = load(&path, "Tomas");
        assert_eq!(loaded.entries.len(), 1);
        assert_eq!(loaded.get("ok"), Some(&draft("b", "", "")));
        // Nothing left to keep removes the file; removing it twice is fine.
        save(&path, "Tomas", &Drafts::default()).unwrap();
        assert!(!path.exists());
        remove(&path).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn path_sits_beside_the_read_marks() {
        let origin = Url::parse("https://msn.example").unwrap();
        let Some(path) = default_path(&origin, "team", "Tomas") else {
            return; // No HOME or XDG_STATE_HOME in this environment.
        };
        let marks = crate::read_marks::default_path(&origin, "team", "Tomas").unwrap();
        assert_eq!(
            path.parent().unwrap().file_name().unwrap(),
            "desktop-drafts"
        );
        assert_eq!(
            path.parent().unwrap().parent(),
            marks.parent().unwrap().parent()
        );
        assert_eq!(path.file_name(), marks.file_name());
        assert_eq!(default_path(&origin, "Not A Slug", "Tomas"), None);
    }
}
