import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Each concept gets its own query vector: "paddle…" → axis 0, anything else → axis 200.
vi.mock('../src/embeddings.js', async (orig) => {
  const { DIM } = await import('./helpers/search-seed.js');
  const along = (axis: number) => { const v = new Array<number>(DIM).fill(0); v[axis] = 1; return v; };
  return {
    ...(await orig<typeof import('../src/embeddings.js')>()),
    initEmbeddings: vi.fn(async () => {}),
    generateEmbedding: vi.fn(async (text: string) => (text.toLowerCase().startsWith('paddle') ? along(0) : along(200))),
  };
});

import { initDatabase, insertExchange } from '../src/db.js';
import { searchMultipleConcepts, formatMultiConceptResults, multiConceptResultsToJson } from '../src/search.js';
import { DIM } from './helpers/search-seed.js';

/** Unit vector `theta` away from `mainAxis`, leaning toward `sideAxis`. */
function near(mainAxis: number, theta: number, sideAxis: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[mainAxis] = Math.cos(theta);
  v[sideAxis] = Math.sin(theta);
  return v;
}

// SQ-12 — the multi-concept search intersected, per conversation, each concept's nearest 5×limit exchanges.
// On a large index those lists rarely share a conversation: ["Paddle", "웹훅"] returned nothing while 38
// exchanges contained both words.
describe('multi-concept search finds exchanges that contain every concept\'s words', () => {
  let tmpDir: string;
  const prevDb = process.env.MEMORY_BANK_DB_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-multi-concept-'));
    process.env.MEMORY_BANK_DB_PATH = path.join(tmpDir, 'db.sqlite');
  });

  afterEach(() => {
    if (prevDb === undefined) delete process.env.MEMORY_BANK_DB_PATH; else process.env.MEMORY_BANK_DB_PATH = prevDb;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(extra: Array<{ id: string; user: string; assistant?: string; vector: number[]; sidechain?: boolean }> = []) {
    const db = initDatabase();
    const put = (id: string, user: string, assistant: string, vector: number[], sidechain = false) => insertExchange(db, {
      id, project: 'demo', timestamp: '2026-10-01T00:00:00.000Z', userMessage: user, assistantMessage: assistant,
      archivePath: `/seed/archive/${id}.jsonl`, lineStart: 1, lineEnd: 2, isSidechain: sidechain,
    }, vector);
    db.transaction(() => {
      // 40 conversations near the first concept's vector and 40 near the second's — none shared.
      for (let i = 0; i < 40; i++) put(`near-a-${i}`, `billing question ${i}`, 'an answer', near(0, 0.1 + i * 0.01, 1 + i));
      for (let i = 0; i < 40; i++) put(`near-b-${i}`, `delivery question ${i}`, 'an answer', near(200, 0.1 + i * 0.01, 201 + i));
      for (const row of extra) put(row.id, row.user, row.assistant ?? 'an answer', row.vector, row.sidechain);
    })();
    db.close();
  }

  it('returns the exchange that has every word, even when the semantic lists share no conversation', async () => {
    seed([
      { id: 'both-words', user: 'the Paddle webhook arrives late', vector: near(0, 1.2, 300) },
      { id: 'one-word', user: 'the Paddle invoice is wrong', vector: near(0, 1.2, 301) },
    ]);

    const results = await searchMultipleConcepts(['Paddle', 'webhook'], { limit: 5 });
    expect(results.map((r) => r.exchange.id)).toEqual(['both-words']);
    expect(results[0].matchedBy).toBe('keyword');
    // real similarities of that exchange to each concept (cos 1.2 to the first axis, orthogonal to the second)
    expect(results[0].conceptSimilarities[0]).toBeCloseTo(Math.cos(1.2), 1);
    expect(results[0].conceptSimilarities[1]).toBeCloseTo(0, 1);
    expect(results[0].averageSimilarity).toBeCloseTo((results[0].conceptSimilarities[0] + results[0].conceptSimilarities[1]) / 2, 6);

    const text = await formatMultiConceptResults(results, ['Paddle', 'webhook']);
    expect(text).toMatch(/1\. \[demo, 2026-10-01\] - every word in one exchange/);
    expect(JSON.parse(multiConceptResultsToJson(results, ['Paddle', 'webhook'])).results[0].matchedBy).toBe('keyword');
  });

  it('a concept of several words needs all of them; Korean words match with particles attached', async () => {
    seed([
      { id: 'ko-both', user: 'Paddle 웹훅이 늦게 온다', vector: near(0, 1.2, 300) },
      { id: 'ko-one', user: 'Paddle 결제가 실패했다', vector: near(0, 1.2, 301) },
      { id: 'phrase-all', user: 'paddle retries the signed webhook', vector: near(0, 1.2, 302) },
      { id: 'phrase-part', user: 'paddle sends a webhook', vector: near(0, 1.2, 303) },
    ]);
    expect((await searchMultipleConcepts(['Paddle', '웹훅'], { limit: 5 })).map((r) => r.exchange.id)).toEqual(['ko-both']);
    expect((await searchMultipleConcepts(['Paddle', 'signed webhook'], { limit: 5 })).map((r) => r.exchange.id)).toEqual(['phrase-all']);
  });

  it('keyword matches come first, then the conversations every concept is semantically near, up to the limit', async () => {
    seed([
      { id: 'both-words', user: 'the Paddle webhook arrives late', vector: near(0, 1.2, 300) },
      // one conversation near BOTH concept vectors (two exchanges of the same file would do; here one row in between)
    ]);
    const db = initDatabase();
    insertExchange(db, { id: 'shared-a', project: 'demo', timestamp: '2026-10-01T00:00:00.000Z', userMessage: 'first half', assistantMessage: 'x', archivePath: '/seed/archive/shared.jsonl', lineStart: 1, lineEnd: 2 }, near(0, 0.05, 350));
    insertExchange(db, { id: 'shared-b', project: 'demo', timestamp: '2026-10-01T00:00:00.000Z', userMessage: 'second half', assistantMessage: 'x', archivePath: '/seed/archive/shared.jsonl', lineStart: 3, lineEnd: 4 }, near(200, 0.05, 351));
    db.close();

    const results = await searchMultipleConcepts(['Paddle', 'webhook'], { limit: 5 });
    expect(results.map((r) => [r.exchange.archivePath, r.matchedBy])).toEqual([
      ['/seed/archive/both-words.jsonl', 'keyword'],
      ['/seed/archive/shared.jsonl', 'semantic'],
    ]);
    expect(results[1].conceptSimilarities[0]).toBeGreaterThan(0.95);
    expect(results[1].conceptSimilarities[1]).toBeGreaterThan(0.95);
    expect((await searchMultipleConcepts(['Paddle', 'webhook'], { limit: 1 })).map((r) => r.matchedBy)).toEqual(['keyword']);
  });

  it('machine-noise turns are not keyword matches unless asked for', async () => {
    seed([{ id: 'noise', user: 'Warmup', assistant: 'the Paddle webhook is ready', vector: near(0, 1.2, 300), sidechain: true }]);
    expect(await searchMultipleConcepts(['Paddle', 'webhook'], { limit: 5 })).toEqual([]);
    expect((await searchMultipleConcepts(['Paddle', 'webhook'], { limit: 5, include_noise: true })).map((r) => r.exchange.id)).toEqual(['noise']);
  });

  it('no exchange has every word and no conversation is near every concept: nothing', async () => {
    seed([{ id: 'one-word', user: 'the Paddle invoice is wrong', vector: near(0, 1.2, 301) }]);
    const results = await searchMultipleConcepts(['Paddle', 'webhook'], { limit: 5 });
    expect(results).toEqual([]);
    expect(await formatMultiConceptResults(results, ['Paddle', 'webhook'])).toBe('No conversations found matching all concepts: Paddle, webhook');
  });
});
