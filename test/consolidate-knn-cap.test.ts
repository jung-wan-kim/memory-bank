import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';

// The comparison LLM is a stub: every pair is INDEPENDENT, each call counted.
vi.mock('../src/llm.js', () => ({
  callHaiku: vi.fn().mockResolvedValue('{"relation":"INDEPENDENT","merged_fact":"","reason":"stub"}'),
  parseJsonResponse: vi.fn().mockReturnValue({ relation: 'INDEPENDENT', merged_fact: '', reason: 'stub' }),
}));

import { callHaiku } from '../src/llm.js';
import { initDatabase, getVecQuant, embeddingToVecBlob, vecParamSql } from '../src/db.js';
import { insertFact, searchSimilarFacts, searchSimilarFactsSameScope } from '../src/fact-db.js';
import { consolidateAllPending } from '../src/consolidator.js';
import { VEC0_KNN_K_MAX } from '../src/vec-limits.js';

/**
 * 2026-10-16 ~ 11-10: consolidation stood still for 25 days. The same-scope
 * candidate search grew its KNN k 200 → 800 → 3,200 → 12,800 whenever a driver
 * had fewer than 4 neighbours above the threshold, sqlite-vec refuses k > 4,096,
 * and the drain loop held the cursor on that throw — 2,552 runs failed on the
 * same first fact. Every existing fixture used identical vectors and at most
 * 211 rows, so none of them reached the fourth page.
 *
 * This fixture is the shape of a real index: more distinct vectors than the k
 * limit (4,200), one near-duplicate pair among them, and one fact with no
 * neighbour at all.
 */

const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

/** Deterministic PRNG (mulberry32) — the fixture is the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unit(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

/** A random direction in 384 dimensions: two such vectors are near-orthogonal (cos ≈ 0 ± 0.05). */
function randomUnit(next: () => number): number[] {
  return unit(Array.from({ length: 384 }, () => next() + next() + next() - 1.5));
}

const CROWD = 4200; // > VEC0_KNN_K_MAX distinct vectors
const T0 = Date.parse('2020-01-01T00:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

describe('same-scope candidate search on an index larger than the KNN k limit', () => {
  let dir: string;
  let db: Database.Database;
  let pairA: { id: string; embedding: number[] };
  let pairB: { id: string; embedding: number[] };
  let lone: { id: string; embedding: number[] };
  /** Cursor that sits right after the crowd: only the pair and the lone fact are pending. */
  const afterCrowd = { createdAt: iso(CROWD + 1000), id: '' };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-knn-cap-'));
    process.env.TEST_DB_PATH = path.join(dir, 'test.db');
    db = initDatabase();
    const next = rng(20261016);
    const setCreated = db.prepare('UPDATE facts SET created_at = ?, updated_at = ? WHERE id = ?');
    const add = (fact: string, scope_type: 'global' | 'project', scope_project: string | null, embedding: number[], at: string) => {
      const id = insertFact(db, { fact, category: 'knowledge', scope_type, scope_project, source_exchange_ids: [], embedding });
      setCreated.run(at, at, id);
      return { id, embedding };
    };
    db.transaction(() => {
      for (let i = 0; i < CROWD; i++) add(`Crowd fact number ${i} about an unrelated topic`, 'global', null, randomUnit(next), iso(i));
      const base = randomUnit(next);
      const nudge = randomUnit(next);
      pairA = add('The deploy script tags the release before it publishes', 'global', null, base, iso(CROWD + 2000));
      // cos(base, near) ≈ 0.999 — a paraphrase-level neighbour, far above the 0.95 gate
      pairB = add('The deploy script creates the release tag, then publishes', 'global', null,
        unit(base.map((x, i) => x + 0.05 * nudge[i])), iso(CROWD + 3000));
      lone = add('The staging database is restored from the nightly dump', 'project', '/proj-lone', randomUnit(next), iso(CROWD + 4000));
    })();
  }, 120_000);

  afterAll(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the fixture really is larger than the limit, and the limit is one the installed sqlite-vec accepts', () => {
    const rows = (db.prepare('SELECT COUNT(*) AS n FROM vec_facts').get() as { n: number }).n;
    expect(rows).toBe(CROWD + 3);
    expect(rows).toBeGreaterThan(VEC0_KNN_K_MAX);
    const q = getVecQuant(db, 'vec_facts');
    const atCap = db.prepare(`SELECT id FROM vec_facts WHERE embedding MATCH ${vecParamSql(q)} ORDER BY distance LIMIT ?`)
      .all(embeddingToVecBlob(pairA.embedding, q), VEC0_KNN_K_MAX);
    expect(atCap).toHaveLength(VEC0_KNN_K_MAX);
  });

  it('a driver with ONE neighbour finds it (it used to ask for k=12,800 and throw)', () => {
    const hits = searchSimilarFactsSameScope(db, pairA.embedding, { type: 'global' }, 5, 0.95);
    expect(hits.map((h) => h.fact.id)).toEqual([pairA.id, pairB.id]);
  });

  it('a driver with NO neighbour gets only itself back — not a throw', () => {
    const hits = searchSimilarFactsSameScope(db, lone.embedding, { type: 'project', project: '/proj-lone' }, 5, 0.95);
    expect(hits.map((h) => h.fact.id)).toEqual([lone.id]);
  });

  it('when more rows pass the threshold than one KNN can return, it returns what the nearest 4,096 held and says so', () => {
    // threshold -1: every row passes, so only the k limit can end the paging.
    const capped: Array<{ k: number; found: number }> = [];
    const hits = searchSimilarFactsSameScope(db, lone.embedding, { type: 'project', project: '/proj-lone' }, 5, -1,
      { onCapReached: (info) => capped.push(info) });
    expect(hits.map((h) => h.fact.id)).toEqual([lone.id]);
    expect(capped).toEqual([{ k: VEC0_KNN_K_MAX, found: 1 }]);
  });

  it('a search that ends below the threshold does not report the cap', () => {
    const capped: unknown[] = [];
    searchSimilarFactsSameScope(db, pairA.embedding, { type: 'global' }, 5, 0.95, { onCapReached: (info) => capped.push(info) });
    expect(capped).toEqual([]);
  });

  it('replay-bench visibility paging stops at the limit too (it used to ask for k=6,400 and throw)', () => {
    const visible = new Set([pairA.id, pairB.id]);
    const hits = searchSimilarFacts(db, pairA.embedding, null, 5, 0.95, { visibleId: (id) => visible.has(id) });
    expect(hits.map((h) => h.fact.id)).toEqual([pairA.id, pairB.id]);
  });

  it('consolidateAllPending compares the pair and moves the cursor past all three pending facts', async () => {
    const result = await consolidateAllPending(db, afterCrowd);

    const prompts = (callHaiku as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[1]));
    expect(prompts).toHaveLength(2); // A against B, then B against A — the lone fact has no candidate
    for (const p of prompts) {
      expect(p).toContain('The deploy script tags the release before it publishes');
      expect(p).toContain('The deploy script creates the release tag, then publishes');
    }
    expect(result.haikuCalls).toBe(2);
    expect(result.processed).toBe(3);
    expect(result.cursor).toEqual({ createdAt: iso(CROWD + 4000), id: lone.id });
  });
});
