import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';

/**
 * Which fact of a pair is "existing" and which is "new" follows the time its
 * CONTENT was stated, not the time its row was created.
 *
 * A merge keeps the older row: after EVOLUTION that row holds the later fact's
 * sentence, after DUPLICATE it holds a statement the later fact confirmed. Its
 * created_at stays the old one, so a fact created between the two read as the
 * newer of the pair — the LLM was shown "existing = the latest content, new =
 * older content", and CONTRADICTION then switched off the latest decision
 * (measured: 5 of 100 comparisons on real pairs, all verdicts EVOLUTION).
 * The surviving fact now records the later of the two content times
 * (facts.content_at) and the pair is ordered by it.
 */

const mocks = vi.hoisted(() => {
  const textVector = (text: string): number[] => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    let a = h >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const v = Array.from({ length: 384 }, () => next() - 0.5);
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => x / n);
  };
  return { textVector };
});

vi.mock('../src/llm.js', () => ({
  callHaiku: vi.fn().mockResolvedValue('{}'),
  parseJsonResponse: vi.fn(),
}));
// A rewritten sentence keeps the shared vector here: the three facts of a scenario must stay neighbours.
vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => mocks.textVector('shared starting vector')),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
}));

import { callHaiku, parseJsonResponse } from '../src/llm.js';
import { initDatabase } from '../src/db.js';
import { insertFact, ensureFactContentAtColumn, factContentTimes } from '../src/fact-db.js';
import { consolidateAllPending, applyConsolidationResult, buildConsolidationPrompt } from '../src/consolidator.js';
import type { Fact } from '../src/types.js';

const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

const BASE = mocks.textVector('shared starting vector');
const T0 = Date.parse('2026-03-01T00:00:00.000Z');
const day = (n: number) => new Date(T0 + n * 86_400_000).toISOString();

describe('the pair is ordered by when its content was stated', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-content-order-'));
    process.env.TEST_DB_PATH = path.join(dir, 'test.db');
    db = initDatabase();
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(fact: string, at: string, opts: { count?: number; sources?: string[] } = {}): string {
    const id = insertFact(db, {
      fact, category: 'decision', scope_type: 'project', scope_project: '/proj',
      source_exchange_ids: opts.sources ?? [], embedding: BASE,
    });
    db.prepare('UPDATE facts SET created_at = ?, updated_at = ?, consolidated_count = ? WHERE id = ?').run(at, at, opts.count ?? 1, id);
    return id;
  }
  const verdict = (v: { relation: string; merged_fact: string; reason: string }) => (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue(v);
  const row = (id: string) => db.prepare('SELECT fact, is_active, consolidated_count, source_exchange_ids, created_at FROM facts WHERE id = ?')
    .get(id) as { fact: string; is_active: number; consolidated_count: number; source_exchange_ids: string; created_at: string };
  const contentAt = (id: string) => factContentTimes(db, [id]).get(id);
  const prompts = () => (callHaiku as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[1]));
  const factOf = (id: string): Fact => {
    const r = db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as Record<string, unknown>;
    return {
      ...(r as unknown as Fact),
      source_exchange_ids: JSON.parse(r.source_exchange_ids as string),
      embedding: r.embedding ? new Float32Array(new Uint8Array(r.embedding as Buffer).buffer) : null,
      is_active: Boolean(r.is_active),
    };
  };

  it('after EVOLUTION the older row holds the later sentence: a fact created between the two is the EXISTING one of the next pair', async () => {
    const a = seed('Sessions are stored in memory', day(1));
    const b = seed('Sessions are stored in Postgres', day(3));
    verdict({ relation: 'EVOLUTION', merged_fact: '', reason: 'moved' });
    await consolidateAllPending(db, null);
    expect(row(a).fact).toBe('Sessions are stored in Postgres');
    expect(row(b).is_active).toBe(0);
    expect(row(a).created_at, 'the row keeps its own creation time').toBe(day(1));
    expect(contentAt(a), 'its content is as recent as the fact merged into it').toBe(day(3));

    // Created between the two; compared now (it is the driver, the surviving row its neighbour).
    const c = seed('Sessions are stored in Redis', day(2));
    vi.clearAllMocks();
    verdict({ relation: 'CONTRADICTION', merged_fact: '', reason: 'replaced' });
    await consolidateAllPending(db, { createdAt: day(1), id: a });

    expect(prompts()).toEqual([buildConsolidationPrompt('Sessions are stored in Redis', 'Sessions are stored in Postgres')]);
    expect(row(c).is_active, 'the day-2 statement is the one replaced').toBe(0);
    expect(row(a).is_active, 'the day-3 content — the latest decision — stays').toBe(1);
    expect(row(a).fact).toBe('Sessions are stored in Postgres');
  });

  it('after DUPLICATE the older row was confirmed by the later fact: it is the NEW one against a fact created between', async () => {
    const a = seed('Deploys run from the main branch', day(1));
    const b = seed('The main branch is what gets deployed', day(3));
    verdict({ relation: 'DUPLICATE', merged_fact: '', reason: 'same' });
    await consolidateAllPending(db, null);
    expect(row(b).is_active).toBe(0);
    expect(contentAt(a)).toBe(day(3));

    const c = seed('Deploys run from release branches', day(2));
    vi.clearAllMocks();
    verdict({ relation: 'CONTRADICTION', merged_fact: '', reason: 'replaced' });
    await consolidateAllPending(db, { createdAt: day(1), id: a });

    expect(prompts()).toEqual([buildConsolidationPrompt('Deploys run from release branches', 'Deploys run from the main branch')]);
    expect(row(c).is_active).toBe(0);
    expect(row(a).is_active).toBe(1);
  });

  it('EVOLUTION across the two orders: the fact with the older content keeps its row and takes the newer sentence, counts and sources', async () => {
    const a = seed('Cache TTL is 5 minutes', day(1), { count: 2, sources: ['ex-a'] });
    seed('Cache TTL is 30 minutes', day(5), { count: 1, sources: ['ex-b'] });
    verdict({ relation: 'EVOLUTION', merged_fact: '', reason: 'tuned' });
    await consolidateAllPending(db, null);
    expect(row(a).fact).toBe('Cache TTL is 30 minutes');
    expect(row(a).consolidated_count).toBe(3);

    const c = seed('Cache TTL is 15 minutes', day(3), { count: 4, sources: ['ex-c'] });
    vi.clearAllMocks();
    verdict({ relation: 'EVOLUTION', merged_fact: '', reason: 'tuned again' });
    await consolidateAllPending(db, { createdAt: day(1), id: a });

    // By content: c (day 3) is existing, a (day 5) is new — c's row stays and takes a's sentence.
    expect(prompts()).toEqual([buildConsolidationPrompt('Cache TTL is 15 minutes', 'Cache TTL is 30 minutes')]);
    expect(row(c).is_active).toBe(1);
    expect(row(c).fact).toBe('Cache TTL is 30 minutes');
    expect(row(a).is_active).toBe(0);
    expect(row(c).consolidated_count).toBe(7);
    expect(JSON.parse(row(c).source_exchange_ids)).toEqual(['ex-c', 'ex-a', 'ex-b']);
    expect(contentAt(c)).toBe(day(5));
  });

  it('the content time only moves forward, and is the latest over a chain of merges', () => {
    const a = seed('Node 18 is the runtime', day(1));
    const b = seed('Node 20 is the runtime', day(4));
    const c = seed('Node 22 is the runtime', day(9));
    const d = seed('Node 16 was the runtime', day(2));

    applyConsolidationResult(db, factOf(a), factOf(c), { relation: 'EVOLUTION', merged_fact: '', reason: 'r' }, { embedding: BASE });
    expect(contentAt(a)).toBe(day(9));
    applyConsolidationResult(db, factOf(a), factOf(b), { relation: 'DUPLICATE', merged_fact: '', reason: 'r' });
    expect(contentAt(a), 'an older fact merged in later does not pull it back').toBe(day(9));
    applyConsolidationResult(db, factOf(d), factOf(a), { relation: 'CONTRADICTION', merged_fact: '', reason: 'r' });
    expect(row(a).is_active).toBe(1);
    expect(contentAt(a), 'the surviving later fact keeps its own time').toBe(day(9));
  });

  it('a pair that was never merged is ordered by creation time, as before; INDEPENDENT records nothing', async () => {
    const older = seed('Logs are written as JSON lines', day(1));
    const later = seed('Logs are JSON lines on stderr', day(2));
    verdict({ relation: 'INDEPENDENT', merged_fact: '', reason: 'separate' });
    await consolidateAllPending(db, null);
    expect(prompts()[0]).toBe(buildConsolidationPrompt('Logs are written as JSON lines', 'Logs are JSON lines on stderr'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM facts WHERE content_at IS NOT NULL').get()).toEqual({ n: 0 });
    expect(contentAt(older)).toBe(day(1));
    expect(contentAt(later)).toBe(day(2));
  });

  it('a merge that fails and rolls back on a store without the column leaves the column in place (it is added before the transaction)', () => {
    const older = seed('Feature flags live in the config file', day(1));
    const later = seed('Feature flags moved to the database', day(2));
    const columns = () => (db.prepare(`SELECT name FROM pragma_table_info('facts')`).all() as Array<{ name: string }>).map((c) => c.name);
    if (columns().includes('content_at')) db.prepare('ALTER TABLE facts DROP COLUMN content_at').run();
    db.close();
    db = new Database(process.env.TEST_DB_PATH!); // a handle that has not looked for the column yet
    const sqliteVec = require('sqlite-vec') as { load: (d: Database.Database) => void };
    sqliteVec.load(db);
    db.exec(`CREATE TRIGGER fail_last BEFORE UPDATE OF is_active ON facts WHEN NEW.is_active = 0 BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);

    expect(() => applyConsolidationResult(db, factOf(older), factOf(later), { relation: 'DUPLICATE', merged_fact: '', reason: 'same' }))
      .toThrow(/injected failure/);

    expect(columns(), 'the rollback must not take the column with it').toContain('content_at');
    expect(contentAt(older), 'and reading content times still works on this handle').toBe(day(1));
    expect(db.prepare('SELECT COUNT(*) AS n FROM facts WHERE content_at IS NOT NULL').get(), 'nothing of the failed merge stayed').toEqual({ n: 0 });
  });

  // 2차 검수 R2-CE-04: the first use of the column is an ALTER, and another process holding the write lock past
  // this handle's wait made it fail. The handle then remembered "no column" for its lifetime: every merge of
  // that run was ordered by creation time and recorded no content time, with nothing in the log.
  describe('another process holds the write lock when the column is first needed', () => {
    const columns = () => (db.prepare(`SELECT name FROM pragma_table_info('facts')`).all() as Array<{ name: string }>).map((c) => c.name);
    /** This test's handle: no column yet, has not looked for it, waits 20ms for a lock. */
    function reopenWithoutColumn(): void {
      if (columns().includes('content_at')) db.prepare('ALTER TABLE facts DROP COLUMN content_at').run();
      db.close();
      db = new Database(process.env.TEST_DB_PATH!);
      (require('sqlite-vec') as { load: (d: Database.Database) => void }).load(db);
      db.pragma('busy_timeout = 20');
    }

    it('the failed attempt is not remembered: the same handle adds the column once the lock is gone', () => {
      const a = seed('Imports are sorted alphabetically', day(1));
      reopenWithoutColumn();
      const other = new Database(process.env.TEST_DB_PATH!);
      try {
        other.exec('BEGIN IMMEDIATE');
        expect(ensureFactContentAtColumn(db), 'while the lock is held').toBe(false);
        expect(factContentTimes(db, [a]).get(a), 'content times read as creation times meanwhile').toBe(day(1));
        other.exec('COMMIT');
      } finally {
        other.close();
      }
      expect(ensureFactContentAtColumn(db), 'the same handle, the lock gone').toBe(true);
      expect(columns()).toContain('content_at');
    });

    it('a run counts the pairs it ordered without the column, and a merge made after the lock is gone still records its content time', async () => {
      const a = seed('Sessions are stored in memory', day(1));
      const b = seed('Sessions are stored in Postgres', day(3));
      reopenWithoutColumn();
      const other = new Database(process.env.TEST_DB_PATH!);
      other.exec('BEGIN IMMEDIATE');
      // The other writer finishes while the comparison call is in flight.
      (callHaiku as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { other.exec('COMMIT'); other.close(); return '{}'; });
      verdict({ relation: 'EVOLUTION', merged_fact: '', reason: 'moved' });

      const result = await consolidateAllPending(db, null);

      expect(result.withoutContentTime, 'the pair was ordered by creation time').toBe(1);
      expect(result.evolutions).toBe(1);
      expect(row(a).fact).toBe('Sessions are stored in Postgres');
      expect(row(b).is_active).toBe(0);
      expect(columns()).toContain('content_at');
      expect(contentAt(a), 'the merge recorded the later content time').toBe(day(3));
    });

    it('a run on a store that has the column counts nothing', async () => {
      seed('Logs go to stderr', day(1));
      seed('Logs go to stderr as JSON', day(2));
      verdict({ relation: 'INDEPENDENT', merged_fact: '', reason: 'separate' });
      expect((await consolidateAllPending(db, null)).withoutContentTime).toBe(0);
    });

    it('a merge that adds the column inside its own transaction and then rolls back leaves the handle usable', () => {
      const older = seed('Feature flags live in the config file', day(1));
      const later = seed('Feature flags moved to the database', day(2));
      reopenWithoutColumn();
      db.exec(`CREATE TRIGGER fail_last BEFORE UPDATE OF is_active ON facts WHEN NEW.is_active = 0 BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
      // What a merge does when its own attempt before the transaction met the lock: the column is first looked for inside.
      expect(() => db.transaction(() => {
        expect(factContentTimes(db, [older]).get(older)).toBe(day(1)); // adds the column inside this transaction
        expect(ensureFactContentAtColumn(db)).toBe(true);
        db.prepare('UPDATE facts SET is_active = 0 WHERE id = ?').run(later); // fails: the transaction rolls back, the column with it
      }).immediate()).toThrow(/injected failure/);

      expect(columns(), 'the rollback took the column').not.toContain('content_at');
      // The handle did not keep "the column is there" from inside that transaction: it looks again and adds it.
      expect(contentAt(older)).toBe(day(1));
      expect(columns()).toContain('content_at');
    });
  });

  it('the column is added on first use to a store that lacks it; a handle that cannot add it reads creation times', () => {
    const a = seed('Imports are sorted', day(1));
    const columns = () => (db.prepare(`SELECT name FROM pragma_table_info('facts')`).all() as Array<{ name: string }>).map((c) => c.name);
    if (columns().includes('content_at')) db.prepare('ALTER TABLE facts DROP COLUMN content_at').run();
    const readOnly = new Database(process.env.TEST_DB_PATH!, { readonly: true, fileMustExist: true });
    try {
      expect(ensureFactContentAtColumn(readOnly)).toBe(false);
      expect(factContentTimes(readOnly, [a]).get(a)).toBe(day(1));
    } finally {
      readOnly.close();
    }
    // A fresh write handle (the check is remembered per handle).
    const fresh = new Database(process.env.TEST_DB_PATH!);
    try {
      expect(ensureFactContentAtColumn(fresh)).toBe(true);
      expect(ensureFactContentAtColumn(fresh), 'idempotent').toBe(true);
      expect((fresh.prepare(`SELECT name FROM pragma_table_info('facts')`).all() as Array<{ name: string }>).map((c) => c.name)).toContain('content_at');
    } finally {
      fresh.close();
    }
  });
});
