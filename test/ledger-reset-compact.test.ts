import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { suppressConsole } from './test-utils.js';

/**
 * 압축(compaction) 뒤 세션 원장 초기화 (2026-11-10, 감사 INJ-02).
 *
 * 원장의 전제는 「이미 주입한 사실은 대화 컨텍스트에 있다」인데, 압축이 그 사실을 요약으로
 * 바꾼 뒤에도 원장은 그대로라 같은 사실이 세션이 끝날 때까지 다시 실리지 않았다(실측:
 * 원장 94개 중 11세션이 압축을 겪었고 그 원장에 315건). 압축해도 세션 id 는 그대로다.
 *  - hooks.json 의 SessionStart `compact` 묶음이 scripts/ledger-reset-hook.js 를 동기로 부른다
 *  - 그 훅은 그 세션의 원장만 지운다(다른 세션·다른 source 는 그대로)
 *  - 지운 뒤에는 같은 사실이 다시 주입 대상이다(실제 모델·임시 DB 로 계산해 확인)
 */

const restoreConsole = suppressConsole();
const REPO = path.resolve(__dirname, '..');
const FACT = 'The deploy pipeline publishes a Vercel preview for every pull request before merge';
const PROMPT = 'How does our deploy pipeline publish Vercel previews for pull requests?';
const prevEnv = { ...process.env };
let tmp: string;
let core: typeof import('../src/inject-core.js');
let ledgerMod: typeof import('../src/inject-ledger.js');
let factId: string;

const ledgerFile = (sid: string) => path.join(tmp, 'conversation-index', 'state', 'inject-ledger', `${sid}.json`);
const readLog = (): Array<Record<string, unknown>> => {
  const f = path.join(tmp, 'conversation-index', 'logs', 'inject-context.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const keyOf = (sid: string) => createHash('sha256').update(sid).digest('hex').slice(0, 12);

/** SessionStart 훅을 Claude Code 가 부르는 모양 그대로(stdin JSON) 실행한다. */
function runResetHook(input: Record<string, unknown>): string {
  return execFileSync(process.execPath, ['scripts/ledger-reset-hook.js'], {
    cwd: REPO, encoding: 'utf8', timeout: 30_000,
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: '/tmp/proj', ...input }),
    env: { ...process.env, MEMORY_BANK_CONFIG_DIR: tmp },
  });
}

/** 블록을 출력하는 쪽이 하는 일(계산 → 출력 → 원장 기록)을 그대로 따른다 — inject-core.test.ts 와 같은 헬퍼. */
async function injectAndRecord(sessionId: string): Promise<string> {
  const r = await core.computeInjectResult(PROMPT, '/tmp/proj', 'daemon', sessionId, { client: 'claude-code' });
  if (r.ledgerKeys.length > 0) ledgerMod.appendLedger(sessionId, ledgerMod.loadLedger(sessionId), r.ledgerKeys);
  return r.context;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ledger-reset-'));
  process.env.MEMORY_BANK_CONFIG_DIR = tmp;
  process.env.TEST_DB_PATH = path.join(tmp, 'test.db');
  delete process.env.MEMORY_BANK_REPEAT_DETECT;
  core = await import('../src/inject-core.js');
  ledgerMod = await import('../src/inject-ledger.js');
  const { initDatabase } = await import('../src/db.js');
  const { insertFact } = await import('../src/fact-db.js');
  const { initEmbeddings, generateEmbedding } = await import('../src/embeddings.js');
  await initEmbeddings();
  const db = initDatabase();
  try {
    factId = insertFact(db, {
      fact: FACT, category: 'decision', scope_type: 'global', scope_project: null,
      source_exchange_ids: [], embedding: await generateEmbedding(FACT, 'passage'),
    });
  } finally {
    db.close();
  }
}, 120_000);

afterAll(() => {
  process.env = prevEnv;
  restoreConsole();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('hooks.json — compact 묶음', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'hooks', 'hooks.json'), 'utf8'));
  type Group = { matcher: string; hooks: Array<Record<string, unknown>> };
  const groups = cfg.hooks.SessionStart as Group[];
  const matches = (g: Group, source: string) => new RegExp(`^(?:${g.matcher})$`).test(source);
  const isReset = (h: Record<string, unknown>) => String(h.command).includes('scripts/ledger-reset-hook.js');

  it('source=compact 에 걸리는 묶음이 원장 초기화 훅을 동기로(async 없이, timeout 5초 이하) 부른다', () => {
    const hooks = groups.filter((g) => matches(g, 'compact')).flatMap((g) => g.hooks).filter(isReset);
    expect(hooks, 'compact 에서 도는 원장 초기화 훅').toHaveLength(1);
    // 비동기면 다음 프롬프트의 주입 훅이 초기화보다 먼저 원장을 읽을 수 있다
    expect(hooks[0].async, 'async 금지').toBeUndefined();
    expect(Number(hooks[0].timeout)).toBeGreaterThan(0);
    expect(Number(hooks[0].timeout)).toBeLessThanOrEqual(5);
    expect(fs.existsSync(path.join(REPO, 'scripts', 'ledger-reset-hook.js')), '등록한 스크립트가 실제로 있다').toBe(true);
  });

  it('startup·resume·clear·fork 에서는 원장 초기화 훅이 돌지 않는다 (이어받은 세션의 컨텍스트에는 주입한 사실이 남아 있다)', () => {
    for (const source of ['startup', 'resume', 'clear', 'fork']) {
      const hooks = groups.filter((g) => matches(g, source)).flatMap((g) => g.hooks).filter(isReset);
      expect(hooks, source).toEqual([]);
    }
  });

  it('compact 묶음은 세션 시작 작업(동기화·통합 워커·설치)을 다시 돌리지 않는다', () => {
    const cmds = groups.filter((g) => matches(g, 'compact')).flatMap((g) => g.hooks).map((h) => String(h.command));
    expect(cmds.filter((c) => !c.includes('scripts/ledger-reset-hook.js'))).toEqual([]);
  });
});

describe('resetLedger', () => {
  it('그 세션의 원장만 비우고(지운 키 수를 돌려준다) 다른 세션 원장은 그대로 둔다', () => {
    ledgerMod.appendLedger('sess-reset-A001', new Set(), ['fa1', 't:a1', 'fa2']);
    ledgerMod.appendLedger('sess-reset-B002', new Set(), ['fb1', 't:b1']);
    expect(ledgerMod.resetLedger('sess-reset-A001')).toBe(3);
    expect(ledgerMod.loadLedger('sess-reset-A001').size).toBe(0);
    expect([...ledgerMod.loadLedger('sess-reset-B002')]).toEqual(['fb1', 't:b1']);
    // 비운 원장 위에 다시 쌓인다
    ledgerMod.appendLedger('sess-reset-A001', ledgerMod.loadLedger('sess-reset-A001'), ['fa9']);
    expect([...ledgerMod.loadLedger('sess-reset-A001')]).toEqual(['fa9']);
  });

  it('원장이 없던 세션은 0, 쓸 수 없는 세션 id 는 null (어느 파일도 건드리지 않는다)', () => {
    ledgerMod.appendLedger('sess-reset-C003', new Set(), ['fc1']);
    expect(ledgerMod.resetLedger('sess-never-seen-0001')).toBe(0);
    expect(ledgerMod.resetLedger('')).toBeNull();
    expect(ledgerMod.resetLedger(undefined)).toBeNull();
    expect(ledgerMod.resetLedger('../..')).toBeNull();
    expect([...ledgerMod.loadLedger('sess-reset-C003')]).toEqual(['fc1']);
  });

  it('지우지 못하면 던진다 — 조용히 남으면 그 세션 내내 재주입이 막힌 채로 「초기화됨」이 된다', () => {
    // 원장 파일 자리에 비어 있지 않은 폴더가 있으면 unlink 가 실패한다
    const sid = 'sess-reset-D004';
    fs.mkdirSync(path.join(ledgerFile(sid), 'x'), { recursive: true });
    expect(() => ledgerMod.resetLedger(sid)).toThrow();
    fs.rmSync(ledgerFile(sid), { recursive: true, force: true });
  });
});

describe('SessionStart(compact) 훅 — scripts/ledger-reset-hook.js', () => {
  it('compact 로 시작한 세션에서 같은 사실이 다시 주입 대상이 된다', async () => {
    const sid = 'sess-compact-0001';
    const other = 'sess-compact-other';
    const first = await injectAndRecord(sid);
    expect(first, '첫 프롬프트에는 사실이 실린다').toContain(FACT);
    await injectAndRecord(other);
    const otherBefore = fs.readFileSync(ledgerFile(other), 'utf8');

    // 압축 전: 같은 프롬프트는 원장에 막혀 아무것도 싣지 않는다 (양성 대조)
    expect(await injectAndRecord(sid)).toBe('');
    expect(readLog().at(-1)).toMatchObject({ status: 'deduped', session_key: keyOf(sid) });

    const out = runResetHook({ session_id: sid, source: 'compact' });
    expect(out, '훅은 세션에 아무 문맥도 싣지 않는다').toBe('');
    expect(ledgerMod.loadLedger(sid).size).toBe(0);
    expect(fs.readFileSync(ledgerFile(other), 'utf8'), '다른 세션 원장은 바이트 그대로').toBe(otherBefore);

    // 압축 뒤: 같은 사실이 다시 실리고, 다시 원장에 오른다
    const again = await injectAndRecord(sid);
    expect(again).toContain(FACT);
    expect(readLog().at(-1)).toMatchObject({ status: 'injected', session_key: keyOf(sid), injected_ids: [factId.slice(0, 12)] });
    expect(ledgerMod.loadLedger(sid).has(factId)).toBe(true);
  }, 60_000);

  it('로그: via session-start · source compact · status ledger-reset · 지운 키 수', () => {
    const sid = 'sess-compact-log01';
    ledgerMod.appendLedger(sid, new Set(), ['f1', 't:1', 'f2', 't:2']);
    runResetHook({ session_id: sid, source: 'compact' });
    const mine = readLog().filter((l) => l.session_key === keyOf(sid));
    expect(mine).toEqual([expect.objectContaining({
      via: 'session-start', source: 'compact', status: 'ledger-reset', ledger_cleared: 4, has_session: true, project: '/tmp/proj',
    })]);
    expect(mine[0].plugin_version).toBe(JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version);
  });

  it('source 가 compact 가 아니면 원장을 건드리지 않고 로그도 남기지 않는다', () => {
    for (const source of ['startup', 'resume', 'clear', 'fork', undefined]) {
      const sid = `sess-not-compact-${source ?? 'none'}`;
      ledgerMod.appendLedger(sid, new Set(), ['keep-1', 't:keep']);
      const before = fs.readFileSync(ledgerFile(sid), 'utf8');
      runResetHook(source === undefined ? { session_id: sid } : { session_id: sid, source });
      expect(fs.readFileSync(ledgerFile(sid), 'utf8'), String(source)).toBe(before);
      expect(readLog().filter((l) => l.session_key === keyOf(sid)), String(source)).toEqual([]);
    }
  });

  it('세션 id 가 없으면 어느 원장도 지우지 않고 error 한 줄을 남긴다', () => {
    const sid = 'sess-compact-keep01';
    ledgerMod.appendLedger(sid, new Set(), ['keep-1']);
    const linesBefore = readLog().length;
    runResetHook({ source: 'compact' });
    expect([...ledgerMod.loadLedger(sid)]).toEqual(['keep-1']);
    const added = readLog().slice(linesBefore);
    expect(added).toEqual([expect.objectContaining({ via: 'session-start', source: 'compact', status: 'error', has_session: false })]);
    expect(String(added[0].error)).toContain('session');
  });

  it('원장을 지우지 못하면 error 로 남는다 (ledger-reset 으로 기록하지 않는다)', () => {
    const sid = 'sess-compact-fail01';
    fs.mkdirSync(path.join(ledgerFile(sid), 'x'), { recursive: true });
    runResetHook({ session_id: sid, source: 'compact' });
    const mine = readLog().filter((l) => l.session_key === keyOf(sid));
    expect(mine).toEqual([expect.objectContaining({ via: 'session-start', source: 'compact', status: 'error' })]);
    expect(mine[0].ledger_cleared).toBeUndefined();
    fs.rmSync(ledgerFile(sid), { recursive: true, force: true });
  });

  it('정적 import 사슬이 가볍다 — better-sqlite3·임베딩 모델을 올리지 않는다', () => {
    const seen = new Set<string>();
    const bare = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
        const spec = m[1];
        if (spec.startsWith('../dist/')) walk(path.join(REPO, 'src', spec.slice('../dist/'.length).replace(/\.js$/, '.ts')));
        else if (spec.startsWith('./')) walk(path.join(path.dirname(file), spec.replace(/\.js$/, '.ts')));
        else bare.add(spec);
      }
    };
    walk(path.join(REPO, 'scripts', 'ledger-reset-hook.js'));
    expect(seen.size, '사슬을 실제로 따라갔다').toBeGreaterThan(3);
    expect([...bare].filter((b) => !b.startsWith('node:') && !['fs', 'path', 'os', 'crypto'].includes(b))).toEqual([]);
  });
});
