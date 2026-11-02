#!/bin/bash
# claim-done-gate.sh
# TaskCompleted 이벤트(작업을 완료로 표시할 때)에서 "완료 선언"을 검증.
# 코드가 있는데 **현재 상태에 결속된** .qa-cycle-passed 가 없으면 차단 (exit 2).
#
# HARD 강제: 서브에이전트가 QA 없이 "완료" 보고하는 걸 exit code로 막음.
#
# 2026-08-03 (사용자 지시 — 시간 기반 판정 전면 폐기):
#   (1) `--since='1 hour ago'` 커밋 창 제거. 이 창 때문에 커밋이 1시간만 지나면
#       마커가 아예 없어도 통과했다(실측 exit 0).
#   (2) 마커 mtime 1시간 검사 제거. `touch` 한 번이면 무관한 옛 마커가 되살아났다(실측).
#   (3) 대체: 상태 결속 — 증거의 wt_sha(4번째 필드)가 지금 상태와 같아야 유효.
#       시간이 오래돼도 상태가 같으면 유효, 1분 전이어도 상태가 다르면 무효.
#   (4) 0/0 PASS(전 severity 테스트 0건) 마커 무효 — 검증 시늉(theater) 차단.
# 해제(의도적 opt-out 전용): CLAIM_DONE_GATE=0

#   🚨 빈 입력 가드 (2026-08-04 Codex HIGH): GNU/Linux xargs 는 입력이 비어도 명령을
#   1회 실행해 `git hash-object --` 가 stdin 을 해싱하고 **빈-blob SHA** 를 덧붙인다.
#   그러면 미추적 0건인 저장소에서 shell 구현과 python 구현의 지문이 갈려 QA 증거가
#   영구 거부된다(크로스플랫폼 데드락). macOS(BSD)는 실행하지 않아 무해하지만, 어느
#   플랫폼에서도 같도록 sh 래퍼로 인자 0개면 아무 것도 출력하지 않게 한다.
set -euo pipefail

# 완전 우회 (의도적 opt-out 전용)
if [ "${CLAIM_DONE_GATE:-1}" = "0" ]; then exit 0; fi

# stdin에서 hook event JSON 읽기
INPUT=$(cat 2>/dev/null || echo '{}')

# jq 없으면 python3
if ! command -v jq &>/dev/null; then
  jq() {
    python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    path = sys.argv[1].lstrip('.').split('.')
    for key in path:
        key = key.split('//')[0].strip()
        data = data.get(key, '') if isinstance(data, dict) else ''
    print(data if data else '')
except Exception:
    print('')
" "$@"
  }
fi

# 프로젝트 루트 찾기
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$PROJECT_ROOT"

CODE_EXT_RE='\.(ts|tsx|js|jsx|py|dart|kt|java|go|rs|vue|svelte|mjs|cjs)$'
CODE_GLOBS=('*.ts' '*.tsx' '*.js' '*.jsx' '*.py' '*.dart' '*.kt' '*.java' '*.go' '*.rs' '*.vue' '*.svelte' '*.mjs' '*.cjs')

# 코드 변경 여부 체크 (staged + unstaged)
CHANGED_FILES=$(git status --porcelain 2>/dev/null | awk '{print $2}' || true)
CODE_CHANGES=$(echo "$CHANGED_FILES" | grep -E "$CODE_EXT_RE" || true)

# 🚨 상태 결속 (2026-08-03 — 시간 창 전면 폐기, 사용자 지시)
#   폐기한 것: `git log --since="1 hour ago"` 창. 이건 **무엇을 검증했는지와 무관**하고,
#   실측으로 두 구멍이 확인됐다:
#     A) 코드 커밋이 1시간보다 오래되고 워킹트리가 clean 이면 `.qa-cycle-passed` 가
#        **아예 없어도** exit 0 (마커 검사에 도달조차 안 함).
#     B) 아래 mtime 검사는 `touch` 한 번으로 되살아난다(다른 커밋을 검증한 마커도 통과).
#   교체: 시간이 아니라 **QA 가 검증한 상태 == 지금 완료 선언하는 상태**인지 본다.
#   정의는 qa-gate-before-push.sh 3.3 / task-quality-gate 의 _cur_wt 와 **반드시 동일**
#   (정의가 갈리면 그 틈이 우회 통로가 된다).
# 🚨 지문은 **정본 스크립트**로 얻는다 (2026-08-04 Codex HIGH).
#   여기 인라인 사본이 hash-object 실패를 `2>/dev/null` 로 삼켜, 읽을 수 없는 미추적 파일의
#   내용이 지문에서 조용히 빠졌다. 그러면 그 파일을 사후 수정해도 지문이 그대로라 **stale 증거가
#   완료 게이트를 통과**한다 — 생산자·push 게이트는 같은 조건에서 fail-closed 인데 이 사본만
#   달랐다(정의 불일치 = 우회 통로, qa-evidence-format 규칙 위반).
#   🚨 **repo-local 사본을 실행하지 않는다** (2026-08-04 Codex CRITICAL — 직전 라운드 수리가
#   만든 회귀): 이 훅은 user scope 에서 돌고, 악성 저장소는 `.claude/hooks/` 아래에 아무
#   셸 코드나 커밋할 수 있다. 그걸 `bash` 로 실행하면 저장소를 여는 것만으로 RCE 다.
#   user-scope 보안 훅은 **신뢰 경계 안(사용자 홈)의 정본만** 실행한다.
_CDG_FP="$HOME/.claude/scripts/qa-state-fingerprint.sh"
[ -L "$_CDG_FP" ] && _CDG_FP=""   # 정본 자리가 심링크면 신뢰하지 않는다
if [ -n "$_CDG_FP" ] && [ -f "$_CDG_FP" ]; then
  # accept-either stage1 (2026-08-13, artifact-relocation-consumer-alignment 부록 7):
  #   --print-both 로 v1(현행 4스트림)·v2(4스트림 ‖ untracked 경로 목록 -z append)를 함께 얻어
  #   증거가 어느 쪽과 일치해도 통과 — 부분 배포 중 생산/소비 데드락 방지.
  #   구버전 정본(플래그 미지원)은 1줄만 내므로 2번째 줄 부재는 "v2 없음"으로 처리한다
  #   (수용 집합이 좁아지는 방향 — fail-open 아님).
  _CDG_BOTH=$(bash "$_CDG_FP" --print-both 2>/dev/null) || _CDG_BOTH=""
  CURRENT_WT=$(printf '%s\n' "$_CDG_BOTH" | sed -n '1p')
  CURRENT_WT_V2=$(printf '%s\n' "$_CDG_BOTH" | sed -n '2p')
else
  # 정본 부재 시에도 **같은 기준으로 fail-closed** — 해싱 불가 항목이 있으면 빈 값을 남긴다.
  if git ls-files -o --exclude-standard -z 2>/dev/null | xargs -0 -n 200 sh -c '[ "$#" -eq 0 ] || exec git hash-object -- "$@"' _ >/dev/null 2>&1; then
    CURRENT_WT=$( { git rev-parse HEAD 2>/dev/null
                    git status --porcelain 2>/dev/null
                    git diff HEAD 2>/dev/null
                    git ls-files -o --exclude-standard -z 2>/dev/null | xargs -0 -n 200 sh -c '[ "$#" -eq 0 ] || exec git hash-object -- "$@"' _ 2>/dev/null
                  } | PATH=/usr/bin:/bin shasum -a 256 2>/dev/null | awk '{print $1}' )
  else
    CURRENT_WT=""
  fi
  CURRENT_WT_V2=""   # 인라인 폴백은 v1 단독 — 수용 집합 축소 방향이라 안전
fi

# 이 저장소가 코드를 추적하는가 (문서 전용 저장소는 대상 아님)
# head -1 은 첫 줄만 읽고 파이프를 닫아, 코드 파일이 많은 저장소에서 git 이 SIGPIPE 로 죽고 pipefail·set -e 로 게이트 전체가
# rc 141(비차단 = 통과)로 끝났다(2026-10-17 재설치 측정: BisFramework·KFM). sed -n 1p 는 입력을 끝까지 읽는다.
TRACKS_CODE=$(git ls-files -- "${CODE_GLOBS[@]}" 2>/dev/null | sed -n 1p)

if [ -z "$CODE_CHANGES" ] && [ -z "$TRACKS_CODE" ]; then
  # 워킹트리 코드 변경 없음 + 저장소가 코드를 추적하지도 않음 → 통과 (문서/설정 전용)
  exit 0
fi

if [ -z "$CODE_CHANGES" ]; then
  CODE_CHANGES="(committed) $(git log -1 --name-only --format= -- "${CODE_GLOBS[@]}" 2>/dev/null | grep -E "$CODE_EXT_RE" | head -5 | tr '\n' ' ' || true)"
fi

# 🚨 /team 진입 시 QA 무효화가 **불완전**했으면 차단 (Codex HIGH 2026-08-04)
#   team-qa-evidence-reset.sh 가 .qa-required 에 reset_complete 를 기록한다.
#   0 이면 이전 증거가 살아남았다는 뜻이고, 그게 상태 결속상 유효하면 그대로 재사용된다 —
#   "이전 QA 이력과 무관하게 다시 실행" 지시가 그 지점에서 깨진다. 소비자가 없으면
#   그 마커는 문서일 뿐이므로(producer-without-consumer) 여기서 실제로 읽는다.
if [ -f ".qa-required" ] && grep -q '^reset_complete=0' ".qa-required" 2>/dev/null; then
  echo "❌ claim-done-gate: /team 진입 시 QA 이력 무효화가 완료되지 않았습니다." >&2
  grep -E '^(skipped|archived)=' ".qa-required" 2>/dev/null | sed 's/^/     /' >&2
  echo "   이전 QA 증거가 남아 재사용될 수 있습니다 — 증거를 직접 제거하고 QA 재실행하세요." >&2
  echo "   (해제: 무효화 사유를 해소한 뒤 .qa-required 삭제)" >&2
  exit 2
fi

# 코드 변경이 있는데 .qa-cycle-passed가 없거나 오래됨 → 차단
if [ ! -f ".qa-cycle-passed" ]; then
  echo "❌ claim-done-gate: 코드 변경이 있는데 .qa-cycle-passed 파일이 없습니다." >&2
  echo "   변경된 코드 파일:" >&2
  echo "$CODE_CHANGES" | head -5 | sed 's/^/     /' >&2
  echo "" >&2
  echo "   QA 실행 필수: Skill(\"qa-cycle\")" >&2
  exit 2
fi

# 🚨 상태 결속 검증 (mtime 신선도 + 커밋시각 비교를 대체)
#   형식: PASS|{short_hash}|{iso_ts}|{wt_sha}  — 4번째 필드가 QA 시점 워킹트리 지문.
#   시간이 아무리 오래돼도 상태가 같으면 유효하고, 1분 전이어도 상태가 다르면 무효다.
QA_FIRST_LINE=$(head -1 ".qa-cycle-passed" 2>/dev/null || true)
STORED_WT=$(printf '%s' "$QA_FIRST_LINE" | cut -d'|' -f4)

if [ -z "$STORED_WT" ]; then
  echo "❌ claim-done-gate: .qa-cycle-passed 에 워킹트리 결속 필드(4번째)가 없습니다." >&2
  echo "   'mtime 1시간' 신선도는 폐기됐습니다 — touch 로 통과하고 무엇을 검증했는지 못 보기 때문." >&2
  echo "   QA 재수행 후 아래 형식으로 기록하세요:" >&2
  # (아래는 **사용자가 자기 저장소에서** 증거를 만들 때의 안내다 — 자기 신뢰 맥락이므로
  #  project-local 우선이 맞다. 반면 이 훅 자신은 user scope 정본만 실행한다(위 CRITICAL 주석).
  echo "     FP=.claude/hooks/qa-state-fingerprint.sh; [ -f \"\$FP\" ] || FP=~/.claude/scripts/qa-state-fingerprint.sh" >&2
  echo "     WT=\$(bash \"\$FP\") || { echo 지문계산실패; exit 1; }" >&2
  echo "     PASS|\$(git rev-parse --short HEAD)|\$(date -u +%Y-%m-%dT%H:%M:%SZ)|\$WT" >&2
  exit 2
fi

if [ "$STORED_WT" != "$CURRENT_WT" ] && [ "$STORED_WT" != "$CURRENT_WT_V2" ]; then
  echo "❌ claim-done-gate: QA 가 검증한 상태와 지금 완료 선언하는 상태가 다릅니다." >&2
  echo "   증거 결속: ${STORED_WT:0:12}… / 현재 상태: ${CURRENT_WT:0:12}…" >&2
  [ -n "$CURRENT_WT_V2" ] && echo "   (v2 지문과도 불일치: ${CURRENT_WT_V2:0:12}…)" >&2
  echo "   새 커밋이든 미커밋 수정이든 QA 이후 바뀌었습니다 — QA 재실행 필요: Skill(\"qa-cycle\")" >&2
  exit 2
fi

# 커밋 결속도 함께 확인 (상태 지문에 HEAD 가 포함되나, 오탐 진단 메시지를 위해 분리 유지)
STORED_HASH=$(printf '%s' "$QA_FIRST_LINE" | cut -d'|' -f2)
CURRENT_HASH=$(git rev-parse --short HEAD 2>/dev/null || true)
if [ -n "$STORED_HASH" ] && [ -n "$CURRENT_HASH" ] && [ "$STORED_HASH" != "$CURRENT_HASH" ]; then
  echo "❌ claim-done-gate: QA 이후 새 커밋 발생. hash($STORED_HASH) != HEAD($CURRENT_HASH)." >&2
  echo "   커밋된 코드가 QA를 거치지 않았습니다 — QA 재실행 필요: Skill(\"qa-cycle\")" >&2
  exit 2
fi

# 0/0 PASS 무효화: severity 라인이 존재하는데 전 severity total 합이 0이면 검증 시늉 → 차단
SEV_LINES=$(grep -cE '^(CRITICAL|HIGH|MEDIUM|LOW):' ".qa-cycle-passed" 2>/dev/null || echo 0)
if [ "${SEV_LINES:-0}" -gt 0 ]; then
  TOTAL_TCS=$(grep -E '^(CRITICAL|HIGH|MEDIUM|LOW):' ".qa-cycle-passed" | sed -E 's/.*: *[0-9]+\/([0-9]+).*/\1/' | awk '{s+=$1} END{print s+0}' || echo 0)
  if [ "${TOTAL_TCS:-0}" -eq 0 ]; then
    echo "❌ claim-done-gate: .qa-cycle-passed가 전 severity 0/0 PASS — 테스트 0건은 QA가 아닙니다." >&2
    echo "   실제 테스트를 실행하고 pass/total(>0)을 기록해야 합니다: Skill(\"qa-cycle\")" >&2
    exit 2
  fi
fi

# 🚨 레벨2·3 미완료 차단 (2026-10-17 사용자 지시 — "레벨1 통과 후 merge·push, 그 뒤 레벨2·3")
#   qa-gate-before-push 는 level2/level3 이 deferred:post-push 인 증거로도 push 를 허용한다(레벨1 PASS 뒤에만).
#   완료는 레벨2·3 이 PASS/N/A 일 때만이다(완료 마커는 전건 성공에만). 종전엔 객체형 deferred 만 보아
#   FAIL·문자열형 deferred·qa_ladder 삭제가 완료로 통과했다(C35) — 이제 허용값 밖은 전부 막는다.
#   레벨 키 부재 자체는 이 게이트의 몫이 아니다(H-/A- 존재 시 판정 필수는 push 게이트 ③ 이 맡는다).
#   다만 미룸·위임 흔적(deferred:post-push·delegated:push-gate)이 증거 어디에든 남았는데 qa_ladder 나
#   레벨2·3 키가 빠졌으면 지운 흔적으로 보고 막는다. 흔적은 원문(중복 키로 가려진 값)과 파싱된 키·값 전체
#   (유니코드 이스케이프로 원문 검색을 피한 값)에서 찾는다. 둘 다 PASS/N/A 로 남아 있으면 흔적이 있어도 통과.
#   한계: 증거 파일을 통째로 지우거나 토큰을 다른 말로 바꾸면 이 검사로는 못 잡는다(증거 부재 시 동작은 종전 유지).
#   증거 파일이 있는데 JSON 으로 못 읽거나(빈 파일·BOM 포함 — push 게이트와 같은 판정) 판정 출력이 없으면
#   통과로 읽지 않는다(fail-closed).
#   판정기는 python3 -I(격리 모드)로 돈다 — 현재 폴더(저장소 루트)를 모듈 경로에서 빼서 루트의 json.py·enum.py 가
#   표준 모듈을 가로채 거짓 통과·거짓 차단을 만들거나 __pycache__ 로 저장소(=상태 지문)를 바꾸지 못하게 한다.
#   ⚠ 강제 범위: 이 검사는 TaskCompleted(TaskUpdate 로 완료 표시)에서만 돈다 — 리드의 응답 종료(Stop)에는
#   걸리지 않는다(install-project-hooks.sh 가 이 훅을 TaskCompleted 에만 배선한다).
if [ -f ".qa-evidence.json" ]; then
  _CDG_LAD=$(python3 -I -c 'import json, sys
TRACE = ("deferred:post-push", "delegated:push-gate")
try:
    raw = open(sys.argv[1], encoding="utf-8").read()
    d = json.loads(raw)
except Exception as e:
    print("BLOCK:.qa-evidence.json 을 JSON 으로 읽지 못함(%s)" % e.__class__.__name__); sys.exit(0)
if not isinstance(d, dict):
    print("BLOCK:.qa-evidence.json 루트가 객체가 아님"); sys.exit(0)
def traces():
    # 원문 검색 + 파싱된 키·값 전체 순회(깊은 중첩에서도 재귀 한계에 걸리지 않게 스택으로 돈다)
    found = set(t for t in TRACE if t in raw)
    st = [d]
    while st:
        x = st.pop()
        if isinstance(x, str):
            found.update(t for t in TRACE if t in x)
        elif isinstance(x, dict):
            st.extend(x.keys()); st.extend(x.values())
        elif isinstance(x, list):
            st.extend(x)
    return "·".join(sorted(found))
if "qa_ladder" not in d:
    # 사다리도 미룸·위임 흔적도 없으면 레거시 증거 — 통과
    tr = traces()
    print(("BLOCK:qa_ladder 가 없는데 %s 가 남아 있음(사다리를 지운 흔적)" % tr) if tr else "OK")
    sys.exit(0)
lad = d["qa_ladder"]
if not isinstance(lad, dict):
    print("BLOCK:qa_ladder 가 객체가 아님(%s)" % type(lad).__name__); sys.exit(0)
bad = []
miss = []
for k in ("level2_heuristic", "level3_adversarial"):
    if k not in lad:
        miss.append(k); continue
    v = lad[k]
    if not isinstance(v, dict):
        bad.append("%s=%s (객체 아님)" % (k, json.dumps(v, ensure_ascii=False)[:60])); continue
    s = v.get("status")
    if not (isinstance(s, str) and s.strip() in ("PASS", "N/A")):
        bad.append("%s.status=%s" % (k, json.dumps(s, ensure_ascii=False)[:60]))
if miss:
    tr = traces()
    if tr:
        bad.append("%s 키가 없는데 %s 가 남아 있음(레벨 기록을 지운 흔적)" % ("·".join(miss), tr))
print(("BLOCK:" + ", ".join(bad)) if bad else "OK")' ".qa-evidence.json" 2>/dev/null) || _CDG_LAD="BLOCK:판정기 실행 실패(rc=$?)"
  if [ "$_CDG_LAD" != "OK" ]; then
    _CDG_WHY="${_CDG_LAD#BLOCK:}"
    echo "❌ claim-done-gate: 검증 레벨 사다리가 끝나지 않았습니다 — ${_CDG_WHY:-판정 출력 없음}" >&2
    echo "   레벨2(휴리스틱)·레벨3(적대)을 끝까지 실행하고 .qa-evidence.json 의 qa_ladder 에서 각 status 를 PASS(해당 없으면 N/A)로 갱신해야 완료입니다." >&2
    echo "   FAIL 은 고친 뒤 재실행, deferred:post-push·delegated:push-gate 는 미룬 레벨을 마저 돌린 뒤 PASS 로 바꾸세요 — qa_ladder 나 레벨 키를 지우는 것은 해소가 아닙니다." >&2
    echo "   (rule: qa-verification-levels — 단계 push)" >&2
    exit 2
  fi
fi

exit 0
