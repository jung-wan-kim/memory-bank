#!/bin/bash

# validate-before-commit.sh
# PreToolUse Hook: git commit 명령 감지 시 빌드/타입/테스트 게이트
# 모든 검증 통과 시에만 커밋 허용 (exit 0), 실패 시 차단 (exit 2)

# jq 없으면 python3 폴백
if ! command -v jq &>/dev/null; then
  jq() {
    python3 -c "
import sys, json
data = json.load(sys.stdin)
path = sys.argv[1].lstrip('.').split('.')
for key in path:
    key = key.split('//')[0].strip()
    data = data.get(key, '') if isinstance(data, dict) else ''
print(data if data else '')
" "$@"
  }
fi

# stdin에서 JSON 입력 읽기
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Bash 도구의 git commit 명령만 필터링
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

# 연속행(백슬래시-개행)은 bash 처럼 제거 후, 남은 개행은 공백 평탄화해 매칭
# (g\<개행>it 토큰 융합·줄단위 grep 미스 방지). 순수 bash 치환 — sed N 은 EOF 에서
# 무출력이라 꼬리 백슬래시 주석(# \)로 _FLAT 을 비워 훅 전체를 skip 시킬 수 있었다 (Codex HIGH R10).
_FLAT=${COMMAND//\\$'\n'/}
_FLAT=${_FLAT//$'\n'/ }
if ! printf '%s' "$_FLAT" | grep -qE "git[[:space:]].*commit"; then
  exit 0
fi

# --allow-empty/--amend 스킵은 아래 python argv 파싱에서 토큰 단위로 판정
# (raw grep 은 -m "fix --amend" 처럼 메시지 문자열 속 위장에 속는다 — Codex HIGH R5)

# --- 커밋 메시지 포맷 검증 ---
# 모든 -m/--message 값을 shlex로 추출해 전수 검사.
# ⚠️ 경계 (정직 고지): 이 훅은 명령 "문자열"의 정적 파싱이다 — 글롭(A?*)·틸드·브레이스 확장처럼
# 실행 시점에 argv가 달라지는 경로는 원리적으로 판정 불가(agent-browser-security.sh의 수학적
# 한계와 동일 클래스). 위협모델은 "세션 작성자의 습관 실수 방지"(가드레일)이지 적대 작성자가
# 아니다 — 의도적 우회는 훅 비활성화와 등가라 정적 강화로 막을 수 없다. 판정 가능한 것(리터럴·
# 다중 메시지 플래그·클러스터·변수/명령치환·렉싱불가)은 전부 검사하고, 나머지는 이 경계 선언으로 남긴다.
# 이력: ① sed ["\x27] 브라켓이 BSD sed에서 « " \ x 2 7 » 문자집합이 되어 fix 제목 오차단
# (2026-07-19) ② 템플릿 마이그레이션이 수정을 되돌려 회귀(2026-08-08) ③ sed는 마지막 -m만
# 읽어 `-m "AI..." -m "..."` 로 AI 제목 검사 우회 가능(Codex HIGH) → shlex 전수 추출로 근본 전환.
# 첫 -m = git 제목(subject). shlex 실패(복합명령 따옴표 불균형 등)는 검사 skip — 오차단 방지.
COMMIT_MSGS=$(printf '%s' "$COMMAND" | python3 -c '
import re, shlex, sys
raw = sys.stdin.read()
# 셸 연속행(백슬래시-개행)은 bash 와 동일하게 "제거"(토큰 융합 보존: g\<개행>it → git,
# 큰따옴표 안 A\<개행>I → AI). 남은 개행은 명령 구분자로 정규화.
raw_lex = raw.replace("\r\n", "\n").replace("\\\n", "").replace("\n", " ; ")
try:
    lx = shlex.shlex(raw_lex, posix=True, punctuation_chars=True)
    lx.whitespace_split = True
    toks = list(lx)
except ValueError:
    # 렉싱 불가 — git commit -m 이 보이면 검증 불가로 차단 (skip하면 우회 통로)
    if re.search(r"git\s+commit", raw) and re.search(r"(^|[\s\"\x27=(])-{1,2}[a-z]*m", raw):
        print("__VBC_UNVERIFIABLE__")
    sys.exit(0)
# 셸 구분자(;, &&, ||, |, 리다이렉션, 괄호) 토큰 기준으로 세그먼트 분할 —
# 다른 세그먼트의 --amend/echo 인자가 git commit 검증에 섞이는 것 차단 (Codex HIGH R6)
SEP = set(";&|<>(){}")
segs = []
cur = []
for t in toks:
    if t and all(c in SEP for c in t):
        if cur:
            segs.append(cur)
            cur = []
    else:
        cur.append(t)
if cur:
    segs.append(cur)
msgs = []
unverifiable = False
for seg in segs:
    if "git" not in seg:
        continue
    gi = seg.index("git")
    after_git = seg[gi + 1:]
    # git 전역옵션 통과: -C <path>/-c <cfg> 는 값 동반, 그 외 -* 는 단독 — 첫 서브커맨드 탐색
    j = 0
    sub = ""
    while j < len(after_git):
        x = after_git[j]
        if x in ("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"):
            j += 2
            continue
        if x.startswith("-"):
            j += 1
            continue
        sub = x
        break
    if sub != "commit":
        continue
    args = after_git[j + 1:]
    seg_msgs = []
    seg_skip = False
    seg_unv = False
    i = 0
    while i < len(args):
        t = args[i]
        if t == "--":  # pathspec 구분자 — 이후는 경로
            break
        val = None
        if t in ("-m", "--message"):
            if i + 1 < len(args):
                val = args[i + 1]; i += 2
            else:
                i += 1
        elif t.startswith("--message="):
            val = t[len("--message="):]; i += 1
        elif t in ("--amend", "--allow-empty"):
            # 이 git commit 세그먼트의 "플래그 위치" 토큰만 — 메시지 값/타 세그먼트는 여기 오지 않는다
            seg_skip = True; i += 1
        elif len(t) > 1 and t[0] == "-" and t[1] != "-" and "m" in t[1:]:
            pos = t.index("m", 1)
            rest = t[pos + 1:]
            if rest:
                val = rest; i += 1
            elif i + 1 < len(args):
                val = args[i + 1]; i += 2
            else:
                i += 1
        else:
            i += 1
            continue
        if val is None:
            continue
        if re.search(r"[$](?!\d)", val) or "\x60" in val:
            seg_unv = True
        else:
            seg_msgs.append(val.replace("\n", " ").replace("\r", " "))
    if seg_skip:
        continue  # amend/allow-empty 세그먼트는 검증 면제 (그 세그먼트만)
    msgs.extend(seg_msgs)
    unverifiable = unverifiable or seg_unv
if unverifiable:
    print("__VBC_UNVERIFIABLE__")
for m in msgs:
    print(m)
' 2>/dev/null)
# 검증 불가(동적 메시지) = fail-loud 차단 — 정적 게이트를 변수로 우회하는 경로 봉쇄 (Codex HIGH R2)
if printf '%s\n' "$COMMIT_MSGS" | grep -q "^__VBC_UNVERIFIABLE__$"; then
  echo "  x 커밋 메시지에 변수/명령치환이 있어 정적 검증 불가 — 리터럴 -m \"메시지\" 로 다시 실행하세요" >&2
  exit 2
fi
if [ -n "$COMMIT_MSGS" ]; then
  SUBJECT=$(printf '%s\n' "$COMMIT_MSGS" | head -1)
  # 빈/짧은 제목 차단 (git은 첫 -m 을 제목으로 쓴다)
  if [ ${#SUBJECT} -lt 3 ]; then
    echo "  x 커밋 메시지가 너무 짧습니다 (최소 3자)" >&2
    exit 2
  fi
  # AI 관련 메시지 차단 (사용자 규칙) — 어느 -m 값이든 (마지막-m만 검사하던 우회 차단)
  if printf '%s\n' "$COMMIT_MSGS" | grep -qiE "^(AI|Claude|GPT|LLM|generated by)"; then
    echo "  x 커밋 메시지에 AI 관련 내용 포함 금지" >&2
    exit 2
  fi
fi

# --- 적응형 3-tier 검증 시스템 ---

# 1. 스테이징된 파일 목록 수집
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null)
if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

FILE_COUNT=$(echo "$STAGED_FILES" | wc -l | tr -d ' ')

# 2. 코드 파일 여부 판별 (확장자 기반)
CODE_EXTENSIONS="ts|tsx|js|jsx|py|dart|java|go|rs|rb|php|swift|kt|c|cpp|h|html|vue|svelte"
HAS_CODE=0
while IFS= read -r file; do
  if echo "$file" | grep -qE "\.($CODE_EXTENSIONS)$"; then
    HAS_CODE=1
    break
  fi
done <<< "$STAGED_FILES"

# 3. 보안/아키텍처 패턴 감지 (파일명/디렉토리명의 단어 경계 매칭)
HAS_SECURITY=0
HAS_ARCHITECTURE=0
while IFS= read -r file; do
  # 보안: .env 파일, 또는 경로 구성요소에 보안 키워드 포함
  if echo "$file" | grep -qE "\.env(\.|$)"; then
    HAS_SECURITY=1
  fi
  BASENAME=$(basename "$file")
  if echo "$BASENAME" | grep -qiE "^(auth|secret|credential|permission)[^a-z]|[^a-z](auth|secret|credential|permission)"; then
    HAS_SECURITY=1
  fi
  # 아키텍처: 디렉토리명이 정확히 매칭 또는 파일명이 키워드로 시작
  if echo "$file" | grep -qiE "(^|/)migrations?/|(^|/)middleware/|(^|/)routes?/|(^|/)schemas?/"; then
    HAS_ARCHITECTURE=1
  fi
  if echo "$BASENAME" | grep -qiE "^(schema|migration|middleware)\.(ts|js|py|dart|sql)$"; then
    HAS_ARCHITECTURE=1
  fi
done <<< "$STAGED_FILES"

# 4. 티어 결정
TIER="STANDARD"

# LIGHT: 비코드 파일만 + 3개 이하
if [ "$HAS_CODE" -eq 0 ] && [ "$FILE_COUNT" -le 3 ]; then
  TIER="LIGHT"
fi

# THOROUGH: 보안/아키텍처 파일 포함 또는 10개 초과
if [ "$HAS_SECURITY" -eq 1 ] || [ "$HAS_ARCHITECTURE" -eq 1 ] || [ "$FILE_COUNT" -gt 10 ]; then
  TIER="THOROUGH"
fi

echo "[검증 티어: $TIER] (파일 ${FILE_COUNT}개)" >&2

# LIGHT 티어: 즉시 통과
if [ "$TIER" = "LIGHT" ]; then
  echo "  o 비코드 파일만 변경 - 검증 스킵" >&2
  exit 0
fi

# --- 티어별 검증 실행 ---

GATE_FAILED=0
ERRORS=""

# 프로젝트 유형 감지
IS_NODE=0
IS_FLUTTER=0
[ -f "package.json" ] && IS_NODE=1
[ -f "pubspec.yaml" ] && IS_FLUTTER=1

# === Node.js 프로젝트 검증 ===
if [ "$IS_NODE" -eq 1 ]; then

  # [STANDARD + THOROUGH] 타입 체크
  if grep -q '"type-check"' package.json 2>/dev/null; then
    echo "  [타입체크] TypeScript 검증 중..." >&2
    TYPE_OUTPUT=$(npm run type-check 2>&1)
    if [ $? -ne 0 ]; then
      GATE_FAILED=1
      ERRORS+="[TYPE ERROR]\n$(echo "$TYPE_OUTPUT" | grep -E "error TS" | head -10)\n\n"
      echo "  x 타입 체크 실패" >&2
    else
      echo "  o 타입 체크 통과" >&2
    fi
  fi

  # [THOROUGH only] 빌드 체크
  if [ "$TIER" = "THOROUGH" ]; then
    if grep -q '"build"' package.json 2>/dev/null; then
      echo "  [빌드] 빌드 검증 중..." >&2
      BUILD_OUTPUT=$(npm run build 2>&1)
      if [ $? -ne 0 ]; then
        GATE_FAILED=1
        ERRORS+="[BUILD ERROR]\n$(echo "$BUILD_OUTPUT" | tail -20)\n\n"
        echo "  x 빌드 실패" >&2
      else
        echo "  o 빌드 통과" >&2
      fi
    fi

    # [THOROUGH only] 테스트 실행
    if grep -q '"test"' package.json 2>/dev/null; then
      TEST_SCRIPT=$(node -e "const p=require('./package.json'); console.log(p.scripts?.test || '')" 2>/dev/null)
      if [ -n "$TEST_SCRIPT" ] && ! echo "$TEST_SCRIPT" | grep -qE "^(echo|exit|no test)"; then
        echo "  [테스트] 테스트 실행 중..." >&2
        TEST_OUTPUT=$(timeout 120 npm test -- --run 2>&1 || timeout 120 npm test 2>&1)
        if [ $? -ne 0 ]; then
          GATE_FAILED=1
          ERRORS+="[TEST ERROR]\n$(echo "$TEST_OUTPUT" | tail -20)\n\n"
          echo "  x 테스트 실패" >&2
        else
          echo "  o 테스트 통과" >&2
        fi
      fi
    fi
  fi
fi

# === Flutter 프로젝트 검증 ===
if [ "$IS_FLUTTER" -eq 1 ]; then

  # [STANDARD + THOROUGH] flutter analyze
  echo "  [분석] Flutter analyze 실행 중..." >&2
  ANALYZE_OUTPUT=$(flutter analyze 2>&1)
  if [ $? -ne 0 ]; then
    GATE_FAILED=1
    ERRORS+="[FLUTTER ANALYZE]\n$(echo "$ANALYZE_OUTPUT" | tail -15)\n\n"
    echo "  x Flutter analyze 실패" >&2
  else
    echo "  o Flutter analyze 통과" >&2
  fi

  # [THOROUGH only] flutter test
  if [ "$TIER" = "THOROUGH" ]; then
    echo "  [테스트] Flutter test 실행 중..." >&2
    FTEST_OUTPUT=$(flutter test 2>&1)
    if [ $? -ne 0 ]; then
      GATE_FAILED=1
      ERRORS+="[FLUTTER TEST]\n$(echo "$FTEST_OUTPUT" | tail -15)\n\n"
      echo "  x Flutter test 실패" >&2
    else
      echo "  o Flutter test 통과" >&2
    fi
  fi
fi

# === Supabase Edge Function 변경 감지 ===
HAS_EDGE_FN=0
EDGE_FN_FILES=""
while IFS= read -r file; do
  if echo "$file" | grep -qE "^supabase/functions/.*/index\.ts$"; then
    HAS_EDGE_FN=1
    EDGE_FN_FILES+="$file "
  fi
done <<< "$STAGED_FILES"

if [ "$HAS_EDGE_FN" -eq 1 ]; then
  echo "" >&2
  echo "  ⚠ [Edge Function 변경 감지] $EDGE_FN_FILES" >&2
  echo "    커밋 후 반드시 배포하세요:" >&2
  echo "    npx supabase functions deploy <name> --no-verify-jwt" >&2
  echo "" >&2
fi

# === HTML 프론트엔드 검증 (public/*.html 변경 시) ===
HAS_HTML=0
HTML_FILES=""
while IFS= read -r file; do
  if echo "$file" | grep -qE "^public/.*\.html$"; then
    HAS_HTML=1
    HTML_FILES+="$file "
  fi
done <<< "$STAGED_FILES"

if [ "$HAS_HTML" -eq 1 ]; then
  echo "  [HTML] 프론트엔드 파일 변경 감지: $HTML_FILES" >&2

  # 1. HTML 구문 오류 체크 (script 태그 닫힘, 기본 구조)
  for hf in $HTML_FILES; do
    if [ -f "$hf" ]; then
      # script 태그 열림/닫힘 수 비교
      OPEN_SCRIPT=$(grep -c "<script" "$hf" 2>/dev/null || echo 0)
      CLOSE_SCRIPT=$(grep -c "</script>" "$hf" 2>/dev/null || echo 0)
      if [ "$OPEN_SCRIPT" -ne "$CLOSE_SCRIPT" ]; then
        GATE_FAILED=1
        ERRORS+="[HTML SYNTAX] $hf: <script> 태그 불일치 (열림:$OPEN_SCRIPT, 닫힘:$CLOSE_SCRIPT)\n\n"
        echo "  x $hf: script 태그 불일치" >&2
      fi

      # Supabase RPC 호출이 있으면 함수명 존재 여부 경고
      RPC_CALLS=$(grep -oE "rpc\(['\"][^'\"]+['\"]" "$hf" 2>/dev/null | sed "s/rpc(['\"]//;s/['\"]//")
      if [ -n "$RPC_CALLS" ]; then
        echo "  i $hf: RPC 함수 호출 감지: $RPC_CALLS" >&2
        echo "  ⚠ 배포 전 브라우저에서 RPC 응답 확인 필수!" >&2
      fi
    fi
  done

  # 2. Vercel 배포 예정이면 경고
  echo "" >&2
  echo "  ⚠ [HTML 변경 감지] 커밋 후 배포 전에 반드시:" >&2
  echo "    1. 로컬에서 브라우저 열어서 확인하거나" >&2
  echo "    2. vercel preview로 테스트 후 vercel --prod 실행" >&2
  echo "" >&2
fi

# === L0: API Contract 검증 (THOROUGH only) ===
if [ "$TIER" = "THOROUGH" ] && [ -f "scripts/verify-dto-mapping.py" ]; then
  echo "  [L0] API Contract 검증 중..." >&2
  DTO_OUTPUT=$(python3 scripts/verify-dto-mapping.py 2>&1)
  if echo "$DTO_OUTPUT" | grep -qiE "ERROR|FAIL|mismatch"; then
    ERRORS+="[API CONTRACT]\n$(echo "$DTO_OUTPUT" | head -10)\n\n"
    echo "  ! API Contract 불일치 감지 (경고)" >&2
    # 경고만, BLOCK하지 않음
  else
    echo "  o API Contract 통과" >&2
  fi
fi

# === Self-Challenge: 완료 전 자가 검증 (THOROUGH only) ===
if [ "$TIER" = "THOROUGH" ] && [ "$FILE_COUNT" -gt 5 ]; then
  if [ ! -f ".completion-check.md" ] && [ ! -f "docs/.completion-check.md" ]; then
    if [ "$FILE_COUNT" -gt 10 ]; then
      # 10개 초과: BLOCK
      GATE_FAILED=1
      ERRORS+="[SELF-CHALLENGE] ${FILE_COUNT}개 파일 커밋. .completion-check.md (QA HARD/SOFT/미구현 표) 필수.\n\n"
      echo "  x [Self-Challenge] ${FILE_COUNT}개 파일 — .completion-check.md 없이 커밋 불가" >&2
    else
      # 5~10개: WARNING
      echo "  ⚠️ [Self-Challenge] ${FILE_COUNT}개 파일. .completion-check.md 작성 권장." >&2
    fi
  else
    echo "  o Self-Challenge 검증 파일 확인됨" >&2
  fi
fi

# --- 게이트 판정 ---
if [ $GATE_FAILED -eq 1 ]; then
  echo "" >&2
  echo "--- Commit Gate BLOCKED [$TIER] ---" >&2
  echo "아래 에러를 수정한 후 다시 커밋하세요:" >&2
  echo -e "$ERRORS" >&2
  exit 2
fi

echo "  o 모든 검증 통과 [$TIER]" >&2
exit 0
