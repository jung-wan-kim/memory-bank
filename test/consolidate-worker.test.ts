import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { insertFact, deactivateFact, insertRevision } from '../src/fact-db.js';

/**
 * scripts/fact-consolidate-worker.js run as the hook runs it: a child process
 * whose only lasting output is the file log and the state files. (It imports
 * dist/, so `npm run build` must have run — `npm test` does that in pretest.)
 *
 * The incident this pins (2026-10-16 ~ 11-10): the candidate search threw
 * before any LLM call, and 2,552 runs left nothing but `processed=0 haiku=1`.
 * The fixture reproduces "the search throws" with a real fault — a corrupt
 * int8 scale record — and no fact has a neighbour, so no LLM is ever called.
 */

const REPO = path.resolve(__dirname, '..');

function vec(seed: number): number[] {
  const v = Array.from({ length: 384 }, (_, i) => Math.sin(seed * 31 + i * 7.3) * 0.1);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

describe('fact-consolidate-worker.js', () => {
  let tmp: string;
  let dbPath: string;
  let ids: string[];

  const indexDir = () => path.join(tmp, 'conversation-index');
  const logLines = () => {
    const file = path.join(indexDir(), 'fact-consolidate.log');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
  };
  const healthFile = () => path.join(indexDir(), 'state', 'fact-consolidate-health.json');
  const health = () => JSON.parse(fs.readFileSync(healthFile(), 'utf8'));
  const cursorFile = () => path.join(indexDir(), 'fact-consolidate-cursor.txt');

  function runWorker(env: Record<string, string> = {}) {
    const childEnv: Record<string, string | undefined> = {
      ...process.env, MEMORY_BANK_CONFIG_DIR: tmp, MEMORY_BANK_DB_PATH: dbPath, ...env,
    };
    delete childEnv.TEST_DB_PATH;
    delete childEnv.LAST_CONSOLIDATED_AT;
    const res = spawnSync(process.execPath, ['scripts/fact-consolidate-worker.js'], {
      cwd: REPO, env: childEnv as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 30_000,
    });
    expect(res.status, res.stderr).toBe(0);
    return res.stdout;
  }
  function withDb(fn: (db: Database.Database) => void) {
    const db = new Database(dbPath);
    try { fn(db); } finally { db.close(); }
  }
  const breakIndex = () => withDb((db) => db.prepare('INSERT OR REPLACE INTO vec_int8_scale (table_name, scale) VALUES (?, ?)').run('vec_facts', -1));
  const repairIndex = () => withDb((db) => db.prepare('DELETE FROM vec_int8_scale WHERE table_name = ?').run('vec_facts'));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-consolidate-worker-'));
    dbPath = path.join(tmp, 't.sqlite');
    const prev = process.env.TEST_DB_PATH;
    process.env.TEST_DB_PATH = dbPath;
    try {
      const db = initDatabase();
      try {
        ids = [1, 3, 6].map((seed, i) => {
          const id = insertFact(db, {
            fact: `Worker fixture fact number ${i} with no neighbour`, category: 'decision',
            scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: vec(seed),
          });
          const at = new Date(Date.parse('2026-06-01T00:00:00.000Z') + i * 1000).toISOString();
          db.prepare('UPDATE facts SET created_at = ? WHERE id = ?').run(at, id);
          return id;
        });
      } finally {
        db.close();
      }
    } finally {
      if (prev === undefined) delete process.env.TEST_DB_PATH; else process.env.TEST_DB_PATH = prev;
    }
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a clean run moves the cursor to the last fact and leaves no error line and no health record', () => {
    runWorker();
    expect(JSON.parse(fs.readFileSync(cursorFile(), 'utf8')).id).toBe(ids[2]);
    expect(logLines()).toEqual([]); // no LLM call, no error — nothing to say
    expect(fs.existsSync(healthFile())).toBe(false);
  }, 40_000);

  it('a run that fails before any LLM call logs the fact, the kind and the message, and starts a health record', () => {
    breakIndex();
    const before = Date.now();
    runWorker();

    expect(logLines()).toEqual([
      `worker: ERROR fact=${ids[0]} kind=internal msg=vec_int8_scale: invalid scale -1 for vec_facts`,
      expect.stringMatching(/^worker: held consecutive_failures=1 since=\S+ next_attempt=next start$/),
    ]);
    const h = health();
    expect(h).toMatchObject({
      consecutiveFailures: 1, factId: ids[0], kind: 'internal',
      message: 'vec_int8_scale: invalid scale -1 for vec_facts', nextAttemptAt: null,
    });
    expect(Date.parse(h.firstFailureAt)).toBeGreaterThanOrEqual(before);
    expect(typeof h.pluginVersion).toBe('string');
    expect(fs.existsSync(cursorFile()), 'the cursor does not move past the failing fact').toBe(false);
  }, 40_000);

  it('after more than five held runs the next starts wait; a repaired index runs once the wait is over and clears the record', () => {
    breakIndex();
    for (let i = 0; i < 6; i++) runWorker();

    expect(logLines().filter((l) => l.startsWith('worker: ERROR fact='))).toHaveLength(6);
    const sixth = health();
    expect(sixth.consecutiveFailures).toBe(6);
    expect(Date.parse(sixth.nextAttemptAt) - Date.parse(sixth.lastFailureAt)).toBe(5 * 60_000);
    expect(logLines().at(-1)).toBe(`worker: held consecutive_failures=6 since=${sixth.firstFailureAt} next_attempt=${sixth.nextAttemptAt}`);

    // Seventh start, inside the wait: nothing runs, nothing is counted, nothing is logged.
    const linesBefore = logLines();
    const out = runWorker();
    expect(out).toContain('fact-consolidate: not run — 6 runs in a row');
    expect(out).toContain(sixth.nextAttemptAt);
    expect(logLines()).toEqual(linesBefore);
    expect(health()).toEqual(sixth);

    // The fault is gone, but the wait still holds for this version…
    repairIndex();
    runWorker();
    expect(health()).toEqual(sixth);
    expect(fs.existsSync(cursorFile())).toBe(false);

    // …until it is over: the run goes through, the cursor moves, the record is removed.
    fs.writeFileSync(healthFile(), JSON.stringify({ ...sixth, nextAttemptAt: new Date(Date.now() - 1000).toISOString() }));
    runWorker();
    expect(JSON.parse(fs.readFileSync(cursorFile(), 'utf8')).id).toBe(ids[2]);
    expect(fs.existsSync(healthFile())).toBe(false);
    expect(logLines()).toEqual(linesBefore);
  }, 60_000);

  it('a wait recorded by another plugin version does not hold this one back', () => {
    breakIndex();
    for (let i = 0; i < 6; i++) runWorker();
    const sixth = health();
    fs.writeFileSync(healthFile(), JSON.stringify({ ...sixth, pluginVersion: '0.0.0-other' }));

    runWorker();

    expect(logLines().filter((l) => l.startsWith('worker: ERROR fact='))).toHaveLength(7);
    expect(health().consecutiveFailures).toBe(7);
  }, 60_000);

  it('a run that dies outside any fact (the database cannot be opened) is counted as fatal', () => {
    const notADb = path.join(tmp, 'a-directory');
    fs.mkdirSync(notADb);
    runWorker({ MEMORY_BANK_DB_PATH: notADb });

    expect(logLines()[0]).toMatch(/^worker: FATAL /);
    expect(health()).toMatchObject({ consecutiveFailures: 1, factId: null, kind: 'fatal' });
  }, 40_000);

  it('a cursor that cannot be written is reported (the next run would silently redo this one)', () => {
    fs.mkdirSync(cursorFile(), { recursive: true }); // a directory where the cursor file belongs
    runWorker();

    expect(logLines()).toEqual([expect.stringMatching(/^worker: cursor not written \(.+\) — the next run repeats this one$/)]);
    expect(fs.existsSync(healthFile()), 'the run itself did not fail').toBe(false);
  }, 40_000);

  it('facts an earlier rewrite left without a Korean sentence get it back once, and the run says so', () => {
    // What a rewrite did before it carried the Korean sentence along: the surviving fact holds the
    // merged-away fact's sentence, with fact_kr NULL and no Korean vector.
    let survivor = '';
    const prev = process.env.TEST_DB_PATH; // initDatabase: the vector tables need sqlite-vec loaded
    process.env.TEST_DB_PATH = dbPath;
    try {
      const db = initDatabase();
      try {
        const seed = (fact: string, factKr: string, seedNo: number, at: string) => {
          const id = insertFact(db, {
            fact, category: 'decision', scope_type: 'project', scope_project: '/restore-fixture',
            source_exchange_ids: [], embedding: vec(seedNo), fact_kr: factKr, embedding_kr: vec(seedNo + 100),
          });
          db.prepare('UPDATE facts SET created_at = ? WHERE id = ?').run(at, id);
          return id;
        };
        survivor = seed('The fixture service listens on port 80', '픽스처 서비스는 80 포트를 쓴다', 11, '2026-05-01T00:00:00.000Z');
        const gone = seed('The fixture service listens on port 8080', '픽스처 서비스는 8080 포트를 쓴다', 15, '2026-05-02T00:00:00.000Z');
        insertRevision(db, {
          fact_id: survivor, previous_fact: 'The fixture service listens on port 80',
          new_fact: 'The fixture service listens on port 8080', reason: 'evolved', source_exchange_id: null,
        });
        db.prepare('UPDATE facts SET fact = ?, fact_kr = NULL WHERE id = ?').run('The fixture service listens on port 8080', survivor);
        db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(survivor);
        deactivateFact(db, gone);
      } finally {
        db.close();
      }
    } finally {
      if (prev === undefined) delete process.env.TEST_DB_PATH; else process.env.TEST_DB_PATH = prev;
    }

    runWorker();

    expect(logLines()).toEqual(['worker: fact_kr restored=1 of 1 rewritten facts without a Korean sentence']);
    withDb((db) => {
      expect((db.prepare('SELECT fact_kr FROM facts WHERE id = ?').get(survivor) as { fact_kr: string }).fact_kr).toBe('픽스처 서비스는 8080 포트를 쓴다');
      expect(db.prepare('SELECT 1 AS present FROM vec_facts_kr_rowids WHERE id = ?').get(survivor)).toEqual({ present: 1 });
    });
    expect(fs.existsSync(path.join(indexDir(), 'state', 'fact-kr-restore.json'))).toBe(true);

    // The same version again: the pass does not run (nothing new in the log).
    runWorker();
    expect(logLines()).toHaveLength(1);
  }, 90_000);

  it('an unusable health record is reported in the log and the count starts over', () => {
    breakIndex();
    fs.mkdirSync(path.dirname(healthFile()), { recursive: true });
    fs.writeFileSync(healthFile(), '{"consecutiveFailures": 40');
    runWorker();

    expect(logLines()[0]).toBe('worker: health record unreadable (not JSON) — the failure count starts over');
    expect(health().consecutiveFailures).toBe(1);
  }, 40_000);
});
