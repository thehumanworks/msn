//! Where this reader stopped on each board, kept on this computer only (ADR 0045), and the
//! unread counts the board list shows from it.
//!
//! The file lives beside the CLI's cursors:
//! `$XDG_STATE_HOME/msn/<origin-hash>/<tenant>/desktop-read/<reader-hash>.json`, mode 0600. It
//! holds `{"reader": name, "marks": [[channel, id], …]}`, oldest-moved first; at most
//! `MAX_MARKS` boards are kept. The server never learns it: the counts request sends the marks
//! and the server keeps nothing.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use url::Url;

/// Boards remembered per reader on this computer; the least recently moved mark goes first.
pub const MAX_MARKS: usize = 200;
/// Boards per counts request, matching the server's limit.
pub const UNREAD_BOARDS: usize = 100;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Marks {
    /// `(channel, newest message id seen)`, least recently moved first.
    entries: Vec<(String, u64)>,
}

impl Marks {
    pub fn get(&self, channel: &str) -> Option<u64> {
        self.entries
            .iter()
            .find(|(name, _)| name == channel)
            .map(|(_, id)| *id)
    }

    /// Moves a mark forward only. Returns whether it moved.
    pub fn advance(&mut self, channel: &str, id: u64) -> bool {
        if self.get(channel).is_some_and(|current| current >= id) {
            return false;
        }
        self.entries.retain(|(name, _)| name != channel);
        self.entries.push((channel.to_string(), id));
        if self.entries.len() > MAX_MARKS {
            let excess = self.entries.len() - MAX_MARKS;
            self.entries.drain(..excess);
        }
        true
    }

    /// The marks for boards in `listed`, most recently read last, at most `UNREAD_BOARDS`.
    pub fn for_listed(&self, listed: &[String]) -> Vec<(String, u64)> {
        let pairs: Vec<(String, u64)> = self
            .entries
            .iter()
            .filter(|(name, _)| listed.iter().any(|listed| listed == name))
            .cloned()
            .collect();
        let skip = pairs.len().saturating_sub(UNREAD_BOARDS);
        pairs.into_iter().skip(skip).collect()
    }
}

#[derive(Serialize, Deserialize)]
struct Stored {
    reader: String,
    marks: Vec<(String, u64)>,
}

/// The file for one reader on one workspace, or `None` without `XDG_STATE_HOME` or `HOME`.
pub fn default_path(origin: &Url, tenant: &str, reader: &str) -> Option<PathBuf> {
    msn_cli::config::slug(tenant).ok()?;
    let reader_hash = msn_cli::cursor::reader_hash(reader).ok()?;
    let state_home = match std::env::var_os("XDG_STATE_HOME") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => match std::env::var_os("HOME") {
            Some(home) if !home.is_empty() => PathBuf::from(home).join(".local").join("state"),
            _ => return None,
        },
    };
    Some(
        state_home
            .join("msn")
            .join(msn_cli::cursor::origin_hash(origin))
            .join(tenant)
            .join("desktop-read")
            .join(format!("{reader_hash}.json")),
    )
}

/// Reads the marks; a missing, unreadable or malformed file, or one for another reader, is empty.
pub fn load(path: &Path, reader: &str) -> Marks {
    let Ok(text) = fs::read_to_string(path) else {
        return Marks::default();
    };
    let Ok(stored) = serde_json::from_str::<Stored>(&text) else {
        return Marks::default();
    };
    if stored.reader != reader {
        return Marks::default();
    }
    let mut marks = Marks::default();
    for (channel, id) in stored.marks {
        if msn_cli::config::is_slug(&channel) && id <= msn_cli::config::MAX_SAFE_INTEGER {
            marks.advance(&channel, id);
        }
    }
    marks
}

/// Writes the marks atomically (a temporary file renamed over the old one), readable only by
/// this user.
/// Another window of the same reader may have written meanwhile: its marks are merged in, keeping
/// the higher id per board, so neither window moves a mark back.
pub fn save(path: &Path, reader: &str, marks: &Marks) -> std::io::Result<()> {
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
    let mut merged = load(path, reader);
    for (channel, id) in &marks.entries {
        merged.advance(channel, *id);
    }
    let payload = serde_json::to_string(&Stored {
        reader: reader.to_string(),
        marks: merged.entries,
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
    let mut file = options.open(&tmp)?;
    file.write_all(payload.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path)
}

/// One board's count, as the server answered it for the mark `after`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unread {
    pub channel: String,
    pub after: u64,
    pub count: u64,
    pub to_you: u64,
    pub capped: bool,
}

impl Unread {
    /// The badge: "12" or "99+", and "@2" for messages addressed to you.
    pub fn badge(&self) -> Option<(String, Option<String>)> {
        if self.count == 0 {
            return None;
        }
        let count = format!("{}{}", self.count, if self.capped { "+" } else { "" });
        let mine = (self.to_you > 0).then(|| format!("@{}", self.to_you));
        Some((count, mine))
    }

    /// The hover text: "3 unread messages, 1 to you".
    pub fn label(&self) -> String {
        let count = format!("{}{}", self.count, if self.capped { "+" } else { "" });
        let noun = if self.count == 1 && !self.capped {
            "unread message"
        } else {
            "unread messages"
        };
        if self.to_you > 0 {
            format!("{count} {noun}, {} to you", self.to_you)
        } else {
            format!("{count} {noun}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_only_move_forward_and_keep_the_most_recent() {
        let mut marks = Marks::default();
        assert!(marks.advance("work", 10));
        assert!(!marks.advance("work", 9));
        assert!(!marks.advance("work", 10));
        assert!(marks.advance("ops", 3));
        assert!(marks.advance("work", 12));
        assert_eq!(marks.get("work"), Some(12));
        assert_eq!(
            marks.for_listed(&["work".into(), "ops".into(), "new".into()]),
            vec![("ops".into(), 3), ("work".into(), 12)]
        );
        for index in 0..MAX_MARKS {
            marks.advance(&format!("b{index}"), 1);
        }
        assert_eq!(marks.get("ops"), None, "the oldest marks are dropped");
        let listed: Vec<String> = (0..MAX_MARKS).map(|i| format!("b{i}")).collect();
        let pairs = marks.for_listed(&listed);
        assert_eq!(pairs.len(), UNREAD_BOARDS);
        assert_eq!(pairs[0].0, format!("b{}", MAX_MARKS - UNREAD_BOARDS));
    }

    #[test]
    fn saves_and_loads_for_the_same_reader_only() {
        let dir = std::env::temp_dir().join(format!("msn-read-{}", uuid::Uuid::new_v4()));
        let path = dir.join("nested").join("marks.json");
        let mut marks = Marks::default();
        marks.advance("work", 7);
        marks.advance("ops", 9);
        save(&path, "Tomas", &marks).unwrap();
        assert_eq!(load(&path, "Tomas"), marks);
        assert_eq!(load(&path, "someone"), Marks::default());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o700);
        }
        // Another window wrote a newer mark for one board: saving keeps the higher id of each.
        let mut other = Marks::default();
        other.advance("work", 20);
        other.advance("new", 1);
        save(&path, "Tomas", &other).unwrap();
        let mut stale = Marks::default();
        stale.advance("work", 7);
        stale.advance("ops", 11);
        save(&path, "Tomas", &stale).unwrap();
        let both = load(&path, "Tomas");
        assert_eq!(
            (both.get("work"), both.get("ops"), both.get("new")),
            (Some(20), Some(11), Some(1))
        );
        fs::write(&path, "not json").unwrap();
        assert_eq!(load(&path, "Tomas"), Marks::default());
        fs::write(
            &path,
            r#"{"reader":"Tomas","marks":[["Bad Name",1],["ok",2]]}"#,
        )
        .unwrap();
        assert_eq!(load(&path, "Tomas").get("ok"), Some(2));
        assert_eq!(load(&path, "Tomas").get("Bad Name"), None);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn path_follows_the_cli_state_layout() {
        let origin = Url::parse("https://msn.example/").unwrap();
        let path = default_path(&origin, "team", "Tomas");
        if let Some(path) = path {
            let text = path.to_string_lossy().to_string();
            assert!(text.contains("/msn/"));
            assert!(text.contains("/team/desktop-read/"));
            assert!(text.ends_with(".json"));
        }
        assert_eq!(default_path(&origin, "Bad Tenant", "Tomas"), None);
        assert_eq!(default_path(&origin, "team", "  "), None);
    }

    #[test]
    fn badge_and_label() {
        let entry = |count, to_you, capped| Unread {
            channel: "work".into(),
            after: 1,
            count,
            to_you,
            capped,
        };
        assert_eq!(entry(0, 0, false).badge(), None);
        assert_eq!(entry(1, 0, false).badge(), Some(("1".into(), None)));
        assert_eq!(entry(1, 0, false).label(), "1 unread message");
        assert_eq!(
            entry(99, 2, true).badge(),
            Some(("99+".into(), Some("@2".into())))
        );
        assert_eq!(entry(99, 2, true).label(), "99+ unread messages, 2 to you");
    }
}
