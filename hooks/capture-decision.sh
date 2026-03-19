#!/bin/bash
# PostToolUse Hook: Detect decision patterns after Edit/Write tool calls
# and store them in memory-bank facts with ontology classification.
#
# Environment variables provided by Claude Code:
#   TOOL_NAME       - Name of the tool that was called (Edit, Write, etc.)
#   TOOL_INPUT      - JSON-encoded tool input
#   TOOL_RESULT     - JSON-encoded tool result
#   SESSION_ID      - Current session ID
#   CWD             - Current working directory

set -euo pipefail

TOOL_NAME="${TOOL_NAME:-}"
SESSION_ID="${SESSION_ID:-}"
CWD="${CWD:-$(pwd)}"

# Only process Edit and Write tool calls
if [[ "$TOOL_NAME" != "Edit" && "$TOOL_NAME" != "Write" ]]; then
  exit 0
fi

# Read stdin (hook input may also arrive via stdin for richer hooks)
HOOK_INPUT=""
if [ -t 0 ]; then
  : # no stdin in interactive mode
else
  HOOK_INPUT=$(cat 2>/dev/null || true)
fi

# Determine the combined text to analyze
if [[ -n "$HOOK_INPUT" ]]; then
  ANALYSIS_TEXT="$HOOK_INPUT"
elif [[ -n "${TOOL_INPUT:-}" ]]; then
  ANALYSIS_TEXT="$TOOL_INPUT"
else
  exit 0
fi

# Keyword detection for decision patterns (case-insensitive)
DECISION_KEYWORDS=(
  "decision"
  "decided"
  "chose"
  "选择"
  "결정"
  "선택"
  "approach"
  "strategy"
  "architecture"
  "pattern"
  "refactor"
  "migrate"
  "replace"
  "because"
  "reason"
  "tradeoff"
  "trade-off"
)

FOUND_KEYWORD=false
LOWER_TEXT=$(echo "$ANALYSIS_TEXT" | tr '[:upper:]' '[:lower:]')

for kw in "${DECISION_KEYWORDS[@]}"; do
  if echo "$LOWER_TEXT" | grep -qF "$kw" 2>/dev/null; then
    FOUND_KEYWORD=true
    break
  fi
done

if [[ "$FOUND_KEYWORD" != "true" ]]; then
  exit 0
fi

# Locate the memory-bank capture script (relative to this hook)
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPTURE_SCRIPT="${HOOK_DIR}/../scripts/capture-decision.js"

if [[ ! -f "$CAPTURE_SCRIPT" ]]; then
  # Script not built yet; silently skip
  exit 0
fi

# Run the Node.js capture script asynchronously (non-blocking)
SESSION_ID="$SESSION_ID" \
CWD="$CWD" \
TOOL_NAME="$TOOL_NAME" \
DECISION_TEXT="$ANALYSIS_TEXT" \
  node "$CAPTURE_SCRIPT" &

exit 0
