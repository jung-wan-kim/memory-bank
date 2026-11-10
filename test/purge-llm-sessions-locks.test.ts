import { describe, it, expect, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { initDatabase, insertExchange, DELETE_BATCH_MAX_MS } from '../src/db.js';
import { suppressConsole } from './test-utils.js';

/**
 * scripts/purge-llm-sessions.mjs --apply must not sit on the write lock while it deletes.
 *
 * Its own delete loop committed every 2,000 rows and started the next batch at once. On a large index a
 * batch of 2,000 (each row an FTS delete and a vec0 delete) holds the lock for longer than the 5s every
 * other process waits — measured on a copy of a live DB: 25 failed lock waits during one purge. The other
 * maintenance deletes (deleteExchanges) commit after DELETE_BATCH_MAX_MS as well and pause between batches;
 * the purge has to do the same.
 *
 * How this is seen from outside the script: a trigger in the fixture makes every exchange delete slow, so
 * the whole delete takes several times DELETE_BATCH_MAX_MS with far fewer than 2,000 rows. While the
 * script runs, a second connection that does not wait at all (busy_timeout 0) keeps asking for the write
 * lock. A row-count-only batch is one transaction: the writer never gets in before every row is gone.
 *
 * How slow "slow" is depends on the machine and on what else it is doing, so the fixture is not sized by
 * an estimate: a run whose delete was over too quickly to tell the two behaviours apart is run again with
 * twice the rows.
 */

const REPO = path.resolve(__dirname, '..');
const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());
const EMB = new Array(384).fill(0.01);
const HUMAN = 3;
/**
 * Rows of the table the slow trigger cross-joins with itself, once per deleted exchange (600² additions —
 * measured 10-35ms a delete on the machine this was written on, depending on its load).
 */
const SLOW_ROWS = 600;
/** A delete that lasted this long spans several time-bounded batches. */
const LONG_ENOUGH_MS = 5 * DELETE_BATCH_MAX_MS;

interface Observation {
  cfg: string;
  dbPath: string;
  polluted: number;
  status: number | null;
  stdout: string;
  stderr: string;
  /** Exchange counts at which the non-waiting writer held the write lock. */
  writableAt: number[];
  /** Longest time the writer was refused without a break, from the first refusal to the next time it got in. */
  longestRefusedMs: number;
  /** From the last time the lock was free with every row still there to the first time all polluted rows were gone. */
  deleteMs: number;
}

describe('purge-llm-sessions --apply and the write lock', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(dbPath: string, polluted: number): void {
    process.env.TEST_DB_PATH = dbPath;
    const db = initDatabase();
    try {
      db.exec('CREATE TABLE slow_rows (x INTEGER)');
      const add = db.prepare('INSERT INTO slow_rows (x) VALUES (?)');
      db.transaction(() => { for (let i = 0; i < SLOW_ROWS; i++) add.run(i); })();
      db.exec(`CREATE TRIGGER slow_exchange_delete AFTER DELETE ON exchanges BEGIN
        SELECT sum(a.x + b.x) FROM slow_rows a, slow_rows b;
      END`);
      const insert = (id: string, project: string) => insertExchange(db, {
        id, project, timestamp: 't', userMessage: `question ${id}`, assistantMessage: `answer ${id}`,
        archivePath: `/arch/${id}.jsonl`, lineStart: 1, lineEnd: 2,
        toolCalls: [{ id: `${id}:0`, exchangeId: id, toolName: 'Read', isError: false, timestamp: 't' }],
      }, EMB);
      for (let i = 0; i < polluted; i++) insert(`slug-${i}`, '-private-tmp-memory-bank-llm');
      for (let i = 0; i < HUMAN; i++) insert(`human-${i}`, 'proj');
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
      delete process.env.TEST_DB_PATH;
    }
  }

  /** One purge of `polluted` slug-family rows on a fresh database, watched by a writer that never waits. */
  async function purgeWatched(polluted: number): Promise<Observation> {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-purge-locks-'));
    dirs.push(cfg);
    const dbPath = path.join(cfg, 'db.sqlite');
    seed(dbPath, polluted);
    const total = polluted + HUMAN;

    const probe = new Database(dbPath);
    probe.pragma('busy_timeout = 0');
    const count = probe.prepare('SELECT count(*) AS n FROM exchanges');
    const writableAt = new Set<number>();
    let longestRefusedMs = 0;
    let refusedSince: number | null = null;
    let lastFreeWithAllRows = performance.now();
    let allGoneAt: number | null = null;

    const poll = () => {
      const now = performance.now();
      let rows: number;
      try {
        probe.exec('BEGIN IMMEDIATE');
        rows = (count.get() as { n: number }).n;
        probe.exec('ROLLBACK');
        writableAt.add(rows);
        if (rows === total) lastFreeWithAllRows = now;
        if (refusedSince !== null) {
          longestRefusedMs = Math.max(longestRefusedMs, now - refusedSince);
          refusedSince = null;
        }
      } catch (error) {
        if (!/database is locked|SQLITE_BUSY/i.test(String(error))) throw error;
        if (probe.inTransaction) probe.exec('ROLLBACK');
        if (refusedSince === null) refusedSince = now;
        rows = (count.get() as { n: number }).n; // a reader is never refused (WAL)
      }
      if (rows === HUMAN && allGoneAt === null) allGoneAt = now;
    };

    let stdout = '';
    let stderr = '';
    const timer = setInterval(poll, 5);
    let status: number | null;
    try {
      status = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, ['scripts/purge-llm-sessions.mjs', '--apply'], {
          cwd: REPO, env: { ...process.env, MEMORY_BANK_CONFIG_DIR: cfg, MEMORY_BANK_DB_PATH: dbPath },
        });
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', reject);
        child.on('close', resolve);
      });
      poll();
    } finally {
      clearInterval(timer);
      probe.close();
    }
    return {
      cfg, dbPath, polluted, status, stdout, stderr,
      writableAt: [...writableAt].sort((a, b) => b - a),
      longestRefusedMs,
      deleteMs: (allGoneAt ?? performance.now()) - lastFreeWithAllRows,
    };
  }

  it('commits by elapsed time and leaves a gap a non-waiting writer gets into; the result is the same purge', async () => {
    let seen: Observation | undefined;
    for (let polluted = 80; polluted <= 640; polluted *= 2) {
      seen = await purgeWatched(polluted);
      expect(seen.status, seen.stderr + seen.stdout).toBe(0);
      if (seen.deleteMs >= LONG_ENOUGH_MS) break;
    }
    const { cfg, dbPath, polluted, stdout, writableAt, longestRefusedMs, deleteMs } = seen!;
    expect(polluted, 'fewer rows than one row-count batch').toBeLessThan(2000);
    expect(deleteMs, `the fixture could not make the delete of ${polluted} rows slow on this machine`).toBeGreaterThanOrEqual(LONG_ENOUGH_MS);

    // The purge itself: same report, same rows gone, same backup.
    expect(stdout).toMatch(/families: slug\n/);
    expect(stdout).toContain(`polluted exchanges: ${polluted}\n`);
    expect(stdout).toContain(`backed up ${polluted} exchanges to `);
    expect(stdout).toContain(`  deleted ${polluted}/${polluted}\n`);
    expect(stdout).toContain(`left of the ${polluted} worklist ids — exchanges: 0, tool_calls: 0, vectors: 0`);
    const check = new Database(dbPath, { readonly: true });
    try {
      expect(check.prepare('SELECT count(*) AS n FROM exchanges').get()).toEqual({ n: HUMAN });
      expect(check.prepare('SELECT count(*) AS n FROM tool_calls').get()).toEqual({ n: HUMAN });
      expect(check.prepare('SELECT count(*) AS n FROM vec_exchanges_rowids').get()).toEqual({ n: HUMAN });
    } finally {
      check.close();
    }
    const backup = new Database(path.join(cfg, 'conversation-index', 'purge-llm-backup.sqlite'), { readonly: true });
    try {
      expect(backup.prepare('SELECT count(*) AS n FROM exchanges').get()).toEqual({ n: polluted });
      expect(backup.prepare('SELECT count(*) AS n FROM tool_calls').get()).toEqual({ n: polluted });
    } finally {
      backup.close();
    }

    // The lock: with some rows deleted and some still to go, a writer that does not wait got the lock —
    // the batch ended before its row limit, and the next one did not start at once.
    const midway = writableAt.filter((rows) => rows > HUMAN && rows < polluted + HUMAN);
    const what = `delete took ${Math.round(deleteMs)}ms; write lock was free at row counts ${writableAt.join(', ')}`;
    expect(midway.length, what).toBeGreaterThanOrEqual(2);
    // And nobody was kept out for anything like the whole delete — as one transaction that whole time is
    // one refusal — nor for the 5s another process waits before it gives up.
    expect(longestRefusedMs, what).toBeLessThan(Math.min(deleteMs / 2, 5000));
  }, 180_000);
});
