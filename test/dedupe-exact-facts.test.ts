import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { findExactDuplicateGroups, applyExactDedupe, restoreExactDedupe, exactSentenceKey } from '../src/dedupe-exact-facts.js';

/**
 * Cleanup of exact duplicates (same scope, same sentence up to whitespace and
 * case). The module is tested directly; the script is run as a child process
 * for its arguments and for "a dry run cannot write". (The script imports
 * dist/: `npm run build` must have run — `npm test` does that in pretest.)
 */

const REPO = path.resolve(__dirname, '..');

function vec(seed: number): number[] {
  const v = Array.from({ length: 384 }, (_, i) => Math.sin(seed * 31 + i * 7.3) * 0.1);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

/** Everything the cleanup may touch, and the schema: equal fingerprints = nothing was written. */
function fingerprint(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  sqliteVec.load(db);
  try {
    const h = createHash('sha256');
    for (const sql of [
      'SELECT name, sql FROM sqlite_master ORDER BY name',
      'SELECT * FROM facts ORDER BY id',
      'SELECT id, embedding FROM vec_facts ORDER BY id',
      'SELECT id, embedding FROM vec_facts_kr ORDER BY id',
    ]) {
      for (const row of db.prepare(sql).all() as Array<Record<string, unknown>>) {
        h.update(JSON.stringify(Object.values(row).map((v) => (Buffer.isBuffer(v) ? v.toString('hex') : v))));
      }
    }
    return h.digest('hex');
  } finally {
    db.close();
  }
}

describe('exact-duplicate cleanup', () => {
  let dir: string;
  let dbPath: string;
  let ids: Record<'gitOldest' | 'gitSpaced' | 'gitUpper' | 'otherProject' | 'globalSame' | 'pairOld' | 'pairNew' | 'unique' | 'inactiveCopy', string>;

  const T0 = Date.parse('2026-06-15T00:00:00.000Z');
  const day = (n: number) => new Date(T0 + n * 86_400_000).toISOString();
  const writable = () => { const db = new Database(dbPath); sqliteVec.load(db); return db; };
  const readOnly = () => { const db = new Database(dbPath, { readonly: true }); sqliteVec.load(db); return db; };
  const row = (db: Database.Database, id: string) => db.prepare('SELECT is_active, consolidated_count, source_exchange_ids, updated_at FROM facts WHERE id = ?')
    .get(id) as { is_active: number; consolidated_count: number; source_exchange_ids: string; updated_at: string };
  const hasVec = (db: Database.Database, table: string, id: string) => db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-exact-'));
    dbPath = path.join(dir, 'test.db');
    const prev = process.env.TEST_DB_PATH;
    process.env.TEST_DB_PATH = dbPath;
    const db = initDatabase();
    try {
      let seed = 0;
      const add = (fact: string, at: string, o: { project?: string | null; count?: number; sources?: string[]; kr?: boolean } = {}) => {
        const project = o.project === undefined ? '/proj' : o.project;
        const id = insertFact(db, {
          fact, category: 'knowledge', scope_type: project ? 'project' : 'global', scope_project: project,
          source_exchange_ids: o.sources ?? [], embedding: vec(++seed),
          fact_kr: o.kr ? '한국어 문장' : null, embedding_kr: o.kr ? vec(++seed) : null,
        });
        db.prepare('UPDATE facts SET created_at = ?, updated_at = ?, consolidated_count = ? WHERE id = ?').run(at, at, o.count ?? 1, id);
        return id;
      };
      const git = 'The billing worker retries a failed charge three times';
      ids = {
        gitOldest: add(git, day(1), { count: 2, sources: ['ex-1'] }),
        gitSpaced: add('The  billing worker retries a failed charge\nthree times ', day(2), { count: 3, sources: ['ex-2'], kr: true }),
        gitUpper: add('THE BILLING WORKER RETRIES A FAILED CHARGE THREE TIMES', day(3), { sources: ['ex-1', 'ex-3'] }),
        otherProject: add(git, day(1), { project: '/elsewhere' }),    // same sentence, another project — not a duplicate
        globalSame: add(git, day(1), { project: null }),               // …nor is the global copy
        pairNew: add('Tests run with vitest', day(9), { count: 4 }),
        pairOld: add('Tests run with vitest', day(5), { count: 1 }),   // inserted later, created earlier: it is the survivor
        unique: add('Tests run with vitest.', day(6)),                 // a trailing period is a different sentence here
        inactiveCopy: add(git, day(0)),
      };
      db.prepare('UPDATE facts SET is_active = 0 WHERE id = ?').run(ids.inactiveCopy);
      db.prepare('DELETE FROM vec_facts WHERE id = ?').run(ids.inactiveCopy);
    } finally {
      db.close();
      if (prev === undefined) delete process.env.TEST_DB_PATH; else process.env.TEST_DB_PATH = prev;
    }
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds the groups on a read-only handle — same scope and same sentence only, oldest first — and writes nothing', () => {
    const before = fingerprint(dbPath);
    const db = readOnly();
    let groups;
    try {
      groups = findExactDuplicateGroups(db);
    } finally {
      db.close();
    }
    expect(groups.map((g) => ({ survivorId: g.survivorId, removedIds: g.removedIds })).sort((a, b) => b.removedIds.length - a.removedIds.length)).toEqual([
      { survivorId: ids.gitOldest, removedIds: [ids.gitSpaced, ids.gitUpper] },
      { survivorId: ids.pairOld, removedIds: [ids.pairNew] },
    ]);
    expect(exactSentenceKey(' A  b\nC ')).toBe('a b c');
    expect(fingerprint(dbPath)).toBe(before);
  });

  it('apply (counts sum): survivors take counts and sources, the rest are deactivated with their vector rows, nothing else moves', () => {
    const db = writable();
    try {
      const bystanders = [ids.otherProject, ids.globalSame, ids.unique, ids.inactiveCopy].map((id) => row(db, id));
      const applied = applyExactDedupe(db, findExactDuplicateGroups(db), { counts: 'sum', now: new Date('2026-11-10T12:34:56.000Z') });

      expect(applied).toEqual({ groups: 2, deactivated: 3, groupsChangedSinceCheck: 0, backupTable: 'dedupe_exact_backup_20261110123456' });
      expect(row(db, ids.gitOldest)).toEqual({ is_active: 1, consolidated_count: 2 + 3 + 1, source_exchange_ids: '["ex-1","ex-2","ex-3"]', updated_at: day(1) });
      expect(row(db, ids.pairOld)).toMatchObject({ is_active: 1, consolidated_count: 5, updated_at: day(5) });
      for (const id of [ids.gitSpaced, ids.gitUpper, ids.pairNew]) {
        expect(row(db, id)).toMatchObject({ is_active: 0, updated_at: '2026-11-10T12:34:56.000Z' });
        expect(hasVec(db, 'vec_facts', id)).toBe(false);
        expect(hasVec(db, 'vec_facts_kr', id)).toBe(false);
      }
      expect(hasVec(db, 'vec_facts', ids.gitOldest)).toBe(true);
      expect([ids.otherProject, ids.globalSame, ids.unique, ids.inactiveCopy].map((id) => row(db, id))).toEqual(bystanders);

      // Nothing left to merge; a second apply writes nothing and leaves no backup table.
      expect(findExactDuplicateGroups(db)).toEqual([]);
      expect(applyExactDedupe(db, [], { counts: 'sum' })).toEqual({ groups: 0, deactivated: 0, groupsChangedSinceCheck: 0, backupTable: null });
    } finally {
      db.close();
    }
  });

  it('apply (counts keep): the survivor keeps its own count, sources are still united', () => {
    const db = writable();
    try {
      applyExactDedupe(db, findExactDuplicateGroups(db), { counts: 'keep' });
      expect(row(db, ids.gitOldest)).toMatchObject({ consolidated_count: 2, source_exchange_ids: '["ex-1","ex-2","ex-3"]' });
      expect(row(db, ids.pairOld).consolidated_count).toBe(1);
      expect(row(db, ids.gitSpaced).is_active).toBe(0);
    } finally {
      db.close();
    }
  });

  it('a group whose member changed after it was found is left alone as a whole', () => {
    const db = writable();
    try {
      const groups = findExactDuplicateGroups(db);
      db.prepare('UPDATE facts SET fact = ? WHERE id = ?').run('The project moved to the release branch', ids.gitUpper);
      const applied = applyExactDedupe(db, groups, { counts: 'sum' });
      expect(applied).toMatchObject({ groups: 1, deactivated: 1, groupsChangedSinceCheck: 1 });
      expect(row(db, ids.gitSpaced).is_active).toBe(1);
      expect(row(db, ids.gitOldest).consolidated_count).toBe(2);
    } finally {
      db.close();
    }
  });

  it('restore puts every changed value and vector row back', () => {
    const before = fingerprint(dbPath);
    const db = writable();
    try {
      const table = applyExactDedupe(db, findExactDuplicateGroups(db), { counts: 'sum' }).backupTable!;
      expect(fingerprint(dbPath)).not.toBe(before);
      expect(restoreExactDedupe(db, table)).toEqual({ reactivated: 3, survivorsRestored: 2, skippedChanged: 0 });
      expect(() => restoreExactDedupe(db, 'facts')).toThrow(/not a backup table/);
      db.exec(`DROP TABLE ${table}`); // the backup table itself is the only difference left
    } finally {
      db.close();
    }
    expect(fingerprint(dbPath)).toBe(before);
  });

  it('restore keeps what happened after the cleanup: a later confirmation stays, a fact switched on again is not touched', () => {
    const db = writable();
    try {
      const table = applyExactDedupe(db, findExactDuplicateGroups(db), { counts: 'sum' }).backupTable!;
      db.prepare('UPDATE facts SET consolidated_count = consolidated_count + 1 WHERE id = ?').run(ids.gitOldest); // confirmed once more since
      db.prepare('UPDATE facts SET is_active = 1 WHERE id = ?').run(ids.pairNew);                               // switched on by someone else
      expect(restoreExactDedupe(db, table)).toEqual({ reactivated: 2, survivorsRestored: 2, skippedChanged: 1 });
      expect(row(db, ids.gitOldest).consolidated_count).toBe(3); // 2 before the cleanup + the later one
    } finally {
      db.close();
    }
  });

  describe('scripts/dedupe-exact-facts.mjs', () => {
    function run(args: string[]) {
      const env: Record<string, string | undefined> = { ...process.env, MEMORY_BANK_CONFIG_DIR: dir };
      delete env.TEST_DB_PATH;
      delete env.MEMORY_BANK_DB_PATH;
      return spawnSync(process.execPath, ['scripts/dedupe-exact-facts.mjs', ...args], {
        cwd: REPO, env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 30_000,
      });
    }

    it('refuses unknown or mismatched arguments and changes nothing', () => {
      const before = fingerprint(dbPath);
      for (const [args, message] of [
        [['--db', dbPath, '--aply'], /unknown argument: --aply/],
        [['--db', dbPath, '--apply'], /--apply needs --counts sum\|keep/],
        [['--db', dbPath, '--apply', '--counts', 'max'], /--apply needs --counts sum\|keep/],
        [['--db', dbPath, '--apply', '--counts', 'sum', '--dry-run'], /--dry-run cannot be used with --apply/],
        [['--db', dbPath, '--counts', 'sum'], /--counts cannot be used with a dry run/],
        [['--db', dbPath, '--restore', 'dedupe_exact_backup_20261110123456', '--list'], /--list cannot be used with --restore/],
        [['--db', dbPath, '--restore', 'dedupe_exact_backup_19990101000000'], /no such backup table/],
        [['--db', path.join(dir, 'missing.db')], /no database at/],
      ] as Array<[string[], RegExp]>) {
        const res = run(args);
        expect(res.status, args.join(' ')).toBe(1);
        expect(res.stderr, args.join(' ')).toMatch(message);
      }
      expect(fingerprint(dbPath)).toBe(before);
    }, 60_000);

    it('the default run is a dry run: it reports the groups and the database is unchanged', () => {
      const before = fingerprint(dbPath);
      const res = run(['--db', dbPath, '--list']);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain('exact-duplicate groups (same scope, same sentence): 2');
      expect(res.stdout).toContain('facts in those groups: 5 — 3 would be deactivated, 2 stay');
      expect(res.stdout).toContain('largest groups: 3, 2');
      expect(res.stdout).toContain(`3× keep ${ids.gitOldest} [project /proj] the billing worker retries a failed charge three times`);
      expect(res.stdout).toContain('dry run — nothing written');
      expect(fingerprint(dbPath)).toBe(before);
    }, 40_000);

    it('--apply --counts sum merges, and --restore of its backup table brings the database back', () => {
      const before = fingerprint(dbPath);
      const applied = run(['--db', dbPath, '--apply', '--counts', 'sum']);
      expect(applied.status, applied.stderr).toBe(0);
      expect(applied.stdout).toContain('merged 2 groups, deactivated 3 facts; 0 groups changed during the run');
      const table = /backup table: (dedupe_exact_backup_\d{14})/.exec(applied.stdout)![1];

      const restored = run(['--db', dbPath, '--restore', table]);
      expect(restored.status, restored.stderr).toBe(0);
      expect(restored.stdout).toContain('reactivated 3 facts, restored 2 survivors');
      const db = writable();
      db.exec(`DROP TABLE ${table}`);
      db.close();
      expect(fingerprint(dbPath)).toBe(before);
    }, 60_000);
  });
});
