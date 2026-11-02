#!/bin/bash
# deploy-verify-marker.sh — PostToolUse(Bash): 배포 명령 감지 → .deploy-pending-verify 마커 생성 (producer)
#
# 목적: "배포된 이후에는 아예 테스트를 안 한다"는 갭을 HARD로 닫는다 (2026-07-24 사용자 지시).
#   배포가 일어난 사실을 에이전트 자기신고가 아니라 hook이 결정론적으로 기록 → 소비자 게이트
#   (task-quality-gate.sh Gate 5 / qa-gate-before-push.sh POST-DEPLOY GATE)가 배포 URL 대상
#   smoke+E2E 재검증 증거(.qa-evidence.json 의 post_deploy 블록, 마커보다 신선)를 요구하고
#   없으면 exit 2 로 완료/push 를 차단한다. backend-patterns "배포 후 smoke test 필수"의 HARD 승격.
#
# 🚨 2026-09-02 순환 결함 수리 — "시도"가 아니라 "착지"에만 마커를 찍는다.
#   증상: push 가 실패해도(git pre-push 훅 차단·거부·네트워크) 마커가 갱신됐다. 배포는 0건인데
#   소비자 게이트는 "마커보다 신선한 post_deploy 증거"를 요구하므로, 증거를 만들어도 다음 push
#   시도가 다시 마커를 갱신해 영원히 뒤처진다(실측: claude-code-site 에서 정상 통과 불가,
#   증거 mtime 을 손으로 밀어 우회함). dispatcher-terminal-state-invariant "완료 마커는 전건
#   성공에만" 의 배포 판 — 실패한 시도에 남는 마커는 완료 마커가 아니라 묘비다.
#   판정 근거: tool_response 에는 **종료 코드가 없다**(실측 스키마: stdout·stderr·interrupted·
#   isImage·noOutputExpected, grep 무매치 시 returnCodeInterpretation 추가). 래퍼가 성공하면
#   내부 실패와 구분 불가하므로 tool_response 로는 push 실패를 못 본다 → git 상태로 판정한다:
#   **원격 추적 ref 가 HEAD 를 담고 있으면 착지**(push 성공 시 git 이 갱신한다). 판정 불가한
#   형태(명시 refspec·upstream 없음·다른 remote)는 종전대로 마커 생성(보수: 검증 요구 > 누락).
#
# producer 는 항상 exit 0 (비차단). 강제는 소비자 게이트에서. 해제: E2E_GATE=0 (소비자측).
# 마커 파일은 로컬 상태 — .gitignore 에 .deploy-pending-verify 추가 권장.
INPUT=$(cat)
DVM_TMP=$(mktemp 2>/dev/null) || DVM_TMP="${TMPDIR:-/tmp}/dvm.$$"
printf '%s' "$INPUT" > "$DVM_TMP"
trap 'rm -f "$DVM_TMP"' EXIT

CMD=$(DVM_FILE="$DVM_TMP" python3 -c "
import os,json
try: print(json.load(open(os.environ['DVM_FILE'],encoding='utf-8')).get('tool_input',{}).get('command','') or '')
except Exception: print('')
" 2>/dev/null || echo "")
[ -z "$CMD" ] && exit 0

# 🚨 heredoc 본문은 명령이 아니라 **데이터**다 (2026-09-02). 파일을 쓰는 명령의 본문에 "git push"·
#   "vercel --prod" 가 글로 들어 있으면 배포로 오탐했고, 큰 heredoc 은 따옴표 불균형으로 shlex 를
#   ValueError 로 떨어뜨려 판정 불가(=보수적 마커)까지 갔다. 실측: 이 훅 자신을 쓰는 명령이
#   가짜 배포 마커를 만들어 다음 push 에 post_deploy 재검증을 요구했다.
#   → 탐지는 본문을 뺀 사본(CMD_SCAN)으로, 마커 기록은 원본 CMD 로.
CMD_SCAN=$(DVM_FILE="$DVM_TMP" python3 -c "
import os,json,re
try:
    c=json.load(open(os.environ['DVM_FILE'],encoding='utf-8')).get('tool_input',{}).get('command','') or ''
except Exception:
    c=''
# <<EOF / <<'EOF' / <<-EOF 본문 제거 (구분자까지)
c=re.sub(r'<<-?\s*([\'\"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n.*?\n[ \t]*\2[ \t]*(?=\n|\$)', ' ', c, flags=re.S)
print(c)
" 2>/dev/null || echo "$CMD")
[ -z "$CMD_SCAN" ] && CMD_SCAN="$CMD"
# 🚨 대상 저장소는 훅 프로세스의 cwd 가 아니라 **이벤트 cwd** 로 정한다 (Codex HIGH 2026-09-02):
#    훅은 별도 프로세스라 명령이 실행된 디렉토리를 물려받지 않는다. 명령이 'cd X && ...' 로 시작하면
#    그 X 를 기준으로 한다(그 이상의 동적 cd 는 정적으로 못 본다 — 아래 정직 고지).
EVT_CWD=$(DVM_FILE="$DVM_TMP" python3 -c "
import os,json
try: print(json.load(open(os.environ['DVM_FILE'],encoding='utf-8')).get('cwd','') or '')
except Exception: print('')
" 2>/dev/null || echo "")
DVM_CD=$(DVM_CMD="$CMD" python3 -c "
import os,re
c=os.environ.get('DVM_CMD','')
m=re.match(r'\s*cd\s+([^\s;&|]+)', c)
print(m.group(1) if m else '')
" 2>/dev/null || echo "")
DVM_BASE="${EVT_CWD:-$PWD}"
if [ -n "$DVM_CD" ]; then
  case "$DVM_CD" in
    /*) DVM_BASE="$DVM_CD" ;;
    "~"/*) DVM_BASE="$HOME/${DVM_CD#~/}" ;;
    *) DVM_BASE="$DVM_BASE/$DVM_CD" ;;
  esac
fi
PROJECT_ROOT=$(git -C "$DVM_BASE" rev-parse --show-toplevel 2>/dev/null)
[ -z "$PROJECT_ROOT" ] && PROJECT_ROOT=$(git -C "${EVT_CWD:-$PWD}" rev-parse --show-toplevel 2>/dev/null)
# 이벤트 cwd 가 git 밖이어도 명령이 'git -C <경로> push' 면 그 저장소가 대상이다
#    (교차 리뷰 HIGH 2026-09-02 — 미탐 방향)
if [ -z "$PROJECT_ROOT" ]; then
  DVM_GITC=$(DVM_CMD="$CMD" python3 -c "
import os,re
m=re.search(r'(?:^|[\s;&|(])git\s+(?:-c\s+\S+\s+)*-C\s+(\S+)', os.environ.get('DVM_CMD',''))
print(m.group(1).strip('\'\"') if m else '')
" 2>/dev/null || echo "")
  [ -n "$DVM_GITC" ] && PROJECT_ROOT=$(git -C "$DVM_GITC" rev-parse --show-toplevel 2>/dev/null)
fi
[ -z "$PROJECT_ROOT" ] && exit 0

# 🚨 중단(interrupted)은 "배포 안 됐다"가 아니라 "모른다"다 (Codex HIGH 2026-09-02): 원격이 이미
#    받아들인 뒤 중단됐을 수 있다. 건너뛰지 않고 그대로 판정한다 — git push 는 아래 착지 확인이
#    답하고, 명시 배포 CLI 는 보수적으로 마커를 남긴다.

# 🚨 판정은 **세그먼트 단위**다 (Codex HIGH 2026-09-02): 'echo --dry-run; vercel --prod' 처럼
#    전역 문자열 검사로는 다른 세그먼트의 토큰이 진짜 배포를 가린다. ;·&&·||·|·개행으로 잘라
#    각 세그먼트를 따로 본다.
DVM_SEGS=$(DVM_SCAN="$CMD_SCAN" python3 -c "
import os,re
c=os.environ.get('DVM_SCAN','').replace('\n',' ; ')
for seg in re.split(r'\|\||&&|[;|&]', c):
    seg=seg.strip()
    if seg: print(seg.replace(chr(10),' '))
" 2>/dev/null || printf '%s' "$CMD_SCAN")

IS_DEPLOY=0
# 명시적 배포 CLI (프로덕션 표면에 닿는 명령)
# 🚨 단어 경계 필수 (2026-08-06 실측 오탐): `vercel[^|;&]*deploy` 는 echo 데이터 문자열
#   "vercel prod deployments (조회 헤더)" 의 deploy**ments** 에 매치돼 조회(vercel ls)를
#   배포로 오탐 — 가짜 마커가 post_deploy 증거를 오요구해 push 를 차단했다. deploy/--prod 는
#   토큰 끝 경계(공백|행끝)로만 매치한다. npm run deploy 는 deploy:prod 류 변형이 흔해 예외.
#   ⚠️ 잔여 한계: raw grep 이라 "vercel deploy" 를 **데이터로 언급**하는 echo/주석은 여전히
#   오탐한다(git push 분기의 shlex 실호출 판정과 비대칭). 실피해 재발 시 shlex 판정으로 승격.
#   ⚠️ 이 분기는 착지 확인이 불가능하다 — 원격 상태로 검증할 수 있는 것은 git push 뿐이고,
#   CLI 성공 여부는 tool_response 에 종료 코드가 없어 판정 불가. 종전대로 보수적으로 마커.
printf '%s\n' "$DVM_SEGS" | grep -vE '(^|[[:space:]])--dry-run([[:space:]]|=|$)|(^|[[:space:]])--dryRun([[:space:]]|=|$)' \
 | grep -qE 'vercel[^|;&]*(--prod(uction)?|deploy)([[:space:]]|$)|supabase[[:space:]]+functions[[:space:]]+deploy([[:space:]]|$)|firebase[[:space:]]+deploy([[:space:]]|$)|flyctl[[:space:]]+deploy([[:space:]]|$)|fly[[:space:]]+deploy([[:space:]]|$)|gcloud[[:space:]]+(app|run)[[:space:]]+deploy([[:space:]]|$)|az[[:space:]]+(webapp|functionapp)[[:space:]]+(deploy|up)([[:space:]]|$)|npm[[:space:]]+run[[:space:]]+deploy|wrangler[[:space:]]+(deploy|publish)([[:space:]]|$)|netlify[[:space:]]+deploy([[:space:]]|$)' && IS_DEPLOY=1

# push-트리거 배포: Vercel 연결 repo 의 git push 는 배포다 (Vercel 이 push 시 자동 배포)
# 🚨 오탐 방지 (2026-07-24): "git push" 데이터 언급(정규식/문서)에 가짜 마커를 만들면 소비자 게이트가
#   배포후검증을 오요구한다 — shlex 로 실제 호출일 때만 마커. 판정 불가는 마커 생성(보수: 검증 요구 > 누락).
# 🚨 프리필터를 'git push' 리터럴로 두면 'git -C . push' · 'env -i git push' 를 놓친다
#    (Codex HIGH 2026-09-02 — 미탐 방향). git 과 push 가 함께 보이면 파서에 넘긴다.
if [ "$IS_DEPLOY" = 0 ] && echo "$CMD_SCAN" | grep -q 'git' && echo "$CMD_SCAN" | grep -q 'push'; then
  if [ -d "$PROJECT_ROOT/.vercel" ] || [ -f "$PROJECT_ROOT/vercel.json" ]; then
    DVM_NODRY=$(printf '%s\n' "$DVM_SEGS" | grep -vE '(^|[[:space:]])--dry-run([[:space:]]|=|$)|(^|[[:space:]])--dryRun([[:space:]]|=|$)' | tr '\n' ';')
    # dry-run 세그먼트를 걸러 남는 것이 없으면 배포 후보가 아예 없다 — 빈 입력을 '판정 불가'로 읽으면
    # dry-run 이 마커를 만든다(실측 회귀).
    case "$DVM_NODRY" in
      *[!\;[:space:]]*) : ;;
      *) DVM_DETECT="NONE|||" ;;
    esac
    [ -z "${DVM_DETECT:-}" ] && DVM_DETECT=$(GATE_CMD="$DVM_NODRY" python3 - <<'PYDETECT' 2>/dev/null
import os, re, shlex
cmd = os.environ.get('GATE_CMD', '')
if not cmd:
    print("AMBIG|||"); raise SystemExit
# 🚨 명령치환 판정은 "git 이 보이면 무조건 불명"이 아니라 "그 치환 안에 push 가 있는가"로 (2026-09-02).
#   옛 규칙(토큰이 $(git 로 끝나면 AMBIG)은 `X=$(git rev-parse HEAD)` 같은 일상 명령까지 배포로 표시했다 —
#   바깥 가드가 'git push' **문자열**만 보므로 주석·문서에 그 말이 있으면 통과하고, 그다음 $(git 하나로
#   가짜 마커가 생겨 일어나지 않은 배포의 검증을 요구했다(실측: 이 훅을 쓰는 파일 쓰기 명령 자신이 유발).
if re.search(r'\$\(\s*[\w./-]*git\b[^)]*\bpush\b', cmd) or re.search(r'`\s*[\w./-]*git\b[^`]*\bpush\b', cmd):
    print("AMBIG|||"); raise SystemExit
# 🚨 줄바꿈을 그대로 두면 shlex 가 공백으로 먹어 **다음 줄의 진짜 push 를 놓친다**(2026-09-02 실측:
#   'cd repo\ngit push origin main' 미탐 → 배포후검증이 조용히 사라짐 = 위험한 방향).
#   먼저 개행을 ; 로 바꿔 구분자로 살린다. 따옴표 안의 개행은 shlex 가 한 토큰으로 묶으므로 영향 없다.
cmd2 = re.sub(r'(\|\||&&|[;|&()])', r' \1 ', cmd.replace('\n', ' ; '))
try:
    toks = shlex.split(cmd2, posix=True)
except ValueError:
    print("AMBIG|||"); raise SystemExit
SEPS = {';', '&', '|', '&&', '||', '(', ')'}
STARTERS = {'sudo', 'env', 'exec', 'command', 'nohup', 'time'}
cmd_pos = True
i = 0; n = len(toks)
while i < n:
    t = toks[i]
    if t in SEPS:
        cmd_pos = True; i += 1; continue
    if cmd_pos:
        if '=' in t and not t.startswith('='):
            i += 1; continue
        if t in STARTERS:
            # 래퍼의 플래그(및 값)를 건너뛴다 (교차 리뷰 HIGH 2026-09-02):
            #    'env -i git push' · 'sudo -u user git push' 에서 git 이 명령 위치를 잃었다.
            i += 1
            takes_val = {'-u', '-g', '-C', '-S', '--chdir', '--user', '--group'}
            while i < n and toks[i] not in SEPS:
                a = toks[i]
                if a in takes_val:
                    i += 2; continue
                if a.startswith('-') or ('=' in a and not a.startswith('=')):
                    i += 1; continue
                break
            continue
        if t == 'git' or t.endswith('/git'):
            args = []
            j = i + 1
            while j < n and toks[j] not in SEPS:
                a = toks[j]
                if '>' not in a and '<' not in a:
                    args.append(a)
                j += 1
            k = 0
            while k < len(args):
                a = args[k]
                if a in ('-C', '-c', '--git-dir', '--work-tree', '--namespace'):
                    k += 2; continue
                if a.startswith('-'):
                    k += 1; continue
                break
            if k < len(args) and args[k] == 'push':
                # push 뒤의 위치 인자에서 remote 와 refspec 형태를 뽑는다(착지 판정 입력).
                rest = [x for x in args[k + 1:] if not x.startswith('-')]
                remote = rest[0] if rest else ''
                refspecs = rest[1:]
                colon = '1' if any(':' in x for x in refspecs) else '0'
                # --mirror/--all 은 어떤 ref 가 갔는지 upstream 으로 못 본다 → 판정 불가
                if any(x in ('--mirror', '--all', '--delete') for x in args[k + 1:]):
                    colon = '1'
                # 🚨 refspec 이 여럿이면 upstream 하나로 착지를 못 가린다 → 판정 불가 (Codex HIGH 2026-09-02)
                if len(refspecs) > 1:
                    colon = '1'
                ref = refspecs[0] if refspecs else ''
                print("REAL|%s|%s|%s" % (remote, colon, ref)); raise SystemExit
            i = j; cmd_pos = False; continue
        cmd_pos = False; i += 1; continue
    i += 1
print("NONE|||")
PYDETECT
)
    DVM_VERDICT=${DVM_DETECT%%|*}
    DVM_REST=${DVM_DETECT#*|}
    DVM_REMOTE=${DVM_REST%%|*}
    DVM_REST2=${DVM_REST#*|}
    DVM_COLON=${DVM_REST2%%|*}
    DVM_REF=${DVM_REST2#*|}
    [ "${DVM_VERDICT:-AMBIG}" != "NONE" ] && IS_DEPLOY=1

    # 🚨 착지 확인 — 실패한 push 는 배포를 만들지 않는다(순환 결함 수리).
    #   원격 추적 ref 가 HEAD 를 담고 있어야 원격이 코드를 받은 것이다. 판정 불가면 보수적으로 유지.
    if [ "$IS_DEPLOY" = 1 ] && [ "${DVM_VERDICT:-}" = "REAL" ] && [ "${DVM_COLON:-1}" = "0" ]; then
      DVM_UPREF=$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)
      if [ -n "$DVM_UPREF" ]; then
        DVM_UPREMOTE=${DVM_UPREF%%/*}
        # 🚨 현재 브랜치가 아닌 ref 를 밀면(예: 'git push origin release') 원격은 그 ref 를 받았는데
        #    upstream(origin/main)과 HEAD 는 다르다 → 착지 판정이 미탐을 만든다. 현재 브랜치일 때만 적용.
        DVM_CURBR=$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)
        if { [ -z "$DVM_REMOTE" ] || [ "$DVM_REMOTE" = "$DVM_UPREMOTE" ]; } \
           && { [ -z "$DVM_REF" ] || [ "$DVM_REF" = "$DVM_CURBR" ]; }; then
          # upstream==HEAD 는 "원격이 이 커밋을 갖고 있다"까지만 증명한다 (교차 리뷰 HIGH 2026-09-02).
          #    이미 같았는데 push 가 거부된 경우를 성공으로 읽지 않도록, 출력의 명시 실패·무변경
          #    신호를 함께 본다. 종료 코드가 없으므로 휴리스틱이다(정직 고지).
          DVM_OUT=$(DVM_FILE="$DVM_TMP" python3 -c "
import os,json
try:
    tr=json.load(open(os.environ['DVM_FILE'],encoding='utf-8')).get('tool_response') or {}
    print(((tr.get('stdout') or '')+chr(10)+(tr.get('stderr') or ''))[:4000])
except Exception: print('')
" 2>/dev/null || echo "")
          if printf '%s' "$DVM_OUT" | grep -qE 'Everything up-to-date|\[rejected\]|failed to push|pre-push|error: '; then
            IS_DEPLOY=0
            echo "배포 미발생(출력에 거부 또는 무변경 신호) — 마커 생성 안 함" >&2
          fi
          DVM_HEAD=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null)
          DVM_UP=$(git -C "$PROJECT_ROOT" rev-parse "$DVM_UPREF" 2>/dev/null)
          if [ -n "$DVM_HEAD" ] && [ -n "$DVM_UP" ] && [ "$DVM_HEAD" != "$DVM_UP" ]; then
            IS_DEPLOY=0
            echo "📌 배포 미발생(push 미착지: 원격 $DVM_UPREF 이 HEAD 를 아직 안 받음) — 마커 생성 안 함" >&2
          fi
        fi
      fi
    fi
  fi
fi
[ "$IS_DEPLOY" = 0 ] && exit 0

# 마커는 저장소가 제어하는 경로다 (교차 리뷰 CRITICAL 2026-09-02): 리다이렉션으로 쓰면 체크아웃된
#    심링크를 따라가 사용자가 쓸 수 있는 임의 파일을 truncate 한다. 같은 디렉토리 임시 파일에 쓰고
#    os.replace 로 원자 교체한다 — replace 는 링크를 따라가지 않고 그 자리에 일반 파일을 놓는다.
DVM_ROOT="$PROJECT_ROOT" DVM_CMDTXT="$CMD" python3 - <<'PYMARK' 2>/dev/null || true
import os, time, tempfile
root = os.environ['DVM_ROOT']
cmd = (os.environ.get('DVM_CMDTXT') or '')[:200]
body = 'deploy_detected %s\ncmd %s\n' % (time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), cmd)
fd, tmp = tempfile.mkstemp(dir=root, prefix='.deploy-pending-verify.', suffix='.tmp')
try:
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(body)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, os.path.join(root, '.deploy-pending-verify'))
except Exception:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
PYMARK
echo "📌 배포 감지 → .deploy-pending-verify 마커 생성. 배포 URL 대상 smoke+E2E 재검증(post_deploy 증거) 전까지 완료/push가 차단됩니다." >&2
exit 0
