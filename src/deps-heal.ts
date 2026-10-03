import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Dependency self-heal, shared by the inject hook client and the LLM callers.
 * Node builtins only: it must load even when node_modules is broken.
 */

/** The plugin root — one level above dist/ (and src/ under vitest). */
export function pluginRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Self-heal missing runtime deps (better-sqlite3 등 native 모듈, and since SDK
 * 0.3.x the Agent SDK's platform binary — see isMissingSdkBinary).
 *
 * 왜: (a) `claude plugin update` 가 npm install 을 비결정적으로 누락한다
 * (실측: 1.4.0 캐시엔 node_modules 생성, 1.4.1 캐시엔 미생성 → 콜드 경로
 * 전체가 Cannot find package 로 사망). (b) cc-sync 는 node_modules 를
 * 제외하고 plugins/cache 를 타 머신에 실어 나르므로, 동기화로 받은 캐시는
 * 항상 deps 가 없다. 두 경우 모두 처음 감지한 곳에서 1회 한정으로
 * detached npm install 을 시도한다 (marker 파일 'wx' 원자 생성으로 중복
 * 방지 — 실패해도 다음 설치 디렉토리에서만 재시도, 무한 루프 없음).
 * Returns whether this call spawned it. (Moved from scripts/inject-context.js.)
 */
export function selfHealDeps(root: string, label: string): boolean {
  const marker = path.join(root, '.deps-heal-attempted');
  try {
    fs.writeFileSync(marker, new Date().toISOString(), { flag: 'wx' });
  } catch {
    return false; // already attempted for this install
  }
  try {
    const child = spawn('npm', ['install', '--no-audit', '--no-fund'], {
      // windowsHide: a detached process without an inherited console opens a new
      // conhost window on Windows (no-op elsewhere).
      cwd: root, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    process.stderr.write(`${label}: missing deps detected — spawned background npm install (one-shot)\n`);
    return true;
  } catch (e) {
    process.stderr.write(`${label}: self-heal spawn failed: ${e instanceof Error ? e.message : e}\n`);
    return false;
  }
}

/**
 * Agent SDK 0.3.x ships its CLI as a per-platform optionalDependency
 * (@anthropic-ai/claude-agent-sdk-<platform>-<arch>); 0.1.x bundled cli.js.
 * An install that skipped optional deps (--omit=optional, a registry hiccup, a
 * cache copied from another architecture) fails every query() with this error.
 */
export function isMissingSdkBinary(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /native cli binary for \S+ not found/i.test(message);
}

/**
 * Call at every query() failure. For a missing SDK binary: spawn the one-shot
 * install and say so on stderr — the error itself is classified transient
 * (llm-error-class.ts), so LLM steps hold and resume once the install lands
 * instead of skipping work.
 */
export function noteSdkFailure(err: unknown, label: string, root: string = pluginRoot()): void {
  if (!isMissingSdkBinary(err)) return;
  const spawned = selfHealDeps(root, label);
  process.stderr.write(
    `${label}: Agent SDK platform binary missing (${process.platform}-${process.arch}) — ` +
      (spawned
        ? 'LLM steps are held until the background install lands\n'
        : 'self-heal was already attempted for this install; reinstall the plugin (claude plugin update memory-bank@memory-bank-dev)\n'),
  );
}
