#!/bin/bash
# Install memory-bank slash commands to user scope (~/.claude/commands/)
# Runs on SessionStart - idempotent (skips if already installed)

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$(dirname "$0")")}"
USER_COMMANDS="$HOME/.claude/commands"

mkdir -p "$USER_COMMANDS"

for cmd in "$PLUGIN_ROOT/commands/"*.md; do
  [ -f "$cmd" ] || continue
  basename="$(basename "$cmd")"
  target="$USER_COMMANDS/$basename"
  # Only copy if not exists or outdated
  if [ ! -f "$target" ] || ! diff -q "$cmd" "$target" >/dev/null 2>&1; then
    cp "$cmd" "$target"
  fi
done
