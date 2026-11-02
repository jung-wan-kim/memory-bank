#!/bin/bash
# hook-run.sh — telemetry wrapper for Claude Code hooks
#
# Usage (installed by install-hook-telemetry.py / install-project-hooks.sh):
#   bash ~/.claude/scripts/hook-run.sh bash ~/.claude/hooks/foo.sh   (user scope)
#   bash ~/.claude/scripts/hook-run.sh ~/.claude/hooks/foo.sh        (user scope)
#   ./.claude/hooks/hook-run.sh ./.claude/hooks/foo.sh               (project scope)
#
# Contract:
# - Reads stdin once, buffers, pipes to inner hook
# - Passes all args after this script path as the actual hook invocation
# - Logs {ts, hook, exit, session_id?, hook_event_name?, agent_type?, agent_id?,
#   project_tag, scope, tag_reason?} to $LOOPY_ERA_TRIGGER_LOG after execution.
#   session_id/hook_event_name/agent_type/agent_id are additive+optional
#   (omitted when absent from stdin); project_tag/scope are always present
#   (fixed-vocabulary or hex values only — never free-text).
# - Propagates the inner hook's exit code verbatim (incl. 2 for block)
#
# Failure mode: logging errors must NEVER change the hook's exit code.
# If the log file is not writable, the wrapper silently continues. All new
# telemetry derivation (project_tag/scope/agent fields) is best-effort and
# runs after the inner hook's exit code is captured — it can never alter EXIT
# or pollute stdout/stderr (project_tag derivation runs inside the suppressed
# logging block only).
#
# HOOK_RUN_PRINT_TAG=1: prints only the derived project_tag to stdout (before
# consuming stdin) and exits 0 without running the inner hook. Used by
# install-project-hooks.sh (fake-project tests) and dead-hook-report.sh to
# compute a project's expected tag using this exact derivation (no duplicated
# derivation logic elsewhere).

set -u

LOG_FILE="${LOOPY_ERA_TRIGGER_LOG:-$HOME/.claude/.loopy-era/hook-triggers.jsonl}"

# ── project_tag derivation (P0 — project-scope hook 관측 복구) ─────────────
# 태그는 ".claude/settings.json 또는 .git 이 있는 가장 가까운 상위 디렉토리 경로"(git 명령
# 미사용 — git 은 환경변수/config 로 최상위가 바뀌므로, 설정 계층이 없는 순수 파일시스템
# 상향탐색만 신뢰)를 머신 로컬 salt 로 해싱한 값이다. .claude/settings.json 을 .git 과 함께
# (우선) 정지 조건으로 두는 이유: project 훅의 스코프 경계는 정의상 settings.json 위치이고,
# 자체 .git 이 없는 프로젝트(상위 git 워크트리 하위 — 예: $HOME 자체가 워크트리인 환경)가
# .git 도달까지 계속 상향탐색해 서로 다른 프로젝트가 동일 태그로 충돌하는 것을 막는다 —
# settings.json 이 있으면 .git 에 닿기 전에 그 디렉토리에서 먼저 멈춘다. salt 는 오프라인
# 대조 오라클을 차단하기 위함 — 관측용 식별자이지 보안 경계가 아니다(실행 환경을 통제하는
# 주체에 대한 방어는 OS 격리가 담당).
#   s:<16hex>  = settings.json/git 최상위에서 파생 + salt 적용 — 판정 가능
#   p:<16hex>  = salt 는 적용됐으나 출처 미검증(CLAUDE_PROJECT_DIR/$PWD 폴백) — 판정 보류
#   p:degraded = salt 또는 해시 도구 부재, 경로에서 아무 값도 파생하지 않음 — 판정 보류
# 실패는 전부 p:degraded 로 수렴한다 — 어떤 실패도 이 함수를 호출하는 지점(EXIT 캡처 이후,
# 억제 블록 안)의 바깥으로 새어나가지 않는다.
_PROJ_TAG=""
_PROJ_ALGO=""
_TAG_REASON=""
_derive_project_tag() {
  local _top="" _d _src _src_ok _salt_f _t _salt _hash

  _d=$(pwd -P 2>/dev/null) || _d=""
  while [ -n "$_d" ] && [ "$_d" != "/" ]; do
    { [ -f "$_d/.claude/settings.json" ] || [ -e "$_d/.git" ]; } && { _top="$_d"; break; }
    # [perf 2026-09-28] dirname 프로세스 대신 파라미터 확장 — 절대경로에서 결과 동일("/a"→"/")
    _d="${_d%/*}"; [ -n "$_d" ] || _d="/"
  done

  if [ -n "$_top" ]; then
    _src="$_top"; _src_ok=1
  else
    _src="${CLAUDE_PROJECT_DIR:-$PWD}"; _src_ok=0
  fi

  _salt_f="$HOME/.claude/.loopy-era/tag-salt"
  if [ ! -s "$_salt_f" ]; then
    mkdir -p "$(dirname "$_salt_f")" 2>/dev/null
    _t=$(mktemp "$(dirname "$_salt_f")/.salt.XXXXXX" 2>/dev/null) || _t=""
    if [ -n "$_t" ]; then
      chmod 600 "$_t" 2>/dev/null
      head -c 32 /dev/urandom 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n' > "$_t" 2>/dev/null
      ln "$_t" "$_salt_f" 2>/dev/null    # 원자적: 이미 있으면 실패 = 먼저 쓴 쪽 승리
      rm -f "$_t" 2>/dev/null
    fi
  fi
  _salt=$(< "$_salt_f") 2>/dev/null || _salt=""   # [perf] cat 실행 없이 읽기 — 끝 줄바꿈 제거까지 동일
  case "${#_salt}:$_salt" in                # 형식 검증 — 64 hex 아니면 무효
    64:*[!0-9a-f]*) _salt="" ;;
    64:*) : ;;
    *) _salt="" ;;
  esac

  # 🚨 경로에서 값을 파생하는 곳은 여기 한 군데뿐이고, 두 조건을 모두 만족할 때만이다:
  #    (salt 있음) AND (sha 도구 있음). 하나라도 없으면 상수 마커를 낸다 — 무염 파생값은
  #    그 자체가 오프라인 대조 오라클이기 때문.
  _hash=""
  if [ -n "$_salt" ]; then
    # [perf 2026-09-28] shasum 은 perl 스크립트라 기동만 수십 ms — 같은 SHA-256 을 C 바이너리 openssl 로 먼저 계산한다.
    #   절대경로 고정(PATH 비신뢰). 출력은 판마다 "hex" / "(stdin)= hex" / "SHA2-256(stdin)= hex" 라 마지막 토큰만 취하고,
    #   64자 소문자 hex 가 아니면 버리고 아래 기존 경로(shasum → sha256sum)로 간다 — 태그 값은 어느 경로든 동일.
    _hash=$(printf '%s\n%s' "$_salt" "$_src" | /usr/bin/openssl dgst -sha256 2>/dev/null) || _hash=""
    _hash="${_hash##* }"
    case "${#_hash}:$_hash" in 64:*[!0-9a-f]*) _hash="" ;; 64:*) _hash="${_hash:0:16}" ;; *) _hash="" ;; esac
    [ -z "$_hash" ] && _hash=$(printf '%s\n%s' "$_salt" "$_src" | PATH=/usr/bin:/bin shasum -a 256 2>/dev/null | cut -c1-16)
    [ -z "$_hash" ] && _hash=$(printf '%s\n%s' "$_salt" "$_src" | PATH=/usr/bin:/bin sha256sum 2>/dev/null | cut -c1-16)
  fi

  _PROJ_TAG=""; _PROJ_ALGO=""; _TAG_REASON=""
  if [ -n "$_hash" ]; then
    _PROJ_TAG="$_hash"
    if [ "$_src_ok" = 1 ]; then _PROJ_ALGO="s"; else _PROJ_ALGO="p"; _TAG_REASON="unverified-source"; fi
  else
    _PROJ_TAG="degraded"; _PROJ_ALGO="p"
    if [ -n "$_salt" ]; then _TAG_REASON="no-hash-tool"; else _TAG_REASON="no-salt"; fi
  fi
  _PROJ_TAG="${_PROJ_ALGO}:${_PROJ_TAG}"
}

# HOOK_RUN_PRINT_TAG=1: stdin 소비 전에 태그만 출력하고 종료 (파생 로직 이중화 금지 — 설치기/
# 리포터가 프로젝트별 기대 태그를 계산할 때 이 경로를 그대로 호출한다)
# 🚨 Codex CRITICAL: 인자(훅 경로)가 하나라도 있으면 이 분기를 무시하고 정상 실행한다 — 세션/
#   settings env 블록 등으로 HOOK_RUN_PRINT_TAG=1 이 남아 있어도, 실제 훅 호출(항상 최소 1개
#   인자를 받는다)에서 게이트가 조용히 우회되지 않는다. 무인자 호출(설치기/리포터의 태그 조회
#   전용 호출)만 이 분기를 탄다.
if [ "${HOOK_RUN_PRINT_TAG:-0}" = "1" ] && [ $# -eq 0 ]; then
  _derive_project_tag
  printf '%s\n' "$_PROJ_TAG"
  exit 0
fi

# Identify hook name from args for telemetry (best-effort; ends in .sh)
# [perf] basename fork 제거 — bash 파라미터 확장으로 동일 결과 (동작 불변)
# HOOK_PATH_RAW: basename 추출 전의 실행 대상 경로 — scope(user/project/other) 판정에 사용
HOOK_NAME=""
HOOK_PATH_RAW=""
for arg in "$@"; do
  case "$arg" in
    *.sh|*.sh\ *)
      HOOK_PATH_RAW="${arg%% *}"
      HOOK_NAME="${HOOK_PATH_RAW##*/}"
      break
      ;;
  esac
done
# JSON 인젝션 방어(F3 — Codex HIGH): 파일명 유래 필드도 아래 session_id 등과 동일 새니타이즈.
# 인용부호/백슬래시/제어문자(탭·VT·개행·CR 등 0x00-0x1F, DEL 포함) 가 섞인 훅 파일명이 JSONL
# 레코드를 조작(라인 분할 후 임의 필드값의 위조 레코드 삽입)하거나, 이스케이프 안 된 제어문자
# 자체가 JSON 스펙(RFC 8259) 위반이 되어 그 줄을 파싱 불가로 만드는 것을 방지(2026-08-01
# Codex MEDIUM R2: 개행/CR/따옴표/백슬래시 4종만 제거하던 이전 버전은 tab·VT 등을 남겨
# json.loads 가 실패 — 그 훅의 발화 기록이 무음으로 소실되어 dead-hook 오탐을 유발했다).
# [:cntrl:] 로 전 제어문자(0x00-0x1F, 0x7F)를 한 번에 제거 + 길이 캡(120자).
HOOK_NAME="${HOOK_NAME//[\"\\[:cntrl:]]/}"   # [perf] tr 대신 bash 치환 — 같은 문자 집합(따옴표·백슬래시·제어문자) 제거
HOOK_NAME="${HOOK_NAME:0:120}"
[ -z "$HOOK_NAME" ] && HOOK_NAME="unknown"

# 2026-09-28: 등록이 $CLAUDE_PROJECT_DIR 절대경로 형태면 작업 폴더가 하위 폴더여도 훅이 실행된다.
# 프로젝트 훅들은 "현재 폴더 = 프로젝트 루트"를 전제로 .qa-evidence.json·package.json 같은 상대경로를
# 읽는다(상대경로 등록 시절엔 루트에서만 실행됐다). 그래서 프로젝트 훅은 루트로 이동한 뒤 실행해
# 그 전제를 지킨다 — 하위 폴더에서 증거 파일을 못 찾아 게이트가 통과로 새는 것을 막는다.
# 이동 뒤에는 scope 판정($PWD)·project_tag 파생도 루트 기준이 된다.
# 이동 대상은 현재 폴더에서 위로 올라가며 처음 만나는 .claude/settings.json 폴더(프로젝트 설정 경계)다 —
# 워크트리(.claude/worktrees/*)나 자체 .claude 를 가진 하위 저장소에서는 그 사본을 판정한다(상대경로
# 등록 시절과 같은 대상). 그런 폴더가 프로젝트 안에 없으면 프로젝트 루트로 간다. 이동 실패는 stderr 경고.
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
  case "$HOOK_PATH_RAW" in
    "$CLAUDE_PROJECT_DIR"/.claude/hooks/*)
      # 비교는 실제 경로(pwd -P)로 한다 — /tmp·/private/tmp 같은 심링크 표기나 끝의 '/' 차이로
      # 워크트리를 루트로 잘못 판정하지 않게.
      _hr_root=$(cd "$CLAUDE_PROJECT_DIR" 2>/dev/null && pwd -P) || _hr_root="${CLAUDE_PROJECT_DIR%/}"
      _hr_dir=$(pwd -P 2>/dev/null) || _hr_dir="$PWD"
      while [ -n "$_hr_dir" ] && [ "$_hr_dir" != "/" ]; do
        [ -f "$_hr_dir/.claude/settings.json" ] && break
        [ "$_hr_dir" = "$_hr_root" ] && break
        _hr_dir="${_hr_dir%/*}"
      done
      case "$_hr_dir" in
        "$_hr_root"|"$_hr_root"/*) ;;
        *)
          # 작업 폴더가 프로젝트 루트 밖(형제 워크트리·임시 병합 폴더)이다 (2026-10-17, 개선안 B-2 조건 1).
          # 시작 루트로 돌아가면 게이트가 **다른 저장소의 push 를 시작 루트의 증거로** 판정한다 — 대신 작업 폴더 위로 처음
          # 만나는 .claude/settings.json 폴더, 없으면 그 폴더의 git 최상위를 판정 기준으로 삼는다. 둘 다 없으면 이동하지 않고
          # HOOK_RUN_ROOT_UNRESOLVED=1 을 넘긴다 — push 게이트는 이 값에서 push 를 fail-loud(exit 2) 한다.
          _hr_cwd=$(pwd -P 2>/dev/null) || _hr_cwd="$PWD"
          _hr_dir="$_hr_cwd"
          while [ -n "$_hr_dir" ] && [ "$_hr_dir" != "/" ]; do
            [ -f "$_hr_dir/.claude/settings.json" ] && break
            _hr_dir="${_hr_dir%/*}"
          done
          if [ -z "$_hr_dir" ] || [ "$_hr_dir" = "/" ] || [ ! -f "$_hr_dir/.claude/settings.json" ]; then
            _hr_dir=$(git -C "$_hr_cwd" rev-parse --show-toplevel 2>/dev/null) || _hr_dir=""
          fi
          if [ -z "$_hr_dir" ]; then
            export HOOK_RUN_ROOT_UNRESOLVED=1
            echo "hook-run: 작업 폴더($_hr_cwd)가 프로젝트 루트 밖이고 판정 기준(.claude/settings.json·git 최상위)을 찾지 못함 — 현재 폴더에서 실행, push 게이트는 fail-loud" >&2
            _hr_dir="$_hr_cwd"
          else
            echo "hook-run: 작업 폴더가 프로젝트 루트 밖 — 판정 기준을 $_hr_dir 로 잡음(시작 루트 $_hr_root 아님)" >&2
          fi
          ;;
      esac
      cd "$_hr_dir" 2>/dev/null || echo "hook-run: 프로젝트 폴더로 이동 실패($_hr_dir) — 현재 폴더에서 실행" >&2
      ;;
  esac
fi

# Buffer stdin (hook may consume it)
STDIN_BUF=$(cat 2>/dev/null || true)

# Execute the real hook with original stdin
if [ -n "$STDIN_BUF" ]; then
  echo "$STDIN_BUF" | "$@"
else
  "$@" </dev/null
fi
EXIT=$?

# --- session_id/hook_event_name/agent_type/agent_id extraction (additive telemetry) ---
# stdin 은 Claude Code hook stdin 계약(JSON)이다 — 존재하면 session_id/hook_event_name/
# agent_type/agent_id 필드를 bash 정규식으로만(python 스폰 없이) 추출해 텔레메트리 라인에
# 추가 필드로 싣는다(agent_type/agent_id는 P2-C — agent/skill 스코프 채택의 측정 선행조건).
# 실패/부재 시 조용히 생략(필드 자체를 안 실음) — 기존 {ts,hook,exit} 3필드 계약은 항상 유지.
SESSION_ID_EXTRACTED=""
HOOK_EVENT_NAME_EXTRACTED=""
AGENT_TYPE_EXTRACTED=""
AGENT_ID_EXTRACTED=""
if [ -n "$STDIN_BUF" ]; then
  # [perf 2026-09-28] 필드마다 printf|grep|head|sed 4개 + tr 1개를 띄우던 것을 bash 정규식·치환으로 대체.
  #   결과 동일: grep -o|head -1 의 "첫 일치" = [[ =~ ]] 의 가장 왼쪽 일치, sed 로 벗기던 부분 = 캡처 그룹.
  _re_sid='"session_id"[[:space:]]*:[[:space:]]*"([^"]*)"'
  _re_evt='"hook_event_name"[[:space:]]*:[[:space:]]*"([^"]*)"'
  _re_aty='"agent_type"[[:space:]]*:[[:space:]]*"([^"]*)"'
  _re_aid='"agent_id"[[:space:]]*:[[:space:]]*"([^"]*)"'
  [[ $STDIN_BUF =~ $_re_sid ]] && SESSION_ID_EXTRACTED="${BASH_REMATCH[1]}"
  [[ $STDIN_BUF =~ $_re_evt ]] && HOOK_EVENT_NAME_EXTRACTED="${BASH_REMATCH[1]}"
  [[ $STDIN_BUF =~ $_re_aty ]] && AGENT_TYPE_EXTRACTED="${BASH_REMATCH[1]}"
  [[ $STDIN_BUF =~ $_re_aid ]] && AGENT_ID_EXTRACTED="${BASH_REMATCH[1]}"
  # JSON 인젝션 방어: 값에 인용부호/백슬래시/제어문자(탭·VT 등 포함, [:cntrl:] 전체)가 섞이면
  # 출력 JSON 이 깨지므로 제거 (개행/CR 만 제거하던 이전 버전은 tab/VT 등을 남겨 json.loads
  # 실패 — 2026-08-01 Codex MEDIUM R2, HOOK_NAME 과 동일 결함/동일 수정)
  # + 길이 캡(120자) — 임의로 긴 값이 로그 라인을 부풀리는 것을 방지
  SESSION_ID_EXTRACTED="${SESSION_ID_EXTRACTED//[\"\\[:cntrl:]]/}"
  SESSION_ID_EXTRACTED="${SESSION_ID_EXTRACTED:0:120}"
  HOOK_EVENT_NAME_EXTRACTED="${HOOK_EVENT_NAME_EXTRACTED//[\"\\[:cntrl:]]/}"
  HOOK_EVENT_NAME_EXTRACTED="${HOOK_EVENT_NAME_EXTRACTED:0:120}"
  AGENT_TYPE_EXTRACTED="${AGENT_TYPE_EXTRACTED//[\"\\[:cntrl:]]/}"
  AGENT_TYPE_EXTRACTED="${AGENT_TYPE_EXTRACTED:0:120}"
  AGENT_ID_EXTRACTED="${AGENT_ID_EXTRACTED//[\"\\[:cntrl:]]/}"
  AGENT_ID_EXTRACTED="${AGENT_ID_EXTRACTED:0:120}"
fi

# --- scope classification (fixed vocabulary: user|project|other) ---
# HOOK_PATH_RAW 가 $HOME/.claude/hooks/ 하위(절대경로) 면 user, "./" 로 시작하거나
# $PWD/.claude/hooks/ 하위면 project, 그 외는 other. 순수 문자열 판정(경로 미실존이어도 안전) —
# 관측용 분류이지 보안 경계가 아니다.
SCOPE="other"
if [ -n "$HOOK_PATH_RAW" ]; then
  case "$HOOK_PATH_RAW" in
    "$HOME"/.claude/hooks/*)
      SCOPE="user"
      ;;
    ./*|"$PWD"/.claude/hooks/*)
      SCOPE="project"
      ;;
    "${CLAUDE_PROJECT_DIR:-/nonexistent-claude-project-dir}"/.claude/hooks/*)
      # 2026-09-28: 등록이 $CLAUDE_PROJECT_DIR 절대경로 형태(install-project-hooks.sh 신형)면
      # 작업 폴더가 하위 폴더여도($PWD 불일치) project 로 분류한다.
      SCOPE="project"
      ;;
    *)
      SCOPE="other"
      ;;
  esac
fi

# Log trigger (best-effort; never fails the hook)
# [perf] dirname fork 제거 + mkdir 는 디렉토리 부재 시에만 (동작 불변)
# project_tag 파생(salt 파일 I/O 포함)은 이 억제 블록 안에서만 호출한다 — 어떤 실패도 EXIT 를
# 바꾸거나 stdout/stderr 를 오염시키지 않는다(블록 전체가 &>/dev/null).
{
  _LOG_DIR="${LOG_FILE%/*}"
  [ -d "$_LOG_DIR" ] || mkdir -p "$_LOG_DIR" 2>/dev/null || true
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  _derive_project_tag
  _EXTRA=""
  [ -n "$SESSION_ID_EXTRACTED" ] && _EXTRA="${_EXTRA},\"session_id\":\"${SESSION_ID_EXTRACTED}\""
  [ -n "$HOOK_EVENT_NAME_EXTRACTED" ] && _EXTRA="${_EXTRA},\"hook_event_name\":\"${HOOK_EVENT_NAME_EXTRACTED}\""
  [ -n "$AGENT_TYPE_EXTRACTED" ] && _EXTRA="${_EXTRA},\"agent_type\":\"${AGENT_TYPE_EXTRACTED}\""
  [ -n "$AGENT_ID_EXTRACTED" ] && _EXTRA="${_EXTRA},\"agent_id\":\"${AGENT_ID_EXTRACTED}\""
  _EXTRA="${_EXTRA},\"project_tag\":\"${_PROJ_TAG}\""
  _EXTRA="${_EXTRA},\"scope\":\"${SCOPE}\""
  [ -n "$_TAG_REASON" ] && _EXTRA="${_EXTRA},\"tag_reason\":\"${_TAG_REASON}\""
  printf '{"ts":"%s","hook":"%s","exit":%d%s}\n' "$TS" "$HOOK_NAME" "$EXIT" "$_EXTRA" >> "$LOG_FILE" 2>/dev/null || true
} &>/dev/null

exit $EXIT
