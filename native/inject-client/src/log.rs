//! The injection observability log — inject-log.ts appendInjectLog: one JSONL line per run, rotated to
//! `.old` above 5MB, never throws. Key order follows the JS object literal so the parity tests can compare
//! lines as text.
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::envelope::Input;
use crate::gate::js_len;

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

pub struct Meta {
    pub client: String,
    pub entrypoint: Option<String>,
    pub req_id: String,
    pub client_impl: &'static str,
}

impl Meta {
    /// `...meta` in the JS client: client, entrypoint (absent when unset), req_id, client_impl.
    pub fn extend(&self, m: &mut Map<String, Value>) {
        m.insert("client".into(), Value::String(self.client.clone()));
        if let Some(e) = &self.entrypoint {
            m.insert("entrypoint".into(), Value::String(e.clone()));
        }
        m.insert("req_id".into(), Value::String(self.req_id.clone()));
        m.insert("client_impl".into(), Value::String(self.client_impl.to_string()));
    }
}

/// `new Date().toISOString()` — millisecond precision, UTC.
pub fn iso_now() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let millis = d.subsec_millis();
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    // civil_from_days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", sod / 3600, (sod % 3600) / 60, sod % 60)
}

pub fn append_skipped(index_dir: &Path, reason: &str, input: &Input, meta: &Meta) {
    let mut m = Map::new();
    m.insert("ts".into(), Value::String(iso_now()));
    m.insert("status".into(), Value::String("skipped".into()));
    m.insert("reason".into(), Value::String(reason.into()));
    m.insert("project".into(), Value::String(input.cwd.clone()));
    m.insert("prompt_len".into(), Value::from(js_len(&input.prompt) as u64));
    m.insert("via".into(), Value::String("client".into()));
    m.insert("has_session".into(), Value::Bool(!input.session_id.is_empty()));
    meta.extend(&mut m);
    append_line(index_dir, &Value::Object(m));
}

/// Best-effort append (observability must not break injection).
pub fn append_line(index_dir: &Path, line: &Value) {
    let dir = index_dir.join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let p = dir.join("inject-context.jsonl");
    if let Ok(meta) = std::fs::metadata(&p) {
        if meta.len() > MAX_LOG_BYTES {
            let _ = std::fs::rename(&p, dir.join("inject-context.jsonl.old"));
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = f.write_all(format!("{}\n", line).as_bytes());
    }
}
