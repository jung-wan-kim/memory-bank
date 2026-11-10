import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { injectSocketPathIn } from '../src/version-guard.js';
import { hostSkipReason } from '../src/inject-host-skip.js';
import * as core from '../src/inject-core.js';
import { lineDaemon, closeAll, readInjectLog, shortTmpDir } from './helpers/fake-inject-daemon.js';

/**
 * 호스트별 주입 끄기 스위치는 훅 쪽 환경으로도 판정한다 (2026-11-11, 1.8.0 검수 IH-5).
 *
 * MEMORY_BANK_INJECT_HEADLESS=0 · MEMORY_BANK_INJECT_CODEX=0 은 블록을 계산하는 프로세스의 환경에서만 읽혔다.
 * 데몬이 답하는 경로에서 그 프로세스는 소켓을 쥔 MCP 서버인데, 요청한 세션의 서버가 아니라 먼저 묶은 다른
 * 세션의 서버일 수 있다. 그래서 `MEMORY_BANK_INJECT_HEADLESS=0 claude -p …` 처럼 그 실행에만 주거나 Codex 쪽
 * 환경에만 두면, 데몬이 있을 때는 그대로 주입되고 데몬이 없을 때만 꺼졌다(같은 프롬프트에 972자 또는 0자).
 * 훅 클라이언트는 자기가 어느 호스트인지 이미 안다 — 데몬에 묻기 전에 자기 환경으로 먼저 판정한다.
 * 데몬 쪽 판정은 그대로다(둘 중 한 곳에만 있어도 꺼진다).
 *
 * 여기서는 node 클라이언트를 본다. 네이티브 클라이언트와의 일치는 test/native-inject-client.test.ts.
 */

const REPO = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version as string;
const PROMPT = '호스트별 주입 스위치를 훅 쪽 환경에서 판정하는지 확인한다';
const servers: net.Server[] = [];
let tmp: string;
let received: Array<Record<string, unknown>>;

/** 스위치를 모르는 데몬 — 다른 세션의 MCP 서버처럼, 물으면 언제나 블록을 준다. */
const daemonThatInjects = () => lineDaemon(injectSocketPathIn(path.join(tmp, 'conversation-index'), VERSION)!,
  (_req, c) => c.end(JSON.stringify({ ok: true, context: 'INJECTED-BY-DAEMON', ledger_keys: [] }) + '\n'), servers, received);

function runHook(input: Record<string, unknown>, extra: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MEMORY_BANK_CONFIG_DIR: tmp, MEMORY_BANK_CLIENT: '' };
    for (const k of ['CLAUDE_CODE_ENTRYPOINT', 'USER_PROMPT', 'MEMORY_BANK_INJECT_HEADLESS', 'MEMORY_BANK_INJECT_CODEX', 'MEMORY_BANK_INJECT_DAEMON_FAILED', 'MEMORY_BANK_INJECT_FALLBACK_REASON']) delete env[k];
    Object.assign(env, extra);
    const child = spawn(process.execPath, ['scripts/inject-context.js'], { cwd: REPO, env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout!.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out));
    child.stdin!.end(JSON.stringify({ prompt: PROMPT, cwd: '/tmp/proj', session_id: 'sess-host-switch', hook_event_name: 'UserPromptSubmit', ...input }));
  });
}

beforeEach(() => { tmp = shortTmpDir('/tmp/mbhs-'); received = []; });
afterEach(async () => { await closeAll(servers); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('hostSkipReason 은 가벼운 모듈에 있다 (훅 클라이언트가 무거운 모듈 없이 쓴다)', () => {
  it('inject-core 가 내보내는 것과 같은 함수이고, 모듈은 아무것도 import 하지 않는다', () => {
    expect(core.hostSkipReason).toBe(hostSkipReason);
    const src = fs.readFileSync(path.join(REPO, 'src', 'inject-host-skip.ts'), 'utf8');
    expect(src, 'better-sqlite3·임베딩 모델을 끌어오면 웜 경로가 느려진다').not.toMatch(/^\s*import\s/m);
  });
});

describe('node 클라이언트: 훅의 환경에만 스위치가 있어도 데몬에 묻지 않고 건너뛴다', () => {
  it('MEMORY_BANK_INJECT_HEADLESS=0 + 헤드리스 진입점(sdk-*) → 출력 없음, skipped/headless 한 줄, 데몬은 요청을 받지 않는다', async () => {
    await daemonThatInjects();
    const out = await runHook({ transcript_path: '/tmp/t.jsonl' }, { MEMORY_BANK_INJECT_HEADLESS: '0', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' });
    expect(out, '예전에는 데몬의 블록이 그대로 실렸다').toBe('');
    expect(received).toEqual([]);
    const log = readInjectLog(tmp);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: 'skipped', reason: 'headless', via: 'client', client: 'claude-code', entrypoint: 'sdk-ts', has_session: true, client_impl: 'node', project: '/tmp/proj', prompt_len: PROMPT.length });
  });

  it('MEMORY_BANK_INJECT_CODEX=0 + Codex 프롬프트(turn_id) → 출력 없음, skipped/codex-off', async () => {
    await daemonThatInjects();
    const out = await runHook({ turn_id: 'turn-1' }, { MEMORY_BANK_INJECT_CODEX: '0' });
    expect(out).toBe('');
    expect(received).toEqual([]);
    expect(readInjectLog(tmp).at(-1)).toMatchObject({ status: 'skipped', reason: 'codex-off', via: 'client', client: 'codex' });
  });

  it('대조: 스위치가 있어도 해당하지 않는 호스트(대화형 Claude Code)는 데몬의 블록을 받는다', async () => {
    await daemonThatInjects();
    const out = await runHook({ transcript_path: '/tmp/t.jsonl' }, { MEMORY_BANK_INJECT_HEADLESS: '0', MEMORY_BANK_INJECT_CODEX: '0', CLAUDE_CODE_ENTRYPOINT: 'cli' });
    expect(out).toBe('INJECTED-BY-DAEMON\n');
    expect(received).toHaveLength(1);
  });

  it('대조: 스위치가 없으면 헤드리스·Codex 도 지금처럼 데몬의 블록을 받는다 (기본 동작은 그대로)', async () => {
    await daemonThatInjects();
    expect(await runHook({ transcript_path: '/tmp/t.jsonl' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' })).toBe('INJECTED-BY-DAEMON\n');
    expect(await runHook({ turn_id: 'turn-1' }, {})).toBe('INJECTED-BY-DAEMON\n');
    expect(received).toHaveLength(2);
  });
});
