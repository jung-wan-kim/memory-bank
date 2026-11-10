import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';

/**
 * The SessionStart hook starts the consolidate worker only when it has work:
 * an active fact after the cursor, and no failure backoff running. While
 * consolidation was stuck (2026-10-16 ~ 11-10) every session start launched a
 * worker — up to 839 a day — that opened the 4 GB database to fail on the same
 * fact. (The hook imports dist/: `npm run build` must have run.)
 *
 * The hook runs with MEMORY_BANK_SESSION_START_SPAWN=0 here — no worker is
 * started against the fixture — and reports on stderr what it would have done.
 */

const REPO = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version as string;

describe('fact-consolidate-hook.js: whether the consolidate worker is started', () => {
  let tmp: string;
  let dbPath: string;

  const indexDir = () => path.join(tmp, 'conversation-index');
  const at = (i: number) => new Date(Date.parse('2026-06-01T00:00:00.000Z') + i * 1000).toISOString();

  function seedFacts(n: number): string[] {
    const prev = process.env.TEST_DB_PATH;
    process.env.TEST_DB_PATH = dbPath;
    try {
      const db = initDatabase();
      try {
        return Array.from({ length: n }, (_, i) => {
          const id = insertFact(db, {
            fact: `Hook gate fixture fact number ${i}`, category: 'decision', scope_type: 'project', scope_project: '/tmp/mb-gate-proj',
            source_exchange_ids: [], embedding: null,
          });
          db.prepare('UPDATE facts SET created_at = ? WHERE id = ?').run(at(i), id);
          return id;
        });
      } finally {
        db.close();
      }
    } finally {
      if (prev === undefined) delete process.env.TEST_DB_PATH; else process.env.TEST_DB_PATH = prev;
    }
  }

  function runHook() {
    const env: Record<string, string | undefined> = {
      ...process.env,
      MEMORY_BANK_CONFIG_DIR: tmp,
      MEMORY_BANK_DB_PATH: dbPath,
      MEMORY_BANK_SESSION_START_SPAWN: '0',
      MEMORY_BANK_SESSION_CONTINUITY: '',
      MEMORY_BANK_INTENT_PROFILE: '',
    };
    delete env.TEST_DB_PATH;
    delete env.LAST_CONSOLIDATED_AT;
    const res = spawnSync(process.execPath, ['scripts/fact-consolidate-hook.js'], {
      cwd: REPO, env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ session_id: 'gate-test-0001', cwd: '/tmp/mb-gate-proj', hook_event_name: 'SessionStart' }),
    });
    expect(res.status, res.stderr).toBe(0);
    const decision = res.stderr.split('\n').filter((l) => l.includes('fact-consolidate-worker.js'));
    expect(decision, res.stderr).toHaveLength(1);
    return { decision: decision[0], stdout: res.stdout };
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-consolidate-gate-'));
    dbPath = path.join(tmp, 't.sqlite');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('facts and no cursor yet: the worker is started (and the key facts are still printed)', () => {
    seedFacts(2);
    const { decision, stdout } = runHook();
    expect(decision).toBe('fact-consolidate: would start fact-consolidate-worker.js (pending facts)');
    expect(stdout).toContain('Hook gate fixture fact number 0');
  }, 40_000);

  it('the cursor already stands on the last fact: no worker', () => {
    const ids = seedFacts(2);
    fs.mkdirSync(indexDir(), { recursive: true });
    fs.writeFileSync(path.join(indexDir(), 'fact-consolidate-cursor.txt'), JSON.stringify({ createdAt: at(1), id: ids[1] }));
    const { decision, stdout } = runHook();
    expect(decision).toBe('fact-consolidate: would skip fact-consolidate-worker.js (no pending facts)');
    expect(stdout).toContain('Hook gate fixture fact number 0');
  }, 40_000);

  it('a fact newer than the cursor: the worker is started', () => {
    const ids = seedFacts(2);
    fs.mkdirSync(indexDir(), { recursive: true });
    fs.writeFileSync(path.join(indexDir(), 'fact-consolidate-cursor.txt'), JSON.stringify({ createdAt: at(0), id: ids[0] }));
    expect(runHook().decision).toBe('fact-consolidate: would start fact-consolidate-worker.js (pending facts)');
  }, 40_000);

  it('a failure backoff of this version is running: no worker, even with pending facts', () => {
    seedFacts(2);
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    fs.mkdirSync(path.join(indexDir(), 'state'), { recursive: true });
    const health = {
      firstFailureAt: at(0), lastFailureAt: at(1), consecutiveFailures: 9, factId: 'fact-x', kind: 'internal',
      message: 'boom', nextAttemptAt: until, pluginVersion: VERSION,
    };
    fs.writeFileSync(path.join(indexDir(), 'state', 'fact-consolidate-health.json'), JSON.stringify(health));
    expect(runHook().decision).toBe(`fact-consolidate: would skip fact-consolidate-worker.js (backoff until ${until})`);

    // The same record from another version does not hold this one back.
    fs.writeFileSync(path.join(indexDir(), 'state', 'fact-consolidate-health.json'), JSON.stringify({ ...health, pluginVersion: '0.0.0-other' }));
    expect(runHook().decision).toBe('fact-consolidate: would start fact-consolidate-worker.js (pending facts)');
  }, 60_000);

  it('a backoff time further out than the longest wait (the clock was ahead when it was written) does not keep the worker from starting', () => {
    seedFacts(2);
    fs.mkdirSync(path.join(indexDir(), 'state'), { recursive: true });
    fs.writeFileSync(path.join(indexDir(), 'state', 'fact-consolidate-health.json'), JSON.stringify({
      firstFailureAt: at(0), lastFailureAt: at(1), consecutiveFailures: 9, factId: 'fact-x', kind: 'internal',
      message: 'boom', nextAttemptAt: new Date(Date.now() + 400 * 86_400_000).toISOString(), pluginVersion: VERSION,
    }));
    expect(runHook().decision).toBe('fact-consolidate: would start fact-consolidate-worker.js (pending facts)');
  }, 40_000);

  it('a cursor ahead of the clock starts the worker (which pulls it back) instead of reading as "nothing pending"', () => {
    seedFacts(2);
    const skewed = new Date(Date.now() + 400 * 86_400_000).toISOString();
    fs.mkdirSync(indexDir(), { recursive: true });
    fs.writeFileSync(path.join(indexDir(), 'fact-consolidate-cursor.txt'), JSON.stringify({ createdAt: skewed, id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }));
    expect(runHook().decision).toBe(`fact-consolidate: would start fact-consolidate-worker.js (cursor ${skewed} is ahead of the clock)`);
  }, 40_000);

  it('no database yet: no worker', () => {
    expect(runHook().decision).toBe('fact-consolidate: would skip fact-consolidate-worker.js (no database)');
  }, 40_000);

  it('a check that cannot be made starts the worker (it reports its own failures)', () => {
    // A database file without a facts table: the pending query throws.
    fs.writeFileSync(dbPath, '');
    expect(runHook().decision).toMatch(/^fact-consolidate: would start fact-consolidate-worker\.js \(check failed: .*no such table: facts/);
  }, 40_000);
});
