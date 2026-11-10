import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { isNoiseExchange, shouldIndexExchange, WARMUP_MESSAGE, OBSERVER_PROMPT_PREFIX } from '../src/noise.js';
import { buildPollutionWhere } from '../src/pollution-predicate.js';
import { WORKER_PROMPT_PREFIXES } from '../src/paths.js';

// Machine noise was 82.6% of one production index (2026-11-10): agent warm-up
// turns and another plugin's observer prompts. The predicate decides what is
// never indexed — and, through its SQL twin, what the purge deletes — so both
// directions are pinned: noise is matched, a person's message is not.

describe('isNoiseExchange', () => {
  it('matches the agent warm-up turn: a SIDECHAIN user message that is exactly the warm-up word', () => {
    expect(isNoiseExchange('Warmup', true)).toBe(true);
    expect(isNoiseExchange('Warmup', 1)).toBe(true);
  });

  it('does not match what a person can write', () => {
    expect(isNoiseExchange('Warmup', false)).toBe(false);          // typed on the main chain
    expect(isNoiseExchange('Warmup', undefined)).toBe(false);
    expect(isNoiseExchange('Warmup 순서 알려줘', true)).toBe(false);  // starts with the word
    expect(isNoiseExchange('warmup', true)).toBe(false);
    expect(isNoiseExchange(' Warmup', true)).toBe(false);
    expect(isNoiseExchange('Warmup\n', true)).toBe(false);
    expect(isNoiseExchange('', true)).toBe(false);
    expect(isNoiseExchange(null, true)).toBe(false);
  });

  it('matches an observer prompt by its exact leading text, on either chain', () => {
    expect(isNoiseExchange(`${OBSERVER_PROMPT_PREFIX}\n<what_happened>Read</what_happened>`, false)).toBe(true);
    expect(isNoiseExchange(OBSERVER_PROMPT_PREFIX, true)).toBe(true);
    expect(isNoiseExchange(`이 태그는 뭐야: ${OBSERVER_PROMPT_PREFIX}`, false)).toBe(false);
    expect(isNoiseExchange(` ${OBSERVER_PROMPT_PREFIX}`, false)).toBe(false);
    expect(isNoiseExchange('<observed_from_primary_session', false)).toBe(false);
  });
});

describe('shouldIndexExchange', () => {
  it('refuses worker prompts and machine noise, accepts everything else', () => {
    expect(shouldIndexExchange({ userMessage: 'How do I deploy this?' })).toBe(true);
    expect(shouldIndexExchange({ userMessage: 'Warmup', isSidechain: false })).toBe(true);
    expect(shouldIndexExchange({ userMessage: 'Warmup', isSidechain: true })).toBe(false);
    expect(shouldIndexExchange({ userMessage: `${OBSERVER_PROMPT_PREFIX} …` })).toBe(false);
    for (const prefix of WORKER_PROMPT_PREFIXES) {
      expect(shouldIndexExchange({ userMessage: `${prefix} rest of the prompt` }), prefix).toBe(false);
    }
    expect(shouldIndexExchange({ userMessage: 'You are an expert developer, please help' })).toBe(true);
  });
});

describe('the SQL twin (purge) selects exactly the rows isNoiseExchange refuses', () => {
  const CASES: Array<{ um: string; sc: number }> = [];
  for (const um of [
    WARMUP_MESSAGE, `${WARMUP_MESSAGE} 순서 알려줘`, ` ${WARMUP_MESSAGE}`, `${WARMUP_MESSAGE}\n`, WARMUP_MESSAGE.toLowerCase(),
    OBSERVER_PROMPT_PREFIX, `${OBSERVER_PROMPT_PREFIX}\n<what_happened>x</what_happened>`, `see ${OBSERVER_PROMPT_PREFIX}`,
    OBSERVER_PROMPT_PREFIX.slice(0, -1), 'an ordinary question', '',
  ]) {
    CASES.push({ um, sc: 0 }, { um, sc: 1 });
  }

  it('warmup + observer families', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE exchanges (id INTEGER PRIMARY KEY, project TEXT, user_message TEXT, is_sidechain BOOLEAN)');
      const ins = db.prepare('INSERT INTO exchanges (id, project, user_message, is_sidechain) VALUES (?, ?, ?, ?)');
      CASES.forEach((c, i) => ins.run(i, '-Users-me-Project-real', c.um, c.sc));

      // drop the always-on slug clause's matches (none here) — every row sits under a real slug
      const { where, params } = buildPollutionWhere({ warmup: true, observer: true });
      const bySql = (db.prepare(`SELECT id FROM exchanges WHERE ${where} ORDER BY id`).all(...params) as Array<{ id: number }>).map((r) => r.id);
      const byPredicate = CASES.map((c, i) => (isNoiseExchange(c.um, c.sc) ? i : -1)).filter((i) => i >= 0);
      expect(bySql).toEqual(byPredicate);
      expect(byPredicate.length).toBe(5); // warm-up on the sidechain + 2 observer texts × 2 chains

      // each family alone
      const only = (o: Parameters<typeof buildPollutionWhere>[0]) => {
        const q = buildPollutionWhere(o);
        return (db.prepare(`SELECT user_message AS um, is_sidechain AS sc FROM exchanges WHERE ${q.where} ORDER BY id`).all(...q.params) as Array<{ um: string; sc: number }>);
      };
      expect(only({ warmup: true })).toEqual([{ um: WARMUP_MESSAGE, sc: 1 }]);
      expect(only({ observer: true }).every((r) => r.um.startsWith(OBSERVER_PROMPT_PREFIX))).toBe(true);
      expect(only({ observer: true })).toHaveLength(4);
      expect(only({})).toEqual([]); // without the flags nothing under a real slug is touched
    } finally {
      db.close();
    }
  });
});

describe('one way into the index', () => {
  const SRC = path.resolve(__dirname, '..', 'src');
  const sources = fs.readdirSync(SRC).filter((f) => f.endsWith('.ts'));
  /** Files of src/ that CALL `name(` (the line declaring it does not count). */
  const callers = (name: string): string[] => sources.filter((f) =>
    fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').some((l) =>
      new RegExp(`(^|[^A-Za-z0-9_.])${name}\\(`).test(l) && !new RegExp(`function ${name}\\(`).test(l) && !l.trim().startsWith('*') && !l.trim().startsWith('//')));

  // sync, the three indexer entry points and repair used to carry five copies of
  // the "embed + insert" loop, each with its own subset of the guards.
  it('insertExchange and generateExchangeEmbedding are called from index-exchanges.ts only', () => {
    expect(callers('insertExchange')).toEqual(['index-exchanges.ts']);
    expect(callers('generateExchangeEmbedding')).toEqual(['index-exchanges.ts']);
  });

  it('every indexing path goes through indexExchanges: sync, indexer (3 entry points), repair', () => {
    expect(callers('indexExchanges')).toEqual(['indexer.ts', 'sync.ts', 'verify.ts']);
    const count = (file: string) => (fs.readFileSync(path.join(SRC, file), 'utf8').match(/await indexExchanges\(/g) ?? []).length;
    expect({ indexer: count('indexer.ts'), sync: count('sync.ts'), verify: count('verify.ts') }).toEqual({ indexer: 3, sync: 1, verify: 1 });
  });

  it('indexExchanges applies shouldIndexExchange before it embeds or writes', () => {
    const body = fs.readFileSync(path.join(SRC, 'index-exchanges.ts'), 'utf8');
    const guard = body.indexOf('shouldIndexExchange(exchange)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('await generateExchangeEmbedding('));
    expect(guard).toBeLessThan(body.indexOf('insertExchange(db'));
  });
});
