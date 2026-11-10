#!/bin/bash
# build-native-client.sh — SessionStart (async): build the native inject client when cargo is available and the
# installed binary does not match the plugin's native/inject-client/SRC_HASH. Without cargo, or on any failure,
# the hook keeps its node path — nothing here can break a prompt. Output goes to
# <indexDir>/logs/native-build.log (one line per run) and the binary to <indexDir>/bin/ (outside the plugin
# cache, which live-apply rewrites).
#
# A failed build is remembered: <indexDir>/state/native-build-failed holds "<SRC_HASH> <unix seconds>", and for
# RETRY_AFTER_S the same SRC_HASH is not built again. On a machine that has cargo but cannot reach crates.io
# (proxy, firewall) every session start ran cargo through its own retries and time limits before it failed
# (131s measured) and the next session start began again from nothing. A changed SRC_HASH (plugin update) is
# tried at once; deleting the file retries now.
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

# A build of this SRC_HASH failed less than RETRY_AFTER_S ago → not again yet. A record that cannot be read, or
# carries a time in the future, counts as none: it must never keep the build away for good.
FAIL_MARK="$INDEX_DIR/state/native-build-failed"
RETRY_AFTER_S=21600 # 6 hours
NOW=$(date +%s)
if [[ -f "$FAIL_MARK" ]]; then
  F_HASH=""; F_TS=""
  read -r F_HASH F_TS < "$FAIL_MARK" 2>/dev/null || true
  if [[ "$F_HASH" == "$WANT" && "$F_TS" =~ ^[0-9]+$ ]] && (( F_TS <= NOW && NOW - F_TS < RETRY_AFTER_S )); then
    say "지난 빌드 실패($WANT) 후 $(( (NOW - F_TS) / 60 ))분 — $(( RETRY_AFTER_S / 3600 ))시간 안에는 다시 시도하지 않음, node 경로 유지 (바로 다시 하려면 삭제: $FAIL_MARK)"; exit 0
  fi
fi
# Written through a temp file: two session starts may fail at the same moment.
record_failure() {
  mkdir -p "$INDEX_DIR/state" 2>/dev/null || return 0
  printf '%s %s\n' "$WANT" "$(date +%s)" > "$FAIL_MARK.tmp.$$" 2>/dev/null && mv -f "$FAIL_MARK.tmp.$$" "$FAIL_MARK" 2>/dev/null || rm -f "$FAIL_MARK.tmp.$$" 2>/dev/null
  return 0
}

TARGET_DIR="$INDEX_DIR/native-build"
mkdir -p "$BIN_DIR" "$TARGET_DIR" 2>/dev/null || { say "디렉터리 생성 실패 — node 경로 유지"; exit 0; }
START=$(date +%s)
# Network limits for cargo's registry requests: one retry and 10s per request, instead of cargo's defaults
# (3 retries, 30s) — an unreachable registry then fails in tens of seconds, not two minutes. Passed through
# the environment (every cargo version reads it; the --config flag needs 1.63+); a value the user set stays.
if ! MEMORY_BANK_INJECT_CLIENT_SRC_HASH="$WANT" CARGO_NET_RETRY="${CARGO_NET_RETRY:-1}" CARGO_HTTP_TIMEOUT="${CARGO_HTTP_TIMEOUT:-10}" \
    "$CARGO" build --release --quiet --manifest-path "$CRATE/Cargo.toml" --target-dir "$TARGET_DIR" > "$TARGET_DIR/last-build.out" 2>&1; then
  record_failure
  say "cargo build 실패 — node 경로 유지, $(( RETRY_AFTER_S / 3600 ))시간 뒤 다시 시도 ($(tail -c 300 "$TARGET_DIR/last-build.out" | tr '\n' ' '))"; exit 0
fi
BUILT="$TARGET_DIR/release/memory-bank-inject-client"
[[ -x "$BUILT" ]] || { record_failure; say "빌드 산출물 없음 — node 경로 유지"; exit 0; }
# The binary reports the hash it was compiled with — refuse to install a binary that does not carry the pin.
GOT="$("$BUILT" --src-hash 2>/dev/null || true)"
[[ "$GOT" == "$WANT" ]] || { record_failure; say "바이너리 해시 불일치($GOT ≠ $WANT) — 설치하지 않음, node 경로 유지"; exit 0; }
TMP_BIN="$BIN.tmp.$$"; TMP_HASH="$BIN.srchash.tmp.$$"
# Old pin first, then binary, then new pin: if this stops half-way the binary has no pin and the wrapper runs node —
# never a new binary paired with an old pin.
cp "$BUILT" "$TMP_BIN" && chmod 755 "$TMP_BIN" && printf '%s\n' "$WANT" > "$TMP_HASH" && rm -f "$BIN.srchash" && mv -f "$TMP_BIN" "$BIN" && mv -f "$TMP_HASH" "$BIN.srchash" \
  || { rm -f "$TMP_BIN" "$TMP_HASH"; say "설치 실패 — node 경로 유지"; exit 0; }
rm -f "$FAIL_MARK" 2>/dev/null
say "built $WANT in $(( $(date +%s) - START ))s → $BIN"
exit 0
