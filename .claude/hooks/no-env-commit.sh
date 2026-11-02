#!/bin/bash
# STACK: universal
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
# PreToolUse (Bash): git add 로 민감 파일(.env/.pem/.key/credentials) 추가 차단.
#  - explicit 검사는 **`git add <인자>` 범위로 스코핑** → 커밋 메시지/다른 명령의 .env 문자열 오탐 방지.
#  - bulk(., -A, --all, -u) 는 `git add --dry-run` 으로 실제 staged 될 민감파일 확인(gitignore된 .env 는
#    dry-run 에 안 나와 자연 예외). cd 접두 처리. (Codex R7: `git add .` 우회 차단)
#  - 따옴표는 \x27/\x22 hex 사용 — bash $() 안 heredoc 의 삼중따옴표/내부따옴표 파서 충돌 회피.
# 입력은 temp-file 로 (heredoc 이 stdin 을 점유 + 거대 payload ARG_MAX 회피 — no-localstorage 와 동일).
# [perf] sound prefilter — 차단은 add_iter(\bgit\b...add\b) 매칭이 전제 → "git"+"add" substring 없으면
# python 스폰 없이 통과. 따옴표/백슬래시 난독화(g"i"t) 대비 제거 후 검사 — 동작 부분집합 불변.
_NECIN=$(cat 2>/dev/null || printf '{}')
_PF="${_NECIN//\"/}"; _PF="${_PF//\'/}"; _PF="${_PF//\\/}"
case "$_PF" in
  *git*add*|*add*git*) : ;;
  *) exit 0 ;;
esac
# 🚨 2026-08-24 HIGH: mktemp 실패 시 PID 기반 예측 가능 임시경로로 폴백하던 것을 제거 —
#   예측 가능 임시 경로는 심링크 선점 등으로 공격면이 되고(atomic-artifact-publish #1), mktemp
#   실패는 임시 파일을 신뢰 경계 안에 만들 수 없다는 뜻이라 검증 자체가 성립하지 않는다 = fail-closed.
TMPIN=$(mktemp 2>/dev/null) || {
  echo "HARD BLOCK: 임시 파일 생성 실패(mktemp) — 민감파일 검증을 수행할 수 없어 차단합니다." >&2
  exit 2
}
trap 'rm -f "$TMPIN" 2>/dev/null' EXIT
printf '%s' "$_NECIN" > "$TMPIN" 2>/dev/null || {
  echo "HARD BLOCK: 임시 파일 쓰기 실패 — 민감파일 검증을 수행할 수 없어 차단합니다." >&2
  exit 2
}
RES=$(NEC_FILE="$TMPIN" python3 - <<'PYEOF'
import sys, json, re, os, subprocess
try:
    raw = open(os.environ["NEC_FILE"], encoding="utf-8", errors="ignore").read() or "{}"
    cmd = json.loads(raw).get("tool_input", {}).get("command", "") or ""
except Exception:
    # 🚨 2026-08-24 HIGH (Codex): 이 except 에 도달했다는 것 자체가 이미 위험 신호다 — bash 층
    #   prefilter(_PF, 위 12-17행)가 "git"+"add" substring 을 먼저 매치해야만 이 python 이 실행되므로,
    #   JSON 파싱이 실패해도 원문에 git+add 신호가 있었음은 확정이다. 종전엔 여기서 "OK" 를 찍어
    #   검증 실패(malformed/truncated JSON)를 통과로 위장했다 — fail-open, 비밀 유출 클래스
    #   (`git add .env` 를 담은 stdin 이 파싱만 깨지면 exit 0). 이 지점만 BLOCK 으로 전환한다.
    #   wedge 안전: _PF 에 안 걸리는 입력(git·add 와 무관한 명령)은 bash 층에서 이미 exit 0 으로
    #   빠지므로 이 except 자체에 도달하지 않는다 — 모든 파싱 실패를 무조건 차단하는 것이 아니다.
    print("BLOCK|ipnyeok JSON pasing silpae (malformed/truncated) — git+add sinho neun gamji doeeoss-eumyeo geomjeung bulga = chadan"); sys.exit()

SAFE    = re.compile(r"\.env\.(example|sample|template)\b")
EXPL    = re.compile(r"\.(env|pem|key)\b|credentials\b")
BAREENV = re.compile(r"(^|\s)\.env(\s|\x22|\x27|$)")
DANGER  = re.compile(r"\.(env|pem|key)(\x27|\x22|\.|\s|$)|credentials")
BULK    = re.compile(r"(^|\s)(-A|--all|-u|--update|\.|\*)(\s|$)")
# 🚨 2026-08-24 HIGH: `--pathspec-from-file=<file>` 는 add 대상을 커맨드라인이 아니라 파일에서
#   읽는다 — 파일 안에만 민감 경로가 있으면 위 EXPL/BULK 의 문자열 매칭이 놓쳐 staged 된다(Codex HIGH,
#   `git add --pathspec-from-file=paths` where paths contains .env). 아래에서 파일 내용을 실제로
#   읽어 같은 EXPL/SAFE 술어로 매 줄 검사한다.
PSFF    = re.compile(r"--pathspec-from-file(?:=([^\s]+)|\s+([^\s]+))")

# "git ... add <args>" 의 args 만 추출(다음 구분자 전까지) → explicit 은 이 범위에서만 검사
# 중간 토큰에 = / 포함 (git -c user.name=x add / --git-dir=/path add 우회 차단 — replay seed-013, 2026-07-03)
# 🚨 4R HIGH (2026-07-26): g"it" add .env 처럼 따옴표 분할이 \bgit\b 인식기를 비껴갔다 —
#   agent-browser-security 의 정규화 전례대로 **인식기는 따옴표/백슬래시 제거본(cmd_n)** 위에서
#   돈다(외곽 bash 프리필터 _PF 와 동일 원리). 동적 판정(dyn)은 인용 구조가 필요해 raw 유지 —
#   "분할+동적 동시 적층"(g"it" -C "$repo" add)은 능동 이중 난독화로 정규식 훅의 문서화 경계.
# 텍스트-싱크(-m/-am/--message/echo/printf) 뒤의 인용 스팬은 실행이 아니라 데이터 —
#   통째 블랭킹 후 인식(커밋 메시지/출력문에 git add 예시를 적으면 차단되던 자기-FP 실측 4R).
#   bash -c "..." 는 실행 컨텍스트이므로 싱크 목록에 없다(계속 인식됨).
def _blank_textual(c):
    # 🚨 5R CRITICAL: echo "$(git add .env)" — 큰따옴표 안 명령치환은 데이터가 아니라 실행이다.
    #   chr(36)( / 백틱 포함 스팬은 블랭킹하지 않고 남겨 인식기가 보게 한다.
    pat = (r"(?:(?<=\s)|^)((?:-m|-am|--message(?:=)?|echo|printf)\s+)"
           r"(\x27[^\x27]*\x27|\x22(?:\x5c.|[^\x22\x5c])*\x22)")
    def repl(mo):
        span = mo.group(2)
        if (chr(36) + "(") in span or chr(96) in span:
            return mo.group(0)          # 실행 가능 내용 — 블랭킹 금지
        return " TXT_SINK STQ "
    return re.sub(pat, repl, c)
cmd_base = _blank_textual(cmd)
cmd_n = re.sub(r"[\x22\x27\x5c]", "", cmd_base)
add_iter = list(re.finditer(r"\bgit\b\s+(?:[\w.=/,:-]+\s+)*?add\b([^\n;&|]*)", cmd_n))
# 🚨 3R HIGH (2026-07-26): `repo=x; git -C "$repo" add .` 처럼 git..add 사이에 런타임 토큰이
#   끼면 위의 엄격 매처가 통째로 미매치(따옴표/$ 는 토큰 클래스 밖) → 검사 0 으로 우회됐다.
#   텍스트 훅은 변수를 해석할 수 없으므로(정규식 훅의 문서화된 한계) 판정 불가 = 차단(fail-closed).
#   단 느슨한 raw 스캔은 인용문 속 예시 텍스트(echo "git add $x 설명")까지 차단(실측 자기-FP) →
#   **인용부 블랭킹 구조 판정**: 따옴표 스팬을 마커로 접되 chr(36)/chr(96) 포함 스팬은 DYN 마커로.
#   실제 동적 대상( git 과 add "사이"의 $var/"$var"/`cmd` )만 걸리고, 통짜 인용문 속 언급은 통과.
_D = chr(36); _B = chr(96)
def _struct(c):
    def dq_sub(mo):
        s = mo.group(0)
        return " DYNQ " if (_D in s or _B in s) else " STQ "
    c = re.sub(r"\x5c[" + _D + _B + r"]", " STQ ", c)          # \$ \` 이스케이프 = 정적
    c = re.sub(r"\x27[^\x27]*\x27", " STQ ", c)                 # '...' = 정적
    c = re.sub(r"\x22(?:\x5c.|[^\x22\x5c])*\x22", dq_sub, c)    # "..." = $ 포함 여부로 DYN/정적
    return c
_st = _struct(cmd_base)
dyn = re.search(r"\bgit\b([^\n;&|]*?)\badd\b", _st)
if dyn and (_D in dyn.group(1) or _B in dyn.group(1) or "DYNQ" in dyn.group(1)):
    print("BLOCK|git..add sai dong jeok tokeun(byeonsu/chihwan) — pandan bulga = chadan. jeongjeok gyeongro ro add hasey o"); sys.exit()
if not add_iter:
    print("OK"); sys.exit()

def workdir():
    m = re.search(r"(?:^|&&|;|\n)\s*cd\s+([^\n;&|]+?)\s*(?:&&|;|\n|$)", cmd_n)
    if m:
        d = m.group(1).strip().strip(chr(34) + chr(39))
        if os.path.isdir(d):
            return d
    return "."

for m in add_iter:
    args = m.group(1)
    psf_m = PSFF.search(args)
    if psf_m:                                    # (0) --pathspec-from-file — git 자신에게 위임해 검사
        # 판정 불가는 전부 fail-closed(BLOCK) — 이 파일의 다른 검증 축과 동일 원칙.
        psf_seg = m.group(0)
        if re.search(r"(?:^|\s)(?:-C\s|--git-dir(?:=|\s)|--work-tree(?:=|\s))", psf_seg):
            # -C/--git-dir/--work-tree 와 공존하면 BULK dry-run 급 정밀한 대상 repo 해석이 필요한데
            # 중복구현하지 않는다 — 잘못 해석하면 디코이(무해) 파일을 읽고 오판(우회)할 위험이 있어
            # 판정 불가로 취급한다.
            print("BLOCK|pathspec-from-file gwa -C/--git-dir/--work-tree gong jon — pandan bulga = chadan"); sys.exit()
        psf_arg = (psf_m.group(1) or psf_m.group(2) or "").strip(chr(34) + chr(39))
        if not psf_arg or psf_arg == "-" or chr(36) in psf_arg or chr(96) in psf_arg:
            print("BLOCK|pathspec-from-file i dong jeok gap ttoneun stdin(-) — pandan bulga = chadan"); sys.exit()
        # 공백 포함 인용 경로 방어(5R CRITICAL 과 동일 원리) — truncated 오파싱으로 엉뚱한(무해) 파일을
        #   가리키는 것을 막는다.
        if re.search(r"\x22[^\x22]*\s[^\x22]*\x22|\x27[^\x27]*\s[^\x27]*\x27", psf_seg) \
           and re.search(r"--pathspec-from-file[=\s]+[\x22\x27]", psf_seg):
            print("BLOCK|pathspec-from-file gyeong ro e gong baek pohamdoen inyong — pandan bulga = chadan"); sys.exit()
        cw = workdir()
        psf_path = psf_arg if os.path.isabs(psf_arg) else os.path.join(cw, psf_arg)
        # 🚨 2026-08-24 (Codex 신규): 파일 내용을 직접 읽어 EXPL 로 검사하면 git 의 pathspec
        #   C-quoting(core.quotePath — `"\056env"` 류 octal escape 가 `.env` 로 디코딩)을 내가
        #   재구현해야 하는데, 그 길은 수렴하지 않는다(rule claude-code-hook-stdin-contract #6 —
        #   3라운드+ 는 정규식 강화가 아니라 설계 변경). 대신 **git 자신에게 위임**한다 —
        #   `git add --dry-run --pathspec-from-file=<file>` 을 돌려 git 이 디코딩·해석을 마친
        #   뒤 실제로 staged 될 경로를 출력하게 하고, 그 출력을 기존 DANGER/SAFE 술어(BULK 분기와
        #   동일 술어 재사용)로 검사한다 — C-quoting·유니코드 이스케이프 등 인코딩 축이 통째로
        #   닫힌다(실측: 원시 텍스트로는 `"\056env"` 이지만 dry-run 출력은 `add '.env'`).
        #   dry-run 이 rc≠0 이면(파일 없음·pathspec 이 실 파일과 불일치 등) 판정 불가 = 차단
        #   (기존 BULK dry-run 계약과 동일 — git 의 실제 add 도 그 경우 아무것도 stage 하지 못하고
        #   같은 방식으로 실패하므로 wedge 아님).
        dry = ["git", "add", "--dry-run"]
        if re.search(r"--pathspec-file-nul\b", psf_seg):
            dry.append("--pathspec-file-nul")
        dry.append("--pathspec-from-file=" + psf_path)
        try:
            r = subprocess.run(dry, cwd=cw, capture_output=True, text=True, timeout=10)
            if r.returncode != 0:
                print("BLOCK|pathspec-from-file dry-run silpae (pail eobtgeona pathspec bulilchi) — pandan bulga = chadan"); sys.exit()
            out = r.stdout or ""
        except Exception:
            print("BLOCK|pathspec-from-file dry-run silhaeng bulga — pandan bulga = chadan"); sys.exit()
        danger = [ln for ln in out.splitlines() if DANGER.search(ln) and not SAFE.search(ln)]
        if danger:
            print("BLOCK|pathspec-from-file dry-run e min gam pail poham: " + ", ".join(danger[:5])); sys.exit()
    if EXPL.search(args):                       # (1) explicit 민감 파일명 (add 인자 범위)
        if not (SAFE.search(args) and not BAREENV.search(args)):
            print("BLOCK|min gam pail myeong i git add inja e issseubnida"); sys.exit()
    if BULK.search(args):                        # (2) bulk add -> dry-run
        # 🚨 Codex 2차리뷰 CRITICAL (2026-07-26): `git -C <repo> add .` 는 dry-run 을 훅 cwd 에서
        #   돌려 다른 repo 의 .env 를 못 봤다(재현됨) — 매치된 git 호출부에서 -C 경로를 추출해
        #   dry-run cwd 를 대상 repo 로 맞춘다. cd 접두와 결합(상대 -C 는 cd 기준으로 해석).
        # 🚨 3R HIGH: ① 다중 -C 는 git 의미대로 순서 누적(-C a -C b → a/b) ② `-C "$repo"` 처럼
        #   런타임 변수는 텍스트 훅이 해석 불가(정규식 훅의 문서화된 한계) — 해석 실패를 "." 폴백으로
        #   삼키면 대상 repo 미검사 우회가 되므로 **판정 불가 = 차단**(fail-closed, 비밀 유출 클래스).
        cw = workdir()
        unresolved = None
        seg = m.group(0)
        for cm in re.finditer(r"(?:^|\s)-C\s+([^\s]+)", seg):
            cpath = os.path.expanduser(cm.group(1))
            # ⚠ 이 python 은 비인용 heredoc 안 — '$'/백틱 리터럴은 bash 가 먹으므로 chr() 로 표기
            if chr(36) in cpath or chr(96) in cpath:
                unresolved = cpath; break
            cw = cpath if os.path.isabs(cpath) else os.path.join(cw, cpath)
        # 🚨 4R HIGH: --git-dir/--work-tree 대안 repo 지정이 dry-run 대상을 비껴갔다(재현) —
        #   추출해 dry-run 에 그대로 전달. --git-dir 만 있으면 /.git 규약으로 work-tree 유도,
        #   유도 불가·동적 값은 판정 불가 = 차단(fail-closed).
        gd = wt = None
        for gm in re.finditer(r"--git-dir[=\s]+([^\s]+)", seg):
            gd = os.path.expanduser(gm.group(1))
        for wm in re.finditer(r"--work-tree[=\s]+([^\s]+)", seg):
            wt = os.path.expanduser(wm.group(1))
        if unresolved is None:
            for v in (gd, wt):
                if v is not None and (chr(36) in v or chr(96) in v):
                    unresolved = v; break
        if unresolved is None and gd is not None and wt is None:
            # 🚨 5R HIGH: '--git-dir=.git'(상대 규약형)이 endswith('/.git')에 걸려 오차단 —
            #   basename 규약으로 일반화: X/.git → X, '.git' 단독 → 현재 작업 디렉토리.
            if os.path.basename(gd.rstrip("/")) == ".git":
                parent = os.path.dirname(gd.rstrip("/"))
                wt = parent if parent else cw
            else:
                unresolved = gd   # bare/비규약 git-dir — work-tree 판정 불가
        if unresolved is None:
            base = wt if wt is not None else cw
            if not os.path.isabs(base):
                base = os.path.join(cw, base)
            if not os.path.isdir(base):
                unresolved = base
        if unresolved is not None:
            print("BLOCK|add daesang repo reul haeseok hal su eopseum (dong jeok/-C/--git-dir?): "
                  + str(unresolved)[:80] + " — jeongjeok gyeongro ro add hasey o"); sys.exit()
        # 🚨 5R CRITICAL: 따옴표 제거가 공백 포함 인용 경로("/tmp/a b")를 오파싱해 엉뚱한 repo 를
        #   dry-run 하고, 그 실패를 빈 결과=OK 로 삼켰다 — ① git..add 구간에 공백 포함 인용 스팬이
        #   있으면 판정 불가=차단 ② dry-run 실패(비정상 종료)도 판정 불가=차단(fail-closed).
        # (6R MEDIUM 정밀화: 검사 범위를 현재 git..add 세그먼트로 한정 — 뒤따르는 무관한
        #  인용 텍스트("done now" 등)에 오탐하지 않도록. raw 에서 세그먼트를 못 찾으면(따옴표
        #  분할 등) 보수적으로 전체를 본다)
        rawseg_m = re.search(r"\bgit\b[^\n;&|]*\badd\b[^\n;&|]*", cmd)
        rawseg = rawseg_m.group(0) if rawseg_m else cmd
        if re.search(r"\x22[^\x22]*\s[^\x22]*\x22|\x27[^\x27]*\s[^\x27]*\x27", rawseg) \
           and re.search(r"(?:-C|--git-dir|--work-tree)[=\s]+[\x22\x27]", rawseg):
            print("BLOCK|gong baek pohamdoen inyong repo gyeongro — pandan bulga = chadan"); sys.exit()
        dry = ["git"]
        if gd is not None: dry += ["--git-dir", gd if os.path.isabs(gd) else os.path.join(cw, gd)]
        if wt is not None: dry += ["--work-tree", wt if os.path.isabs(wt) else os.path.join(cw, wt)]
        dry += ["add", "--dry-run", "-A"]
        try:
            r = subprocess.run(dry, cwd=(wt if (wt and os.path.isabs(wt)) else cw),
                               capture_output=True, text=True, timeout=10)
            if r.returncode != 0:
                print("BLOCK|dry-run silpae (daesang repo hwagin bulga) — pandan bulga = chadan"); sys.exit()
            out = r.stdout or ""
        except Exception:
            print("BLOCK|dry-run silhaeng bulga — pandan bulga = chadan"); sys.exit()
        danger = [ln for ln in out.splitlines() if DANGER.search(ln) and not SAFE.search(ln)]
        if danger:
            print("BLOCK|git add bulk ga min gam pail eul staged: " + ", ".join(danger[:5])); sys.exit()
print("OK")
PYEOF
)

# 🚨 2026-08-24 HIGH: 기존 `[ "${RES%%|*}" = "BLOCK" ] && exit 2` 는 BLOCK 만 명시 검사하고
#   그 외(빈 RES·python crash·미인식 문구)는 전부 통과(exit 0) — 검증 파이프라인의 근본 실패가
#   그대로 우회로였다(fail-open). OK 만 명시 허용, 나머지는 전부 차단하는 화이트리스트로 전환.
case "${RES%%|*}" in
  OK)
    exit 0
    ;;
  BLOCK)
    echo "HARD BLOCK: 민감 파일(.env/.pem/.key/credentials)을 git add 할 수 없습니다." >&2
    echo "   상세: ${RES#BLOCK|}" >&2
    echo "   .gitignore 에 추가하거나 개별 파일만 add 하세요 (.env.example 류는 허용)." >&2
    exit 2
    ;;
  *)
    echo "HARD BLOCK: 검증 결과를 인식할 수 없습니다(빈 값/미인식/도구 실패) — 검증 불가 = 차단." >&2
    exit 2
    ;;
esac
