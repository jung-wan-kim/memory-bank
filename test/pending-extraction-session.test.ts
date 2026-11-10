import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pendingExtractionCoreQuery, EXTRACTION_STATE, MAX_INTERNAL_RETRIES, CLAIM_LEASE_MINUTES } from '../src/pending-extraction.js';

/**
 * "backfill 이 이 세션을 집는가"를 한 세션에 대해 묻는 꼴 (2026-11-11, 2차 검수 R2-CE-03).
 *
 * 추출 워커는 선색인이 실패했거나 공급자가 일시 실패했을 때 이 질문을 한다. 예전에는 pending
 * 질의 전체를 서브쿼리로 두고 바깥에서 세션을 걸렀다 — 세션 조건이 안으로 내려가지 않아 모든
 * 세션을 집계했다(실DB 복제본: 세션 73,498개·교환 341,840행에서 한 번에 14~22초, 그동안 워커는
 * 세션 잠금을 쥔다). 세션을 받는 꼴은 그 세션의 교환만 읽는다(같은 복제본에서 0.1~2ms).
 *
 * 술어는 하나여야 한다: 세션을 준 답이 전체 목록에 그 세션이 있는지와 언제나 같다.
 */

let tmp: string;
let db: Database.Database;

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const EXCLUDED = '/work/excluded-project';
const CFG = { minExchanges: 2, excludeProjects: [EXCLUDED], quietMinutes: 0 };

function seed(sid: string, n: number, opts: { cwd?: string; sidechain?: number; minutesAgo?: number } = {}): void {
  const ins = db.prepare('INSERT INTO exchanges (session_id, timestamp, is_sidechain, cwd) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < n; i++) ins.run(sid, minutesAgo((opts.minutesAgo ?? 600) - i), opts.sidechain ?? 0, opts.cwd ?? '/work/app');
}
const marker = (sid: string, extracted: number, saved = 0, processedAt = minutesAgo(5)) =>
  db.prepare('INSERT INTO extraction_log (session_id, processed_at, extracted, saved) VALUES (?, ?, ?, ?)').run(sid, processedAt, extracted, saved);

/** The whole pending list — what backfill picks from. */
function pendingList(cfg: Parameters<typeof pendingExtractionCoreQuery>[0] = CFG): Set<string> {
  const { sql, params } = pendingExtractionCoreQuery(cfg);
  return new Set((db.prepare(sql).all(...params) as Array<{ sid: string }>).map((r) => r.sid));
}
/** The one-session question, as scripts/fact-extract-worker.js asks it. */
function picks(sid: string, cfg: Parameters<typeof pendingExtractionCoreQuery>[0] = CFG): boolean {
  const { sql, params } = pendingExtractionCoreQuery(cfg, { sessionId: sid });
  return Boolean(db.prepare(`SELECT 1 FROM (${sql}) WHERE sid = ? LIMIT 1`).get(...params, sid));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-pending-session-'));
  db = new Database(path.join(tmp, 't.sqlite'));
  // The columns the predicate reads, and the two indexes of the product schema that matter to its plan.
  db.exec(`
    CREATE TABLE exchanges (id INTEGER PRIMARY KEY, session_id TEXT, timestamp TEXT, is_sidechain INTEGER DEFAULT 0, cwd TEXT);
    CREATE INDEX idx_session_id ON exchanges(session_id);
    CREATE INDEX idx_sidechain ON exchanges(is_sidechain);
    CREATE TABLE extraction_log (session_id TEXT PRIMARY KEY, processed_at TEXT, extracted INTEGER, saved INTEGER, claim_owner TEXT);
  `);
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('pending 술어를 한 세션에 대해 묻기', () => {
  it('세션마다 답이 전체 목록과 같다 — 대상·마커·교환 수·제외 프로젝트·서브에이전트·재시도·claim', () => {
    seed('plain', 3);
    seed('one-exchange', 1);
    seed('done', 3); marker('done', 4, 4);
    seed('zero-marker', 3); marker('zero-marker', 0, 0);
    seed('seeded', 3); marker('seeded', EXTRACTION_STATE.SEED);
    seed('retry-left', 3); marker('retry-left', EXTRACTION_STATE.RETRIABLE_INTERNAL, MAX_INTERNAL_RETRIES - 1);
    seed('retry-spent', 3); marker('retry-spent', EXTRACTION_STATE.RETRIABLE_INTERNAL, MAX_INTERNAL_RETRIES);
    seed('claimed-fresh', 3); marker('claimed-fresh', EXTRACTION_STATE.CLAIMED, 0, minutesAgo(1));
    seed('claimed-stale', 3); marker('claimed-stale', EXTRACTION_STATE.CLAIMED, 0, minutesAgo(CLAIM_LEASE_MINUTES + 5));
    seed('excluded', 3, { cwd: EXCLUDED });
    seed('partly-excluded', 2); seed('partly-excluded', 1, { cwd: EXCLUDED }); // one exchange in an excluded project excludes the session
    seed('llm-worker', 3, { cwd: '/anything/memory-bank-llm' });
    seed('sidechain-only', 3, { sidechain: 1 });
    seed('mostly-sidechain', 1); seed('mostly-sidechain', 4, { sidechain: 1 }); // one main-chain exchange: below the minimum
    const sessions = (db.prepare('SELECT DISTINCT session_id AS s FROM exchanges').all() as Array<{ s: string }>).map((r) => r.s);
    expect(sessions).toHaveLength(14);

    const list = pendingList();
    expect([...list].sort()).toEqual(['claimed-stale', 'plain', 'retry-left']);
    for (const sid of [...sessions, 'no-such-session']) expect(picks(sid), sid).toBe(list.has(sid));
  });

  it('조용함 조건도 같은 술어다: 방금 교환이 있었던 세션은 세션을 줘도 대상이 아니다', () => {
    seed('active', 3, { minutesAgo: 3 });
    seed('quiet', 3, { minutesAgo: 600 });
    const cfg = { ...CFG, quietMinutes: 60 };
    expect([...pendingList(cfg)]).toEqual(['quiet']);
    expect(picks('active', cfg)).toBe(false);
    expect(picks('quiet', cfg)).toBe(true);
    expect(picks('active', CFG), '조용함 조건을 끄면 대상').toBe(true);
  });

  it('제외 프로젝트가 없는 설정에서도 같다', () => {
    seed('plain', 3);
    seed('llm-worker', 3, { cwd: '/anything/memory-bank-llm' });
    const cfg = { minExchanges: 2, excludeProjects: [], quietMinutes: 0 };
    expect([...pendingList(cfg)]).toEqual(['plain']);
    expect(picks('plain', cfg)).toBe(true);
    expect(picks('llm-worker', cfg)).toBe(false);
  });

  it('세션을 주면 그 세션의 교환만 읽는다: 두 값짜리 is_sidechain 색인이 아니라 session_id 색인으로 계획된다', () => {
    seed('plain', 3);
    const plan = (sql: string, args: unknown[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail).join(' | ');

    const whole = pendingExtractionCoreQuery(CFG);
    // what the worker ran before: the whole list, filtered outside — every main-chain exchange is read
    expect(plan(`SELECT 1 FROM (${whole.sql}) WHERE sid = ? LIMIT 1`, [...whole.params, 'plain']))
      .toMatch(/SEARCH e USING INDEX idx_sidechain \(is_sidechain=\?\)/);

    const one = pendingExtractionCoreQuery(CFG, { sessionId: 'plain' });
    const p = plan(`SELECT 1 FROM (${one.sql}) WHERE sid = ? LIMIT 1`, [...one.params, 'plain']);
    expect(p).toMatch(/SEARCH e USING INDEX idx_session_id \(session_id=\?\)/);
    expect(p).toMatch(/SEARCH x USING INDEX idx_session_id \(session_id=\?\)/); // the excluded-project lookup too
    expect(p).not.toMatch(/idx_sidechain/);
  });

  it('세션을 주지 않으면 문장과 인자가 예전 그대로다 (backfill·세션 시작 탐침이 쓰는 꼴)', () => {
    const before = pendingExtractionCoreQuery(CFG);
    expect(pendingExtractionCoreQuery(CFG, {})).toEqual(before);
    expect(before.params).toEqual([EXCLUDED]);
    expect(before.sql).toContain('WHERE e.is_sidechain = 0 AND e.session_id IS NOT NULL');
    expect(before.sql).not.toContain('e.session_id = ?');
    expect(before.sql).not.toContain('x.session_id = ?');
  });
});
