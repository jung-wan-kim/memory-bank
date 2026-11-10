import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * SessionEnd 훅 워커(scripts/fact-extract-worker.js) **실행** 계약.
 *
 * 워커 원본을 그대로 복사해 자식 프로세스로 돌리고, 의존 dist 모듈만 스텁으로 바꾼다
 * (backfill-worker-execution.test.ts 와 같은 방식 — 소스 문자열 검사로는 "무엇을 어떤
 * 순서로 부르는가"를 검증할 수 없다). 스텁은 불린 순서를 파일에 남긴다.
 */

const SID = '7c2e9a41-3b5d-4f60-8a17-d4e6b0c59f23';
let sandbox: string;

interface StubOptions {
  /** preindexSession 이 돌려줄 상태. 'THROW' 면 예외를 던진다. */
  preindex?: string;
  /** runFactExtraction 이 돌려줄 값(JSON). */
  result?: Record<string, unknown>;
}

function writeStubs(opts: StubOptions = {}): void {
  const dist = path.join(sandbox, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'index'), { recursive: true });
  const order = JSON.stringify(path.join(sandbox, 'order.log'));
  const mark = (name: string) => `fs.appendFileSync(${order}, ${JSON.stringify(name + '\n')});`;

  fs.writeFileSync(path.join(dist, 'session-preindex.js'), `
import fs from 'node:fs';
export async function preindexSession(sessionId) {
  ${mark('preindex')}
  fs.appendFileSync(${order}, 'preindex-arg:' + sessionId + '\\n');
  const status = ${JSON.stringify(opts.preindex ?? 'indexed')};
  if (status === 'THROW') throw new Error('preindex exploded');
  return { status };
}
`);
  fs.writeFileSync(path.join(dist, 'fact-extractor.js'), `
import fs from 'node:fs';
export async function runFactExtraction(_db, sessionId, project) {
  ${mark('extract')}
  fs.appendFileSync(${order}, 'extract-arg:' + sessionId + '|' + project + '\\n');
  return ${JSON.stringify(opts.result ?? { extracted: 2, saved: 2 })};
}
export function classifyExtractionFailure() { return 'internal'; }
export const FAILURE_REPORT = {
  internal: { label: 'ERROR', note: 'i', bucket: 'budget', consumesBudget: true, escalate: true },
};
`);
  fs.writeFileSync(path.join(dist, 'db.js'), `
import fs from 'node:fs';
export function initDatabase() {
  ${mark('db-open')}
  return { close: () => { ${mark('db-close')} } };
}
`);
  fs.writeFileSync(path.join(dist, 'paths.js'),
    `export function getIndexDir() { return ${JSON.stringify(path.join(sandbox, 'index'))}; }\n`);

  // 워커 원본을 그대로 복사 — 검증 대상은 실제 소스여야 한다.
  fs.copyFileSync(
    path.join(__dirname, '..', 'scripts', 'fact-extract-worker.js'),
    path.join(sandbox, 'scripts', 'fact-extract-worker.js'),
  );
}

function runWorker(env: Record<string, string> = {}): { code: number; order: string[]; log: string } {
  let code = 0;
  try {
    execFileSync(process.execPath, ['scripts/fact-extract-worker.js'], {
      cwd: sandbox, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, SESSION_ID: SID, CWD: '/tmp/worker-exec-project', ...env },
    });
  } catch (e) {
    code = (e as { status?: number }).status ?? 1;
  }
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return {
    code,
    order: read(path.join(sandbox, 'order.log')).split('\n').filter(Boolean),
    log: read(path.join(sandbox, 'index', 'fact-extract.log')),
  };
}

beforeEach(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-extract-worker-exec-')); });
afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

describe('훅 워커: 추출 전에 그 세션을 색인한다', () => {
  it('색인 → 추출 순서로 한 번씩 부르고, 같은 세션 id 를 넘긴다', () => {
    writeStubs();
    const { code, order, log } = runWorker();
    expect(code).toBe(0);
    expect(order.filter((l) => l === 'preindex')).toHaveLength(1);
    expect(order.filter((l) => l === 'extract')).toHaveLength(1);
    expect(order.indexOf('preindex')).toBeLessThan(order.indexOf('extract'));
    expect(order).toContain(`preindex-arg:${SID}`);
    expect(order).toContain(`extract-arg:${SID}|/tmp/worker-exec-project`);
    expect(log).toMatch(new RegExp(`preindex session=${SID} status=indexed`));
    expect(log).toMatch(new RegExp(`session=${SID} extracted=2 saved=2`));
  });

  it('색인 0건으로 건너뛴 추출은 사유와 색인 단계 결과를 로그에 남긴다', () => {
    writeStubs({ preindex: 'no_transcript', result: { extracted: 0, saved: 0, skipped: 'not_indexed' } });
    const { code, log } = runWorker();
    expect(code).toBe(0);
    expect(log).toMatch(/SKIPPED \(not_indexed\)/);
    expect(log).toMatch(/preindex=no_transcript/);
    expect(log, '건너뛴 실행을 "0건 처리"로 적으면 안 된다').not.toMatch(/extracted=0 saved=0/);
  });

  it('색인 단계가 예외를 던져도 추출 단계로 가고 훅 불변식(exit 0)을 지킨다', () => {
    writeStubs({ preindex: 'THROW' });
    const { code, order, log } = runWorker();
    expect(code).toBe(0);
    expect(order).toContain('extract');
    expect(log).toMatch(/preindex session=.* status=failed — preindex exploded/);
  });
});
