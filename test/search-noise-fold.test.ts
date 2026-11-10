import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/embeddings.js', async (orig) => {
  const { QUERY_VECTOR } = await import('./helpers/search-seed.js');
  return {
    ...(await orig<typeof import('../src/embeddings.js')>()),
    initEmbeddings: vi.fn(async () => {}),
    generateEmbedding: vi.fn(async () => QUERY_VECTOR),
  };
});

import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { createRelation } from '../src/ontology-db.js';
import { vecAt } from './helpers/search-seed.js';
import {
  getKnowledgeContext,
  formatKnowledgeContext,
  KNOWLEDGE_FACT_CHARS,
  searchConversations,
  searchConversationsDetailed,
  formatResults,
  isErrorSummary,
  getSearchDb,
  NOISE_EXCHANGE_SQL,
  NOISE_OBSERVER_PREFIX,
} from '../src/search.js';
import { seedExchanges, type SeedRow } from './helpers/search-seed.js';

let tmpDir: string;
const prevDb = process.env.MEMORY_BANK_DB_PATH;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-search-noise-'));
  process.env.MEMORY_BANK_DB_PATH = path.join(tmpDir, 'db.sqlite');
});

afterEach(() => {
  if (prevDb === undefined) delete process.env.MEMORY_BANK_DB_PATH; else process.env.MEMORY_BANK_DB_PATH = prevDb;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ids = (results: Array<{ exchange: { id: string } }>) => results.map((r) => r.exchange.id);

// SQ-01 — 82.6% of the live conversation index is machine noise: sub-agent warm-up turns (a sidechain row
// whose user message is exactly "Warmup") and another memory plugin's observer prompts. Searches returned
// those instead of what a person asked.
describe('machine-noise rows are left out by default', () => {
  const warmups = (n: number): SeedRow[] => Array.from({ length: n }, (_, i) => ({
    id: `warmup-${i}`, theta: 0.05 + (i % 15) * 0.02, userMessage: 'Warmup', assistantMessage: 'Ready to help with zebrafish.', isSidechain: true,
  }));
  const observers = (n: number): SeedRow[] => Array.from({ length: n }, (_, i) => ({
    id: `observer-${i}`, theta: 0.4 + (i % 15) * 0.02, userMessage: `${NOISE_OBSERVER_PREFIX}\n<what_happened>zebrafish tool call ${i}</what_happened>`,
  }));
  const real: SeedRow[] = [
    { id: 'real-1', theta: 0.9, userMessage: 'why did the zebrafish migration fail' },
    { id: 'real-2', theta: 1.0, userMessage: 'Warmup', isSidechain: false }, // a person typed it in the main chain
    { id: 'real-3', theta: 1.1, userMessage: 'Warmup 순서 알려줘', isSidechain: true }, // not exactly "Warmup"
  ];

  it('the predicate is one SQL condition over `exchanges AS e`', () => {
    expect(NOISE_OBSERVER_PREFIX).toBe('<observed_from_primary_session>');
    expect(NOISE_EXCHANGE_SQL).toContain(`'Warmup'`);
    expect(NOISE_EXCHANGE_SQL).toContain(NOISE_OBSERVER_PREFIX);
    const db = initDatabase();
    seedExchanges(db, [...warmups(2), ...observers(2), ...real]);
    const noisy = db.prepare(`SELECT e.id FROM exchanges AS e WHERE ${NOISE_EXCHANGE_SQL} ORDER BY e.id`).all() as Array<{ id: string }>;
    db.close();
    expect(noisy.map((r) => r.id)).toEqual(['observer-0', 'observer-1', 'warmup-0', 'warmup-1']);
  });

  it('vector search returns the real turns behind 30 nearer noise rows', async () => {
    const db = initDatabase();
    seedExchanges(db, [...warmups(15), ...observers(15), ...real]);
    db.close();

    expect(ids(await searchConversations('anything', { mode: 'vector', limit: 3 }))).toEqual(['real-1', 'real-2', 'real-3']);

    const withNoise = await searchConversations('anything', { mode: 'vector', limit: 3, include_noise: true });
    expect(ids(withNoise)).toEqual(['warmup-0', 'warmup-1', 'warmup-2']);
  });

  it('keyword search finds the one real match behind 300 newer noise matches', async () => {
    const db = initDatabase();
    seedExchanges(db, [real[0], ...warmups(150), ...observers(150)]);
    db.close();

    const { results, meta } = await searchConversationsDetailed('zebrafish', { mode: 'text', limit: 5 });
    expect(ids(results)).toEqual(['real-1']);
    expect(meta.text).toEqual({ path: 'fts', truncated: false });

    const withNoise = await searchConversations('zebrafish', { mode: 'text', limit: 5, include_noise: true });
    expect(withNoise).toHaveLength(5);
    expect(ids(withNoise)).not.toContain('real-1');
  });

  it('keyword search with a date filter leaves noise out too', async () => {
    const db = initDatabase();
    seedExchanges(db, [
      { ...real[0], timestamp: '2026-10-20T00:00:00.000Z' },
      ...warmups(20).map((r) => ({ ...r, timestamp: '2026-10-21T00:00:00.000Z' })),
    ]);
    db.close();
    expect(ids(await searchConversations('zebrafish', { mode: 'text', limit: 5, after: '2026-10-01' }))).toEqual(['real-1']);
  });

  it('`both` mode leaves noise out of both passes', async () => {
    const db = initDatabase();
    seedExchanges(db, [...warmups(15), ...observers(15), ...real]);
    db.close();
    const results = await searchConversations('zebrafish', { mode: 'both', limit: 10 });
    expect(ids(results).sort()).toEqual(['real-1', 'real-2', 'real-3']);
  });

  it('says so when the keyword pass ran out of look-ahead before filling the limit', async () => {
    const db = initDatabase();
    seedExchanges(db, [real[0], ...warmups(4200)]);
    db.close();

    const { results, meta } = await searchConversationsDetailed('zebrafish', { mode: 'text', limit: 5 });
    expect(results).toEqual([]);
    expect(meta.text).toEqual({ path: 'fts', truncated: true });
    expect(await formatResults(results, meta)).toMatch(/Keyword results are incomplete/);
  });
});

// SQ-07 — a growing session is re-indexed with the same user turn under a new id each time (the id hashes
// the end line), so one turn came back several times with only the line range differing.
describe('snapshot copies of one turn are folded into one result', () => {
  const turn = (id: string, lineEnd: number, theta: number, over: Partial<SeedRow> = {}): SeedRow => ({
    id, theta, archivePath: '/seed/archive/session-a.jsonl', lineStart: 100, lineEnd, userMessage: 'how should the zebrafish index be rebuilt', ...over,
  });

  it('vector: one row per turn — the longest snapshot — and the limit is still filled', async () => {
    const db = initDatabase();
    seedExchanges(db, [
      turn('snap-110', 110, 0.10),
      turn('snap-150', 150, 0.12),
      turn('snap-130', 130, 0.11),
      { id: 'other-1', theta: 0.3 },
      { id: 'other-2', theta: 0.4 },
      { id: 'other-3', theta: 0.5 },
    ]);
    db.close();

    const { results, meta } = await searchConversationsDetailed('anything', { mode: 'vector', limit: 3 });
    expect(ids(results)).toEqual(['snap-150', 'other-1', 'other-2']);
    expect(results[0].exchange.lineEnd).toBe(150);
    expect(meta.folded).toBe(2);
  });

  it('keyword: one row per turn', async () => {
    const db = initDatabase();
    seedExchanges(db, [turn('snap-110', 110, 0.1), turn('snap-150', 150, 0.1), turn('snap-130', 130, 0.1), { id: 'other', theta: 0.3, userMessage: 'zebrafish elsewhere' }]);
    db.close();
    const results = await searchConversations('zebrafish', { mode: 'text', limit: 10 });
    expect(ids(results).sort()).toEqual(['other', 'snap-150']);
  });

  it('both: a turn the two passes found through different snapshots is one "both" row', async () => {
    const db = initDatabase();
    seedExchanges(db, [
      // the vector pass (limit 1) sees only the nearest snapshot; the keyword pass sees the one with the word
      turn('snap-110', 110, 0.1, { userMessage: 'how should the index be rebuilt' }),
      turn('snap-150', 150, 1.2, { userMessage: 'how should the index be rebuilt', assistantMessage: 'rebuild it with the zebrafish script' }),
      { id: 'other', theta: 0.5 },
    ]);
    db.close();
    const results = await searchConversations('zebrafish', { mode: 'both', limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].exchange.id).toBe('snap-150');
    expect(results[0].matchedBy).toBe('both');
    expect(results[0].similarity).toBeCloseTo(Math.cos(0.1), 2);
  });

  it('rows of different turns, or of different files, are not folded', async () => {
    const db = initDatabase();
    seedExchanges(db, [
      turn('a-100', 110, 0.1),
      turn('a-200', 210, 0.2, { lineStart: 200 }),
      turn('b-100', 110, 0.3, { archivePath: '/seed/archive/session-b.jsonl' }),
    ]);
    db.close();
    const { results, meta } = await searchConversationsDetailed('anything', { mode: 'vector', limit: 5 });
    expect(ids(results)).toEqual(['a-100', 'a-200', 'b-100']);
    expect(meta.folded).toBe(0);
  });
});

// SQ-13 — 63% of the short summaries on disk are LLM error strings ("Invalid API key · Please run /login")
// or a worker's JSON reply; the search printed them as the conversation's summary.
describe('error-shaped summaries are not shown', () => {
  it('isErrorSummary recognizes the stored failure shapes and leaves real summaries alone', () => {
    for (const bad of [
      'Invalid API key · Please run /login',
      'API Error: Rate limit reached',
      'API Error: 500 {"type":"error","error":{"type":"api_error"}}',
      'Your account does not have access to Claude Code. Please run /login.',
      '```json\n{"has_relation": false}\n```',
      '{"has_relation": true, "relation_type": "SUPPORTS"}',
      '',
      '   ',
    ]) {
      expect(isErrorSummary(bad), bad).toBe(true);
    }
    for (const good of [
      'Built JWT authentication for the React app and fixed a token expiration bug.',
      'Investigated an API error in the billing webhook; the cause was a missing region pin.',
      'Rate limit handling was moved into the retry wrapper.',
      '[No summary: the model declined to summarize this conversation.]',
    ]) {
      expect(isErrorSummary(good), good).toBe(false);
    }
  });

  it('a result carries no summary when the summary file holds an error string', async () => {
    const archive = path.join(tmpDir, 'archive');
    fs.mkdirSync(archive);
    fs.writeFileSync(path.join(archive, 'bad-summary.txt'), 'Invalid API key · Please run /login\n');
    fs.writeFileSync(path.join(archive, 'good-summary.txt'), 'Rebuilt the zebrafish index after the migration.\n');
    const db = initDatabase();
    seedExchanges(db, [
      { id: 'bad', theta: 0.1, archivePath: path.join(archive, 'bad.jsonl') },
      { id: 'good', theta: 0.2, archivePath: path.join(archive, 'good.jsonl') },
    ]);
    db.close();

    const results = await searchConversations('anything', { mode: 'vector', limit: 5 });
    const byId = new Map(results.map((r) => [r.exchange.id, r]));
    expect(byId.get('bad')!.summary).toBeUndefined();
    expect(byId.get('good')!.summary).toBe('Rebuilt the zebrafish index after the migration.');
    const text = await formatResults(results);
    expect(text).not.toContain('Invalid API key');
    expect(text).toContain('Rebuilt the zebrafish index after the migration.');
  });
});

// ROB-12 — a query with no letter or digit, an index that was never built, or an FTS error sent the keyword
// pass to a full LIKE scan of every exchange without a word about it.
describe('the keyword pass says when it fell back to a full LIKE scan', () => {
  const rows: SeedRow[] = [
    { id: 'arrow', theta: 0.1, userMessage: 'what does a -> b mean here' },
    { id: 'plain', theta: 0.2, userMessage: 'the zebrafish migration' },
  ];

  it('a normal keyword query uses the index and adds no note', async () => {
    const db = initDatabase();
    seedExchanges(db, rows);
    db.close();
    const { results, meta } = await searchConversationsDetailed('zebrafish', { mode: 'text', limit: 5 });
    expect(ids(results)).toEqual(['plain']);
    expect(meta.text).toEqual({ path: 'fts', truncated: false });
    expect(await formatResults(results, meta)).not.toMatch(/Note:/);
  });

  it('a query with no searchable token: LIKE scan, reported', async () => {
    const db = initDatabase();
    seedExchanges(db, rows);
    db.close();
    const { results, meta } = await searchConversationsDetailed('->', { mode: 'text', limit: 5 });
    expect(ids(results)).toEqual(['arrow']);
    expect(meta.text).toEqual({ path: 'like-scan', reason: 'the query has no letter or digit to look up in the keyword index', truncated: false });
    expect(await formatResults(results, meta)).toMatch(/Note: Keyword pass ran as a full scan \(the query has no letter or digit/);
  });

  it('an index that was never built: LIKE scan, reported', async () => {
    const db = initDatabase();
    seedExchanges(db, rows);
    db.prepare(`UPDATE fts_meta SET value = '0' WHERE key = 'exchanges_fts_built'`).run();
    db.close();
    const { results, meta } = await searchConversationsDetailed('zebrafish', { mode: 'text', limit: 5 });
    expect(ids(results)).toEqual(['plain']);
    expect(meta.text?.path).toBe('like-scan');
    expect(meta.text?.reason).toMatch(/keyword index has not been built/);
  });

  it('an FTS failure: LIKE scan, with the error in the note and on stderr', async () => {
    const db = initDatabase();
    seedExchanges(db, rows);
    db.close();
    // Make every statement over the keyword index fail on the search connection.
    const searchDb = getSearchDb();
    const realPrepare = searchDb.prepare.bind(searchDb);
    searchDb.prepare = ((sql: string) => {
      if (/exchanges_fts/.test(sql)) throw new Error('fts5: simulated failure in exchanges_fts');
      return realPrepare(sql);
    }) as typeof searchDb.prepare;
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    try {
      const { results, meta } = await searchConversationsDetailed('zebrafish', { mode: 'text', limit: 5 });
      expect(ids(results)).toEqual(['plain']);
      expect(meta.text?.path).toBe('like-scan');
      expect(meta.text?.reason).toMatch(/keyword index query failed: .*exchanges_fts/);
      expect(errors.join('\n')).toMatch(/memory-bank search: keyword index query failed.*exchanges_fts/);
    } finally {
      spy.mockRestore();
      searchDb.prepare = realPrepare;
    }
  });
});

// ONT-07 / SQ-16 — the "Related Knowledge" section of a search printed every neighbour of each fact in full.
describe('related knowledge section is bounded', () => {
  it('clips the fact, lists at most 5 neighbours (contradictions first) and counts the rest', async () => {
    const db = initDatabase();
    const hub = insertFact(db, { fact: 'Hub decision ' + 'h'.repeat(2000), category: 'decision', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: vecAt(0.1) });
    for (let i = 0; i < 9; i++) {
      const neighbour = insertFact(db, { fact: `Neighbour ${i} ` + 'n'.repeat(900), category: 'knowledge', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: vecAt(1.4, 2 + i) });
      createRelation(db, hub, i === 8 ? 'CONTRADICTS' : 'SUPPORTS', neighbour);
    }
    db.close();

    const context = await getKnowledgeContext('anything', null, 3);
    expect(context.facts).toHaveLength(1);
    expect(context.facts[0].fact.length).toBeLessThanOrEqual(KNOWLEDGE_FACT_CHARS);
    expect(context.facts[0].relatedFacts).toHaveLength(5);
    expect(context.facts[0].relatedFacts[0].relationType).toBe('CONTRADICTS');
    expect(context.facts[0].relatedFacts.every((r) => r.fact.length <= 160)).toBe(true);
    expect(context.facts[0].relatedOmitted).toBe(4);

    const text = formatKnowledgeContext(context);
    expect([...text.matchAll(/^  - (SUPPORTS|CONTRADICTS): /gm)]).toHaveLength(5);
    expect(text).toMatch(/…and 4 more related facts/);
    expect(text.length).toBeLessThan(1600);
  });
});

// SQ-15 — unicode61 splits on whitespace, so a Korean word with a particle attached ("검색을") is a
// different token from the bare word ("검색") and an exact-token query misses it.
describe('Korean keyword search matches a word with a particle attached', () => {
  const rows: SeedRow[] = [
    { id: 'ko-particles', theta: 0.1, userMessage: '검색을 개선했다' },
    { id: 'ko-exact', theta: 0.2, userMessage: '검색 개선 계획' },
    { id: 'ko-other', theta: 0.3, userMessage: '임베딩 모델을 바꿨다' },
    { id: 'en-longer', theta: 0.4, userMessage: 'the zebrafish migration' },
  ];

  it('a Hangul query word matches tokens that start with it', async () => {
    const db = initDatabase();
    seedExchanges(db, rows);
    db.close();
    const { results, meta } = await searchConversationsDetailed('검색 개선', { mode: 'text', limit: 10 });
    expect(ids(results).sort()).toEqual(['ko-exact', 'ko-particles']);
    expect(meta.text).toEqual({ path: 'fts', truncated: false });
    expect(ids(await searchConversations('임베딩 모델', { mode: 'text', limit: 10 }))).toEqual(['ko-other']);
  });

  it('a one-character Hangul word and Latin words still match whole tokens only', async () => {
    const db = initDatabase();
    seedExchanges(db, rows);
    db.close();
    expect(await searchConversations('zebra', { mode: 'text', limit: 10 })).toEqual([]);
    expect(ids(await searchConversations('zebrafish', { mode: 'text', limit: 10 }))).toEqual(['en-longer']);
    expect(await searchConversations('검', { mode: 'text', limit: 10 })).toEqual([]);
  });
});
