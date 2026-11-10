import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { initDatabase, EXCHANGE_TURN_INDEX } from '../src/db.js';
import { planSnapshotDedupe, applySnapshotDedupe } from '../src/snapshot-dedupe.js';
import { suppressConsole } from './test-utils.js';

// The one-time cleanup of duplicate snapshots of a turn (rows an older build
// left behind). It deletes rows and rewrites fact sources, so: dry run first
// and read-only, backup before any change, and facts never left pointing at a
// deleted row.

const REPO = path.resolve(__dirname, '..');
const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

let cfg: string;
let dbPath: string;

/**
 * Rows the way an older build left them: written straight to the tables (the
 * current insertExchange would remove the shorter snapshots as it goes).
 *   a.jsonl line 1 → 3 snapshots (ends 2, 4, 9)   keep a1-9
 *   a.jsonl line 10 → 1 row                        untouched
 *   b.jsonl line 1 → 2 snapshots (ends 2, 3)       keep b1-3
 */
function seed(): void {
  process.env.TEST_DB_PATH = dbPath;
  const db = initDatabase();
  try {
    const ex = db.prepare(`INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, last_indexed, embedding_version)
      VALUES (?, 'proj', 't', ?, ?, ?, ?, ?, ?, 3)`);
    const vec = db.prepare('INSERT INTO vec_exchanges (id, embedding) VALUES (?, vec_int8(?))');
    const tool = db.prepare(`INSERT INTO tool_calls (id, exchange_id, tool_name, timestamp) VALUES (?, ?, 'Read', 't')`);
    const add = (id: string, file: string, start: number, end: number) => {
      ex.run(id, `question at ${file}:${start}`, `answer up to line ${end}`, `/arch/${file}`, start, end, end);
      vec.run(id, Buffer.from(new Int8Array(384).fill(1).buffer));
      tool.run(`${id}:0`, id);
    };
    add('a1-2', 'a.jsonl', 1, 2);
    add('a1-9', 'a.jsonl', 1, 9);
    add('a1-4', 'a.jsonl', 1, 4);
    add('a10-11', 'a.jsonl', 10, 11);
    add('b1-2', 'b.jsonl', 1, 2);
    add('b1-3', 'b.jsonl', 1, 3);
    const fact = db.prepare(`INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at) VALUES (?, ?, 'decision', 'global', ?, 't', 'u')`);
    fact.run('f-stale', 'a fact from a short snapshot', JSON.stringify(['a1-2', 'a10-11']));
    fact.run('f-both', 'a fact naming two snapshots of one turn', JSON.stringify(['a1-4', 'a1-9', 'b1-2']));
    fact.run('f-clean', 'a fact from rows that stay', JSON.stringify(['a1-9', 'a10-11']));
    fact.run('f-broken', 'a fact with unreadable sources', 'not json');
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
    delete process.env.TEST_DB_PATH;
  }
}

const open = () => { process.env.TEST_DB_PATH = dbPath; try { return initDatabase(); } finally { delete process.env.TEST_DB_PATH; } };
const idsOf = (db: Database.Database, table: string) =>
  (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
const sources = (db: Database.Database) =>
  Object.fromEntries((db.prepare('SELECT id, source_exchange_ids AS s FROM facts ORDER BY id').all() as Array<{ id: string; s: string }>).map((r) => [r.id, r.s]));

beforeEach(() => {
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-dedupe-'));
  dbPath = path.join(cfg, 'db.sqlite');
  seed();
});
afterEach(() => {
  fs.rmSync(cfg, { recursive: true, force: true });
});

describe('planSnapshotDedupe', () => {
  it('counts turns, extra rows, files and affected facts — on a read-only connection', () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(planSnapshotDedupe(db)).toEqual({
        turns: 2, extraRows: 3, files: 2, maxRowsPerTurn: 3, factsToRewrite: 2, factsWithInvalidSources: 1,
      });
    } finally {
      db.close();
    }
  });
});

describe('applySnapshotDedupe', () => {
  it('keeps the fullest snapshot of each turn, removes the others with their vectors and tool calls, and re-points facts', () => {
    const db = open();
    const backupPath = path.join(cfg, 'backup.sqlite');
    try {
      const before = sources(db);
      const result = applySnapshotDedupe(db, backupPath);
      expect(result).toMatchObject({ deletedRows: 3, rewrittenFacts: 2, remainingExtraRows: 0, backupPath });

      expect(idsOf(db, 'exchanges')).toEqual(['a1-9', 'a10-11', 'b1-3']);
      expect(idsOf(db, 'vec_exchanges_rowids')).toEqual(['a1-9', 'a10-11', 'b1-3']);
      expect(idsOf(db, 'tool_calls')).toEqual(['a1-9:0', 'a10-11:0', 'b1-3:0']);
      expect(sources(db)).toEqual({
        'f-stale': JSON.stringify(['a1-9', 'a10-11']),
        'f-both': JSON.stringify(['a1-9', 'b1-3']), // two snapshots of one turn collapse to one id
        'f-clean': before['f-clean'],
        'f-broken': 'not json',
      });
      // every id a fact names now exists
      const named = new Set(Object.values(sources(db)).filter((s) => s.startsWith('[')).flatMap((s) => JSON.parse(s) as string[]));
      for (const id of named) expect(idsOf(db, 'exchanges'), id).toContain(id);
      // updated_at is not touched: this is not a change of the fact
      expect(db.prepare(`SELECT DISTINCT updated_at AS u FROM facts`).all()).toEqual([{ u: 'u' }]);
    } finally {
      db.close();
    }

    const bak = new Database(backupPath, { readonly: true });
    try {
      expect(idsOf(bak, 'exchanges')).toEqual(['a1-2', 'a1-4', 'b1-2']);
      expect(idsOf(bak, 'tool_calls')).toEqual(['a1-2:0', 'a1-4:0', 'b1-2:0']);
      expect(bak.prepare('SELECT id, keep_id FROM snapshot_map ORDER BY id').all())
        .toEqual([{ id: 'a1-2', keep_id: 'a1-9' }, { id: 'a1-4', keep_id: 'a1-9' }, { id: 'b1-2', keep_id: 'b1-3' }]);
      expect(bak.prepare('SELECT id, source_exchange_ids AS s FROM facts_sources_before ORDER BY id').all()).toEqual([
        { id: 'f-both', s: JSON.stringify(['a1-4', 'a1-9', 'b1-2']) },
        { id: 'f-stale', s: JSON.stringify(['a1-2', 'a10-11']) },
      ]);
    } finally {
      bak.close();
    }
  });

  it('a second run has nothing to do and writes no backup', () => {
    const db = open();
    try {
      applySnapshotDedupe(db, path.join(cfg, 'backup-1.sqlite'));
      const state = JSON.stringify([idsOf(db, 'exchanges'), sources(db)]);
      const second = applySnapshotDedupe(db, path.join(cfg, 'backup-2.sqlite'));
      expect(second).toMatchObject({ deletedRows: 0, rewrittenFacts: 0, backupPath: null });
      expect(JSON.stringify([idsOf(db, 'exchanges'), sources(db)])).toBe(state);
      expect(fs.existsSync(path.join(cfg, 'backup-2.sqlite'))).toBe(false);
    } finally {
      db.close();
    }
  });

  // The re-point used to be ONE write transaction that also searched every fact's source list
  // (measured on a copy of a live DB, 13,573 facts: the write lock held 3.3 to 5.4s, and another
  // process's write failed after its 5s wait). Now the search runs without the lock and the
  // writes go a few hundred facts at a time.
  describe('re-pointing the facts never holds the write lock for the whole job', () => {
    /** 25 more facts that name a removed snapshot (a1-2), so the re-point takes several batches. */
    function seedManyFacts(db: Database.Database, n = 25): void {
      const fact = db.prepare(`INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at) VALUES (?, ?, 'decision', 'global', ?, 't', 'u')`);
      for (let i = 0; i < n; i++) fact.run(`m-${String(i).padStart(2, '0')}`, `fact number ${i}`, JSON.stringify(['a1-2', 'a10-11']));
    }
    /** A second connection that does not wait: its write succeeds only when nobody holds the write lock. */
    function canWriteNow(): boolean {
      const other = new Database(dbPath);
      try {
        other.pragma('busy_timeout = 0');
        other.exec('BEGIN IMMEDIATE');
        other.exec('COMMIT');
        return true;
      } catch {
        return false;
      } finally {
        other.close();
      }
    }

    it('the facts are written in batches, and another connection gets the write lock between two of them', () => {
      const db = open();
      try {
        seedManyFacts(db);
        const batches: number[] = [];
        const otherCouldWrite: boolean[] = [];
        const result = applySnapshotDedupe(db, path.join(cfg, 'backup.sqlite'), {
          repoint: { batchSize: 10, pauseMs: 0, onBatch: (done) => { batches.push(done); otherCouldWrite.push(canWriteNow()); } },
        });
        // 2 seeded facts + 25: three batches of at most 10
        expect(result).toMatchObject({ deletedRows: 3, rewrittenFacts: 27, remainingExtraRows: 0 });
        expect(batches).toEqual([10, 20, 27]);
        expect(otherCouldWrite).toEqual([true, true, true]);
        const s = sources(db);
        for (let i = 0; i < 25; i++) expect(s[`m-${String(i).padStart(2, '0')}`]).toBe(JSON.stringify(['a1-9', 'a10-11']));
        expect(s['f-stale']).toBe(JSON.stringify(['a1-9', 'a10-11']));
        expect(s['f-both']).toBe(JSON.stringify(['a1-9', 'b1-3']));
      } finally {
        db.close();
      }
    });

    it('a batch also ends when it has held the lock for maxBatchMs', () => {
      const db = open();
      try {
        seedManyFacts(db);
        const batches: number[] = [];
        // 0ms: every fact is its own transaction
        const result = applySnapshotDedupe(db, path.join(cfg, 'backup.sqlite'), {
          repoint: { maxBatchMs: 0, pauseMs: 0, onBatch: (done) => batches.push(done) },
        });
        expect(result.rewrittenFacts).toBe(27);
        expect(batches).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
      } finally {
        db.close();
      }
    });

    it('a fact that changed after it was read is judged again inside its batch, not overwritten with the list computed earlier', () => {
      const db = open();
      try {
        seedManyFacts(db);
        const setSources = db.prepare('UPDATE facts SET source_exchange_ids = ? WHERE id = ?');
        const changed: string[] = [];
        const result = applySnapshotDedupe(db, path.join(cfg, 'backup.sqlite'), {
          repoint: {
            batchSize: 5, pauseMs: 0,
            onBatch: () => {
              if (changed.length > 0) return;
              // Between the first batch and the rest, "another process" changes facts that are still waiting:
              const waiting = (db.prepare(`SELECT id FROM facts WHERE id LIKE 'm-%' AND source_exchange_ids LIKE '%a1-2%' ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
              expect(waiting.length).toBeGreaterThanOrEqual(4);
              setSources.run(JSON.stringify(['a10-11', 'new-row']), waiting[0]);         // no longer names a removed row
              setSources.run(JSON.stringify(['b1-2', 'new-row', 'a1-4']), waiting[1]);   // names other removed rows now
              setSources.run('not json any more', waiting[2]);                           // unreadable now
              db.prepare('DELETE FROM facts WHERE id = ?').run(waiting[3]);              // gone
              changed.push(...waiting.slice(0, 4));
            },
          },
        });
        const s = sources(db);
        expect(s[changed[0]]).toBe(JSON.stringify(['a10-11', 'new-row']));          // left as the other process wrote it
        expect(s[changed[1]]).toBe(JSON.stringify(['b1-3', 'new-row', 'a1-9']));    // re-pointed from what is stored NOW
        expect(s[changed[2]]).toBe('not json any more');                            // left alone
        expect(s[changed[3]]).toBeUndefined();
        // 27 facts named a removed row; of the four changed meanwhile only one still did
        expect(result.rewrittenFacts).toBe(27 - 3);
        // and no fact names a removed row any more
        for (const [id, list] of Object.entries(s)) {
          if (!list.startsWith('[')) continue;
          for (const removed of ['a1-2', 'a1-4', 'b1-2']) expect(JSON.parse(list), id).not.toContain(removed);
        }
      } finally {
        db.close();
      }
    });

    it('a source list that is valid JSON but not an array is left alone (it used to stop the run after the backup)', () => {
      const db = open();
      try {
        db.prepare(`INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at) VALUES ('f-object', 'odd sources', 'decision', 'global', ?, 't', 'u')`)
          .run(JSON.stringify({ first: 'a1-2' }));
        const result = applySnapshotDedupe(db, path.join(cfg, 'backup.sqlite'));
        expect(result).toMatchObject({ deletedRows: 3, rewrittenFacts: 2, remainingExtraRows: 0 });
        expect(sources(db)['f-object']).toBe(JSON.stringify({ first: 'a1-2' }));
      } finally {
        db.close();
      }
    });

    it('the defaults: a few hundred facts per transaction, the lock given up after 400ms, a pause between batches', async () => {
      const { REPOINT_BATCH_ROWS } = await import('../src/snapshot-dedupe.js');
      const { DELETE_BATCH_MAX_MS, DELETE_BATCH_PAUSE_MS } = await import('../src/db.js');
      expect(REPOINT_BATCH_ROWS).toBe(500);
      expect(DELETE_BATCH_MAX_MS).toBe(400);
      expect(DELETE_BATCH_PAUSE_MS).toBeGreaterThan(100); // longer than the longest sleep of a waiting connection's busy handler
    });
  });

  it('a backup that cannot be written changes nothing', () => {
    const db = open();
    const taken = path.join(cfg, 'taken.sqlite');
    fs.writeFileSync(taken, 'already here');
    try {
      const before = JSON.stringify([idsOf(db, 'exchanges'), sources(db)]);
      expect(() => applySnapshotDedupe(db, taken)).toThrow(/backup already exists/);
      expect(JSON.stringify([idsOf(db, 'exchanges'), sources(db)])).toBe(before);
    } finally {
      db.close();
    }
  });
});

describe('scripts/dedupe-exchange-snapshots.mjs', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/dedupe-exchange-snapshots.mjs', ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, MEMORY_BANK_CONFIG_DIR: cfg, MEMORY_BANK_DB_PATH: dbPath },
  });
  const sha = () => crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
  const backups = () => {
    const dir = path.join(cfg, 'conversation-index', 'backups');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };
  const readIds = () => {
    const db = new Database(dbPath, { readonly: true });
    try { return idsOf(db, 'exchanges'); } finally { db.close(); }
  };
  const hasIndex = () => {
    const db = new Database(dbPath, { readonly: true });
    try { return db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name = ?`).get(EXCHANGE_TURN_INDEX); } finally { db.close(); }
  };

  it('the default is a dry run: it reports the plan and leaves the database file byte-for-byte unchanged', () => {
    const before = sha();
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/turns with more than one row: 2 \(in 2 files, up to 3 rows for one turn\)/);
    expect(r.stdout).toMatch(/rows to remove: 3/);
    expect(r.stdout).toMatch(/facts to re-point at the remaining row: 2/);
    expect(r.stdout).toMatch(/DRY-RUN \(no changes made\)/);
    expect(sha()).toBe(before);
    expect(backups()).toEqual([]);
  });

  it('a mistyped flag, or --create-index without --apply, stops the run before the database is opened', () => {
    const before = sha();
    for (const args of [['--aply'], ['--apply', '--create-indx'], ['--create-index'], ['--apply', '--apply']]) {
      const r = run(...args);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr, args.join(' ')).toMatch(/dedupe-exchange-snapshots: /);
    }
    expect(sha()).toBe(before);
    expect(readIds()).toHaveLength(6);
    expect(backups()).toEqual([]);
  });

  it('--apply removes the extra rows after a backup; --create-index builds the turn index', () => {
    // an older build's database has no (archive_path, line_start) index
    const old = new Database(dbPath);
    sqliteVec.load(old);
    old.exec(`DROP INDEX IF EXISTS ${EXCHANGE_TURN_INDEX}`);
    old.close();
    expect(hasIndex()).toEqual({ n: 0 });

    const r = run('--apply', '--create-index');
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/re-pointed 2 facts, deleted 3 rows; duplicate rows left: 0/);
    expect(readIds()).toEqual(['a1-9', 'a10-11', 'b1-3']);
    expect(backups().filter((f) => f.startsWith('dedupe-snapshots-'))).toHaveLength(1);
    expect(hasIndex()).toEqual({ n: 1 });
  });
});
