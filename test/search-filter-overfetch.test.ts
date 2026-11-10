import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The query embedding is fixed (axis 0); every seeded row's angle from it is chosen by the test.
vi.mock('../src/embeddings.js', async (orig) => {
  const { QUERY_VECTOR } = await import('./helpers/search-seed.js');
  return {
    ...(await orig<typeof import('../src/embeddings.js')>()),
    initEmbeddings: vi.fn(async () => {}),
    generateEmbedding: vi.fn(async () => QUERY_VECTOR),
  };
});

import { initDatabase } from '../src/db.js';
import { searchConversations, searchConversationsDetailed, formatResults, VEC_KNN_K_MAX, VEC_KNN_FLAT_K } from '../src/search.js';
import { seedExchanges, type SeedRow } from './helpers/search-seed.js';

// SQ-03 — date/agent filters used to run AFTER the KNN's top-k cut (k = limit), so a row
// that passed the filter but sat behind `limit` nearer filtered-out rows never came back.
describe('vector search with row filters (bounded over-fetch)', () => {
  let tmpDir: string;
  const prevDb = process.env.MEMORY_BANK_DB_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-search-filter-'));
    process.env.MEMORY_BANK_DB_PATH = path.join(tmpDir, 'db.sqlite');
  });

  afterEach(() => {
    if (prevDb === undefined) delete process.env.MEMORY_BANK_DB_PATH; else process.env.MEMORY_BANK_DB_PATH = prevDb;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** `count` old rows nearer to the query than anything else the test seeds. */
  const oldNearRows = (count: number): SeedRow[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `old-${i}`,
      theta: 0.05 + (0.4 * i) / count,
      timestamp: '2025-03-01T00:00:00.000Z',
      codingAgent: 'claude-code',
    }));

  it('finds the row that passes `after` behind 50 nearer rows that do not', async () => {
    const db = initDatabase();
    seedExchanges(db, [...oldNearRows(50), { id: 'recent', theta: 0.9, timestamp: '2026-10-20T00:00:00.000Z' }]);
    db.close();

    const unfiltered = await searchConversations('anything', { mode: 'vector', limit: 10 });
    expect(unfiltered).toHaveLength(10);
    expect(unfiltered.map((r) => r.exchange.id)).not.toContain('recent');

    const filtered = await searchConversations('anything', { mode: 'vector', limit: 10, after: '2026-01-01' });
    expect(filtered.map((r) => r.exchange.id)).toEqual(['recent']);
  });

  it('finds the row that passes `coding_agent` behind 50 nearer rows of another agent', async () => {
    const db = initDatabase();
    seedExchanges(db, [...oldNearRows(50), { id: 'codex-row', theta: 0.9, codingAgent: 'codex' }]);
    db.close();

    const filtered = await searchConversations('anything', { mode: 'vector', limit: 10, coding_agent: 'codex' });
    expect(filtered.map((r) => r.exchange.id)).toEqual(['codex-row']);
  });

  it('fills `limit` with filter-passing rows in distance order', async () => {
    const db = initDatabase();
    const recent: SeedRow[] = Array.from({ length: 12 }, (_, i) => ({
      id: `recent-${String(i).padStart(2, '0')}`,
      theta: 0.6 + i * 0.03,
      timestamp: '2026-10-20T00:00:00.000Z',
    }));
    seedExchanges(db, [...oldNearRows(120), ...recent]);
    db.close();

    const { results, meta } = await searchConversationsDetailed('anything', { mode: 'vector', limit: 10, after: '2026-01-01' });
    expect(results.map((r) => r.exchange.id)).toEqual(recent.slice(0, 10).map((r) => r.id));
    // Nothing passed among the nearest 80, so the next round went straight to the ceiling;
    // the index holds 132 rows, 12 of them pass the filter.
    expect(meta.vector).toEqual({ k: 4096, candidates: 132, matched: 12, truncated: false });
  });

  it('grows k by the pass rate it has seen instead of scanning again and again', async () => {
    const db = initDatabase();
    // every 10th of 1,500 rows passes the filter: 8 of the nearest 80
    const rows: SeedRow[] = Array.from({ length: 1500 }, (_, i) => ({
      id: `row-${String(i).padStart(4, '0')}`,
      theta: 0.05 + i * 0.0008,
      timestamp: i % 10 === 0 ? '2026-10-20T00:00:00.000Z' : '2025-03-01T00:00:00.000Z',
    }));
    seedExchanges(db, rows);
    db.close();

    const { results, meta } = await searchConversationsDetailed('anything', { mode: 'vector', limit: 20, after: '2026-01-01' });
    expect(results).toHaveLength(20);
    expect(results.every((r) => r.exchange.timestamp.startsWith('2026'))).toBe(true);
    // 160 at first (20 × 8) → about 16 pass → next k = max(640, 160 × 20 × 2 / 16 = 400) = 640: two rounds, done
    expect(meta.vector).toMatchObject({ k: 640, candidates: 640, truncated: false });
    // about every 10th of the nearest 640 (int8 ties at the edge make it ±a few)
    expect(meta.vector!.matched).toBeGreaterThanOrEqual(58);
    expect(meta.vector!.matched).toBeLessThanOrEqual(70);
  });

  // F10 — sqlite-vec selects the nearest min(k, 1024) of every 1,024-vector chunk, so a KNN costs the same for
  // any k from 1,024 up (341,840 vectors: k 400 → 145 ms, 1,600 → 300 ms, 4,096 → 300 ms). A k in between
  // paid the ceiling's price for fewer candidates and often needed one more round at the ceiling.
  it('a next k at or above the vec0 chunk size goes to the ceiling at once', async () => {
    expect(VEC_KNN_FLAT_K).toBe(1024);
    const db = initDatabase();
    // every 10th of 1,500 rows passes the filter: about 32 of the nearest 320
    const rows: SeedRow[] = Array.from({ length: 1500 }, (_, i) => ({
      id: `row-${String(i).padStart(4, '0')}`,
      theta: 0.05 + i * 0.0008,
      timestamp: i % 10 === 0 ? '2026-10-20T00:00:00.000Z' : '2025-03-01T00:00:00.000Z',
    }));
    seedExchanges(db, rows);
    db.close();

    const { results, meta } = await searchConversationsDetailed('anything', { mode: 'vector', limit: 40, after: '2026-01-01' });
    expect(results).toHaveLength(40);
    expect(results.every((r) => r.exchange.timestamp.startsWith('2026'))).toBe(true);
    // 320 at first (40 × 8) → about 32 pass → the pass rate asks for max(1280, 800) = 1280 → the ceiling
    // instead (the index holds 1,500 rows, so it is read whole: 150 pass)
    expect(meta.vector).toEqual({ k: 4096, candidates: 1500, matched: 150, truncated: false });
  });

  it('starts at the k the caller names (a caller that just searched this index under the same filters)', async () => {
    const db = initDatabase();
    seedExchanges(db, [...oldNearRows(120), { id: 'recent', theta: 0.9, timestamp: '2026-10-20T00:00:00.000Z' }]);
    db.close();

    const guessed = await searchConversationsDetailed('anything', { mode: 'vector', limit: 1, after: '2026-01-01' });
    // 64 at first, nothing passes → the ceiling
    expect(guessed.meta.vector).toEqual({ k: 4096, candidates: 121, matched: 1, truncated: false });
    const told = await searchConversationsDetailed('anything', { mode: 'vector', limit: 1, after: '2026-01-01', vector_first_k: 256 });
    expect(told.results.map((r) => r.exchange.id)).toEqual(['recent']);
    expect(told.meta.vector).toEqual({ k: 256, candidates: 121, matched: 1, truncated: false });
  });

  it('an index that runs out before `limit` is not reported as truncated', async () => {
    const db = initDatabase();
    seedExchanges(db, [...oldNearRows(30), { id: 'recent', theta: 0.9, timestamp: '2026-10-20T00:00:00.000Z' }]);
    db.close();

    const { results, meta } = await searchConversationsDetailed('anything', { mode: 'vector', limit: 10, after: '2026-01-01' });
    expect(results).toHaveLength(1);
    expect(meta.vector).toEqual({ k: 80, candidates: 31, matched: 1, truncated: false });
    expect(await formatResults(results, meta)).not.toMatch(/ceiling/i);
  });

  it('stops at the sqlite-vec k ceiling and says the result was cut short', async () => {
    expect(VEC_KNN_K_MAX).toBe(4096);
    const db = initDatabase();
    // 4,200 nearer rows fail the filter; the only passing row is beyond the ceiling.
    seedExchanges(db, [...oldNearRows(4200), { id: 'recent', theta: 1.2, timestamp: '2026-10-20T00:00:00.000Z' }]);
    db.close();

    const { results, meta } = await searchConversationsDetailed('anything', { mode: 'vector', limit: 5, after: '2026-01-01' });
    expect(results).toEqual([]);
    expect(meta.vector).toEqual({ k: 4096, candidates: 4096, matched: 0, truncated: true });

    const text = await formatResults(results, meta);
    expect(text).toContain('No results found.');
    expect(text).toMatch(/nearest 4096 vector candidates/);
    expect(text).toMatch(/0 passed the filters/);
  });

  it('a limit above the k ceiling is clamped instead of failing the query', async () => {
    const db = initDatabase();
    seedExchanges(db, oldNearRows(20));
    db.close();

    const results = await searchConversations('anything', { mode: 'vector', limit: 5000 });
    expect(results).toHaveLength(20);
  });
});

// SQ-03/SQ-06 — keyword hits carried distance 0, so `both` mode printed them as "100% match".
describe('match labels', () => {
  let tmpDir: string;
  const prevDb = process.env.MEMORY_BANK_DB_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-search-label-'));
    process.env.MEMORY_BANK_DB_PATH = path.join(tmpDir, 'db.sqlite');
  });

  afterEach(() => {
    if (prevDb === undefined) delete process.env.MEMORY_BANK_DB_PATH; else process.env.MEMORY_BANK_DB_PATH = prevDb;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a keyword-only hit has no similarity and is never printed as "100% match"', async () => {
    const db = initDatabase();
    seedExchanges(db, [
      { id: 'near-1', theta: 0.1, userMessage: 'how do I tune the planner' },
      { id: 'near-2', theta: 0.2, userMessage: 'planner statistics are stale' },
      { id: 'keyword', theta: 1.3, userMessage: 'the zebrafish migration failed again' },
    ]);
    db.close();

    const results = await searchConversations('zebrafish', { mode: 'both', limit: 2 });
    const byId = new Map(results.map((r) => [r.exchange.id, r]));
    expect(byId.get('keyword')!.similarity).toBeUndefined();
    expect(byId.get('keyword')!.matchedBy).toBe('text');
    expect(byId.get('near-1')!.matchedBy).toBe('vector');
    // cosine of the seeded angle (int8-quantized), not 1 − L2 distance
    expect(byId.get('near-1')!.similarity).toBeCloseTo(Math.cos(0.1), 2);

    const text = await formatResults(results);
    expect(text).not.toContain('100% match');
    expect(text).toMatch(/- keyword match/);
    expect(text).toMatch(/- 99% match/);
  });

  it('`both` mode returns at most `limit` rows, a hit found by both passes first', async () => {
    const db = initDatabase();
    seedExchanges(db, [
      { id: 'A', theta: 0.1, userMessage: 'how do I tune the planner' },
      { id: 'B', theta: 0.2, userMessage: 'the zebrafish migration failed again' },
      { id: 'D', theta: 0.3, userMessage: 'planner statistics are stale' },
      { id: 'E', theta: 0.4, userMessage: 'index rebuild takes too long' },
      { id: 'C', theta: 1.3, userMessage: 'zebrafish again, different table' },
    ]);
    db.close();

    const results = await searchConversations('zebrafish', { mode: 'both', limit: 2 });
    expect(results).toHaveLength(2);
    expect(results[0].exchange.id).toBe('B');
    expect(results[0].matchedBy).toBe('both');
    expect(results[0].similarity).toBeCloseTo(Math.cos(0.2), 2);
    expect(await formatResults(results)).toMatch(/- 98% match \(semantic \+ keyword\)/);
  });
});
