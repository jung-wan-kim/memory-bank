import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';

vi.mock('../src/llm.js', () => ({
  callHaiku: vi.fn(),
  parseJsonResponse: vi.fn(),
}));

import { callHaiku, parseJsonResponse } from '../src/llm.js';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { consolidateAllPending } from '../src/consolidator.js';

/**
 * What a run reports when a fact's comparison fails.
 *
 * 2026-10-16 ~ 11-10: the candidate search threw before any LLM call, the
 * drain loop counted that as one call, and the worker logged only
 * `processed=0 haiku=1` — 2,552 times, with the error text thrown away. A
 * reader of that log concludes "one LLM call per run"; the real number was 0.
 */

const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

function vec(seed: number): number[] {
  const v = Array.from({ length: 384 }, (_, i) => Math.sin(seed * 31 + i * 7.3) * 0.1);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}
const T0 = Date.parse('2026-05-01T00:00:00.000Z');
const day = (n: number) => new Date(T0 + n * 86_400_000).toISOString();
const INDEPENDENT = { relation: 'INDEPENDENT', merged_fact: '', reason: 'separate' };

describe('consolidateAllPending: failures are reported, and only real LLM calls are counted', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-errors-'));
    process.env.TEST_DB_PATH = path.join(dir, 'test.db');
    db = initDatabase();
    vi.resetAllMocks();
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('{}');
    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue(INDEPENDENT);
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(fact: string, at: string, embedding: number[]): string {
    const id = insertFact(db, { fact, category: 'decision', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding });
    db.prepare('UPDATE facts SET created_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
    return id;
  }
  /** One fact alone, then a pair of neighbours — in creation order. */
  function seedLoneThenPair() {
    const lone = seed('The changelog is written in Korean', day(1), vec(1));
    const first = seed('Hooks must finish within five seconds', day(2), vec(2));
    const second = seed('A hook has a five second time limit', day(3), vec(2));
    return { lone, first, second };
  }
  const calls = () => (callHaiku as ReturnType<typeof vi.fn>).mock.calls.length;

  it('a clean run reports no error', async () => {
    seedLoneThenPair();
    const result = await consolidateAllPending(db, null);
    expect(result.lastError).toBeNull();
    expect(result.processed).toBe(3);
    expect(result.haikuCalls).toBe(calls());
    expect(result.haikuCalls).toBe(2);
  });

  it('an error BEFORE the LLM is reached counts zero calls, names the fact and the message, and holds the cursor', async () => {
    const { lone } = seedLoneThenPair();
    // A real internal fault of the candidate search: the recorded int8 scale is corrupt.
    db.prepare('INSERT OR REPLACE INTO vec_int8_scale (table_name, scale) VALUES (?, ?)').run('vec_facts', -1);
    const since = { createdAt: day(0), id: '' };

    const result = await consolidateAllPending(db, since);

    expect(calls()).toBe(0);
    expect(result.haikuCalls).toBe(0);
    expect(result.processed).toBe(0);
    expect(result.cursor).toEqual(since);
    expect(result.lastError).toEqual({
      factId: lone, kind: 'internal', message: 'vec_int8_scale: invalid scale -1 for vec_facts', held: true,
    });
  });

  it('an internal error AFTER the call still counts that call; facts before it are done and the cursor stops in front of it', async () => {
    const { lone, first } = seedLoneThenPair();
    (parseJsonResponse as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('parser boom'); });

    const result = await consolidateAllPending(db, null);

    expect(calls()).toBe(1);
    expect(result.haikuCalls).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.cursor).toEqual({ createdAt: day(1), id: lone });
    expect(result.lastError).toEqual({ factId: first, kind: 'internal', message: 'parser boom', held: true });
  });

  it('a provider outage is reported as transient and held', async () => {
    const { first } = seedLoneThenPair();
    (callHaiku as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error('503 overloaded'), { status: 503 }));

    const result = await consolidateAllPending(db, null);

    expect(result.haikuCalls).toBe(1);
    expect(result.lastError).toEqual({ factId: first, kind: 'transient', message: '503 overloaded', held: true });
  });

  it('an unrecognized provider error is reported as unknown and held', async () => {
    const { first } = seedLoneThenPair();
    (callHaiku as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('something weird'));

    const result = await consolidateAllPending(db, null);

    expect(result.haikuCalls).toBe(1);
    expect(result.lastError).toEqual({ factId: first, kind: 'unknown', message: 'something weird', held: true });
  });

  it('a per-request rejection is held twice, then skipped — and the skip is still reported, as not held', async () => {
    const { lone, first, second } = seedLoneThenPair();
    (callHaiku as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error('400 prompt too long'), { status: 400 }));

    const run1 = await consolidateAllPending(db, null);
    expect(run1.lastError).toEqual({ factId: first, kind: 'deterministic', message: '400 prompt too long', held: true });
    expect(run1.cursor).toEqual({ createdAt: day(1), id: lone });

    const run2 = await consolidateAllPending(db, run1.cursor);
    expect(run2.lastError).toEqual({ factId: first, kind: 'deterministic', message: '400 prompt too long', held: true });
    expect(run2.processed).toBe(0);

    // Third failure of `first`: skipped (cursor moves past it); `second` then fails for its first time and holds.
    const run3 = await consolidateAllPending(db, run2.cursor);
    expect(run3.processed).toBe(1);
    expect(run3.cursor).toEqual({ createdAt: day(2), id: first });
    expect(run3.lastError).toEqual({ factId: second, kind: 'deterministic', message: '400 prompt too long', held: true });
    expect(run3.haikuCalls).toBe(2);
  });

  it('a skip that ends the run is reported as not held', async () => {
    const lone = seed('The changelog is written in Korean', day(1), vec(1));
    const first = seed('Hooks must finish within five seconds', day(2), vec(2));
    const second = seed('A hook has a five second time limit', day(3), vec(2));
    // `first` has already failed twice; `second` is past the cursor's reach only after `first`.
    db.prepare('UPDATE facts SET consolidation_attempts = 2 WHERE id = ?').run(first);
    (callHaiku as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(Object.assign(new Error('400 prompt too long'), { status: 400 }))
      .mockResolvedValue('{}');

    const result = await consolidateAllPending(db, { createdAt: day(1), id: lone });

    expect(result.processed).toBe(2);
    expect(result.cursor).toEqual({ createdAt: day(3), id: second });
    expect(result.lastError).toEqual({ factId: first, kind: 'deterministic', message: '400 prompt too long', held: false });
  });
});
