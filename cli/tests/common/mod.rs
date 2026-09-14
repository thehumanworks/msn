use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub struct Scripted {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub delay: Duration,
}

impl Scripted {
    pub fn json(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: body.to_string(),
            delay: Duration::ZERO,
        }
    }

    pub fn empty(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: String::new(),
            delay: Duration::ZERO,
        }
    }

    pub fn redirect(location: &str) -> Self {
        Self {
            status: 302,
            headers: vec![("Location".into(), location.to_string())],
            body: String::new(),
            delay: Duration::ZERO,
        }
    }

    pub fn delayed(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }
}

#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
    pub at: Instant,
}

pub struct MockServer {
    pub addr: std::net::SocketAddr,
    requests: Arc<Mutex<Vec<Recorded>>>,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
}

impl MockServer {
    pub fn spawn(responses: Vec<Scripted>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        listener.set_nonblocking(false).ok();
        let addr = listener.local_addr().expect("addr");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let queue = Arc::new(Mutex::new(VecDeque::from(responses)));
        let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reqs = Arc::clone(&requests);
        let q = Arc::clone(&queue);
        let stop = Arc::clone(&shutdown);
        thread::spawn(move || {
            listener
                .set_nonblocking(true)
                .expect("nonblocking accept so shutdown can finish");
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if stop.load(std::sync::atomic::Ordering::SeqCst) {
                            break;
                        }
                        handle_one(stream, &reqs, &q, &stop);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            addr,
            requests,
            shutdown,
        }
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.addr.port())
    }

    pub fn recorded(&self) -> Vec<Recorded> {
        self.requests.lock().expect("lock").clone()
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.shutdown
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = TcpStream::connect_timeout(&self.addr, Duration::from_millis(50));
    }
}

fn handle_one(
    mut stream: TcpStream,
    requests: &Arc<Mutex<Vec<Recorded>>>,
    responses: &Arc<Mutex<VecDeque<Scripted>>>,
    stop: &Arc<std::sync::atomic::AtomicBool>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let mut buf = Vec::new();
    let mut tmp = [0u8; 2048];
    let header_end = loop {
        match stream.read(&mut tmp) {
            Ok(0) => return,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if let Some(pos) = find_header_end(&buf) {
                    break pos;
                }
                if buf.len() > 64 * 1024 {
                    return;
                }
            }
            Err(_) => return,
        }
    };
    let header_block = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = header_block.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let content_len = headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < content_len {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => body.extend_from_slice(&tmp[..n]),
            Err(_) => break,
        }
    }
    body.truncate(content_len);
    requests.lock().expect("lock").push(Recorded {
        method,
        path,
        headers,
        body,
        at: Instant::now(),
    });
    let scripted = responses.lock().expect("lock").pop_front();
    let Some(scripted) = scripted else {
        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(20));
        }
        return;
    };
    if !scripted.delay.is_zero() {
        let start = Instant::now();
        while start.elapsed() < scripted.delay && !stop.load(std::sync::atomic::Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(20));
        }
        if stop.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
    }
    let reason = reason_phrase(scripted.status);
    let mut out = format!(
        "HTTP/1.1 {} {}\r\nConnection: close\r\n",
        scripted.status, reason
    );
    if !scripted.body.is_empty() {
        out.push_str(&format!("Content-Length: {}\r\n", scripted.body.len()));
    } else if scripted.status != 204 {
        out.push_str("Content-Length: 0\r\n");
    }
    for (name, value) in &scripted.headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str("\r\n");
    out.push_str(&scripted.body);
    let _ = stream.write_all(out.as_bytes());
    let _ = stream.flush();
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        410 => "Gone",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Unknown",
    }
}
