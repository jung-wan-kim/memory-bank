#!/bin/bash
# STACK: universal
# pipefail-grep-ok
# ai-commit-msg-ban.sh — HARD gate
# git commit -m "..." 메시지에 AI/Claude/GPT/LLM 관련 내용 금지.
# 사용자 명시적 규칙: "Git 커밋 메시지에 AI 관련 내용 제외".
set -euo pipefail

INPUT=$(cat 2>/dev/null || echo '{}')

# [perf] sound prefilter — 차단은 -m 메시지 내 AI 키워드가 전제. 키워드 substring 부재 시 python 스폰 없이 통과.
# 키워드: claude|anthropic|gpt|llm|copilot|generated (ai_generated/generated.by.ai 는 generated 포함).
# 대소문자(tr)/따옴표·백슬래시 난독화(strip) 대비 후 검사 — 동작 부분집합 불변.
_PF="${INPUT//\"/}"; _PF="${_PF//\'/}"; _PF="${_PF//\\/}"
_LC=$(printf '%s' "$_PF" | tr '[:upper:]' '[:lower:]')
case "$_LC" in
  *claude*|*anthropic*|*gpt*|*llm*|*copilot*|*generated*) : ;;
  *) exit 0 ;;
esac

TOOL=$(echo "$INPUT" | python3 -c "
import sys, json
try: print(json.load(sys.stdin).get('tool_name',''))
except: print('')
")
[ "$TOOL" = "Bash" ] || exit 0

CMD=$(echo "$INPUT" | python3 -c "
import sys, json
try: print(json.load(sys.stdin).get('tool_input', {}).get('command', ''))
except: print('')
")

# Eval-resistant: command 전체에서 -m '...' / -m "..." 패턴을 추출하여 AI 키워드 검사.
# git commit context 정규식 의존하지 않음 (eval/변수 치환 bypass 방지).
MSG=$(printf '%s' "$CMD" | python3 -c "
import sys, re
cmd = sys.stdin.read()
# command 안 어디든 git + commit + -m 패턴이 있으면 메시지 추출
msgs = re.findall(r\"-m\s+'([^']*)'|-m\s+\\\"([^\\\"]*)\\\"|-m\s+(\S+)\", cmd, re.DOTALL)
for m in msgs:
    text = m[0] or m[1] or m[2]
    if text:
        print(text)
" 2>/dev/null)

[ -z "$MSG" ] && exit 0

# 경로/파일명 문맥 면제 (2026-08-12 P5): CLAUDE.md·.claude/ 경로·claude-code-* 표기는 파일명이지 AI 귀속 언급이 아니다.
MSG=$(printf '%s' "$MSG" | sed -E 's#CLAUDE\.md##g; s#~?/?\.claude(/[^[:space:]]*)?##g; s#claude-code(-[[:alnum:]_-]+)?##g')

# AI 관련 키워드 금지 — word boundary 기반 (하이픈/언더스코어 뒤도 감지)
if echo "$MSG" | grep -qiE '\b(claude|anthropic|gpt|llm|copilot)\b|ai[[:space:]_]generated|generated.by.ai'; then
  echo "❌ ai-commit-msg-ban: commit message에 AI 관련 내용 금지" >&2
  echo "   발견: $(echo "$MSG" | grep -iE 'claude|anthropic|gpt|llm|copilot|ai.generated|generated.by.ai' | head -2)" >&2
  exit 2
fi

exit 0
