#!/bin/bash
# Install memory-bank slash commands to user scope (~/.claude/commands/)
# Runs on SessionStart - idempotent (a copy is rewritten only when its content would change)
#
# A command points at plugin files as ${CLAUDE_PLUGIN_ROOT}/… . Claude Code fills that in for the
# plugin's own commands (/memory-bank:show-dashboard), but a user-scope copy (/show-dashboard) is not
# a plugin component, and the variable is not in the environment of the Bash tool either — left as
# it is, the copy would run `node "/ui/server.cjs"`. So each copy gets this plugin root written in.
# A plugin update moves the root; the next SessionStart rewrites the copies.

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
USER_COMMANDS="$HOME/.claude/commands"

mkdir -p "$USER_COMMANDS"

for cmd in "$PLUGIN_ROOT/commands/"*.md; do
  [ -f "$cmd" ] || continue
  name="$(basename "$cmd")"
  target="$USER_COMMANDS/$name"
  tmp="$(mktemp "$USER_COMMANDS/.memory-bank-command.XXXXXX")" || {
    echo "install-commands: no temp file in $USER_COMMANDS — $name not installed" >&2
    continue
  }
  # The root goes in as plain text (index/substr, value from the environment): no character of a
  # path — space, &, backslash, $ — is read as a pattern or an escape.
  if ! MEMORY_BANK_PLUGIN_ROOT="$PLUGIN_ROOT" awk '
      BEGIN { needle = "${CLAUDE_PLUGIN_ROOT}"; root = ENVIRON["MEMORY_BANK_PLUGIN_ROOT"] }
      {
        line = $0; out = ""
        while ((at = index(line, needle)) > 0) {
          out = out substr(line, 1, at - 1) root
          line = substr(line, at + length(needle))
        }
        print out line
      }' "$cmd" > "$tmp"; then
    echo "install-commands: could not prepare $name — not installed" >&2
    rm -f "$tmp"
    continue
  fi
  # Only install if missing or outdated; renamed into place so a reader never sees half a file.
  if cmp -s "$tmp" "$target"; then
    rm -f "$tmp"
  else
    chmod 644 "$tmp" && mv "$tmp" "$target"
  fi
done
