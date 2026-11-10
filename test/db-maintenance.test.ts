import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initDatabase, getVecQuant, embeddingToVecBlob, vecParamSql } from '../src/db.js';
import { analyzeFactTables, reconcileFactVectors, ANALYZE_TABLES } from '../src/db-maintenance.js';
import { EMBEDDING_VERSION } from '../src/embedding-version.js';
import { suppressConsole } from './test-utils.js';

const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-dbmaint-'));
  process.env.TEST_DB_PATH = path.join(dir, 'db.sqlite');
});
afterEach(() => {
  delete process.env.TEST_DB_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

const plan = (db: Database.Database, sql: string) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(' | ');

/** 6,000 facts shaped like a real table: 2/3 active, ~60 projects, ~900 categories. */
function seedFacts(db: Database.Database): void {
  const ins = db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at, is_active, ontology_category_id)
    VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`);
  db.transaction(() => {
    for (let i = 0; i < 6000; i++) {
      const project = i % 2 === 0 ? `/p/${i % 60}` : null;
      const ts = new Date(1.7e12 + i * 1000).toISOString();
      ins.run(`f${i}`, `fact number ${i}`, ['decision', 'preference', 'pattern', 'knowledge', 'constraint'][i % 5],
        project ? 'project' : 'global', project, ts, ts, i % 3 === 0 ? 0 : 1, `c${i % 900}`);
    }
  })();
}

describe('analyzeFactTables', () => {
  it('writes statistics for the fact-side tables only, and reports them', () => {
    const db = initDatabase();
    try {
      seedFacts(db);
      db.prepare(`INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end) VALUES ('e1', 'p', 't', 'q', 'a', '/a.jsonl', 1, 2)`).run();
      const outcome = analyzeFactTables(db);
      expect(outcome.tables).toEqual([...ANALYZE_TABLES]);
      expect(outcome.stat_rows).toBeGreaterThanOrEqual(5); // facts: one row per index
      expect(outcome.ms).toBeGreaterThanOrEqual(0);
      const analyzed = (db.prepare('SELECT DISTINCT tbl FROM sqlite_stat1 ORDER BY tbl').all() as Array<{ tbl: string }>).map((r) => r.tbl);
      expect(analyzed).toContain('facts');
      for (const t of analyzed) expect(ANALYZE_TABLES as readonly string[], t).toContain(t);
      expect(analyzed).not.toContain('exchanges');
      expect(analyzed).not.toContain('tool_calls');
      // the connection's own setting is put back
      expect(db.pragma('analysis_limit', { simple: true })).toBe(0);
    } finally {
      db.close();
    }
  });

  it('with statistics the fact queries leave the 2-valued index alone even where an older process has re-created it', () => {
    const db = initDatabase();
    try {
      seedFacts(db);
      // what a 1.7.x process sharing the DB does on every open
      db.exec('CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(is_active)');
      const byCategory = `SELECT * FROM facts WHERE ontology_category_id = 'c12' AND is_active = 1`;
      const keyFacts = `SELECT * FROM facts WHERE is_active = 1 AND scope_type = 'project' AND scope_project = '/p/4' ORDER BY consolidated_count DESC LIMIT 20`;
      // the defect: no statistics → both run through the index on a 2-valued column
      expect(plan(db, byCategory)).toMatch(/USING INDEX idx_facts_active \(is_active=\?\)/);
      expect(plan(db, keyFacts)).toMatch(/USING INDEX idx_facts_active \(is_active=\?\)/);

      analyzeFactTables(db);
      expect(plan(db, byCategory)).toMatch(/USING INDEX idx_facts_ontology \(ontology_category_id=\?\)/);
      expect(plan(db, keyFacts)).toMatch(/USING INDEX idx_facts_scope \(scope_type=\? AND scope_project=\?\)/);
    } finally {
      db.close();
    }
  });

  it('running it again is harmless (same tables, statistics still there)', () => {
    const db = initDatabase();
    try {
      seedFacts(db);
      const a = analyzeFactTables(db);
      const b = analyzeFactTables(db);
      expect(b.stat_rows).toBe(a.stat_rows);
    } finally {
      db.close();
    }
  });
});

describe('reconcileFactVectors', () => {
  const vector = (seed: number) => Array.from({ length: 384 }, (_, j) => Math.sin(seed + j) * 0.05);
  const floatBlob = (v: number[]) => Buffer.from(new Float32Array(v).buffer);

  function addFact(db: Database.Database, id: string, opts: { active?: boolean; embedding?: Buffer | null; version?: number } = {}): void {
    db.prepare(`INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at, is_active, embedding, embedding_version)
      VALUES (?, ?, 'decision', 'global', '[]', 't', 't', ?, ?, ?)`)
      .run(id, `fact ${id}`, opts.active === false ? 0 : 1, opts.embedding ?? null, opts.version ?? EMBEDDING_VERSION);
  }
  function addVector(db: Database.Database, table: 'vec_facts' | 'vec_facts_kr', id: string, v: number[]): void {
    const q = getVecQuant(db, table);
    db.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ${vecParamSql(q)})`).run(id, embeddingToVecBlob(v, q));
  }
  const ids = (db: Database.Database, table: string) =>
    (db.prepare(`SELECT id FROM ${table}_rowids ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);

  it('removes the vectors of inactive and absent facts from both tables; active facts keep theirs', () => {
    const db = initDatabase();
    try {
      addFact(db, 'active-1', { embedding: floatBlob(vector(1)) });
      addFact(db, 'inactive-1', { active: false, embedding: floatBlob(vector(2)) });
      for (const table of ['vec_facts', 'vec_facts_kr'] as const) {
        addVector(db, table, 'active-1', vector(1));
        addVector(db, table, 'inactive-1', vector(2));
        addVector(db, table, 'no-such-fact', vector(3));
      }
      const before = db.prepare('SELECT embedding FROM vec_facts WHERE id = ?').get('active-1') as { embedding: Buffer };

      expect(reconcileFactVectors(db)).toEqual([
        { table: 'vec_facts', removed: 2, reinserted: 0, missing_no_embedding: 0 },
        { table: 'vec_facts_kr', removed: 2, reinserted: 0, missing_no_embedding: 0 },
      ]);
      expect(ids(db, 'vec_facts')).toEqual(['active-1']);
      expect(ids(db, 'vec_facts_kr')).toEqual(['active-1']);
      const after = db.prepare('SELECT embedding FROM vec_facts WHERE id = ?').get('active-1') as { embedding: Buffer };
      expect(Buffer.from(after.embedding).equals(Buffer.from(before.embedding))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('an active current-version fact with no vector row gets it back from facts.embedding — the same bytes insertFact would have stored', () => {
    const db = initDatabase();
    try {
      const v = vector(7);
      addFact(db, 'lost-vector', { embedding: floatBlob(v) });
      addFact(db, 'has-vector', { embedding: floatBlob(vector(8)) });
      addVector(db, 'vec_facts', 'has-vector', vector(8));

      const [facts] = reconcileFactVectors(db);
      expect(facts).toEqual({ table: 'vec_facts', removed: 0, reinserted: 1, missing_no_embedding: 0 });
      expect(ids(db, 'vec_facts')).toEqual(['has-vector', 'lost-vector']);
      const q = getVecQuant(db, 'vec_facts');
      const stored = db.prepare('SELECT embedding FROM vec_facts WHERE id = ?').get('lost-vector') as { embedding: Buffer };
      // float32 round-trip of the stored embedding, quantized for the table as it is now
      const expected = embeddingToVecBlob(Array.from(new Float32Array(v)), q);
      expect(Buffer.from(stored.embedding).equals(expected)).toBe(true);
      // and the fact is found by a KNN on its own vector
      const hit = db.prepare(`SELECT id FROM vec_facts WHERE embedding MATCH ${vecParamSql(q)} AND k = 1`).get(embeddingToVecBlob(v, q)) as { id: string };
      expect(hit.id).toBe('lost-vector');
    } finally {
      db.close();
    }
  });

  it('does not write a vector it cannot vouch for: no stored embedding, wrong size, stale version, inactive', () => {
    const db = initDatabase();
    try {
      addFact(db, 'no-embedding');
      addFact(db, 'short-embedding', { embedding: Buffer.alloc(100) });
      addFact(db, 'stale-version', { embedding: floatBlob(vector(1)), version: EMBEDDING_VERSION - 1 });
      addFact(db, 'inactive', { active: false, embedding: floatBlob(vector(2)) });

      const [facts] = reconcileFactVectors(db);
      expect(facts).toEqual({ table: 'vec_facts', removed: 0, reinserted: 0, missing_no_embedding: 2 });
      expect(ids(db, 'vec_facts')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('a second run finds nothing left to do', () => {
    const db = initDatabase();
    try {
      addFact(db, 'lost-vector', { embedding: floatBlob(vector(7)) });
      addFact(db, 'inactive-1', { active: false });
      addVector(db, 'vec_facts', 'inactive-1', vector(2));
      addVector(db, 'vec_facts_kr', 'gone', vector(3));
      reconcileFactVectors(db);
      const state = JSON.stringify([ids(db, 'vec_facts'), ids(db, 'vec_facts_kr')]);
      expect(reconcileFactVectors(db)).toEqual([
        { table: 'vec_facts', removed: 0, reinserted: 0, missing_no_embedding: 0 },
        { table: 'vec_facts_kr', removed: 0, reinserted: 0, missing_no_embedding: 0 },
      ]);
      expect(JSON.stringify([ids(db, 'vec_facts'), ids(db, 'vec_facts_kr')])).toBe(state);
    } finally {
      db.close();
    }
  });
});
