#!/usr/bin/env python3
"""Validate Claude Code init-project/team hard process contracts.

This mirrors the stronger Codex init-project -> team handoff pattern for the
Claude Code user scope. It is intentionally dependency-free so /init-project can
copy it into project-local `.claude/scripts/` and use it as a hard gate.
"""
from __future__ import annotations

import argparse
import re
import json
import os
import sys
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "2026-05-01.claude-init-team-hard.v1"
CONTRACT_KIND = "claude-init-project-team-hard-process"
REQUIRED_CONTRACT_IDS = {
    "init-project-profile",
    "project-scope-hooks",
    "qa-scenario-contract",
    "qa-cycle-hard-gate",
    "team-precontext-contract",
    "team-runtime-contract",
    "team-handoff-contract",
    "workflow-skill-chain",
    "self-improve-feedback-loop",
    "loopy-era-eval-gate",
    "harness-report-gate",
}
MUST_HAVE_HOOKS = (  # init-project SKILL.md §11 MUST_HAVE 와 동일 집합(UI 변종 task-quality-gate 는 §11 이 별도 판정)
    "qa-gate-before-push.sh", "claim-done-gate.sh", "deploy-verify-marker.sh", "codex-review-gate.sh",
    "no-env-commit.sh", "secret-content-scan.sh", "ai-commit-msg-ban.sh",
)

REQUIRED_EDGE_IDS = {
    "init-project->hard-contract",
    "hard-contract->team-precontext",
    "init-project->team-handoff",
    "team-handoff->team-runtime",
    "hard-contract->qa-scenario-gen",
    "qa-scenarios->qa-cycle",
    "qa-cycle->team-verification-lane",
    "verify-project-scope->hard-contract",
    "init-project->workflow-skill-chain",
    "init-project->generated-project-skills",
    "qa-cycle->self-improve",
    "loopy-era-eval->harness-report",
}
CONNECTED_SKILLS = {
    "init-project",
    "team",
    "qa-scenario-gen",
    "qa-cycle",
    "qa-strategy",
    "auto-issue",
    "self-improve",
    "loopy-era-eval",
    "harness-report",
    "harness-scorecard",
    "backend-patterns",
    "frontend-patterns",
}
# 2026-11-01: `<project>-scaffold` 리터럴을 필수 집합에서 뺀다 — init-project SKILL.md 는 실제 슬러그(예: tiger-bro-webtoon-scaffold)로 치환하라고
#   지시하는데 리터럴을 요구하면 치환한 계약이 required 실패·리터럴은 placeholder 경고라 양립 불가였다. 이제 '-scaffold 로 끝나는 항목 ≥1' 이 조건.
def skills_ok(skills) -> bool:
    if not isinstance(skills, list):
        return False
    names = set(map(str, skills))
    return CONNECTED_SKILLS.issubset(names) and any(n.endswith("-scaffold") for n in names)
USER_SCOPE_MARKERS = {
    "skills/init-project/SKILL.md": [
        "Codex parity: hard process contract gate [HARD]",
        "validate-hard-process-contract.py --project-root \"$(pwd)\" --require-project-contract --json",
        "Every contract item, validator, and edge MUST use",
    ],
    "commands/init-project.md": [
        "## Hard process contract [HARD]",
        "All typed contract values must be `hard`; `soft` is invalid",
    ],
    "skills/team/SKILL.md": [
        "Codex parity: hard process contract prelaunch gate [HARD]",
        "missing_hard_process_contract",
        "soft`, warning-only, best-effort, or prose-only edges are invalid",
    ],
    "commands/team.md": [
        "## Prelaunch hard gate",
        "soft` typed edges are invalid",
    ],
    # agents/team-orchestrator.md 는 2026-09-02 은퇴(스폰 0건) — 2026-10-03 하네스 축소로 /team 은 리드가
    # skills/team/SKILL.md 를 직접 수행하므로 그 계약 마커(위 skills/team/SKILL.md 항목)가 유일한 user-scope 표면이다.
    "skills/qa-scenario-gen/SKILL.md": [
        "Codex parity: hard scenario contract edge [HARD]",
        "blocker_count>0",
    ],
    "skills/qa-cycle/SKILL.md": [
        "Codex parity: hard process and scope gate [HARD]",
        "--scope full-regression",
    ],
    "skills/start-harness/SKILL.md": [
        "Start Harness — Claude Code loopy-era bridge",
        "no typed `soft` values",
    ],
    "scripts/start-harness.sh": [
        "Claude start-harness smoke",
        "validate-hard-process-contract.py",
    ],
    "skills/loopy-era-eval/SKILL.md": [
        "Codex comparison finding: start-harness + hard contract coverage",
        "no typed contract value equals `soft`",
    ],
    "skills/harness-report/SKILL.md": [
        "Codex parity addendum: hard process contract dimension",
        "the literal value `soft` is invalid inside contract artifacts",
    ],
    "scripts/verify-project-scope-load.sh": [
        "hard process contract gate",
        "validate-hard-process-contract.py",
    ],
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate Claude Code hard init/team process contracts")
    parser.add_argument("--project-root", default=os.getcwd())
    parser.add_argument("--require-project-contract", action="store_true")
    parser.add_argument("--user-scope", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def add(checks: list[dict[str, Any]], name: str, ok: bool, evidence: str = "", required: bool = True) -> None:
    checks.append({"name": name, "ok": bool(ok), "required": required, "evidence": evidence})


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except Exception as exc:  # validator reports parse failure as evidence
        return {"__parse_error__": str(exc)}


def walk_values(value: Any) -> list[Any]:
    values = [value]
    if isinstance(value, dict):
        for child in value.values():
            values.extend(walk_values(child))
    elif isinstance(value, list):
        for child in value:
            values.extend(walk_values(child))
    return values


def status_is_hard(item: dict[str, Any]) -> bool:
    for key in ("type", "edge_type", "gate_type", "contract_type", "strength"):
        if key in item and str(item.get(key)).strip().lower() != "hard":
            return False
    return True


def project_contract_path(root: Path) -> Path:
    return root / ".claude" / "loopy-era" / "hard-process-contract.json"


def team_handoff_path(root: Path) -> Path:
    return root / ".claude" / "loopy-era" / "team-handoff.json"


def validate_team_handoff(root: Path, *, require: bool) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    path = team_handoff_path(root)
    if not path.exists():
        add(checks, "team-handoff:exists", not require, str(path), required=require)
        return checks
    data = read_json(path)
    add(checks, "team-handoff:parse", isinstance(data, dict) and "__parse_error__" not in data, str(path))
    if not isinstance(data, dict) or "__parse_error__" in data:
        return checks
    add(checks, "team-handoff:schema-version", data.get("schema_version") == SCHEMA_VERSION, str(data.get("schema_version")))
    add(checks, "team-handoff:type", data.get("contract_type") == "hard", str(data.get("contract_type")))
    add(checks, "team-handoff:handoff-type", data.get("handoff_type") == "init-project-to-team", str(data.get("handoff_type")))
    add(checks, "team-handoff:from-to", data.get("from") in {"/init-project", "$init-project"} and data.get("to") in {"/team", "$team"}, f"{data.get('from')}->{data.get('to')}")
    add(checks, "team-handoff:hard-contract-path", data.get("hard_contract_path") == ".claude/loopy-era/hard-process-contract.json", str(data.get("hard_contract_path")))
    validator = str(data.get("validator_command", ""))
    add(checks, "team-handoff:validator-command", "validate-hard-process-contract.py" in validator and "--require-project-contract" in validator, validator)
    add(checks, "team-handoff:team-runtime-plan-command", bool(str(data.get("team_runtime_plan_command", "")).strip()), str(data.get("team_runtime_plan_command", "")))
    add(checks, "team-handoff:team-runtime-execute-command", bool(str(data.get("team_runtime_execute_command", "")).strip()), str(data.get("team_runtime_execute_command", "")))
    add(checks, "team-handoff:team-launch-hint", str(data.get("team_launch_hint", data.get("claude_team_launch_hint", ""))).startswith("/team"), str(data.get("team_launch_hint", data.get("claude_team_launch_hint", ""))))
    gates = [item for item in data.get("required_prelaunch_gates", []) if isinstance(item, dict)]
    add(checks, "team-handoff:prelaunch-gates-hard", bool(gates) and all(item.get("type") == "hard" for item in gates), str(gates[:3]))
    skills = data.get("connected_workflow_skills")
    add(checks, "team-handoff:connected-workflow-skills", skills_ok(skills), str(skills))
    if isinstance(data, dict):
        bad_lit = [v for v in walk_values(data) if isinstance(v, str) and re.search(r"\$(?:init-project|team|plan-design)\b", v)]
        add(checks, "team-handoff:no-unexpanded-literal", not bad_lit, str(bad_lit[:3]) if bad_lit else "ok", required=False)   # 2026-11-01: fde-maker "from": "$init-project" — Codex 런타임은 '$init-project' 를 라벨로 쓰므로 경고
        tmpl_lit = [v for v in walk_values(data) if isinstance(v, str) and re.search(r"<project>|&lt;project&gt;|\{프로젝트명\}", v)]
        add(checks, "team-handoff:no-template-placeholder", not tmpl_lit, str(tmpl_lit[:3]) if tmpl_lit else "ok", required=False)   # 템플릿 자리표시자(<project>-scaffold) — 전 프로젝트 잔존, 경고

    return checks


def validate_contract(root: Path, *, require: bool) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    path = project_contract_path(root)
    if not path.exists():
        add(checks, "project-contract:exists", not require, str(path), required=require)
        return checks
    data = read_json(path)
    add(checks, "project-contract:parse", isinstance(data, dict) and "__parse_error__" not in data, str(path if "__parse_error__" not in data else data.get("__parse_error__")))
    if not isinstance(data, dict) or "__parse_error__" in data:
        return checks
    add(checks, "project-contract:schema-version", data.get("schema_version") == SCHEMA_VERSION, str(data.get("schema_version")))
    add(checks, "project-contract:kind", data.get("contract_kind") == CONTRACT_KIND, str(data.get("contract_kind")))
    add(checks, "project-contract:type", data.get("contract_type") == "hard", str(data.get("contract_type")))
    contracts = data.get("contracts")
    edges = data.get("contract_edges")
    validators = data.get("validators")
    add(checks, "project-contract:contracts-list", isinstance(contracts, list) and bool(contracts), "contracts")
    add(checks, "project-contract:edges-list", isinstance(edges, list) and bool(edges), "contract_edges")
    add(checks, "project-contract:validators-list", isinstance(validators, list) and bool(validators), "validators")
    contract_ids = {str(item.get("id")) for item in contracts or [] if isinstance(item, dict)}
    edge_ids = {str(item.get("id")) for item in edges or [] if isinstance(item, dict)}
    add(checks, "project-contract:required-contract-ids", REQUIRED_CONTRACT_IDS.issubset(contract_ids), ",".join(sorted(REQUIRED_CONTRACT_IDS - contract_ids)))
    add(checks, "project-contract:required-edge-ids", REQUIRED_EDGE_IDS.issubset(edge_ids), ",".join(sorted(REQUIRED_EDGE_IDS - edge_ids)))
    typed_items = [item for item in (contracts or []) + (edges or []) + (validators or []) if isinstance(item, dict)]
    non_hard = [str(item.get("id") or item.get("command") or item) for item in typed_items if not status_is_hard(item)]
    add(checks, "project-contract:all-typed-items-hard", not non_hard, "; ".join(non_hard[:5]))
    soft_values = [value for value in walk_values(data) if isinstance(value, str) and value.strip().lower() == "soft"]
    add(checks, "project-contract:no-soft-values", not soft_values, str(soft_values[:5]))
    commands = {str(item.get("command", "")) for item in validators or [] if isinstance(item, dict)}
    add(checks, "project-contract:self-validator-command", any("validate-hard-process-contract.py" in command and "--require-project-contract" in command for command in commands), str(sorted(commands)))
    skills = data.get("connected_workflow_skills")
    add(checks, "project-contract:connected-workflow-skills", skills_ok(skills), str(skills))
    # ── project-scope 실체 검사 (2026-11-01 — 2달 감사: 계약 `project-scope-hooks` 가 '설치됨'을 주장하는데 검증기는 JSON 형태만 봐서
    #    훅 0개 프로젝트 5개(memory-bank 71커밋·AK push 19회·fde-maker commit 32 …)와 /team 세션의 계약 자가 생성 3건이 25/25 로 통과했다) ──
    exempt = data.get("project_scope_exempt")
    exempt_decl = isinstance(exempt, dict) and str(exempt.get("approved_by", "")).strip().lower() == "user" and bool(str(exempt.get("reason", "")).strip())
    # 면제는 계약(LLM 쓰기 경로) 선언만으로는 무효 — user scope 설정 파일(~/.claude/config/project-scope-exempt.conf, 사용자 토글 성격)에
    #   같은 repo(절대경로 또는 git common dir sha1[:16])가 적혀 있어야 한다(반박 검증 C-2: approved_by:"user" 한 줄 자가 승인 차단).
    exempt_conf_ok = False
    try:
        conf = Path(os.path.expanduser("~/.claude/config/project-scope-exempt.conf"))
        if conf.is_file():
            import hashlib, subprocess
            key = None
            try:
                r = subprocess.run(["git", "-C", str(root), "rev-parse", "--git-common-dir"], capture_output=True, text=True, timeout=10)
                if r.returncode == 0:
                    common = Path(r.stdout.strip()); common = common if common.is_absolute() else root / common
                    key = hashlib.sha1(str(common.resolve()).encode()).hexdigest()[:16]
            except Exception:
                key = None
            for line in conf.read_text(encoding="utf-8", errors="replace").splitlines():
                tok = line.split("#", 1)[0].strip()
                if tok and (tok == str(root.resolve()) or tok == str(root) or (key and tok == key)):
                    exempt_conf_ok = True
    except OSError:
        exempt_conf_ok = False
    hooks_dir = root / ".claude" / "hooks"
    settings_path = root / ".claude" / "settings.json"
    if exempt_decl and exempt_conf_ok:
        add(checks, "project-scope:exempt-declared", True, f"reason={exempt.get('reason')} · approved_by=user · date={exempt.get('date')} · conf 일치")
    else:
        if exempt_decl and not exempt_conf_ok:
            add(checks, "project-scope:exempt-declared", False, "계약은 면제를 선언했지만 ~/.claude/config/project-scope-exempt.conf 에 이 repo 가 없다 — 사용자가 직접 적어야 유효", required=False)
        def hook_ok(h: str) -> bool:
            fp = hooks_dir / h
            return fp.is_file() and os.access(fp, os.X_OK) and fp.stat().st_size > 0
        missing_files = [h for h in MUST_HAVE_HOOKS if not hook_ok(h)]
        add(checks, "project-scope:hooks-installed", not missing_files,
            ("missing/비실행/0바이트=" + ",".join(missing_files)) if missing_files else f"{len(MUST_HAVE_HOOKS)}/{len(MUST_HAVE_HOOKS)} in {hooks_dir}")
        sj = read_json(settings_path) if settings_path.is_file() else None
        registered: set[str] = set()
        if isinstance(sj, dict) and isinstance(sj.get("hooks"), dict):
            for event, entries in sj["hooks"].items():
                if event not in ("PreToolUse", "PostToolUse", "TaskCompleted", "Stop", "StopWait", "UserPromptSubmit", "SessionStart"):
                    continue
                for ent in entries if isinstance(entries, list) else []:
                    for hk in (ent.get("hooks") if isinstance(ent, dict) else None) or []:
                        if not (isinstance(hk, dict) and hk.get("type") == "command"):
                            continue
                        cmd = str(hk.get("command") or "")
                        for h in MUST_HAVE_HOOKS:
                            if re.search(r"(?:^|[\s/\"'])\.?/?(?:[^\s\"']*/)?\.claude/hooks/" + re.escape(h) + r"(?=[\s\"']|$)", cmd):
                                registered.add(h)
        unreg = [h for h in MUST_HAVE_HOOKS if h not in registered]
        if not settings_path.is_file():
            add(checks, "project-scope:settings-registered", False, f"{settings_path} 없음 — bash ~/.claude/scripts/install-project-hooks.sh <root>")
        else:
            add(checks, "project-scope:settings-registered", not unreg, ("unregistered=" + ",".join(unreg)) if unreg else "ok(hooks[].command 정확 파일명 일치)")
        add(checks, "project-scope:install-version", (root / ".claude" / ".hooks-install-version").is_file(), str(root / ".claude" / ".hooks-install-version"))
    gb = str(data.get("generated_by") or "")
    add(checks, "project-contract:generated-by-init-project", gb.strip().lower().startswith(("/init-project", "init-project")),
        gb or "(없음) — /team 세션·recovery 경로가 쓴 계약은 자가 충족 의심", required=False)
    return checks


def validate_user_scope() -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    claude_home = Path.home() / ".claude"
    for rel, markers in USER_SCOPE_MARKERS.items():
        path = claude_home / rel
        add(checks, f"user-scope:{rel}:exists", path.exists(), str(path))
        text = path.read_text(errors="replace") if path.exists() else ""
        # thin-shell 구조(2026-07-28): SKILL.md 절차 전문이 sibling PROCEDURE.md 로 이동 —
        # 마커 검사는 두 파일 합집합 텍스트로 수행한다.
        if path.name == "SKILL.md":
            proc = path.with_name("PROCEDURE.md")
            if proc.exists():
                text += "\n" + proc.read_text(errors="replace")
        for marker in markers:
            add(checks, f"user-scope:{rel}:marker:{marker[:48]}", marker in text, marker)
    validator = claude_home / "scripts" / "validate-hard-process-contract.py"
    add(checks, "user-scope:validator-executable", os.access(validator, os.X_OK), str(validator))
    return checks


def main() -> int:
    args = parse_args()
    root = Path(args.project_root).resolve()
    checks: list[dict[str, Any]] = []
    if args.user_scope:
        checks.extend(validate_user_scope())
    checks.extend(validate_contract(root, require=args.require_project_contract))
    checks.extend(validate_team_handoff(root, require=args.require_project_contract))
    failed = [item for item in checks if item.get("required", True) and not item.get("ok")]
    payload = {
        "status": "passed" if not failed else "failed",
        "passed": not failed,
        "project_root": str(root),
        "schema_version": SCHEMA_VERSION,
        "checks": checks,
        "failed": failed,
        "summary": f"{sum(1 for c in checks if c.get('required') and c['ok'])}/{sum(1 for c in checks if c.get('required'))} required passed · {sum(1 for c in checks if not c.get('required') and not c['ok'])}/{sum(1 for c in checks if not c.get('required'))} warnings",
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(payload["summary"])
        for item in failed:
            print(f"FAIL {item['name']}: {item.get('evidence','')}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
