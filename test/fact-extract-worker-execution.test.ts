import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  /** runFactExtraction 이 던질 실패의 분류(classifyExtractionFailure 가 돌려줄 값). */
  throwKind?: string;
  /** runFactExtraction 이 끝나기 전에 기다릴 시간(ms). */
  extractDelayMs?: number;
  /** initDatabase 가 처음 몇 번 'database is locked' 를 던질지. */
  dbOpenFailures?: number;
  /** backfill 대상 여부 탐침(SELECT 1 FROM (pending) WHERE sid = ?)의 답. */
  backfillEligible?: boolean;
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
  await new Promise((r) => setTimeout(r, ${opts.extractDelayMs ?? 0}));
  if (${JSON.stringify(opts.throwKind ?? '')}) throw new Error('extraction blew up');
  return ${JSON.stringify(opts.result ?? { extracted: 2, saved: 2 })};
}
export function classifyExtractionFailure() { return ${JSON.stringify(opts.throwKind ?? 'internal')}; }
export const FAILURE_REPORT = {
  handoff: { label: 'HANDOFF', note: 'table-note-handoff', bucket: 'handoff', consumesBudget: false, escalate: false },
  provider_transient: { label: 'ERROR', note: 'table-note-transient 다음 run 재시도', bucket: 'transient', consumesBudget: false, escalate: false },
  provider_deterministic: { label: 'ERROR', note: 'table-note-deterministic', bucket: 'budget', consumesBudget: true, escalate: false },
  internal: { label: 'ERROR', note: 'table-note-internal 예산 소모', bucket: 'budget', consumesBudget: true, escalate: true },
};
`);
  fs.writeFileSync(path.join(dist, 'db.js'), `
import fs from 'node:fs';
const counter = ${JSON.stringify(path.join(sandbox, 'db-open-count'))};
export function initDatabase() {
  const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
  fs.writeFileSync(counter, String(n));
  if (n <= ${opts.dbOpenFailures ?? 0}) throw new Error('database is locked');
  ${mark('db-open')}
  return {
    prepare: (sql) => ({
      get: (...args) => {
        fs.appendFileSync(${order}, 'probe:' + JSON.stringify({ sql: String(sql), args }) + '\\n');
        return ${opts.backfillEligible ? '{ 1: 1 }' : 'undefined'};
      },
    }),
    close: () => { ${mark('db-close')} },
  };
}
`);
  fs.writeFileSync(path.join(dist, 'pending-extraction.js'), `
import fs from 'node:fs';
export function getExtractionConfig() { return { minExchanges: 2, excludeProjects: ['/x'], quietMinutes: 60 }; }
export function pendingExtractionCoreQuery(cfg) {
  fs.appendFileSync(${order}, 'pending-cfg:' + JSON.stringify(cfg) + '\\n');
  return { sql: 'SELECT sid FROM stub_pending WHERE cwd <> ?', params: ['/x'] };
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

const workerEnv = (env: Record<string, string>) =>
  ({ ...process.env, SESSION_ID: SID, CWD: '/tmp/worker-exec-project', ...env });
const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const orderLines = () => read(path.join(sandbox, 'order.log')).split('\n').filter(Boolean);
const workerLog = () => read(path.join(sandbox, 'index', 'fact-extract.log'));

function runWorker(env: Record<string, string> = {}): { code: number; order: string[]; log: string } {
  let code = 0;
  try {
    execFileSync(process.execPath, ['scripts/fact-extract-worker.js'], {
      cwd: sandbox, encoding: 'utf8', timeout: 30_000, env: workerEnv(env),
    });
  } catch (e) {
    code = (e as { status?: number }).status ?? 1;
  }
  return { code, order: orderLines(), log: workerLog() };
}

const lockDir = () => path.join(sandbox, 'index', 'extract-locks');
const lockFile = () => path.join(lockDir(), `${createHash('sha256').update(SID).digest('hex').slice(0, 32)}.lock`);
function writeLock(content: string, ageMs = 0): void {
  fs.mkdirSync(lockDir(), { recursive: true });
  fs.writeFileSync(lockFile(), content);
  if (ageMs > 0) {
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(lockFile(), at, at);
  }
}
/** 이미 끝난 프로세스의 pid. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

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

  it('세션 상한으로 잘린 후보 수와 자격증명으로 버린 사실 수를 결과 줄에 남긴다 (없으면 적지 않는다)', () => {
    writeStubs({ result: {
      extracted: 60, saved: 60, truncated: 36, rejectedSecrets: 2,
      rejectedInvalid: { 'fact-session-environment': 3, 'fact-bracket-placeholder': 1 },
      scopeProject: '/repos/app main',
    } });
    expect(runWorker().log).toMatch(
      /extracted=60 saved=60 truncated=36 rejected_secret=2 rejected_invalid=fact-session-environment×3,fact-bracket-placeholder×1 scope_project=\/repos\/app main$/m,
    );

    fs.rmSync(path.join(sandbox, 'index', 'fact-extract.log'));
    writeStubs({ result: { extracted: 3, saved: 3 } });
    const { log } = runWorker();
    expect(log).toMatch(/extracted=3 saved=3/);
    expect(log).not.toMatch(/truncated|rejected_secret|rejected_invalid|scope_project/);
  });

  it('색인 0건으로 건너뛴 추출은 사유와 색인 단계 결과를 로그에 남긴다', () => {
    writeStubs({ preindex: 'no_transcript', result: { extracted: 0, saved: 0, skipped: 'not_indexed' } });
    const { code, log } = runWorker();
    expect(code).toBe(0);
    expect(log).toMatch(/SKIPPED \(not_indexed\)/);
    expect(log).toMatch(/preindex=no_transcript/);
    expect(log, '건너뛴 실행을 "0건 처리"로 적으면 안 된다').not.toMatch(/extracted=0 saved=0/);
  });

  it('새 대화가 없어 건너뛴 추출도 사유를 남긴다', () => {
    writeStubs({ result: { extracted: 0, saved: 0, skipped: 'no_new_exchanges' } });
    const { log } = runWorker();
    expect(log).toMatch(/SKIPPED \(no_new_exchanges\)/);
    expect(log).not.toMatch(/extracted=0 saved=0/);
  });

  it('색인 단계가 예외를 던져도 추출 단계로 가고 훅 불변식(exit 0)을 지킨다', () => {
    writeStubs({ preindex: 'THROW' });
    const { code, order, log } = runWorker();
    expect(code).toBe(0);
    expect(order).toContain('extract');
    expect(log).toMatch(/preindex session=.* status=failed — preindex exploded/);
  });
});

describe('훅 워커: 실패 문구가 실제 처리와 같다', () => {
  it('DB 를 끝내 열지 못하면 db_open_failed 로 적고, 쓰지 않은 예산을 썼다고 하지 않는다', () => {
    writeStubs({ dbOpenFailures: 99 });
    const { code, order, log } = runWorker();
    expect(code).toBe(0);
    expect(order, '선점 전에 멈춘다').not.toContain('extract');
    expect(log).toMatch(/ERROR \(db_open_failed\) session=.*database is locked/);
    expect(log).toMatch(/마커·재시도 예산은 그대로/);
    expect(log, '분류표의 "예산 소모" 문구가 붙으면 거짓이다').not.toMatch(/table-note-internal|예산 소모/);
    expect(read(path.join(sandbox, 'db-open-count')), '유계 재시도').toBe('3');
  });

  it('DB 열기의 일시 잠금은 재시도로 넘기고 추출까지 간다', () => {
    writeStubs({ dbOpenFailures: 2 });
    const { order, log } = runWorker();
    expect(order).toContain('extract');
    expect(log).not.toMatch(/db_open_failed/);
    expect(log).toMatch(/extracted=2 saved=2/);
  });

  it('공급자 일시 실패: backfill 이 다시 집을 수 있는 세션이면 그렇게 적는다', () => {
    writeStubs({ throwKind: 'provider_transient', backfillEligible: true });
    const { code, order, log } = runWorker();
    expect(code).toBe(0);
    expect(log).toMatch(/ERROR \(provider_transient\) session=.*extraction blew up — .*backfill 이 다시 처리/);
    expect(log, '훅 경로에는 "다음 run" 이 없다').not.toMatch(/다음 run 재시도/);
    // backfill 과 같은 술어에 조용함 조건만 끄고, 이 세션 하나를 묻는다.
    expect(order).toContain(`pending-cfg:${JSON.stringify({ minExchanges: 2, excludeProjects: ['/x'], quietMinutes: 0 })}`);
    const probe = JSON.parse(order.find((l) => l.startsWith('probe:'))!.slice('probe:'.length));
    expect(probe.sql).toBe('SELECT 1 FROM (SELECT sid FROM stub_pending WHERE cwd <> ?) WHERE sid = ? LIMIT 1');
    expect(probe.args).toEqual(['/x', SID]);
  });

  it('공급자 일시 실패: backfill 대상이 아니면 다시 시도될 경로가 없다고 적는다', () => {
    writeStubs({ throwKind: 'provider_transient', backfillEligible: false });
    const { log } = runWorker();
    expect(log).toMatch(/ERROR \(provider_transient\).*backfill 대상이 아님.*다시 시도되지 않음/);
    expect(log).not.toMatch(/다음 run 재시도|backfill 이 다시 처리/);
  });

  it('선점 뒤의 내부 실패는 분류표 문구 그대로 적는다', () => {
    writeStubs({ throwKind: 'internal' });
    const { code, log } = runWorker();
    expect(code).toBe(0);
    expect(log).toMatch(/ERROR \(internal\) session=.*extraction blew up — table-note-internal/);
  });
});

describe('훅 워커: 세션당 하나만 돈다', () => {
  it('종료 사유를 시작 줄에 남기고, 끝나면 잠금 파일을 치운다', () => {
    writeStubs();
    const { log } = runWorker({ SESSION_END_REASON: 'prompt_input_exit' });
    expect(log).toMatch(new RegExp(`extracting session=${SID} project=/tmp/worker-exec-project reason=prompt_input_exit`));
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('사유가 없거나 이상한 값이면 unknown 으로 적는다 (로그 줄을 깨지 않게)', () => {
    writeStubs();
    expect(runWorker().log).toMatch(/reason=unknown/);
    fs.rmSync(path.join(sandbox, 'index', 'fact-extract.log'));
    expect(runWorker({ SESSION_END_REASON: 'two words\nextracted=9 saved=9' }).log).toMatch(/reason=unknown/);
    expect(workerLog()).not.toMatch(/saved=9/);
  });

  it('살아 있는 워커가 같은 세션을 쥐고 있으면 색인도 추출도 하지 않는다', () => {
    writeStubs();
    writeLock(`${process.pid}\n${new Date().toISOString()}\n${SID}\n`);
    const { code, order, log } = runWorker({ SESSION_END_REASON: 'other' });
    expect(code).toBe(0);
    expect(order).toEqual([]);
    expect(log).toMatch(new RegExp(`SKIPPED \\(already_running\\) session=${SID} reason=other .*pid ${process.pid}`));
    expect(fs.readFileSync(lockFile(), 'utf8'), '남의 잠금을 지우지 않는다').toContain(String(process.pid));
  });

  it('죽은 워커가 남긴 잠금은 치우고 진행한다', () => {
    writeStubs();
    writeLock(`${deadPid()}\n${new Date().toISOString()}\n${SID}\n`);
    const { order, log } = runWorker();
    expect(order).toContain('extract');
    expect(log).not.toMatch(/already_running/);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('방금 생겼고 아직 내용이 없는 잠금은 주인이 쓰는 중으로 보고 양보한다', () => {
    writeStubs();
    writeLock('');
    const { order, log } = runWorker();
    expect(order).toEqual([]);
    expect(log).toMatch(/SKIPPED \(already_running\)/);
  });

  it('내용 없이 오래된 잠금은 치우고 진행한다', () => {
    writeStubs();
    writeLock('', 10 * 60_000);
    expect(runWorker().order).toContain('extract');
  });

  it('두 워커가 겹치면 하나만 추출한다', async () => {
    writeStubs({ extractDelayMs: 1500 });
    const first = spawn(process.execPath, ['scripts/fact-extract-worker.js'], {
      cwd: sandbox, stdio: 'ignore', env: workerEnv({ SESSION_END_REASON: 'first' }),
    });
    const firstDone = new Promise<number | null>((resolve) => first.on('exit', resolve));
    // 첫 워커가 추출 단계에 들어갈 때까지 기다린다(잠금은 그보다 먼저 잡힌다).
    for (let i = 0; i < 200 && !orderLines().includes('extract'); i++) await new Promise((r) => setTimeout(r, 25));
    expect(orderLines()).toContain('extract');

    const second = runWorker({ SESSION_END_REASON: 'second' });
    expect(second.log).toMatch(/SKIPPED \(already_running\) session=.* reason=second/);

    expect(await firstDone).toBe(0);
    expect(orderLines().filter((l) => l === 'extract')).toHaveLength(1);
    expect(orderLines().filter((l) => l === 'preindex')).toHaveLength(1);
    expect(fs.existsSync(lockFile())).toBe(false);
  }, 20_000);
});

describe('SessionEnd 훅: 워커에 넘기는 값', () => {
  /** 훅 원본을 복사하고, 워커 자리에는 받은 환경을 파일로 남기는 스텁을 둔다. */
  async function runHook(input: Record<string, unknown>): Promise<Record<string, string>> {
    fs.mkdirSync(path.join(sandbox, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'dist', 'node-abi.js'), 'export function ensureNativeAbi() {}\n');
    fs.copyFileSync(
      path.join(__dirname, '..', 'scripts', 'fact-extract-hook.js'),
      path.join(sandbox, 'scripts', 'fact-extract-hook.js'),
    );
    const seen = path.join(sandbox, 'worker-env.json');
    fs.writeFileSync(path.join(sandbox, 'scripts', 'fact-extract-worker.js'), `
import fs from 'node:fs';
const { SESSION_ID, CWD, SESSION_END_REASON } = process.env;
fs.writeFileSync(${JSON.stringify(seen + '.tmp')}, JSON.stringify({ SESSION_ID, CWD, SESSION_END_REASON }));
fs.renameSync(${JSON.stringify(seen + '.tmp')}, ${JSON.stringify(seen)});
`);
    const env = { ...process.env };
    delete env.SESSION_ID; delete env.CWD; delete env.SESSION_END_REASON; delete env.PROJECT_DIR;
    const r = spawnSync(process.execPath, ['scripts/fact-extract-hook.js'], {
      cwd: sandbox, encoding: 'utf8', timeout: 30_000, input: JSON.stringify(input), env,
    });
    expect(r.status).toBe(0);
    // 워커는 떼어 낸(detached) 프로세스다 — 결과 파일이 생길 때까지 기다린다.
    for (let i = 0; i < 400 && !fs.existsSync(seen); i++) await new Promise((res) => setTimeout(res, 25));
    return JSON.parse(fs.readFileSync(seen, 'utf8'));
  }

  it('stdin 의 session_id·cwd·reason 을 워커 환경으로 넘긴다', async () => {
    const got = await runHook({ session_id: SID, cwd: '/tmp/hook-exec-project', hook_event_name: 'SessionEnd', reason: 'logout' });
    expect(got).toEqual({ SESSION_ID: SID, CWD: '/tmp/hook-exec-project', SESSION_END_REASON: 'logout' });
  }, 20_000);

  it('reason 이 없거나 문자열이 아니면 빈 값으로 넘긴다', async () => {
    const got = await runHook({ session_id: SID, cwd: '/tmp/hook-exec-project', reason: { nested: true } });
    expect(got.SESSION_END_REASON).toBe('');
  }, 20_000);
});
