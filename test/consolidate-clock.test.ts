import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';

vi.mock('../src/llm.js', () => ({
  callHaiku: vi.fn().mockResolvedValue('{}'),
  parseJsonResponse: vi.fn().mockReturnValue({ relation: 'INDEPENDENT', merged_fact: '', reason: 'stub' }),
}));

import { callHaiku } from '../src/llm.js';
import { initDatabase } from '../src/db.js';
import { insertFact, getAllNewFactsSince } from '../src/fact-db.js';
import { consolidateAllPending } from '../src/consolidator.js';

/**
 * The drain walks facts in `(created_at, id)` order and remembers the last one
 * it examined. A fact stamped while the clock was ahead sorts after every fact
 * created since: once the cursor reached it, nothing created at the real time
 * was pending any more — consolidation stopped without a word. The drain now
 * leaves facts dated ahead of the clock alone (until their time comes), so the
 * cursor it hands back never lies ahead of the clock, and says how many it left.
 */

const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

const NOW = new Date('2026-11-10T12:00:00.000Z');
const DAY = 86_400_000;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const SHARED = (() => {
  const v = Array.from({ length: 384 }, (_, i) => Math.sin(i * 7.3) * 0.1);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
})();

describe('facts dated ahead of the clock', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-clock-'));
    process.env.TEST_DB_PATH = path.join(dir, 'test.db');
    db = initDatabase();
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** All facts of one project share a vector: any two of them are a candidate pair. */
  function seed(fact: string, createdAt: string, project: string): string {
    const id = insertFact(db, { fact, category: 'decision', scope_type: 'project', scope_project: project, source_exchange_ids: [], embedding: SHARED });
    db.prepare('UPDATE facts SET created_at = ? WHERE id = ?').run(createdAt, id);
    return id;
  }

  it('getAllNewFactsSince: with a time bound, facts dated after it are not returned', () => {
    const past = seed('Past fact', at(-DAY), '/a');
    const future = seed('Future fact', at(400 * DAY), '/a');
    expect(getAllNewFactsSince(db, null).map((f) => f.id)).toEqual([past, future]);
    expect(getAllNewFactsSince(db, null, 2000, NOW.toISOString()).map((f) => f.id)).toEqual([past]);
    expect(getAllNewFactsSince(db, { createdAt: at(-2 * DAY), id: '' }, 2000, NOW.toISOString()).map((f) => f.id)).toEqual([past]);
    expect(getAllNewFactsSince(db, { createdAt: at(-DAY), id: past }, 2000, NOW.toISOString())).toEqual([]);
  });

  it('the drain compares the facts of the real time, leaves the future-dated ones, and its cursor is not ahead of the clock', async () => {
    seed('Deploys run from main', at(-2 * DAY), '/real');
    const lastReal = seed('Deploys run from the main branch', at(-DAY), '/real');
    seed('Builds use esbuild', at(400 * DAY), '/skewed');
    seed('Builds are made with esbuild', at(400 * DAY + 1000), '/skewed');

    const result = await consolidateAllPending(db, null, { now: NOW });

    // Each of the two real facts is driven once and compared with the other (INDEPENDENT keeps both).
    const prompts = (callHaiku as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[1]));
    expect(prompts).toHaveLength(2);
    expect(prompts.some((p) => p.includes('esbuild')), 'no future-dated fact is driven or compared').toBe(false);
    expect(result.processed).toBe(2);
    expect(result.cursor).toEqual({ createdAt: at(-DAY), id: lastReal });
    expect(result.aheadOfClock, 'the two future-dated facts are counted, not silently dropped').toBe(2);
    expect(Date.parse(result.cursor!.createdAt)).toBeLessThanOrEqual(NOW.getTime());
  });

  it('once the clock reaches them they are compared like any other fact', async () => {
    seed('Builds use esbuild', at(400 * DAY), '/skewed');
    const last = seed('Builds are made with esbuild', at(400 * DAY + 1000), '/skewed');

    const early = await consolidateAllPending(db, null, { now: NOW });
    expect(early.processed).toBe(0);
    expect(early.cursor).toBeNull();
    expect(early.aheadOfClock).toBe(2);

    const later = await consolidateAllPending(db, early.cursor, { now: new Date(NOW.getTime() + 401 * DAY) });
    expect(later.processed).toBe(2);
    expect(later.cursor).toEqual({ createdAt: at(400 * DAY + 1000), id: last });
    expect(later.aheadOfClock).toBe(0);
  });

  it('a cursor pulled back to now stays where it is when nothing is pending — that is what the worker writes back', async () => {
    seed('An old fact', at(-30 * DAY), '/real');
    const clamped = { createdAt: NOW.toISOString(), id: '' };
    const result = await consolidateAllPending(db, clamped, { now: NOW });
    expect(result.processed).toBe(0);
    expect(result.cursor).toEqual(clamped);
  });
});
