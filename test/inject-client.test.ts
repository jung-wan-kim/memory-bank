import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 얇은 훅 클라이언트(scripts/inject-context.js)를 실제 자식 프로세스로 실행한다.
 * 수정 전에는 짧은 프롬프트를 로그 없이 버렸고, 작업 알림은 거르지 않고 데몬에
 * 보내 사실을 주입했다. 이제 둘 다 데몬에 닿기 전에 이유와 함께 skipped 로 남는다.
 * (dist 를 읽으므로 pretest 빌드 산출물로 돈다 — 등록된 실행 형태 그대로.)
 */

const REPO = path.resolve(__dirname, '..');
let tmp: string;

function runHook(input: Record<string, unknown> | string, env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, ['scripts/inject-context.js'], {
    cwd: REPO, encoding: 'utf8', timeout: 20_000,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, MEMORY_BANK_CONFIG_DIR: tmp, MEMORY_BANK_CLIENT: '', ...env },
  });
}

function lastLog(): Record<string, unknown> {
  const p = path.join(tmp, 'conversation-index', 'logs', 'inject-context.jsonl');
  return JSON.parse(fs.readFileSync(p, 'utf8').trim().split('\n').at(-1)!);
}

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-inject-client-')); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('inject-context.js 클라이언트 거르기', () => {
  it('Claude Code 의 작업 알림은 출력 없이 skipped(task-notification) 로 남는다', () => {
    const out = runHook({
      prompt: '<task-notification>\n<task-id>w4fya4o1a</task-id>\n<status>completed</status>\n</task-notification>',
      cwd: '/tmp/proj', session_id: 'sess-client-0001', transcript_path: '/tmp/t.jsonl',
      hook_event_name: 'UserPromptSubmit',
    });
    expect(out).toBe('');
    expect(lastLog()).toMatchObject({
      status: 'skipped', reason: 'task-notification', via: 'client',
      client: 'claude-code', has_session: true, project: '/tmp/proj',
    });
  });

  it('Codex 봉투(turn_id)는 codex 로 태그되고, 짧은 프롬프트도 이제 로그에 남는다', () => {
    runHook({ prompt: '응', cwd: '/tmp/proj', session_id: 'codex-sess-01', turn_id: 't1', transcript_path: '/x' });
    expect(lastLog()).toMatchObject({ status: 'skipped', reason: 'short', client: 'codex', prompt_len: 1 });
  });

  it('Codex 래퍼 방식(표준입력 비움 + 봉투를 USER_PROMPT 로)도 프롬프트·세션·작업 경로를 꺼낸다', () => {
    // ~/.codex/hooks/memory-bank/inject-context.sh 는 USER_PROMPT=$(cat) 로 봉투 전체를 넘긴다
    const envelope = JSON.stringify({
      session_id: 'codex-sess-envelope', turn_id: 't9', transcript_path: '/x.jsonl',
      cwd: '/tmp/codex-proj', hook_event_name: 'UserPromptSubmit', model: 'gpt', prompt: '좋아',
    });
    runHook('', { USER_PROMPT: envelope, CWD: '/tmp/wrapper-pwd' });
    expect(lastLog()).toMatchObject({
      status: 'skipped', reason: 'short', prompt_len: 2, client: 'codex',
      has_session: true, project: '/tmp/codex-proj',
    });
  });

  it('봉투가 아닌 JSON 텍스트 프롬프트는 그대로 둔다', () => {
    runHook('', { USER_PROMPT: '{"a":1}' });
    expect(lastLog()).toMatchObject({ reason: 'short', prompt_len: 7 });
  });

  it('래퍼가 준 MEMORY_BANK_CLIENT 가 추론보다 우선한다', () => {
    runHook({ prompt: '<command-name>/clear</command-name>', cwd: '/tmp/proj' }, { MEMORY_BANK_CLIENT: 'codex' });
    expect(lastLog()).toMatchObject({ reason: 'slash-command', client: 'codex', has_session: false });
  });
});
