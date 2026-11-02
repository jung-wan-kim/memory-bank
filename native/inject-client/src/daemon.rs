//! Ask the warm inject daemon over its versioned unix socket — askDaemon in scripts/inject-context.js.
//! Resolves with the answer, or the fallback reason the JS client would have used:
//! 'no-daemon' (nothing listening), 'daemon-timeout' (3s for the answer; 20s from the FIRST warming line —
//! later warming lines do not extend it, so a daemon that only ever says warming cannot hold the prompt),
//! 'daemon-closed' (hung up without a full answer), 'daemon-error' (bad line / ok:false).
//!
//! Both deadlines are absolute (wall clock from the request, like the JS setTimeout), not per read: the
//! socket is read in raw chunks with the remaining time as the read timeout, and lines are split here — a
//! daemon trickling bytes without a newline runs into the same 3s as under the JS client.
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::envelope::Input;
use crate::jsval::{js_string, truthy};
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

/// JSON.parse accepts a lone surrogate escape (`\ud83d` without its pair) and the string carries the lone
/// surrogate; writing it to stdout then yields U+FFFD. serde_json refuses the escape. Replace lone surrogate
/// escapes with `\ufffd` before parsing so both clients print the same bytes — the daemon can produce one
/// when a fact is cut at a UTF-16 index inside an astral character.
fn sanitize_lone_surrogate_escapes(text: &str) -> String {
    let b = text.as_bytes();
    let hex4 = |i: usize| -> Option<u32> {
        if i + 6 > b.len() || b[i] != b'\\' || b[i + 1] != b'u' {
            return None;
        }
        std::str::from_utf8(&b[i + 2..i + 6]).ok().and_then(|h| u32::from_str_radix(h, 16).ok())
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 1 < b.len() {
            if let Some(cp) = hex4(i) {
                if (0xD800..0xDC00).contains(&cp) {
                    match hex4(i + 6) {
                        Some(low) if (0xDC00..0xE000).contains(&low) => {
                            out.push_str(&text[i..i + 12]);
                            i += 12;
                        }
                        _ => {
                            out.push_str("\\ufffd");
                            i += 6;
                        }
                    }
                    continue;
                }
                if (0xDC00..0xE000).contains(&cp) {
                    out.push_str("\\ufffd");
                    i += 6;
                    continue;
                }
                out.push_str(&text[i..i + 6]);
                i += 6;
                continue;
            }
            // any other escape: copy the backslash and the escaped byte together (so `\\u` is not an escape)
            let end = (i + 2).min(b.len());
            out.push_str(&text[i..end]);
            i = end;
            continue;
        }
        // copy one UTF-8 character
        let ch_len = text[i..].chars().next().map(char::len_utf8).unwrap_or(1);
        out.push_str(&text[i..i + ch_len]);
        i += ch_len;
    }
    out
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
    let _ = stream.set_write_timeout(Some(RESPONSE_TIMEOUT));

    let mut req = Map::new();
    req.insert("prompt".into(), Value::String(input.prompt.clone()));
    req.insert("cwd".into(), Value::String(input.cwd.clone()));
    req.insert("session_id".into(), Value::String(input.session_id.clone()));
    meta.extend(&mut req);
    let line = format!("{}\n", Value::Object(req));
    if stream.write_all(line.as_bytes()).is_err() {
        return Err("daemon-error");
    }

    let mut deadline = Instant::now() + RESPONSE_TIMEOUT;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lone_surrogate_escapes_become_replacement_chars_and_pairs_survive() {
        assert_eq!(sanitize_lone_surrogate_escapes(r#"{"context":"a\ud83d"}"#), r#"{"context":"a\ufffd"}"#);
        assert_eq!(sanitize_lone_surrogate_escapes(r#"{"context":"\ud83d\ude00"}"#), r#"{"context":"\ud83d\ude00"}"#);
        assert_eq!(sanitize_lone_surrogate_escapes(r#"{"context":"\ude00x"}"#), r#"{"context":"\ufffdx"}"#);
        assert_eq!(sanitize_lone_surrogate_escapes(r#"{"c":"\\ud83d"}"#), r#"{"c":"\\ud83d"}"#); // escaped backslash, not an escape
        assert_eq!(sanitize_lone_surrogate_escapes("{\"c\":\"한글 🙂 \\u00e9\"}"), "{\"c\":\"한글 🙂 \\u00e9\"}");
        let v: Value = serde_json::from_str(&sanitize_lone_surrogate_escapes(r#"{"ok":true,"context":"x\ud83d"}"#)).unwrap();
        assert_eq!(v["context"].as_str().unwrap(), "x\u{FFFD}");
    }
}
