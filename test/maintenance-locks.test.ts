import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initDatabase, insertExchange, deleteExchanges, DELETE_BATCH_MAX_MS, DELETE_BATCH_PAUSE_MS, EXCHANGES_FTS_AD_DDL } from '../src/db.js';
import { backupExchangeRows, writeRowBackup } from '../src/row-backup.js';
import { backupExchangesOfPaths, clearConversationIndex, exchangesMissingFromBackup, resetVectorsAndTextIndex, CLEAR_YIELD_EVERY_MS } from '../src/rebuild.js';

/**
 * Maintenance commands (rebuild, snapshot dedupe, prune) must not hold the
 * write lock past the 5s every other process waits for it — a held lock is a
 * failed session-start hook, worker or MCP server somewhere else (review LSO-5).
 *  - A row backup copies under a READ snapshot. It used to take the write lock
 *    for the whole copy: about a minute for 131,380 rows on the measured DB.
 *  - Bulk deletes commit by elapsed time, not only by row count, and pause
 *    between batches: 2,000 rows with their FTS and vector deletes took over
 *    5s per batch, back to back.
 *  - The end of a rebuild resets the vectors and the text index in two
 *    transactions: as one they were the last 5s+ hold of the run.
 */

const EMB = new Array(384).fill(0.01);

describe('maintenance does not sit on the write lock', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-maint-locks-'));
    dbPath = path.join(dir, 'db.sqlite');
    process.env.TEST_DB_PATH = dbPath;
  });
  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const seed = (db: Database.Database, n: number): string[] => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `ex-${i}`;
      insertExchange(db, {
        id, project: 'proj', timestamp: '2026-11-01T00:00:00Z', userMessage: `question ${i}`, assistantMessage: `answer ${i}`,
        archivePath: `/arch/proj/f${i}.jsonl`, lineStart: 1, lineEnd: 2,
        toolCalls: [{ id: `${id}:0`, exchangeId: id, toolName: 'Read', isError: false, timestamp: 't' }],
      }, EMB);
      ids.push(id);
    }
    return ids;
  };

  it('a row backup is written while another connection holds the write lock, and holds what the source held', () => {
    const db = initDatabase();
    const ids = seed(db, 6);
    db.pragma('busy_timeout = 200');
    const writer = new Database(dbPath);
    writer.exec('BEGIN IMMEDIATE');
    // uncommitted in the other connection: not part of what the backup may see
    writer.prepare(`UPDATE exchanges SET user_message = 'changed, not committed' WHERE id = 'ex-0'`).run();
    const backupPath = path.join(dir, 'backups', 'rows.sqlite');
    try {
      const counts = backupExchangeRows(db, ids, backupPath);
      expect(counts).toEqual({ exchanges: 6, toolCalls: 6 });
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
      db.close();
    }
    const bak = new Database(backupPath, { readonly: true });
    try {
      expect(bak.prepare('SELECT user_message AS u FROM exchanges ORDER BY id').all().map((r) => (r as { u: string }).u))
        .toEqual(['question 0', 'question 1', 'question 2', 'question 3', 'question 4', 'question 5']);
    } finally {
      bak.close();
    }
  });

  it('a backup that cannot be written still leaves no half file behind', () => {
    const db = initDatabase();
    seed(db, 2);
    const backupPath = path.join(dir, 'backups', 'bad.sqlite');
    try {
      expect(() => writeRowBackup(db, backupPath, [{ table: 'exchanges', select: 'SELECT * FROM no_such_table' }])).toThrow();
      expect(fs.existsSync(backupPath)).toBe(false);
      // and the connection is usable for the next one
      expect(writeRowBackup(db, backupPath, [{ table: 'exchanges', select: 'SELECT * FROM exchanges' }])).toEqual({ exchanges: 2 });
    } finally {
      db.close();
    }
  });

  it('a row indexed after the backup snapshot is counted as missing from it — the rebuild stops on that instead of clearing it', () => {
    const db = initDatabase();
    try {
      seed(db, 4);
      const paths = ['/arch/proj/f0.jsonl', '/arch/proj/f2.jsonl'];
      const backupPath = path.join(dir, 'backups', 'unreachable.sqlite');
      expect(backupExchangesOfPaths(db, paths, backupPath)).toEqual({ exchanges: 2, toolCalls: 2 });
      expect(exchangesMissingFromBackup(db, paths, backupPath)).toBe(0);

      // another process indexes one more turn of one of those files, and a turn of a file outside them
      insertExchange(db, {
        id: 'late-1', project: 'proj', timestamp: '2026-11-01T00:01:00Z', userMessage: 'later question', assistantMessage: 'later answer',
        archivePath: '/arch/proj/f2.jsonl', lineStart: 3, lineEnd: 4,
      }, EMB);
      insertExchange(db, {
        id: 'elsewhere-1', project: 'proj', timestamp: '2026-11-01T00:01:00Z', userMessage: 'other question', assistantMessage: 'other answer',
        archivePath: '/arch/proj/f3.jsonl', lineStart: 3, lineEnd: 4,
      }, EMB);

      expect(exchangesMissingFromBackup(db, paths, backupPath)).toBe(1);
      // reads only: the backup file and the index are as they were
      expect(db.prepare('SELECT count(*) AS n FROM exchanges').get()).toEqual({ n: 6 });
      expect(db.prepare(`SELECT count(*) AS n FROM pragma_database_list WHERE name = 'bak'`).get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('the last step of a rebuild lets go of the write lock between the vectors and the text index', () => {
    const db = initDatabase();
    const other = new Database(dbPath);
    other.pragma('busy_timeout = 0');
    try {
      seed(db, 3);
      // as a clear leaves it: the text index marked "not built", one row gone without the FTS trigger
      db.prepare(`INSERT OR REPLACE INTO fts_meta(key, value) VALUES('exchanges_fts_built', '0')`).run();
      db.exec('DROP TRIGGER exchanges_fts_ad');
      db.prepare(`DELETE FROM tool_calls WHERE exchange_id = 'ex-0'`).run();
      db.prepare(`DELETE FROM exchanges WHERE id = 'ex-0'`).run();
      db.exec(EXCHANGES_FTS_AD_DDL);
      const seen: Array<Record<string, unknown>> = [];

      const result = resetVectorsAndTextIndex(db, {
        onVectorsReset: () => {
          // a writer that does not wait at all gets the lock here
          other.exec('BEGIN IMMEDIATE');
          other.exec('ROLLBACK');
          seen.push({
            inTransaction: db.inTransaction,
            vectors: (other.prepare('SELECT count(*) AS n FROM vec_exchanges_rowids').get() as { n: number }).n,
            textIndexBuilt: (other.prepare(`SELECT value FROM fts_meta WHERE key = 'exchanges_fts_built'`).get() as { value: string }).value,
          });
        },
      });

      expect(result).toEqual({ vectorsKept: 2 });
      // between the two: the vectors are already those of the rows that are left, the text index is still "not built"
      expect(seen).toEqual([{ inTransaction: false, vectors: 2, textIndexBuilt: '0' }]);
      expect(db.prepare(`SELECT value FROM fts_meta WHERE key = 'exchanges_fts_built'`).get()).toEqual({ value: '1' });
      expect(db.prepare(`SELECT e.id FROM exchanges_fts f JOIN exchanges e ON e.rowid = f.rowid WHERE exchanges_fts MATCH '"question"' ORDER BY e.id`).all())
        .toEqual([{ id: 'ex-1' }, { id: 'ex-2' }]);
    } finally {
      other.close();
      db.close();
    }
  });

  it('a clear leaves gaps for other writers: none is locked out between its batches, and it clears everything', () => {
    // back-to-back batches are one long hold to a process that retries every 100ms: a gap at least this often
    expect(CLEAR_YIELD_EVERY_MS).toBeLessThanOrEqual(2000);
    const db = initDatabase();
    const other = new Database(dbPath);
    other.pragma('busy_timeout = 0');
    try {
      seed(db, 5);
      let otherWrote = 0;
      const cleared = clearConversationIndex(db, {
        batchSize: 2,
        onBatch: () => {
          other.exec('BEGIN IMMEDIATE');
          other.exec('ROLLBACK');
          otherWrote++;
        },
      });
      expect(cleared).toEqual({ exchanges: 5, toolCalls: 5 });
      expect(otherWrote).toBe(6); // 3 tool-call batches + 3 exchange batches
      expect(db.prepare('SELECT count(*) AS n FROM vec_exchanges_rowids').get()).toEqual({ n: 0 });
      expect(db.prepare(`SELECT value FROM fts_meta WHERE key = 'exchanges_fts_built'`).get()).toEqual({ value: '1' });
    } finally {
      other.close();
      db.close();
    }
  });

  it('deleteExchanges commits when a batch has taken its time, not only when it is full', () => {
    expect(DELETE_BATCH_MAX_MS).toBeLessThanOrEqual(1000);
    expect(DELETE_BATCH_PAUSE_MS).toBeGreaterThan(100); // longer than SQLite's longest busy-handler sleep
    const db = initDatabase();
    try {
      const ids = seed(db, 7);
      const batches: number[] = [];
      // a time budget of 0: every row is a batch of its own, whatever the row limit
      expect(deleteExchanges(db, ids, 2000, { maxBatchMs: 0, pauseMs: 0, onBatch: (deleted) => batches.push(deleted) })).toBe(7);
      expect(batches).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(db.prepare('SELECT count(*) AS n FROM exchanges').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM tool_calls').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM vec_exchanges_rowids').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('the row limit still applies, and another writer gets in between two batches', () => {
    const db = initDatabase();
    const other = new Database(dbPath);
    other.pragma('busy_timeout = 0');
    try {
      const ids = seed(db, 6);
      const batches: number[] = [];
      let otherWrote = 0;
      const deleted = deleteExchanges(db, ids, 4, {
        pauseMs: 0,
        onBatch: (n) => {
          batches.push(n);
          // between batches no transaction is open: a writer that does not wait at all gets the lock
          other.exec('BEGIN IMMEDIATE');
          other.exec('ROLLBACK');
          otherWrote++;
        },
      });
      expect(deleted).toBe(6);
      expect(batches).toEqual([4, 6]);
      expect(otherWrote).toBe(2);
    } finally {
      other.close();
      db.close();
    }
  });
});
