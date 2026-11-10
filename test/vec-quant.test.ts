import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  initDatabase,
  getVecQuant,
  embeddingToVecBlob,
  vecParamSql,
  normalizeVecDistance,
  l2DistanceToSimilarity,
  VEC_INT8_SCALE,
  FACT_VEC_INT8_SCALE,
} from '../src/db.js';
import { insertFact, updateFact, searchSimilarFacts, searchSimilarFactsSameScope, searchAllFacts } from '../src/fact-db.js';
import { createDomain, createCategory, upsertCategoryEmbedding, searchSimilarCategories } from '../src/ontology-db.js';
import { suppressConsole } from './test-utils.js';

// 2026-10-16: int8 배율을 표별로 기록한다. 기록이 없으면 127(대화 표, 새 DB 의 사실 표, 이미 int8@127 인
// 다른 사용자의 DB). 600 은 scripts/migrate-vec-facts-int8.mjs 가 이전 버전 프로세스를 확인한 뒤에만 기록한다
// — 1.7.6 은 모든 int8 표를 127 로 읽으므로, 새 DB 에 600 을 기록하면 함께 도는 1.7.6 이 잘못 읽는다.

/** Simulate a migrated DB: record scale 600 for the (still empty) fact-side tables. */
function recordFactScale600(db: Database.Database) {
  for (const t of ['vec_facts', 'vec_facts_kr', 'vec_categories']) {
    db.prepare('INSERT OR REPLACE INTO vec_int8_scale (table_name, scale) VALUES (?, ?)').run(t, FACT_VEC_INT8_SCALE);
  }
}

function storedBlob(db: Database.Database, table: string, id: string): Buffer {
  return Buffer.from((db.prepare(`SELECT embedding FROM ${table} WHERE id = ?`).get(id) as { embedding: Buffer }).embedding);
}

const restoreConsole = suppressConsole();

function unitVector(seed: number): number[] {
  const v = Array.from({ length: 384 }, (_, i) => Math.sin(seed * 31 + i * 7.3) * 0.1);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

function floatL2(a: number[], b: number[]): number {
  return Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0));
}

describe('per-table int8 scale', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-quant-'));
    dbPath = path.join(dir, 'test.db');
    process.env.TEST_DB_PATH = dbPath;
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fresh DB: every int8 table is created at 127 with no scale record (what 1.7.6 creates)', () => {
    const db = initDatabase();
    try {
      for (const t of ['vec_facts', 'vec_facts_kr', 'vec_categories', 'vec_exchanges']) {
        expect(getVecQuant(db, t)).toEqual({ dtype: 'int8', scale: VEC_INT8_SCALE });
      }
      expect((db.prepare('SELECT count(*) AS n FROM vec_int8_scale').get() as { n: number }).n).toBe(0);
      expect(FACT_VEC_INT8_SCALE).toBe(600);
      expect(VEC_INT8_SCALE).toBe(127);
    } finally {
      db.close();
    }
  });

  // sync-import: sync-export-import.test.ts; reembed-worker writes through the same
  // getVecQuant/vecParamSql pair inside tx.immediate() (scripts/reembed-worker.js).
  it('fact-db and ontology-db writers and readers use the recorded scale (600): stored bytes and retrieval', () => {
    const db = initDatabase();
    try {
      recordFactScale600(db);
      const q600 = { dtype: 'int8' as const, scale: 600 };
      const a = unitVector(11);
      const b = unitVector(12);
      const id = insertFact(db, {
        fact: 'Scale-aware writes everywhere', category: 'decision', scope_type: 'project', scope_project: 'proj-x',
        source_exchange_ids: ['ex-1'], embedding: a, fact_kr: '모든 쓰기가 배율을 따른다', embedding_kr: b,
      });
      expect(storedBlob(db, 'vec_facts', id).equals(embeddingToVecBlob(a, q600))).toBe(true);
      expect(storedBlob(db, 'vec_facts_kr', id).equals(embeddingToVecBlob(b, q600))).toBe(true);

      const c = unitVector(13);
      // Same sentence, new vector: a CHANGED sentence also drops the Korean vector
      // (its translation is of the old sentence — consolidate-apply.test.ts), and
      // this test reads that vector back below.
      updateFact(db, id, { fact: 'Scale-aware writes everywhere', embedding: c });
      expect(storedBlob(db, 'vec_facts', id).equals(embeddingToVecBlob(c, q600))).toBe(true);

      const sim = (d: number) => l2DistanceToSimilarity(d);
      expect(sim(searchSimilarFacts(db, c, 'proj-x', 5, 0.5)[0].distance)).toBeGreaterThan(0.999);
      expect(sim(searchSimilarFacts(db, b, 'proj-x', 5, 0.5)[0].distance)).toBeGreaterThan(0.999); // via vec_facts_kr
      expect(sim(searchSimilarFactsSameScope(db, c, { type: 'project', project: 'proj-x' }, 5, 0.5)[0].distance)).toBeGreaterThan(0.999);
      expect(sim(searchAllFacts(db, c, 5, 0.5)[0].distance)).toBeGreaterThan(0.999);

      const dom = createDomain(db, 'Infra', 'infra');
      const cat = createCategory(db, dom.id, 'Vectors', 'vector storage');
      const e = unitVector(14);
      upsertCategoryEmbedding(db, cat.id, e);
      expect(storedBlob(db, 'vec_categories', cat.id).equals(embeddingToVecBlob(e, q600))).toBe(true);
      const hit = searchSimilarCategories(db, e, 3)[0];
      expect(hit.category.id).toBe(cat.id);
      expect(sim(hit.distance)).toBeGreaterThan(0.999);
    } finally {
      db.close();
    }
  });

  it('a broken vector index fails loud in search (only a missing table reads as "no candidates")', () => {
    const db = initDatabase();
    try {
      const emb = unitVector(21);
      insertFact(db, {
        fact: 'Failures must not look like "no relevant facts"', category: 'knowledge', scope_type: 'global',
        scope_project: null, source_exchange_ids: ['ex-1'], embedding: emb,
      });
      db.prepare("INSERT OR REPLACE INTO vec_int8_scale (table_name, scale) VALUES ('vec_facts', 0)").run();
      expect(() => searchSimilarFacts(db, emb, null, 5, 0.5)).toThrow(/vec_int8_scale/);
      expect(() => searchSimilarFactsSameScope(db, emb, { type: 'global' }, 5, 0.5)).toThrow(/vec_int8_scale/);
      db.prepare("DELETE FROM vec_int8_scale").run();
      db.exec('DROP TABLE vec_facts_kr');
      expect(searchSimilarFacts(db, emb, null, 5, 0.5)).toHaveLength(1); // absent KR index = no KR candidates
    } finally {
      db.close();
    }
  });

  it('a KNN that fails once (a swap between the dtype read and the MATCH) is retried; one that keeps failing throws', () => {
    const db = initDatabase();
    try {
      const emb = unitVector(31);
      const id = insertFact(db, {
        fact: 'Retried once across a table swap', category: 'knowledge', scope_type: 'global',
        scope_project: null, source_exchange_ids: ['ex-1'], embedding: emb,
      });
      let failuresLeft = 0;
      const flaky = new Proxy(db, {
        get(target, prop) {
          if (prop === 'prepare') {
            return (sql: string) => {
              if (/MATCH/.test(sql) && /vec_facts\b/.test(sql) && failuresLeft > 0) {
                failuresLeft--;
                throw new Error('Dimension mismatch for inserted vector for the "embedding" column');
              }
              return target.prepare(sql);
            };
          }
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      failuresLeft = 1;
      expect(searchSimilarFacts(flaky, emb, null, 5, 0.5)[0]?.fact.id).toBe(id);
      expect(failuresLeft).toBe(0);
      failuresLeft = 2;
      expect(() => searchSimilarFacts(flaky, emb, null, 5, 0.5)).toThrow(/Dimension mismatch/);
    } finally {
      db.close();
    }
  });

  it('insertFact/updateFact: a failed vector write leaves neither a vector-less row nor a row/vector mismatch', () => {
    const db = initDatabase();
    try {
      const a = unitVector(41);
      const id = insertFact(db, {
        fact: 'Written before the index broke', category: 'knowledge', scope_type: 'global',
        scope_project: null, source_exchange_ids: ['ex-1'], embedding: a,
      });
      db.prepare("INSERT OR REPLACE INTO vec_int8_scale (table_name, scale) VALUES ('vec_facts', 0)").run();
      const before = db.prepare('SELECT count(*) AS n FROM facts').get();
      expect(() => insertFact(db, {
        fact: 'Must not be stored without its vector', category: 'knowledge', scope_type: 'global',
        scope_project: null, source_exchange_ids: ['ex-2'], embedding: unitVector(42),
      })).toThrow(/vec_int8_scale/);
      expect(db.prepare('SELECT count(*) AS n FROM facts').get()).toEqual(before);
      const stored = () => db.prepare('SELECT fact, embedding FROM facts WHERE id = ?').get(id) as { fact: string; embedding: Buffer };
      const was = stored();
      expect(() => updateFact(db, id, { fact: 'Rewritten while the index is broken', embedding: unitVector(43) })).toThrow(/vec_int8_scale/);
      expect(stored()).toEqual(was); // row text and stored embedding unchanged, still matching the index

      // Partial: vec_facts accepts the write, vec_facts_kr then fails — the vec_facts row rolls back too.
      db.prepare("DELETE FROM vec_int8_scale WHERE table_name = 'vec_facts'").run();
      db.prepare("INSERT OR REPLACE INTO vec_int8_scale (table_name, scale) VALUES ('vec_facts_kr', 0)").run();
      const vecBefore = db.prepare('SELECT count(*) AS n FROM vec_facts_rowids').get();
      expect(() => insertFact(db, {
        fact: 'English vector written, Korean one fails', category: 'knowledge', scope_type: 'global',
        scope_project: null, source_exchange_ids: ['ex-3'], embedding: unitVector(44), fact_kr: '한국어 벡터 실패', embedding_kr: unitVector(45),
      })).toThrow(/vec_int8_scale/);
      expect(db.prepare('SELECT count(*) AS n FROM facts').get()).toEqual(before);
      expect(db.prepare('SELECT count(*) AS n FROM vec_facts_rowids').get()).toEqual(vecBefore);
    } finally {
      db.close();
    }
  });

  it('legacy int8 fact table without a recorded scale reads as 127 and re-open does not record one', () => {
    const raw = new Database(dbPath);
    sqliteVec.load(raw);
    raw.exec('CREATE VIRTUAL TABLE vec_facts USING vec0(id TEXT PRIMARY KEY, embedding int8[384])');
    raw.close();

    const db = initDatabase();
    try {
      expect(getVecQuant(db, 'vec_facts')).toEqual({ dtype: 'int8', scale: 127 });
      const recorded = db.prepare("SELECT count(*) AS n FROM vec_int8_scale WHERE table_name = 'vec_facts'").get() as { n: number };
      expect(recorded.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('float32 table reports scale 1 and a bare placeholder', () => {
    const raw = new Database(dbPath);
    sqliteVec.load(raw);
    raw.exec('CREATE VIRTUAL TABLE vec_facts USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[384])');
    raw.close();
    const db = initDatabase();
    try {
      const q = getVecQuant(db, 'vec_facts');
      expect(q).toEqual({ dtype: 'float32', scale: 1 });
      expect(vecParamSql(q)).toBe('?');
      expect(embeddingToVecBlob(unitVector(1), q).length).toBe(384 * 4);
    } finally {
      db.close();
    }
  });

  it('a corrupt recorded scale fails loud instead of silently falling back', () => {
    const db = initDatabase();
    try {
      for (const bad of [0, -5, 1e9]) {
        db.prepare("INSERT OR REPLACE INTO vec_int8_scale (table_name, scale) VALUES ('vec_facts', ?)").run(bad);
        expect(() => getVecQuant(db, 'vec_facts')).toThrow(/vec_int8_scale/);
      }
    } finally {
      db.close();
    }
  });

  it('encode/normalize use the table scale: scale 600 tracks the float distance far closer than 127', () => {
    const a = unitVector(3);
    const b = unitVector(4);
    const exact = floatL2(a, b);
    const err = (scale: number) => {
      const q = { dtype: 'int8' as const, scale };
      const qa = new Int8Array(embeddingToVecBlob(a, q).buffer.slice(0));
      const qb = new Int8Array(embeddingToVecBlob(b, q).buffer.slice(0));
      let s = 0;
      for (let i = 0; i < 384; i++) s += (qa[i] - qb[i]) ** 2;
      return Math.abs(normalizeVecDistance(Math.sqrt(s), q) - exact);
    };
    expect(err(600)).toBeLessThan(err(127));
    expect(err(600)).toBeLessThan(0.01);
    expect(vecParamSql({ dtype: 'int8', scale: 600 })).toBe('vec_int8(?)');
  });

  it('a fact written to a migrated (scale 600) table is found again at similarity ≈ 1', () => {
    const db = initDatabase();
    try {
      recordFactScale600(db);
      const emb = unitVector(7);
      const id = insertFact(db, {
        fact: 'User prefers int8 fact vectors at a per-table scale',
        category: 'preference', scope_type: 'global', scope_project: null,
        source_exchange_ids: ['ex-1'], embedding: emb,
      });
      const hits = searchSimilarFacts(db, emb, null, 5, 0.5);
      expect(hits[0]?.fact.id).toBe(id);
      expect(l2DistanceToSimilarity(hits[0].distance)).toBeGreaterThan(0.999);
    } finally {
      db.close();
    }
  });

  it('a fact written to a legacy (scale 127) table is found again at similarity ≈ 1', () => {
    const raw = new Database(dbPath);
    sqliteVec.load(raw);
    raw.exec('CREATE VIRTUAL TABLE vec_facts USING vec0(id TEXT PRIMARY KEY, embedding int8[384])');
    raw.exec('CREATE VIRTUAL TABLE vec_facts_kr USING vec0(id TEXT PRIMARY KEY, embedding int8[384])');
    raw.close();
    const db = initDatabase();
    try {
      const emb = unitVector(9);
      const id = insertFact(db, {
        fact: 'Legacy int8 tables keep reading at scale 127',
        category: 'knowledge', scope_type: 'global', scope_project: null,
        source_exchange_ids: ['ex-2'], embedding: emb,
      });
      const hits = searchSimilarFacts(db, emb, null, 5, 0.5);
      expect(hits[0]?.fact.id).toBe(id);
      expect(l2DistanceToSimilarity(hits[0].distance)).toBeGreaterThan(0.99);
    } finally {
      db.close();
    }
  });
});

afterAll(() => restoreConsole());
