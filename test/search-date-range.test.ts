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
import { generateEmbedding } from '../src/embeddings.js';
import { searchConversationsDetailed, searchMultipleConcepts } from '../src/search.js';
import { seedExchanges } from './helpers/search-seed.js';

// R2-SEARCH-4 — the date arguments were checked for their format only. With `after` later than `before` no
// row can pass, but the vector pass still widened its KNN to the sqlite-vec ceiling (12 s on the live index)
// and the answer said the search had been "cut short … narrow the query or relax the date filter".
describe('search: a date range no conversation can be in', () => {
  let tmpDir: string;
  const prevDb = process.env.MEMORY_BANK_DB_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-search-dates-'));
    process.env.MEMORY_BANK_DB_PATH = path.join(tmpDir, 'db.sqlite');
    const db = initDatabase();
    seedExchanges(db, Array.from({ length: 30 }, (_, i) => ({
      id: `row-${i}`, theta: 0.1 + i * 0.01, timestamp: `2026-0${1 + (i % 9)}-15T00:00:00.000Z`, userMessage: `quokka note ${i}`,
    })));
    db.close();
    vi.mocked(generateEmbedding).mockClear();
  });

  afterEach(() => {
    if (prevDb === undefined) delete process.env.MEMORY_BANK_DB_PATH; else process.env.MEMORY_BANK_DB_PATH = prevDb;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('`after` later than `before` is an error that names both, before any pass runs', async () => {
    for (const mode of ['both', 'vector', 'text'] as const) {
      await expect(searchConversationsDetailed('quokka', { mode, after: '2026-10-01', before: '2026-01-01' }))
        .rejects.toThrow(/--after 2026-10-01 is later than --before 2026-01-01/);
    }
    await expect(searchMultipleConcepts(['quokka', 'note'], { after: '2026-10-01', before: '2026-01-01' }))
      .rejects.toThrow(/--after 2026-10-01 is later than --before 2026-01-01/);
    // the query was never embedded: nothing was searched
    expect(vi.mocked(generateEmbedding)).not.toHaveBeenCalled();
  });

  // `before` keeps the days before it (a timestamp of that day sorts after the bare date), so the same day
  // on both sides is empty too — and had the same answer: "cut short".
  it('the same day as `after` and `before` is an error that says how to ask for one day', async () => {
    await expect(searchConversationsDetailed('quokka', { mode: 'vector', after: '2026-03-15', before: '2026-03-15' }))
      .rejects.toThrow(/--after and --before are both 2026-03-15 .*give the following day as --before/);
    expect(vi.mocked(generateEmbedding)).not.toHaveBeenCalled();
    // …and asking that way finds the rows of that day
    const oneDay = await searchConversationsDetailed('quokka', { mode: 'text', limit: 50, after: '2026-03-15', before: '2026-03-16' });
    expect(oneDay.results.length).toBeGreaterThan(0);
    for (const hit of oneDay.results) expect(hit.exchange.timestamp.slice(0, 10)).toBe('2026-03-15');
  });

  it('a range in the right order still filters, and one date alone is not a range', async () => {
    const inRange = await searchConversationsDetailed('quokka', { mode: 'text', limit: 50, after: '2026-03-01', before: '2026-05-01' });
    expect(inRange.results.length).toBeGreaterThan(0);
    for (const hit of inRange.results) {
      expect(hit.exchange.timestamp >= '2026-03-01' && hit.exchange.timestamp <= '2026-05-01').toBe(true);
    }
    expect((await searchConversationsDetailed('quokka', { mode: 'text', limit: 50, after: '2026-08-01' })).results.length).toBeGreaterThan(0);
    expect((await searchConversationsDetailed('quokka', { mode: 'text', limit: 50, before: '2026-02-01' })).results.length).toBeGreaterThan(0);
  });

  it('a date the calendar does not have is refused (it used to roll over into the next month)', async () => {
    for (const [arg, value] of [['after', '2026-02-30'], ['before', '2026-02-30'], ['after', '2026-04-31'], ['before', '2025-02-29']] as const) {
      await expect(searchConversationsDetailed('quokka', { mode: 'text', [arg]: value }))
        .rejects.toThrow(new RegExp(`Invalid --${arg} date: "${value}"\\. Not a valid calendar date`));
    }
    // real dates at the edges are fine
    for (const value of ['2024-02-29', '2026-12-31', '2026-01-01']) {
      await expect(searchConversationsDetailed('quokka', { mode: 'text', after: value })).resolves.toBeDefined();
    }
  });
});
