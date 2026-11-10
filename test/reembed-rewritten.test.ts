import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { initDatabase, getVecQuant, embeddingToVecBlob } from '../src/db.js';
import { insertFact, insertRevision } from '../src/fact-db.js';
import { checkRewrittenFacts, applyRewrittenFacts, restoreRewrittenFacts } from '../src/reembed-rewritten.js';

/**
 * Repair of facts that consolidation rewrote without re-embedding (≤1.7.9).
 * The module is tested with a stand-in embedder (a vector that depends only on
 * the text); the script is run as a child process for what it alone decides —
 * its arguments, and that a dry run cannot write. (The script imports dist/:
 * `npm run build` must have run — `npm test` does that in pretest.)
 */

const REPO = path.resolve(__dirname, '..');

/** A unit vector that depends only on the text — distinct texts are near-orthogonal. */
function textVector(text: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const v = Array.from({ length: 384 }, () => next() - 0.5);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}
const embed = async (text: string) => textVector(text);

/** Everything a repair may touch, and the schema: equal fingerprints = nothing was written. */
function fingerprint(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  sqliteVec.load(db);
  try {
    const h = createHash('sha256');
    for (const sql of [
      'SELECT name, sql FROM sqlite_master ORDER BY name',
      'SELECT * FROM facts ORDER BY id',
      'SELECT * FROM fact_revisions ORDER BY id',
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

describe('repairing facts rewritten without a new vector', () => {
  let dir: string;
  let dbPath: string;
  let ids: { evolved: string; contradictionSurvivor: string; alreadyCurrent: string; noRevision: string; otherScope: string };

  const readOnly = () => { const db = new Database(dbPath, { readonly: true }); sqliteVec.load(db); return db; };
  const writable = () => { const db = new Database(dbPath); sqliteVec.load(db); return db; };
  const row = (db: Database.Database, id: string) => db.prepare('SELECT fact, fact_kr, embedding, updated_at FROM facts WHERE id = ?')
    .get(id) as { fact: string; fact_kr: string | null; embedding: Buffer; updated_at: string };
  const vecHex = (db: Database.Database, table: string, id: string) => {
    const r = db.prepare(`SELECT embedding FROM ${table} WHERE id = ?`).get(id) as { embedding: Buffer } | undefined;
    return r ? Buffer.from(r.embedding).toString('hex') : null;
  };
  const blobHex = (db: Database.Database, table: string, v: number[]) => embeddingToVecBlob(v, getVecQuant(db, table)).toString('hex');
  const f32Hex = (v: number[]) => Buffer.from(new Float32Array(v).buffer).toString('hex');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reembed-rewritten-'));
    dbPath = path.join(dir, 'test.db');
    const prev = process.env.TEST_DB_PATH;
    process.env.TEST_DB_PATH = dbPath;
    const db = initDatabase();
    try {
      const add = (fact: string, embeddedAs: string, extra: { project?: string; factKr?: string } = {}) => insertFact(db, {
        fact, category: 'decision', scope_type: 'project', scope_project: extra.project ?? '/proj', source_exchange_ids: [],
        embedding: textVector(embeddedAs),
        fact_kr: extra.factKr ?? null, embedding_kr: extra.factKr ? textVector(extra.factKr) : null,
      });
      const revise = (factId: string, previous: string, next: string) =>
        insertRevision(db, { fact_id: factId, previous_fact: previous, new_fact: next, reason: 'fixture', source_exchange_id: null });

      // EVOLUTION as ≤1.7.9 applied it: sentence replaced, vector and fact_kr left behind.
      const evolved = add('The API is served at v2 (was v1)', 'The API is served at v1', { factKr: 'API 는 v1 로 제공된다' });
      revise(evolved, 'The API is served at v1', 'The API is served at v2 (was v1)');
      // CONTRADICTION with a merged sentence: the revision sits on the retired fact, the sentence on the survivor.
      const retired = add('Sessions are stored in Redis', 'Sessions are stored in Redis');
      db.prepare('UPDATE facts SET is_active = 0 WHERE id = ?').run(retired);
      const contradictionSurvivor = add('Sessions are stored in Postgres, not Redis', 'Sessions moved to Postgres');
      revise(retired, 'Sessions are stored in Redis', 'Sessions are stored in Postgres, not Redis');
      // CONTRADICTION without a merged sentence: the survivor's own sentence — its vector is right.
      const retired2 = add('Builds use esbuild', 'Builds use esbuild');
      db.prepare('UPDATE facts SET is_active = 0 WHERE id = ?').run(retired2);
      const alreadyCurrent = add('Builds use rolldown', 'Builds use rolldown', { factKr: '빌드는 rolldown 을 쓴다' });
      revise(retired2, 'Builds use esbuild', 'Builds use rolldown');
      // Never rewritten: not this repair's business, whatever its vector is.
      const noRevision = add('Logs are JSON lines', 'something else entirely');
      // The same sentence in another project is not the revised one.
      const otherScope = add('The API is served at v2 (was v1)', 'unrelated vector', { project: '/elsewhere' });
      db.prepare("UPDATE facts SET updated_at = '2026-01-01T00:00:00.000Z'").run();
      ids = { evolved, contradictionSurvivor, alreadyCurrent, noRevision, otherScope };
    } finally {
      db.close();
      if (prev === undefined) delete process.env.TEST_DB_PATH; else process.env.TEST_DB_PATH = prev;
    }
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the check runs on a read-only handle, finds exactly the stale rewritten facts and writes nothing', async () => {
    const before = fingerprint(dbPath);
    const db = readOnly();
    let check;
    try {
      check = await checkRewrittenFacts(db, embed);
    } finally {
      db.close();
    }
    expect(check.candidates).toBe(3);
    expect(check.current).toBe(1);
    expect(check.stale.map((s) => s.id).sort()).toEqual([ids.evolved, ids.contradictionSurvivor].sort());
    expect(check.stale.find((s) => s.id === ids.evolved)!.hasFactKr).toBe(true);
    expect(check.stale.find((s) => s.id === ids.contradictionSurvivor)!.hasFactKr).toBe(false);
    expect(fingerprint(dbPath)).toBe(before);
  });

  it('apply (fact-kr clear): the stale facts get their sentence\'s vector, lose fact_kr, keep updated_at; the rest is byte-identical', async () => {
    const db = writable();
    try {
      const untouched = [ids.alreadyCurrent, ids.noRevision, ids.otherScope].map((id) => [row(db, id), vecHex(db, 'vec_facts', id), vecHex(db, 'vec_facts_kr', id)]);
      const check = await checkRewrittenFacts(db, embed);
      const applied = applyRewrittenFacts(db, check.stale, { factKr: 'clear', now: new Date('2026-11-10T12:34:56.000Z') });

      expect(applied).toEqual({ reembedded: 2, factKrCleared: 1, changedSinceCheck: 0, backupTable: 'reembed_rewritten_backup_20261110123456' });
      for (const id of [ids.evolved, ids.contradictionSurvivor]) {
        const sentence = row(db, id).fact;
        expect(row(db, id).embedding.toString('hex')).toBe(f32Hex(textVector(sentence)));
        expect(vecHex(db, 'vec_facts', id)).toBe(blobHex(db, 'vec_facts', textVector(sentence)));
        expect(row(db, id).updated_at).toBe('2026-01-01T00:00:00.000Z');
      }
      expect(row(db, ids.evolved).fact_kr).toBeNull();
      expect(vecHex(db, 'vec_facts_kr', ids.evolved)).toBeNull();
      expect([ids.alreadyCurrent, ids.noRevision, ids.otherScope].map((id) => [row(db, id), vecHex(db, 'vec_facts', id), vecHex(db, 'vec_facts_kr', id)])).toEqual(untouched);

      // The backup holds the old bytes of the two changed rows.
      const backup = db.prepare('SELECT id, fact_kr, embedding FROM reembed_rewritten_backup_20261110123456 ORDER BY id').all() as Array<{ id: string; fact_kr: string | null; embedding: Buffer }>;
      expect(backup.map((b) => b.id)).toEqual([ids.evolved, ids.contradictionSurvivor].sort());
      expect(backup.find((b) => b.id === ids.evolved)!.embedding.toString('hex')).toBe(f32Hex(textVector('The API is served at v1')));
      expect(backup.find((b) => b.id === ids.evolved)!.fact_kr).toBe('API 는 v1 로 제공된다');

      // A second run finds nothing stale and leaves no second backup table.
      const again = await checkRewrittenFacts(db, embed);
      expect(again.stale).toEqual([]);
      expect(again.current).toBe(3);
      expect(applyRewrittenFacts(db, again.stale, { factKr: 'clear' })).toEqual({ reembedded: 0, factKrCleared: 0, changedSinceCheck: 0, backupTable: null });
    } finally {
      db.close();
    }
  });

  it('apply (fact-kr keep) leaves the Korean sentence and its vector', async () => {
    const db = writable();
    try {
      const krBefore = vecHex(db, 'vec_facts_kr', ids.evolved);
      const applied = applyRewrittenFacts(db, (await checkRewrittenFacts(db, embed)).stale, { factKr: 'keep' });
      expect(applied.reembedded).toBe(2);
      expect(applied.factKrCleared).toBe(0);
      expect(row(db, ids.evolved).fact_kr).toBe('API 는 v1 로 제공된다');
      expect(vecHex(db, 'vec_facts_kr', ids.evolved)).toBe(krBefore);
    } finally {
      db.close();
    }
  });

  it('a fact whose sentence changed between the check and the write is left alone', async () => {
    const db = writable();
    try {
      const check = await checkRewrittenFacts(db, embed);
      db.prepare('UPDATE facts SET fact = ? WHERE id = ?').run('The API is served at v3', ids.evolved);
      const before = [row(db, ids.evolved), vecHex(db, 'vec_facts', ids.evolved)];
      const applied = applyRewrittenFacts(db, check.stale, { factKr: 'clear' });
      expect(applied.reembedded).toBe(1);
      expect(applied.changedSinceCheck).toBe(1);
      expect([row(db, ids.evolved), vecHex(db, 'vec_facts', ids.evolved)]).toEqual(before);
    } finally {
      db.close();
    }
  });

  it('restore puts every changed byte back', async () => {
    const before = fingerprint(dbPath);
    const db = writable();
    let table: string;
    try {
      table = applyRewrittenFacts(db, (await checkRewrittenFacts(db, embed)).stale, { factKr: 'clear' }).backupTable!;
      expect(restoreRewrittenFacts(db, table)).toEqual({ restored: 2, skippedChanged: 0 });
      expect(() => restoreRewrittenFacts(db, 'facts')).toThrow(/not a backup table/);
      expect(() => restoreRewrittenFacts(db, 'reembed_rewritten_backup_19990101000000')).toThrow(/no such backup table/);
      db.exec(`DROP TABLE ${table}`); // the backup table itself is the only difference left
    } finally {
      db.close();
    }
    expect(fingerprint(dbPath)).toBe(before);
  });

  describe('scripts/reembed-rewritten-facts.mjs', () => {
    function run(args: string[]) {
      const env: Record<string, string | undefined> = { ...process.env, MEMORY_BANK_CONFIG_DIR: dir };
      delete env.TEST_DB_PATH;
      delete env.MEMORY_BANK_DB_PATH;
      return spawnSync(process.execPath, ['scripts/reembed-rewritten-facts.mjs', ...args], {
        cwd: REPO, env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 30_000,
      });
    }

    it('refuses unknown or mismatched arguments before opening anything', () => {
      const before = fingerprint(dbPath);
      for (const [args, message] of [
        [['--db', dbPath, '--aply'], /unknown argument: --aply/],
        [['--db', dbPath, '--apply'], /--apply needs --fact-kr clear\|keep/],
        [['--db', dbPath, '--apply', '--fact-kr', 'maybe'], /--apply needs --fact-kr clear\|keep/],
        [['--db', dbPath, '--apply', '--fact-kr', 'clear', '--dry-run'], /--dry-run cannot be used with --apply/],
        [['--db', dbPath, '--fact-kr', 'clear'], /--fact-kr cannot be used with a dry run/],
        [['--db', dbPath, '--restore', 'reembed_rewritten_backup_20261110123456', '--dry-run'], /--dry-run cannot be used with --restore/],
        [['--db', path.join(dir, 'missing.db')], /no database at/],
      ] as Array<[string[], RegExp]>) {
        const res = run(args);
        expect(res.status, args.join(' ')).toBe(1);
        expect(res.stderr, args.join(' ')).toMatch(message);
      }
      expect(fingerprint(dbPath)).toBe(before);
    }, 60_000);

    it('a dry run of a database with nothing to check reports zero and writes nothing', () => {
      const setup = writable();
      setup.exec('DELETE FROM fact_revisions'); // no revision → no candidate → the embedding model is never loaded
      setup.close();
      const before = fingerprint(dbPath);

      const res = run(['--db', dbPath]);

      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("candidates (active facts holding a revision's sentence): 0");
      expect(res.stdout).toContain('dry run — nothing written');
      // The closing lines name the choice to make: keep, and clear only before a translation run.
      expect(res.stdout).toContain('Re-run with --apply --fact-kr keep to repair');
      expect(res.stdout).toMatch(/--fact-kr clear removes them instead; use it only when scripts\/translate-facts\.mjs/);
      expect(fingerprint(dbPath)).toBe(before);
    }, 40_000);

    it('--restore of a table that is not there fails with exit 1', () => {
      const res = run(['--db', dbPath, '--restore', 'reembed_rewritten_backup_19990101000000']);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/no such backup table/);
    }, 40_000);
  });
});
