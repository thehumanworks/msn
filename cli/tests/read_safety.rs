#[allow(dead_code)]
mod common;

#[cfg(unix)]
mod unix {
    use std::fs;
    use std::io::Read;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use super::common::{MockServer, Scripted};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    const PAGE: &str = r#"{"messages":[{"id":7}],"nextCursor":7,"hasMore":false}"#;

    struct TestHome(PathBuf);

    impl TestHome {
        fn new(label: &str) -> Self {
            let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "msn-read-safety-{label}-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("test home");
            Self(path)
        }

        fn command(&self) -> Command {
            let mut command = Command::new(env!("CARGO_BIN_EXE_msn"));
            command
                .env_clear()
                .env("HOME", &self.0)
                .env("XDG_STATE_HOME", self.0.join("state"));
            command
        }

        fn cursor(&self) -> PathBuf {
            self.0.join("cursor.json")
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("remove test home");
        }
    }

    fn read_args(url: &str, cursor: &Path) -> Vec<String> {
        vec![
            "--url".into(),
            url.into(),
            "--tenant".into(),
            "team".into(),
            "--token".into(),
            "tenant-secret".into(),
            "read".into(),
            "general".into(),
            "--cursor-file".into(),
            cursor.display().to_string(),
        ]
    }

    fn cursor_before(url: &str) -> String {
        format!(r#"{{"server":"{url}","tenant":"team","channel":"general","after":3}}"#)
    }

    fn lock_path(cursor: &Path) -> PathBuf {
        let mut value = cursor.as_os_str().to_os_string();
        value.push(".lock");
        PathBuf::from(value)
    }

    fn wait_for_request(server: &MockServer) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while server.recorded().is_empty() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!server.recorded().is_empty(), "read did not start polling");
    }

    fn exit_capped(child: &mut Child) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = child.try_wait().expect("child status") {
                return status;
            }
            if Instant::now() > deadline {
                child.kill().expect("kill timed out child");
                child.wait().expect("reap timed out child");
                panic!("read did not exit promptly");
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn sigterm_during_read_releases_lock_without_advancing_cursor() {
        let server = MockServer::spawn(vec![
            Scripted::json(200, PAGE).delayed(Duration::from_secs(30)),
        ]);
        let home = TestHome::new("sigterm");
        let cursor = home.cursor();
        let before = cursor_before(&server.url());
        fs::write(&cursor, &before).expect("seed cursor");

        let mut child = home
            .command()
            .args(read_args(&server.url(), &cursor))
            .args(["--wait", "25"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn read");
        wait_for_request(&server);
        assert!(lock_path(&cursor).exists(), "read did not hold cursor lock");

        assert!(
            Command::new("kill")
                .args(["-TERM", &child.id().to_string()])
                .status()
                .expect("send SIGTERM")
                .success()
        );
        assert_eq!(exit_capped(&mut child).code(), Some(0));
        assert!(!lock_path(&cursor).exists(), "SIGTERM left a lock behind");
        assert_eq!(fs::read_to_string(&cursor).unwrap(), before);
    }

    #[test]
    fn stdout_failure_does_not_advance_read_cursor_and_releases_lock() {
        let server = MockServer::spawn(vec![
            Scripted::json(200, PAGE).delayed(Duration::from_millis(150)),
        ]);
        let home = TestHome::new("stdout");
        let cursor = home.cursor();
        let before = cursor_before(&server.url());
        fs::write(&cursor, &before).expect("seed cursor");

        let mut child = home
            .command()
            .args(read_args(&server.url(), &cursor))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn read");
        drop(child.stdout.take());
        let status = exit_capped(&mut child);
        let mut error = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut error)
            .unwrap();

        assert!(!status.success());
        assert!(!error.is_empty(), "stdout failure was not reported");
        assert!(
            !lock_path(&cursor).exists(),
            "stdout failure left a lock behind"
        );
        assert_eq!(fs::read_to_string(&cursor).unwrap(), before);
    }
}
