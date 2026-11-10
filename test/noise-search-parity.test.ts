import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { NOISE_EXCHANGE_SQL } from '../src/search.js';
import { isNoiseExchange, OBSERVER_PROMPT_PREFIX, WARMUP_MESSAGE } from '../src/noise.js';

/**
 * Two code paths decide "is this turn machine noise": the indexer (isNoiseExchange, noise.ts) and the
 * conversation search (NOISE_EXCHANGE_SQL, search.ts). If they disagree, the search either shows turns the
 * index now refuses or hides turns a person wrote. This runs the SQL condition over a grid of rows and
 * compares each answer with the function's.
 */
describe('noise rule: search SQL ≡ index-time function', () => {
  const messages = [
    WARMUP_MESSAGE,
    `${WARMUP_MESSAGE} `,
    WARMUP_MESSAGE.toLowerCase(),
    `${WARMUP_MESSAGE} 순서 알려줘`,
    OBSERVER_PROMPT_PREFIX,
    `${OBSERVER_PROMPT_PREFIX}\n<what_happened>…`,
    ` ${OBSERVER_PROMPT_PREFIX}`,
    OBSERVER_PROMPT_PREFIX.replace(/_/g, 'x'), // `_` must not act as a wildcard
    'how do I rebuild the index?',
    '',
  ];
  const sidechains: Array<number | null> = [0, 1, null];

  it('gives the same answer for every (message, sidechain) pair', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE exchanges (id INTEGER PRIMARY KEY, user_message TEXT, is_sidechain INTEGER)');
      const insert = db.prepare('INSERT INTO exchanges (user_message, is_sidechain) VALUES (?, ?)');
      const cases: Array<{ message: string; sidechain: number | null }> = [];
      for (const message of messages) for (const sidechain of sidechains) { insert.run(message, sidechain); cases.push({ message, sidechain }); }

      const rows = db.prepare(`SELECT e.user_message AS message, e.is_sidechain AS sidechain, (${NOISE_EXCHANGE_SQL}) AS noise FROM exchanges AS e ORDER BY e.id`).all() as
        Array<{ message: string; sidechain: number | null; noise: number }>;

      expect(rows).toHaveLength(cases.length);
      const disagreements = rows
        .filter((row) => Boolean(row.noise) !== isNoiseExchange(row.message, row.sidechain))
        .map((row) => ({ message: row.message, sidechain: row.sidechain, sql: Boolean(row.noise) }));
      expect(disagreements).toEqual([]);
      // The grid really holds both kinds of noise and real messages (not a vacuous pass).
      expect(rows.filter((row) => row.noise).length).toBeGreaterThanOrEqual(4);
      expect(rows.filter((row) => !row.noise).length).toBeGreaterThanOrEqual(10);
    } finally {
      db.close();
    }
  });
});
