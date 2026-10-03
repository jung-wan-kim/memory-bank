import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { suppressConsole } from './test-utils.js';

/**
 * computeInjectContext 회귀 (2026-10-03 수정분).
 *  - 하네스가 보낸 메시지(작업 알림 등)는 검색 없이 건너뛰고 이유를 로그에 남긴다
 *  - id 가 다른 같은 문장은 한 블록에 한 번만, 다음 프롬프트에서도 다시 싣지 않는다
 *  - 반복 감지는 기본 꺼짐, MEMORY_BANK_REPEAT_DETECT=1 에서만 돈다
 *  - 단계별 시간·출처·호출자 필드가 로그에 남는다
 * 실제 임베딩 모델과 임시 DB 를 쓴다(모킹하면 기준선 게이트를 통과하는지 못 본다).
 */

const restoreConsole = suppressConsole();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-inject-core-'));
const DEPLOY = 'The deploy pipeline publishes a Vercel preview for every pull request before merge';
const prevEnv = { ...process.env };

type LogLine = Record<string, unknown>;
let readLog: () => LogLine[];
let core: typeof import('../src/inject-core.js');
let embed: typeof import('../src/embeddings.js');
let factDb: typeof import('../src/fact-db.js');
let dbMod: typeof import('../src/db.js');

async function addFact(text: string): Promise<string> {
  const db = dbMod.initDatabase();
  try {
    return factDb.insertFact(db, {
      fact: text, category: 'decision', scope_type: 'global', scope_project: null,
      source_exchange_ids: [], embedding: await embed.generateEmbedding(text, 'passage'),
    });
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  process.env.MEMORY_BANK_CONFIG_DIR = tmp;
  process.env.TEST_DB_PATH = path.join(tmp, 'test.db');
  delete process.env.MEMORY_BANK_REPEAT_DETECT;
  core = await import('../src/inject-core.js');
  embed = await import('../src/embeddings.js');
  factDb = await import('../src/fact-db.js');
  dbMod = await import('../src/db.js');
  const { getInjectLogPath } = await import('../src/inject-log.js');
  readLog = () => fs.readFileSync(getInjectLogPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  await embed.initEmbeddings();
  // 같은 문장을 id 만 다르게 두 번 — 실 DB 의 이중 저장(메모리 문서 이중 import)과 같은 모양
  await addFact(DEPLOY);
  await addFact(DEPLOY);
  await addFact('Database migrations run through Flyway with versioned SQL files only');
}, 120_000);

afterAll(() => {
  process.env = prevEnv;
  restoreConsole();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.MEMORY_BANK_REPEAT_DETECT;
});

describe('computeInjectContext', () => {
  it('작업 알림은 검색하지 않고 이유와 함께 skipped 로 남긴다', async () => {
    const out = await core.computeInjectContext(
      '<task-notification>\n<task-id>b9ex41zdi</task-id>\n<status>completed</status>\n</task-notification>',
      '/tmp/proj', 'daemon', 'sess-gate-0001', { client: 'claude-code' },
    );
    expect(out).toBe('');
    const last = readLog().at(-1)!;
    expect(last).toMatchObject({ status: 'skipped', reason: 'task-notification', via: 'daemon', client: 'claude-code', has_session: true });
    expect(last.embed_ms, '알림에 임베딩을 계산하면 안 된다').toBeUndefined();
  });

  it('id 만 다른 같은 문장은 블록에 한 번만 싣고, 단계 시간·출처를 기록한다', async () => {
    const out = await core.computeInjectContext(
      'How does our deploy pipeline publish Vercel previews for pull requests?',
      '/tmp/proj', 'daemon', 'sess-dedup-0001', { client: 'codex', entrypoint: 'cli' },
    );
    const hits = out.split('\n').filter((l) => l.includes('deploy pipeline publishes a Vercel preview'));
    expect(hits, `블록:\n${out}`).toHaveLength(1);
    const last = readLog().at(-1)!;
    expect(last).toMatchObject({ status: 'injected', text_deduped: 1, from_rel: 0, client: 'codex', entrypoint: 'cli', has_session: true });
    expect(last.from_vec).toBe(last.injected);
    for (const k of ['embed_ms', 'search_ms', 'related_ms']) expect(typeof last[k], k).toBe('number');
    expect(last.repeat_ms, '반복 감지는 기본 꺼짐').toBeUndefined();
  }, 30_000);

  it('같은 세션의 다음 프롬프트는 세 번째 사본(새 id)도 본문 키로 거른다', async () => {
    await addFact(DEPLOY); // 첫 주입 이후 새 id 로 같은 문장이 또 저장됨
    const out = await core.computeInjectContext(
      'Remind me again how the deploy pipeline handles Vercel previews for pull requests',
      '/tmp/proj', 'daemon', 'sess-dedup-0001',
    );
    expect(out.includes('deploy pipeline publishes a Vercel preview'), `블록:\n${out}`).toBe(false);
    const last = readLog().at(-1)!;
    expect(Number(last.text_deduped)).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('MEMORY_BANK_REPEAT_DETECT=1 일 때만 반복 감지가 돈다', async () => {
    process.env.MEMORY_BANK_REPEAT_DETECT = '1';
    await core.computeInjectContext(
      'What is our policy for database migrations with Flyway versioned SQL?',
      '/tmp/proj', 'daemon', 'sess-repeat-0001',
    );
    const last = readLog().at(-1)!;
    expect(last.status).toBe('injected');
    expect(typeof last.repeat_ms).toBe('number');
  }, 30_000);
});
