import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Agent SDK 0.3.x 는 CLI 를 플랫폼별 optionalDependency 로 싣는다(0.1.x 는 cli.js 내장).
 * optional 설치가 빠지면 모든 query() 가 'Native CLI binary … not found' 로 실패한다.
 * 예전 분류로는 'unknown' 이라 통합·분류 루프가 그동안 fact 를 건너뛰었고, 자가치유도
 * 알림도 없었다. 이제 transient(보류) + 1회 npm install + stderr 알림.
 */

const spawned: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: vi.fn((cmd: string, args: string[], opts: { cwd?: string }) => {
    spawned.push({ cmd, args, cwd: opts?.cwd });
    return { unref() {} };
  }),
}));

const SDK_ERROR = new Error(
  'Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.',
);
let root: string;
let stderr: string[];
let restore: () => void;

beforeEach(() => {
  spawned.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-deps-heal-'));
  stderr = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  restore = () => { process.stderr.write = orig; };
});
afterEach(() => {
  restore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('SDK 플랫폼 실행 파일 누락', () => {
  it('보류(transient)로 분류한다 — unknown 이면 루프가 fact 를 건너뛴다', async () => {
    const { classifyLlmError } = await import('../src/llm-error-class.js');
    expect(classifyLlmError(SDK_ERROR)).toBe('transient');
  });

  it('처음 한 번만 npm install 을 띄우고, 매번 stderr 에 알린다', async () => {
    const { noteSdkFailure } = await import('../src/deps-heal.js');
    noteSdkFailure(SDK_ERROR, 'memory-bank llm', root);
    noteSdkFailure(SDK_ERROR, 'memory-bank llm', root);
    expect(spawned).toEqual([{ cmd: 'npm', args: ['install', '--no-audit', '--no-fund'], cwd: root }]);
    expect(fs.existsSync(path.join(root, '.deps-heal-attempted'))).toBe(true);
    const msgs = stderr.filter((l) => l.includes('platform binary missing'));
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toContain('already attempted');
  });

  it('다른 오류에는 아무것도 하지 않는다', async () => {
    const { noteSdkFailure } = await import('../src/deps-heal.js');
    noteSdkFailure(new Error('429 Too Many Requests'), 'memory-bank llm', root);
    expect(spawned).toHaveLength(0);
    expect(stderr.join('')).toBe('');
  });
});
