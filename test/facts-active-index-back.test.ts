import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { insertFact, searchSimilarFactsSameScope } from '../src/fact-db.js';
import {
  createDomain, createCategory, classifyFact, ontologyNameKey,
  activeFactCounts, findCategoriesByNameKey, getFactsByCategory,
} from '../src/ontology-db.js';
import { suppressConsole } from './test-utils.js';

/**
 * 옛 버전 프로세스가 idx_facts_active 를 되살린 DB 에서도 사실 저장·분류·통합 경로의 문장이
 * 그 색인을 타지 않는다 (2026-11-11, 2차 검수 R2-CE-01).
 *
 * 이 버전은 그 색인을 지우지만, 같은 DB 를 쓰는 1.7.x 프로세스가 열 때마다 다시 만들고
 * (CREATE INDEX IF NOT EXISTS) 이 버전은 지운 뒤 6시간 동안 그것을 그대로 둔다
 * (FACTS_ACTIVE_INDEX_REDROP_MS). 통계가 없는 DB 에서 플래너는 `… AND is_active = 1` 을 그 두 값짜리
 * 색인으로 풀어 활성 사실 전부를 읽는다. 실DB 복제본(사실 46,507행·활성 30,584) 측정:
 *  - 분류별 사실 수 1회 29.5ms 대 0.09ms — 저장 사실 1건당 24회, 추출 1회 2.1초 → 9.3초
 *  - 프로젝트 범위 사실 수 1회 30.3ms 대 2.1ms — 통합 드라이버마다 1회
 * 여기서는 제품 함수가 실제로 prepare 한 문장을 잡아 그 DB 에서 EXPLAIN 한다(문장을 옮겨 적지 않는다).
 */

const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

const THROUGH_ACTIVE_INDEX = /idx_facts_active\b(?!_)/;
const EMB = (seed: number) => {
  const v = Array.from({ length: 384 }, (_, i) => Math.sin(seed * 31 + i));
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};

describe('fact statements while an older process has idx_facts_active back', () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;

  const hasActiveIndex = (handle: Database.Database) =>
    handle.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_facts_active'`).get() !== undefined;

  /** EXPLAIN QUERY PLAN of a statement with `?` parameters (bound to NULL: the plan does not depend on values). */
  function plan(sql: string): string {
    for (let n = 0; n <= 16; n++) {
      try {
        return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(n).fill(null)) as Array<{ detail: string }>)
          .map((r) => r.detail).join(' | ');
      } catch (e) {
        if (!/Too (few|many) parameter values/.test((e as Error).message)) throw e;
      }
    }
    throw new Error(`could not bind: ${sql}`);
  }

  /** Every statement text `fn` prepares on the handle. */
  function statementsOf(fn: () => void): string[] {
    const seen: string[] = [];
    const original = db.prepare;
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      seen.push(sql);
      return original.call(db, sql);
    };
    try {
      fn();
    } finally {
      (db as unknown as { prepare: unknown }).prepare = original;
    }
    return seen;
  }

  const factStatements = (seen: string[]) => seen.filter((sql) => /\bFROM facts\b/.test(sql));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-active-index-back-'));
    dbPath = path.join(dir, 'db.sqlite');
    process.env.TEST_DB_PATH = dbPath;
    // A DB an older build made (it has the index); this code drops it and records when.
    const made = initDatabase();
    made.exec('CREATE INDEX idx_facts_active ON facts(is_active)');
    made.close();
    initDatabase().close();
    // An older process opens the DB: its initDatabase runs CREATE INDEX IF NOT EXISTS (v1.7.9 src/db.ts).
    const older = new Database(dbPath);
    older.exec('CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(is_active)');
    older.close();
    // This code again, minutes later: the index is left alone.
    db = initDatabase();
    expect(hasActiveIndex(db)).toBe(true);
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const fact = (text: string, scope: string | null, embedding: number[] | null = null) => insertFact(db, {
    fact: text, category: 'decision', scope_type: scope ? 'project' : 'global', scope_project: scope,
    source_exchange_ids: [], embedding,
  });

  it('the same shapes without the hint do plan through the index here (what the hint is for)', () => {
    expect(plan(`SELECT COUNT(*) AS n FROM facts WHERE ontology_category_id = ? AND is_active = 1`))
      .toMatch(/idx_facts_active \(is_active=\?\)/);
    expect(plan(`SELECT COUNT(*) AS n FROM facts WHERE is_active = 1 AND scope_type = 'project' AND scope_project = ? AND embedding_version = ?`))
      .toMatch(/idx_facts_active \(is_active=\?\)/);
  });

  it('category fact counts and facts-by-category go through the category index, with the same numbers', () => {
    const domain = createDomain(db, 'Backend', 'Server side');
    const logging = createCategory(db, domain.id, 'Logging', 'How services log');
    const caching = createCategory(db, domain.id, 'Caching', 'What is cached where');
    const empty = createCategory(db, domain.id, 'Queues', 'Background queues');
    const inLogging = [
      fact('The billing service writes structured JSON logs through pino.', '/work/app'),
      fact('Log rotation for the billing service is done by logrotate, daily.', '/work/app'),
      fact('Request ids are attached to every log line of the gateway.', null),
    ];
    const retired = fact('The billing service used winston for logging before the rewrite.', '/work/app');
    const inCaching = fact('Session data is cached in Redis with a 30 minute expiry.', '/work/app');
    for (const id of [...inLogging, retired]) classifyFact(db, id, logging.id);
    classifyFact(db, inCaching, caching.id);
    db.prepare('UPDATE facts SET is_active = 0 WHERE id = ?').run(retired);

    let counts = new Map<string, number>();
    let namesakes: ReturnType<typeof findCategoriesByNameKey> = [];
    let listed: ReturnType<typeof getFactsByCategory> = [];
    const seen = statementsOf(() => {
      counts = activeFactCounts(db, [logging.id, caching.id, empty.id]);
      namesakes = findCategoriesByNameKey(db, ontologyNameKey('Logging'));
      listed = getFactsByCategory(db, logging.id);
    });

    // the numbers: active facts only, a category with none is absent
    expect([...counts.entries()].sort()).toEqual([[caching.id, 1], [logging.id, 3]].sort());
    expect(namesakes.map((c) => [c.id, c.active_facts])).toEqual([[logging.id, 3]]);
    expect(listed.map((f) => f.id).sort()).toEqual([...inLogging].sort());

    // the plans: none through the two-valued index, each through the category index
    const statements = factStatements(seen);
    expect(statements.length).toBeGreaterThanOrEqual(3);
    for (const sql of statements) {
      expect(plan(sql), sql).not.toMatch(THROUGH_ACTIVE_INDEX);
      expect(plan(sql), sql).toMatch(/idx_facts_ontology \(ontology_category_id=\?\)/);
    }
  });

  it('the scope fact count of the same-scope candidate search goes through the scope index, with the same answers', () => {
    const mine = fact('The importer retries a failed batch three times before giving up.', '/work/app', EMB(1));
    fact('The exporter writes CSV files with a UTF-8 byte order mark.', '/work/other', EMB(2));
    const shared = fact('Timestamps are stored in UTC everywhere.', null, EMB(3));
    const gone = fact('The scheduler ran on cron before it moved to a queue.', '/work/retired', EMB(4));
    db.prepare('UPDATE facts SET is_active = 0 WHERE id = ?').run(gone);

    let inProject: Array<{ fact: { id: string } }> = [];
    let inGlobal: Array<{ fact: { id: string } }> = [];
    let inRetired: Array<{ fact: { id: string } }> = [];
    let inEmpty: Array<{ fact: { id: string } }> = [];
    const seenLive = statementsOf(() => {
      inProject = searchSimilarFactsSameScope(db, EMB(1), { type: 'project', project: '/work/app' }, 5, 0.85);
      inGlobal = searchSimilarFactsSameScope(db, EMB(3), { type: 'global' }, 5, 0.85);
    });
    // a scope whose only fact is inactive, and one with no fact at all: counted as empty, no vector search
    const seenEmpty = statementsOf(() => {
      inRetired = searchSimilarFactsSameScope(db, EMB(4), { type: 'project', project: '/work/retired' }, 5, 0.85);
      inEmpty = searchSimilarFactsSameScope(db, EMB(1), { type: 'project', project: '/work/nothing-here' }, 5, 0.85);
    });

    expect(inProject.map((r) => r.fact.id)).toEqual([mine]);
    expect(inGlobal.map((r) => r.fact.id)).toEqual([shared]);
    expect(inRetired).toEqual([]);
    expect(inEmpty).toEqual([]);
    expect(seenEmpty.some((sql) => /vec_facts/.test(sql))).toBe(false);

    const counts = [...seenLive, ...seenEmpty].filter((sql) => /COUNT\(\*\)/.test(sql) && /\bFROM facts\b/.test(sql));
    expect(counts.length).toBe(4); // one per search
    for (const sql of counts) {
      expect(plan(sql), sql).not.toMatch(THROUGH_ACTIVE_INDEX);
      expect(plan(sql), sql).toMatch(/idx_facts_scope \(scope_type=\?/);
    }
    // nothing else these searches read from facts goes through it either (rows are read by id)
    for (const sql of factStatements([...seenLive, ...seenEmpty])) expect(plan(sql), sql).not.toMatch(THROUGH_ACTIVE_INDEX);
  });
});
