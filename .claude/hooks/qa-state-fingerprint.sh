#!/bin/bash
# qa-state-fingerprint.sh — QA 증거 결속용 "상태 지문" 단일 정본
#
# 배경(2026-08-03, 사용자 지시): QA 증거의 유효성을 mtime(1시간)으로 판정하던 것을 전면 폐기했다.
#   mtime 은 *무엇을 검증했는지와 아무 관련이 없다* — touch 한 번이면 통과하고, 5분 전 증거라도
#   다른 상태를 검증한 것이면 그대로 통과했다. 이것이 QA 구멍의 뿌리였다.
#   대체: "증거가 검증한 상태 == 지금 push/완료하려는 상태" 여야 유효.
#
# 🚨 이 지문의 정의는 아래 3곳과 **바이트 단위로 동일**해야 한다. 정의가 갈리면 그 틈이 그대로
#    우회 통로가 되거나(누락), 정상 작업이 전부 막힌다(과잉):
#      - hook-templates/universal/qa-gate-before-push.sh  : CURRENT_WT
#      - hook-templates/ui-qa/qa-gate-before-push.sh      : (universal 과 동일 사본)
#      - hook-templates/ui-qa/task-quality-gate.sh        : _cur_wt()
#    실측 교훈:
#      - HEAD 를 빼면 커밋만 바뀐 경우를 못 잡아 빈 커밋이 통과했다.
#      - `git status --porcelain` 은 untracked 를 '?? path' 로만 내고 **내용을 안 본다** →
#        untracked 파일을 사후 수정해도 지문이 그대로였다(Codex HIGH 2026-08-04).
#        그래서 ls-files -o + hash-object 로 내용까지 해싱한다.
#
# 🚨 QA 증거 파일(.qa-cycle-passed 등)은 **pathspec 이 아니라 .gitignore 로 제외된다.**
#    `--exclude-standard` 가 gitignore 를 존중하기 때문이며, 그것이 유일한 방어선이다.
#    gitignore 에 없으면 **증거를 쓰는 행위가 지문을 바꿔 방금 만든 증거가 즉시 무효**가 된다
#    (자기무효화 → push 영구 차단). install-project-hooks.sh 가 설치 시 이 4줄을 보장한다.
#    (실측 2026-08-04: 게이트 설치 50곳 중 38곳이 누락 상태 = 잠복 브릭이었다.)
#
# 사용:
#   WT=$(bash ~/.claude/scripts/qa-state-fingerprint.sh)
#   printf 'PASS|%s|%s|%s\n' "$(git rev-parse --short HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$WT" > .qa-cycle-passed
#
#   --print-both : v1(현행 정의)과 v2(경로 목록 포함)를 각 1줄씩 2줄 출력 — accept-either
#     소비자용. 구버전 정본(이 플래그 미지원)은 1줄만 내므로 소비자는 2번째 줄 부재를
#     "v2 없음"으로 관대하게 처리해야 한다(하위호환).
#
# 출력: 64자 hex. 계산 불가 시 **빈 문자열 + exit 1** (fail-closed — 소비자는 빈 지문을
#   '통과'가 아니라 '검증 불가'로 처리해야 한다: 측정 불가 ≠ 통과).
# 🚨 배치 해싱 (2026-08-04 autoresearch 실측): 미추적 파일마다 git 프로세스를 1개씩 띄우면
#   파일 수에 선형으로 폭발한다 — 미추적 9,479개인 저장소에서 **120초**가 걸렸다.
#   `xargs -0 -n 200` 배치는 출력이 **바이트 동일**하면서 실측 38배 빠르다(2221ms→58ms,
#   공백·한글 파일명 포함 검증). 빈 입력에서 xargs 는 명령을 실행하지 않는다(macOS 확인).
#   실패 파일 특정이 필요한 곳은 배치로 먼저 판정하고, 실패했을 때만 개별 루프로 범인을 찾는다.
#   🚨 빈 입력 가드 (2026-08-04 Codex HIGH): GNU/Linux xargs 는 입력이 비어도 명령을
#   1회 실행해 `git hash-object --` 가 stdin 을 해싱하고 **빈-blob SHA** 를 덧붙인다.
#   그러면 미추적 0건인 저장소에서 shell 구현과 python 구현의 지문이 갈려 QA 증거가
#   영구 거부된다(크로스플랫폼 데드락). macOS(BSD)는 실행하지 않아 무해하지만, 어느
#   플랫폼에서도 같도록 sh 래퍼로 인자 0개면 아무 것도 출력하지 않게 한다.
# accept-either 2단계 롤아웃 (2026-08-06 발행 · stage1 착지 2026-08-13 · stage2 flip 2026-08-13):
#   원래 갭: untracked 파일의 **경로**는 v1 지문에 포함되지 않았다(status 는 '?? dir/' collapse,
#   hash-object 는 blob 만 기여) — 내용 동일 rename 이 지문 불변(stale 증거 재사용 창, Codex HIGH
#   2026-08-06). 수리(경로 목록 append)는 **지문 정의 변경**이라 원자 전개가 불가능(생산/소비
#   데드락) — artifact-relocation-consumer-alignment 부록 7 의 accept-either 2단계로 전개했다:
#     stage1(완료 2026-08-13, cc-sync 1c97bed9c): --print-both 추가(당시 기본 출력 v1 불변) +
#       소비자 게이트 6종 accept-either + coverage SSOT(fingerprint-coverage.sh) 신설.
#     stage2(완료 2026-08-13, 이 커밋): **기본 출력 v2 flip**. 근거는 이 주석이 아니라
#       fingerprint-coverage.sh exit 0 실측(차단 비교자 232/232 v2-ready — 스크립트 출력 사본,
#       fleet 재설치 install-project-hooks.sh 40 roots 후 달성). 소비자는 v1·v2 를 모두 계산해
#       accept-either 하므로 v2 증거가 즉시 수용된다.
#     🚨 커버리지 수치는 fingerprint-coverage.sh 출력의 사본으로만 적는다(분모 술어가 산문마다
#       달라 3회 측정 3개 값이 나온 실측 — 수치 정본은 술어 SSOT 스크립트).
#     stage3(잔여): 인라인 v1 생산자 정렬(coverage '생산자(참고)' 항목) 완료 + 유예 후
#       소비자의 v1 수용 제거. 그 전까지 --print-both 는 v1·v2 2줄 출력을 유지한다.
#   v2 정의(바이트 고정): 4스트림 그대로 ‖ `git ls-files -o --exclude-standard -z` (NUL 형, 맨 뒤 append).
set -uo pipefail

# 🚨 생산자도 소비자와 **같은 기준으로 fail-closed** (Codex MEDIUM 2026-08-04):
#   hash-object 실패를 `2>/dev/null` 로 삼키면 그 파일은 지문에 아무 기여도 하지 않는데,
#   push 게이트(_WT_UNREADABLE)와 task-quality-gate 는 같은 실패에서 **차단**한다.
#   그러면 생산자는 wt_sha 를 멀쩡히 만들어 증거에 기록하고 소비자는 무조건 거부하는
#   계약 불일치가 된다("동일 정의"라는 문서 주장도 거짓이 된다). 실패는 여기서도 차단한다.
_UNHASHABLE=$(if git ls-files -o --exclude-standard -z 2>/dev/null | xargs -0 -n 200 sh -c '[ "$#" -eq 0 ] || exec git hash-object -- "$@"' _ >/dev/null 2>&1; then :; else git ls-files -o --exclude-standard -z 2>/dev/null | while IFS= read -r -d '' _f; do git hash-object -- "$_f" >/dev/null 2>&1 || printf '%s
' "$_f"; done; fi)
if [ -n "$_UNHASHABLE" ]; then
  echo "🛑 상태 지문 계산 실패 — 해싱할 수 없는 미추적 항목이 있습니다(측정 불가 ≠ 통과):" >&2
  printf '%s\n' "$_UNHASHABLE" | head -5 | while IFS= read -r _u; do echo "   - $_u" >&2; done
  echo "   권한을 고치거나 .gitignore 에 추가한 뒤 재시도하세요." >&2
  echo "   (중첩 worktree 디렉토리라면 install-project-hooks.sh 재실행으로 .gitignore 가 보장됩니다)" >&2
  exit 1
fi

# 🚨 git 명령 실패 무시 금지 (Codex HIGH 2026-08-06): 기존엔 각 명령의 실패를 2>/dev/null 로
#   삼키고 **부분 출력**을 해싱했다 — 외부 diff driver 실패 재현에서 서로 다른 추적 내용이
#   같은 지문이 됐다(stale 증거 재사용 창). && 체인으로 어느 명령이든 실패하면 지문을 만들지
#   않고 exit 1 (fail-closed). 성공 경로의 스트림 내용은 종전과 **바이트 동일** — 게이트
#   인라인 정의와의 값 호환 유지(지문 정의 변경 아님).
_WT_TMP=$(mktemp "${TMPDIR:-/tmp}/qafp.XXXXXX") || { echo "🛑 상태 지문 계산 실패 — temp 생성 불가(측정 불가 ≠ 통과)" >&2; exit 1; }
trap 'rm -f "$_WT_TMP"' EXIT
if ! {
       git rev-parse HEAD &&
       git status --porcelain &&
       git diff HEAD &&
       { git ls-files -o --exclude-standard -z | xargs -0 -n 200 sh -c '[ "$#" -eq 0 ] || exec git hash-object -- "$@"' _; }
     } > "$_WT_TMP" 2>/dev/null; then
  echo "🛑 상태 지문 계산 실패 — git 상태 명령 오류(측정 불가 ≠ 통과). 저장소/diff driver 상태를 확인하세요." >&2
  exit 1
fi
WT=$(PATH=/usr/bin:/bin shasum -a 256 < "$_WT_TMP" 2>/dev/null | awk '{print $1}')

if [ -z "$WT" ]; then
  echo "🛑 상태 지문 계산 실패 — git 저장소인지 확인하세요(측정 불가 ≠ 통과)" >&2
  exit 1
fi

# v2 = 위 4스트림 뒤에 미추적 '경로 목록'(NUL 종결)을 그대로 append — 내용 동일 rename 가시화.
# 같은 temp 에 append 하므로 v1 계산에 쓴 바이트가 그대로 prefix (git 작업 중복 0).
if ! git ls-files -o --exclude-standard -z >> "$_WT_TMP" 2>/dev/null; then
  echo "🛑 상태 지문(v2) 계산 실패 — git ls-files 오류(측정 불가 ≠ 통과)" >&2
  exit 1
fi
WT2=$(PATH=/usr/bin:/bin shasum -a 256 < "$_WT_TMP" 2>/dev/null | awk '{print $1}')
if [ -z "$WT2" ]; then
  echo "🛑 상태 지문(v2) 계산 실패(측정 불가 ≠ 통과)" >&2
  exit 1
fi
if [ "${1:-}" = "--print-both" ]; then
  printf '%s\n%s\n' "$WT" "$WT2"
  exit 0
fi
# stage2 flip (2026-08-13): 기본 출력 = v2 (근거: fingerprint-coverage.sh exit 0 — 헤더 주석 참조)
printf '%s\n' "$WT2"
