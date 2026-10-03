import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { suppressConsole } from './test-utils.js';

/**
 * 계산 실패는 「빈 성공」과 구분된다 (2026-10-03, v1.7.1 독립 검토 지적).
 * 데몬은 이 표시를 보고 {ok:false} 로 답해 클라이언트를 대체 경로로 보낸다.
 * 표시가 없으면 모델 로드가 실패한 데몬이 프롬프트마다 빈 블록을 성공으로 돌려준다.
 */

vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: vi.fn(async () => { throw new Error('model load failed'); }),
  generateEmbedding: vi.fn(),
  queryBaseline: vi.fn(),
}));

const restoreConsole = suppressConsole();
const prevEnv = { ...process.env };
let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-inject-fail-'));
  process.env.MEMORY_BANK_CONFIG_DIR = tmp;
  process.env.TEST_DB_PATH = path.join(tmp, 'test.db');
});

afterAll(() => {
  process.env = prevEnv;
  restoreConsole();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('computeInjectResult — 계산 실패', () => {
  it('모델 로드가 실패하면 failed 를 표시하고 로그에 error 로 남긴다', async () => {
    const core = await import('../src/inject-core.js');
    const r = await core.computeInjectResult(
      'How does our deploy pipeline publish Vercel previews for pull requests?',
      '/tmp/proj', 'daemon', 'sess-fail-0001',
    );
    expect(r).toEqual({ context: '', ledgerKeys: [], failed: true });
    const { getInjectLogPath } = await import('../src/inject-log.js');
    const last = JSON.parse(fs.readFileSync(getInjectLogPath(), 'utf8').trim().split('\n').at(-1)!);
    expect(last).toMatchObject({ status: 'error', error: 'model load failed' });
  });

  it('건너뛴 프롬프트와 일치 없음은 실패가 아니다', async () => {
    const core = await import('../src/inject-core.js');
    const r = await core.computeInjectResult('<task-notification>\n<status>completed</status>\n</task-notification>', '/tmp/proj', 'daemon');
    expect(r.failed).toBeUndefined();
  });
});
