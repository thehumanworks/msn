//! Drives the real `Worker` and `AppState` reducer exactly the way the GUI does, so tests can
//! exercise generation guards, coalescing and live refresh without opening a window.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use msn_desktop::net::worker::{Command, EVENT_QUEUE_CAPACITY, UiEvent, Worker};
use msn_desktop::state::AppState;

pub struct Rig {
    pub worker: Worker,
    pub rx: Receiver<UiEvent>,
    pub wakes: Arc<AtomicUsize>,
    pub seen: Mutex<Vec<UiEvent>>,
}

pub fn rig() -> Rig {
    let (tx, rx) = sync_channel(EVENT_QUEUE_CAPACITY);
    let wakes = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&wakes);
    let worker = Worker::spawn(tx, move || {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    Rig {
        worker,
        rx,
        wakes,
        seen: Mutex::new(Vec::new()),
    }
}

impl Rig {
    pub fn connect(&self, origin: &str, tenant: &str, token: &str) -> u64 {
        let generation = self.worker.next_generation();
        self.worker
            .send(Command::Connect {
                generation,
                origin: url::Url::parse(origin).unwrap(),
                tenant: tenant.into(),
                token: token.into(),
                chosen_username: None,
            })
            .ok()
            .unwrap();
        generation
    }

    /// Collects events until `pred` matches one (returned) or `secs` elapse.
    pub fn until(&self, secs: u64, pred: impl Fn(&UiEvent) -> bool) -> Option<UiEvent> {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < deadline {
            if let Ok(event) = self.rx.recv_timeout(Duration::from_millis(50)) {
                self.seen.lock().unwrap().push(event.clone());
                if pred(&event) {
                    return Some(event);
                }
            }
        }
        None
    }

    pub fn quiet_for(&self, millis: u64) -> Vec<UiEvent> {
        let mut out = Vec::new();
        let deadline = Instant::now() + Duration::from_millis(millis);
        while Instant::now() < deadline {
            if let Ok(event) = self.rx.recv_timeout(Duration::from_millis(20)) {
                out.push(event);
            }
        }
        out
    }
}

/// Drives the real worker with the real reducer exactly like the GUI does.
pub struct Pump<'a> {
    pub rig: &'a Rig,
    pub state: AppState,
}

impl Pump<'_> {
    pub fn dispatch(&mut self, commands: Vec<Command>) {
        for command in commands {
            match command {
                Command::Disconnect => {
                    self.rig.worker.next_generation();
                }
                command => {
                    if let Err(rejected) = self.rig.worker.send(command) {
                        self.state.on_rejected(*rejected);
                    }
                }
            }
        }
    }

    pub fn until(&mut self, secs: u64, done: impl Fn(&AppState) -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < deadline {
            if done(&self.state) {
                return true;
            }
            if let Ok(event) = self.rig.rx.recv_timeout(Duration::from_millis(30)) {
                let commands = self.state.apply(event);
                self.dispatch(commands);
            }
            let deferred = self.state.take_deferred();
            self.dispatch(deferred);
        }
        done(&self.state)
    }
}
