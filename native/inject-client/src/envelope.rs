//! The hook input: stdin JSON (Claude Code's UserPromptSubmit contract), plain text, or the USER_PROMPT /
//! CWD / SESSION_ID environment of a manual run — including the Codex wrapper's whole-envelope-in-USER_PROMPT
//! form. Mirrors main() of scripts/inject-context.js field for field.
use serde_json::Value;

use crate::jsval::{js_string, sanitize_lone_surrogate_escapes, truthy};

pub struct Input {
    pub prompt: String,
    pub cwd: String,
    pub session_id: String,
    /// Hook host for the inject log ('' when unknown — the caller writes 'manual').
    pub client: String,
    /// USER_PROMPT held a hook envelope that is not a usable UserPromptSubmit one — never searched.
    pub invalid_envelope: bool,
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

/// parseHookEnvelope: Some(Ok(..)) for a usable UserPromptSubmit envelope, Some(Err(())) for another
/// envelope (wrong event / non-string prompt), None for an ordinary prompt (JSON that is not an envelope too).
fn parse_hook_envelope(text: &str) -> Option<Result<Value, ()>> {
    let t = crate::gate::trim_start(text);
    if !t.starts_with('{') {
        return None;
    }
    let j: Value = serde_json::from_str(&sanitize_lone_surrogate_escapes(t)).ok()?;
    let obj = j.as_object()?;
    if !obj.contains_key("hook_event_name") {
        return None;
    }
    if obj.get("hook_event_name").and_then(Value::as_str) != Some("UserPromptSubmit") || !obj.get("prompt").map(Value::is_string).unwrap_or(false) {
        return Some(Err(()));
    }
    Some(Ok(j))
}

pub fn parse(raw: &[u8]) -> Input {
    let raw_text = String::from_utf8_lossy(raw).into_owned();
    let mut input = Input { prompt: String::new(), cwd: String::new(), session_id: String::new(), client: env("MEMORY_BANK_CLIENT"), invalid_envelope: false };
    if !raw_text.is_empty() {
        read_stdin_fields(&raw_text, &mut input);
    }
    if input.prompt.is_empty() {
        read_user_prompt_env(&mut input);
    }
    if input.cwd.is_empty() {
        input.cwd = env("CWD");
        if input.cwd.is_empty() {
            input.cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        }
    }
    if input.session_id.is_empty() {
        input.session_id = env("SESSION_ID");
    }
    input
}

/// stdin: a JSON envelope — JSON.parse accepts any JSON value, and property access on a non-object yields
/// undefined → '' — or plain text, which is the prompt itself.
fn read_stdin_fields(raw_text: &str, input: &mut Input) {
    match serde_json::from_str::<Value>(&sanitize_lone_surrogate_escapes(raw_text)) {
        // JS: `JSON.parse('null').prompt` throws → the catch path keeps the raw text as the prompt
        Ok(Value::Null) => input.prompt = raw_text.to_string(),
        Ok(j) => {
            let get = |k: &str| j.as_object().and_then(|o| o.get(k));
            input.prompt = js_string(get("prompt"));
            input.cwd = js_string(get("cwd"));
            input.session_id = js_string(get("session_id"));
            if input.client.is_empty() {
                input.client = if truthy(get("turn_id")) { "codex".into() } else if truthy(get("transcript_path")) { "claude-code".into() } else { String::new() };
            }
        }
        Err(_) => input.prompt = raw_text.to_string(),
    }
}

/// USER_PROMPT of a manual run or of the Codex wrapper, which puts the whole hook envelope there: a usable
/// UserPromptSubmit envelope is unwrapped (its cwd/session_id only fill empty fields), any other envelope is
/// marked invalid and never searched, anything else is the prompt text.
fn read_user_prompt_env(input: &mut Input) {
    input.prompt = env("USER_PROMPT");
    match parse_hook_envelope(&input.prompt) {
        Some(Ok(j)) => {
            let o = j.as_object().expect("object");
            input.prompt = o.get("prompt").and_then(Value::as_str).unwrap_or("").to_string();
            if input.cwd.is_empty() {
                if let Some(Value::String(c)) = o.get("cwd") { input.cwd = c.clone(); }
            }
            if input.session_id.is_empty() {
                if let Some(Value::String(s)) = o.get("session_id") { input.session_id = s.clone(); }
            }
            if input.client.is_empty() {
                input.client = if truthy(o.get("turn_id")) { "codex".into() } else { "manual".into() };
            }
        }
        Some(Err(())) => input.invalid_envelope = true,
        None => {}
    }
}
