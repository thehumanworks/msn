#[allow(dead_code)]
mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use common::{MockServer, Scripted};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn temporary_home(label: &str) -> PathBuf {
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "msn-profile-{label}-{}-{nanos}-{sequence}",
        std::process::id()
    ))
}

fn command(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_msn"));
    command.env_clear();
    command.env("HOME", home);
    command.env("XDG_CONFIG_HOME", home.join("config"));
    command.env("XDG_STATE_HOME", home.join("state"));
    command
}

fn output(mut command: Command) -> Output {
    command.output().expect("run msn")
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).expect("UTF-8 stdout")
}

fn stderr(output: &Output) -> String {
    String::from_utf8(output.stderr.clone()).expect("UTF-8 stderr")
}

#[test]
fn save_exact_profile_is_private_and_public_commands_never_print_token() {
    let server = MockServer::spawn(vec![Scripted::json(
        200,
        r#"{"tenant":"team","username":"alice","usernamePrefix":null}"#,
    )]);
    let home = temporary_home("save");
    let secret = "participant-secret-value";
    let mut save = command(&home);
    save.args([
        "--url",
        &server.url(),
        "--tenant",
        "team",
        "--token",
        secret,
        "profile",
        "save",
        "alice",
    ]);
    let saved = output(save);
    assert!(saved.status.success(), "{}", stderr(&saved));
    assert!(!stdout(&saved).contains(secret));

    let profile = home.join("config/msn/profiles/alice.json");
    assert!(profile.is_file());
    let contents = fs::read_to_string(&profile).expect("profile JSON");
    assert!(contents.contains(secret));
    assert!(contents.contains(r#""username":"alice""#));
    assert!(contents.contains(r#""reader":"alice""#));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(profile.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&profile).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let mut show = command(&home);
    show.args(["profile", "show", "alice"]);
    let shown = output(show);
    assert!(shown.status.success(), "{}", stderr(&shown));
    assert!(!stdout(&shown).contains(secret));
    assert!(stdout(&shown).contains(r#""username":"alice""#));

    let mut list = command(&home);
    list.args(["profile", "list"]);
    let listed = output(list);
    assert!(listed.status.success(), "{}", stderr(&listed));
    assert_eq!(stdout(&listed).trim(), r#"{"profiles":["alice"]}"#);
    assert!(!stdout(&listed).contains(secret));

    let mut duplicate = command(&home);
    duplicate.args([
        "--url",
        &server.url(),
        "--tenant",
        "team",
        "--token",
        secret,
        "profile",
        "save",
        "alice",
    ]);
    let duplicate = output(duplicate);
    assert_eq!(duplicate.status.code(), Some(5));
    assert!(stderr(&duplicate).contains("already exists"));

    let mut composed = command(&home);
    composed
        .env("MSN_PROFILE", "alice")
        .args(["profile", "save", "bob"]);
    let composed = output(composed);
    assert_eq!(composed.status.code(), Some(2));
    assert!(stderr(&composed).contains("cannot be composed"));
}

#[test]
fn selected_profile_replaces_ambient_connection_and_rejects_explicit_connection_flags() {
    let server = MockServer::spawn(vec![
        Scripted::json(
            200,
            r#"{"tenant":"team","username":"alice","usernamePrefix":null}"#,
        ),
        Scripted::json(200, r#"{"channels":[],"nextCursor":null,"hasMore":false}"#),
        Scripted::json(
            200,
            r#"{"messages":[{"id":7}],"nextCursor":7,"hasMore":false}"#,
        ),
        Scripted::json(
            200,
            r#"{"messages":[{"id":8}],"nextCursor":8,"hasMore":false}"#,
        ),
    ]);
    let home = temporary_home("select");
    let mut save = command(&home);
    save.args([
        "--url",
        &server.url(),
        "--tenant",
        "team",
        "--token",
        "right-secret",
        "profile",
        "save",
        "alice",
    ]);
    let saved = output(save);
    assert!(saved.status.success(), "{}", stderr(&saved));

    let mut channels = command(&home);
    channels
        .env("MSN_PROFILE", "alice")
        .env("MSN_URL", "https://stale.invalid")
        .env("MSN_WORKSPACE_TENANT", "stale")
        .env("MSN_WORKSPACE_TOKEN", "wrong-secret")
        .env("MSN_USERNAME", "wrong-user")
        .env("MSN_READER", "wrong-reader")
        .arg("channels");
    let read = output(channels);
    assert!(read.status.success(), "{}", stderr(&read));
    assert!(stdout(&read).contains(r#""channels":[]"#));
    let request = server.recorded().last().unwrap().clone();
    assert_eq!(request.path, "/api/tenants/team/channels?limit=1000");
    assert_eq!(
        request.headers.get("authorization").unwrap(),
        "Bearer right-secret"
    );

    let origin = url::Url::parse(&server.url()).unwrap();
    let cursor_for = |reader: &str| {
        home.join("state/msn")
            .join(msn_cli::cursor::origin_hash(&origin))
            .join("team/readers")
            .join(msn_cli::cursor::reader_hash(reader).unwrap())
            .join("general.json")
    };
    let mut stale_reader = command(&home);
    stale_reader
        .env("MSN_PROFILE", "alice")
        .env("MSN_USERNAME", "wrong-user")
        .env("MSN_READER", "wrong-reader")
        .args(["read", "general"]);
    let read = output(stale_reader);
    assert!(read.status.success(), "{}", stderr(&read));
    assert!(cursor_for("alice").is_file());
    assert!(!cursor_for("wrong-reader").exists());

    let mut explicit_reader = command(&home);
    explicit_reader
        .env("MSN_PROFILE", "alice")
        .args(["--reader", "reviewer", "read", "general"]);
    let read = output(explicit_reader);
    assert!(read.status.success(), "{}", stderr(&read));
    assert!(cursor_for("reviewer").is_file());

    let mut mixed = command(&home);
    mixed.args(["--profile", "alice", "--url", &server.url(), "channels"]);
    let rejected = output(mixed);
    assert_eq!(rejected.status.code(), Some(2));
    assert!(stderr(&rejected).contains("complete connection"));
}

#[test]
fn activate_validates_profile_and_shell_init_exports_only_profile_name() {
    let server = MockServer::spawn(vec![
        Scripted::json(
            200,
            r#"{"tenant":"team","username":"alice","usernamePrefix":null}"#,
        ),
        Scripted::json(
            200,
            r#"{"tenant":"team","username":"alice","usernamePrefix":null}"#,
        ),
    ]);
    let home = temporary_home("activate");
    let mut save = command(&home);
    save.args([
        "--url",
        &server.url(),
        "--tenant",
        "team",
        "--token",
        "hidden-secret",
        "profile",
        "save",
        "alice",
    ]);
    assert!(output(save).status.success());

    let binary = PathBuf::from(env!("CARGO_BIN_EXE_msn"));
    let mut shell = Command::new("/bin/bash");
    shell
        .env_clear()
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_STATE_HOME", home.join("state"))
        .env("PATH", binary.parent().unwrap())
        .env("MSN_PROFILE", "previous")
        .args([
            "-c",
            r#"eval "$(msn shell-init bash)"
msn activate alice
msn activate missing >/dev/null 2>&1
failure=$?
printf '%s:%s' "$MSN_PROFILE" "$failure""#,
        ]);
    let activated = output(shell);
    assert!(activated.status.success(), "{}", stderr(&activated));
    assert_eq!(stdout(&activated), "alice:4");
    assert!(!stdout(&activated).contains("hidden-secret"));

    let mut init = command(&home);
    init.args(["shell-init", "zsh"]);
    let initialized = output(init);
    assert!(initialized.status.success(), "{}", stderr(&initialized));
    assert!(stdout(&initialized).contains("activate|deactivate"));
    assert!(stdout(&initialized).contains("command msn"));
    assert!(!stdout(&initialized).contains("hidden-secret"));

    let mut deactivate = command(&home);
    deactivate.arg("deactivate");
    let deactivated = output(deactivate);
    assert!(deactivated.status.success());
    assert_eq!(stdout(&deactivated).trim(), "unset MSN_PROFILE");
}

#[cfg(unix)]
#[test]
fn profile_loading_rejects_symlinks_and_open_permissions() {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let home = temporary_home("unsafe");
    let directory = home.join("config/msn/profiles");
    fs::create_dir_all(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    let target = home.join("real.json");
    fs::write(&target, "{}").unwrap();
    symlink(&target, directory.join("linked.json")).unwrap();

    let mut linked = command(&home);
    linked.args(["profile", "show", "linked"]);
    let rejected = output(linked);
    assert_eq!(rejected.status.code(), Some(2));
    assert!(stderr(&rejected).contains("symlink"));

    fs::remove_file(directory.join("linked.json")).unwrap();
    fs::write(directory.join("open.json"), "{}").unwrap();
    fs::set_permissions(
        directory.join("open.json"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    let mut open = command(&home);
    open.args(["profile", "show", "open"]);
    let rejected = output(open);
    assert_eq!(rejected.status.code(), Some(2));
    assert!(stderr(&rejected).contains("permissions 644"));
}
