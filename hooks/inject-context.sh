#!/bin/bash
# UserPromptSubmit Hook: Inject relevant past decisions into the conversation context.
#
# Reads the user's prompt from stdin, searches memory-bank for related facts,
# and prints context to stdout so Claude Code prepends it to the prompt.
#
# Environment variables:
#   CWD             - Current working directory
#   SESSION_ID      - Current session ID

set -euo pipefail

CWD="${CWD:-$(pwd)}"

# Read the user prompt from stdin
USER_PROMPT=""
if [ ! -t 0 ]; then
  USER_PROMPT=$(cat 2>/dev/null || true)
fi

if [[ -z "$USER_PROMPT" ]]; then
  exit 0
fi

# Minimum prompt length to avoid wasting tokens on short inputs
if [[ ${#USER_PROMPT} -lt 20 ]]; then
  exit 0
fi

# Locate inject script
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INJECT_SCRIPT="${HOOK_DIR}/../scripts/inject-context.js"

if [[ ! -f "$INJECT_SCRIPT" ]]; then
  exit 0
fi

# Run the Node.js injection script
# It reads USER_PROMPT from env, writes context to stdout
CONTEXT=$(CWD="$CWD" USER_PROMPT="$USER_PROMPT" node "$INJECT_SCRIPT" 2>/dev/null || true)

if [[ -n "$CONTEXT" ]]; then
  # Output the context block; Claude Code will prepend it to the user prompt
  printf '%s\n\n' "$CONTEXT"
fi

exit 0
