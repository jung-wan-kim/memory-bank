import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';

/**
 * A verdict is applied only to the pair it judged.
 *
 * The comparison call takes seconds, and the write that follows used to trust
 * the two rows read before it. When something else switched one of them off
 * meanwhile (a cleanup script's --apply, another writer), the merge was applied
 * to the switched-off row and the other fact was switched off too: both gone.
 * EVOLUTION even rebuilt a vector row for the inactive fact. The write now
 * checks, inside its transaction, that both facts are still active and still
 * hold the sentences that were judged — otherwise it writes nothing.
 */

const mocks = vi.hoisted(() => {
  const state = { beforeAnswer: null as null | (() => void) };
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
  // The store changes while the call is in flight — once, like another process would do it.
  callHaiku: vi.fn(async () => {
    const change = mocks.state.beforeAnswer;
    mocks.state.beforeAnswer = null;
    change?.();
    return '{}';
  }),
  parseJsonResponse: vi.fn(),
}));
vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn(async (text: string) => mocks.textVector(text)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
}));

import { callHaiku, parseJsonResponse } from '../src/llm.js';
import { initDatabase } from '../src/db.js';
import { insertFact, deactivateFact, updateFact } from '../src/fact-db.js';
import { consolidateAllPending, applyConsolidationResult } from '../src/consolidator.js';
import type { Fact } from '../src/types.js';

const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

const BASE = mocks.textVector('shared starting vector');
const T0 = Date.parse('2026-03-01T00:00:00.000Z');
const day = (n: number) => new Date(T0 + n * 86_400_000).toISOString();

describe('a verdict is applied only to the pair it judged', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-stale-pair-'));
    process.env.TEST_DB_PATH = path.join(dir, 'test.db');
    db = initDatabase();
    vi.clearAllMocks();
    mocks.state.beforeAnswer = null;
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(fact: string, at: string, count = 1): string {
    const id = insertFact(db, {
      fact, category: 'decision', scope_type: 'project', scope_project: '/proj',
      source_exchange_ids: [`ex-${fact.length}`], embedding: BASE, fact_kr: `${fact} (한국어)`, embedding_kr: mocks.textVector(`${fact} (한국어)`),
    });
    db.prepare('UPDATE facts SET created_at = ?, updated_at = ?, consolidated_count = ? WHERE id = ?').run(at, at, count, id);
    return id;
  }
  const verdict = (v: { relation: string; merged_fact: string; reason: string }) => (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue(v);
  /** Everything a merge could touch on a fact. */
  const snapshot = (id: string) => ({
    row: db.prepare('SELECT fact, fact_kr, is_active, consolidated_count, source_exchange_ids, hex(embedding) AS embedding FROM facts WHERE id = ?').get(id),
    vec: (db.prepare('SELECT hex(embedding) AS e FROM vec_facts WHERE id = ?').get(id) as { e: string } | undefined)?.e ?? null,
    vecKr: (db.prepare('SELECT hex(embedding) AS e FROM vec_facts_kr WHERE id = ?').get(id) as { e: string } | undefined)?.e ?? null,
  });
  const active = (id: string) => (db.prepare('SELECT is_active FROM facts WHERE id = ?').get(id) as { is_active: number }).is_active;
  const revisions = () => (db.prepare('SELECT COUNT(*) AS n FROM fact_revisions').get() as { n: number }).n;
  const factOf = (id: string): Fact => {
    const r = db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as Record<string, unknown>;
    return {
      ...(r as unknown as Fact),
      source_exchange_ids: JSON.parse(r.source_exchange_ids as string),
      embedding: r.embedding ? new Float32Array(new Uint8Array(r.embedding as Buffer).buffer) : null,
      is_active: Boolean(r.is_active),
    };
  };

  for (const relation of ['DUPLICATE', 'EVOLUTION'] as const) {
    it(`${relation}: the older fact is switched off while the call is in flight — nothing is written, the later fact stays`, async () => {
      const older = seed('Deploys run from the main branch', day(1), 2);
      const later = seed('Deploys run from release branches', day(2), 3);
      mocks.state.beforeAnswer = () => deactivateFact(db, older);
      verdict({ relation, merged_fact: '', reason: 'r' });

      // Only the older fact is driven: the later one (still active afterwards) would otherwise be compared on its own turn.
      const olderAfterSwitchOff = () => snapshot(older);
      const result = await consolidateAllPending(db, null);

      expect(callHaiku).toHaveBeenCalledTimes(1);
      expect(active(older), 'switched off by the other writer, as it left it').toBe(0);
      expect(active(later), 'the surviving fact must not be switched off for a merge into a dead row').toBe(1);
      expect(olderAfterSwitchOff().row).toMatchObject({ fact: 'Deploys run from the main branch', consolidated_count: 2 });
      expect(olderAfterSwitchOff().vec, 'no vector row is rebuilt for an inactive fact').toBeNull();
      expect(snapshot(later).row).toMatchObject({ fact: 'Deploys run from release branches', consolidated_count: 3, is_active: 1 });
      expect(revisions()).toBe(0);
      expect(result.merged + result.evolutions + result.contradictions, 'not counted as a merge').toBe(0);
      expect(result.changedPairs).toBe(1);
      expect(result.haikuCalls, 'the call was made').toBe(1);
      expect(result.lastError, 'not a failure: the cursor moves on').toBeNull();
      expect(result.processed).toBe(2);
    });
  }

  it('CONTRADICTION: the later fact is switched off while the call is in flight — the older fact is not switched off as well', async () => {
    const older = seed('Sessions are stored in Redis', day(1));
    const later = seed('Sessions moved to Postgres', day(2));
    mocks.state.beforeAnswer = () => deactivateFact(db, later);
    verdict({ relation: 'CONTRADICTION', merged_fact: 'Sessions are stored in Postgres, no longer in Redis', reason: 'r' });
    const before = snapshot(older);

    const result = await consolidateAllPending(db, null);

    expect(active(older)).toBe(1);
    expect(snapshot(older)).toEqual(before);
    expect(active(later)).toBe(0);
    expect(revisions()).toBe(0);
    expect(result.contradictions).toBe(0);
    expect(result.changedPairs).toBe(1);
  });

  it('one of the two sentences is rewritten while the call is in flight: the verdict judged another sentence and is not applied', async () => {
    const older = seed('Cache TTL is 5 minutes', day(1));
    const later = seed('Cache TTL is 15 minutes', day(2));
    mocks.state.beforeAnswer = () => updateFact(db, later, { fact: 'Cache TTL is 15 minutes for images only', embedding: BASE });
    (parseJsonResponse as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ relation: 'DUPLICATE', merged_fact: '', reason: 'same' })      // judged the sentence that is gone
      .mockReturnValue({ relation: 'INDEPENDENT', merged_fact: '', reason: 'narrower' });   // the pair as it is now
    const before = { older: snapshot(older).row, laterCount: 1 };

    const result = await consolidateAllPending(db, null);

    expect(result.changedPairs).toBe(1);
    expect(result.merged, 'the DUPLICATE verdict was about a sentence the fact no longer holds').toBe(0);
    expect(snapshot(older).row).toEqual(before.older);
    expect(active(later)).toBe(1);
    // The later fact's own turn compares the pair again.
    expect(callHaiku).toHaveBeenCalledTimes(2);
  });

  it('an untouched pair is applied as before', async () => {
    const older = seed('Tests run with vitest', day(1));
    const later = seed('Vitest runs the tests', day(2));
    verdict({ relation: 'DUPLICATE', merged_fact: '', reason: 'same' });

    const result = await consolidateAllPending(db, null);

    expect(active(older)).toBe(1);
    expect(active(later)).toBe(0);
    expect(result.merged).toBe(1);
    expect(result.changedPairs).toBe(0);
  });

  it('applyConsolidationResult says whether it wrote, and writes nothing for a pair that changed since it was read', () => {
    const older = seed('Node 20 is the runtime', day(1));
    const later = seed('Node 22 is the runtime', day(2));
    const [o, l] = [factOf(older), factOf(later)];
    deactivateFact(db, older);
    const laterBefore = snapshot(later);

    expect(applyConsolidationResult(db, o, l, { relation: 'DUPLICATE', merged_fact: '', reason: 'same' })).toBe(false);
    expect(snapshot(later)).toEqual(laterBefore);
    expect(revisions()).toBe(0);

    const a = seed('Logs go to stdout', day(3));
    const b = seed('Logs are printed to stdout', day(4));
    expect(applyConsolidationResult(db, factOf(a), factOf(b), { relation: 'DUPLICATE', merged_fact: '', reason: 'same' })).toBe(true);
    expect(active(b)).toBe(0);
    expect(applyConsolidationResult(db, factOf(a), factOf(later), { relation: 'INDEPENDENT', merged_fact: '', reason: 'separate' }), 'nothing to write is not a refusal').toBe(true);
  });
});
