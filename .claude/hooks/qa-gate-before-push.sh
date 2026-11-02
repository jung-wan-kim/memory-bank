#!/bin/bash

# qa-gate-before-push.sh
# PreToolUse Hook (Bash matcher): git push 전 품질 게이트
# 모든 코드 변경 프로젝트에서 QA 증거 요구 (user-proxy 연동)
# 모든 출력을 stderr로 보냄 (Claude Code가 stderr를 요구)
exec 1>&2

INPUT=$(cat /dev/stdin)
CMD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)
CMD_PARSE_RC=$?
# 🚨 Round-12 HIGH: python3 자체가 실패(바이너리 손상/hijack·문법오류 등, rc!=0)하면 기존
#   `|| echo ""` 는 CMD 를 무조건 빈 문자열로 접어 "git push 아님"으로 오판했다 — 아래 전
#   검증기(rc fail-closed 수리 7곳)가 통째로 미실행 통과했다(실측, Round-12 HIGH). 파싱
#   성공(rc=0)이면 기존 의미(빈 커맨드 = CMD="") 그대로 유지 — 새 분기는 파싱 실패에만 적용.
if [ "$CMD_PARSE_RC" -ne 0 ]; then
  CMD=""
  # 순수 셸 폴백: 원본 stdin 에 'git ... push' 형태가 보이면 판정 불가로 fail-closed 차단하고,
  # 안 보이면 무관 명령일 가능성이 높으므로 collateral 을 피해 통과시키되 경고만 남긴다.
  # 🚨 (361차 적대 리뷰 R1 HIGH) `git ... push` 인접 형태만 보면 `g=git; $g push` 같은 런타임 조립이 폴백을 통과했다 —
  #    prefilter 와 같은 술어(git 단어 + push 존재)로 fail-closed. python 부재 환경은 이미 비정상이라 과차단이 옳다.
  #    정직 한계(적대 리뷰 R2): 명령 문자열에 git/push 토큰이 아예 없는 런타임 조립(printf 8진 이스케이프 등)은 어떤 문자열
  #    게이트도 못 본다 — 그 층은 OS 격리·원격 훅의 몫(agent-sandbox-containment). python 부재 시 전 Bash 차단은 복구 경로까지
  #    막으므로 채택하지 않는다(트레이드오프 선언).
  if printf '%s' "$INPUT" | grep -Eq '(^|[^[:alnum:]_-])git([^[:alnum:]_-]|$)' && printf '%s' "$INPUT" | grep -q 'push'; then
    echo "HARD BLOCK: hook 입력 파서(python3) 실행 실패(rc=$CMD_PARSE_RC) — push 판정 불가, fail-closed"
    echo "  복구: python3 를 복구한 뒤 재시도(우회 옵션 없음 — push 판정을 건너뛸 수 없습니다)"
    exit 2
  fi
  echo "⚠️  hook 입력 파서(python3) 실행 실패(rc=$CMD_PARSE_RC) — push 여부 불명. git push 흔적이 보이지 않아 통과합니다" >&2
  exit 0
fi

# git push 명령이 아니면 통과 (1차 cheap prefilter)
# 🚨 `git push` 리터럴만 보면 `git -C <dir> push`·`git --git-dir=... push` 를 놓쳐 게이트가
#    통째로 skip 된다(Codex HIGH). git 과 push 가 함께 있으면 정밀 파서로 넘긴다.
#
# 🚨 잔여 한계 (정직 고지 — 닫히지 않는다):
#   토큰이 **런타임에 조립되면** 이 파서는 볼 수 없다: `g=git; $g push`, `eval "git push"`,
#   base64 디코드 파이프, 다른 언어 wrapper(python subprocess) 등. 전부 실측으로 통과 확인.
#   정규식/셸 파서로는 원리상 차단 불가이며(agent-browser-security.md 와 같은 결함 클래스),
#   무한히 패턴을 늘려도 새 우회가 나온다. 이 게이트가 막는 대상은 **우발적 skip 과 흔한 형태**이고,
#   의도적 우회를 막는 층은 여기가 아니라 push 수령 측(원격 훅/CI)이다.
# 🚨 (2026-09-21 361차) `git` 뒤를 공백/EOL 로만 보면 `g=git; $g push` 의 `git;` 이 prefilter 에서 탈락해
#    python 파서(런타임 조립 → AMBIG fail-closed)에 도달조차 못 했다 — 단어 경계(비-[alnum_-])로 넓힌다.
if ! echo "$CMD" | grep -qE '(^|[^[:alnum:]_-])git([^[:alnum:]_-]|$)' || ! echo "$CMD" | grep -q "push"; then
  echo "" >&2
  exit 0
fi

# 🚨 오탐 수정 (2026-07-24): "git push"/"--all" 이 명령이 아니라 **따옴표 안 데이터**(정규식 리터럴·
#   heredoc 문서·grep 패턴)로만 등장해도 게이트가 실제 push 로 오인해 차단했다(실측 2회).
#   shlex 로 실제 호출을 판별: 없으면(NONE) 통과, 실제 호출이면 그 호출의 인자만(ARGS:) 이후 파싱에
#   사용(데이터 속 --all/--force 오염 동시 해소), 파싱 불가·명령치환($(git push))은 AMBIG → 기존
#   텍스트 휴리스틱으로 보수 진행(over-detect 유지 = 안전).
# 회귀 셀프테스트 정본: ~/.claude/scripts/push-detector-bypass-selftest.sh (블록 픽스처 46 + e2e 16×2템플릿 = 78 ·
#   install-project-hooks.sh 가 설치 전 --no-e2e 로 호출해 우회 잔존 시 설치를 거부한다 — 2026-09-21 361차 EXEC).
PUSH_DETECT=$(GATE_CMD="$CMD" python3 - <<'PYDETECT' 2>/dev/null
import os, re, shlex
cmd = os.environ.get('GATE_CMD', '')
if not cmd:
    print("AMBIG"); raise SystemExit          # env 전달 실패(초대형 명령 등) → 보수적
# 🚨 heredoc 본문은 **데이터**다 — shlex 는 heredoc 을 모르므로 본문의 'git push' 가
#   명령 위치의 토큰으로 보여 오탐한다(실측: 문서/테스트 페이로드를 담은 명령이 차단됨).
#   본문을 먼저 제거한다. 본문 안의 진짜 실행은 없다(그 텍스트는 stdin 으로 전달될 뿐).
def _strip_heredocs(text):
    lines = text.split('\n'); out = []; i = 0
    while i < len(lines):
        line = lines[i]; out.append(line)
        # 🚨 정규식에 '<' 두 개를 연달아 쓰지 않는다 — 이 파이썬은 $( ... ) 안의 heredoc 본문이라
        #    sh(bash 3.2 POSIX 모드)가 재파싱하면서 그 두 글자를 heredoc 연산자로 오인해
        #    스크립트 전체가 문법오류로 죽는다(실측: sh -n 실패, 러너에서 게이트 무력화).
        # 🚨 이 파이썬은 $( ... ) 안 heredoc 본문이다. sh(bash 3.2 POSIX)가 그 안을 재파싱하면서
        #    따옴표 짝을 세므로, 정규식에 홑/겹따옴표 **리터럴**을 쓰면 짝이 어긋나 스크립트 전체가
        #    문법오류로 죽는다(실측: sh -n 실패 → 러너에서 게이트 무력화). \x22/\x27 로 표기한다.
        tags = re.findall(r'[<][<]-?\s*([\x22\x27]?)([A-Za-z_][A-Za-z0-9_]*)\1', line)
        i += 1
        for _q, tag in tags:
            while i < len(lines) and lines[i].strip() != tag:
                i += 1
            if i < len(lines):
                i += 1        # 종료 태그 줄도 소비
    return '\n'.join(out)

cmd = _strip_heredocs(cmd)
SEPS = {';', '&', '|', '&&', '||', '(', ')'}
# 🚨 셸 키워드/그룹핑 뒤에도 **명령 위치**가 이어진다. 이걸 빼먹으면
#    `{ git push; }` · `if true; then git push; fi` · `! git push` · `while ...; do git push; done`
#    이 전부 탐지를 빠져나갔다(실측 exit 0 — 적대 리뷰 HIGH).
KEYWORDS = {'{', '}', '!', 'then', 'else', 'elif', 'fi', 'do', 'done', 'in',
            'if', 'while', 'until', 'for', 'case', 'esac', 'function'}
STARTERS = {'sudo', 'env', 'exec', 'command', 'nohup', 'time', 'xargs', 'stdbuf', 'nice', 'ionice',
            'find', 'timeout', 'caffeinate', 'flock'}
# 🚨 (2026-09-21 361차, 적대 리뷰 R1/R2 CRITICAL) 셸 래퍼 `sh -c "git push"` 는 script 문자열이 한 토큰이라
#    명령 위치에 git 이 없고 NONE 으로 통과했다. -c 의 script 를 **재귀 스캔**한다(같은 cd 기준 상속).
SHELLS = {'sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash'}
# 🚨 런타임 조립(`g=git; $g push`·`eval "git push"`·alias·source)은 이 파서가 원리적으로 볼 수 없다.
#    렉싱 불가는 통과가 아니라 차단이다(claude-code-hook-stdin-contract 규칙 1) — AMBIG 로 낸다.
#    prefilter(git 단어 + push)를 이미 통과한 명령에만 닿으므로 과탐 범위는 좁다.
DYNAMIC = {'eval', 'alias', 'source', '.'}
# 다른 언어 인터프리터의 인라인 스크립트(`python3 -c "subprocess.run(['git','push'])"`)는 셸이 아니라 재귀 스캔 불가 —
# 문자열이 git 과 push 를 함께 품으면 AMBIG. 파일 실행(`python3 x.py`)은 볼 수 없다(정직 한계 — 상단 고지와 동일).
INTERP = {'python', 'python3', 'python2', 'node', 'nodejs', 'perl', 'ruby', 'php', 'deno', 'bun', 'lua', 'osascript'}
def _is_interp(tok):
    return tok in INTERP or tok.rsplit('/', 1)[-1] in INTERP
class _Ambig(Exception):
    pass
def _is_git(tok):
    return tok == 'git' or tok.endswith('/git')
def _is_shell(tok):
    return tok in SHELLS or tok.rsplit('/', 1)[-1] in SHELLS
def _scan(text, cd_hint, cd_ambig, depth):
    if depth > 4:
        raise _Ambig()                          # 래퍼 중첩 과다 — 판정 불가
    # 셸 연산자를 공백 패딩 후 shlex — 따옴표 안 연산자는 여전히 한 토큰(데이터)으로 남는다
    cmd2 = re.sub(r'(\|\||&&|[;|&()\n])', r' \1 ', text)
    try:
        toks = shlex.split(cmd2, posix=True)
    except ValueError:
        raise _Ambig()                          # 따옴표 불균형 등 → 보수적
    # 🚨 (361차 적대 리뷰 R1 CRITICAL) 따옴표 안 명령치환 `echo "$(git push)"`·백틱은 shlex 가 한 토큰으로 접어
    #    명령 위치에 git 이 없다 — 어느 위치든 그런 토큰이 git 을 품으면 렉싱 불가 = AMBIG(fail-closed).
    #    (인용 없는 `$(git push)`·`<(git push)` 는 괄호 패딩으로 명령 위치에 놓여 아래 일반 경로가 잡는다.)
    #    ※ 괄호 패딩이 따옴표 안에도 공백을 넣으므로 토큰은 `$ ( git push ) ` 형태 — `$` 와 `(` 사이 공백 허용.
    for tok in toks:
        if re.search(r'[$]\s*[(]|`', tok) and 'git' in tok:
            raise _Ambig()
    pushes = []
    cmd_pos = True
    paren_stack = []
    i = 0; n = len(toks)
    while i < n:
        t = toks[i]
        if t in SEPS:
            # 🚨 서브셸 `( ... )` 안의 cd 는 밖으로 새지 않는다(실측: `(cd /other; :); git push` 가
            #    이 repo push 를 /other 로 오분류해 통과했다 — Codex HIGH). 괄호에서 상태를 저장/복원한다.
            if t == '(':
                paren_stack.append((cd_hint, cd_ambig))
            elif t == ')':
                if paren_stack:
                    cd_hint, cd_ambig = paren_stack.pop()
            cmd_pos = True; i += 1; continue
        if cmd_pos:
            if t in KEYWORDS:
                i += 1; continue                   # 키워드 뒤에도 명령 위치 유지
            # 선행 리다이렉션(`> /tmp/out git push`)도 명령 위치를 유지시킨다
            if re.match(r'^[0-9]*(>>|>|<<<|<<|<)', t):
                if t.rstrip('0123456789<>&') == '' and i + 1 < n and toks[i+1] not in SEPS:
                    i += 2; continue               # 연산자와 대상이 분리된 형태
                i += 1; continue
            if t.endswith('$(git') or t.endswith('`git'):
                raise _Ambig()                     # 명령치환 내 git — 인자 경계 불명 → 보수적
            if '=' in t and not t.startswith('='):
                i += 1; continue                   # VAR=x 접두 — 여전히 명령 위치
            if t.startswith('$') or t.startswith('`') or t in DYNAMIC:
                raise _Ambig()                     # 변수 명령/eval/alias/source — 런타임 조립(fail-closed)
            if _is_interp(t):
                j = i + 1
                while j < n and toks[j] not in SEPS:
                    a = toks[j]
                    if a in ('-c', '-e', '-E', '--eval', '-r') and j + 1 < n and toks[j+1] not in SEPS:
                        s2 = toks[j+1]
                        if 'git' in s2 and 'push' in s2:
                            raise _Ambig()
                    j += 1
                i = j; cmd_pos = False; continue
            if _is_shell(t):
                # `sh [-opts] -c <script> [args]` — script 만 재귀. -c 없는 `bash file.sh` 는 볼 수 없다(정직 한계).
                j = i + 1; script = None
                while j < n and toks[j] not in SEPS:
                    a = toks[j]
                    if a == '--':
                        j += 1; continue
                    if a.startswith('-') and not a.startswith('--') and 'c' in a[1:]:
                        if j + 1 < n and toks[j+1] not in SEPS:
                            script = toks[j+1]
                        break
                    if a.startswith('-'):
                        j += 1; continue
                    break                          # 첫 비옵션 = 스크립트 파일 — 내용 불가시
                if script is not None:
                    pushes.extend(_scan(script, cd_hint, cd_ambig, depth + 1))
                while j < n and toks[j] not in SEPS:
                    j += 1
                i = j; cmd_pos = False; continue
            if t == 'cd':
                # `cd /other; git push` — 세미콜론 형태는 기존 정규식이 못 잡아 엉뚱한 repo 를
                # 검사했다(Codex HIGH, 실측). 셸처럼 이후 명령의 기준 디렉토리로 기억한다.
                # 🚨 cd 는 **누적**된다: `cd /repo; cd sub` → /repo/sub. last-wins 는 오인(Codex HIGH).
                if i + 1 < n and toks[i+1] not in SEPS:
                    _v = toks[i+1]
                    if _v == '-' or _v.startswith('$') or _v.startswith('`'):
                        cd_ambig = True; cd_hint = ''
                    elif os.path.isabs(_v):
                        cd_hint = _v; cd_ambig = False
                    else:
                        cd_hint = os.path.normpath(os.path.join(cd_hint, _v)) if cd_hint else _v
                else:
                    cd_ambig = True; cd_hint = ''     # 인자 없는 cd → $HOME (기준 불명 취급)
                i += 1; cmd_pos = False; continue
            if t in STARTERS:
                # 🚨 래퍼는 자체 옵션·인자를 갖는다(`sudo -u nobody git push`, `time -p git push`,
                #    `env -i PATH=... git push`). 단순히 한 토큰만 건너뛰면 그 다음이 git 이 아니라
                #    옵션이라 명령 위치를 잃고 게이트가 통째로 skip 됐다(Codex HIGH, 실측 3케이스).
                #    세퍼레이터 전까지 git 토큰을 찾아 그 위치로 점프한다(보수적 over-detect).
                j = i + 1
                found = -1
                while j < n and toks[j] not in SEPS:
                    # 🚨 (361차) 점프 대상을 git 만이 아니라 셸/동적 토큰까지 — `xargs sh -c "git push"`·
                    #    `find . -exec git push ;`·`sudo sh -c ...` 가 전부 이 경로다. (`.` 은 경로 인자와 구분 불가라 점프 대상에서 제외)
                    tj = toks[j]
                    if _is_git(tj) or _is_shell(tj) or tj in ('eval', 'alias', 'source') or tj.startswith('$'):
                        found = j; break
                    j += 1
                if found >= 0:
                    i = found; continue        # cmd_pos 는 True 유지 → 아래 git/셸/동적 분기로
                i = j; cmd_pos = False; continue   # 점프 대상 없음 — 나머지는 래퍼 자신의 인자(명령 위치 아님)
            if _is_git(t):
                args = []
                j = i + 1
                while j < n and toks[j] not in SEPS:
                    a = toks[j]
                    if '>' not in a and '<' not in a:   # 리다이렉션 토큰 제외 (2>&1 등)
                        args.append(a)
                    j += 1
                k = 0
                cdir = cd_hint          # `cd X` 로 옮긴 위치가 기본 기준
                gitdir = ''
                def _join(base, val):
                    # git 의 -C 는 **누적**된다: 두 번째 -C 는 첫 번째 기준의 상대경로다
                    # (`git -C /other -C sub push` → /other/sub). last-wins 로 처리하면 오인한다.
                    if not val:
                        return base
                    if os.path.isabs(val):
                        return val
                    return os.path.normpath(os.path.join(base, val)) if base else val
                while k < len(args):
                    a = args[k]
                    if a == '-C':
                        if k + 1 < len(args):
                            cdir = _join(cdir, args[k + 1])
                        k += 2; continue
                    if a.startswith('-C') and len(a) > 2:
                        cdir = _join(cdir, a[2:]); k += 1; continue   # 붙여쓴 -C<dir> (Codex MEDIUM)
                    if a == '--git-dir':
                        if k + 1 < len(args):
                            gitdir = args[k + 1]
                        k += 2; continue
                    if a.startswith('--git-dir='):
                        gitdir = a.split('=', 1)[1]; k += 1; continue
                    # 🚨 (2026-09-21 361차, 적대 리뷰 R2 HIGH) --work-tree 는 **작업트리** 지정이지 저장소 위치가 아니다.
                    #    실측: cwd=A 에서 `git --work-tree=B push` 의 git-dir 는 A/.git (push 되는 repo 는 A).
                    #    이를 cdir 로 취급하면 B(타 repo)를 평가해 "전부 타 repo" 로 exit 0 — 게이트 우회.
                    #    값을 소비만 하고 기준 디렉토리는 바꾸지 않는다(저장소 발견은 cwd/-C/--git-dir 로만).
                    if a == '--work-tree':
                        k += 2; continue
                    if a.startswith('--work-tree='):
                        k += 1; continue
                    if a in ('-c', '--namespace'):
                        # 🚨 (361차 적대 리뷰 R1 CRITICAL) `git -c alias.x='!git push' x` — 인라인 alias 가 곧 push 다.
                        if a == '-c' and k + 1 < len(args) and args[k + 1].startswith('alias.'):
                            raise _Ambig()
                        k += 2; continue
                    if a.startswith('-c') and a[2:].startswith('alias.'):
                        raise _Ambig()                     # 붙여쓴 -calias.x=...
                    if a.startswith('-'):
                        k += 1; continue
                    break
                # `git config alias.p push; git p` — 같은 명령 안에서 alias 를 정의하고 쓰면 두 번째 git 은 볼 수 없다.
                if k < len(args) and args[k] == 'config' and any(x.startswith('alias.') for x in args) and 'push' in args:
                    raise _Ambig()
                if k < len(args) and args[k] == 'push':
                    # 🚨 대상 디렉토리를 **이 파서에서** 함께 낸다. 별도 정규식으로 뽑던 기존 방식은
                    #    `git -c x=y -C /other push` 에서 값을 못 뽑아 **엉뚱한 repo 의 증거를 검사**했다
                    #    (Codex HIGH, 실측: 다른 repo push 인데 claude-code-site 증거로 차단).
                    # 🚨 첫 push 에서 멈추면 `git -C /other push && git push` 의 2차(이 repo) push 가
                    #    무검사로 통과했다(Codex CRITICAL, 실측 exit 0). **모든 push 를 열거**한다.
                    if gitdir and not os.path.isabs(gitdir):
                        gitdir = _join(cdir, gitdir)          # 상대 --git-dir 는 cd/-C 기준(Codex HIGH)
                    if cd_ambig and not cdir and not gitdir:
                        cdir = '\x01AMBIG'                    # 기준 불명 → bash 가 보수적으로 처리
                    pushes.append('PUSH\x1f%s\x1f%s\x1f%s' % (cdir, gitdir, ' '.join(args[k+1:])))
                i = j; cmd_pos = False; continue
            cmd_pos = False; i += 1; continue
        i += 1
    return pushes
try:
    _pushes = _scan(cmd, '', False, 0)
except _Ambig:
    print("AMBIG"); raise SystemExit
print('\n'.join(_pushes) if _pushes else "NONE")
PYDETECT
)
[ -z "$PUSH_DETECT" ] && PUSH_DETECT="AMBIG"   # python 미가용/실패 → 보수적(over-detect)
PUSH_MODE=ambig; PUSH_REAL_ARGS=""
if printf '%s' "$PUSH_DETECT" | grep -q '^NONE$'; then
  exit 0   # 실제 git push 호출 없음 — 데이터/문자열 내 언급뿐 (오탐 케이스)
fi
# 2026-10-17 B-2 조건 1: 래퍼가 판정 기준 저장소를 정하지 못한 작업 폴더(프로젝트 루트 밖 + settings.json·git 최상위 없음)에서의
# push 는 어느 증거로도 판정할 수 없다 — 시작 루트의 증거로 다른 저장소의 push 를 통과시키지 않게 fail-loud.
if [ "${HOOK_RUN_ROOT_UNRESOLVED:-0}" = "1" ]; then
  echo "❌ qa-gate-before-push: 작업 폴더($PWD)가 프로젝트 루트 밖이고 판정 기준 저장소를 찾지 못했습니다 — push 를 막습니다." >&2
  echo "   해소: push 할 저장소 루트(.claude/settings.json 또는 git 최상위가 있는 폴더)로 이동하거나 git -C <저장소> 로 push 하세요." >&2
  exit 2
fi

# 🚨 push 대상 repo 를 평가한다 (2026-07-26 → 07-27 전체 열거로 강화)
#   기존 결함 2가지(둘 다 실측 재현):
#   (1) 훅 cwd 기준으로만 PROJECT_ROOT 를 잡아 `cd <other> && git push` 시 *push 하지도 않는*
#       프로젝트의 QA 증거를 검사 → EXEMPT 무력화·거짓 차단
#   (2) **첫 push 에서 멈춰** `git -C /other push && git push` 의 2차(이 repo) push 가 무검사 통과
#   → 파서가 낸 **모든 push** 를 순회해, 하나라도 이 repo 를 향하면 이 repo 를 평가한다.
HOOK_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
AMBIG_MARK=$(printf '\001AMBIG')

# --git-dir 로부터 워크트리를 유도한다.
#   🚨 `git --git-dir=X rev-parse --show-toplevel` 은 X 가 아니라 **cwd** 를 워크트리로 보고
#   현재 repo 경로를 돌려준다(실측) — 그대로 쓰면 남의 repo push 를 이 repo 로 오평가한다.
_wt_from_gitdir() {
  local gd="$1" wt=""
  [ -d "$gd" ] || return 1
  gd=$(cd "$gd" 2>/dev/null && pwd -P) || return 1
  wt=$(git --git-dir="$gd" config --get core.worktree 2>/dev/null)
  if [ -n "$wt" ]; then
    case "$wt" in /*) : ;; *) wt="$gd/$wt" ;; esac
  elif [ "$(basename "$gd")" = ".git" ]; then
    wt=$(dirname "$gd")
  else
    return 2      # bare repo — 워크트리 없음(이 repo 아님이 확실)
  fi
  [ -d "$wt" ] || return 2
  printf '%s' "$wt"
}

PROJECT_ROOT=""; _matched=0; _saw_push=0
# 🚨 구분자는 탭이 아니라 US(\037) — 탭은 IFS **공백류**라 연속 탭이 하나로 축약돼
#    빈 필드가 사라진다(실측: `git --git-dir=.git push` 에서 dir/gitdir 가 밀려 오판).
#    🚨 $'\037'(ANSI-C 인용)은 bash 전용이다 — 이 훅이 sh 로 실행되면 따옴표가 안 닫혀
#    파일 끝까지 삼키고 문법오류로 죽는다(실측: 러너가 sh 로 띄워 게이트가 통째로 무력화됐다).
US_SEP=$(printf '\037')
while IFS="$US_SEP" read -r _tag _d _g _a; do
  [ "$_tag" = "PUSH" ] || continue
  _saw_push=1; PUSH_MODE=real
  # 명령에서 온 값에 eval/명령치환 금지 — 필요한 건 물결 확장뿐이라 문자열 치환만.
  case "$_d" in "~") _d="$HOME";; "~/"*) _d="$HOME/${_d#\~/}";; esac
  case "$_g" in "~") _g="$HOME";; "~/"*) _g="$HOME/${_g#\~/}";; esac
  _cand=""
  if [ "$_d" = "$AMBIG_MARK" ]; then
    _cand="$HOOK_ROOT"                       # cd - / 변수 cd → 기준 불명 → 보수적으로 이 repo
  elif [ -n "$_g" ]; then
    if _cand=$(_wt_from_gitdir "$_g"); then :; else
      [ $? -eq 2 ] && _cand="__OTHER__" || _cand="$HOOK_ROOT"   # bare=타 repo / 부재=보수적
    fi
  elif [ -n "$_d" ]; then
    if [ -d "$_d" ]; then
      _cand=$(git -C "$_d" rev-parse --show-toplevel 2>/dev/null)
      [ -n "$_cand" ] || _cand="__OTHER__"   # git repo 아님 → 이 repo 대상 아님
    else
      _cand="$HOOK_ROOT"                     # 존재하지 않는 경로 → 보수적
    fi
  else
    _cand="$HOOK_ROOT"                       # 디렉토리 지정 없음 → 훅 cwd 의 repo
  fi
  if [ -n "$HOOK_ROOT" ] && [ "$_cand" = "$HOOK_ROOT" ]; then
    PROJECT_ROOT="$HOOK_ROOT"; PUSH_REAL_ARGS="$_a"; _matched=1; break
  fi
done <<EOF
$PUSH_DETECT
EOF

if [ "$_saw_push" = 1 ] && [ "$_matched" = 0 ]; then
  exit 0   # 열거된 push 가 전부 다른 repo 대상 — 이 repo 를 대신 평가하지 않는다
fi
[ -n "$PROJECT_ROOT" ] || PROJECT_ROOT="$HOOK_ROOT"
[ -z "$PROJECT_ROOT" ] && exit 0

# QA gate 예외 프로젝트 (설정/메타 동기화 등 코드 프로젝트 아님)
QA_GATE_EXEMPT_PROJECTS=(
  "$HOME/Project/Claude/cc-sync"
)
for exempt in "${QA_GATE_EXEMPT_PROJECTS[@]}"; do
  if [ "$PROJECT_ROOT" = "$exempt" ]; then
    exit 0
  fi
done

EVIDENCE="$PROJECT_ROOT/.qa-cycle-passed"
BROWSER_EVIDENCE="$PROJECT_ROOT/.qa-evidence.json"

# === ACCEPTANCE GATE (anti-Goodhart, Fix2 HARD) — 전 스택 공통, 최상단 무조건 실행 ===
# 기존엔 ui-qa 카테고리에만 있어 백엔드/CLI/데이터 프로젝트에 anti-Goodhart 게이트가 전무했다(F3).
# universal 로 승격해 모든 스택 커버: .qa-evidence.json 존재(=PASS 주장) 시 acceptance_verified 를 HARD 검증,
# UI 변경이면 존재+PASS 강제. fail-open: 파일 누락(비-UI)·non-PASS(WIP).
# fail-closed(차단): verdict=PASS+acceptance 누락/무효(anti-Goodhart), malformed(파싱 불가), head 미결속.
#   신선도(1h)는 **UI 만**(재렌더 staleness). 비-UI PASS 재사용은 head-binding(현재 HEAD 결속)이 차단. 해제: ACCEPTANCE_GATE=0
ACC_UI_EXT='tsx|jsx|css|scss|sass|less|vue|svelte|html'
ACC_UI_CONF='(tailwind|postcss|vite|next|nuxt|svelte)\.config\.'
# UI 감지: 단일 HEAD~1 이 아니라 **실제 push 될 refspec 범위**를 스캔(ui-qa RANGE_FILES 이식) → 멀티커밋 UI /
#   no-upstream 신규 브랜치 / `git push origin HEAD:other` refspec 목적지 어긋남을 모두 커버(Codex 7R).
# 실제 push 대상 ref 추정: 'git push [flags] [remote] [refspec]'의 src. 미지정 시 HEAD.
#   값받는 플래그(-o/--push-option/--repo/--receive-pack/--exec)의 값토큰은 건너뛰어 remote 오인 방지.
#   --all/--mirror/--tags(+ refspec 없는 push)·다중 refspec·push.default=matching → 모호 → 보수적 over-detect.
ACC_TIP=HEAD; ACC_AMBIG=0
if [ "$PUSH_MODE" = "real" ]; then
  # 실제 호출 인자만 검사 — 명령 내 데이터 문자열(--all 인용 등) 오염 차단 (2026-07-24)
  case " $PUSH_REAL_ARGS " in *" --all "*|*" --mirror "*|*" --tags "*) ACC_AMBIG=1;; esac
else
  case " $CMD " in *" --all "*|*" --mirror "*|*" --tags "*) ACC_AMBIG=1;; esac
fi
if [ "$PUSH_MODE" = "real" ]; then
  _apargs="$PUSH_REAL_ARGS"
else
  _apargs=$(printf '%s' "$CMD" | sed -E 's/.*git[[:space:]]+push//')
fi
_aptoks=(); _askipval=0
for _t in $_apargs; do
  if [ "$_askipval" = 1 ]; then _askipval=0; continue; fi
  case "$_t" in
    -o|--push-option|--repo|--receive-pack|--exec) _askipval=1; continue;;
    -*) continue;;
    *) _aptoks+=("$_t");;
  esac
done
_arefs=(); _ai=0; ACC_DST=""
if [ "$ACC_AMBIG" = 0 ]; then
  for _t in "${_aptoks[@]}"; do _ai=$((_ai+1)); [ "$_ai" -eq 1 ] && continue; _arefs+=("$_t"); done
fi
if [ "$ACC_AMBIG" = 0 ] && [ "${#_arefs[@]}" -eq 0 ]; then
  [ "$(git config push.default 2>/dev/null)" = "matching" ] && ACC_AMBIG=1
fi
if [ "$ACC_AMBIG" = 0 ] && [ "${#_arefs[@]}" -eq 1 ]; then
  _aspec="${_arefs[0]#+}"; _asrc="${_aspec%%:*}"
  if [ "$_aspec" = "$_asrc" ]; then ACC_DST="$_asrc"; else ACC_DST="${_aspec#*:}"; fi
  ACC_DST="${ACC_DST#refs/heads/}"
  if [ "$ACC_DST" = "HEAD" ]; then _acb=$(git symbolic-ref --short HEAD 2>/dev/null); [ -n "$_acb" ] && ACC_DST="$_acb"; fi
  if [ -z "$_asrc" ] || ! git rev-parse --verify -q "$_asrc" >/dev/null 2>&1; then ACC_AMBIG=1; else ACC_TIP="$_asrc"; fi
fi
if [ "$ACC_AMBIG" = 1 ] || [ "${#_arefs[@]}" -ge 2 ]; then
  ACC_RANGE_FILES=$( { git log --name-only --pretty=format: --branches --not --remotes 2>/dev/null; git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null; } | sort -u)
else
  ACC_BASE=""
  [ -n "$ACC_DST" ] && git rev-parse --verify -q "origin/$ACC_DST" >/dev/null 2>&1 && ACC_BASE="origin/$ACC_DST"
  [ -z "$ACC_BASE" ] && ACC_BASE=$(git rev-parse --abbrev-ref --symbolic-full-name "${ACC_TIP}@{u}" 2>/dev/null || true)
  if [ -z "$ACC_BASE" ]; then
    if git rev-parse --verify -q "origin/$ACC_TIP" >/dev/null 2>&1; then ACC_BASE="origin/$ACC_TIP"
    else
      for _ab in origin/HEAD origin/master origin/main; do
        git rev-parse --verify -q "$_ab" >/dev/null 2>&1 && { ACC_BASE=$(git merge-base "$_ab" "$ACC_TIP" 2>/dev/null || true); [ -n "$ACC_BASE" ] && break; }
      done
    fi
  fi
  if [ -n "$ACC_BASE" ]; then
    ACC_RANGE_FILES=$( { git diff --name-only "${ACC_BASE}..${ACC_TIP}" 2>/dev/null; git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null; } | sort -u)
  else
    # 원격 ref 전무(신규 브랜치, no upstream) → tip 의 **전체 히스토리** 스캔(over-detect = 안전, HEAD~1 로 축소 안 함)
    ACC_RANGE_FILES=$( { git log --name-only --pretty=format: "$ACC_TIP" 2>/dev/null; git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null; } | sort -u)
  fi
fi
# 🚨 push 범위의 쉘 스크립트에 박힌 python 블록이 **쉘 인용 규칙대로 잘렸는지** 검사한다.
#   실측(2026-07-27): 이 게이트 자신의 증거검사 python 이 주석 속 큰따옴표 하나로 끊겨
#   SyntaxError 로 죽었고, stderr 가 버려져 몇 커밋 동안 검사가 통째로 멈춘 채 지나갔다.
#   .githooks/pre-commit 에도 같은 검사가 있으나 core.hooksPath 설정에 따라 안 돌 수 있으므로
#   **항상 도는 이 게이트에서도** 확인한다. 해제: EMBEDDED_PY_GATE=0
if [ "${EMBEDDED_PY_GATE:-1}" != "0" ] && [ -f "$PROJECT_ROOT/scripts/check-embedded-python.py" ]; then
  _emb_list=$(printf '%s\n' "$ACC_RANGE_FILES" | { grep -E '\.sh$' || [ $? -eq 1 ]; })
  if [ -n "$_emb_list" ]; then
    _emb_bad=""
    while IFS= read -r _f; do
      [ -n "$_f" ] || continue
      [ -f "$PROJECT_ROOT/$_f" ] || continue        # 삭제된 파일은 건너뛴다
      python3 "$PROJECT_ROOT/scripts/check-embedded-python.py" "$PROJECT_ROOT/$_f" >/dev/null 2>&1 \
        || _emb_bad="$_emb_bad $_f"
    done <<EOF
$_emb_list
EOF
    if [ -n "$_emb_bad" ]; then
      echo "HARD BLOCK: 쉘 스크립트의 임베디드 python 이 끊겼습니다 (조용히 죽는 결함)" >&2
      echo "  대상:$_emb_bad" >&2
      echo "  상세: python3 scripts/check-embedded-python.py <파일>   해제: EMBEDDED_PY_GATE=0" >&2
      exit 2
    fi
  fi
fi

ACC_UI_CHANGED=$(printf '%s\n' "$ACC_RANGE_FILES" | grep -cE "\.(${ACC_UI_EXT})$|${ACC_UI_CONF}" || true)
# 🚨 auto-issue 경유 게이트 진입 (Codex HIGH, Fix2 Round2 A): 기존 조건(UI 변경 OR evidence 파일
#   존재)만으로는 비-UI 변경 + .qa-evidence.json 부재 조합에서 이 블록 전체가 skip 되었다 —
#   auto-issue 저장소(.claude/auto-issue/issue-*/)는 완료조건 승계 계약이 있어 UI 여부·evidence
#   존재 여부와 무관하게 QA 증거가 필수다.
ACC_AUTO_ISSUE=0
if ls "$PROJECT_ROOT"/.claude/auto-issue/issue-*/acceptance-contract.md >/dev/null 2>&1 \
   || ls -d "$PROJECT_ROOT"/.claude/auto-issue/issue-*/ >/dev/null 2>&1; then
  ACC_AUTO_ISSUE=1
fi
if [ "${ACCEPTANCE_GATE:-1}" != "0" ] && { [ "${ACC_UI_CHANGED:-0}" -gt 0 ] || [ -f "$BROWSER_EVIDENCE" ] || [ "${ACC_AUTO_ISSUE:-0}" -eq 1 ]; }; then
  ACC_HEAD=$(git rev-parse HEAD 2>/dev/null)   # full 40자 — evidence head 가 short(7+)든 full 이든 접두 매칭 가능(Codex: short cur 는 full head 접두 불가 버그)
  REQUIRE_EVIDENCE=0; [ "${ACC_UI_CHANGED:-0}" -gt 0 ] && REQUIRE_EVIDENCE=1
  ACC_FAIL=$(QA_EVIDENCE="$BROWSER_EVIDENCE" ACC_HEAD="$ACC_HEAD" REQUIRE_EVIDENCE="$REQUIRE_EVIDENCE" ACC_AUTO_ISSUE="$ACC_AUTO_ISSUE" ACC_PLAN="$PROJECT_ROOT/docs/qa-test-plan.md" ACC_ROOT="$PROJECT_ROOT" python3 - <<'PYACC' 2>&1
import json, os, stat, sys, time

def _open_regular(path, max_bytes=4 * 1024 * 1024, errors='strict'):
    # TOCTOU 방지(Codex HIGH, 2026-09-02 라운드4) — 아래 Round-3 방어(lstat 후 open())는 검사와
    # open() 사이에 파일이 FIFO/심링크로 교체될 수 있는 창을 남긴다. 정규 파일 검증과 open 을
    # 같은 fd 로 원자화해 그 창을 없앤다. O_NONBLOCK 은 writer 없는 FIFO 를 열 때 영구 블록을
    # 막고(POSIX: read-only O_NONBLOCK open 은 즉시 반환), O_NOFOLLOW 는 마지막 경로 성분이
    # 심링크면 open() 자체를 ELOOP 로 거부한다(atomic-artifact-publish 항목11 — 읽는 쪽도
    # 가드 대상).
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > max_bytes:
            raise ValueError('not a regular file or too large (%d bytes)' % st.st_size)
        return os.fdopen(fd, 'r', encoding='utf-8', errors=errors)
    except Exception:
        os.close(fd)
        raise

p = os.environ.get('QA_EVIDENCE', '')
req = os.environ.get('REQUIRE_EVIDENCE', '0') == '1'   # req=UI 변경. UI: evidence+PASS 강제. 비-UI: PASS 청구 시에만 강제.
auto_issue = os.environ.get('ACC_AUTO_ISSUE', '0') == '1'   # auto-issue 경유: 비-UI 라도 evidence 필수(Fix2 Round2 A)
if not p or not os.path.exists(p):
    if req:
        print('UI 변경인데 .qa-evidence.json 없음')
    elif auto_issue:
        print('auto-issue 경유 push 는 QA 증거(.qa-evidence.json + acceptance_verified) 필수 — 비-UI 변경도 예외 아님')
    sys.exit(0)
# 🚨 Round-3 HIGH(auto-issue FIFO) + Round-4 HIGH(TOCTOU): 정규 파일 검증과 open() 을 같은 fd 로
#    원자화한다 — writer 없는 FIFO 의 open() 영구 블록 차단(fail-closed) + 검사~open 사이 교체창 제거.
try:
    _qaf = _open_regular(p)
except Exception as e:
    print('.qa-evidence.json 이 정규 파일이 아님(FIFO/심링크/디렉토리) 또는 조회 불가/크기초과 — 위조 의심, push 차단: %s' % e); sys.exit(0)
# 1) 파싱 먼저 — malformed(파싱 불가)는 나이/스코프 무관 **항상 차단**(fail-closed). evidence 존재하나 검증
#    불가하면 손상으로 우회 가능(Codex). stale 검사보다 앞이라 stale-malformed 우회도 닫힌다.
try:
    with _qaf:
        d = json.load(_qaf)
except Exception as e:
    print('.qa-evidence.json 파싱 불가(malformed=차단): %s' % e); sys.exit(0)
if not isinstance(d, dict):
    print('evidence 최상위가 객체가 아님'); sys.exit(0)
try:
    vdt = str(d.get('verdict', '')).strip().upper()
    # 2) verdict != PASS(WIP): PASS 를 청구하지 않음 → 비-UI 는 fail-open(허용), UI 는 PASS 강제.
    if vdt != 'PASS':
        if req: print('verdict가 PASS 아님 (%r) — UI 는 PASS 필요' % d.get('verdict'))
        sys.exit(0)
    # ── 이하: PASS 를 **청구**함. anti-reuse/anti-spoof 강제 ──
    # 3) 🚨 mtime 신선도 폐기(2026-08-03, 사용자 지시) — 시간은 무엇을 검증했는지와 무관하다.
    #    기존엔 UI PASS 증거를 'mtime 1시간 이내'로 판정했는데 `touch` 한 번이면 통과했고,
    #    5분 전 증거라도 다른 상태를 검증한 것이면 그대로 통과했다.
    #    재사용 차단은 아래 4)의 HEAD 결속 + 3.3 의 워킹트리 결속(wt_sha)이 담당한다 —
    #    시간이 아니라 '증거가 검증한 상태 == 지금 push 하려는 상태'로 판정한다.
    # 4) HEAD 결속(PASS 청구 시 **필수**): 증거는 현재 HEAD 에 결속돼야 교차커밋/시간 재사용을 차단한다.
    #    head(또는 commit) 필드 필수 + 7자 이상 + 현재 full HEAD 의 접두여야. 미제공/짧음/불일치 → 차단.
    #    (Codex: head 생략 시 mtime 만으로는 재사용 가능 → head 결속을 required 로. head='a' 위조도 len>=7 로 차단.)
    ev_head = str(d.get('head', d.get('commit', ''))).strip()
    cur = os.environ.get('ACC_HEAD', '').strip()
    if not ev_head or len(ev_head) < 7 or not (cur and cur.startswith(ev_head)):
        print('.qa-evidence.json head 결속 실패 — PASS 증거는 현재 HEAD 에 바인딩된 head(7자+) 필수 (head=%r, HEAD=%.12s)' % (ev_head, cur)); sys.exit(0)
    # 5) acceptance_verified: 각 met=true + 비어있지 않은 criterion + evidence (anti-Goodhart 핵심)
    av = d.get('acceptance_verified')
    if not (isinstance(av, list) and av):
        print('acceptance_verified 누락/빈 배열'); sys.exit(0)
    bad = [a for a in av if not (isinstance(a, dict) and a.get('met') is True
            and str(a.get('criterion', '')).strip() and str(a.get('evidence', '')).strip())]
    if bad:
        print('acceptance_verified %d건 무효(각 met=true + criterion + evidence 필요)' % len(bad)); sys.exit(0)
    # 6) 🚨 plan AC 교차검증 (2026-08-05): qa-test-plan.md 의 '수용 기준 매핑'(- AC-NNN: ... TC-...)이
    #    있으면 그 AC **전건**이 acceptance_verified 에 있어야 한다(항목 id 필드 또는 criterion 선두 AC-NNN).
    #    없으면 계획(plan 모드)의 완료조건이 QA 에서 조용히 누락된 것 — 자기 기준 QA(anti-Goodhart) 차단.
    #    plan 에 AC 라인이 없으면 미강제(레거시 호환 — 신규 생성은 qa-scenario-gen 이 섹션을 필수 산출).
    import re
    plan_p = os.environ.get('ACC_PLAN', '')
    plan_txt = ''
    if plan_p and os.path.exists(plan_p):
        try:
            # 같은 방어(정규 파일 + 4MiB 상한, TOCTOU 없는 원자 open) — plan 파일도 FIFO 면 open()
            # 이 영구 블록하고, 검사~open 사이 교체 창도 같은 fd 원자화로 없앤다.
            with _open_regular(plan_p, errors='replace') as _pf:
                plan_txt = _pf.read()
        except Exception as e:
            # 🚨 Round-9 HIGH: plan 이 '존재하는데 못 읽음'(FIFO/심링크/디렉토리/과대)을 '없음'과
            # 같은 빈 문자열로 접으면 아래 AC 매핑 강제(ac_lines)가 조용히 통째로 사라져 임의
            # acceptance_verified 가 통과한다. 부재(위 os.path.exists 분기가 False)는 기존
            # 미강제(레거시 skip)를 그대로 유지하고, 판독 불가만 즉시 차단한다.
            print('BLOCK:qa-test-plan.md 읽기 실패(정규 파일·4MiB 이하여야): %s' % e); sys.exit(0)
    ac_lines = re.findall(r'(?m)^[-*][ \t]+(AC-[0-9]{1,4})[ \t]*:(.*)', plan_txt)
    # 🚨 auto-issue 경유 레거시 skip 폐쇄 (2026-09-02): plan 에 AC 라인이 0건이면 종전엔 무조건
    #    미강제였다 — 일반 프로젝트 호환은 유지하되, auto-issue 경유(.claude/auto-issue/issue-*/
    #    존재)면 완료조건 승계 실패이므로 차단한다(anti-Goodhart 구멍 재개 방지).
    import glob
    _acroot = os.environ.get('ACC_ROOT', '') or os.getcwd()
    _auto_dirs = glob.glob(os.path.join(_acroot, '.claude/auto-issue/issue-*/'))
    _auto_contracts = glob.glob(os.path.join(_acroot, '.claude/auto-issue/issue-*/acceptance-contract.md'))
    _is_auto_issue = bool(_auto_dirs) or bool(_auto_contracts)
    probs = []
    if ac_lines:
        seen = set(); plan_ids = []; unmapped = []
        for aid, rest in ac_lines:
            u = aid.upper()
            if u not in seen:
                seen.add(u); plan_ids.append(u)
                if 'TC-' not in rest: unmapped.append(u)
        ev_ids = set()
        for a in av:
            for cand in (str(a.get('id', '')).strip().upper(), str(a.get('criterion', '')).strip().upper()):
                m2 = re.match(r'[ \t]*(AC-[0-9]{1,4})\b', cand)
                if m2: ev_ids.add(m2.group(1))
        missing = [x for x in plan_ids if x not in ev_ids]
        if unmapped:
            probs.append('plan AC %d건 TC 미매핑(각 AC 라인에 TC-... 매핑 필수): %s' % (len(unmapped), ','.join(unmapped[:5])))
        if missing:
            probs.append('plan 수용기준(AC) %d건 acceptance_verified 미커버: %s' % (len(missing), ','.join(missing[:8])))
    elif _is_auto_issue and os.environ.get('ACCEPTANCE_GATE', '1') != '0':
        probs.append('auto-issue 경유인데 qa-test-plan 수용 기준 매핑(- AC-NNN:) 0건 — qa-scenario-gen 으로 계약 AC 를 plan 에 승계한 뒤 재시도')
    # 🚨 계약↔plan 동등성(acceptance_contract.py check) — 계약 파일이 있으면 ac_lines 유무와 무관하게 검사.
    if _auto_contracts:
        _contract_path = max(_auto_contracts, key=lambda p: os.path.getmtime(p) if os.path.exists(p) else 0)
        _acp = os.environ.get('ACCEPTANCE_CONTRACT_PY') or os.path.expanduser('~/.claude/skills/auto-issue/scripts/acceptance_contract.py')
        if not os.path.exists(_acp):
            probs.append('acceptance_contract.py 부재: %s' % _acp)
        else:
            import subprocess
            try:
                _cp = subprocess.run(
                    [sys.executable, _acp, 'check', '--contract', _contract_path,
                     '--plan', plan_p, '--require-plan', '--json'],
                    capture_output=True, text=True, timeout=30,
                )
            except Exception as _e:
                probs.append('acceptance_contract.py check 실행 실패: %s' % _e)
            else:
                if _cp.returncode == 2:
                    try:
                        _cj = json.loads(_cp.stdout or '{}')
                        _v0 = (_cj.get('violations') or ['형식 위반'])[0]
                    except Exception:
                        _v0 = (_cp.stdout or _cp.stderr or '').strip()[:200] or '형식 위반'
                    probs.append('acceptance-contract.md 계약 위반: %s' % _v0)
                elif _cp.returncode == 3:
                    probs.append('acceptance-contract.md status=insufficient — §5 구현 진입 전 계약 보강 필요')
                elif _cp.returncode not in (0,):
                    probs.append('acceptance_contract.py check 비정상 종료(rc=%d): %s' % (_cp.returncode, (_cp.stderr or '')[-200:]))
    if probs:
        print('; '.join(probs)); sys.exit(0)
    print('')
except Exception as e:
    print('BLOCK:evidence parse/shape error: %s' % e.__class__.__name__)
    sys.exit(0)
PYACC
)
  # 🚨 Round-11 HIGH: python3 비정상 종료(rc!=0, 예: 문법오류·kill·python3 부재)면 ACC_FAIL 이
  #   무출력으로 비어있을 수 있다 — 아래 -n 검사는 빈 문자열을 "문제 없음"으로 오독(fail-open)한다.
  ACC_RC=$?
  if [ "$ACC_RC" -ne 0 ] && ! printf '%s' "$ACC_FAIL" | grep -q '^BLOCK:'; then
    ACC_FAIL="BLOCK:validator 실행 실패(rc=$ACC_RC) — fail-closed"
  fi
  if [ -n "$ACC_FAIL" ]; then
    echo "HARD BLOCK: acceptance 검증 실패 (anti-Goodhart, Fix2): $ACC_FAIL"
    echo "  verdict=PASS 는 .qa-evidence.json + 수용기준 검증(각 met=true+criterion+evidence)이 필수입니다(자기 기준/no-op/빈 {met:true} 금지). 해제: ACCEPTANCE_GATE=0"
    exit 2
  fi
fi

# === PROVEN-RED GATE (opt-in — 2026-09-20 360차 EXEC 승격, tdd-enforcement anti-vacuous / gap-trap "proven red") ===
# 변경된 테스트 파일이 base(push 대상 브랜치)에서도 전건 통과하면 "증명 없음"(vacuous) — 되돌려도 FAIL 하지 않는 회귀 테스트.
# 기본 off: 프로젝트 테스트 러너를 임시 워크트리에서 실제 실행하므로 시간·부작용 표면이 크다 → PROVEN_RED_GATE=1 인 세션/프로젝트만.
# exit 3(러너 미검출·타임아웃 = 측정 불가)은 경고만 — 통과로 읽지 않되 차단도 하지 않는다(fail-loud #5). 사용자 트리·index 는 불변.
# 판정 정본: ~/.claude/scripts/proven-red-anti-vacuous-test-gate.sh (--selftest 픽스처 13종 anti-vacuous — 적대 리뷰 11R 수렴 후 확장).
if [ "${PROVEN_RED_GATE:-0}" = "1" ] && [ -x "$HOME/.claude/scripts/proven-red-anti-vacuous-test-gate.sh" ]; then
  _pr_base="${ACC_BASE:-HEAD}"
  _pr_out=$(bash "$HOME/.claude/scripts/proven-red-anti-vacuous-test-gate.sh" --repo "$PROJECT_ROOT" --base "$_pr_base" 2>&1) && _pr_rc=0 || _pr_rc=$?
  case "$_pr_rc" in
    0) : ;;
    2) echo "HARD BLOCK: proven-red — 변경된 테스트가 base(${_pr_base})에서도 통과합니다. 되돌려도 FAIL 하지 않는 테스트는 회귀를 증명하지 않습니다." >&2
       printf '%s\n' "$_pr_out" | tail -8 >&2
       echo "  테스트가 수정된 동작을 실제로 단언하도록 고친 뒤 재시도 (rule: tdd-enforcement anti-vacuous). 해제: PROVEN_RED_GATE=0" >&2
       exit 2 ;;
    *) echo "⚠️  proven-red 측정 불가(rc=${_pr_rc}) — 통과로 읽지 않음·차단도 하지 않음: $(printf '%s' "$_pr_out" | tail -1)" >&2 ;;
  esac
fi

# === QA LADDER GATE (validate-if-present — 2026-09-12 330차 EXEC 승격, qa-verification-levels v2) ===
# .qa-evidence.json 에 qa_ladder 블록이 있을 때만 검사한다. 부재 = 레거시 증거 = 통과(accept-either 1단계 —
# 설치본 60+ 가 정렬되기 전 필수화하면 전 프로젝트 push 브릭). verdict 가 PASS 가 아닌 WIP 증거도 대상 아님.
# 차단(exit 2) 조건 — 전건 결정론(JSON 필드 비교 + plan 헤더 계수):
#   ① sequence_valid != true (diagnostic 모드 산출물은 PASS 증거로 쓸 수 없다)
#   ② 레벨 스킵: levelN 이 PASS(또는 delegated) 인데 level(N-1) 이 PASS/N/A 가 아님
#   ③ plan 에 `#### H-` 있으면 level2 ∈ {PASS,N/A}, `#### A-` 있으면 level3 ∈ {PASS,N/A,delegated:push-gate}
#   ④ level3 = delegated:push-gate 면 highest_level_passed ≤ 2 (push 게이트 통과 시점에 3 승격) · highest 는 실제 순차 PASS 를 넘지 못한다
#   ⑤ 측정 필드(findings{critical,high,medium,low}·elapsed_s·spawns) 가 있으면 스키마 유효(음이 아닌 수)
#   ⑥ 통과선: level1/level2 PASS 인데 findings critical>0 또는 high>0, level3 PASS 인데 critical>0 → 차단
#   ⑦ 단계 push (2026-10-17 사용자 지시 — "레벨1 통과 후 merge·push, 그 뒤 레벨2·3"): level2/level3 의
#      `deferred:post-push` 는 level1_functional=PASS 일 때만 허용하고 ③ 의 판정 필수를 충족한다. 미룬 상태로는
#      완료 선언이 안 된다 — claim-done-gate 가 deferred 잔존을 exit 2 로 막는다(완료 마커는 전건 성공에만).
# 검사 로직은 아래 PYLADDER 단일 정본 — ~/.claude/scripts/qa-ladder-gate-selftest.sh 가 같은 블록을 추출해 픽스처로 실행한다
# (anti-vacuous: 스킵 픽스처가 실제로 차단되는지). 해제: QA_LADDER_GATE=0
if [ "${QA_LADDER_GATE:-1}" != "0" ] && [ -f "$BROWSER_EVIDENCE" ]; then
  LADDER_FAIL=$(QA_EVIDENCE="$BROWSER_EVIDENCE" LADDER_PLAN="$PROJECT_ROOT/docs/qa-test-plan.md" python3 - <<'PYLADDER' 2>&1
import json, os, re, stat, sys
p = os.environ['QA_EVIDENCE']; plan = os.environ.get('LADDER_PLAN', '')
try:
    st = os.lstat(p)
    if not stat.S_ISREG(st.st_mode) or st.st_size > 2 * 1024 * 1024:
        print('BLOCK:.qa-evidence.json 이 정규 파일이 아니거나 크기 초과(2MiB) — 위조 의심'); sys.exit(0)
    with open(p, encoding='utf-8') as f:
        d = json.load(f)
except Exception as e:
    print('BLOCK:.qa-evidence.json 파싱 불가: %s' % e.__class__.__name__); sys.exit(0)
if not isinstance(d, dict):
    print('BLOCK:evidence 루트가 객체가 아님'); sys.exit(0)
lad = d.get('qa_ladder')
if lad is None:
    sys.exit(0)  # 부재 = 레거시 증거 = 통과 (validate-if-present)
verdict = str(d.get('verdict', '') or '').strip().upper()
if verdict and verdict != 'PASS':
    sys.exit(0)  # WIP/FAIL 증거는 PASS 청구가 아니므로 사다리 검사 대상 아님
if not isinstance(lad, dict):
    print('BLOCK:qa_ladder 가 객체가 아님'); sys.exit(0)
issues = []
OK = {'PASS', 'N/A'}
L = ['level1_functional', 'level2_heuristic', 'level3_adversarial', 'level4_operational']
DEF = 'deferred:post-push'
ALLOWED = [{'PASS', 'FAIL', 'N/A'}, {'PASS', 'FAIL', 'N/A', DEF}, {'PASS', 'FAIL', 'N/A', 'delegated:push-gate', DEF}, {'PASS', 'N/A'}]
sts = []
for i, k in enumerate(L):
    v = lad.get(k)
    if v is None:
        sts.append(None); continue
    if not isinstance(v, dict):
        issues.append('%s 가 객체가 아님' % k); sts.append('INVALID'); continue
    s = v.get('status')
    s = str(s).strip() if s is not None else None
    if s is not None and s not in ALLOWED[i]:
        issues.append('%s.status=%r 허용 어휘 밖(%s)' % (k, s, '|'.join(sorted(ALLOWED[i]))))
    sts.append(s)
# ① diagnostic 산출물은 PASS 증거 불가
if lad.get('sequence_valid') is not True:
    issues.append('sequence_valid != true — diagnostic(ladder_scope=diagnostic)/미기재 산출물은 PASS 증거로 쓸 수 없다')
if sts[0] is None:
    issues.append('level1_functional 누락 — 사다리는 레벨1부터 오른다')
# ⑦ 단계 push: 레벨2·3 을 push 뒤로 미루는 것은 레벨1 PASS 뒤에만
if DEF in (sts[1], sts[2]) and sts[0] != 'PASS':
    issues.append('%s 는 level1_functional=PASS 일 때만 허용 (현재 level1=%s) — 레벨1 통과 후 push 단계 정책' % (DEF, sts[0]))
# ② 레벨 스킵 차단
def _passed(s):
    return s == 'PASS' or s == 'delegated:push-gate'
for i in range(1, 4):
    if _passed(sts[i]) and sts[i - 1] not in OK:
        issues.append('레벨 스킵: %s=%s 인데 %s=%s (하위 레벨 PASS/N/A 후에만 상위 실행)' % (L[i], sts[i], L[i - 1], sts[i - 1]))
# ③ plan 에 H-/A- 시나리오가 있으면 해당 레벨 판정 필수
if plan and os.path.isfile(plan):
    try:
        with open(plan, encoding='utf-8', errors='replace') as f:
            txt = f.read()
        hN = len(re.findall(r'^#### H-', txt, re.M)); aN = len(re.findall(r'^#### A-', txt, re.M))
    except Exception as e:
        hN = aN = 0; issues.append('plan 읽기 실패: %s' % e.__class__.__name__)
    if hN > 0 and sts[1] not in (OK | {DEF}):
        issues.append('plan H-* %d건 존재 — level2_heuristic 은 PASS|N/A|%s 필수 (현재 %s)' % (hN, DEF, sts[1]))
    if aN > 0 and sts[2] not in (OK | {'delegated:push-gate', DEF}):
        issues.append('plan A-* %d건 존재 — level3_adversarial 은 PASS|N/A|delegated:push-gate|%s 필수 (현재 %s)' % (aN, DEF, sts[2]))
# ④ highest_level_passed 정합
hlp = lad.get('highest_level_passed')
if hlp is not None:
    if isinstance(hlp, bool) or not isinstance(hlp, int) or not (0 <= hlp <= 4):
        issues.append('highest_level_passed 는 0~4 정수여야 함 (현재 %r)' % (hlp,))
    else:
        actual = 0
        for i, s in enumerate(sts):
            if s == 'PASS':
                actual = i + 1
            elif s == 'N/A':
                continue
            else:
                break
        if sts[2] == 'delegated:push-gate' and hlp > 2:
            issues.append('level3=delegated:push-gate 상태의 highest_level_passed 는 2 (push 통과 시 3 승격) — 현재 %d' % hlp)
        elif hlp > actual:
            issues.append('highest_level_passed=%d 가 실제 순차 PASS(%d)를 초과' % (hlp, actual))
# ⑤ 측정 필드 스키마 · ⑥ 레벨 통과선
def _nonneg(x):
    return (not isinstance(x, bool)) and isinstance(x, (int, float)) and x >= 0
for i, k in enumerate(L):
    v = lad.get(k)
    if not isinstance(v, dict):
        continue
    fd = v.get('findings')
    if fd is not None:
        if not isinstance(fd, dict) or any(kk not in fd or not _nonneg(fd[kk]) for kk in ('critical', 'high', 'medium', 'low')):
            issues.append('%s.findings 스키마 무효 — {critical,high,medium,low} 음이 아닌 수 필수' % k)
        elif sts[i] == 'PASS':
            crit = fd.get('critical', 0); high = fd.get('high', 0)
            if i in (0, 1) and (crit > 0 or high > 0):
                issues.append('%s=PASS 인데 findings critical=%s high=%s — 통과선은 CRITICAL/HIGH 0' % (k, crit, high))
            if i == 2 and crit > 0:
                issues.append('%s=PASS 인데 findings critical=%s — 통과선은 CRITICAL 0' % (k, crit))
    for mk in ('elapsed_s', 'spawns'):
        if mk in v and not _nonneg(v[mk]):
            issues.append('%s.%s 는 음이 아닌 수여야 함 (현재 %r)' % (k, mk, v[mk]))
print('; '.join(issues))
PYLADDER
)
  # python3 비정상 종료(rc!=0)+무출력은 -n 검사에서 "문제 없음"으로 오독된다 — fail-closed
  LADDER_RC=$?
  if [ "$LADDER_RC" -ne 0 ] && ! printf '%s' "$LADDER_FAIL" | grep -q '^BLOCK:'; then
    LADDER_FAIL="BLOCK:validator 실행 실패(rc=$LADDER_RC) — fail-closed"
  fi
  if [ -n "$LADDER_FAIL" ]; then
    echo "HARD BLOCK: QA 검증 레벨 사다리(qa_ladder) 검사 실패 — $LADDER_FAIL"
    echo "  레벨 N+1 PASS 는 레벨 N PASS/N/A 후에만 · diagnostic(sequence_valid=false)은 PASS 증거 불가 · plan 에 H-/A- 있으면 레벨2/3 판정 필수(레벨1 PASS 뒤 단계 push 면 deferred:post-push) (rule: qa-verification-levels). 해제: QA_LADDER_GATE=0"
    exit 2
  fi
fi

# === E2E 완료조건 HARD GATE (2026-07-24 — QA 완료조건 = TC 전건 + E2E 전건, SOFT 잔존 0) ===
# PASS 청구(.qa-evidence.json verdict=PASS) 시 e2e 블록 필수(UI 무관), UI 변경이면 screenshot_compare 도 필수.
if [ "${E2E_GATE:-1}" != "0" ] && [ -f "$BROWSER_EVIDENCE" ]; then
  E2E_FAIL=$(QA_EVIDENCE="$BROWSER_EVIDENCE" PR="$PROJECT_ROOT" HAS_UI_ENV="$( [ "${ACC_UI_CHANGED:-0}" -gt 0 ] && echo 1 || echo 0 )" python3 - <<'PYE2E' 2>&1
import json, os, sys
p = os.environ['QA_EVIDENCE']; base = os.environ.get('PR', '.')
try:
    d = json.load(open(p, encoding='utf-8'))
except Exception as e:
    print('.qa-evidence.json 파싱 불가: %s' % e); sys.exit(0)
if not isinstance(d, dict):
    print('evidence 최상위가 객체가 아님'); sys.exit(0)
try:
    if str(d.get('verdict','')).strip().upper() != 'PASS':
        sys.exit(0)   # PASS 청구 아닐 땐 미강제 (acceptance 게이트와 동일 원칙)
    issues = []
    e2e = d.get('e2e')
    if not isinstance(e2e, dict):
        issues.append('e2e 블록 누락(해당 없음도 not_applicable:true + reason 필수)')
    elif e2e.get('not_applicable') is True:
        if not str(e2e.get('reason','')).strip(): issues.append('e2e.not_applicable 인데 reason 없음')
        # 🚨 실행 표면 존재 시 not_applicable 거부 (2026-08-05): reason 은 산문이라 게이트가 진위를 못 본다.
        #    명백한 dev 표면(package.json dev/start/serve/preview 스크립트, vite/next/nuxt/svelte/astro 설정,
        #    루트 index.html)이 있으면 저니 1건은 반드시 가능하다 — n/a 주장을 결정론으로 차단. 해제: E2E_GATE=0
        #    (의도된 과탐 — Codex MEDIUM 2026-08-05 수용: docs 전용/라이브러리 repo 도 dev 표면이 있으면
        #    저니 1건을 실제로 돌리는 것이 이 하네스의 doctrine[실행 표면 있으면 E2E 필수]이고,
        #    진짜 예외는 의식적 E2E_GATE=0 으로만. 과탐지는 안전 — 저니 1건이 한 번 더 도는 것뿐.)
        surf = []
        _pj = os.path.join(base, 'package.json')
        if os.path.exists(_pj):
            try:
                _sc = (json.load(open(_pj, encoding='utf-8')) or {}).get('scripts', {}) or {}
                _hit = [k for k in ('dev', 'start', 'serve', 'preview') if str(_sc.get(k, '')).strip()]
                if _hit: surf.append('package.json scripts:' + ','.join(_hit))
            except Exception:
                pass
        import glob as _g
        for _pat in ('vite.config.*', 'next.config.*', 'nuxt.config.*', 'svelte.config.*', 'astro.config.*'):
            if _g.glob(os.path.join(base, _pat)): surf.append(_pat)
        if os.path.exists(os.path.join(base, 'index.html')): surf.append('index.html')
        if surf:
            issues.append('e2e.not_applicable 인데 실행 표면 존재(%s) — E2E 저니 최소 1건 필수' % '; '.join(surf[:3]))
    else:
        if e2e.get('executed') is not True: issues.append('e2e.executed != true')
        try:
            tot = int(e2e.get('total', 0)); ok = int(e2e.get('passed', -1))
        except Exception:
            tot, ok = 0, -1; issues.append('e2e.total/passed 숫자 아님')
        if tot < 1: issues.append('e2e.total<1 (E2E 0건 금지)')
        if ok != tot: issues.append('E2E 미전건 %s/%s' % (ok, tot))
        js = e2e.get('journeys')
        if not (isinstance(js, list) and js): issues.append('e2e.journeys 누락/빈 배열')
        else:
            badj = [j for j in js if not (isinstance(j, dict) and j.get('passed') is True
                    and str(j.get('id','')).strip() and str(j.get('evidence','')).strip())]
            if badj: issues.append('e2e.journeys %d건 무효(각 passed=true+id+evidence)' % len(badj))
    if os.environ.get('HAS_UI_ENV') == '1':
        sc = d.get('screenshot_compare')
        if not isinstance(sc, dict): issues.append('screenshot_compare 블록 누락(UI 완료는 스크린캡처+비교분석 필수)')
        else:
            if sc.get('executed') is not True: issues.append('screenshot_compare.executed != true')
            try:
                cn = int(sc.get('compared', 0)); mm = int(sc.get('mismatches', -1))
            except Exception:
                cn, mm = 0, -1; issues.append('screenshot_compare compared/mismatches 숫자 아님')
            if cn < 1: issues.append('screenshot_compare.compared<1')
            if mm != 0: issues.append('screenshot_compare.mismatches=%s' % mm)
            if str(sc.get('verdict','')).strip().upper() != 'PASS': issues.append('screenshot_compare.verdict != PASS')
            files = sc.get('files') or []
            rf = [f if os.path.isabs(str(f)) else os.path.join(base, str(f)) for f in files]
            miss = [f for f in rf if not os.path.exists(f)]
            if not files: issues.append('screenshot_compare.files 비어있음')
            elif miss: issues.append('screenshot 파일 부재 %d건' % len(miss))
    print('; '.join(issues))
except Exception as e:
    print('BLOCK:evidence parse/shape error: %s' % e.__class__.__name__)
    sys.exit(0)
PYE2E
)
  # 🚨 Round-11 HIGH: python3 비정상 종료(rc!=0)+무출력은 -n 검사에서 "문제 없음"으로 오독된다.
  E2E_RC=$?
  if [ "$E2E_RC" -ne 0 ] && ! printf '%s' "$E2E_FAIL" | grep -q '^BLOCK:'; then
    E2E_FAIL="BLOCK:validator 실행 실패(rc=$E2E_RC) — fail-closed"
  fi
  if [ -n "$E2E_FAIL" ]; then
    echo "HARD BLOCK: E2E 완료조건 실패 — $E2E_FAIL"
    echo "  QA 완료조건 = TC 전건 + E2E 전건 (+UI는 스크린샷 비교분석). 해제: E2E_GATE=0"
    exit 2
  fi
fi

# === POST-DEPLOY VERIFY GATE (2026-07-24 HARD) — deploy-verify-marker.sh 마커 소비 ===
DEPLOY_MARK="$PROJECT_ROOT/.deploy-pending-verify"
# 🚨 Round-10 HIGH: -f 는 비정규 파일(FIFO/디렉토리/심링크)에서 false 를 반환해 "마커 없음"으로
#   오독 — 아래 게이트 진입 조건이 통째로 거짓이 되어 배포 후 검증 없이 push 가 통과한다
#   (early success). -e 로 먼저 무결성을 확인해 fail-closed 즉시 차단한다.
# 🚨 Round-11 HIGH: dangling 심링크(대상 없음)는 -e·-f 둘 다 false 다 — 위 Round-10 수리는
#   "존재하는데 -f 거짓"(FIFO/디렉토리)만 잡고, 대상이 없는 심링크는 여전히 "마커 없음"으로
#   오독해 이 게이트 진입조건 전체를 통과시킨다(배포 후 검증 없이 push 통과, old blob 실증).
#   -L 은 대상 존재 여부와 무관하게 심링크 자체를 감지하므로 -e 보다 먼저 확인한다.
if [ -L "$DEPLOY_MARK" ]; then
  echo "HARD BLOCK: $DEPLOY_MARK 는 정규 파일이어야 함(심링크 금지)"
  echo "  복구: rm $DEPLOY_MARK 후 정규 파일로 재생성(QA/배포 절차 재실행)"
  exit 2
fi
if [ -e "$DEPLOY_MARK" ] && [ ! -f "$DEPLOY_MARK" ]; then
  echo "HARD BLOCK: $DEPLOY_MARK 는 정규 파일이어야 함(FIFO/디렉토리 아님)"
  echo "  복구: rm $DEPLOY_MARK 후 QA/배포 절차 재실행으로 정규 파일 재생성"
  exit 2
fi
if [ -f "$DEPLOY_MARK" ] && [ "${E2E_GATE:-1}" != "0" ]; then
  # 🚨 362차 EXEC(적대 리뷰 2026-09-21 R1·R2 HIGH): 검증한 마커와 소비(rm)하는 마커를 같은 inode 로 결속.
  #   종전에는 PYPD 가 경로로 검증하고 아래 rm -f 가 경로로 삭제해, 그 사이에 다른 프로세스(재배포)가 새 마커로
  #   교체하면 **미검증 마커가 삭제**돼 다음 push 가 배포 후 검증 없이 통과했다(TOCTOU — atomic-artifact-publish 11·
  #   security-patterns ④ "검사한 객체 ≠ 소비한 객체"). 검증 시작 시 lstat(dev:ino) 를 기록하고 PYPD 안에서는
  #   O_NOFOLLOW 로 연 fd 의 fstat 가 그 id 와 같은지, 소비 직전에는 lstat 이 같은지 재대조한다.
  #   한계 정직 고지: POSIX 에 fd 단위 unlink 가 없어 재대조~rm 사이 창은 0 이 아니다(수 μs) — 검증 전체 구간(수백 ms)을
  #   덮던 창을 그만큼으로 좁힌 것이다. 회귀: scripts/deploy-marker-consume-selftest.sh (교체·심링크·FIFO·소실 시나리오).
  _mark_id() { python3 -c 'import os, sys
try:
    st = os.lstat(sys.argv[1]); print("%d:%d" % (st.st_dev, st.st_ino))
except FileNotFoundError:
    print("GONE")' "$1" 2>/dev/null; }
  MARK_ID=$(_mark_id "$DEPLOY_MARK")
  case "$MARK_ID" in ''|GONE)
    echo "HARD BLOCK: 배포 마커 식별 실패(lstat ${MARK_ID:-오류}) — 검증 대상을 특정할 수 없어 fail-closed"
    echo "  복구: $DEPLOY_MARK 상태 확인 후 QA/배포 절차 재실행"
    exit 2 ;;
  esac
  PD_FAIL=$(QA_EVIDENCE="$BROWSER_EVIDENCE" DEPLOY_MARK="$DEPLOY_MARK" DEPLOY_MARK_ID="$MARK_ID" python3 - <<'PYPD' 2>&1
import json, os, stat, sys

def _open_regular(path, max_bytes=4 * 1024 * 1024, errors='strict'):
    # TOCTOU 방지(Codex HIGH, 2026-09-02 라운드4) — PYACC 블록과 동일 계약(별도 heredoc 이라
    # 정의를 중복한다): exists() 검사와 open() 사이의 창에서 파일이 FIFO/심링크로 교체될 수
    # 있으므로 정규 파일 검증과 open 을 같은 fd 로 원자화한다. 이 블록은 종전에 이 검사가
    # 전무해(FIFO 열기 시 무한 블록) PYACC 블록보다 더 취약했다.
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > max_bytes:
            raise ValueError('not a regular file or too large (%d bytes)' % st.st_size)
        return os.fdopen(fd, 'r', encoding='utf-8', errors=errors)
    except Exception:
        os.close(fd)
        raise

m = os.environ['DEPLOY_MARK']; p = os.environ['QA_EVIDENCE']; mid = os.environ.get('DEPLOY_MARK_ID', '')
# 마커도 fd 로 열어 검증 시작 시 기록한 id 와 결속 — 경로 getmtime 은 교체된 마커의 시각을 읽는다.
try:
    _mfd = os.open(m, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
except Exception as e:
    print('배포 마커 열기 실패(교체/소실/비정규 의심) — push 차단: %s' % e.__class__.__name__); sys.exit(0)
try:
    _mst = os.fstat(_mfd)
finally:
    os.close(_mfd)
if not stat.S_ISREG(_mst.st_mode):
    print('배포 마커가 정규 파일이 아님 — 검증 중 교체 의심, push 차단'); sys.exit(0)
if '%d:%d' % (_mst.st_dev, _mst.st_ino) != mid:
    print('배포 마커가 검증 시작 후 교체됨(id %s → %d:%d) — 새 배포 재검증 필요' % (mid, _mst.st_dev, _mst.st_ino)); sys.exit(0)
if not os.path.exists(p):
    print('배포 감지(.deploy-pending-verify)됐는데 .qa-evidence.json 없음 — 배포 후 검증 미실행'); sys.exit(0)
try:
    _pdf = _open_regular(p)
except Exception as e:
    print('.qa-evidence.json 이 정규 파일이 아님(FIFO/심링크/디렉토리) 또는 조회 불가/크기초과 — 위조 의심, push 차단: %s' % e); sys.exit(0)
try:
    with _pdf:
        d = json.load(_pdf)
except Exception as e:
    print('evidence 파싱 불가: %s' % e); sys.exit(0)
if not isinstance(d, dict):
    print('evidence 최상위가 객체가 아님'); sys.exit(0)
try:
    pd = d.get('post_deploy')
    issues = []
    if not isinstance(pd, dict):
        issues.append('post_deploy 블록 없음 — 배포 URL smoke+E2E 재검증 필수')
    else:
        if os.path.getmtime(p) < _mst.st_mtime: issues.append('post_deploy 증거가 배포 시각보다 오래됨 — 재검증 필요')
        if not str(pd.get('url','')).strip(): issues.append('post_deploy.url 없음')
        if str(pd.get('smoke','')).strip().upper() != 'PASS': issues.append('post_deploy.smoke != PASS')
        e2e = pd.get('e2e') or {}
        if e2e.get('not_applicable') is True:
            if not str(e2e.get('reason','')).strip(): issues.append('post_deploy.e2e.not_applicable 인데 reason 없음')
        else:
            try:
                tot = int(e2e.get('total', 0)); ok = int(e2e.get('passed', -1))
            except Exception:
                tot, ok = 0, -1; issues.append('post_deploy.e2e total/passed 숫자 아님')
            if tot < 1: issues.append('post_deploy.e2e.total<1')
            if ok != tot: issues.append('post_deploy E2E %s/%s' % (ok, tot))
    print('; '.join(issues))
except Exception as e:
    print('BLOCK:evidence parse/shape error: %s' % e.__class__.__name__)
    sys.exit(0)
PYPD
)
  # 🚨 Round-11 HIGH: python3 비정상 종료(rc!=0)+무출력은 -n 검사에서 "문제 없음"으로 오독되고,
  #   그 결과 아래 rm -f 가 검증 없이 배포 마커를 소비해 재검증 기회까지 사라진다.
  PD_RC=$?
  if [ "$PD_RC" -ne 0 ] && ! printf '%s' "$PD_FAIL" | grep -q '^BLOCK:'; then
    PD_FAIL="BLOCK:validator 실행 실패(rc=$PD_RC) — fail-closed"
  fi
  if [ -n "$PD_FAIL" ]; then
    echo "HARD BLOCK: 배포 후 검증 실패 — $PD_FAIL"
    echo "  배포 후에는 배포 URL 대상 smoke+E2E 증거(post_deploy)가 필수입니다. 해제: E2E_GATE=0"
    exit 2
  fi
  # 소비 직전 재대조 — 검증한 그 inode 만 소비한다. 교체(다른 id / 심링크 / FIFO)면 삭제를 생략하고 차단해
  #   새 배포의 마커를 살려 둔다(다음 push 가 재검증하게). 소실(GONE)은 소비할 것이 없으므로 통과.
  NOW_ID=$(_mark_id "$DEPLOY_MARK")
  if [ "$NOW_ID" = "GONE" ]; then
    echo "ℹ️ 배포 마커가 검증 중 사라짐 — 소비 생략(검증은 충족)"
  elif [ "$NOW_ID" != "$MARK_ID" ]; then
    echo "HARD BLOCK: 배포 마커가 검증 중 교체됨(검증 $MARK_ID → 현재 ${NOW_ID:-식별불가}) — 미검증 마커는 소비하지 않음"
    echo "  새 배포가 감지된 것입니다. 배포 URL 대상 smoke+E2E 를 다시 수행해 post_deploy 증거를 갱신한 뒤 push 하세요."
    exit 2
  else
    rm -f "$DEPLOY_MARK" 2>/dev/null || true   # 검증 충족 + 동일 inode → 마커 소비
  fi
fi

# 🚨 deny-by-default: 확장자 allowlist 는 .github/workflows/*.yml·확장자 없는 스크립트를 놓친다.
#   codex-review-gate.sh 의 _INERT_RE 와 **동일**해야 한다(정의 불일치 = 우회 통로).
_INERT_RE='\.(md|markdown|txt|rst|adoc|png|jpe?g|gif|webp|ico|pdf|mp4|mov|woff2?|ttf|eot|snap)$|^(LICENSE|NOTICE|CHANGELOG|\.gitignore|\.gitattributes)$'
# --- 코드 변경 여부 확인 ---
# HEAD~1 만 보면 UI 커밋 뒤에 백엔드 커밋을 얹어 push 할 때 검사가 통째로 건너뛰어진다.
# push 범위 전체(ACC_RANGE_FILES)를 보고, 산출이 비면 HEAD~1 로 폴백한다.
DB_SCOPE_FILES="$ACC_RANGE_FILES"
[ -z "$DB_SCOPE_FILES" ] && DB_SCOPE_FILES=$(git diff --name-only HEAD~1 2>/dev/null)
# 🚨 deny-by-default (Codex HIGH 2026-08-04): 이 allowlist 가 `.github/workflows/*.yml`·확장자
#   없는 스크립트를 놓쳤고, 비면 아래에서 exit 0 으로 **게이트 전체가 우회**됐다(실측: 악성
#   workflow 커밋이 무검사 통과). 변경 파일은 기본 '검사 대상'이고 무해한 것만 제외한다.
CODE_CHANGES=$(printf '%s\n' "$DB_SCOPE_FILES" | grep -v '^$' | { grep -ivE "$_INERT_RE" || [ $? -eq 1 ]; } | head -1)
UI_CHANGES=$(printf '%s\n' "$DB_SCOPE_FILES" | { grep -E '\.(tsx|jsx|vue|svelte|css|scss|html)$' || [ $? -eq 1 ]; } | head -1)

# 코드 변경이 없어도 qa-test-plan.md가 있으면 TC 메타 필수 (2026-04-06 HARD 승격)
# "코드 변경 없음"을 이유로 QA 전체 스킵 절대 금지
if [ -z "$CODE_CHANGES" ]; then
  QA_PLAN="$PROJECT_ROOT/docs/qa-test-plan.md"
  if [ -f "$QA_PLAN" ]; then
    # qa-test-plan.md가 있는 프로젝트: .qa-cycle-passed + TC 메타 필수
    if [ ! -f "$EVIDENCE" ]; then
      echo "HARD BLOCK: 문서만 변경해도 qa-test-plan.md가 있는 프로젝트는 .qa-cycle-passed 필수."
      exit 2
    fi
    CONTENT=$(cat "$EVIDENCE" 2>/dev/null)
    if ! echo "$CONTENT" | grep -q "CRITICAL:"; then
      echo "HARD BLOCK: .qa-cycle-passed에 TC 실행 메타데이터 없음. 문서만 변경해도 인터랙션 QA 필수."
      exit 2
    fi
    # TC 메타 있으면 통과
    exit 0
  fi
  # qa-test-plan.md 없는 프로젝트만 바이패스
  exit 0
fi

# --- .qa-cycle-passed 검증 ---

# 1. 파일 존재
if [ ! -f "$EVIDENCE" ]; then
  echo "HARD BLOCK: QA 미실행. 코드 변경이 감지되었으나 .qa-cycle-passed 파일이 없습니다. user-proxy QA 또는 /qa-cycle을 먼저 수행하세요."
  exit 2
fi

# 2. 🚨 상태 결속 (2026-08-03 — mtime 신선도 폐기, 사용자 지시)
#   기존엔 "1시간 이내"만 봤다. mtime 은 **무엇을 검증했는지와 아무 관련이 없다** — `touch` 한 번이면
#   통과하고, 5분 전 증거라도 *다른 상태*를 검증한 것이면 그대로 통과했다. 이게 QA 구멍의 뿌리였다.
#   교체: 시간이 아니라 **QA 가 검증한 상태 == 지금 push 하려는 상태**인지 본다.
#   커밋 결속은 아래 3.2 가, 워킹트리 결속은 여기(3.3)가 담당한다.
#   → 커밋이든 워킹트리든 QA 이후 바뀌었으면 **재실행 강제**. 시간은 보지 않는다(1분 전이어도
#     상태가 다르면 무효, 3시간 전이어도 상태가 같으면 유효).

# 3. PASS 포함 확인
CONTENT=$(cat "$EVIDENCE" 2>/dev/null)
if ! echo "$CONTENT" | grep -q "PASS"; then
  echo "HARD BLOCK: QA 결과가 PASS가 아닙니다."
  exit 2
fi

# 3.1 Hash 검증 강제 — 단순 "PASS" 위조 방지
# 형식: PASS|commit_hash|timestamp (mark-qa-pass.sh가 생성하는 포맷)
FIRST_LINE=$(echo "$CONTENT" | head -1)
if ! echo "$FIRST_LINE" | grep -qE '^PASS\|[a-f0-9]+\|'; then
  echo "HARD BLOCK: .qa-cycle-passed 포맷 위반. 'PASS|commit_hash|timestamp' 형식 필수."
  echo "  현재: $(printf '%.60s' "$FIRST_LINE")"
  echo "  mark-qa-pass.sh로 생성하세요: bash ~/.codex/scripts/mark-qa-pass.sh manual '설명'"
  exit 2
fi

# 3.2 Commit hash 일치 확인 (이전의 선택적 검증을 강제로 승격)
STORED_HASH=$(echo "$FIRST_LINE" | cut -d'|' -f2)
CURRENT_HASH=$(git rev-parse --short HEAD 2>/dev/null)
if [ -n "$STORED_HASH" ] && [ -n "$CURRENT_HASH" ] && [ "$STORED_HASH" != "$CURRENT_HASH" ]; then
  echo "HARD BLOCK: QA 이후 새 커밋 발생. hash($STORED_HASH) != HEAD($CURRENT_HASH). QA 재수행 필수."
  exit 2
fi

# 3.3 🚨 워킹트리 결속 (2026-08-03 신설 — mtime 신선도의 대체)
#   3.2 는 **커밋만** 본다. QA 후 파일을 고치고 커밋하지 않으면 HEAD 가 그대로라 통과했다
#   (미커밋 변경이 push 대상에 포함되지 않더라도, QA 가 검증한 트리와 다른 트리에서 낸 PASS 다).
#   4번째 필드에 QA 시점 워킹트리 해시를 기록하고 지금과 대조한다.
#   형식: PASS|{short_hash}|{iso_ts}|{wt_sha}
#   wt_sha = { git rev-parse HEAD; git status --porcelain; git diff HEAD; git ls-files -o --exclude-standard -z | while IFS= read -r -d '' f; do git hash-object -- \"\$f\"; done; } | shasum -a 256
STORED_WT=$(echo "$FIRST_LINE" | cut -d'|' -f4)
# 🚨 정의 통일(HEAD 포함): HEAD 를 빼면 빈 커밋/커밋만 바뀐 상태를 못 잡는다.
#   task-quality-gate.sh 의 _cur_wt() 와 반드시 동일해야 한다(정의 불일치 = 우회 통로).
# 🚨 fail-closed (Codex HIGH 2026-08-04): `git hash-object` 실패를 `2>/dev/null` 로 삼키면 그
#   파일은 지문에 **아무 기여도 하지 않는다** — 읽기 불가(예: chmod 030) 미추적 파일을 심어두면
#   QA 이후 그 내용을 바꿔도 `git status` 출력과 지문이 그대로라 stale 증거가 통과한다.
#   실측 재현: 읽기불가 파일 v1→EXPLOIT 교체 후 지문 동일(b4584bff...). 정상 파일은 정상 감지.
#   → 열거/해싱에 하나라도 실패하면 '통과'가 아니라 **차단**한다(측정 불가 ≠ 통과).
#   (task-quality-gate.sh 는 a31162c88 에서 이미 fail-closed — push gate 만 남아 있었다.)
_WT_UNREADABLE=$(git ls-files -o --exclude-standard -z 2>/dev/null \
  | while IFS= read -r -d '' _f; do git hash-object -- "$_f" >/dev/null 2>&1 || printf '%s\n' "$_f"; done)
if [ -n "$_WT_UNREADABLE" ]; then
  echo "HARD BLOCK: 상태 지문 계산 실패 — 읽을 수 없는 미추적 파일이 있어 QA 결속을 검증할 수 없습니다."
  printf '%s\n' "$_WT_UNREADABLE" | head -5 | while IFS= read -r _u; do echo "  - $_u"; done
  echo "  측정 불가는 통과가 아닙니다. 권한을 고치거나 .gitignore 에 추가한 뒤 재시도하세요."
  exit 2
fi
# accept-either stage1 (2026-08-13, artifact-relocation-consumer-alignment 부록 7): 증거 wt_sha 는
#   v1(현행 4스트림) 또는 v2(4스트림 ‖ untracked 경로 목록 -z, 맨 뒤 append) 어느 쪽과 일치해도
#   유효 — 생산자 flip(stage2) 전까지 부분 배포 상태에서 데드락을 없애는 소비자측 브릿지.
_WT_STREAM_TMP=$(mktemp "${TMPDIR:-/tmp}/qgate-wt.XXXXXX" 2>/dev/null) || _WT_STREAM_TMP=""
if [ -n "$_WT_STREAM_TMP" ]; then
  { git rev-parse HEAD 2>/dev/null; git status --porcelain 2>/dev/null; git diff HEAD 2>/dev/null; git ls-files -o --exclude-standard -z 2>/dev/null | while IFS= read -r -d '' _f; do git hash-object -- "$_f" 2>/dev/null; done; } > "$_WT_STREAM_TMP"
  CURRENT_WT=$(PATH=/usr/bin:/bin shasum -a 256 < "$_WT_STREAM_TMP" 2>/dev/null | awk '{print $1}')
  git ls-files -o --exclude-standard -z 2>/dev/null >> "$_WT_STREAM_TMP"
  CURRENT_WT_V2=$(PATH=/usr/bin:/bin shasum -a 256 < "$_WT_STREAM_TMP" 2>/dev/null | awk '{print $1}')
  rm -f "$_WT_STREAM_TMP"
else
  CURRENT_WT=$( { git rev-parse HEAD 2>/dev/null; git status --porcelain 2>/dev/null; git diff HEAD 2>/dev/null; git ls-files -o --exclude-standard -z 2>/dev/null | while IFS= read -r -d '' _f; do git hash-object -- "$_f" 2>/dev/null; done; } \
                | PATH=/usr/bin:/bin shasum -a 256 2>/dev/null | awk '{print $1}')
  CURRENT_WT_V2=""  # temp 불가 시 v1 단독 판정 — 수용 집합이 좁아지는 방향(fail-open 아님)
fi
if [ -z "$CURRENT_WT" ]; then
  echo "HARD BLOCK: 상태 지문이 비어 있습니다 — 결속 검증 불가(측정 불가 ≠ 통과)."
  exit 2
fi
if [ -z "$STORED_WT" ]; then
  echo "HARD BLOCK: .qa-cycle-passed 에 워킹트리 결속 필드가 없습니다 (4번째 필드)."
  echo "  기존 'mtime 1시간' 신선도는 폐기됐습니다 — touch 로 통과하고 무엇을 검증했는지 못 보기 때문."
  echo "  QA 를 재수행하고 아래 형식으로 기록하세요:"
  echo "    PASS|\$(git rev-parse --short HEAD)|\$(date -u +%Y-%m-%dT%H:%M:%SZ)|\$( { git rev-parse HEAD; git status --porcelain; git diff HEAD; git ls-files -o --exclude-standard -z | while IFS= read -r -d '' f; do git hash-object -- \"\$f\"; done; } | shasum -a 256 | awk '{print \$1}')"
  exit 2
fi
if [ "$STORED_WT" != "$CURRENT_WT" ] && [ "$STORED_WT" != "$CURRENT_WT_V2" ]; then
  echo "HARD BLOCK: QA 이후 워킹트리 변경. QA 가 검증한 상태와 지금 push 하려는 상태가 다릅니다."
  echo "  QA 시점: ${STORED_WT:0:16}...  현재: ${CURRENT_WT:0:16}... (v1·v2 모두 불일치)"
  echo "  → QA 재수행 필수 (시간 경과가 아니라 *상태 불일치* 이므로 대기해도 해소되지 않습니다)."
  exit 2
fi

# 3.4 🚨 push-발행 정합 (2026-08-05, Codex HIGH): 3.3 은 "증거 상태 == 현재 상태"만 본다.
#   증거가 **미커밋 수정을 포함한(dirty) 상태**에 결속돼 있으면 3.3 은 통과하지만, push 는
#   HEAD 만 발행하므로 **검증된 미커밋 수정이 발행에서 조용히 빠진다** (검증 상태 ≠ 발행 커밋 —
#   bug-fixer 수정 후 커밋 없이 재QA→push 하는 팀 플로우에서 실제 발생 가능하던 창).
#   → 추적 파일의 미커밋 코드 수정(스테이징 포함)이 있으면 차단: 신규 커밋 후 그 상태에서
#     QA 를 재수행해야 증거가 발행될 커밋 그 자체에 결속된다.
#   범위: 추적 파일 변경만(?? / !! 제외) — 미추적 파일은 발행 대상이 아님이 자명한 스크래치이고,
#   inert(문서/이미지)는 코드와 피해 등급이 달라 제외(과탐 억제). 해제: QA_WT_CLEAN_GATE=0
#   🚨 파싱은 -z(NUL) + rename 양쪽 경로 검사 (Codex HIGH/MEDIUM 2026-08-05 R2):
#     ① `git mv src/x.js docs/x.md` 는 라인 파싱+`sed '.* -> '` 로는 새 경로(inert)만 남아
#        코드 제거 rename 이 통과했다 — R/C 는 old/new **어느 한쪽이라도** 코드면 차단.
#     ② 개행/특수문자 경로는 라인 지향 파싱을 깨뜨린다 — NUL 레코드로만 파싱.
#     파서 실패는 통과가 아니라 차단(측정 불가 ≠ 통과).
if [ "${QA_WT_CLEAN_GATE:-1}" != "0" ]; then
  # 🚨 파이프와 히어독을 한 명령에 쓰지 말 것: 히어독이 python 의 stdin 을 대체해 파이프 데이터가
  #    파서에 도달하지 않는다(실측: 무음 no-op — T13 부정 테스트가 적발). temp 파일 경유.
  #    (주석에도 '<' 2연속 리터럴 금지 — 체커가 히어독 시작으로 오인, 이 파일 상단 경고와 동일 클래스)
  _ST_TMP=$(mktemp "${TMPDIR:-/tmp}/qgate-st.XXXXXX" 2>/dev/null) \
    || { echo "HARD BLOCK: push-발행 정합 검사 실패(temp 생성 불가) — 측정 불가 ≠ 통과."; exit 2; }
  # 🚨 status 실패 = 차단 (Codex R3 HIGH): exit 무시하면 실패가 빈 파일 → "clean" 오판(fail-open)
  if ! git status --porcelain -z > "$_ST_TMP" 2>/dev/null; then
    rm -f "$_ST_TMP"
    echo "HARD BLOCK: push-발행 정합 검사 실패(git status 오류) — 측정 불가 ≠ 통과."
    exit 2
  fi
  _DIRTY_CODE=$(STATUS_F="$_ST_TMP" INERT_RE="$_INERT_RE" python3 - <<'PYDIRTY'
import sys, re, os
data = open(os.environ["STATUS_F"], "rb").read().split(b"\x00")
pat = os.environ.get("INERT_RE", "")
inert = re.compile(pat, re.I) if pat else None
out = []
i = 0
while i < len(data):
    rec = data[i]; i += 1
    if not rec:
        continue
    s = rec.decode("utf-8", "replace")
    if len(s) < 4:
        continue
    xy, path = s[:2], s[3:]
    paths = [path]
    if ("R" in xy) or ("C" in xy):
        # -z 포맷: rename/copy 는 다음 NUL 레코드가 원본 경로 — 양쪽 다 검사한다
        if i < len(data) and data[i]:
            paths.append(data[i].decode("utf-8", "replace"))
            i += 1
    # 🚨 untracked 미발행 차단 (Codex P1 2026-08-06): '??' 를 스킵하면 QA 는 untracked 소스를
    #   포함한 로컬 상태를 검증했는데 push 는 HEAD 만 발행한다 — 추적 코드가 untracked 모듈을
    #   import 하면 원격 빌드가 깨진다(검증 상태 ≠ 발행 커밋). non-inert untracked 는 dirty 로
    #   취급해 커밋(또는 gitignore)을 요구한다. ignored('!!')만 발행 정합과 무관하므로 스킵.
    if xy == "!!":
        continue
    for p in paths:
        if p and not (inert and inert.search(p)):
            out.append(xy + " " + " / ".join(paths).replace("\n", "?"))
            break
    if len(out) >= 5:
        break
sys.stdout.write("\n".join(out))
PYDIRTY
) || { rm -f "$_ST_TMP"; echo "HARD BLOCK: push-발행 정합 검사 실패(상태 파서 오류) — 측정 불가 ≠ 통과."; exit 2; }
  rm -f "$_ST_TMP"
  if [ -n "$_DIRTY_CODE" ]; then
    echo "HARD BLOCK: QA 증거가 미커밋 코드 수정을 포함한 상태에 결속되어 있습니다."
    echo "  push 는 HEAD 만 발행합니다 — 검증된 미커밋 수정이 발행에서 빠집니다(검증 상태 ≠ 발행 커밋)."
    printf '%s\n' "$_DIRTY_CODE" | while IFS= read -r _d; do echo "  - $_d"; done
    echo "  → 수정을 커밋(신규 커밋, amend 금지)한 뒤 그 상태에서 QA 재수행 후 push. 해제: QA_WT_CLEAN_GATE=0"
    echo "    (untracked '??' 소스는 git add 후 커밋하거나, 산출물/상태 파일이면 .gitignore 에 추가)"
    exit 2
  fi
fi

# 3.5. TC 실행 메타데이터 검증 (qa-test-plan.md가 있는 프로젝트)
QA_PLAN="$PROJECT_ROOT/docs/qa-test-plan.md"
if [ -f "$QA_PLAN" ]; then
  # qa-test-plan.md의 CRITICAL/HIGH/MEDIUM TC 수 추출
  PLAN_CRITICAL=$(grep -c "심각도.*CRITICAL" "$QA_PLAN" 2>/dev/null); [ -n "${PLAN_CRITICAL}" ] || PLAN_CRITICAL=0
  PLAN_HIGH=$(grep -c "심각도.*HIGH" "$QA_PLAN" 2>/dev/null); [ -n "${PLAN_HIGH}" ] || PLAN_HIGH=0
  PLAN_MEDIUM=$(grep -c "심각도.*MEDIUM" "$QA_PLAN" 2>/dev/null); [ -n "${PLAN_MEDIUM}" ] || PLAN_MEDIUM=0

  # .qa-cycle-passed에 TC 메타데이터가 있는지 확인 — HARD BLOCK (WARNING 아님)
  if ! echo "$CONTENT" | grep -q "CRITICAL:"; then
    echo "HARD BLOCK: .qa-cycle-passed에 TC 실행 메타데이터 없음."
    echo "  qa-test-plan.md에 ${PLAN_CRITICAL}건 CRITICAL, ${PLAN_HIGH}건 HIGH, ${PLAN_MEDIUM}건 MEDIUM TC 존재."
    echo "  .qa-cycle-passed에 'CRITICAL: N/M PASS' 형식이 필요합니다."
    echo "  qa-cycle이 TC를 실제로 실행했는지 확인하세요."
    exit 2
  fi

  # CRITICAL TC 검증: 전수 실행 + plan과 total 교차 비교
  EXEC_CRITICAL=$(echo "$CONTENT" | grep "CRITICAL:" | grep -o "[0-9]*/[0-9]*" | head -1)
  if [ -n "$EXEC_CRITICAL" ]; then
    EXEC_NUM=$(echo "$EXEC_CRITICAL" | cut -d'/' -f1)
    EXEC_TOTAL=$(echo "$EXEC_CRITICAL" | cut -d'/' -f2)
    if [ "$EXEC_NUM" -lt "$EXEC_TOTAL" ]; then
      echo "HARD BLOCK: CRITICAL TC 미전수 실행. ${EXEC_NUM}/${EXEC_TOTAL}"
      exit 2
    fi
    # plan과 교차 비교: .qa-cycle-passed의 total과 qa-test-plan.md의 count가 다르면 경고
    if [ "$EXEC_TOTAL" -lt "$PLAN_CRITICAL" ]; then
      echo "HARD BLOCK: CRITICAL TC 수 불일치. .qa-cycle-passed: ${EXEC_TOTAL}건, qa-test-plan.md: ${PLAN_CRITICAL}건"
      exit 2
    fi
  fi

  # HIGH TC 검증: 전수 실행
  EXEC_HIGH=$(echo "$CONTENT" | grep "HIGH:" | grep -o "[0-9]*/[0-9]*" | head -1)
  if [ -n "$EXEC_HIGH" ]; then
    HIGH_NUM=$(echo "$EXEC_HIGH" | cut -d'/' -f1)
    HIGH_TOTAL=$(echo "$EXEC_HIGH" | cut -d'/' -f2)
    if [ "$HIGH_NUM" -lt "$HIGH_TOTAL" ]; then
      echo "HARD BLOCK: HIGH TC 미전수 실행. ${HIGH_NUM}/${HIGH_TOTAL}"
      exit 2
    fi
  fi

  # MEDIUM TC 검증: 전수 실행
  EXEC_MEDIUM=$(echo "$CONTENT" | grep "MEDIUM:" | grep -o "[0-9]*/[0-9]*" | head -1)
  if [ -n "$EXEC_MEDIUM" ]; then
    MED_NUM=$(echo "$EXEC_MEDIUM" | cut -d'/' -f1)
    MED_TOTAL=$(echo "$EXEC_MEDIUM" | cut -d'/' -f2)
    if [ "$MED_NUM" -lt "$MED_TOTAL" ]; then
      echo "HARD BLOCK: MEDIUM TC 미전수 실행. ${MED_NUM}/${MED_TOTAL}"
      exit 2
    fi
  fi

  # E2E TC 검증 (2026-07-24): qa-test-plan.md 에 TC-E2E 존재 시 'E2E: n/n' 전수 라인 필수
  PLAN_E2E=$(grep -c "^#### TC-E2E-" "$QA_PLAN" 2>/dev/null); [ -n "${PLAN_E2E}" ] || PLAN_E2E=0
  if [ "${PLAN_E2E:-0}" -gt 0 ]; then
    EXEC_E2E=$(echo "$CONTENT" | grep "E2E:" | grep -o "[0-9]*/[0-9]*" | head -1)
    if [ -z "$EXEC_E2E" ]; then
      echo "HARD BLOCK: qa-test-plan.md 에 TC-E2E ${PLAN_E2E}건 존재하나 .qa-cycle-passed 에 'E2E: n/n PASS' 라인 없음."
      exit 2
    fi
    E2E_NUM=$(echo "$EXEC_E2E" | cut -d'/' -f1)
    E2E_TOTAL=$(echo "$EXEC_E2E" | cut -d'/' -f2)
    if [ "$E2E_NUM" -lt "$E2E_TOTAL" ] || [ "$E2E_TOTAL" -lt "$PLAN_E2E" ]; then
      echo "HARD BLOCK: E2E TC 미전수/수 불일치. 실행 ${E2E_NUM}/${E2E_TOTAL}, plan ${PLAN_E2E}건."
      exit 2
    fi
  fi
fi

# 4. 무결성: 빌드 해시 검증 (형식: PASS|commit_hash|timestamp)
if echo "$CONTENT" | head -1 | grep -q "|"; then
  STORED_HASH=$(echo "$CONTENT" | head -1 | cut -d'|' -f2)
  CURRENT_HASH=$(git rev-parse --short HEAD 2>/dev/null)
  if [ -n "$STORED_HASH" ] && [ "$STORED_HASH" != "$CURRENT_HASH" ]; then
    echo "HARD BLOCK: QA 이후 새 커밋이 발생. .qa-cycle-passed 해시($STORED_HASH)와 HEAD($CURRENT_HASH) 불일치. QA를 다시 수행하세요."
    exit 2
  fi
fi

# === CODEX REVIEW GATE (HARD) ===
# .codex-review-passed 파일 없으면 push 차단. exit 2.
# 이 파일은 codex review 완료 시 생성됨.
# 생성 주체: codex-review-gate.sh (SubagentStop/TaskCompleted) 또는 auto-adversarial-review.sh (codex CLI)
CODEX_EVIDENCE="$PROJECT_ROOT/.codex-review-passed"

# /codex-gate push off 존중 + safety ratchet (auto-adversarial-review.sh 체크①과 동일 floor 의미):
#   config(PUSH_GATE)=on 은 floor 다 — env(AUTO_ADVERSARIAL_REVIEW=off)로 끌 수 없다. env 는 config 가
#   off/미지정일 때만 일회성 ENABLE(on) 가능(게이트를 올릴 수만, 내릴 수 없음). 은닉/지속 env(shell 프로파일·
#   launchctl 등)가 켜진 게이트를 조용히 뚫는 것 차단. 끄려면 '/codex-gate push off'(가시적·영속·의도적).
# off 이면 Codex 크로스 리뷰(.codex-review-passed) 요구를 스킵한다 (Claude QA/ACCEPTANCE 게이트는 위에서 이미 강제).
# 🚨 config 는 mutable $HOME 가 아니라 passwd DB 실제 홈에서 (conformance-baseline-correctness 부록3):
#   'HOME=$(mktemp) git push' 로 config 를 숨겨 게이트를 off 로 떨구는 우회 차단. 해석 유틸은 신뢰 PATH 만.
#   ⚠️ ①과 달리 config 불가/부재 시 fail-OPEN(off) 유지 — ②는 항상 hook 이라 fail-closed 면 codex-less/
#      config-chmod 머신의 모든 push 를 wedge 한다. ②의 차단은 .codex-review-passed(codex 로만 생성) 요구뿐이라
#      config 불명 시 요구 스킵이 안전(과잉차단 대신 과소차단; 위 codex-missing fail-open 주석과 정합).
#   구조적 한계(수렴 2026-07-22): dscl(macOS)·getent(Linux) 둘 다 없는 exotic/minimal 시스템은 신뢰
#      identity 소스가 없어 _RHOME 이 mutable $HOME 로 폴백 → 그런 시스템에선 HOME-spoof 가 다시 가능.
#      (실제 macOS엔 항상 dscl, Linux엔 getent 존재; exotic 시스템 + HOME 조작 = 의도적 operator, 위협모델 밖.)
_SPATH="/usr/bin:/bin:/usr/sbin:/sbin"
_RHOME="$HOME"; _u=$(PATH="$_SPATH" id -un 2>/dev/null)
if [ -n "$_u" ]; then
  if PATH="$_SPATH" command -v dscl >/dev/null 2>&1; then
    _h=$(PATH="$_SPATH" dscl . -read "/Users/$_u" NFSHomeDirectory 2>/dev/null | PATH="$_SPATH" sed -n "s/^NFSHomeDirectory: *//p")
  elif PATH="$_SPATH" command -v getent >/dev/null 2>&1; then
    _h=$(PATH="$_SPATH" getent passwd "$_u" 2>/dev/null | PATH="$_SPATH" cut -d: -f6)
  fi
  [ -n "${_h:-}" ] && [ -d "$_h" ] && _RHOME="$_h"
fi
_CFG=$(PATH="$_SPATH" sed -n "s/^PUSH_GATE=//p" "$_RHOME/.claude/config/codex-gates.conf" 2>/dev/null | PATH="$_SPATH" head -1 | PATH="$_SPATH" tr "[:upper:]" "[:lower:]")
_CODEX_GATE_ON=0
case "$_CFG" in
  on|true|1|yes|enabled) _CODEX_GATE_ON=1 ;;   # config=on → floor (env 무관, 끌 수 없음)
  *)
    case "$(printf '%s' "${AUTO_ADVERSARIAL_REVIEW:-off}" | tr '[:upper:]' '[:lower:]')" in
      on|true|1|yes|enabled) _CODEX_GATE_ON=1 ;;   # config off/미지정 → env 로 일회성 ENABLE 만
    esac ;;
esac
# (쿼터 hold 판정은 아래 _CODEX_QUOTA_HOLD 블록에서 SSOT 마커로 일원화 — 2026-08-08 R3)

# 🚨 강제 조건 = config=on(위 floor) + auth.json@passwd-실제홈 존재. **PATH 무관**(Codex R4 CRITICAL:
#   `command -v codex` 는 PATH 의존 → `PATH=/usr/bin:/bin git push` 로 codex 숨겨 스킵 가능했음. 제거).
#   auth.json 을 signal 로: 있으면(=codex 설정된 머신) 강제, 없으면(codex-less dev/CI) 스킵=fail-open.
#   ①과 달리 fail-OPEN 인 이유: ②는 codex 를 실행하지 않고 이미 생성된 .codex-review-passed **파일만**
#   검사한다(그 파일은 codex 로만 생성). auth 부재 머신에서 fail-closed 하면 PUSH_GATE=on(글로벌 config,
#   동기화됨)이 모든 push 를 영구 wedge 한다. auth.json 은 $_RHOME(passwd홈)에서 읽어 HOME 스푸핑에도 면역.
#   구조적 한계(수렴 2026-07-22 R7): fail-open signal 인 auth.json 을 operator 가 `mv ~/.codex/auth.json /tmp;
#   git push` 로 일시 제거하면 강제를 스킵할 수 있다. 그러나 이는 자기 FS 를 조작하는 **의도적 operator**
#   (위협모델 밖; config 편집·/codex-gate push off·CODEX_BYPASS_QA_GATE 와 동급). fail-open 을 fail-closed 로
#   바꾸면 codex-less 머신을 wedge 하므로, 어떤 fail-open signal(auth/codex/config)도 operator 제거엔 무력하다.
# 🚨 쿼터 소진 보류 (2026-08-06 실측): 마커가 codex-quota-exhausted 면 리뷰어가 한도 리셋일까지
#   실행 불가능한 상태다 — auth.json 부재(codex-less 머신 fail-open 스킵)와 동일한 '도구 가용성'
#   클래스이므로 같은 의미론을 적용해 codex 증거 요구를 보류한다(코드결함 FAIL·판정 ERROR 는
#   종전대로 차단). Claude QA(.qa-cycle-passed)/ACCEPTANCE 게이트는 위에서 이미 강제됐다.
#   마커 위조로 이 보류를 얻는 것은 auth.json 을 mv 하는 것과 동급의 의도적 operator 행위로
#   문서화된 위협모델 밖(R-B). — external-probe-gate-classification: 한도 실패는 차단이 아니라 보류.
_CODEX_QUOTA_HOLD=0
# 🚨 판정은 SSOT epoch 마커로만 (교차리뷰 CRITICAL 2026-08-08 R3): 종전의 프로젝트-로컬
#   '.codex-review-passed 첫 줄 codex-quota-exhausted 문자열' 증거는 **만료가 없어** 쿼터 회복
#   후에도 무기한 보류를 얻는 우회였다(생성 후 수동 삭제 전까지 영구). epoch 마커는 리셋 시각
#   경과 시 자동으로 hold 가 풀려 재강제된다 — 사용자 계약(off 동일 스킵)과 자동 복귀를 동시 충족.
if bash "$_RHOME/.claude/scripts/codex-quota-hold.sh" check 2>/dev/null; then
  _CODEX_QUOTA_HOLD=1
  echo "⚠ Codex 쿼터 hold(epoch 마커) — 크로스 리뷰 요구 보류 (리셋 경과 시 자동 재강제)." >&2
fi
if [ "$_CODEX_QUOTA_HOLD" != "1" ] && [ "$_CODEX_GATE_ON" = "1" ] && [ -f "$_RHOME/.codex/auth.json" ]; then
  if [ ! -f "$CODEX_EVIDENCE" ]; then
    echo "HARD BLOCK: Codex 크로스 리뷰 미실행. .codex-review-passed 파일이 없습니다. auto-adversarial-review.sh (codex CLI) 로 크로스 리뷰를 먼저 수행하세요."
    exit 2
  fi

  CODEX_CONTENT=$(cat "$CODEX_EVIDENCE" 2>/dev/null)
  if ! echo "$CODEX_CONTENT" | grep -q "PASS"; then
    echo "HARD BLOCK: Codex 리뷰 PASS가 아닙니다. CRITICAL 이슈를 수정하세요."
    exit 2
  fi

  CODEX_TIME=$(stat -f %m "$CODEX_EVIDENCE" 2>/dev/null || stat -c %Y "$CODEX_EVIDENCE" 2>/dev/null || echo 0)
  # 🚨 mtime 신선도 폐기(2026-08-03) → 상태 결속. Codex 리뷰도 "언제 했나"가 아니라
  #   "무엇을 리뷰했나"가 기준이다. 리뷰 시점 워킹트리와 현재가 다르면 그 리뷰는 무효.
  # 🚨 `no-code-changes` 마커는 **Codex 를 실행하지 않고** 기록된다(생산자가 변경 없음으로 판단).
  #   wt_sha 가 붙어 있어도 그것은 '리뷰했다'는 증거가 아니다 — push 범위에 코드가 있으면 거부한다.
  if head -1 "$CODEX_EVIDENCE" 2>/dev/null | grep -q 'no-code-changes'; then
    _rng_code=$(printf '%s\n' "${ACC_RANGE_FILES:-}" \
      | grep -v '^$' | grep -icvE "$_INERT_RE" || true)
    if [ "${_rng_code:-0}" -gt 0 ]; then
      echo "HARD BLOCK: .codex-review-passed 가 'no-code-changes' 마커인데 push 범위에 코드 변경 ${_rng_code}건."
      echo "  이 마커는 Codex 실행 없이 기록됩니다 — 커밋된 변경의 리뷰 증거가 아닙니다."
      echo "  → auto-adversarial-review.sh (codex CLI) 로 실제 리뷰를 수행하세요."
      exit 2
    fi
  fi
  # 🚨 리뷰 범위 ⊇ push 범위 검사(Codex HIGH 2026-08-04): wt_sha 는 상태 동일성만 증명한다.
  #   생산자가 기록한 리뷰 base 가 실제 push base 의 조상(또는 동일)이어야 '리뷰한 범위가
  #   푸시 범위를 덮는다'가 성립한다. 아니면 다른(또는 빈) 범위를 리뷰한 PASS 를 재사용하는 것.
  # base=uncommitted-only 는 '커밋된 변경을 리뷰하지 않았다'는 뜻이다(Codex HIGH 2026-08-04).
  #   push 범위에 코드가 있으면 그 PASS 로는 승인할 수 없다 — 미리뷰 first-push 승인 차단.
  if grep -q 'base=uncommitted-only' "$CODEX_EVIDENCE" 2>/dev/null; then
    _uc_code=$(printf '%s\n' "${ACC_RANGE_FILES:-}" \
      | grep -v '^$' | grep -icvE "$_INERT_RE" || true)
    if [ "${_uc_code:-0}" -gt 0 ]; then
      echo "HARD BLOCK: Codex 리뷰가 uncommitted 만 대상이었는데 push 범위에 코드 ${_uc_code}건(커밋 포함)."
      echo "  → 원격 base 를 잡을 수 있는 상태에서 재리뷰하거나, 커밋 범위를 리뷰하세요."
      exit 2
    fi
  fi
  # 🚨 모호한 push 는 fail-closed (Codex HIGH 2026-08-04): `git push --all`·다중 refspec·matching
  #   에서는 ACC_BASE 가 비어 포함검사가 통째로 건너뛰어진다 → 현재 브랜치용 PASS 를 재사용해
  #   **다른 로컬 브랜치의 미리뷰 코드**가 함께 올라간다. 커버리지를 증명할 수 없으면 막는다.
  #   ⚠️ 조건은 **모호성(ACC_AMBIG)만** 본다. ACC_BASE 가 비었다고 막으면 원격이 아직 없는
  #      정당한 first-push(`git push origin master`)까지 영구 차단된다(실측 오차단). 그 경우는
  #      위의 base_sha/uncommitted-only 검사가 담당한다.
  if [ "${ACC_AMBIG:-0}" = "1" ]; then
    _amb_code=$(printf '%s\n' "${ACC_RANGE_FILES:-}" | grep -v '^$' | grep -icvE "$_INERT_RE" || true)
    if [ "${_amb_code:-0}" -gt 0 ]; then
      echo "HARD BLOCK: push 대상이 모호해 리뷰 커버리지를 증명할 수 없습니다 (--all / 다중 refspec / matching)."
      echo "  push 범위 내 검사대상 ${_amb_code}건 — 어떤 ref 가 리뷰됐는지 확정 불가."
      echo "  → 구체적 refspec 으로 push 하세요: git push origin <branch>"
      exit 2
    fi
  fi
  # 🚨 리뷰한 tip == 실제 push 되는 tip (Codex HIGH 2026-08-04): base 조상관계와 CURRENT_WT 는
  #   **체크아웃된 브랜치** 기준이라, main 을 리뷰하고 `git push origin evil_branch` 하면
  #   미리뷰 브랜치가 통과한다. 리뷰 시점 tip 을 기록해 push 대상 tip 과 대조한다.
  _REV_TIP=$(grep -m1 -oE 'tip_sha=[a-f0-9]{7,}' "$CODEX_EVIDENCE" 2>/dev/null | cut -d= -f2)
  if [ -n "${ACC_TIP:-}" ]; then
    _push_tip=$(git rev-parse "$ACC_TIP" 2>/dev/null)
    if [ -n "$_push_tip" ] && [ -n "$_REV_TIP" ] && [ "$_REV_TIP" != "$_push_tip" ]; then
      echo "HARD BLOCK: 리뷰한 tip 과 push 대상 tip 이 다릅니다."
      echo "  리뷰: ${_REV_TIP:0:12}...  push: ${_push_tip:0:12}... ($ACC_TIP)"
      echo "  → push 하려는 ref 를 체크아웃한 상태에서 재리뷰하세요."
      exit 2
    fi
  fi
  _REV_BASE_SHA=$(grep -m1 -oE 'base_sha=[a-f0-9]{7,}' "$CODEX_EVIDENCE" 2>/dev/null | cut -d= -f2)
  if [ -n "$_REV_BASE_SHA" ] && [ -n "${ACC_BASE:-}" ]; then
    if git rev-parse --verify -q "$ACC_BASE" >/dev/null 2>&1; then
      # 🚨 조상 관계가 아니라 **커밋 집합 포함**으로 판정한다 (Codex HIGH 2026-08-04 R2).
      #   직전 판(_cov_target=ACC_TIP, push tip 조상 검사)은 사실상 무력했다 — 리뷰 base 는
      #   거의 항상 HEAD 의 조상이므로 통과한다. 실증 시나리오: `--base origin/feature` 로
      #   리뷰한 뒤 그 브랜치를 **main 으로** push 하면, feature 에는 있지만 main 에 없는
      #   커밋들이 push 범위에 포함되는데 리뷰 범위 밖이라 미리뷰로 통과했다.
      #   ACC_BASE 는 merge-base 가 아니라 **push 목적지 ref**(origin/$ACC_DST 등)다.
      #   정확한 요건: push 범위(ACC_BASE..ACC_TIP) ⊆ 리뷰 범위(_REV_BASE_SHA..HEAD).
      #   차집합이 비어야 통과 — 조상 관계 엣지케이스(rebase·분기)에 흔들리지 않는다.
      if ! git rev-parse --verify -q "${_REV_BASE_SHA}^{commit}" >/dev/null 2>&1; then
        echo "HARD BLOCK: Codex 리뷰의 base_sha(${_REV_BASE_SHA:0:12})가 이 저장소에 없습니다(rebase/삭제)."
        echo "  → 현재 상태로 재리뷰하세요."
        exit 2
      fi
      _unreviewed=$(comm -23 \
        <(git rev-list "${ACC_BASE}..${ACC_TIP}" 2>/dev/null | sort) \
        <(git rev-list "${_REV_BASE_SHA}..HEAD" 2>/dev/null | sort) 2>/dev/null | head -5)
      if [ -n "$_unreviewed" ]; then
        echo "HARD BLOCK: push 범위에 리뷰되지 않은 커밋이 있습니다."
        echo "  목적지: $ACC_BASE  →  push tip: ${ACC_TIP}"
        echo "  리뷰 범위: ${_REV_BASE_SHA:0:12}..HEAD"
        echo "  미리뷰 커밋(최대 5):"
        printf '%s\n' "$_unreviewed" | while IFS= read -r _c; do
          echo "    $(git log -1 --format='%h %s' "$_c" 2>/dev/null | cut -c1-80)"
        done
        echo "  → 이 목적지 기준으로 재리뷰하세요 (다른 범위의 PASS 재사용 차단)."
        exit 2
      fi
    fi
  fi
  # 🚨 fail-closed (Codex HIGH 2026-08-04): wt_sha 만 맞고 base_sha·센티널이 **둘 다 없으면**
  #   범위 검사가 통째로 건너뛰어져 미리뷰 커밋 범위가 통과했다(레거시/SKIP 마커 경로).
  #   코드 변경이 있는 push 에는 리뷰 범위 근거를 필수로 요구한다.
  if ! grep -qE 'base_sha=[a-f0-9]{7,}|base=uncommitted-only' "$CODEX_EVIDENCE" 2>/dev/null; then
    _nb_code=$(printf '%s\n' "${ACC_RANGE_FILES:-}" | grep -v '^$' | grep -icvE "$_INERT_RE" || true)
    if [ "${_nb_code:-0}" -gt 0 ]; then
      echo "HARD BLOCK: .codex-review-passed 에 리뷰 범위 근거(base_sha= 또는 base=uncommitted-only)가 없습니다."
      echo "  push 범위에 리뷰 필요 변경 ${_nb_code}건 — 범위를 증명하지 못하는 PASS 는 통과시키지 않습니다."
      exit 2
    fi
  fi
  CODEX_WT=$(grep -m1 -oE 'wt_sha=[a-f0-9]{16,}' "$CODEX_EVIDENCE" 2>/dev/null | cut -d= -f2)
  if [ -z "$CODEX_WT" ]; then
    echo "HARD BLOCK: .codex-review-passed 에 상태 결속(wt_sha=) 없음. 리뷰 재수행 후 기록하세요:"
    echo "  echo \"PASS wt_sha=\$( { git rev-parse HEAD; git status --porcelain; git diff HEAD; git ls-files -o --exclude-standard -z | while IFS= read -r -d '' f; do git hash-object -- \"\$f\"; done; } | shasum -a 256 | awk '{print \$1}')\" > .codex-review-passed"
    exit 2
  elif [ "$CODEX_WT" != "$CURRENT_WT" ] && [ "$CODEX_WT" != "$CURRENT_WT_V2" ]; then
    echo "HARD BLOCK: Codex 리뷰 이후 변경 발생 — 리뷰가 검증한 상태와 push 대상이 다릅니다(v1·v2 모두 불일치). 재리뷰 필수."
    exit 2
  fi
fi

# === UI 변경 시 BROWSER EVIDENCE HARD GATE (2026-04-21 NEW) ===
# UI 파일 변경 감지 시 .qa-evidence.json 전체 HARD 체크
# task-quality-gate.sh가 우회되는 경로(직접 push)에 대한 안전망
if [ -n "$UI_CHANGES" ]; then
  if [ ! -f "$BROWSER_EVIDENCE" ]; then
    echo "HARD BLOCK: UI 파일 변경 감지. .qa-evidence.json이 없습니다. 브라우저 QA(webapp-testing 절차 직접 수행 또는 web-qa-tester) 실행 필수."
    exit 2
  fi
  BEV_TIME=$(stat -f %m "$BROWSER_EVIDENCE" 2>/dev/null || stat -c %Y "$BROWSER_EVIDENCE" 2>/dev/null || echo 0)
  # 🚨 mtime 신선도 폐기(2026-08-03) → 상태 결속. `verified_wt_sha` 가 QA 시점 워킹트리를
  #   가리키고, 지금과 다르면 그 브라우저 증거는 **다른 화면을 검증한 것**이므로 무효.
  # 🚨 경로를 파이썬 소스에 보간 금지 (Codex P2 2026-08-06): 저장소 경로에 아포스트로피가
  #   있으면 단일인용 리터럴이 깨져 예외가 삼켜지고 모든 UI push 가 '지문 없음'으로 거부된다
  #   (거짓 차단). 아래 BEV_CHECK 블록과 동일하게 env 로 전달한다.
  BEV_WT=$(BEV_PATH="$BROWSER_EVIDENCE" python3 -c "
import json,os
try: print(json.load(open(os.environ['BEV_PATH'])).get('verified_wt_sha') or '')
except Exception: print('')
" 2>/dev/null)
  if [ -z "$BEV_WT" ]; then
    echo "HARD BLOCK: .qa-evidence.json 에 verified_wt_sha 없음 (상태 결속 필수 — mtime 신선도는 폐기됨)."
    echo "  브라우저 QA(webapp-testing 절차) 재실행 후 QA 시점 워킹트리 해시를 기록하세요:"
    echo "    { git rev-parse HEAD; git status --porcelain; git diff HEAD; git ls-files -o --exclude-standard -z | while IFS= read -r -d '' f; do git hash-object -- \"\$f\"; done; } | shasum -a 256 | awk '{print \$1}'"
    exit 2
  elif [ "$BEV_WT" != "$CURRENT_WT" ] && [ "$BEV_WT" != "$CURRENT_WT_V2" ]; then
    echo "HARD BLOCK: QA 이후 변경 발생 — .qa-evidence.json 이 검증한 상태와 push 대상이 다릅니다(v1·v2 모두 불일치)."
    echo "  QA 시점: ${BEV_WT:0:16}...  현재: ${CURRENT_WT:0:16}...  → 브라우저 QA(webapp-testing 절차) 재실행 필수."
    exit 2
  fi

  # task-quality-gate.sh와 동일한 필드 체크 (HARD BLOCK 항목 전체 — 2026-04-22 parity)
  DB_RANGE_TMP=$(mktemp "${TMPDIR:-/tmp}/qgate-range.XXXXXX" 2>/dev/null) || DB_RANGE_TMP=""
  # UI 감지와 같은 범위(폴백 적용된 DB_SCOPE_FILES)를 넘긴다 — 한쪽만 폴백하면 정당한 면제가 차단된다
  [ -n "$DB_RANGE_TMP" ] && printf '%s\n' "${DB_SCOPE_FILES:-$ACC_RANGE_FILES}" > "$DB_RANGE_TMP" 2>/dev/null
  # 🚨 경로를 python **소스에 보간하지 않는다** — 디렉토리 이름에 따옴표/코드가 들어가면
  #    임의 파이썬이 실행된다(Codex CRITICAL). env 로 전달하고 os.environ 으로 읽는다.
  BEV_CHECK=$(DB_RANGE_FILE="$DB_RANGE_TMP" BEV_PATH="$BROWSER_EVIDENCE" PROJ_ROOT="$PROJECT_ROOT" python3 -c "
import json, os, sys
try:
    d = json.load(open(os.environ['BEV_PATH']))
    issues = []
    bt = d.get('browser_test', {})
    if not bt.get('executed'):
        issues.append('browser_test.executed=false')
    ce = bt.get('console_errors', 0)
    if ce and int(ce) > 0:
        issues.append('console_errors=' + str(ce))
    if not bt.get('mobile_tested'):
        issues.append('mobile_tested=false')
    # 모바일 증거는 자기신고 플래그 하나로 끝나면 안 된다 — 실제 375 폭 실행 흔적과 판정을 함께 요구한다.
    # (실측 사고: mobile_tested=false + mobile_375px='SKIP' 이 'agent-browser resize 미지원'이라는
    #  틀린 사유로 넘어갔다. 뷰포트 변경은 정상 동작한다 → scripts/qa-mobile.sh 로 재현 가능.)
    vps = bt.get('viewports') or []
    if not any(str(v).strip().startswith('375') for v in vps):
        issues.append('viewports 에 375 폭 없음: ' + (','.join(map(str, vps)) or '비어있음'))

    # checks 필드 4종 전수 (ui_render 포함)
    checks = d.get('checks', bt.get('checks', {}))
    if not checks:
        issues.append('checks 필드 누락')
    else:
        # 허용값 화이트리스트 — FAIL/SKIP/빈값만 막으면 예상 밖 truthy 문자열('OK','done' 등)이
        # 통과해 문서의 'PASS 를 요구한다'는 주장과 어긋난다(독립 리뷰 지적). 명시 허용만 통과.
        for key in ['ui_render', 'text_content', 'api_response_codes', 'roundtrip_crud', 'mobile_375px']:
            val = str(checks.get(key, '')).strip()
            if val == 'FAIL':
                issues.append('checks.' + key + '=FAIL')
            elif not val or val == 'SKIP':
                issues.append('checks.' + key + ' 미실행')
            elif key == 'mobile_375px' and val != 'PASS':
                # 모바일은 N/A 를 인정하지 않는다 — 정적 사이트의 모든 페이지가 모바일 표면이고,
                # N/A 를 열어두면 자기신고 플래그만으로 모바일 검증을 건너뛸 수 있다(Codex HIGH).
                issues.append('checks.mobile_375px 는 PASS 만 인정: ' + val[:20])
            elif val not in ('PASS', 'N/A'):
                issues.append('checks.' + key + ' 값이 PASS/N/A 아님: ' + val[:20])

    # interaction_test 전체 (buttons + popups + forms)
    interaction = d.get('interaction_test', {})
    if not interaction:
        issues.append('interaction_test 누락')
    else:
        btn_total = interaction.get('buttons_total', 0)
        btn_tested = interaction.get('buttons_tested', 0)
        if btn_total > 0 and btn_tested < btn_total:
            issues.append('버튼 미전수: ' + str(btn_tested) + '/' + str(btn_total))
        elif btn_total == 0:
            # 0 은 두 가지다: '안 셌다'(누락) vs '실제로 인터랙티브 표면이 없다'(정적 문서).
            # 후자를 차단하면 정적 산출물은 통과가 구조적으로 불가능해진다 → 실측 신고를 요구해 구분한다.
            # 🚨 이 블록은 python3 -c 큰따옴표 문자열 안에 들어간다 — 주석에도 큰따옴표 금지
            #    (실측 2026-08-05: 주석의 따옴표가 셸 문자열을 조기 종료시켜 IndentationError,
            #     BEV_CHECK 가 빈 값이 되고 게이트가 모든 push 를 차단했다).
            # no_interactive_surface=true 는 a/button/input/onclick 을 실제로 세어 0이었다는 주장이며
            # note 에 그 근거를 남겨야 한다(빈 note 로는 통과 못 함).
            if not (interaction.get('no_interactive_surface') is True
                    and str(interaction.get('note', '')).strip()):
                issues.append('interaction_test.buttons_total 누락'
                              ' (인터랙티브 표면이 실제로 0이면 no_interactive_surface=true + note 근거)')
        if interaction.get('popups_tested') is None:
            issues.append('interaction_test.popups_tested 미기록')
        if 'forms_submitted' not in interaction:
            issues.append('interaction_test.forms_submitted 미기록')

    # screenshot_evidence 파일 존재
    screenshots = d.get('screenshot_evidence', [])
    if not screenshots:
        issues.append('screenshot_evidence 비어있음')
    else:
        missing = [s for s in screenshots if not os.path.exists(s)]
        if missing:
            issues.append('스크린샷 파일 없음 ' + str(len(missing)))

    # api_logs 전체 (error_count 포함)
    api_logs = d.get('api_logs', {})
    if not api_logs.get('captured'):
        issues.append('api_logs.captured=false')
    api_err = api_logs.get('error_count', 0)
    if api_err and int(api_err) > 0:
        issues.append('api_logs.error_count=' + str(api_err))

    # db_verification 전체 (crud_roundtrip 포함)
    db_v = d.get('db_verification', {})
    crud = db_v.get('crud_roundtrip', 'MISSING')
    if crud not in ('PASS', 'N/A'):
        issues.append('db_verification.crud_roundtrip=' + str(crud))
    # DB 계층 부재는 evidence 자기신고로 인정하지 않는다(자유 텍스트 note 는 우회 가능).
    # 게이트가 저장소를 직접 스캔해 독립 판정하고, 지표가 하나라도 있으면 면제하지 않는다(fail-closed).
    DBSIG = ('supabase','prisma','pg','pg-promise','postgres','mysql','mysql2','mongoose','mongodb',
             'sqlite3','better-sqlite3','knex','typeorm','sequelize','drizzle-orm','redis','ioredis',
             'psycopg2','psycopg','sqlalchemy','asyncpg','pymongo','pymysql','alembic','django')
    def _db_layer(root):
        for dd in ('supabase','prisma','migrations','db/migrate'):
            if os.path.isdir(os.path.join(root, dd)):
                return 'dir:' + dd
        SKIP = {'node_modules','.git','.next','dist','build','.venv','out','coverage'}
        for dp, dns, fns in os.walk(root):
            dns[:] = [x for x in dns if x not in SKIP]
            for fn in fns:
                if fn.endswith('.sql'):
                    return 'sql:' + os.path.relpath(os.path.join(dp, fn), root)
        pj = os.path.join(root, 'package.json')
        if os.path.isfile(pj):
            try:
                _pd = json.load(open(pj))
            except Exception:
                return 'unreadable:package.json'
            for nm in list(_pd.get('dependencies', {})) + list(_pd.get('devDependencies', {})):
                # @supabase/supabase-js 처럼 스코프에만 단서가 있는 경우가 있어 이름 전체를 토큰화해 대조한다
                toks = set(nm.lower().lstrip('@').replace('/', '-').split('-'))
                if nm.lower() in DBSIG or toks & set(DBSIG):
                    return 'dep:' + nm
        for rf in ('requirements.txt','pyproject.toml','pom.xml','build.gradle','build.gradle.kts'):
            rp = os.path.join(root, rf)
            if not os.path.isfile(rp):
                continue
            try:
                _tx = open(rp, encoding='utf-8', errors='replace').read().lower()
            except Exception:
                return 'unreadable:' + rf
            for kw in DBSIG + ('jdbc','hibernate','spring-boot-starter-data'):
                if kw in _tx:
                    return 'dep:' + rf + ':' + kw
        return None
    try:
        db_layer = _db_layer(os.environ['PROJ_ROOT'])
    except Exception as _e:
        db_layer = 'scan-failed:' + str(_e)
    # 의존 목록은 본질적으로 불완전하다(Firebase·DynamoDB·사내 SDK·raw HTTP 는 지표에 안 잡힌다).
    # 그래서 '이 push 가 데이터 계층에 닿을 수 있는가'를 변경 범위로 한 번 더 좁힌다.
    # 표현 자산(HTML/CSS/i18n/이미지/문서)만 바뀐 push 는 DB 검증 자체가 성립하지 않는다.
    # 자막(.srt/.vtt)·폰트·이미지처럼 데이터 계층에 닿을 수 없는 산출물은 표현 자산이다.
    # 빠뜨리면 정당한 db_verification=N/A 가 '표현 자산 밖'으로 오분류돼 거짓 차단이 된다
    # (2026-08-05 실측: video/subtitles.en.srt 가 code: 로 분류돼 문서-only push 가 막힘).
    PRESENTATION = ('.html','.htm','.css','.scss','.md','.txt','.png','.jpg','.jpeg',
                    '.webp','.svg','.gif','.ico','.woff','.woff2','.pdf',
                    '.srt','.vtt','.ass')
    SERVER_HINT = ('api/','server/','functions/','supabase/','prisma/','migrations/',
                   'backend/','lambda/','worker/','edge/')
    _rf = os.environ.get('DB_RANGE_FILE', '')
    try:
        rng = [x.strip() for x in open(_rf, encoding='utf-8').read().splitlines() if x.strip()] if _rf else []
    except Exception:
        rng = []
    data_touch = None
    for fp in rng:
        low = fp.lower()
        if any(low.startswith(h) or ('/' + h) in low for h in SERVER_HINT):
            data_touch = 'path:' + fp
            break
        base = os.path.basename(low)
        # 확장자가 없는 알려진 무해 파일 — DB 계층에 닿을 수 없다. 여기 없으면 code 로 분류돼
        # 정당한 db_verification=N/A 가 거짓 차단된다(실측 2026-08-05: .gitignore).
        if base in ('.gitignore', '.gitattributes', '.editorconfig', '.nvmrc',
                    '.prettierignore', '.eslintignore', '.npmrc', '.dockerignore',
                    'license', 'notice', 'changelog', 'codeowners', '.gitkeep'):
            continue
        ext = os.path.splitext(low)[1]
        if ext in PRESENTATION:
            continue
        if ext == '.json':
            if low.startswith('i18n/') or '/i18n/' in low or os.path.basename(low).startswith('og-'):
                continue
            data_touch = 'json:' + fp
            break
        data_touch = 'code:' + fp
        break
    if not rng:
        data_touch = 'range-unknown'
    _db_note_ok = bool(str(db_v.get('note', '')).strip())
    db_na = ((crud == 'N/A') and _db_note_ok
             and (db_layer is None) and (data_touch is None))
    # 2026-08-13 hugh-soft-site 실측: db_layer None(전 repo 스캔 DB 지표 0) repo 의 코드 push 는
    # 질의할 DB 가 없어 queries_executed 를 정직하게 채울 방법이 없고 data_touch 백스톱만으로
    # 영구 차단된다 -- 가드를 푸는 조건을 가드가 막는 클래스. 이 조합만 차단 대신 경고로 강등.
    # db_layer 가 하나라도 잡히면(의존/sql/디렉토리) 기존대로 차단 -- 백스톱 본래 목적 유지.
    if ((crud == 'N/A') and (db_layer is None) and (data_touch is not None)
            and _db_note_ok and (not db_v.get('queries_executed'))):
        print('WARN: db_verification N/A 수용 -- repo 스캔 DB 지표 0, 변경에 코드 포함('
              + str(data_touch) + '). raw HTTP 데이터 경로는 이 게이트가 못 본다', file=sys.stderr)
        db_na = True
    if not db_v.get('queries_executed') and not db_na:
        if crud == 'N/A' and db_layer is not None:
            issues.append('db_verification: N/A 신고했으나 저장소에 DB 계층 지표(' + str(db_layer) + ')')
        elif crud == 'N/A' and data_touch is not None:
            issues.append('db_verification: N/A 신고했으나 변경 범위가 표현 자산 밖(' + str(data_touch) + ')')
        else:
            issues.append('db_verification.queries_executed=false')
    db_note = ''
    if db_na:
        db_note = '면제 — 저장소 스캔·변경 범위 모두 DB 계층 없음. 사유: ' + str(db_v.get('note'))[:60]

    vdt = d.get('verdict', 'MISSING')
    if vdt != 'PASS':
        issues.append('verdict=' + str(vdt))
    print('BLOCK:' + '; '.join(issues) if issues else 'PASS')
    if not issues and db_note:
        print('NOTE:' + db_note)
except Exception as e:
    print('BLOCK:파싱 오류 ' + str(e))
" 2>/dev/null)

  [ -n "$DB_RANGE_TMP" ] && rm -f "$DB_RANGE_TMP"
  BEV_VERDICT=$(printf '%s\n' "$BEV_CHECK" | head -1)
  printf '%s\n' "$BEV_CHECK" | { grep '^NOTE:' || [ $? -eq 1 ]; } | sed 's/^NOTE:/  ℹ /' >&2
  # 빈 값·크래시·예상밖 출력은 검사 불가이므로 통과가 아니라 차단이다(fail-closed)
  if [ "$BEV_VERDICT" != "PASS" ]; then
    REASON=$(printf '%s' "$BEV_VERDICT" | sed 's/^BLOCK://')
    [ -z "$REASON" ] && REASON="증거 검사가 결과를 내지 못했습니다(빈 출력 — 실행 실패 가능)"
    echo "HARD BLOCK: .qa-evidence.json 검증 실패"
    echo "  $REASON"
    exit 2
  fi
fi

exit 0
