//! Per-session "already injected" ledger — inject-ledger.ts: one JSON array per session under
//! <indexDir>/state/inject-ledger/<session>.json, insertion order kept, 800 keys (oldest evicted), written
//! tmp+rename, ledgers older than 7 days pruned on save. Everything best-effort (dedup is an optimisation).
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const MAX_IDS: usize = 800;
const TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn ledger_dir(index_dir: &Path) -> PathBuf {
    index_dir.join("state").join("inject-ledger")
}

/// sanitizeSessionId: keep [A-Za-z0-9_-] only, cut to 80, need at least 4.
pub fn sanitize_session_id(session_id: &str) -> Option<String> {
    let clean: String = session_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').take(80).collect();
    if clean.len() >= 4 { Some(clean) } else { None }
}

/// The session's keys in file order, duplicates folded like a JS Set; absent/corrupt → empty.
pub fn load(index_dir: &Path, session_id: &str) -> Vec<String> {
    let Some(id) = sanitize_session_id(session_id) else { return Vec::new() };
    let text = match std::fs::read_to_string(ledger_dir(index_dir).join(format!("{id}.json"))) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let Ok(serde_json::Value::Array(arr)) = serde_json::from_str::<serde_json::Value>(&text) else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    for v in arr {
        if let serde_json::Value::String(s) = v {
            if !out.contains(&s) {
                out.push(s);
            }
        }
    }
    out
}

pub fn append(index_dir: &Path, session_id: &str, existing: Vec<String>, new_ids: &[String]) {
    let Some(id) = sanitize_session_id(session_id) else { return };
    if new_ids.is_empty() {
        return;
    }
    let dir = ledger_dir(index_dir);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    // [...existing, ...newIds.filter((n) => !existing.has(n))] — new ids are not folded among themselves (JS parity)
    let mut ordered = existing.clone();
    for n in new_ids {
        if !existing.contains(n) {
            ordered.push(n.clone());
        }
    }
    let bounded: &[String] = if ordered.len() > MAX_IDS { &ordered[ordered.len() - MAX_IDS..] } else { &ordered[..] };
    let p = dir.join(format!("{id}.json"));
    let tmp = dir.join(format!("{id}.json.tmp"));
    let Ok(text) = serde_json::to_string(bounded) else { return };
    if std::fs::write(&tmp, text).is_err() {
        return;
    }
    let _ = std::fs::rename(&tmp, &p);
    prune_old(&dir);
}

fn prune_old(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        if let Ok(m) = std::fs::metadata(&p) {
            if let Ok(mtime) = m.modified() {
                if now.duration_since(mtime).map(|d| d > TTL).unwrap_or(false) {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    }
}
