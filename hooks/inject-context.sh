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
LOG_DIR="${MEMORY_BANK_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/superpowers}/conversation-index/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || true
ERR_LOG="$LOG_DIR/inject-context.err.log"
# Keep the error log bounded (~1MB): truncate before append when oversized.
if [[ -f "$ERR_LOG" ]] && [[ $(wc -c < "$ERR_LOG" 2>/dev/null || echo 0) -gt 1048576 ]]; then
  : > "$ERR_LOG"
fi

# Pass raw stdin straight through — the JS parses JSON/plaintext/env itself.
# MEMORY_BANK_CLIENT tags the inject log so Claude Code and Codex are measured apart.
MEMORY_BANK_CLIENT="${MEMORY_BANK_CLIENT:-claude-code}" node "$INJECT_SCRIPT" 2>>"$ERR_LOG" || true

exit 0
