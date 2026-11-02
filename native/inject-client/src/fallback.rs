//! Hand the prompt to the JS client when the daemon did not answer. The JS client skips its own daemon
//! attempt (MEMORY_BANK_INJECT_DAEMON_FAILED carries the reason) and reuses our request id, so its fallback
//! log line pairs with the daemon's line exactly as when it had asked the daemon itself. stdin is the raw
//! envelope we read; stdout/stderr are inherited. A missing node is one stderr line and exit 0 — the hook
//! must never break a prompt.
use std::io::Write;
use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

use crate::paths;

const DEFAULT_HOOK_BUDGET_MS: u64 = 30_000;

/// stderr may be closed or full — a hook must not panic over a diagnostic line.
fn say(msg: &str) {
    let _ = writeln!(std::io::stderr(), "{msg}");
}

/// What is left of the hook's time budget (MEMORY_BANK_INJECT_HOOK_BUDGET_MS, default 30s) after this process
/// spent `elapsed` on stdin and the daemon — the JS client measures its own uptime only, so the budget it sees
/// must already be reduced, or its node-ABI re-run could outlive the host's timeout.
fn remaining_budget_ms(elapsed: Duration) -> u64 {
    let budget = std::env::var("MEMORY_BANK_INJECT_HOOK_BUDGET_MS").ok().and_then(|v| v.trim().parse::<u64>().ok()).filter(|&b| b > 0).unwrap_or(DEFAULT_HOOK_BUDGET_MS);
    budget.saturating_sub(elapsed.as_millis().min(u64::MAX as u128) as u64).max(1)
}

pub fn exec_node(reason: &str, req_id: &str, raw_stdin: &[u8], elapsed: Duration) -> ExitCode {
    let Some(root) = paths::plugin_root() else {
        say(&format!("inject-client: MEMORY_BANK_PLUGIN_ROOT not set — cannot run the node fallback ({reason})"));
        return ExitCode::SUCCESS;
    };
    let script = root.join("scripts").join("inject-context.js");
    let mut child = match Command::new("node")
        .arg(&script)
        .env("MEMORY_BANK_INJECT_DAEMON_FAILED", reason)
        .env("MEMORY_BANK_INJECT_REQ_ID", req_id)
        .env("MEMORY_BANK_INJECT_HOOK_BUDGET_MS", remaining_budget_ms(elapsed).to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            say(&format!("inject-client: node not found — no fallback for this prompt ({reason}): {e}"));
            return ExitCode::SUCCESS;
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(raw_stdin);
        // dropping closes the pipe → the JS client's readHookInput sees EOF
    }
    match child.wait() {
        Ok(status) => match status.code() {
            Some(c) => ExitCode::from(c.clamp(0, 255) as u8),
            None => ExitCode::SUCCESS,
        },
        Err(_) => ExitCode::SUCCESS,
    }
}
