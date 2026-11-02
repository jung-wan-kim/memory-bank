//! Where the plugin keeps its state — mirrors paths.ts getIndexDir() without creating anything on the fast
//! path (the JS client does the same: it only mkdirs where it writes).
use std::path::PathBuf;

pub fn index_dir() -> PathBuf {
    let nonempty = |k: &str| std::env::var(k).ok().filter(|s| !s.is_empty());
    // paths.ts getSuperpowersDir: MEMORY_BANK_CONFIG_DIR → PERSONAL_SUPERPOWERS_DIR → XDG_CONFIG_HOME/superpowers → ~/.config/superpowers
    let base = match nonempty("MEMORY_BANK_CONFIG_DIR").or_else(|| nonempty("PERSONAL_SUPERPOWERS_DIR")) {
        Some(v) => PathBuf::from(v),
        None => {
            let xdg = std::env::var("XDG_CONFIG_HOME").ok().filter(|s| !s.is_empty()).map(PathBuf::from);
            let config = xdg.unwrap_or_else(|| home_dir().join(".config"));
            config.join("superpowers")
        }
    };
    base.join("conversation-index")
}

pub fn home_dir() -> PathBuf {
    std::env::var("HOME").ok().filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// The plugin root the wrapper passes (`MEMORY_BANK_PLUGIN_ROOT`); its package.json names the daemon's
/// socket (one socket per plugin version) and its scripts/ holds the JS fallback.
pub fn plugin_root() -> Option<PathBuf> {
    std::env::var("MEMORY_BANK_PLUGIN_ROOT").ok().filter(|s| !s.is_empty()).map(PathBuf::from)
}

/// package.json "version" of the plugin root, or None (ownPackageVersion in version-guard.ts).
pub fn plugin_version(root: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join("package.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    match v.get("version") {
        Some(serde_json::Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// The inject daemon's socket path for one plugin version (injectSocketPathIn in version-guard.ts): the
/// versioned name when the version string is usable and the path fits a unix socket, else the legacy name.
pub fn inject_socket_path(index_dir: &std::path::Path, version: Option<&str>) -> PathBuf {
    let legacy = index_dir.join("inject-daemon.sock");
    let v = match version {
        Some(v) if !v.is_empty() && v.len() <= 32 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'+' || b == b'-') => v,
        _ => return legacy,
    };
    let versioned = index_dir.join(format!("inject-daemon-{v}.sock"));
    if versioned.as_os_str().len() <= 103 { versioned } else { legacy }
}
