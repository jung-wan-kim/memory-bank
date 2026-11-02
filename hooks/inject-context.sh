#!/bin/bash
# UserPromptSubmit Hook: Inject relevant past decisions into the conversation context.
#
# Claude Code passes hook input as JSON on stdin:
#   { "session_id": "...", "cwd": "...", "prompt": "...", ... }
# ALL parsing happens inside inject-context.js (single node process — the old
# wrapper spawned node 3 extra times just to parse JSON, ~300ms per prompt).
# The JS client tries the warm MCP-server daemon first (~150ms) and falls back
# to a local cold computation (~2.3s) when no daemon is running.

set -euo pipefail

# No subshell for the hook's own directory: hooks.json passes an absolute path (${CLAUDE_PLUGIN_ROOT}/hooks/…); a
# relative invocation (tests, manual runs) is anchored on $PWD. Two $(…) forks here cost ~5ms on every prompt.
HOOK_DIR="${BASH_SOURCE[0]%/*}"
[[ "$HOOK_DIR" == "${BASH_SOURCE[0]}" ]] && HOOK_DIR="."   # bare file name — invoked from its own directory
[[ "$HOOK_DIR" == /* ]] || HOOK_DIR="$PWD/$HOOK_DIR"
HOOK_DIR="${HOOK_DIR%/.}"; HOOK_DIR="${HOOK_DIR%/}"
INJECT_SCRIPT="${HOOK_DIR}/../scripts/inject-context.js"

[[ -f "$INJECT_SCRIPT" ]] || exit 0

# Error log: node-level crashes (missing node_modules, import failures) must be
# visible somewhere — discarding stderr let a broken install go unnoticed for months.
# Same precedence as paths.ts getSuperpowersDir(): MEMORY_BANK_CONFIG_DIR → PERSONAL_SUPERPOWERS_DIR → XDG → ~/.config
INDEX_DIR="${MEMORY_BANK_CONFIG_DIR:-${PERSONAL_SUPERPOWERS_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/superpowers}}/conversation-index"
LOG_DIR="$INDEX_DIR/logs"
[[ -d "$LOG_DIR" ]] || mkdir -p "$LOG_DIR" 2>/dev/null || true
ERR_LOG="$LOG_DIR/inject-context.err.log"
# Keep the error log bounded (~1MB): truncate before append when oversized (size read only when non-empty —
# every subprocess here is paid on every prompt).
if [[ -s "$ERR_LOG" ]] && [[ $(wc -c < "$ERR_LOG" 2>/dev/null || echo 0) -gt 1048576 ]]; then
  : > "$ERR_LOG"
fi

# Native thin client (native/inject-client, built by scripts/build-native-client.sh at SessionStart when cargo
# exists) — used only when it is executable AND its recorded source hash equals this plugin's SRC_HASH, so an
# old binary never talks a new protocol. Anything else runs the node client exactly as before. The binary
# itself falls back to the node client when the daemon does not answer.
PLUGIN_ROOT="${HOOK_DIR%/*}" # HOOK_DIR is canonical and absolute — no second subshell
NATIVE_BIN="${MEMORY_BANK_NATIVE_CLIENT:-$INDEX_DIR/bin/memory-bank-inject-client}"
# Both pins are read with the `read` builtin (first line, whitespace stripped) — a $(tr …) subshell costs ~3ms each,
# and the whole point of the native path is the ~75ms a node start-up takes.
PIN="$PLUGIN_ROOT/native/inject-client/SRC_HASH"
WANT_HASH=""; if [[ -f "$PIN" ]]; then IFS= read -r WANT_HASH < "$PIN" 2>/dev/null || true; WANT_HASH="${WANT_HASH//[[:space:]]/}"; fi
HAVE_HASH=""; if [[ -f "$NATIVE_BIN.srchash" ]]; then IFS= read -r HAVE_HASH < "$NATIVE_BIN.srchash" 2>/dev/null || true; HAVE_HASH="${HAVE_HASH//[[:space:]]/}"; fi

# Pass raw stdin straight through — both clients parse JSON/plaintext/env themselves.
# MEMORY_BANK_CLIENT tags the inject log so Claude Code and Codex are measured apart.
# The brace group's own stderr goes to the error log too: when the client dies of a signal, bash itself prints
# "Segmentation fault: 11 …" to *its* stderr, which is the hook host's — not the client's redirected one.
if [[ -n "$WANT_HASH" && -f "$NATIVE_BIN" && -x "$NATIVE_BIN" && ! -d "$NATIVE_BIN" && "$HAVE_HASH" == "$WANT_HASH" ]]; then
  { MEMORY_BANK_CLIENT="${MEMORY_BANK_CLIENT:-claude-code}" MEMORY_BANK_PLUGIN_ROOT="$PLUGIN_ROOT" "$NATIVE_BIN" 2>>"$ERR_LOG"; } 2>>"$ERR_LOG" || true
else
  { MEMORY_BANK_CLIENT="${MEMORY_BANK_CLIENT:-claude-code}" node "$INJECT_SCRIPT" 2>>"$ERR_LOG"; } 2>>"$ERR_LOG" || true
fi

exit 0
