#!/bin/bash
# secret-content-scan.sh — PreToolUse[Bash] git add/commit 시 스테이징 diff의 시크릿 "내용" 스캔
#   rule: secret-scanning-depth (프로즈 → 실행형 승격, 2026-07-20)
#
# no-env-commit.sh 는 파일명(.env 등)만 차단한다. 이 게이트는 **내용**을 스캔한다 —
# 평문 키 접두사(sk-·AKIA·ghp_)뿐 아니라 JSON 값·export 할당 형태까지 (secret-scanning-depth).
#
# 트리거: git add / git commit 계열. 스테이징된 diff 에 시크릿 패턴이 있으면 exit 2.
# bypass: SECRET_SCAN_SKIP=1

#
# ⚠️ 본질적 한계 (정규식/파서 hook — agent-browser-security 의 "정규식 hook 수학적 한계"와 동일):
#   이 게이트는 흔한 add/commit 패턴(체인·-C·cd·-A·pathspec·shell확장 타겟·별 repo)을 막는 보조
#   안전망이다. 그러나 **정적 분석으로 완전 차단은 수학적으로 불가능**하다 — git 별칭(alias.ci=commit),
#   래퍼 함수/스크립트, 다른 언어(python subprocess)에서의 커밋, GIT_DIR/env 조작, 런타임 명령 조립은
#   무한 변형이라 정규식이 계속 뚫린다(Codex 7R 적대리뷰가 매 라운드 새 shell 변형 발견 — 수렴 불가 실증).
#   **구조적으로 올바른 방어는 이 PreToolUse 게이트가 아니라 대상 repo 안의 git pre-commit hook / CI
#   시크릿 스캐너**다 — 실제 커밋 시점에 실제 repo 에서 돌아 명령 문자열 파싱에 의존하지 않는다.
#   이 게이트는 그 앞단의 조기경보(best-effort)일 뿐. 선언된 경계(2026-09-20 Codex HIGH): 한 Bash 입력 안에서
#   `git add safe && <파일 수정> && git add safe && git commit` 처럼 검사 뒤에 내용을 바꾸는 TOCTOU 는 PreToolUse 시점의
#   훅이 원리적으로 못 본다 — 그 층은 저장소 pre-commit 스캐너(core.hooksPath=~/.codex/git-hooks/pre-commit 의
#   secret_pattern 검사, 커밋 시점의 실제 스테이징 내용)가 맡는다. 같은 이유로 `git -C "$VAR"` 처럼 정적으로 못 읽는 저장소와
#   SECRET_SCAN_SKIP 환경변수(이 훅 프로세스의 env 라 도구 호출의 인라인 접두로는 닿지 않는다)도 이 층의 경계 밖이다.
#   다층: no-env-commit(파일명) + 이 게이트(흔한 케이스)
#   + git pre-commit/CI(robust) + 사람 검토 + secret-scanning-depth SOFT(시크릿을 애초에 파일에 두지 않기).
[ "${SECRET_SCAN_SKIP:-0}" = "1" ] && exit 0
INPUT=$(cat 2>/dev/null || printf '{}')
# 프리필터는 alias 치환 뒤로 옮겼다(아래) — `git ci` 가 INPUT 문자열 프리필터를 비껴가던 것
cmd=$(printf '%s' "$INPUT" | python3 -I -c "import sys,json;d=json.load(sys.stdin);print(d.get('tool_input',{}).get('command',''))" 2>/dev/null)
# git alias(`git ci` = commit, `git a` = add) 는 리터럴 add/commit 판정을 비껴간다(Codex HIGH 2026-09-20) → 전역·저장소 alias 중
# add/commit 으로 펼쳐지는 것을 명령 문자열에서 먼저 치환한다(단어 경계, 옵션 뒤에 오는 서브커맨드 위치만).
_aliases=$(git config --get-regexp '^alias\.' 2>/dev/null | awk '$2=="add"||$2=="commit"||$2=="add"||index($2,"add ")==1||index($2,"commit ")==1{sub(/^alias\./,"",$1); print $1" "$2}')
if [ -n "$_aliases" ]; then
  cmd=$(printf '%s' "$cmd" | ALIASES="$_aliases" python3 -I -c '
import sys, os, re
c=sys.stdin.read()
for line in os.environ.get("ALIASES","").splitlines():
    name, _, target = line.partition(" ")
    if not name: continue
    c=re.sub(r"(git(?:\s+-[^\s]+(?:\s+[^\s-][^\s]*)?)*\s+)"+re.escape(name)+r"(?=\s|$)", lambda m: m.group(1)+target, c)
print(c, end="")' 2>/dev/null || printf '%s' "$cmd")
fi
# 프리필터(alias 치환 *뒤*): add/commit 이 없는 명령은 여기서 끝난다
case "$cmd" in *git*add*|*git*commit*) : ;; *) exit 0 ;; esac
# git [글로벌옵션…] add|commit  — 단일/이중 대시 옵션·=value·탭 모두 허용 (Codex HIGH: git --no-pager add, 탭)
# 옵션 값이 붙은 형태(-C/tmp/other)도 옵션으로 본다 — 예전 [A-Za-z-]* 는 '/' 에서 끊겨 훅이 즉시 통과했다(Codex HIGH 2026-09-20)
printf '%s' "$cmd" | grep -qE 'git([[:space:]]+--?[A-Za-z][^[:space:]]*([[:space:]]+[^[:space:]-][^[:space:]]*)?)*[[:space:]]+(add|commit)' || exit 0

# 🚨 체인 우회 방지 (Codex HIGH 2026-07-20): `git add secret.txt && git commit` 은 이 hook 실행 시점엔
#   secret.txt 가 아직 untracked → git diff/--cached 어디에도 없어 통과 후 같은 명령이 add+commit.
#   → 명령에서 `git add` 대상 경로를 파싱해 **그 파일 내용을 디스크에서 직접 스캔**한다.
SCAN_CONTENT=""
# 참조된 repo 베이스 목록 추출 (git -C <path> 값 + 기본 "."). 여러 git 명령이 서로 다른 repo 를
# 가리켜도 각각 스캔한다 (Codex HIGH: `git -C /tmp/other add` 를 현재 repo 기준으로 읽던 것).
repos=$(printf '%s' "$cmd" | python3 -I -c '
import sys, re, shlex, os
c=sys.stdin.read(); bases=set(); cwd="."
for seg in re.split(r"&&|;|\|\||\||\n", c):  # 줄바꿈도 명령 구분자 — 둘째 줄의 `git -C <other> add` 저장소를 놓쳤다(Codex HIGH 2026-09-20)
    try: toks=shlex.split(seg.strip())
    except Exception: toks=seg.strip().split()
    if not toks: continue
    # cd <dir> 는 이후 git 명령의 기준 디렉토리를 바꾼다 (Codex HIGH: cd /tmp/repo && git add)
    if toks[0]=="cd" and len(toks)>=2:
        cwd = os.path.expanduser(toks[1]); continue
    # `env [-i] [VAR=v]... git` · `VAR=v git` 접두는 벗긴다(Codex HIGH 2026-09-20: env 를 첫 토큰으로 보고 git 을 놓쳤다)
    if toks and toks[0]=="env":
        toks=toks[1:]
        while toks and (toks[0].startswith("-") or "=" in toks[0]): toks=toks[1:]
    while toks and "=" in toks[0] and not toks[0].startswith("-"): toks=toks[1:]
    if not toks: continue
    # git / /usr/bin/git / env 등 절대·상대 경로 prefix 도 git 으로 인식 (Codex CRITICAL: /usr/bin/git -C ...)
    if not (toks[0]=="git" or toks[0].endswith("/git")): continue
    base=cwd
    i=1
    while i < len(toks):
        # -C <path> 와 붙은 -C<path> 둘 다. 상대경로면 앞선 cd 기준으로 잇는다(Codex HIGH 2026-09-20)
        val=None
        if toks[i]=="-C" and i+1 < len(toks): val=toks[i+1]
        elif toks[i].startswith("-C") and len(toks[i])>2: val=toks[i][2:]
        elif toks[i]=="--work-tree" and i+1 < len(toks): val=toks[i+1]
        elif toks[i].startswith("--work-tree="): val=toks[i][len("--work-tree="):]
        elif toks[i]=="--git-dir" and i+1 < len(toks): val=os.path.dirname(toks[i+1].rstrip("/")) or "."
        elif toks[i].startswith("--git-dir="): val=os.path.dirname(toks[i][len("--git-dir="):].rstrip("/")) or "."
        if val is not None:
            val = os.path.expanduser(val)  # normpath 전에 — `~/../x` 를 글자 그대로 접으면 "~" 디렉터리가 된다(프로브 실측)
            base = val if os.path.isabs(val) else os.path.normpath(os.path.join(cwd, val)); break
        i+=1
    bases.add(base)
if not bases: bases={cwd if cwd!="." else "."}
# `~/repo` 는 여기서 펼치고, `$VAR`/명령치환이 남은 경로는 정적으로 못 읽는다 → 그 저장소 대신 현재 저장소를 스캔한다(fail-closed 쪽:
# 아무것도 안 읽고 통과하던 것을 막는다). 다른 저장소의 실제 내용은 그 저장소의 git pre-commit 층이 본다(선언된 경계, 헤더 참조).
resolved=set()
for b in bases:
    b=os.path.expanduser(b)
    resolved.add("." if re.search(r"[\x60$]", b) else b)
print("\n".join(sorted(resolved)))
' 2>/dev/null)
[ -n "$repos" ] || repos="."

# 🎯 정밀 축소 (2026-09-20): add 인자가 전부 *정적 경로 리터럴*(옵션·`.`·-A/-u·글롭·변수·명령치환·리다이렉트 없음)이고
#   렉싱이 성공하면 **그 파일들만** 스캔한다 — 전량 스캔은 이 repo 처럼 untracked 가 수천 개(원본 이미지 포함)면 2분을 넘기고,
#   다른 세션이 남긴 수정 파일의 테스트 픽스처 토큰이 무관한 커밋을 막았다(실측 12건 전부 add 대상 밖). 판정 불가·비정적
#   인자(`git add .`·`-A`·`*`·`$VAR`)는 종전대로 전량 스캔으로 후퇴한다(fail-closed 는 넓은 쪽). cd/-C 는 위 repos 파싱과 같은 규칙.
add_paths=$(printf '%s' "$cmd" | python3 -I -c '
import sys, re, shlex, os, glob
c=sys.stdin.read(); cwd="."; out=[]; full=False
# 🚨 같은 입력 안의 "파일 변경 + add/commit" 은 훅 시점 검사가 원리적으로 무효다(검사 뒤에 파일이 생긴다 — Codex CRITICAL 2026-09-20).
#   git·cd·읽기 전용 필터 외의 명령(printf > f, rm, python3, sed -i, cp, tee …)이 add/commit 과 한 입력에 섞이면 판정하지 않고 차단한다.
#   명령치환·변수(`$(…)`·`$VAR`·백틱)가 add/commit 과 한 입력에 있으면 인자·대상 저장소를 정적으로 못 읽으므로 같은 이유로 차단한다
#   (`git add -f "$(printf .env)"` — Codex CRITICAL). 이 분류는 어떤 조기 종료보다 먼저 돈다(다중행 입력도 줄바꿈으로 나눠 본다).
#   탈출: 파일 변경·동적 인자와 add/commit 을 별도 Bash 호출로 나눈다(commit-landing 규칙과 같은 관례).
READONLY = {"tail","head","wc","cat","grep","sort","uniq","cut","tr","echo","printf","true",":","test","[","date","ls","basename","dirname"}
segs = [s.strip() for s in re.split(r"&&|;|\|\||\||\n", c)]
has_git_write = False; has_mutation = False
for seg in segs:
    try: t = shlex.split(seg)
    except Exception: continue
    if not t: continue
    if t[0]=="env":
        t=t[1:]
        while t and (t[0].startswith("-") or "=" in t[0]): t=t[1:]
    while t and "=" in t[0] and not t[0].startswith("-"): t=t[1:]
    if not t: continue
    if t[0]=="git" or t[0].endswith("/git"):
        if any(x in ("add","commit") for x in t[1:]): has_git_write = True
        continue
    if t[0]=="cd": continue
    if t[0] in READONLY and not re.search(r"[<>]", seg): continue
    has_mutation = True
if has_git_write and (has_mutation or re.search(r"[\x60$]", c)):
    print("MUTATION_MIX"); sys.exit(0)
if "\n" in c:
    print("FULL"); sys.exit(0)  # 다중행(히어독 등)은 인자를 정적으로 못 읽는다 → 전량(둘째 줄의 저장소도 repos 파서가 본다)
for seg in re.split(r"&&|;|\|\||\|", c):
    try: toks=shlex.split(seg.strip())
    except Exception: print("FULL"); sys.exit(0)
    if not toks: continue
    if toks[0]=="cd" and len(toks)>=2: cwd=os.path.expanduser(toks[1]); continue
    if re.search(r"[<>]", seg) and any(t in ("add", "commit") for t in toks):
        print("FULL"); sys.exit(0)  # git add/commit 세그먼트 자체의 리다이렉트만 정적 판독을 막는다(다른 세그먼트의 2>/dev/null 은 무관)
    if toks and toks[0]=="env":
        toks=toks[1:]
        while toks and (toks[0].startswith("-") or "=" in toks[0]): toks=toks[1:]
    while toks and "=" in toks[0] and not toks[0].startswith("-"): toks=toks[1:]
    if not toks: continue
    if not (toks[0]=="git" or toks[0].endswith("/git")): continue
    base=cwd; i=1
    while i < len(toks) and toks[i]!="add" and toks[i]!="commit":
        if toks[i]=="-C" and i+1 < len(toks):
            v=os.path.expanduser(toks[i+1]); base = v if os.path.isabs(v) else os.path.normpath(os.path.join(cwd, v)); i+=2; continue
        if toks[i].startswith("-C") and len(toks[i])>2:
            v=os.path.expanduser(toks[i][2:]); base = v if os.path.isabs(v) else os.path.normpath(os.path.join(cwd, v)); i+=1; continue
        if toks[i]=="--work-tree" and i+1 < len(toks):
            v=os.path.expanduser(toks[i+1]); base = v if os.path.isabs(v) else os.path.normpath(os.path.join(cwd, v)); i+=2; continue
        if toks[i].startswith("--work-tree="):
            v=os.path.expanduser(toks[i][len("--work-tree="):]); base = v if os.path.isabs(v) else os.path.normpath(os.path.join(cwd, v)); i+=1; continue
        if toks[i]=="--git-dir" and i+1 < len(toks):
            v=os.path.dirname(os.path.expanduser(toks[i+1]).rstrip("/")) or "."; base = v if os.path.isabs(v) else os.path.normpath(os.path.join(cwd, v)); i+=2; continue
        if toks[i].startswith("--git-dir="):
            v=os.path.dirname(os.path.expanduser(toks[i][len("--git-dir="):]).rstrip("/")) or "."; base = v if os.path.isabs(v) else os.path.normpath(os.path.join(cwd, v)); i+=1; continue
        i+=1
    if i >= len(toks) or toks[i]!="add": continue
    args=toks[i+1:]
    if args and args[0]=="--": args=args[1:]
    if not args: print("FULL"); sys.exit(0)
    if any(a in ("-f","--force") or (a.startswith("-") and not a.startswith("--") and "f" in a[1:]) for a in args) and \
       any(a in (".","..","-A","--all","-u","--update") or (a.startswith("-") and not a.startswith("--") and any(ch in a[1:] for ch in "Au")) \
           or a.endswith("/") or os.path.isdir(os.path.join(os.path.expanduser(base), os.path.expanduser(a))) for a in args):
        print("FORCE_BROAD"); sys.exit(0)  # -f 와 광역 대상: ignored 파일은 status 에 없어 전량 스캔이 못 본다 → 판정 불가(Codex HIGH 2026-09-20)
    expanded = []
    k = 0
    while k < len(args):
        a = args[k]
        if a == "--pathspec-from-file" and k+1 < len(args): src = args[k+1]; k += 2
        elif a.startswith("--pathspec-from-file="): src = a[len("--pathspec-from-file="):]; k += 1
        else: expanded.append(a); k += 1; continue
        full = True  # 목록 파일의 경로를 리터럴로 읽는다(Codex HIGH 2026-09-20: ignored 항목은 status 에 없다). 상한 500.
        try:
            with open(os.path.join(os.path.expanduser(base), os.path.expanduser(src)), "r", errors="replace") as fh:
                for line in fh.read().splitlines()[:500]:
                    line = line.strip()
                    if line: expanded.append(line)
        except OSError:
            pass
    args = expanded
    for a in args:
        if re.search(r"[*?\[]", a):
            # 글롭은 여기서 펼쳐 그 파일들을 직접 읽는다(전량 스캔은 ignored 를 못 보므로 `add -f "*.env"` 가 새던 축 — Codex HIGH 2026-09-20).
            # 따옴표로 git 에 넘긴 pathspec 과 셸이 먼저 펼친 경우 모두 같은 집합이다. 상한 500.
            full=True
            for m in sorted(glob.glob(os.path.join(os.path.expanduser(base), os.path.expanduser(a)), recursive=True))[:500]:
                if os.path.isfile(m): out.append(os.path.normpath(m))
            continue
        if a.startswith("-") or a in (".","..") or a.endswith("/"):
            full=True; continue  # 옵션(-f 등)·비정적 인자 → 전량 후퇴하되, 함께 적힌 리터럴 경로는 추가로 직접 읽는다
        out.append(os.path.normpath(os.path.join(base, os.path.expanduser(a))))
# `git add -f ignored.env`: 전량 스캔은 git status 가 ignored 를 안 보여 주므로 놓친다(Codex HIGH 2026-09-20) →
# FULL 뒤에 리터럴 경로를 덧붙여 bash 쪽이 그 파일도 디스크에서 읽게 한다.
print("\n".join((["FULL"] if full else []) + out))
' 2>/dev/null)
[ -n "$add_paths" ] || add_paths="FULL"
if [ "$add_paths" = "FORCE_BROAD" ]; then
  echo "🛑 secret-content-scan: git add -f 를 . / -A / 디렉터리에 걸면 ignored 파일까지 스테이징되는데 훅은 그것을 볼 수 없다 — 강제 추가할 파일을 이름으로 지정하라." >&2
  exit 2
fi
if [ "$add_paths" = "MUTATION_MIX" ]; then
  echo "🛑 secret-content-scan: 파일을 만들거나 바꾸는 명령(또는 \$(…)·\$VAR·백틱 같은 동적 인자)과 git add/commit 이 한 Bash 입력에 섞여 있어 훅 시점 검사가 무효다 — 파일 변경·동적 인자와 add/commit 을 별도 호출로 나눠라." >&2
  exit 2
fi

# add 가 명령에 있으면 보수적 전량 스캔이 필요 (add 는 shell확장·pathspec·-A·디렉토리 등 다양한
# 방식으로 untracked 파일을 스테이징하므로, 대상 파싱보다 "그 repo 의 변경/untracked 전량"이 안전).
# add 가 추가하는 파일은 반드시 그 repo 의 변경/untracked 파일이므로 전량 스캔이 놓치지 않는다.
cmd_has_add=0
printf '%s' "$cmd" | grep -qE 'git([[:space:]]+--?[A-Za-z][^[:space:]]*([[:space:]]+[^[:space:]-][^[:space:]]*)?)*[[:space:]]+add' && cmd_has_add=1  # 붙은 옵션값(-C/path) 허용

# 디렉터리 하나를 유계로 읽는다: 텍스트 파일만(확장자·바이너리 스니프), 500개·8MB 상한. 상한은 선언된 경계다 — 조기경보 훅이
# 대형 트리에서 분 단위로 늘어지면 안 되고, 커밋 시점의 실제 스테이징은 git pre-commit 층이 전수로 본다(헤더). 상한에 걸리면
# stderr 로 알린다(무음 부분 스캔 금지 — 측정 불가 ≠ 통과).
read_dir_bounded() {
  local dir="$1"
  find "$dir" -type f -print0 2>/dev/null | python3 -I -c '
import sys, os
SKIP = {".png",".jpg",".jpeg",".gif",".webp",".mp4",".mov",".zip",".gz",".tar",".pdf",".woff",".woff2",".ttf",".otf",".ico",".bin",".safetensors",".pt",".ckpt"}
total = 0; n = 0; out = []; gap = []
names = [x for x in sys.stdin.buffer.read().split(b"\0") if x]
for name in names:
    if os.path.splitext(name)[1].lower() in SKIP: continue
    try:
        if os.path.getsize(name) > 512 * 1024: gap.append(name); continue  # 큰 텍스트 파일은 읽지 않았다 — 통과가 아니라 측정 갭
        data = open(name, "rb").read()
    except OSError: continue
    if b"\0" in data[:8192]: continue
    if n >= 500 or total >= 8 * 1024 * 1024: gap.append(name); continue
    out.append(data.replace(b"\0", b"") + b"\n"); total += len(data); n += 1
if gap:
    # 측정 불가 ≠ 통과: 읽지 못한 파일이 있으면 마커를 내보내 호출자가 차단한다(값이 아니라 파일 수만).
    sys.stderr.write("secret-content-scan: 디렉터리 %s 에서 %d개 파일을 읽지 못했다(상한 500개/8MB 또는 512KB 초과) — 파일을 명시해 add 하거나 디렉터리를 나눠라\n" % (sys.argv[1], len(gap)))
    out.append(b"SECRET_SCAN_UNREAD_FILES=" + str(len(gap)).encode() + b"\n")
sys.stdout.buffer.write(b"".join(out))' "$dir"
}

# repo 하나에 대해: 스테이징 diff + (add 있으면) 변경/untracked 전량을 SCAN_CONTENT 에 누적
scan_repo() {
  local repo="$1"
  # 1) 스테이징 (git commit 이 커밋하는 것)
  SCAN_CONTENT="$SCAN_CONTENT
$(git -C "$repo" diff --cached -U0 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+')"
  # 2) git commit -a → 수정된 추적 파일
  # -a 외에 --all / --include / --only / -i / -o 도 워킹트리 내용을 커밋한다(Codex HIGH 2026-09-20: `commit --only tracked.txt`)
  if printf '%s' "$cmd" | grep -qE 'commit +[^"'"'"']*(-[a-zA-Z]*[aio][a-zA-Z]*([[:space:]]|$)|--all|--include|--only)'; then
    SCAN_CONTENT="$SCAN_CONTENT
$(git -C "$repo" diff -U0 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+')"
  fi
  # 3) add 가 있으면 변경/untracked 전량 (null-구분 → 공백/glob/shell확장 안전)
  if [ "$cmd_has_add" = "1" ] && [ "${add_paths%%$'\n'*}" != "FULL" ]; then
    # 정적 경로 리터럴만 있는 add: 그 파일들만(디스크 내용 — untracked 라도 잡힌다). 디렉토리·부재 경로가 섞이면 전량으로 후퇴.
    local narrow_ok=1 p
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      if [ -f "$p" ]; then SCAN_CONTENT="$SCAN_CONTENT
$(cat "$p" 2>/dev/null)"
      elif [ -d "$p" ]; then SCAN_CONTENT="$SCAN_CONTENT
$(read_dir_bounded "$p")"  # 디렉터리 리터럴: git 이 추가할 파일이 곧 그 안의 파일이다 — 유계로 직접 읽는다
      else narrow_ok=0; break; fi
    done <<< "$add_paths"
    [ "$narrow_ok" = "1" ] && return 0
  fi
  if [ "$cmd_has_add" = "1" ] && [ "${add_paths%%$'\n'*}" = "FULL" ]; then
    # FULL 다음 줄들 = 옵션과 함께 적힌 리터럴 경로(예: add -f ignored.env) — ignored 라 status 에 안 나와도 직접 읽는다
    local extra
    while IFS= read -r extra; do
      [ -n "$extra" ] && [ "$extra" != "FULL" ] || continue
      if [ -f "$extra" ]; then SCAN_CONTENT="$SCAN_CONTENT
$(cat "$extra" 2>/dev/null)"
      elif [ -d "$extra" ]; then SCAN_CONTENT="$SCAN_CONTENT
$(read_dir_bounded "$extra")"  # `add -f ignored-dir`: status 에 안 나오는 디렉터리도 직접 읽는다(Codex HIGH 2026-09-20)
      fi
    done <<< "$add_paths"
  fi
  if [ "$cmd_has_add" = "1" ]; then
    while IFS= read -r -d '' line; do
      local f="${line:3}"
      if [ -d "$repo/$f" ]; then
        # 새 디렉터리는 `?? dir/` 한 줄로 온다 — 안의 파일을 유계로 읽는다(Codex HIGH 2026-09-20: mkdir secrets && git add . 통과).
        SCAN_CONTENT="$SCAN_CONTENT
$(read_dir_bounded "$repo/$f")"
      elif [ -f "$repo/$f" ]; then
        SCAN_CONTENT="$SCAN_CONTENT
$(cat "$repo/$f" 2>/dev/null)"
      fi
    done < <(git -C "$repo" status --porcelain -z 2>/dev/null)
  fi
}
while IFS= read -r r; do [ -n "$r" ] && scan_repo "$r"; done <<< "$repos"

[ -n "$SCAN_CONTENT" ] || exit 0
if printf '%s' "$SCAN_CONTENT" | grep -qE '^SECRET_SCAN_UNREAD_FILES=[0-9]+$'; then
  echo "🛑 secret-content-scan: 디렉터리 스캔 상한으로 읽지 못한 파일이 있어 판정할 수 없다 — 파일을 명시해 add 하거나 디렉터리를 나눠라(위 경고 참조)." >&2
  exit 2
fi
ADDED="$SCAN_CONTENT"

# 시크릿 패턴 (평문 접두사 + JSON 값 + export/할당 형태) — secret-scanning-depth
#  - sk-[...]{20,} 에 -/_ 허용 (Codex HIGH: sk-proj-... 신형 키 놓치던 것)
#  - 할당 키는 대소문자 무관 grep -i (OPENAI_API_KEY 등 대문자 놓치던 것)
# 플레이스홀더/예시(YOUR_·xxx·example·<...>)는 제외해 오탐 축소.
# 🚨 벤더 접두사(AKIA/ghp_/gho_/sk-/xox·PEM)는 대소문자가 **규격으로 고정**돼 있다.
#    grep -i 로 보면 base64 자산(폰트·이미지 data-URI)의 잡음에서 'akia…' 가 걸려 거짓 차단이 난다
#    (실측 2026-07-27: keynote 덱 4건 전부 base64 잡음, 실제 시크릿 0건). 접두사는 대소문자 구분,
#    할당 키워드(api_key/secret/token…)만 -i. 탐지력 손실 없음 — 실제 키는 규격대로 대문자 AKIA /
#    소문자 ghp_ 라 그대로 잡힌다. placeholder 필터는 양쪽 모두에 적용.
HITS=$(
  {
    # -o: 매칭된 값만 남긴다 — 아래 플레이스홀더 제외 필터가 *줄 전체*에 걸리면 `KEY=실제값 # example` 처럼 주석 한 단어로
    #     실제 시크릿이 통과한다(Codex HIGH 2026-09-20). 값 자체에 example/dummy 가 들어 있을 때만 플레이스홀더로 본다.
    printf '%s' "$ADDED" | grep -noE -- '(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}' 2>/dev/null
    # 값 따옴표는 변수로 만든다 — 작은따옴표 패턴 안에 ' 를 넣으려다
    # 문자클래스가 큰따옴표 하나로 컴파일돼 API_KEY='...' 를 놓쳤다(교차리뷰가 실행으로 증명).
    # PEM 은 PKCS#8 armor(알고리즘어 없이 BEGIN 다음 바로 PRIVATE 가 오는 형태)도 잡도록
    # 알고리즘어를 선택적으로 뒀다. 예시 문자열을 주석에 그대로 쓰면 스캐너가 자기 주석을 잡는다.
    _Q="[\"']"
    printf '%s' "$ADDED" | grep -nioE -- "(api[_-]?key|apikey|secret|token|password|access[_-]?key)${_Q}?[[:space:]]*[:=][[:space:]]*${_Q}[A-Za-z0-9/_+.-]{16,}${_Q}|-----BEGIN( [A-Z0-9]+)? PRIVATE KEY-----" 2>/dev/null
  } | grep -viE 'YOUR_|xxxx|example|placeholder|<[a-z_]+>|dummy|redacted|\*\*\*\*|TELEGRAM_BOT_TOKEN\}'
)

if [ -n "$HITS" ]; then
  # 🚨 CRITICAL 수정 (Codex 2026-07-20): 매칭 라인을 그대로 출력하면 시크릿이 로그/CI에 복사되어
  #   게이트가 오히려 유출을 확대한다. **값은 절대 출력하지 않고** 건수 + 마스킹 지문만 emit.
  n=$(printf '%s\n' "$HITS" | grep -c .)
  echo "🛑 secret-content-scan: 스테이징 내용에 시크릿으로 보이는 값 ${n}건 발견 (값은 로그 유출 방지를 위해 미표시)." >&2
  # 마스킹 지문: 각 히트의 앞 4자 + 길이만 (값 자체 노출 금지)
  printf '%s\n' "$HITS" | head -5 | python3 -I -c '
import sys, re
for line in sys.stdin:
    m=re.search(r"(sk-|AKIA|ghp_|gho_|xox|-----BEGIN|[A-Za-z_]*(?:key|secret|token|password))", line, re.I)
    tok=m.group(0) if m else line.strip()[:8]
    print("   · 패턴 %s… (마스킹, 길이 %d)" % (tok[:6], len(line.strip())))
' 2>/dev/null >&2
  echo "   → 값을 환경변수/시크릿 매니저로 옮기고 커밋에서 제거하세요." >&2
  echo "   (오탐이면 bypass: SECRET_SCAN_SKIP=1)" >&2
  exit 2
fi
exit 0
