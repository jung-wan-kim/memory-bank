#!/bin/bash
# build-native-client.sh — SessionStart (async): build the native inject client when cargo is available and the
# installed binary does not match the plugin's native/inject-client/SRC_HASH. Without cargo, or on any failure,
# the hook keeps its node path — nothing here can break a prompt. Output goes to
# <indexDir>/logs/native-build.log (one line per run) and the binary to <indexDir>/bin/ (outside the plugin
# cache, which live-apply rewrites).
set -uo pipefail
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$PLUGIN_ROOT/native/inject-client"
INDEX_DIR="${MEMORY_BANK_CONFIG_DIR:-${PERSONAL_SUPERPOWERS_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/superpowers}}/conversation-index"
BIN_DIR="$INDEX_DIR/bin"
BIN="$BIN_DIR/memory-bank-inject-client"
LOG_DIR="$INDEX_DIR/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || true
LOG="$LOG_DIR/native-build.log"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG" >&2; }

[[ -f "$CRATE/SRC_HASH" ]] || { say "SRC_HASH 없음 — node 경로 유지 ($CRATE)"; exit 0; }
WANT="$(tr -d '[:space:]' < "$CRATE/SRC_HASH")"
HAVE=""; [[ -f "$BIN.srchash" ]] && HAVE="$(tr -d '[:space:]' < "$BIN.srchash")"
if [[ -x "$BIN" && -n "$WANT" && "$HAVE" == "$WANT" ]]; then
  say "up to date ($WANT) — 재빌드 없음"; exit 0
fi

# MEMORY_BANK_CARGO: explicit cargo path, or "none" to behave as if cargo were absent (tests).
CARGO="${MEMORY_BANK_CARGO:-}"
[[ "$CARGO" == "none" ]] && { say "cargo 없음 — node 경로 유지 (설치: https://rustup.rs)"; exit 0; }
if [[ -z "$CARGO" ]]; then
  if command -v cargo >/dev/null 2>&1; then CARGO="$(command -v cargo)"
  elif [[ -x "${CARGO_HOME:-$HOME/.cargo}/bin/cargo" ]]; then CARGO="${CARGO_HOME:-$HOME/.cargo}/bin/cargo"
  elif [[ -x /opt/homebrew/bin/cargo ]]; then CARGO=/opt/homebrew/bin/cargo
  fi
fi
[[ -n "$CARGO" ]] || { say "cargo 없음 — node 경로 유지 (설치: https://rustup.rs)"; exit 0; }

TARGET_DIR="$INDEX_DIR/native-build"
mkdir -p "$BIN_DIR" "$TARGET_DIR" 2>/dev/null || { say "디렉터리 생성 실패 — node 경로 유지"; exit 0; }
START=$(date +%s)
if ! MEMORY_BANK_INJECT_CLIENT_SRC_HASH="$WANT" "$CARGO" build --release --quiet --manifest-path "$CRATE/Cargo.toml" --target-dir "$TARGET_DIR" > "$TARGET_DIR/last-build.out" 2>&1; then
  say "cargo build 실패 — node 경로 유지 ($(tail -c 300 "$TARGET_DIR/last-build.out" | tr '\n' ' '))"; exit 0
fi
BUILT="$TARGET_DIR/release/memory-bank-inject-client"
[[ -x "$BUILT" ]] || { say "빌드 산출물 없음 — node 경로 유지"; exit 0; }
# The binary reports the hash it was compiled with — refuse to install a binary that does not carry the pin.
GOT="$("$BUILT" --src-hash 2>/dev/null || true)"
[[ "$GOT" == "$WANT" ]] || { say "바이너리 해시 불일치($GOT ≠ $WANT) — 설치하지 않음, node 경로 유지"; exit 0; }
TMP_BIN="$BIN.tmp.$$"; TMP_HASH="$BIN.srchash.tmp.$$"
# Old pin first, then binary, then new pin: if this stops half-way the binary has no pin and the wrapper runs node —
# never a new binary paired with an old pin.
cp "$BUILT" "$TMP_BIN" && chmod 755 "$TMP_BIN" && printf '%s\n' "$WANT" > "$TMP_HASH" && rm -f "$BIN.srchash" && mv -f "$TMP_BIN" "$BIN" && mv -f "$TMP_HASH" "$BIN.srchash" \
  || { rm -f "$TMP_BIN" "$TMP_HASH"; say "설치 실패 — node 경로 유지"; exit 0; }
say "built $WANT in $(( $(date +%s) - START ))s → $BIN"
exit 0
