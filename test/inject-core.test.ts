import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { suppressConsole } from './test-utils.js';

/**
 * computeInjectResult 회귀 (2026-10-03 수정분).
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
let ledgerMod: typeof import('../src/inject-ledger.js');

/**
 * 블록을 출력하는 쪽이 하는 일: 계산하고, 블록을 쓰고, 그다음에 그 fact 를 원장에 기록한다
 * (scripts/inject-context.js 의 deliver). 원장을 쓰는 함수는 라이브러리에 두지 않는다 —
 * 출력 없이 기록하는 함수가 있으면 그것을 따라 배선한 호출자가 1.7.1 결함을 되살린다.
 */
async function injectAndRecord(...args: Parameters<typeof core.computeInjectResult>): Promise<string> {
  const r = await core.computeInjectResult(...args);
  const sessionId = args[3];
  if (r.ledgerKeys.length > 0) ledgerMod.appendLedger(sessionId, ledgerMod.loadLedger(sessionId), r.ledgerKeys);
  return r.context;
}

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
  ledgerMod = await import('../src/inject-ledger.js');
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
  delete process.env.MEMORY_BANK_INJECT_HEADLESS;
  delete process.env.MEMORY_BANK_INJECT_CODEX;
});

describe('computeInjectResult', () => {
  it('작업 알림은 검색하지 않고 이유와 함께 skipped 로 남긴다', async () => {
    const out = await injectAndRecord(
      '<task-notification>\n<task-id>b9ex41zdi</task-id>\n<status>completed</status>\n</task-notification>',
      '/tmp/proj', 'daemon', 'sess-gate-0001', { client: 'claude-code' },
    );
    expect(out).toBe('');
    const last = readLog().at(-1)!;
    expect(last).toMatchObject({ status: 'skipped', reason: 'task-notification', via: 'daemon', client: 'claude-code', has_session: true });
    expect(last.embed_ms, '알림에 임베딩을 계산하면 안 된다').toBeUndefined();
  });

  it('id 만 다른 같은 문장은 블록에 한 번만 싣고, 단계 시간·출처를 기록한다', async () => {
    const out = await injectAndRecord(
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

  it('log fields: injected 줄에 margin·게이트 통과 id·주입 id·세션 키·버전이 남는다', async () => {
    const { createHash } = await import('crypto');
    const sid = 'sess-fields-0001';
    const out = await injectAndRecord(
      'Which tool runs our database migrations and in what file format?',
      '/tmp/proj', 'daemon', sid,
    );
    expect(out).toContain('Flyway');
    const last = readLog().at(-1)!;
    expect(last.status).toBe('injected');
    const margins = last.top_margins as number[];
    expect(margins.length).toBe(last.candidates);
    for (const m of margins) expect(Math.round(m * 1000) / 1000).toBe(m);
    expect(margins[0]).toBeGreaterThanOrEqual(0.045);
    const gated = last.gated_ids as string[];
    const injected = last.injected_ids as string[];
    expect(gated.length).toBeGreaterThan(0);
    for (const id of [...gated, ...injected]) expect(id).toHaveLength(12);
    expect(injected).toHaveLength(Number(last.injected));
    expect(last.session_key).toBe(createHash('sha256').update(sid).digest('hex').slice(0, 12));
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
    expect(last.plugin_version).toBe(pkg.version);
  }, 30_000);

  it('log fields: no-match 줄은 빈 gated_ids 와 후보별 margin, 세션 없으면 session_key 없음', async () => {
    const out = await injectAndRecord(
      'Write a haiku about autumn leaves falling on a quiet mountain temple roof',
      '/tmp/proj', 'fallback', undefined,
    );
    expect(out).toBe('');
    const last = readLog().at(-1)!;
    expect(last.status).toBe('no-match');
    expect(last.gated_ids).toEqual([]);
    expect((last.top_margins as number[]).length).toBe(last.candidates);
    expect(last.injected_ids).toBeUndefined();
    expect('session_key' in last).toBe(false);
  }, 30_000);

  it('운영 주입은 저장소 가족 scope 를 쓴다: 저장소 루트에서 나온 사실이 하위 폴더 세션에 실린다', async () => {
    const repo = path.join(tmp, 'family-repo');
    const sibling = `${repo}-cloud`;
    for (const r of [repo, sibling]) {
      fs.mkdirSync(path.join(r, '.git'), { recursive: true });
      fs.writeFileSync(path.join(r, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    }
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    const db = dbMod.initDatabase();
    try {
      const text = 'The family repo signs release builds with the hardware key held by the release manager';
      factDb.insertFact(db, {
        fact: text, category: 'decision', scope_type: 'project', scope_project: repo,
        source_exchange_ids: [], embedding: await embed.generateEmbedding(text, 'passage'),
      });
      const sibText = 'The family repo cloud twin signs release builds with a hardware key kept in the office safe';
      factDb.insertFact(db, {
        fact: sibText, category: 'decision', scope_type: 'project', scope_project: sibling,
        source_exchange_ids: [], embedding: await embed.generateEmbedding(sibText, 'passage'),
      });
    } finally {
      db.close();
    }
    const q = 'Who holds the hardware key that signs release builds of the family repo?';
    const fromDocs = await injectAndRecord(q, path.join(repo, 'docs'), 'daemon', 'sess-family-0001');
    expect(fromDocs, '하위 폴더 세션').toContain('hardware key held by the release manager');
    expect(fromDocs.includes('kept in the office safe'), '이름이 이어진 형제 저장소의 사실은 하위 폴더 세션에 실리지 않는다').toBe(false);
    const fromSibling = await injectAndRecord(q, sibling, 'daemon', 'sess-family-0002');
    expect(fromSibling.includes('hardware key held by the release manager'), '이름이 이어진 형제 저장소는 가족이 아니다').toBe(false);
    expect(fromSibling, '양성 대조: 형제 저장소 자신의 사실은 실린다').toContain('kept in the office safe');
  }, 30_000);

  it('같은 세션의 다음 프롬프트는 세 번째 사본(새 id)도 본문 키로 거른다', async () => {
    await addFact(DEPLOY); // 첫 주입 이후 새 id 로 같은 문장이 또 저장됨
    const out = await injectAndRecord(
      'Remind me again how the deploy pipeline handles Vercel previews for pull requests',
      '/tmp/proj', 'daemon', 'sess-dedup-0001',
    );
    expect(out.includes('deploy pipeline publishes a Vercel preview'), `블록:\n${out}`).toBe(false);
    const last = readLog().at(-1)!;
    expect(Number(last.text_deduped)).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('앞쪽 system-reminder 를 걷어낸 사람 본문으로 검색한다', async () => {
    // 알림이 모델 입력 한도(512 토큰)를 넘게 길면, 걷어내지 않고 통째로 임베딩할 때 뒤의 질문이 잘려 나간다
    const noise = 'The user has the file notes/cooking.md open in the IDE. Recipe: whisk eggs, fold flour, bake. '.repeat(40);
    const question = 'What is our policy for database migrations with Flyway versioned SQL?';
    const out = await injectAndRecord(
      `<system-reminder>${noise}</system-reminder>\n${question}`, '/tmp/proj', 'daemon', 'sess-reminder-0001',
    );
    expect(out, `블록:\n${out}`).toContain('Flyway');
    expect(readLog().at(-1)).toMatchObject({ status: 'injected', query_len: question.length });
  }, 30_000);

  it('computeInjectResult 는 원장을 건드리지 않고 키만 돌려준다 — 기록은 블록을 전달한 쪽이 한다', async () => {
    const { loadLedger } = await import('../src/inject-ledger.js');
    const q = 'How does our deploy pipeline publish Vercel previews for pull requests?';
    const r = await core.computeInjectResult(q, '/tmp/proj', 'daemon', 'sess-result-0001');
    expect(r.context).toContain('deploy pipeline publishes a Vercel preview');
    expect(r.ledgerKeys.length).toBeGreaterThan(0);
    expect(loadLedger('sess-result-0001').size, '계산은 기록하지 않는다 — 출력한 쪽이 쓰기 성공 뒤에 기록한다').toBe(0);
  }, 30_000);

  it('일치 없음·이미 실음은 실패가 아니다 — failed 는 예외에만 붙는다', async () => {
    // failed 가 잘못 붙으면 데몬이 일치 없는 프롬프트마다 ok:false 를 보내, 클라이언트가 매번 모델을 새로 올린다
    const { loadLedger, appendLedger } = await import('../src/inject-ledger.js');
    const none = await core.computeInjectResult(
      'Which kimchi stew recipe uses pork belly and aged kimchi for the deepest flavor?', '/tmp/proj', 'daemon', 'sess-notfail-0001',
    );
    expect(readLog().at(-1)!.status).toBe('no-match');
    expect(none).toEqual({ context: '', ledgerKeys: [] });

    const q = 'How does our deploy pipeline publish Vercel previews for pull requests?';
    const first = await core.computeInjectResult(q, '/tmp/proj', 'daemon', 'sess-notfail-0002');
    appendLedger('sess-notfail-0002', loadLedger('sess-notfail-0002'), first.ledgerKeys);
    const again = await core.computeInjectResult(q, '/tmp/proj', 'daemon', 'sess-notfail-0002');
    expect(readLog().at(-1)!.status).toBe('deduped');
    expect(again).toEqual({ context: '', ledgerKeys: [] });
  }, 30_000);

  it('MEMORY_BANK_REPEAT_DETECT=1 일 때만 반복 감지가 돈다', async () => {
    process.env.MEMORY_BANK_REPEAT_DETECT = '1';
    await injectAndRecord(
      'What is our policy for database migrations with Flyway versioned SQL?',
      '/tmp/proj', 'daemon', 'sess-repeat-0001',
    );
    const last = readLog().at(-1)!;
    expect(last.status).toBe('injected');
    expect(typeof last.repeat_ms).toBe('number');
  }, 30_000);

  /**
   * 사람이 치지 않은 세션의 주입을 끄는 스위치 (2026-11-10, 감사 INJ-04).
   * 10-08 이후 주입 글자 190만 자 가운데 대화형 Claude Code 는 5% 였다(Codex 72.9% · 헤드리스 21.4%).
   * 같은 틀 프롬프트에 같은 블록이 세션을 바꿔 가며 실린다 — 세션 원장은 세션 안에서만 막는다.
   * 기본 동작은 그대로다(둘 다 주입). 끄는 것은 사용자가 정한다.
   */
  describe('호스트별 주입 스위치', () => {
    const Q = 'How does our deploy pipeline publish Vercel previews for pull requests?';

    it('hostSkipReason: 기본은 아무도 건너뛰지 않는다 — 스위치가 0 일 때만, 해당 호스트만', () => {
      const { hostSkipReason } = core;
      const hosts = [
        { client: 'claude-code', entrypoint: 'cli' }, { client: 'claude-code', entrypoint: 'sdk-cli' }, { client: 'claude-code', entrypoint: 'sdk-ts' },
        { client: 'codex' }, { client: 'codex', entrypoint: 'cli' }, { client: 'manual' }, {},
      ];
      for (const h of hosts) expect(hostSkipReason(h, {}), JSON.stringify(h)).toBeNull();
      for (const h of hosts) expect(hostSkipReason(h, { MEMORY_BANK_INJECT_HEADLESS: '1', MEMORY_BANK_INJECT_CODEX: '' }), JSON.stringify(h)).toBeNull();

      const headlessOff = { MEMORY_BANK_INJECT_HEADLESS: '0' };
      expect(hostSkipReason({ client: 'claude-code', entrypoint: 'sdk-cli' }, headlessOff)).toBe('headless');
      expect(hostSkipReason({ client: 'claude-code', entrypoint: 'sdk-ts' }, headlessOff)).toBe('headless');
      expect(hostSkipReason({ client: 'codex', entrypoint: 'sdk-cli' }, headlessOff), '헤드리스 세션이 띄운 Codex').toBe('headless');
      expect(hostSkipReason({ client: 'claude-code', entrypoint: 'cli' }, headlessOff), '대화형 세션은 그대로').toBeNull();
      expect(hostSkipReason({ client: 'codex' }, headlessOff), 'Codex 는 헤드리스 표지가 없다 — 이 스위치로는 끄지 않는다').toBeNull();
      expect(hostSkipReason({}, headlessOff)).toBeNull();

      const codexOff = { MEMORY_BANK_INJECT_CODEX: '0' };
      expect(hostSkipReason({ client: 'codex' }, codexOff)).toBe('codex-off');
      expect(hostSkipReason({ client: 'codex', entrypoint: 'cli' }, codexOff)).toBe('codex-off');
      expect(hostSkipReason({ client: 'claude-code', entrypoint: 'sdk-cli' }, codexOff)).toBeNull();
      expect(hostSkipReason({ client: 'claude-code', entrypoint: 'cli' }, codexOff)).toBeNull();
    });

    it('기본: 헤드리스(sdk-cli)·Codex 프롬프트에도 지금처럼 주입한다', async () => {
      expect(await injectAndRecord(Q, '/tmp/proj', 'daemon', 'sess-host-default-1', { client: 'claude-code', entrypoint: 'sdk-cli' })).toContain('deploy pipeline publishes');
      expect(await injectAndRecord(Q, '/tmp/proj', 'daemon', 'sess-host-default-2', { client: 'codex' })).toContain('deploy pipeline publishes');
    }, 30_000);

    it('MEMORY_BANK_INJECT_HEADLESS=0: sdk-* 세션은 검색 없이 skipped/headless, 대화형 세션은 그대로 주입', async () => {
      process.env.MEMORY_BANK_INJECT_HEADLESS = '0';
      const r = await core.computeInjectResult(Q, '/tmp/proj', 'daemon', 'sess-host-headless-1', { client: 'claude-code', entrypoint: 'sdk-cli', req_id: 'req-host-1' });
      expect(r).toEqual({ context: '', ledgerKeys: [] });
      const last = readLog().at(-1)!;
      expect(last).toMatchObject({ status: 'skipped', reason: 'headless', via: 'daemon', client: 'claude-code', entrypoint: 'sdk-cli', req_id: 'req-host-1', has_session: true });
      expect(last.embed_ms, '건너뛴 프롬프트에 임베딩을 계산하지 않는다').toBeUndefined();
      expect(await injectAndRecord(Q, '/tmp/proj', 'daemon', 'sess-host-headless-2', { client: 'claude-code', entrypoint: 'cli' })).toContain('deploy pipeline publishes');
    }, 30_000);

    it('MEMORY_BANK_INJECT_CODEX=0: Codex 프롬프트는 skipped/codex-off, Claude Code 는 그대로 주입', async () => {
      process.env.MEMORY_BANK_INJECT_CODEX = '0';
      const r = await core.computeInjectResult(Q, '/tmp/proj', 'fallback', 'sess-host-codex-1', { client: 'codex' });
      expect(r).toEqual({ context: '', ledgerKeys: [] });
      expect(readLog().at(-1)!).toMatchObject({ status: 'skipped', reason: 'codex-off', via: 'fallback', client: 'codex' });
      expect(await injectAndRecord(Q, '/tmp/proj', 'daemon', 'sess-host-codex-2', { client: 'claude-code', entrypoint: 'sdk-cli' })).toContain('deploy pipeline publishes');
    }, 30_000);
  });
});
