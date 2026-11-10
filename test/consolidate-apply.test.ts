import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';

/**
 * What a consolidation verdict does to the pair it judged:
 *  - which fact is "existing" and which is "new" follows creation order, not
 *    which one happened to be the driver (a backlog is driven oldest first, so
 *    the nearest neighbour is often the LATER fact);
 *  - a rewritten sentence gets its own vector, and its Korean sentence — a
 *    translation of the old one — is cleared;
 *  - a merge moves the vanishing fact's confirmations and sources to the one
 *    that stays, and either everything is written or nothing is.
 */

const mocks = vi.hoisted(() => {
  const state = { embeddingsModuleLoads: 0, failEmbedding: false, embedded: [] as string[] };
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
// The factory runs when something first imports the module: its run count is
// how the tests see that consolidation loads the embedding model only on demand.
vi.mock('../src/embeddings.js', () => {
  mocks.state.embeddingsModuleLoads++;
  return {
    generateEmbedding: vi.fn(async (text: string) => {
      if (mocks.state.failEmbedding) throw new Error('embedding model unavailable');
      mocks.state.embedded.push(text);
      return mocks.textVector(text);
    }),
    initEmbeddings: vi.fn().mockResolvedValue(undefined),
  };
});

import { callHaiku, parseJsonResponse } from '../src/llm.js';
import { initDatabase, getVecQuant, embeddingToVecBlob } from '../src/db.js';
import { insertFact, updateFact } from '../src/fact-db.js';
import { consolidateAllPending, applyConsolidationResult, buildConsolidationPrompt } from '../src/consolidator.js';
import type { Fact, ConsolidationResult } from '../src/types.js';

const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

const BASE = mocks.textVector('shared starting vector');
const KR = mocks.textVector('공유 한국어 벡터');
const T0 = Date.parse('2026-03-01T00:00:00.000Z');
const day = (n: number) => new Date(T0 + n * 86_400_000).toISOString();

interface Seed { fact: string; at: string; count?: number; sources?: string[]; factKr?: string; project?: string }

describe('applying a consolidation verdict', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-apply-'));
    process.env.TEST_DB_PATH = path.join(dir, 'test.db');
    db = initDatabase();
    vi.clearAllMocks();
    mocks.state.failEmbedding = false;
    mocks.state.embedded = [];
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Every seeded fact shares one vector, so any two in a scope are neighbours whatever their text. */
  function seed(s: Seed): string {
    const id = insertFact(db, {
      fact: s.fact, category: 'decision',
      scope_type: 'project', scope_project: s.project ?? '/proj',
      source_exchange_ids: s.sources ?? [], embedding: BASE,
      fact_kr: s.factKr ?? null, embedding_kr: s.factKr ? KR : null,
    });
    db.prepare('UPDATE facts SET created_at = ?, updated_at = ?, consolidated_count = ? WHERE id = ?').run(s.at, s.at, s.count ?? 1, id);
    return id;
  }
  const verdict = (v: ConsolidationResult) => (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue(v);
  const row = (id: string) => db.prepare(
    'SELECT fact, fact_kr, is_active, consolidated_count, source_exchange_ids, embedding FROM facts WHERE id = ?'
  ).get(id) as { fact: string; fact_kr: string | null; is_active: number; consolidated_count: number; source_exchange_ids: string; embedding: Buffer };
  const vecBlob = (table: 'vec_facts' | 'vec_facts_kr', id: string): string | null => {
    const r = db.prepare(`SELECT embedding FROM ${table} WHERE id = ?`).get(id) as { embedding: Buffer } | undefined;
    return r ? Buffer.from(r.embedding).toString('hex') : null;
  };
  const expectedBlob = (table: 'vec_facts' | 'vec_facts_kr', v: number[]) => embeddingToVecBlob(v, getVecQuant(db, table)).toString('hex');
  const float32 = (v: number[]) => Buffer.from(new Float32Array(v).buffer).toString('hex');
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

  // MUST stay the first test of this file: the mocked module's factory runs once per
  // file, on the first import — a test before this one that rewrites a sentence would
  // load it and the first expectation below would fail.
  it('the embedding module is imported only when a verdict rewrites a sentence', async () => {
    seed({ fact: 'Tests run with vitest', at: day(1) });
    seed({ fact: 'Vitest runs the tests', at: day(2) });
    verdict({ relation: 'DUPLICATE', merged_fact: '', reason: 'same' });
    const first = await consolidateAllPending(db, null);
    expect(first.merged).toBe(1);
    expect(mocks.state.embeddingsModuleLoads, 'a run that rewrites nothing must not load the model').toBe(0);

    seed({ fact: 'The API is served at v1', at: day(3), project: '/other' });
    seed({ fact: 'The API is served at v2', at: day(4), project: '/other' });
    verdict({ relation: 'EVOLUTION', merged_fact: 'The API is served at v2 (was v1)', reason: 'upgraded' });
    const second = await consolidateAllPending(db, first.cursor);
    expect(second.evolutions).toBe(1);
    expect(mocks.state.embeddingsModuleLoads, 'loaded for the rewrite').toBe(1);
    expect(mocks.state.embedded).toEqual(['The API is served at v2 (was v1)']);
  });

  describe('direction: the older fact is "existing", the later one is "new"', () => {
    // The backlog is driven oldest first: the OLDER fact is the driver and its
    // nearest neighbour is the LATER one — the case the old code read backwards.
    it('CONTRADICTION deactivates the older fact, not the later one', async () => {
      const older = seed({ fact: 'State lives in Zustand stores', at: day(1) });
      const later = seed({ fact: 'State moved to React Context', at: day(2) });
      verdict({ relation: 'CONTRADICTION', merged_fact: '', reason: 'replaced' });

      const result = await consolidateAllPending(db, null);

      expect(prompts()).toEqual([buildConsolidationPrompt('State lives in Zustand stores', 'State moved to React Context')]);
      expect(row(older).is_active).toBe(0);
      expect(row(later).is_active).toBe(1);
      expect(row(later).fact).toBe('State moved to React Context');
      expect(result.contradictions).toBe(1);
    });

    it('EVOLUTION with no merged sentence keeps the LATER sentence (on the older row) and retires the later row', async () => {
      const older = seed({ fact: 'The API is served at v1', at: day(1) });
      const later = seed({ fact: 'The API is served at v2', at: day(2) });
      verdict({ relation: 'EVOLUTION', merged_fact: '', reason: 'upgraded' });

      await consolidateAllPending(db, null);

      expect(prompts()).toEqual([buildConsolidationPrompt('The API is served at v1', 'The API is served at v2')]);
      expect(row(older).is_active).toBe(1);
      expect(row(older).fact).toBe('The API is served at v2');
      expect(row(later).is_active).toBe(0);
      const rev = db.prepare('SELECT fact_id, previous_fact, new_fact FROM fact_revisions').all();
      expect(rev).toEqual([{ fact_id: older, previous_fact: 'The API is served at v1', new_fact: 'The API is served at v2' }]);
    });

    it('DUPLICATE keeps the older row', async () => {
      const older = seed({ fact: 'Exports are named exports only', at: day(1) });
      const later = seed({ fact: 'Only named exports are used', at: day(2) });
      verdict({ relation: 'DUPLICATE', merged_fact: '', reason: 'same' });

      await consolidateAllPending(db, null);

      expect(row(older).is_active).toBe(1);
      expect(row(later).is_active).toBe(0);
    });

    it('the same creation time is ordered by id', async () => {
      const a = seed({ fact: 'Logs are written as JSON lines', at: day(1) });
      const b = seed({ fact: 'Logs are JSON lines on stderr', at: day(1) });
      const [first, second] = [a, b].sort();
      verdict({ relation: 'CONTRADICTION', merged_fact: '', reason: 'replaced' });

      await consolidateAllPending(db, null);

      expect(prompts()).toEqual([buildConsolidationPrompt(row(first).fact, row(second).fact)]);
      expect(row(first).is_active).toBe(0);
      expect(row(second).is_active).toBe(1);
    });

    it('a driver that IS the later fact still reads the same way round', async () => {
      const older = seed({ fact: 'Deploys run from the main branch', at: day(1) });
      const later = seed({ fact: 'Deploys run from release branches', at: day(2) });
      verdict({ relation: 'CONTRADICTION', merged_fact: '', reason: 'replaced' });

      // The cursor sits between the two: only the later fact is driven.
      await consolidateAllPending(db, { createdAt: day(1), id: older });

      expect(prompts()).toEqual([buildConsolidationPrompt('Deploys run from the main branch', 'Deploys run from release branches')]);
      expect(row(older).is_active).toBe(0);
      expect(row(later).is_active).toBe(1);
    });
  });

  describe('a rewritten sentence gets its own vector; its Korean sentence is cleared', () => {
    it('no rewrite (DUPLICATE, INDEPENDENT): nothing is embedded, vectors and fact_kr stay', async () => {
      const older = seed({ fact: 'Tests run with vitest', at: day(1), factKr: '테스트는 vitest 로 돈다' });
      seed({ fact: 'Vitest runs the tests', at: day(2), factKr: '테스트는 vitest 로 실행한다' });
      seed({ fact: 'Releases are tagged by hand', at: day(3), project: '/other' });
      seed({ fact: 'Release tags are created manually', at: day(4), project: '/other' });
      (parseJsonResponse as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce({ relation: 'DUPLICATE', merged_fact: 'Tests run with vitest (merged)', reason: 'same' })
        .mockReturnValue({ relation: 'INDEPENDENT', merged_fact: '', reason: 'separate' });

      const result = await consolidateAllPending(db, null);

      expect(result.merged).toBe(1);
      expect(mocks.state.embedded).toEqual([]);
      expect(row(older).fact).toBe('Tests run with vitest');
      expect(row(older).fact_kr).toBe('테스트는 vitest 로 돈다');
      expect(row(older).embedding.toString('hex')).toBe(float32(BASE));
      expect(vecBlob('vec_facts', older)).toBe(expectedBlob('vec_facts', BASE));
      expect(vecBlob('vec_facts_kr', older)).toBe(expectedBlob('vec_facts_kr', KR));
    });

    it('EVOLUTION: the stored embedding and the index row are the new sentence\'s vector; fact_kr and its vector are gone', async () => {
      const older = seed({ fact: 'Search uses the MiniLM model', at: day(1), factKr: '검색은 MiniLM 모델을 쓴다' });
      const later = seed({ fact: 'Search switched to the e5 model', at: day(2), factKr: '검색은 e5 모델로 바뀌었다' });
      const merged = 'Search uses the multilingual e5 model (was MiniLM)';
      verdict({ relation: 'EVOLUTION', merged_fact: merged, reason: 'model change' });

      const result = await consolidateAllPending(db, null);

      expect(result.evolutions).toBe(1);
      expect(mocks.state.embedded).toEqual([merged]);
      expect(row(older).fact).toBe(merged);
      expect(row(older).embedding.toString('hex')).toBe(float32(mocks.textVector(merged)));
      expect(vecBlob('vec_facts', older)).toBe(expectedBlob('vec_facts', mocks.textVector(merged)));
      expect(vecBlob('vec_facts', older)).not.toBe(expectedBlob('vec_facts', BASE));
      expect(row(older).fact_kr).toBeNull();
      expect(vecBlob('vec_facts_kr', older)).toBeNull();
      expect(row(later).is_active).toBe(0);
    });

    it('CONTRADICTION with a merged sentence: the surviving later fact is re-embedded and its fact_kr cleared', async () => {
      const older = seed({ fact: 'Sessions are stored in Redis', at: day(1), factKr: '세션은 Redis 에 저장한다' });
      const later = seed({ fact: 'Sessions moved to Postgres', at: day(2), factKr: '세션은 Postgres 로 옮겼다' });
      const merged = 'Sessions are stored in Postgres, no longer in Redis';
      verdict({ relation: 'CONTRADICTION', merged_fact: merged, reason: 'storage change' });

      await consolidateAllPending(db, null);

      expect(row(older).is_active).toBe(0);
      expect(row(later).fact).toBe(merged);
      expect(row(later).embedding.toString('hex')).toBe(float32(mocks.textVector(merged)));
      expect(vecBlob('vec_facts', later)).toBe(expectedBlob('vec_facts', mocks.textVector(merged)));
      expect(row(later).fact_kr).toBeNull();
      expect(vecBlob('vec_facts_kr', later)).toBeNull();
    });

    it('a merged sentence equal to the stored one is not a rewrite: vector and fact_kr stay', async () => {
      const older = seed({ fact: 'CI runs on every push', at: day(1), factKr: 'CI 는 push 마다 돈다' });
      seed({ fact: 'CI is triggered per push', at: day(2) });
      verdict({ relation: 'EVOLUTION', merged_fact: 'CI runs on every push', reason: 'same sentence' });

      await consolidateAllPending(db, null);

      expect(mocks.state.embedded).toEqual([]);
      expect(row(older).fact_kr).toBe('CI 는 push 마다 돈다');
      expect(vecBlob('vec_facts', older)).toBe(expectedBlob('vec_facts', BASE));
      expect(vecBlob('vec_facts_kr', older)).toBe(expectedBlob('vec_facts_kr', KR));
    });

    it('when the new sentence cannot be embedded nothing is written and the cursor holds on that fact', async () => {
      const older = seed({ fact: 'Builds use esbuild', at: day(1), factKr: '빌드는 esbuild 를 쓴다' });
      const later = seed({ fact: 'Builds moved to rolldown', at: day(2) });
      verdict({ relation: 'EVOLUTION', merged_fact: 'Builds use rolldown (was esbuild)', reason: 'bundler change' });
      mocks.state.failEmbedding = true;

      const result = await consolidateAllPending(db, null);

      expect(result.cursor).toBeNull();
      expect(result.processed).toBe(0);
      expect(result.haikuCalls, 'the comparison call was made').toBe(1);
      expect(result.lastError).toEqual({ factId: older, kind: 'internal', message: 'embedding model unavailable', held: true });
      expect(row(older).fact).toBe('Builds use esbuild');
      expect(row(older).fact_kr).toBe('빌드는 esbuild 를 쓴다');
      expect(row(later).is_active).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM fact_revisions').get() as { n: number }).n).toBe(0);
    });

    it('applyConsolidationResult refuses to rewrite a fact that has a vector without the new sentence\'s vector', () => {
      const older = seed({ fact: 'Cache TTL is 5 minutes', at: day(1) });
      const later = seed({ fact: 'Cache TTL is 15 minutes', at: day(2) });

      expect(() => applyConsolidationResult(db, factOf(older), factOf(later), {
        relation: 'EVOLUTION', merged_fact: 'Cache TTL is 15 minutes (was 5)', reason: 'tuned',
      })).toThrow(/embedding of the new sentence/);
      expect(row(older).fact).toBe('Cache TTL is 5 minutes');
      expect(row(later).is_active).toBe(1);
    });

    it('updateFact: a changed sentence clears fact_kr and its vector; the same sentence keeps them', () => {
      const id = seed({ fact: 'Retries back off exponentially', at: day(1), factKr: '재시도는 지수 백오프로 한다' });

      updateFact(db, id, { fact: 'Retries back off exponentially', consolidated_count_increment: true });
      expect(row(id).fact_kr).toBe('재시도는 지수 백오프로 한다');
      expect(vecBlob('vec_facts_kr', id)).toBe(expectedBlob('vec_facts_kr', KR));

      const next = 'Retries back off exponentially with jitter';
      updateFact(db, id, { fact: next, embedding: mocks.textVector(next) });
      expect(row(id).fact_kr).toBeNull();
      expect(vecBlob('vec_facts_kr', id)).toBeNull();
      expect(vecBlob('vec_facts', id)).toBe(expectedBlob('vec_facts', mocks.textVector(next)));
    });
  });

  describe('a merge carries the vanishing fact\'s confirmations and sources, atomically', () => {
    it('DUPLICATE: the survivor gains the removed fact\'s count and the union of the sources', () => {
      const older = seed({ fact: 'Commits are squashed on merge', at: day(1), count: 2, sources: ['ex-1', 'ex-2'] });
      const later = seed({ fact: 'Merges squash the commits', at: day(2), count: 3, sources: ['ex-2', 'ex-3'] });

      applyConsolidationResult(db, factOf(older), factOf(later), { relation: 'DUPLICATE', merged_fact: '', reason: 'same' });

      expect(row(older).consolidated_count).toBe(5);
      expect(JSON.parse(row(older).source_exchange_ids)).toEqual(['ex-1', 'ex-2', 'ex-3']);
      expect(row(later).is_active).toBe(0);
    });

    it('EVOLUTION: same carry-over, together with the rewrite', () => {
      const older = seed({ fact: 'Node 20 is the runtime', at: day(1), count: 4, sources: ['ex-a'] });
      const later = seed({ fact: 'Node 22 is the runtime', at: day(2), count: 3, sources: ['ex-b'] });
      const merged = 'Node 22 is the runtime (upgraded from 20)';

      applyConsolidationResult(db, factOf(older), factOf(later),
        { relation: 'EVOLUTION', merged_fact: merged, reason: 'upgrade' }, { embedding: mocks.textVector(merged) });

      expect(row(older).fact).toBe(merged);
      expect(row(older).consolidated_count).toBe(7);
      expect(JSON.parse(row(older).source_exchange_ids)).toEqual(['ex-a', 'ex-b']);
      expect(row(later).is_active).toBe(0);
    });

    for (const relation of ['DUPLICATE', 'EVOLUTION', 'CONTRADICTION'] as const) {
      it(`${relation}: a failure halfway leaves no trace (count, sentence, revision, vectors)`, () => {
        const older = seed({ fact: 'Feature flags live in the config file', at: day(1), count: 2, sources: ['ex-1'], factKr: '기능 플래그는 설정 파일에 있다' });
        const later = seed({ fact: 'Feature flags moved to the database', at: day(2), count: 3, sources: ['ex-2'] });
        const merged = 'Feature flags live in the database (moved from the config file)';
        // The LAST write of every relation: fail it after the earlier ones went through.
        const lastWrite = relation === 'CONTRADICTION'
          ? `CREATE TRIGGER fail_last BEFORE UPDATE OF fact ON facts BEGIN SELECT RAISE(ABORT, 'injected failure'); END`
          : `CREATE TRIGGER fail_last BEFORE UPDATE OF is_active ON facts WHEN NEW.is_active = 0 BEGIN SELECT RAISE(ABORT, 'injected failure'); END`;
        db.exec(lastWrite);
        const before = {
          older: row(older), later: row(later),
          vec: vecBlob('vec_facts', older), vecKr: vecBlob('vec_facts_kr', older), vecLater: vecBlob('vec_facts', later),
        };

        expect(() => applyConsolidationResult(db, factOf(older), factOf(later),
          { relation, merged_fact: merged, reason: 'r' }, { embedding: mocks.textVector(merged) })).toThrow(/injected failure/);

        expect({
          older: row(older), later: row(later),
          vec: vecBlob('vec_facts', older), vecKr: vecBlob('vec_facts_kr', older), vecLater: vecBlob('vec_facts', later),
        }).toEqual(before);
        expect((db.prepare('SELECT COUNT(*) AS n FROM fact_revisions').get() as { n: number }).n).toBe(0);
      });
    }
  });
});
