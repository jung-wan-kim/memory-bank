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

  /** A conversation with one exchange near each concept vector — a semantic match of ['Paddle', 'webhook']. */
  function seedSemanticConversation(name: string, theta: number, side: number): void {
    const db = initDatabase();
    const base = { project: 'demo', timestamp: '2026-10-01T00:00:00.000Z', assistantMessage: 'x', archivePath: `/seed/archive/${name}.jsonl` };
    insertExchange(db, { ...base, id: `${name}-a`, userMessage: 'first half', lineStart: 1, lineEnd: 2 }, near(0, theta, side));
    insertExchange(db, { ...base, id: `${name}-b`, userMessage: 'second half', lineStart: 3, lineEnd: 4 }, near(200, theta, side + 1));
    db.close();
  }

  // F3 — the two lists used to be concatenated, keyword matches first: once they filled `limit`, no semantic
  // match was returned at all (18 queries on the live index: 8 lost semantic matches that were closer to the
  // concepts than every keyword match shown).
  it('keyword and semantic matches share one ranking: keyword matches that fill the limit do not push every semantic match out', async () => {
    seed(Array.from({ length: 6 }, (_, i) => ({
      id: `kw-${i}`, user: `the Paddle webhook case ${i}`, vector: near(0, 1.2 - i * 0.02, 300 + i),
    })));
    seedSemanticConversation('sem-0', 0.02, 350);
    seedSemanticConversation('sem-1', 0.04, 352);
    seedSemanticConversation('sem-2', 0.06, 354);

    const results = await searchMultipleConcepts(['Paddle', 'webhook'], { limit: 4 });
    // rank by rank from each list; at the same rank the exchange that has every word goes first
    expect(results.map((r) => r.matchedBy)).toEqual(['keyword', 'semantic', 'keyword', 'semantic']);
    expect(results.filter((r) => r.matchedBy === 'semantic').map((r) => r.exchange.archivePath))
      .toEqual(['/seed/archive/sem-0.jsonl', '/seed/archive/sem-1.jsonl']);
    expect(new Set(results.map((r) => r.exchange.archivePath)).size).toBe(4);

    // a larger limit: all three semantic matches are in, between the keyword matches
    const six = await searchMultipleConcepts(['Paddle', 'webhook'], { limit: 6 });
    expect(six.map((r) => r.matchedBy)).toEqual(['keyword', 'semantic', 'keyword', 'semantic', 'keyword', 'semantic']);
    expect(new Set(six.map((r) => r.exchange.archivePath)).size).toBe(6);
  });

  // R2-SEARCH-2 — the keyword matches were re-sorted by their average similarity to the concepts. A one-word
  // concept and a long turn score in a narrow band whatever the turn is about, so the sort pushed the turn
  // the keyword pass ranked first out of the answer: on the live index the conversation a fact came from was
  // in the top 10 for 10 of 70 two-word queries with the sort and for 14 with the keyword order kept.
  it('keyword matches keep the keyword pass\'s order: their similarity to the concepts does not re-rank them', async () => {
    seed([
      // the keyword pass ranks this one first (the words repeat); its vector is the farther one from the concepts
      { id: 'kw-far', user: 'paddle webhook paddle webhook paddle webhook', vector: near(0, 1.5, 300) },
      { id: 'kw-near', user: 'the paddle webhook arrives late after the retry window closes', vector: near(0, 0.6, 301) },
    ]);
    const results = await searchMultipleConcepts(['Paddle', 'webhook'], { limit: 5 });
    expect(results.map((r) => r.exchange.id)).toEqual(['kw-far', 'kw-near']);
    // the similarity is still reported for each — it is shown, not ranked by
    expect(results[0].averageSimilarity).toBeLessThan(results[1].averageSimilarity);
    expect(results.every((r) => r.matchedBy === 'keyword')).toBe(true);
  });

  it('a keyword match whose exchange has no vector keeps its keyword rank, with its similarity unknown', async () => {
    seed([
      { id: 'kw-first', user: 'paddle webhook paddle webhook paddle webhook', vector: near(0, 1.5, 300) },
      { id: 'kw-second', user: 'the paddle webhook arrives late after the retry window closes', vector: near(0, 0.6, 301) },
    ]);
    const db = initDatabase();
    db.prepare('DELETE FROM vec_exchanges WHERE id = ?').run('kw-first');
    db.close();

    const results = await searchMultipleConcepts(['Paddle', 'webhook'], { limit: 5 });
    expect(results.map((r) => r.exchange.id)).toEqual(['kw-first', 'kw-second']);
    expect(Number.isNaN(results[0].averageSimilarity)).toBe(true);
    expect(await formatMultiConceptResults(results, ['Paddle', 'webhook'])).toMatch(/1\. \[demo, 2026-10-01\] - every word in one exchange \(n\/a/);
  });

  it('a conversation found both ways ranks above one found one way, and is listed once', async () => {
    seed([
      { id: 'kw-only', user: 'the Paddle webhook arrives late', vector: near(0, 0.9, 300) },
    ]);
    seedSemanticConversation('sem-only', 0.02, 350);
    // semantically near both concepts AND one of its exchanges has every word
    seedSemanticConversation('both', 0.06, 352);
    const db = initDatabase();
    insertExchange(db, {
      id: 'both-c', project: 'demo', timestamp: '2026-10-01T00:00:00.000Z', userMessage: 'so the Paddle webhook was the cause',
      assistantMessage: 'x', archivePath: '/seed/archive/both.jsonl', lineStart: 5, lineEnd: 6,
    }, near(0, 1.2, 360));
    db.close();

    const results = await searchMultipleConcepts(['Paddle', 'webhook'], { limit: 5 });
    expect(results.map((r) => r.exchange.archivePath)).toEqual([
      '/seed/archive/both.jsonl', '/seed/archive/kw-only.jsonl', '/seed/archive/sem-only.jsonl',
    ]);
    // listed as the exchange that has every word — the place to read
    expect(results[0].exchange.id).toBe('both-c');
    expect(results[0].matchedBy).toBe('keyword');
  });

  it('at the same rank the keyword match goes first; up to the limit', async () => {
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

  // F10 — every concept used to start its vector pass from the same guess (k = 8 × what it wants) and grow from
  // there. How many of the nearest vectors pass belongs to the index and the filters, not to the concept: on an
  // index that is mostly machine noise each concept paid for the round that was too small.
  it('a later concept starts its vector pass at the k an earlier one needed', async () => {
    const noise = (prefix: string, axis: number) => Array.from({ length: 450 }, (_, i) => ({
      id: `${prefix}-noise-${i}`, user: 'Warmup', vector: near(axis, 0.01 + i * 0.0005, axis + 1 + (i % 90)), sidechain: true,
    }));
    seed([...noise('a', 0), ...noise('b', 200)]);

    const { getSearchDb } = await import('../src/search.js');
    const db = getSearchDb();
    const ks: number[] = [];
    const original = db.prepare.bind(db);
    (db as { prepare: unknown }).prepare = (text: string) => {
      const stmt = original(text);
      if (!/FROM vec_exchanges AS vec/.test(text)) return stmt;
      const all = stmt.all.bind(stmt);
      (stmt as { all: unknown }).all = (...params: unknown[]) => { ks.push(params[params.length - 1] as number); return all(...params); };
      return stmt;
    };
    try {
      await searchMultipleConcepts(['Paddle', 'webhook'], { limit: 10 });
    } finally {
      delete (db as { prepare?: unknown }).prepare;
    }
    // first concept: 400 (10 × 5 × 8), nothing but noise among them → the ceiling. Second concept: the ceiling at once.
    expect(ks).toEqual([400, 4096, 4096]);
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
