//! The wire protocol of the built-in remote access API, kept free of any Tauri types so
//! it can be unit-tested on its own. The desktop app (`app/src-tauri/src/remote.rs`)
//! supplies the router that answers these requests.
//!
//! Auth is a single bearer token, generated on first start and shown in the window.
//! This is a LAN control port that can delete files and drive a GPU: treat the token as
//! the only thing between a stranger's phone and your machine, and say so in the UI.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};

use crate::config::Config;
use crate::generate::GenResult;

/// The API version a client can pin against.
pub const API: u32 = 1;

// ── Job state ────────────────────────────────────────────────────────────────

/// One generation at a time, the same rule the window enforces through its busy flag.
/// A remote client starts a job and polls it, because a 2K render outruns any
/// reasonable HTTP read timeout.
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    /// idle | running | done | error
    pub state: &'static str,
    pub stage: String,
    pub value: u32,
    pub max: u32,
    pub prompt: String,
    pub started_by: String,
    pub result: Option<GenResult>,
    pub error: Option<String>,
}

pub type JobCell = Arc<Mutex<Job>>;

pub fn new_job() -> JobCell {
    Arc::new(Mutex::new(Job { state: "idle", ..Default::default() }))
}

/// Marks a job as running. Returns false when another job is still in flight, so the
/// caller can answer 409 instead of queueing a second render.
pub fn begin(job: &JobCell, prompt: &str, by: &str) -> bool {
    let mut j = job.lock().unwrap();
    if j.state == "running" {
        return false;
    }
    j.state = "running";
    j.stage = "load".into();
    j.value = 0;
    j.max = 0;
    j.prompt = prompt.to_string();
    j.started_by = by.to_string();
    j.result = None;
    j.error = None;
    true
}

/// Folds one progress tick into the job; ignored once the job has settled.
pub fn advance(job: &JobCell, stage: &str, value: u32, max: u32) {
    let mut j = job.lock().unwrap();
    if j.state == "running" {
        j.stage = stage.to_string();
        j.value = value;
        j.max = max;
    }
}

pub fn settle(job: &JobCell, result: Option<GenResult>, error: Option<String>) {
    let mut j = job.lock().unwrap();
    if let Some(r) = result {
        j.state = "done";
        j.result = Some(r);
    } else {
        j.state = "error";
        j.error = Some(error.unwrap_or_else(|| "failed".into()));
    }
}

// ── Request ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    pub fn param(&self, name: &str) -> Option<&str> {
        self.query.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    pub fn json(&self) -> Result<Value, String> {
        serde_json::from_slice(&self.body).map_err(|e| format!("body must be JSON: {e}"))
    }
    /// True when the client asked for a header/body the router should treat as a string field.
    pub fn field(&self, key: &str) -> Option<String> {
        self.json().ok().and_then(|v| v.get(key).and_then(Value::as_str).map(str::to_string))
    }
}

const MAX_HEADER: usize = 64 * 1024;
const MAX_BODY: usize = 64 * 1024 * 1024;

/// Reads one request off the wire. Generic over `Read` so the parser is testable without
/// a socket. Returns `Ok(None)` when the peer hung up before sending anything.
pub fn read_request<R: Read>(stream: &mut R) -> std::io::Result<Option<Request>> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        let n = match stream.read(&mut chunk)? {
            0 => return Ok(None),
            n => n,
        };
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > MAX_HEADER {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "headers too large"));
        }
    };

    let head = String::from_utf8_lossy(&buf[..head_end]).replace("\r\n", "\n");
    let mut lines = head.split('\n');
    let mut parts = lines.next().unwrap_or("").trim_end().splitn(3, ' ');
    let method = parts.next().unwrap_or("").to_uppercase();
    let target = parts.next().unwrap_or("/");
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (percent_decode(p), parse_query(q)),
        None => (percent_decode(target), Vec::new()),
    };
    let mut headers = Vec::new();
    for line in lines.filter(|l| !l.is_empty()) {
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }

    let want = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.trim().parse::<usize>().ok()).unwrap_or(0);
    if want > MAX_BODY {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "body too large"));
    }
    let mut body = buf[head_end..].to_vec();
    while body.len() < want {
        match stream.read(&mut chunk)? {
            0 => break,
            n => body.extend_from_slice(&chunk[..n]),
        }
    }
    body.truncate(want);

    Ok(Some(Request { method, path, query, headers, body }))
}

pub fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|s| !s.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((k, v)) => (decode_query(k), decode_query(v)),
            None => (decode_query(pair), String::new()),
        })
        .collect()
}

/// In a query component a `+` is the form encoding for a space, and plenty of correct
/// clients send one for the space in `C:\...\Qwen Image Local\`. The path keeps the
/// strict decoder, where `+` means a literal plus.
fn decode_query(s: &str) -> String {
    percent_decode(&s.replace('+', " "))
}

/// Only what an HTTP client itself encodes: `%XX`. A `+` stays a `+`, because our query
/// values are file paths rather than form fields.
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ── Reply ────────────────────────────────────────────────────────────────────

pub struct Reply {
    pub status: u16,
    pub ctype: String,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(status: u16, v: Value) -> Self {
        Reply { status, ctype: "application/json; charset=utf-8".into(), body: v.to_string().into_bytes() }
    }
    pub fn bytes(status: u16, ctype: &str, body: Vec<u8>) -> Self {
        Reply { status, ctype: ctype.to_string(), body }
    }
    /// The status line as bytes, for assertions without a socket.
    pub fn head(&self) -> String {
        let reason = match self.status {
            200 => "OK",
            202 => "Accepted",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            409 => "Conflict",
            _ => "Server Error",
        };
        format!("HTTP/1.1 {} {reason}\r\ncontent-type: {}\r\ncontent-length: {}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n", self.status, self.ctype, self.body.len())
    }
    pub fn send(self, stream: &mut TcpStream) -> std::io::Result<()> {
        stream.write_all(self.head().as_bytes())?;
        stream.write_all(&self.body)?;
        stream.flush()
    }
}

// ── Guards ───────────────────────────────────────────────────────────────────

/// Accepts the bearer header or a `?token=` query (an `<img>` src cannot send headers).
pub fn authorized(req: &Request, cfg: &Config) -> bool {
    let want: Vec<u8> = cfg.remote.token.bytes().collect();
    if want.is_empty() {
        return false; // nothing can be right until the app has minted one
    }
    let given = match req.header("authorization") {
        Some(h) if h.len() > 7 => h[7..].trim().to_string(),
        Some(_) => String::new(),
        None => req.param("token").unwrap_or("").to_string(),
    };
    let got: Vec<u8> = given.bytes().collect();
    want.len() == got.len() && want.iter().zip(got.iter()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0
}

/// Resolves `candidate` only if it really lives under `dir`. Symlinks and `..` are
/// settled by canonicalize on both sides, so a crafted path cannot climb out.
pub fn inside(dir: &Path, candidate: &str) -> Option<PathBuf> {
    let root = dir.canonicalize().ok()?;
    let file = Path::new(candidate).canonicalize().ok()?;
    file.starts_with(&root).then_some(file)
}

/// The addresses a phone could actually type. The UDP-route trick is not enough on its
/// own: with a VPN or proxy TUN adapter up, "the default route" is a 198.x virtual NIC
/// that nothing on the LAN can reach. So enumerate the real interfaces and keep only the
/// private ranges, falling back to the default-route address if parsing yields nothing.
pub fn lan_urls(port: u16) -> Vec<String> {
    let mut ips: Vec<String> = private_ipv4s();
    if ips.is_empty() {
        if let Some(ip) = default_route_ipv4() {
            ips.push(ip);
        }
    }
    let mut out = vec![format!("http://127.0.0.1:{port}")];
    for ip in ips {
        let url = format!("http://{ip}:{port}");
        if !out.contains(&url) {
            out.push(url);
        }
    }
    out
}

fn default_route_ipv4() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // Sends nothing; it only asks the OS which source address this route would use.
    sock.connect("223.5.5.5:80").ok()?;
    let addr = sock.local_addr().ok()?;
    (!addr.ip().is_loopback()).then(|| addr.ip().to_string())
}

fn private_ipv4s() -> Vec<String> {
    let text = interface_dump();
    extract_ipv4s(&text).into_iter().filter(|ip| is_private(ip)).collect()
}

fn is_private(ip: &str) -> bool {
    let oct: Vec<u8> = ip.split('.').filter_map(|o| o.parse().ok()).collect();
    matches!(oct.as_slice(),
        [10, ..] | [192, 168, ..] | [172, 16..=31, ..] | [127, ..]
    )
}

/// Every IPv4 in `text` — `ipconfig` and `ifconfig` both print them in prose we can
/// simply scan, which keeps this testable without a machine to query.
pub fn extract_ipv4s(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    'outer: while i < bytes.len() {
        // must start at a digit that is not part of a longer number
        if !(bytes[i].is_ascii_digit() || bytes[i] == b'.') {
            i += 1;
            continue;
        }
        if i > 0 && (bytes[i - 1].is_ascii_digit() || bytes[i - 1] == b'.') {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b'.') {
            j += 1;
        }
        let cand = &text[i..j];
        let oct: Vec<u16> = cand.split('.').filter_map(|p| p.parse().ok()).collect();
        if oct.len() == 4 && oct.iter().all(|o| *o < 256) && cand.matches('.').count() == 3 {
            out.push(cand.to_string());
            i = j;
            continue 'outer;
        }
        i = j.max(i + 1);
    }
    out
}

/// Runs the platform's interface listing. No new dependency, and `no_window` keeps it
/// from flashing a console on Windows, the same way the GPU probe does.
fn interface_dump() -> String {
    #[cfg(windows)]
    let mut cmd = std::process::Command::new("ipconfig");
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = std::process::Command::new("ip");
        c.args(["-4", "addr"]);
        c
    };
    let out = crate::gpu::no_window(&mut cmd).output().ok();
    String::from_utf8_lossy(&out.map(|o| o.stdout).unwrap_or_default()).into_owned()
}


/// History as the window renders it: newest first, sidecar JSON attached, plus a URL a
/// client can fetch the pixels from (with a `token=` because an `<img>` cannot sign).
pub fn list_outputs(cfg: &Config, limit: usize) -> Vec<Value> {
    let Ok(rd) = std::fs::read_dir(&cfg.output_dir) else { return vec![] };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("png")))
        .filter_map(|p| Some((p.metadata().ok()?.modified().ok()?, p)))
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    files
        .into_iter()
        .take(limit)
        .map(|(_, p)| {
            let path = p.to_string_lossy().into_owned();
            json!({
                "path": path,
                "name": p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                "url": format!("/api/file?p={}&token=<TOKEN>", url_encode(&path)),
                "meta": std::fs::read(p.with_extension("json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()),
            })
        })
        .collect()
}

/// The same shortcuts the window offers under the instruction box. If you change one of
/// the two lists, change the other (`app/ui/app.js`).
pub fn quick_prompts() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Remove background", "Remove the background, and output a PNG image"),
        ("Snowy night", "Change the scene to a snowy winter night with warm lights in the windows. Keep everything else the same."),
        ("Watercolor", "Turn this photo into a hand-painted watercolor illustration. Keep the composition."),
        ("Golden hour", "Relight this photo as a golden-hour scene with soft warm sunlight. Keep the subject and composition identical."),
        ("Remove people", "Remove all the people from the photo and fill the background naturally. Keep everything else identical."),
        ("Combine 1 + 2", "Place the subject from <image2> into the scene of <image1>, matching lighting and perspective, with a realistic contact shadow."),
    ]
}

/// The shape of the API, so a client can discover it without a spec.
pub fn capabilities() -> Value {
    json!({
        "api": API,
        "endpoints": [
            "GET /api/ping", "GET /api/status", "GET /api/settings", "POST /api/settings",
            "POST /api/engine/start", "POST /api/engine/stop", "POST /api/generate",
            "GET /api/job", "POST /api/job/cancel", "GET /api/history", "GET /api/file",
            "POST /api/delete", "POST /api/upload",
        ],
        "modes": ["text", "photos", "surprise"],
        "presets": ["draft", "standard", "max"],
        "aspects": ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"],
        "maxRefs": 10,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(text: &str) -> Request {
        let mut cursor = std::io::Cursor::new(text.as_bytes().to_vec());
        read_request(&mut cursor).unwrap().unwrap()
    }

    #[test]
    fn parses_a_post_with_a_json_body() {
        let req = raw("POST /api/generate?token=abc123 HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\nauthorization: Bearer abc123\r\ncontent-length: 15\r\n\r\n{\"mode\":\"text\"}IGNORED");
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/api/generate");
        assert_eq!(req.param("token"), Some("abc123"));
        assert_eq!(req.header("Authorization"), Some("Bearer abc123"));
        assert_eq!(req.body, b"{\"mode\":\"text\"}", "bytes past content-length are not ours");
        assert_eq!(req.json().unwrap()["mode"], "text");
    }

    #[test]
    fn parses_a_get_with_encoded_paths_and_no_body() {
        let req = raw("GET /api/file?p=C%3A%5Cout%5Ca%20b.png HTTP/1.1\r\nhost: x\r\n\r\n");
        assert_eq!(req.path, "/api/file");
        assert_eq!(req.param("p").unwrap(), r"C:\out\a b.png");
        assert!(req.body.is_empty());
    }

    #[test]
    fn reads_a_request_split_across_reads() {
        // One chunk at a time: the parser must keep scanning for the header terminator.
        let text = "GET /api/ping HTTP/1.1\r\nx: 1\r\n\r\n";
        let bytes = text.as_bytes().to_vec();
        let mut slow = SlowReader { data: bytes, step: 3 };
        let req = read_request(&mut slow).unwrap().unwrap();
        assert_eq!(req.path, "/api/ping");
        assert_eq!(req.header("x"), Some("1"));
    }

    struct SlowReader {
        data: Vec<u8>,
        step: usize,
    }
    impl Read for SlowReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.data.is_empty() {
                return Ok(0);
            }
            let n = self.step.min(self.data.len()).min(buf.len());
            buf[..n].copy_from_slice(&self.data[..n]);
            self.data.drain(..n);
            Ok(n)
        }
    }

    #[test]
    fn empty_input_is_a_closed_peer_not_a_panic() {
        let mut none = std::io::Cursor::new(Vec::new());
        assert!(read_request(&mut none).unwrap().is_none());
    }

    #[test]
    fn percent_and_query_helpers() {
        assert_eq!(percent_decode("a%20b+c"), "a b+c", "paths are not form fields");
        assert_eq!(parse_query("limit=5&x=").len(), 2);
        assert_eq!(parse_query("").len(), 0);
        assert_eq!(url_encode(r"C:\a 图.png").contains(' '), false);
        assert_eq!(percent_decode(&url_encode(r"C:\a 图.png")), r"C:\a 图.png");
    }

    #[test]
    fn a_query_plus_is_a_space_so_both_encodings_reach_the_same_file() {
        // The phone once sent Qwen+Image+Local and got a 403, because the path decoder
        // (correctly) leaves + alone. Query values must accept both spellings.
        let dir = std::env::temp_dir().join(format!("qil-remote-space-{}", std::process::id()));
        let sub = dir.join("Qwen Image Local");
        std::fs::create_dir_all(&sub).unwrap();
        let file = sub.join("a b.png");
        std::fs::write(&file, b"png").unwrap();

        let plus = format!("p={}", file.to_string_lossy().replace(' ', "+"));
        let pct = format!("p={}", url_encode(&file.to_string_lossy()));
        let a = parse_query(&plus).remove(0).1;
        let b = parse_query(&pct).remove(0).1;
        assert_eq!(a, b, "+ and %20 must agree");
        assert_eq!(inside(&sub, &a), file.canonicalize().ok(), "and both must resolve to the file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn token_rules() {
        let mut cfg = Config::default();
        let req = raw("GET /api/status HTTP/1.1\r\nauthorization: Bearer abc123\r\n\r\n");
        assert!(!authorized(&req, &cfg), "an unminted token must reject everything");
        cfg.remote.token = "abc123".into();
        assert!(authorized(&req, &cfg));
        assert!(authorized(&raw("GET /api/status?token=abc123 HTTP/1.1\r\n\r\n", ), &cfg), "?token= is how an <img> signs a request");
        assert!(!authorized(&raw("GET /api/status?token=abc12 HTTP/1.1\r\n\r\n", ), &cfg), "one byte short");
        assert!(!authorized(&raw("GET /api/status?token=abc124 HTTP/1.1\r\n\r\n", ), &cfg), "one byte different");
        assert!(!authorized(&raw("GET /api/status HTTP/1.1\r\nauthorization: Bearer\r\n\r\n", ), &cfg), "header with no value");
        assert!(!authorized(&raw("GET /api/status HTTP/1.1\r\n\r\n", ), &cfg), "no credentials at all");
    }

    #[test]
    fn the_output_folder_is_the_only_readable_place() {
        let dir = std::env::temp_dir().join(format!("qil-remote-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let inside_file = dir.join("ok.png");
        std::fs::write(&inside_file, b"png").unwrap();
        assert_eq!(inside(&dir, &inside_file.to_string_lossy()), inside_file.canonicalize().ok());
        assert_eq!(inside(&dir, r"C:\Windows\System32\drivers\etc\hosts"), None);
        assert_eq!(inside(&dir, &dir.join("..\\escape.png").to_string_lossy()), None);
        assert_eq!(inside(&dir, "never-written.png"), None, "a missing file is not a hit");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_lists_newest_first_with_a_fetch_url() {
        let mut cfg = Config::default();
        cfg.output_dir = std::env::temp_dir().join(format!("qil-remote-hist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cfg.output_dir);
        std::fs::create_dir_all(&cfg.output_dir).unwrap();
        std::fs::write(cfg.output_dir.join("old.png"), b"a").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(cfg.output_dir.join("new.png"), b"bb").unwrap();
        std::fs::write(cfg.output_dir.join("new.json"), br#"{"prompt":"hi"}"#).unwrap();
        std::fs::write(cfg.output_dir.join("skip.txt"), b"c").unwrap();

        let items = list_outputs(&cfg, 10);
        assert_eq!(items.len(), 2, "only PNGs are outputs");
        assert_eq!(items[0]["name"], "new.png", "newest first");
        assert_eq!(items[0]["meta"]["prompt"], "hi");
        assert!(items[0]["url"].as_str().unwrap().starts_with("/api/file?p=C%3A"));
        assert!(items[1]["meta"].is_null(), "a missing sidecar is not an error");
        assert_eq!(list_outputs(&cfg, 1).len(), 1, "limit is honoured");
        let _ = std::fs::remove_dir_all(&cfg.output_dir);
    }

    #[test]
    fn job_state_transitions() {
        let job = new_job();
        assert_eq!(job.lock().unwrap().state, "idle");
        assert!(begin(&job, "a cat", "remote"));
        assert!(!begin(&job, "another", "remote"), "a running job refuses a second one");
        advance(&job, "sample", 7, 30);
        assert_eq!(job.lock().unwrap().value, 7);
        settle(&job, None, Some("boom".into()));
        assert_eq!(job.lock().unwrap().state, "error");
        assert_eq!(job.lock().unwrap().error.as_deref(), Some("boom"));
        advance(&job, "sample", 9, 9);
        assert_eq!(job.lock().unwrap().value, 7, "a settled job ignores late progress");
        assert!(begin(&job, "next", "window"), "the next run clears the old error");
        assert!(job.lock().unwrap().error.is_none());
    }

    #[test]
    fn replies_carry_length_and_no_cache() {
        let r = Reply::json(404, json!({ "error": "no such endpoint" }));
        let head = r.head();
        assert!(head.starts_with("HTTP/1.1 404 Not Found\r\n"), "{head}");
        assert!(head.contains("content-length: 28\r\n"), "body length must match: {}", r.body.len());
        assert_eq!(head.len() as u64 - head.rfind("\r\n\r\n").unwrap() as u64 - 4, 0);
        assert!(head.contains("cache-control: no-store"));
        assert!(head.contains("connection: close"));
    }

    #[test]
    fn lan_urls_never_advertise_the_wildcard() {
        let urls = lan_urls(8199);
        assert!(urls[0].starts_with("http://127.0.0.1:8199"));
        assert!(urls.iter().all(|u| !u.contains("0.0.0.0")), "{urls:?}");
        assert!(urls.iter().all(|u| u.ends_with(":8199")));
    }
    #[test]
    fn finds_the_lan_address_not_the_tunnel() {
        // A Windows box with a proxy TUN adapter: the default route is 198.18.x, which no
        // phone on the LAN can reach. The private NIC is the one worth advertising.
        let dump = r#"
Windows IP Configuration
Ethernet adapter Ethernet:
   IPv4 Address. . . . . . . . . . . : 192.168.1.42
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 192.168.1.1
Adapter (FlClash):
   IPv4 Address. . . . . . . . . . . : 198.18.0.1
   DHCP Server . . . . . . . . . . . : 0.0.0.0
   DNS Servers . . . . . . . : 192.168.1.1 8.8.8.8
"#;
        let all = extract_ipv4s(dump);
        assert!(all.contains(&"192.168.1.42".to_string()), "{all:?}");
        assert!(is_private("192.168.1.42"));
        assert!(is_private("10.0.0.5"));
        assert!(is_private("172.20.3.4"));
        assert!(!is_private("198.18.0.1"), "a TUN/benchmark range is not a LAN address");
        assert!(!is_private("8.8.8.8"));
        assert!(!is_private("255.255.255.255"));
        assert!(!is_private("172.32.0.1"), "172.16/12 only");
    }

    #[test]
    fn the_ip_scanner_ignores_masks_and_versions() {
        assert_eq!(extract_ipv4s("no addresses here"), Vec::<String>::new());
        assert_eq!(extract_ipv4s("255.255.255.0"), vec!["255.255.255.0"], "still an IPv4-shaped token");
        assert!(!extract_ipv4s("version 1.2.3.4.5").contains(&"1.2.3.4".to_string()), "five octets is not an IP");
        assert_eq!(extract_ipv4s("a1.2.3.4b").len(), 1);
        assert!(lan_urls(8199).iter().all(|u| u.starts_with("http://") && u.ends_with(":8199")));
        assert!(lan_urls(8199)[0].contains("127.0.0.1"));
    }

    #[test]
    fn interface_dump_runs_without_a_console() {
        // Whatever the machine has, this must not panic and must return text.
        let text = interface_dump();
        assert!(!text.is_empty(), "ipconfig should answer on a Windows box");
        assert!(extract_ipv4s(&text).iter().any(|ip| ip != "0.0.0.0") || extract_ipv4s(&text).is_empty());
    }
}
