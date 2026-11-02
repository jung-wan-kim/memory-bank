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

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INJECT_SCRIPT="${HOOK_DIR}/../scripts/inject-context.js"

[[ -f "$INJECT_SCRIPT" ]] || exit 0

# Error log: node-level crashes (missing node_modules, import failures) must be
# visible somewhere — discarding stderr let a broken install go unnoticed for months.
INDEX_DIR="${MEMORY_BANK_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/superpowers}/conversation-index"
LOG_DIR="$INDEX_DIR/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || true
ERR_LOG="$LOG_DIR/inject-context.err.log"
# Keep the error log bounded (~1MB): truncate before append when oversized.
if [[ -f "$ERR_LOG" ]] && [[ $(wc -c < "$ERR_LOG" 2>/dev/null || echo 0) -gt 1048576 ]]; then
  : > "$ERR_LOG"
fi

# Native thin client (native/inject-client, built by scripts/build-native-client.sh at SessionStart when cargo
# exists) — used only when it is executable AND its recorded source hash equals this plugin's SRC_HASH, so an
# old binary never talks a new protocol. Anything else runs the node client exactly as before. The binary
# itself falls back to the node client when the daemon does not answer.
PLUGIN_ROOT="$(cd "$HOOK_DIR/.." && pwd)"
NATIVE_BIN="${MEMORY_BANK_NATIVE_CLIENT:-$INDEX_DIR/bin/memory-bank-inject-client}"
WANT_HASH=""; [[ -f "$PLUGIN_ROOT/native/inject-client/SRC_HASH" ]] && WANT_HASH="$(tr -d '[:space:]' < "$PLUGIN_ROOT/native/inject-client/SRC_HASH" 2>/dev/null || true)"
HAVE_HASH=""; [[ -f "$NATIVE_BIN.srchash" ]] && HAVE_HASH="$(tr -d '[:space:]' < "$NATIVE_BIN.srchash" 2>/dev/null || true)"

# Pass raw stdin straight through — both clients parse JSON/plaintext/env themselves.
# MEMORY_BANK_CLIENT tags the inject log so Claude Code and Codex are measured apart.
if [[ -n "$WANT_HASH" && -f "$NATIVE_BIN" && -x "$NATIVE_BIN" && ! -d "$NATIVE_BIN" && "$HAVE_HASH" == "$WANT_HASH" ]]; then
  MEMORY_BANK_CLIENT="${MEMORY_BANK_CLIENT:-claude-code}" MEMORY_BANK_PLUGIN_ROOT="$PLUGIN_ROOT" "$NATIVE_BIN" 2>>"$ERR_LOG" || true
else
  MEMORY_BANK_CLIENT="${MEMORY_BANK_CLIENT:-claude-code}" node "$INJECT_SCRIPT" 2>>"$ERR_LOG" || true
fi

exit 0
