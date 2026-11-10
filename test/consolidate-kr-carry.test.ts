import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';

/**
 * A rewritten fact keeps a Korean sentence that matches its new sentence.
 *
 * Rewriting used to clear fact_kr and the Korean vector and nothing built them
 * again (the only writer of fact_kr was a manual script). Measured on a copy of
 * the live store, 92 real candidate pairs judged EVOLUTION: with the vanished
 * fact's Korean sentence as the query, the fact that took over its sentence was
 * in the top 10 for 92 queries before the rewrite and 26 after it, and passed
 * the injection gate for 92 and 21.
 *
 *  - a sentence taken over verbatim from the other fact of the pair brings that
 *    fact's Korean sentence and Korean vector with it (no LLM, no embedding);
 *  - a sentence the verdict wrote comes with its Korean sentence in the same
 *    response (`merged_fact_kr`), embedded locally;
 *  - when neither exists the Korean sentence is empty — never the old one.
 */

const mocks = vi.hoisted(() => {
  const state = { embedded: [] as string[] };
  /** A unit vector that depends only on the text — distinct texts are near-orthogonal. */
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
  return { state, textVector };
});

vi.mock('../src/llm.js', () => ({
  callHaiku: vi.fn().mockResolvedValue('{}'),
  parseJsonResponse: vi.fn(),
}));
vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn(async (text: string) => {
    mocks.state.embedded.push(text);
    return mocks.textVector(text);
  }),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
}));

import { parseJsonResponse } from '../src/llm.js';
import { initDatabase, getVecQuant, embeddingToVecBlob } from '../src/db.js';
import { insertFact, updateFact, searchSimilarFacts } from '../src/fact-db.js';
import { consolidateAllPending, applyConsolidationResult, CONSOLIDATION_SYSTEM_PROMPT } from '../src/consolidator.js';
import type { Fact } from '../src/types.js';

const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

const BASE = mocks.textVector('shared starting vector');
const T0 = Date.parse('2026-03-01T00:00:00.000Z');
const day = (n: number) => new Date(T0 + n * 86_400_000).toISOString();

interface Seed { fact: string; at: string; factKr?: string; krVector?: boolean }
type Verdict = { relation: string; merged_fact?: string; merged_fact_kr?: unknown; reason: string };

describe('a rewritten fact keeps a Korean sentence of its new sentence', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-kr-carry-'));
    process.env.TEST_DB_PATH = path.join(dir, 'test.db');
    db = initDatabase();
    vi.clearAllMocks();
    mocks.state.embedded = [];
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Every seeded fact shares one main vector (any two are neighbours); the Korean vector is the Korean sentence's own. */
  function seed(s: Seed): string {
    const id = insertFact(db, {
      fact: s.fact, category: 'decision', scope_type: 'project', scope_project: '/proj',
      source_exchange_ids: [], embedding: BASE,
      fact_kr: s.factKr ?? null, embedding_kr: s.factKr && s.krVector !== false ? mocks.textVector(s.factKr) : null,
    });
    db.prepare('UPDATE facts SET created_at = ?, updated_at = ? WHERE id = ?').run(s.at, s.at, id);
    return id;
  }
  const verdict = (v: Verdict) => (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue(v);
  const row = (id: string) => db.prepare('SELECT fact, fact_kr, is_active FROM facts WHERE id = ?')
    .get(id) as { fact: string; fact_kr: string | null; is_active: number };
  const krBlob = (id: string): string | null => {
    const r = db.prepare('SELECT embedding FROM vec_facts_kr WHERE id = ?').get(id) as { embedding: Buffer } | undefined;
    return r ? Buffer.from(r.embedding).toString('hex') : null;
  };
  const krBlobOf = (text: string) => embeddingToVecBlob(mocks.textVector(text), getVecQuant(db, 'vec_facts_kr')).toString('hex');
  /** Ids a Korean query (the sentence's own vector) finds in the project, nearest first. */
  const foundByKorean = (text: string) => searchSimilarFacts(db, mocks.textVector(text), '/proj', 5, 0.85).map((h) => h.fact.id);
  const factOf = (id: string): Fact => {
    const r = db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as Record<string, unknown>;
    return {
      ...(r as unknown as Fact),
      source_exchange_ids: JSON.parse(r.source_exchange_ids as string),
      embedding: r.embedding ? new Float32Array(new Uint8Array(r.embedding as Buffer).buffer) : null,
      is_active: Boolean(r.is_active),
    };
  };

  describe('a sentence taken over verbatim brings its Korean sentence and vector', () => {
    it('EVOLUTION with no merged sentence: the older row gets the later fact\'s fact_kr and Korean vector, and a Korean query finds it', async () => {
      const older = seed({ fact: 'The API is served at v1', at: day(1), factKr: 'API 는 v1 으로 제공한다' });
      const later = seed({ fact: 'The API is served at v2', at: day(2), factKr: 'API 는 v2 로 제공한다' });
      expect(foundByKorean('API 는 v2 로 제공한다'), 'before the merge the later fact answers the Korean query').toEqual([later]);
      verdict({ relation: 'EVOLUTION', merged_fact: '', reason: 'upgraded' });

      const result = await consolidateAllPending(db, null);

      expect(result.evolutions).toBe(1);
      expect(row(later).is_active).toBe(0);
      expect(row(older).fact).toBe('The API is served at v2');
      expect(row(older).fact_kr, 'the Korean sentence of the sentence it now holds').toBe('API 는 v2 로 제공한다');
      expect(krBlob(older)).toBe(krBlobOf('API 는 v2 로 제공한다'));
      expect(krBlob(later), 'the retired fact leaves the index').toBeNull();
      expect(foundByKorean('API 는 v2 로 제공한다'), 'after the merge the surviving fact answers it').toEqual([older]);
      expect(foundByKorean('API 는 v1 으로 제공한다'), 'the old Korean sentence no longer points at it').toEqual([]);
      expect(mocks.state.embedded, 'only the new main sentence is embedded — the Korean vector is moved, not recomputed')
        .toEqual(['The API is served at v2']);
      expect(result.rewrites).toBe(1);
      expect(result.rewritesWithoutKorean).toBe(0);
    });

    it('the later fact has a Korean sentence but no Korean vector row: the sentence is carried and its vector is built', async () => {
      const older = seed({ fact: 'Logs go to stdout', at: day(1), factKr: '로그는 stdout 으로 나간다' });
      seed({ fact: 'Logs go to stderr', at: day(2), factKr: '로그는 stderr 로 나간다', krVector: false });
      verdict({ relation: 'EVOLUTION', merged_fact: '', reason: 'moved' });

      await consolidateAllPending(db, null);

      expect(row(older).fact_kr).toBe('로그는 stderr 로 나간다');
      expect(krBlob(older)).toBe(krBlobOf('로그는 stderr 로 나간다'));
      expect(mocks.state.embedded).toEqual(['Logs go to stderr', '로그는 stderr 로 나간다']);
    });

    it('the later fact has no Korean sentence: the older row is left with none — its old one would describe a sentence it no longer holds', async () => {
      const older = seed({ fact: 'Builds use esbuild', at: day(1), factKr: '빌드는 esbuild 를 쓴다' });
      seed({ fact: 'Builds use rolldown', at: day(2) });
      verdict({ relation: 'EVOLUTION', merged_fact: '', reason: 'bundler change' });

      const result = await consolidateAllPending(db, null);

      expect(row(older).fact).toBe('Builds use rolldown');
      expect(row(older).fact_kr).toBeNull();
      expect(krBlob(older)).toBeNull();
      expect(result.rewrites).toBe(1);
      expect(result.rewritesWithoutKorean, 'counted, so the worker can say so').toBe(1);
    });

    it('a merged sentence that repeats the later fact word for word is a verbatim takeover too', async () => {
      const older = seed({ fact: 'Cache TTL is 5 minutes', at: day(1), factKr: '캐시 TTL 은 5분이다' });
      seed({ fact: 'Cache TTL is 15 minutes', at: day(2), factKr: '캐시 TTL 은 15분이다' });
      verdict({ relation: 'EVOLUTION', merged_fact: 'Cache TTL is 15 minutes', merged_fact_kr: '캐시 TTL 이 15분으로 늘었다', reason: 'tuned' });

      await consolidateAllPending(db, null);

      // The stored translation of that exact sentence wins over the verdict's — it already has a vector.
      expect(row(older).fact_kr).toBe('캐시 TTL 은 15분이다');
      expect(krBlob(older)).toBe(krBlobOf('캐시 TTL 은 15분이다'));
      expect(mocks.state.embedded).toEqual(['Cache TTL is 15 minutes']);
    });
  });

  describe('a sentence the verdict wrote comes with its Korean sentence', () => {
    it('the prompt asks for the Korean sentence in the same response', () => {
      expect(CONSOLIDATION_SYSTEM_PROMPT).toContain('"merged_fact_kr"');
    });

    it('EVOLUTION with merged_fact and merged_fact_kr: both are stored, both are embedded, a Korean query finds the fact', async () => {
      const older = seed({ fact: 'Search uses the MiniLM model', at: day(1), factKr: '검색은 MiniLM 모델을 쓴다' });
      seed({ fact: 'Search switched to the e5 model', at: day(2), factKr: '검색은 e5 모델로 바뀌었다' });
      const merged = 'Search uses the multilingual e5 model (was MiniLM)';
      const mergedKr = '검색은 다국어 e5 모델을 쓴다(이전에는 MiniLM)';
      verdict({ relation: 'EVOLUTION', merged_fact: merged, merged_fact_kr: mergedKr, reason: 'model change' });

      const result = await consolidateAllPending(db, null);

      expect(row(older).fact).toBe(merged);
      expect(row(older).fact_kr).toBe(mergedKr);
      expect(krBlob(older)).toBe(krBlobOf(mergedKr));
      expect(foundByKorean(mergedKr)).toEqual([older]);
      expect(mocks.state.embedded).toEqual([merged, mergedKr]);
      expect(result.rewritesWithoutKorean).toBe(0);
    });

    it('CONTRADICTION with merged_fact and merged_fact_kr: the surviving later fact carries the new Korean sentence', async () => {
      const older = seed({ fact: 'Sessions are stored in Redis', at: day(1), factKr: '세션은 Redis 에 저장한다' });
      const later = seed({ fact: 'Sessions moved to Postgres', at: day(2), factKr: '세션은 Postgres 로 옮겼다' });
      const merged = 'Sessions are stored in Postgres, no longer in Redis';
      const mergedKr = '세션은 이제 Redis 가 아니라 Postgres 에 저장한다';
      verdict({ relation: 'CONTRADICTION', merged_fact: merged, merged_fact_kr: mergedKr, reason: 'storage change' });

      await consolidateAllPending(db, null);

      expect(row(older).is_active).toBe(0);
      expect(row(later).fact).toBe(merged);
      expect(row(later).fact_kr).toBe(mergedKr);
      expect(krBlob(later)).toBe(krBlobOf(mergedKr));
      expect(foundByKorean('세션은 Postgres 로 옮겼다'), 'the replaced Korean sentence is gone from the index').toEqual([]);
    });

    it('a merged sentence without a Korean one leaves fact_kr empty (never the old sentence) and is counted', async () => {
      const older = seed({ fact: 'Deploys run from main', at: day(1), factKr: '배포는 main 에서 한다' });
      seed({ fact: 'Deploys run from release branches', at: day(2), factKr: '배포는 release 브랜치에서 한다' });
      verdict({ relation: 'EVOLUTION', merged_fact: 'Deploys run from release branches (was main)', reason: 'branching' });

      const result = await consolidateAllPending(db, null);

      expect(row(older).fact_kr).toBeNull();
      expect(krBlob(older)).toBeNull();
      expect(result.rewritesWithoutKorean).toBe(1);
    });

    for (const [label, bad] of [
      ['the prompt\'s own slot text', '<merged_fact in natural Korean>'],
      ['punctuation only', '...'],
      ['not a string', 42],
      ['blank', '   '],
    ] as const) {
      it(`merged_fact_kr that is ${label} is treated as absent`, async () => {
        const older = seed({ fact: 'CI runs on push', at: day(1), factKr: 'CI 는 push 마다 돈다' });
        seed({ fact: 'CI runs on pull requests', at: day(2), factKr: 'CI 는 PR 마다 돈다' });
        verdict({ relation: 'EVOLUTION', merged_fact: 'CI runs on pull requests and on push', merged_fact_kr: bad, reason: 'both' });

        const result = await consolidateAllPending(db, null);

        expect(row(older).fact).toBe('CI runs on pull requests and on push');
        expect(row(older).fact_kr).toBeNull();
        expect(krBlob(older)).toBeNull();
        expect(result.rewritesWithoutKorean).toBe(1);
      });
    }

    it('a verdict that rewrites nothing ignores merged_fact_kr (DUPLICATE keeps the surviving fact\'s own Korean sentence)', async () => {
      const older = seed({ fact: 'Tests run with vitest', at: day(1), factKr: '테스트는 vitest 로 돈다' });
      seed({ fact: 'Vitest runs the tests', at: day(2), factKr: '테스트는 vitest 로 실행한다' });
      verdict({ relation: 'DUPLICATE', merged_fact: 'Tests run with vitest', merged_fact_kr: '테스트 러너는 vitest 다', reason: 'same' });

      const result = await consolidateAllPending(db, null);

      expect(row(older).fact_kr).toBe('테스트는 vitest 로 돈다');
      expect(krBlob(older)).toBe(krBlobOf('테스트는 vitest 로 돈다'));
      expect(mocks.state.embedded).toEqual([]);
      expect(result.rewrites).toBe(0);
    });
  });

  describe('applyConsolidationResult / updateFact', () => {
    it('applyConsolidationResult carries the Korean sentence of a verbatim takeover without being given any Korean vector', () => {
      const older = seed({ fact: 'Node 20 is the runtime', at: day(1), factKr: 'Node 20 이 런타임이다' });
      const later = seed({ fact: 'Node 22 is the runtime', at: day(2), factKr: 'Node 22 가 런타임이다' });

      applyConsolidationResult(db, factOf(older), factOf(later), { relation: 'EVOLUTION', merged_fact: '', reason: 'upgrade' },
        { embedding: mocks.textVector('Node 22 is the runtime') });

      expect(row(older).fact_kr).toBe('Node 22 가 런타임이다');
      expect(krBlob(older)).toBe(krBlobOf('Node 22 가 런타임이다'));
    });

    it('updateFact: a changed sentence given with its Korean sentence and vector stores both', () => {
      const id = seed({ fact: 'Retries back off exponentially', at: day(1), factKr: '재시도는 지수 백오프로 한다' });
      const next = 'Retries back off exponentially with jitter';
      const nextKr = '재시도는 지터를 넣은 지수 백오프로 한다';

      updateFact(db, id, { fact: next, embedding: mocks.textVector(next), fact_kr: nextKr, embedding_kr: mocks.textVector(nextKr) });

      expect(row(id).fact_kr).toBe(nextKr);
      expect(krBlob(id)).toBe(krBlobOf(nextKr));
    });

    it('updateFact: a Korean sentence given without its vector removes the old Korean vector (the re-embed worker builds the new one)', () => {
      const id = seed({ fact: 'Uploads are capped at 10 MB', at: day(1), factKr: '업로드는 10MB 로 제한한다' });

      updateFact(db, id, { fact: 'Uploads are capped at 25 MB', embedding: mocks.textVector('Uploads are capped at 25 MB'), fact_kr: '업로드는 25MB 로 제한한다' });

      expect(row(id).fact_kr).toBe('업로드는 25MB 로 제한한다');
      expect(krBlob(id)).toBeNull();
    });

    it('updateFact refuses a Korean sentence that is template residue', () => {
      const id = seed({ fact: 'Imports are sorted', at: day(1), factKr: 'import 는 정렬한다' });
      expect(() => updateFact(db, id, { fact: 'Imports are sorted by path', fact_kr: '...' })).toThrow(/fact_kr/);
      expect(row(id).fact).toBe('Imports are sorted');
      expect(row(id).fact_kr).toBe('import 는 정렬한다');
    });
  });
});
