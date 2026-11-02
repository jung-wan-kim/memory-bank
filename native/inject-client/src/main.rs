//! memory-bank inject client — the UserPromptSubmit hook's thin client, in Rust.
//!
//! This is a 1:1 port of the WARM path of `scripts/inject-context.js`: read the hook envelope from stdin,
//! decide with the prompt gate whether the prompt is worth a search, ask the inject daemon over its
//! versioned unix socket, print the block, record the ledger. Everything else — no daemon, a daemon that
//! fails or times out, a node-ABI re-run — is handed to the JS client itself (`fallback.rs`), with the same
//! request id so the daemon's log line and the fallback line stay one prompt.
//!
//! Contract (plan docs/plans/2026-11-02-native-inject-client.md): the hook must never break a prompt, so
//! this binary never panics on input and the wrapper runs it under `|| true`. Output is written once, after
//! the whole answer is in; once writing has started there is no fallback (print first, record second).

mod daemon;
mod envelope;
mod fallback;
mod gate;
mod jsval;
mod ledger;
mod log;
mod paths;

use std::io::{IsTerminal, Read, Write};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Compiled in from the committed pin — the wrapper compares the installed binary's `.srchash` with
/// `native/inject-client/SRC_HASH` and only runs the binary when they match (an old binary must never talk
/// a new protocol). `build.rs` has no part in this: the build script passes the pin as an env var.
pub const SRC_HASH: &str = match option_env!("MEMORY_BANK_INJECT_CLIENT_SRC_HASH") {
    Some(h) => h,
    None => "unpinned",
};

const STDIN_TIMEOUT: Duration = Duration::from_millis(2000);

/// Read stdin to EOF, or whatever arrived by the deadline (readHookInput in hook-stdin.ts). A TTY gives ''.
fn read_stdin() -> Vec<u8> {
    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        return Vec::new();
    }
    let buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let shared = Arc::clone(&buf);
    std::thread::spawn(move || {
        let mut chunk = [0u8; 65536];
        let mut lock = std::io::stdin().lock();
        loop {
            match lock.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut b) = shared.lock() {
                        b.extend_from_slice(&chunk[..n]);
                    }
                }
            }
        }
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(STDIN_TIMEOUT);
    buf.lock().map(|b| b.clone()).unwrap_or_default()
}

fn main() -> ExitCode {
    if std::env::args().nth(1).as_deref() == Some("--src-hash") {
        println!("{SRC_HASH}");
        return ExitCode::SUCCESS;
    }
    let started = std::time::Instant::now();
    let raw = read_stdin();
    let input = envelope::parse(&raw);
    let meta = log::Meta {
        client: if input.client.is_empty() { "manual".to_string() } else { input.client.clone() },
        entrypoint: std::env::var("CLAUDE_CODE_ENTRYPOINT").ok().filter(|s| !s.is_empty()),
        req_id: uuid::Uuid::new_v4().to_string(),
        client_impl: "native",
    };
    let index_dir = paths::index_dir();

    // Harness-generated prompts and very short ones are not worth a search — logged so skips stay measurable.
    let skip_reason = if input.invalid_envelope { Some("hook-envelope") } else { gate::injection_query(&input.prompt).skip_reason() };
    if let Some(reason) = skip_reason {
        log::append_skipped(&index_dir, reason, &input, &meta);
        return ExitCode::SUCCESS;
    }

    match daemon::ask(&index_dir, &input, &meta) {
        Ok(answer) => {
            deliver(&answer.context, &input.session_id, &answer.ledger_keys, &index_dir);
            ExitCode::SUCCESS
        }
        Err(reason) => fallback::exec_node(reason, &meta.req_id, &raw, started.elapsed()),
    }
}

/// Print the block, then mark its facts as shown for this session — only once the write went through to the
/// hook host's pipe (a host that already left received nothing; recording would hide those facts for the
/// rest of the session). Same order as the JS client: print first, record second.
fn deliver(context: &str, session_id: &str, ledger_keys: &[String], index_dir: &std::path::Path) {
    if context.is_empty() {
        return;
    }
    let mut out = std::io::stdout().lock();
    let written = out.write_all(context.as_bytes()).and_then(|_| out.write_all(b"\n")).and_then(|_| out.flush());
    if written.is_ok() && !ledger_keys.is_empty() {
        let existing = ledger::load(index_dir, session_id);
        ledger::append(index_dir, session_id, existing, ledger_keys);
    }
}
