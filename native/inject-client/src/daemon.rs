//! Ask the warm inject daemon over its versioned unix socket — askDaemon in scripts/inject-context.js.
//! Resolves with the answer, or the fallback reason the JS client would have used:
//! 'no-daemon' (nothing listening), 'daemon-timeout' (3s for the answer; 20s from the FIRST warming signal —
//! later warming lines do not extend it, so a daemon that only ever says warming cannot hold the prompt),
//! 'daemon-closed' (hung up without a full answer), 'daemon-error' (bad line / ok:false).
use std::io::{BufRead, BufReader, Write};
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

pub struct Answer {
    pub context: String,
    pub ledger_keys: Vec<String>,
}

pub fn ask(index_dir: &Path, input: &Input, meta: &Meta) -> Result<Answer, &'static str> {
    let root = paths::plugin_root();
    let version = root.as_deref().and_then(paths::plugin_version);
    let sock = paths::inject_socket_path(index_dir, version.as_deref());
    // A unix-socket connect answers at once (ENOENT / ECONNREFUSED) — the JS 300ms connect timer never fires here.
    let mut stream = UnixStream::connect(&sock).map_err(|_| "no-daemon")?;
    let _ = stream.set_read_timeout(Some(RESPONSE_TIMEOUT));
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

    let mut reader = BufReader::new(stream.try_clone().map_err(|_| "daemon-error")?);
    let mut buf = String::new();
    // Absolute deadline once the daemon says warming (armed once — askDaemon in the JS client does the same).
    let mut warming_deadline: Option<Instant> = None;
    loop {
        if let Some(d) = warming_deadline {
            let remaining = d.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("daemon-timeout");
            }
            let _ = stream.set_read_timeout(Some(remaining));
        }
        buf.clear();
        match reader.read_line(&mut buf) {
            Ok(0) => return Err("daemon-closed"),
            Ok(_) if !buf.ends_with('\n') => return Err("daemon-closed"), // EOF inside a line
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => return Err("daemon-timeout"),
            Err(_) => return Err("daemon-error"),
        }
        let res: Value = match serde_json::from_str(buf.trim_end_matches('\n')) {
            Ok(v) => v,
            Err(_) => return Err("daemon-error"),
        };
        let obj = res.as_object();
        if obj.map(|o| truthy(o.get("warming"))).unwrap_or(false) {
            if warming_deadline.is_none() {
                warming_deadline = Some(Instant::now() + WARMING_TIMEOUT);
            }
            continue;
        }
        let Some(o) = obj else { return Err("daemon-error") };
        if !truthy(o.get("ok")) {
            return Err("daemon-error");
        }
        let ledger_keys = match o.get("ledger_keys") {
            Some(Value::Array(a)) => a.iter().filter_map(|k| k.as_str().map(str::to_string)).collect(),
            _ => Vec::new(),
        };
        return Ok(Answer { context: js_string(o.get("context")), ledger_keys });
    }
}
