//! Ask the warm inject daemon over its versioned unix socket — askDaemon in scripts/inject-context.js.
//! Resolves with the answer, or the fallback reason the JS client would have used:
//! 'no-daemon' (nothing listening), 'daemon-timeout' (3s for the answer; 20s from the FIRST warming line —
//! later warming lines do not extend it, so a daemon that only ever says warming cannot hold the prompt),
//! 'daemon-closed' (hung up without a full answer), 'daemon-error' (bad line / ok:false).
//!
//! Both deadlines are absolute (wall clock from the connect, like the JS setTimeout — the write counts), not per read: the
//! socket is read in raw chunks with the remaining time as the read timeout, and lines are split here — a
//! daemon trickling bytes without a newline runs into the same 3s as under the JS client.
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::envelope::Input;
use crate::jsval::{js_string, sanitize_lone_surrogate_escapes, truthy};
use crate::log::Meta;
use crate::paths;

const RESPONSE_TIMEOUT: Duration = Duration::from_millis(3000);
const WARMING_TIMEOUT: Duration = Duration::from_millis(20000);
/// An answer line larger than this is not a block the hook could print anyway — stop buffering.
const MAX_PENDING_BYTES: usize = 16 * 1024 * 1024;

pub struct Answer {
    pub context: String,
    pub ledger_keys: Vec<String>,
}

enum Line {
    Warming,
    Answer(Answer),
    Error,
}

fn parse_line(raw_line: &[u8]) -> Line {
    let text = String::from_utf8_lossy(raw_line);
    let res: Value = match serde_json::from_str(&sanitize_lone_surrogate_escapes(&text)) {
        Ok(v) => v,
        Err(_) => return Line::Error,
    };
    let Some(o) = res.as_object() else { return Line::Error };
    if truthy(o.get("warming")) {
        return Line::Warming;
    }
    if !truthy(o.get("ok")) {
        return Line::Error;
    }
    let ledger_keys = match o.get("ledger_keys") {
        Some(Value::Array(a)) => a.iter().filter_map(|k| k.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    };
    Line::Answer(Answer { context: js_string(o.get("context")), ledger_keys })
}

pub fn ask(index_dir: &Path, input: &Input, meta: &Meta) -> Result<Answer, &'static str> {
    let root = paths::plugin_root();
    let version = root.as_deref().and_then(paths::plugin_version);
    let sock = paths::inject_socket_path(index_dir, version.as_deref());
    // A unix-socket connect answers at once (ENOENT / ECONNREFUSED) — the JS 300ms connect timer never fires here.
    let mut stream = UnixStream::connect(&sock).map_err(|_| "no-daemon")?;
    // The 3s answer deadline starts here, before the request is written (JS arms it on connect): a daemon that
    // does not read a large request runs into daemon-timeout, not an unbounded write.
    let mut deadline = Instant::now() + RESPONSE_TIMEOUT;
    let _ = stream.set_write_timeout(Some(RESPONSE_TIMEOUT));

    let mut req = Map::new();
    req.insert("prompt".into(), Value::String(input.prompt.clone()));
    req.insert("cwd".into(), Value::String(input.cwd.clone()));
    req.insert("session_id".into(), Value::String(input.session_id.clone()));
    meta.extend(&mut req);
    let line = format!("{}\n", Value::Object(req));
    if let Err(e) = stream.write_all(line.as_bytes()) {
        return Err(if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut { "daemon-timeout" } else { "daemon-error" });
    }

    let mut warmed = false;
    let mut pending: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 65536];
    loop {
        while let Some(nl) = pending.iter().position(|&c| c == b'\n') {
            let raw_line: Vec<u8> = pending.drain(..=nl).collect();
            match parse_line(&raw_line[..raw_line.len() - 1]) {
                Line::Warming => {
                    if !warmed {
                        warmed = true;
                        deadline = Instant::now() + WARMING_TIMEOUT;
                    }
                }
                Line::Answer(a) => return Ok(a),
                Line::Error => return Err("daemon-error"),
            }
        }
        if pending.len() > MAX_PENDING_BYTES {
            return Err("daemon-error");
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("daemon-timeout");
        }
        let _ = stream.set_read_timeout(Some(remaining));
        match stream.read(&mut chunk) {
            Ok(0) => return Err("daemon-closed"), // EOF — with or without a partial line
            Ok(n) => pending.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => return Err("daemon-timeout"),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return Err("daemon-error"),
        }
    }
}

