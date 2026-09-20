//! A small stateful fake of the msn Worker (channels, idempotent sends, catchup, point reads,
//! snapshots and the coordination events journal with real long-poll waiting), served over real
//! HTTP by `tiny_http`. Response shapes follow `src/store.ts`: channels are `{name,..}`, a send
//! returns `{message:{id,..},replayed}`, and deleted messages never appear in pages.

#![allow(dead_code)]

pub mod rig;

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tiny_http::{Header, Method, Response, Server};

pub const TENANT: &str = "acme";
pub const TOKEN: &str = "test-token";

#[derive(Clone)]
pub struct Logged {
    pub method: String,
    pub path: String,
    pub query: HashMap<String, String>,
    pub idempotency_key: Option<String>,
    pub body: Option<String>,
}

#[derive(Clone)]
struct Msg {
    id: u64,
    username: String,
    text: String,
    deleted: bool,
}

#[derive(Default)]
struct Chan {
    messages: Vec<Msg>,
    revision: u64,
}

#[derive(Clone)]
struct Event {
    id: u64,
    channel: String,
    kind: &'static str,
    resource: Option<u64>,
    revision: u64,
}

#[derive(Default)]
struct Inner {
    channels: BTreeMap<String, Chan>,
    events: Vec<Event>,
    next_message_id: u64,
    idempotency: HashMap<String, (u64, String)>,
}

pub struct Fake {
    inner: Mutex<Inner>,
    cv: Condvar,
    pub log: Mutex<Vec<Logged>>,
    valid_token: Mutex<String>,
    pub bound_username: Mutex<Option<String>>,
    pub fail_next_posts: AtomicUsize,
    pub corrupt_events: AtomicBool,
    pub missing_events: AtomicBool,
    shutdown: AtomicBool,
}

impl Fake {
    pub fn new() -> Arc<Self> {
        Arc::new(Fake {
            inner: Mutex::new(Inner {
                next_message_id: 1,
                ..Inner::default()
            }),
            cv: Condvar::new(),
            log: Mutex::new(Vec::new()),
            valid_token: Mutex::new(TOKEN.into()),
            bound_username: Mutex::new(Some("alice".into())),
            fail_next_posts: AtomicUsize::new(0),
            corrupt_events: AtomicBool::new(false),
            missing_events: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
        })
    }

    pub fn revoke_token(&self) {
        *self.valid_token.lock().unwrap() = "revoked".into();
        self.cv.notify_all();
    }

    pub fn requests(&self, method: &str, path_contains: &str) -> usize {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|l| l.method == method && l.path.contains(path_contains))
            .count()
    }

    pub fn logged(&self, method: &str, path_contains: &str) -> Vec<Logged> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|l| l.method == method && l.path.contains(path_contains))
            .cloned()
            .collect()
    }

    fn push_event(inner: &mut Inner, channel: &str, kind: &'static str, resource: Option<u64>) {
        let revision = inner.channels.get(channel).map(|c| c.revision).unwrap_or(0);
        let id = inner.events.len() as u64 + 1;
        inner.events.push(Event {
            id,
            channel: channel.into(),
            kind,
            resource,
            revision,
        });
    }

    pub fn create_channel(&self, name: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.channels.contains_key(name) {
            return false;
        }
        inner.channels.insert(name.into(), Chan::default());
        Self::push_event(&mut inner, name, "channel.created", None);
        self.cv.notify_all();
        true
    }

    /// A message from another participant, appended server-side (with its event).
    pub fn add_message(&self, channel: &str, username: &str, text: &str) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        inner.channels.entry(channel.into()).or_default();
        let id = inner.next_message_id;
        inner.next_message_id += 1;
        inner.channels.get_mut(channel).unwrap().messages.push(Msg {
            id,
            username: username.into(),
            text: text.into(),
            deleted: false,
        });
        Self::push_event(&mut inner, channel, "message.created", Some(id));
        self.cv.notify_all();
        id
    }

    /// Admin deletion: tombstone, bump the revision, then emit the event with the new revision.
    pub fn delete_message(&self, channel: &str, id: u64) {
        let mut inner = self.inner.lock().unwrap();
        let chan = inner.channels.get_mut(channel).unwrap();
        chan.messages
            .iter_mut()
            .find(|m| m.id == id)
            .unwrap()
            .deleted = true;
        chan.revision += 1;
        Self::push_event(&mut inner, channel, "message.deleted", Some(id));
        self.cv.notify_all();
    }

    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.cv.notify_all();
    }

    fn message_json(channel: &str, m: &Msg) -> Value {
        json!({"id": m.id, "tenant": TENANT, "channel": channel, "username": m.username,
               "text": m.text,
               "contentType": if m.text.starts_with('{') { "application/json" } else { "text/plain" }, "createdAt": "2026-01-01T00:00:00.000Z"})
    }

    fn event_json(e: &Event) -> Value {
        json!({"id": e.id, "tenant": TENANT, "channel": e.channel, "type": e.kind,
               "resourceId": e.resource, "historyRevision": e.revision,
               "createdAt": "2026-01-01T00:00:00.000Z"})
    }

    fn error(status: u16, code: &str, message: &str) -> (u16, Value) {
        (status, json!({"error": {"code": code, "message": message}}))
    }

    fn handle(
        &self,
        method: &str,
        path: &str,
        query: &HashMap<String, String>,
        auth: Option<&str>,
        idem: Option<&str>,
        body: Option<&str>,
    ) -> (u16, Value) {
        let expected = format!("Bearer {}", self.valid_token.lock().unwrap());
        if auth != Some(expected.as_str()) {
            return Self::error(401, "unauthorized", "Invalid access token.");
        }
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        let number = |name: &str, default: u64| {
            query
                .get(name)
                .and_then(|v| v.parse().ok())
                .unwrap_or(default)
        };
        match (method, parts.as_slice()) {
            ("GET", ["api", "tenants", t]) if *t == TENANT => {
                let mut identity = json!({"tenant": TENANT});
                if let Some(name) = self.bound_username.lock().unwrap().as_ref() {
                    identity["username"] = json!(name);
                }
                (200, identity)
            }
            ("GET", ["api", "tenants", t, "channels"]) if *t == TENANT => {
                let inner = self.inner.lock().unwrap();
                let rows: Vec<Value> = inner
                    .channels
                    .iter()
                    .map(|(name, c)| {
                        json!({"name": name, "createdAt": "2026-01-01T00:00:00.000Z",
                        "messageCount": c.messages.iter().filter(|m| !m.deleted).count()})
                    })
                    .collect();
                let next = inner.channels.keys().last().cloned().unwrap_or_default();
                (
                    200,
                    json!({"channels": rows, "nextCursor": next, "hasMore": false}),
                )
            }
            ("PUT", ["api", "tenants", t, "channels", name]) if *t == TENANT => {
                let created = self.create_channel(name);
                (
                    if created { 201 } else { 200 },
                    json!({"channel": name, "created": created}),
                )
            }
            ("POST", ["api", "tenants", t, "channels", channel, "messages"]) if *t == TENANT => {
                if self.fail_next_posts.load(Ordering::SeqCst) > 0 {
                    self.fail_next_posts.fetch_sub(1, Ordering::SeqCst);
                    return Self::error(503, "unavailable", "try again");
                }
                let payload: Value =
                    serde_json::from_str(body.unwrap_or("{}")).unwrap_or(Value::Null);
                let mut inner = self.inner.lock().unwrap();
                if !inner.channels.contains_key(*channel) {
                    return Self::error(404, "channel_not_found", "Channel not found.");
                }
                let key = format!("{channel}:{}", idem.unwrap_or(""));
                let payload_text = body.unwrap_or("").to_string();
                if let Some((id, original)) = inner.idempotency.get(&key).cloned() {
                    if original != payload_text {
                        return Self::error(
                            409,
                            "idempotency_conflict",
                            "Key reused with another body.",
                        );
                    }
                    let m = inner.channels[*channel]
                        .messages
                        .iter()
                        .find(|m| m.id == id)
                        .unwrap()
                        .clone();
                    return (
                        200,
                        json!({"message": Self::message_json(channel, &m), "replayed": true}),
                    );
                }
                let id = inner.next_message_id;
                inner.next_message_id += 1;
                let msg = Msg {
                    id,
                    username: payload["username"].as_str().unwrap_or("?").into(),
                    text: payload["text"].as_str().unwrap_or("").into(),
                    deleted: false,
                };
                inner
                    .channels
                    .get_mut(*channel)
                    .unwrap()
                    .messages
                    .push(msg.clone());
                inner.idempotency.insert(key, (id, payload_text));
                Self::push_event(&mut inner, channel, "message.created", Some(id));
                self.cv.notify_all();
                (
                    201,
                    json!({"message": Self::message_json(channel, &msg), "replayed": false}),
                )
            }
            ("GET", ["api", "tenants", t, "channels", channel, "messages", id]) if *t == TENANT => {
                let inner = self.inner.lock().unwrap();
                let Some(chan) = inner.channels.get(*channel) else {
                    return Self::error(404, "channel_not_found", "Channel not found.");
                };
                match chan.messages.iter().find(|m| m.id.to_string() == *id) {
                    None => Self::error(404, "message_not_found", "Message not found."),
                    Some(m) if m.deleted => {
                        Self::error(410, "message_deleted", "This message was deleted.")
                    }
                    Some(m) => (
                        200,
                        json!({"message": Self::message_json(channel, m), "historyRevision": chan.revision}),
                    ),
                }
            }
            ("GET", ["api", "tenants", t, "channels", channel, "catchup"]) if *t == TENANT => {
                let inner = self.inner.lock().unwrap();
                let Some(chan) = inner.channels.get(*channel) else {
                    return Self::error(404, "channel_not_found", "Channel not found.");
                };
                let after = number("after", 0);
                let limit = number("limit", 20) as usize;
                let head = chan.messages.iter().map(|m| m.id).max().unwrap_or(0);
                let pending: Vec<&Msg> = chan
                    .messages
                    .iter()
                    .filter(|m| !m.deleted && m.id > after)
                    .collect();
                let page: Vec<Value> = pending
                    .iter()
                    .take(limit)
                    .map(|m| Self::message_json(channel, m))
                    .collect();
                let next = page.last().and_then(|m| m["id"].as_u64()).unwrap_or(after);
                (
                    200,
                    json!({"snapshot": null, "snapshotVersion": 0, "historyRevision": chan.revision,
                    "messages": page, "nextCursor": next, "hasMore": pending.len() > limit,
                    "incomplete": pending.len() > limit, "headCursor": head, "pendingMessages": pending.len()}),
                )
            }
            ("GET", ["api", "tenants", t, "channels", channel, "snapshots"]) if *t == TENANT => {
                let inner = self.inner.lock().unwrap();
                let revision = inner
                    .channels
                    .get(*channel)
                    .map(|c| c.revision)
                    .unwrap_or(0);
                (
                    200,
                    json!({"snapshots": [], "nextCursor": number("after", 0), "hasMore": false,
                    "snapshotVersion": 0, "historyRevision": revision}),
                )
            }
            ("GET", ["api", "tenants", t, "events"]) if *t == TENANT => {
                let result = self.events(query);
                // Like the real server, re-authenticate after the wait: revocation ends the poll.
                let still_valid = format!("Bearer {}", self.valid_token.lock().unwrap());
                if auth != Some(still_valid.as_str()) {
                    return Self::error(401, "unauthorized", "Invalid access token.");
                }
                result
            }
            _ => Self::error(404, "route_not_found", "Unknown endpoint or method."),
        }
    }

    fn events(&self, query: &HashMap<String, String>) -> (u16, Value) {
        if self.missing_events.load(Ordering::SeqCst) {
            return Self::error(
                404,
                "not_found",
                "Unknown endpoint or method. Message deletion is only available under /api/admin/.",
            );
        }
        let number = |name: &str, default: u64| {
            query
                .get(name)
                .and_then(|v| v.parse().ok())
                .unwrap_or(default)
        };
        let after = number("after", 0);
        let limit = number("limit", 100) as usize;
        let wait = number("wait", 0).min(25);
        let filter = query.get("channel");
        let deadline = Instant::now() + Duration::from_secs(wait);
        let mut inner = self.inner.lock().unwrap();
        loop {
            let rows: Vec<&Event> = inner
                .events
                .iter()
                .filter(|e| e.id > after && filter.is_none_or(|c| *c == e.channel))
                .collect();
            let now = Instant::now();
            if !rows.is_empty()
                || wait == 0
                || now >= deadline
                || self.shutdown.load(Ordering::SeqCst)
            {
                let page: Vec<Value> = rows
                    .iter()
                    .take(limit)
                    .map(|e| Self::event_json(e))
                    .collect();
                let mut next = page.last().and_then(|e| e["id"].as_u64()).unwrap_or(after);
                if self.corrupt_events.load(Ordering::SeqCst) && !page.is_empty() {
                    next += 7;
                }
                return (
                    200,
                    json!({"events": page, "nextCursor": next, "hasMore": rows.len() > limit}),
                );
            }
            let (guard, _) = self.cv.wait_timeout(inner, deadline - now).unwrap();
            inner = guard;
        }
    }
}

pub struct MockServer {
    pub origin: String,
    pub fake: Arc<Fake>,
    handle: Option<JoinHandle<()>>,
    server: Arc<Server>,
}

impl MockServer {
    pub fn start() -> Self {
        let fake = Fake::new();
        let server = Arc::new(Server::http("127.0.0.1:0").expect("bind mock server"));
        let origin = format!("http://{}", server.server_addr());
        let accept = Arc::clone(&server);
        let state = Arc::clone(&fake);
        let handle = std::thread::spawn(move || {
            for mut request in accept.incoming_requests() {
                let state = Arc::clone(&state);
                std::thread::spawn(move || {
                    let method = request.method().as_str().to_string();
                    let raw = request.url().to_string();
                    let parsed = url::Url::parse(&format!("http://localhost{raw}")).unwrap();
                    let query: HashMap<String, String> = parsed
                        .query_pairs()
                        .map(|(k, v)| (k.into_owned(), v.into_owned()))
                        .collect();
                    let header = |name: &str| {
                        request
                            .headers()
                            .iter()
                            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
                            .map(|h| h.value.as_str().to_string())
                    };
                    let auth = header("authorization");
                    let idem = header("idempotency-key");
                    let mut body = String::new();
                    if matches!(request.method(), Method::Post | Method::Put) {
                        let _ = request.as_reader().read_to_string(&mut body);
                    }
                    let body = (!body.is_empty()).then_some(body);
                    state.log.lock().unwrap().push(Logged {
                        method: method.clone(),
                        path: parsed.path().to_string(),
                        query: query.clone(),
                        idempotency_key: idem.clone(),
                        body: body.clone(),
                    });
                    let (status, json) = state.handle(
                        &method,
                        parsed.path(),
                        &query,
                        auth.as_deref(),
                        idem.as_deref(),
                        body.as_deref(),
                    );
                    let response = Response::from_data(serde_json::to_vec(&json).unwrap())
                        .with_status_code(status)
                        .with_header(
                            Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                                .unwrap(),
                        );
                    let _ = request.respond(response);
                });
            }
        });
        MockServer {
            origin,
            fake,
            handle: Some(handle),
            server,
        }
    }

    pub fn url(&self) -> url::Url {
        url::Url::parse(&self.origin).unwrap()
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.fake.shutdown();
        self.server.unblock();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}
