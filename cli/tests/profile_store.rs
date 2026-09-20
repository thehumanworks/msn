//! The public profile store used by first-party clients such as the desktop app (ADR 0021).

use std::fs;
use std::path::PathBuf;

use msn_cli::error::CliError;
use msn_cli::profile::{Connection, ProfileStore, Saved};

const TOKEN: &str = "0123456789abcdef0123456789abcdef";

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "msn-profile-store-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        TempDir(path)
    }

    fn profiles(&self) -> PathBuf {
        self.0.join("msn/profiles")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn connection(username: &str, token: &str) -> Connection {
    Connection {
        url: "https://msn.example.com".into(),
        tenant: "my-team".into(),
        token: token.into(),
        username: username.into(),
    }
}

#[cfg(unix)]
fn mode(path: &std::path::Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn saves_a_private_profile_that_the_store_reads_back() {
    let temp = TempDir::new("roundtrip");
    let store = ProfileStore::at(temp.profiles());
    assert_eq!(store.summaries().unwrap(), Vec::new());

    let saved = store
        .save(Some("planner"), &connection("alice", TOKEN))
        .unwrap();
    assert_eq!(saved, Saved::Created("planner".into()));
    assert_eq!(store.load("planner").unwrap(), connection("alice", TOKEN));

    let summaries = store.summaries().unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].name, "planner");
    assert_eq!(summaries[0].username, "alice");
    assert_eq!(summaries[0].tenant, "my-team");

    #[cfg(unix)]
    {
        assert_eq!(mode(&temp.profiles()), 0o700);
        assert_eq!(mode(&temp.profiles().join("planner.json")), 0o600);
    }
    // The file is the CLI's own shape: the reader defaults to the username.
    let raw: serde_json::Value =
        serde_json::from_slice(&fs::read(temp.profiles().join("planner.json")).unwrap()).unwrap();
    assert_eq!(raw["reader"], "alice");
    assert_eq!(raw["url"], "https://msn.example.com");
    // No temporary file is left behind.
    let leftovers: Vec<_> = fs::read_dir(temp.profiles())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(leftovers, vec![std::ffi::OsString::from("planner.json")]);
}

#[test]
fn never_replaces_an_existing_profile() {
    let temp = TempDir::new("conflict");
    let store = ProfileStore::at(temp.profiles());
    store
        .save(Some("planner"), &connection("alice", TOKEN))
        .unwrap();
    assert!(matches!(
        store.check_new_name("planner"),
        Err(CliError::Conflict(_))
    ));
    let other = "ffffffffffffffffffffffffffffffff";
    let error = store
        .save(Some("planner"), &connection("mallory", other))
        .unwrap_err();
    assert!(matches!(error, CliError::Conflict(_)), "{error}");
    assert_eq!(store.load("planner").unwrap(), connection("alice", TOKEN));
}

#[test]
fn automatic_names_follow_the_user_and_never_duplicate_a_connection() {
    let temp = TempDir::new("auto");
    let store = ProfileStore::at(temp.profiles());
    let first = store.save(None, &connection("Alice B", TOKEN)).unwrap();
    assert_eq!(first, Saved::Created("alice-b-my-team".into()));
    // Same origin, workspace, user and key: reported, not duplicated.
    let again = store.save(None, &connection("Alice B", TOKEN)).unwrap();
    assert_eq!(again, Saved::AlreadySaved("alice-b-my-team".into()));
    // A rotated key for the same user is a new profile; the old one is left untouched.
    let rotated = "ffffffffffffffffffffffffffffffff";
    let second = store.save(None, &connection("Alice B", rotated)).unwrap();
    assert_eq!(second, Saved::Created("alice-b-my-team-2".into()));
    assert_eq!(store.load("alice-b-my-team").unwrap().token, TOKEN);
    assert_eq!(store.summaries().unwrap().len(), 2);
}

#[test]
fn rejects_invalid_connections_and_names_without_writing() {
    let temp = TempDir::new("invalid");
    let store = ProfileStore::at(temp.profiles());
    for (name, bad) in [
        (Some("Bad Name"), connection("alice", TOKEN)),
        (Some("../escape"), connection("alice", TOKEN)),
        (None, connection("", TOKEN)),
        (None, connection("alice", "")),
        (
            None,
            Connection {
                url: "http://msn.example.com".into(),
                ..connection("alice", TOKEN)
            },
        ),
        (
            None,
            Connection {
                tenant: "Not A Slug".into(),
                ..connection("alice", TOKEN)
            },
        ),
    ] {
        assert!(store.save(name, &bad).is_err(), "{name:?} {bad:?}");
    }
    assert_eq!(store.summaries().unwrap(), Vec::new());
}

#[test]
fn the_token_never_appears_in_debug_output_or_summaries() {
    let temp = TempDir::new("redaction");
    let store = ProfileStore::at(temp.profiles());
    store
        .save(Some("planner"), &connection("alice", TOKEN))
        .unwrap();
    assert!(!format!("{:?}", connection("alice", TOKEN)).contains(TOKEN));
    assert!(!format!("{:?}", store.summaries().unwrap()).contains(TOKEN));
}

#[cfg(unix)]
#[test]
fn refuses_unsafe_directories_and_skips_unsafe_or_corrupt_files() {
    use std::os::unix::fs::PermissionsExt;
    let temp = TempDir::new("unsafe");
    let store = ProfileStore::at(temp.profiles());
    store
        .save(Some("good"), &connection("alice", TOKEN))
        .unwrap();

    let loose = temp.profiles().join("loose.json");
    fs::copy(temp.profiles().join("good.json"), &loose).unwrap();
    fs::set_permissions(&loose, fs::Permissions::from_mode(0o644)).unwrap();
    let corrupt = temp.profiles().join("corrupt.json");
    fs::write(&corrupt, b"{").unwrap();
    fs::set_permissions(&corrupt, fs::Permissions::from_mode(0o600)).unwrap();
    std::os::unix::fs::symlink(
        temp.profiles().join("good.json"),
        temp.profiles().join("link.json"),
    )
    .unwrap();

    let names: Vec<String> = store
        .summaries()
        .unwrap()
        .into_iter()
        .map(|s| s.name)
        .collect();
    assert_eq!(names, vec!["good"]);
    assert!(store.load("loose").is_err());
    assert!(store.load("link").is_err());
    // A symlink squatting on the name is a conflict, never followed or replaced.
    assert!(matches!(
        store.save(Some("link"), &connection("alice", TOKEN)),
        Err(CliError::Conflict(_))
    ));

    fs::set_permissions(temp.profiles(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(store.summaries().is_err());
    assert!(
        store
            .save(Some("other"), &connection("alice", TOKEN))
            .is_err()
    );
    fs::set_permissions(temp.profiles(), fs::Permissions::from_mode(0o700)).unwrap();
}
