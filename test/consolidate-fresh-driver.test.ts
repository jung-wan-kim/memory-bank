import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';

/**
 * A fact is driven with the sentence and vector it holds when its turn comes.
 *
 * The drain read every pending fact once, at the start of the run, and only
 * re-checked "still active?" before each turn. A fact rewritten by an earlier
 * comparison of the same run (CONTRADICTION with a merged sentence rewrites the
 * later fact — which is still to be driven) went to the LLM with the sentence
 * it no longer held, searched its neighbours with the old vector, and its
 * revision recorded the old sentence as `previous_fact`.
 */

const mocks = vi.hoisted(() => {
  const state = { vectors: new Map<string, number[]>() };
  return { state };
});

vi.mock('../src/llm.js', () => ({
  callHaiku: vi.fn().mockResolvedValue('{}'),
  parseJsonResponse: vi.fn(),
}));
vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn(async (text: string) => {
    const v = mocks.state.vectors.get(text);
    if (!v) throw new Error(`no fixture vector for: ${text}`);
    return v;
  }),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
}));

import { callHaiku, parseJsonResponse } from '../src/llm.js';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { consolidateAllPending, consolidateFacts, buildConsolidationPrompt } from '../src/consolidator.js';

const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

// Unit vectors in one plane, `deg` degrees from the first axis: two of them are neighbours
// (similarity >= 0.95) only when they are less than ~18 degrees apart.
const at = (deg: number): number[] => {
  const v = new Array<number>(384).fill(0);
  v[0] = Math.cos((deg * Math.PI) / 180);
  v[1] = Math.sin((deg * Math.PI) / 180);
  return v;
};
const T0 = Date.parse('2026-03-01T00:00:00.000Z');
const day = (n: number) => new Date(T0 + n * 86_400_000).toISOString();

const A = 'Invoices are stored in a MySQL table';
const B = 'Invoices are stored in the Postgres ledger table';
const C = 'Invoices are kept in the Postgres ledger table, partitioned by month';
const MERGED = 'Invoices are stored in the Postgres ledger table (moved from MySQL)';

describe('a fact is driven with what it holds when its turn comes', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-fresh-driver-'));
    process.env.TEST_DB_PATH = path.join(dir, 'test.db');
    db = initDatabase();
    vi.clearAllMocks();
    mocks.state.vectors = new Map();
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(fact: string, deg: number, createdAt: string, scope: 'project' | 'global' = 'project'): string {
    const id = insertFact(db, {
      fact, category: 'decision', scope_type: scope, scope_project: scope === 'project' ? '/billing' : null,
      source_exchange_ids: [], embedding: at(deg),
    });
    db.prepare('UPDATE facts SET created_at = ?, updated_at = ? WHERE id = ?').run(createdAt, createdAt, id);
    return id;
  }
  const row = (id: string) => db.prepare('SELECT fact, is_active FROM facts WHERE id = ?').get(id) as { fact: string; is_active: number };
  const prompts = () => (callHaiku as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[1]));

  it('a fact rewritten earlier in the run is compared with its new sentence, and its revision records that sentence', async () => {
    // A — B are neighbours, B — C are neighbours, A — C are not (0°, 12°, 24°).
    const a = seed(A, 0, day(1));
    const b = seed(B, 12, day(2));
    const c = seed(C, 24, day(3));
    mocks.state.vectors.set(MERGED, at(14)); // the rewritten B stays C's neighbour
    mocks.state.vectors.set(C, at(24));
    (parseJsonResponse as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ relation: 'CONTRADICTION', merged_fact: MERGED, reason: 'moved' })   // A vs B: A off, B rewritten
      .mockReturnValueOnce({ relation: 'EVOLUTION', merged_fact: '', reason: 'refined' });        // B vs C: B takes C's sentence

    const result = await consolidateAllPending(db, null);

    expect(prompts()).toEqual([
      buildConsolidationPrompt(A, B),
      buildConsolidationPrompt(MERGED, C), // not B's original sentence — B holds MERGED by now
    ]);
    expect(row(a).is_active).toBe(0);
    expect(row(b)).toEqual({ fact: C, is_active: 1 });
    expect(row(c).is_active).toBe(0);
    const revisions = db.prepare('SELECT fact_id, previous_fact, new_fact FROM fact_revisions ORDER BY rowid').all();
    expect(revisions).toEqual([
      { fact_id: a, previous_fact: A, new_fact: MERGED },
      { fact_id: b, previous_fact: MERGED, new_fact: C },
    ]);
    expect(result.changedPairs, 'the second verdict is about the stored pair, so it is applied').toBe(0);
    expect(result.contradictions).toBe(1);
    expect(result.evolutions).toBe(1);
  });

  it('its neighbours are searched with the vector of the sentence it holds now', async () => {
    // B's new sentence moves it away from C (12° -> 60°): by its turn, C is no longer a neighbour.
    seed(A, 0, day(1));
    const b = seed(B, 12, day(2));
    const c = seed(C, 24, day(3));
    mocks.state.vectors.set(MERGED, at(60));
    (parseJsonResponse as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ relation: 'CONTRADICTION', merged_fact: MERGED, reason: 'moved' })
      .mockReturnValue({ relation: 'DUPLICATE', merged_fact: '', reason: 'would merge if asked' });

    const result = await consolidateAllPending(db, null);

    expect(prompts(), 'B (old vector) would have found C; B as stored does not').toEqual([buildConsolidationPrompt(A, B)]);
    expect(row(b)).toEqual({ fact: MERGED, is_active: 1 });
    expect(row(c).is_active).toBe(1);
    expect(result.haikuCalls).toBe(1);
    expect(result.processed).toBe(3);
  });

  it('the cursor still ends on the last fact examined, by its creation key', async () => {
    seed(A, 0, day(1));
    seed(B, 12, day(2));
    const c = seed(C, 24, day(3));
    mocks.state.vectors.set(MERGED, at(14));
    (parseJsonResponse as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ relation: 'CONTRADICTION', merged_fact: MERGED, reason: 'moved' })
      .mockReturnValue({ relation: 'INDEPENDENT', merged_fact: '', reason: 'separate' });

    const result = await consolidateAllPending(db, null);

    expect(result.cursor).toEqual({ createdAt: day(3), id: c });
  });

  it('consolidateFacts (the per-project wrapper) reads the driver the same way', async () => {
    seed(A, 0, day(1));
    seed(B, 12, day(2));
    seed(C, 24, day(3));
    mocks.state.vectors.set(MERGED, at(14));
    (parseJsonResponse as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ relation: 'CONTRADICTION', merged_fact: MERGED, reason: 'moved' })
      .mockReturnValue({ relation: 'INDEPENDENT', merged_fact: '', reason: 'separate' });

    await consolidateFacts(db, '/billing', day(0));

    expect(prompts().slice(0, 2)).toEqual([buildConsolidationPrompt(A, B), buildConsolidationPrompt(MERGED, C)]);
  });
});
