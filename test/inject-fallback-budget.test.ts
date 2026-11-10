import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { injectSocketPathIn } from '../src/version-guard.js';
import { scriptedDaemon, closeAll, readInjectLog, readLedger, shortTmpDir } from './helpers/fake-inject-daemon.js';

/**
 * 프롬프트 훅의 시간 예산과 대체 경로의 실패 기록 (2026-11-10, 감사 INJ-05 · INJ-07).
 *
 *  - hooks.json 에 timeout 이 없어 호스트 기본값(30초)에 기대고 있었다. 클라이언트 두 판의 예산 상수와
 *    같은 값을 명시하고 셋을 테스트로 묶는다.
 *  - 남은 시간 확인은 ABI 재실행 갈래에만 있었다. 일반 대체 경로(콜드 계산)는 시간이 모자라도 시작했고,
 *    호스트가 기한에 훅을 끊으면 로그 한 줄 없이 사라졌다.
 *  - 콜드 계산의 import 단계가 죽으면 stderr 한 줄(시각 없음)만 남고 주입 로그에는 아무것도 없었다
 *    (오류 로그의 sharp 로드 실패 497블록 대 주입 로그 0줄).
 *  - 데몬이 살아 있지만 느릴 때(daemon-timeout) 콜드 계산을 다시 시작하는 기본 동작은 그대로다.
 *    MEMORY_BANK_INJECT_COLD_ON_TIMEOUT=0 이면 그 계산을 건너뛴다.
 *
 * 클라이언트는 임시 플러그인 폴더에서 실행한다: scripts/inject-context.js 는 그대로 복사하고, dist 는
 * 저장소의 파일을 가리키되 inject-core.js 만 시험용으로 바꿔 끼운다(무거운 모델을 올리지 않는다).
 */

const REPO = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version as string;
const PROMPT = '배포 파이프라인을 Vercel 프리뷰로 바꾸는 방법을 정리해 줘';
const servers: net.Server[] = [];
let tmp: string;
let plug: string;

/** 시험용 dist/inject-core.js 본문들. */
const CORE = {
  /** 계산이 끝나지 않는다 (바쁜 기기에서 모델 로드가 길어지는 모양). */
  hangs: 'export async function computeInjectResult() { await new Promise((r) => setTimeout(r, 120000)); return { context: "", ledgerKeys: [] }; }\n',
  /** import 단계에서 죽는다 (깨진 설치). */
  throwsOnImport: 'throw new Error(\'Could not load the "sharp" module using the darwin-arm64 runtime (simulated broken install)\');\n',
  /** 바로 블록을 돌려준다 — 콜드 계산이 실제로 불렸다는 표지. */
  answers: 'export async function computeInjectResult(prompt, project, via, sessionId, meta) {\n'
    + '  return { context: `COLD-RAN reason=${meta.fallback_reason} impl=${meta.client_impl}`, ledgerKeys: ["cold-1"] };\n}\n',
};

function makePlugin(core: string) {
  plug = path.join(tmp, 'plug');
  fs.mkdirSync(path.join(plug, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(plug, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'scripts', 'inject-context.js'), path.join(plug, 'scripts', 'inject-context.js'));
  for (const f of fs.readdirSync(path.join(REPO, 'dist'))) {
    if (f.endsWith('.js') && f !== 'inject-core.js') fs.symlinkSync(path.join(REPO, 'dist', f), path.join(plug, 'dist', f));
  }
  fs.writeFileSync(path.join(plug, 'dist', 'inject-core.js'), core);
  // 의존성 없는 package.json + PATH 의 가짜 npm: 자가 치유(npm install)가 어떤 경우에도 실제로 돌지 않게
  fs.writeFileSync(path.join(plug, 'package.json'), JSON.stringify({ name: 'memory-bank-test-layout', version: VERSION, type: 'module' }));
  fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'bin', 'npm'), `#!/bin/sh\necho called >> "${path.join(tmp, 'npm-calls.log')}"\n`);
  fs.chmodSync(path.join(tmp, 'bin', 'npm'), 0o755);
}

type Run = { stdout: string; stderr: string; status: number | null; ms: number };
function runClient(env: Record<string, string> = {}, sessionId = 'sess-budget-01'): Promise<Run> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const clean: NodeJS.ProcessEnv = { ...process.env, MEMORY_BANK_CONFIG_DIR: tmp, MEMORY_BANK_CLIENT: '', PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}` };
    for (const k of ['MEMORY_BANK_INJECT_HOOK_BUDGET_MS', 'MEMORY_BANK_INJECT_COLD_ON_TIMEOUT', 'MEMORY_BANK_INJECT_DAEMON_FAILED',
      'MEMORY_BANK_INJECT_REQ_ID', 'MEMORY_BANK_INJECT_FALLBACK_REASON', 'CLAUDE_CODE_ENTRYPOINT', 'USER_PROMPT', 'CWD', 'SESSION_ID']) delete clean[k];
    const child = spawn(process.execPath, [path.join(plug, 'scripts', 'inject-context.js')], { env: { ...clean, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stderr.on('data', (d: string) => { stderr += d; });
    const kill = setTimeout(() => child.kill('SIGKILL'), 45_000);
    child.on('close', (status) => { clearTimeout(kill); resolve({ stdout, stderr, status, ms: Date.now() - t0 }); });
    child.stdin.end(JSON.stringify({ prompt: PROMPT, cwd: '/tmp/proj', session_id: sessionId, hook_event_name: 'UserPromptSubmit', transcript_path: '/tmp/t.jsonl' }));
  });
}
const keyOf = (sid: string) => createHash('sha256').update(sid).digest('hex').slice(0, 12);

beforeEach(() => { tmp = shortTmpDir('/tmp/mbbg-'); });
afterEach(async () => { await closeAll(servers); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('훅 timeout 과 클라이언트 예산 상수', () => {
  it('hooks.json 의 UserPromptSubmit 훅은 timeout 을 명시하고, 그 값이 두 클라이언트의 기본 예산과 같다', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'hooks', 'hooks.json'), 'utf8'));
    const hooks = (cfg.hooks.UserPromptSubmit as Array<{ hooks: Array<Record<string, unknown>> }>).flatMap((g) => g.hooks)
      .filter((h) => String(h.command).includes('hooks/inject-context.sh'));
    expect(hooks).toHaveLength(1);
    expect(hooks[0].async, '주입 훅은 동기다 — 블록이 그 프롬프트에 실려야 한다').toBeUndefined();
    const timeoutS = hooks[0].timeout;
    expect(typeof timeoutS, 'timeout 명시(초)').toBe('number');
    const js = /const DEFAULT_HOOK_BUDGET_MS = ([\d_]+);/.exec(fs.readFileSync(path.join(REPO, 'scripts', 'inject-context.js'), 'utf8'));
    const rs = /const DEFAULT_HOOK_BUDGET_MS: u64 = ([\d_]+);/.exec(fs.readFileSync(path.join(REPO, 'native', 'inject-client', 'src', 'fallback.rs'), 'utf8'));
    expect(js, 'JS 클라이언트의 예산 상수').not.toBeNull();
    expect(rs, '네이티브 클라이언트의 예산 상수').not.toBeNull();
    expect(Number(js![1].replace(/_/g, ''))).toBe((timeoutS as number) * 1000);
    expect(Number(rs![1].replace(/_/g, ''))).toBe((timeoutS as number) * 1000);
  });
});

describe('콜드 대체 경로 — 남은 예산 안에서만', () => {
  it('남은 시간이 모자라면 콜드 계산을 시작하지 않고 skipped/hook-budget 한 줄을 남긴다', async () => {
    makePlugin(CORE.answers);
    const run = await runClient({ MEMORY_BANK_INJECT_HOOK_BUDGET_MS: '5000' }); // 5초 − 여유 3초 − 쓴 시간 < 최소 3초
    expect(run.status).toBe(0);
    expect(run.stdout, '콜드 계산이 불리지 않았다').toBe('');
    const log = readInjectLog(tmp);
    expect(log).toEqual([expect.objectContaining({
      status: 'skipped', reason: 'hook-budget', via: 'fallback', fallback_reason: 'no-daemon', project: '/tmp/proj',
      prompt_len: PROMPT.length, has_session: true, client: 'claude-code', client_impl: 'node', session_key: keyOf('sess-budget-01'), plugin_version: VERSION,
    })]);
    expect(String(log[0].req_id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(readLedger(tmp, 'sess-budget-01')).toBeNull();
  });

  it('양성 대조: 예산이 넉넉하면 같은 상황에서 콜드 계산이 돌고 블록이 전달된다', async () => {
    makePlugin(CORE.answers);
    const run = await runClient();
    expect(run.stdout).toBe('COLD-RAN reason=no-daemon impl=node\n');
    expect(readLedger(tmp, 'sess-budget-01')).toBe('["cold-1"]');
  });

  it('콜드 계산이 예산 안에 끝나지 않으면 스스로 멈추고 error 한 줄을 남긴다 (호스트가 끊으면 흔적이 없다)', async () => {
    makePlugin(CORE.hangs);
    const run = await runClient({ MEMORY_BANK_INJECT_HOOK_BUDGET_MS: '8000' }); // 8초 − 여유 3초 ≈ 5초 뒤 멈춘다
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.ms, `소요 ${run.ms}ms — 예산(8초) 안에 끝난다`).toBeLessThan(8_000);
    expect(run.ms).toBeGreaterThan(3_000);
    const log = readInjectLog(tmp);
    expect(log).toEqual([expect.objectContaining({
      status: 'error', via: 'fallback', fallback_reason: 'no-daemon', has_session: true, client_impl: 'node', session_key: keyOf('sess-budget-01'),
    })]);
    expect(String(log[0].error)).toMatch(/cold fallback not finished after \d+ms — stopped inside the 8000ms hook budget, nothing injected/);
    expect(readLedger(tmp, 'sess-budget-01')).toBeNull();
  }, 30_000);

  it('네이티브 클라이언트가 넘긴 프롬프트도 같은 규칙이다 — 줄어든 예산·같은 req_id·client_impl native', async () => {
    makePlugin(CORE.answers);
    const run = await runClient({
      MEMORY_BANK_INJECT_DAEMON_FAILED: 'daemon-closed', MEMORY_BANK_INJECT_REQ_ID: 'req-from-native-0001',
      MEMORY_BANK_INJECT_HOOK_BUDGET_MS: '4000', // 네이티브가 이미 쓴 시간을 뺀 값
    });
    expect(run.stdout).toBe('');
    expect(readInjectLog(tmp)).toEqual([expect.objectContaining({
      status: 'skipped', reason: 'hook-budget', via: 'fallback', fallback_reason: 'daemon-closed', client_impl: 'native', req_id: 'req-from-native-0001',
    })]);
  });
});

describe('콜드 대체 경로 — import 단계 실패 기록', () => {
  it('무거운 모듈을 불러오다 죽으면 주입 로그에 error 한 줄, stderr 에는 시각·버전이 붙은 줄', async () => {
    makePlugin(CORE.throwsOnImport);
    const before = Date.now();
    const run = await runClient();
    expect(run.status, '훅은 프롬프트를 깨지 않는다').toBe(0);
    expect(run.stdout).toBe('');
    const log = readInjectLog(tmp);
    expect(log).toEqual([expect.objectContaining({
      status: 'error', via: 'fallback', fallback_reason: 'no-daemon', project: '/tmp/proj', prompt_len: PROMPT.length,
      has_session: true, client: 'claude-code', client_impl: 'node', session_key: keyOf('sess-budget-01'), plugin_version: VERSION,
    })]);
    expect(String(log[0].error)).toContain('Could not load the "sharp" module');
    const m = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) v([\d.]+)\] inject-context: error: Could not load the "sharp" module/m.exec(run.stderr);
    expect(m, `stderr:\n${run.stderr}`).not.toBeNull();
    expect(Date.parse(m![1])).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(m![1])).toBeLessThanOrEqual(Date.now() + 1000);
    expect(m![2]).toBe(VERSION);
    expect(fs.existsSync(path.join(tmp, 'npm-calls.log')), '모듈 누락이 아닌 오류에는 자가 치유(npm install)를 띄우지 않는다').toBe(false);
  });
});

describe('daemon-timeout 뒤의 콜드 계산', () => {
  /** 연결은 받지만 답하지 않는 데몬 — 살아 있지만 느린 MCP 서버. */
  const silentDaemon = () => scriptedDaemon(injectSocketPathIn(path.join(tmp, 'conversation-index'), VERSION), () => { /* no answer */ }, servers);

  it('기본: 데몬이 3초 안에 답하지 않으면 콜드 계산으로 넘어간다 (지금까지의 동작)', async () => {
    makePlugin(CORE.answers);
    await silentDaemon();
    const run = await runClient();
    expect(run.stdout).toBe('COLD-RAN reason=daemon-timeout impl=node\n');
    expect(run.ms).toBeGreaterThan(2_900);
  }, 30_000);

  it('MEMORY_BANK_INJECT_COLD_ON_TIMEOUT=0: 콜드 계산을 건너뛰고 skipped/daemon-timeout 한 줄을 남긴다', async () => {
    makePlugin(CORE.answers);
    await silentDaemon();
    const run = await runClient({ MEMORY_BANK_INJECT_COLD_ON_TIMEOUT: '0' });
    expect(run.status).toBe(0);
    expect(run.stdout, '콜드 계산이 불리지 않았다').toBe('');
    expect(run.ms).toBeGreaterThan(2_900);
    expect(readInjectLog(tmp)).toEqual([expect.objectContaining({
      status: 'skipped', reason: 'daemon-timeout', via: 'fallback', fallback_reason: 'daemon-timeout', has_session: true, client_impl: 'node',
    })]);
    expect(readLedger(tmp, 'sess-budget-01')).toBeNull();
  }, 30_000);

  it('그 스위치는 daemon-timeout 에만 작동한다 — 데몬이 없으면(no-daemon) 콜드 계산은 그대로 돈다', async () => {
    makePlugin(CORE.answers);
    const run = await runClient({ MEMORY_BANK_INJECT_COLD_ON_TIMEOUT: '0' });
    expect(run.stdout).toBe('COLD-RAN reason=no-daemon impl=node\n');
  });

  it('네이티브 클라이언트가 daemon-timeout 으로 넘긴 프롬프트에도 같은 스위치가 작동한다', async () => {
    makePlugin(CORE.answers);
    const off = await runClient({ MEMORY_BANK_INJECT_DAEMON_FAILED: 'daemon-timeout', MEMORY_BANK_INJECT_REQ_ID: 'req-native-timeout-01', MEMORY_BANK_INJECT_COLD_ON_TIMEOUT: '0' });
    expect(off.stdout).toBe('');
    expect(readInjectLog(tmp)).toEqual([expect.objectContaining({ status: 'skipped', reason: 'daemon-timeout', client_impl: 'native', req_id: 'req-native-timeout-01' })]);
    const on = await runClient({ MEMORY_BANK_INJECT_DAEMON_FAILED: 'daemon-timeout', MEMORY_BANK_INJECT_REQ_ID: 'req-native-timeout-02' }, 'sess-budget-02');
    expect(on.stdout).toBe('COLD-RAN reason=daemon-timeout impl=native\n');
  });
});
