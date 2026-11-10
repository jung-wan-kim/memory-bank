import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { initDatabase, getVecQuant, embeddingToVecBlob, vecParamSql } from '../src/db.js';
import { vecTableFill } from '../src/vec-compact.js';
import { EMBEDDING_VERSION } from '../src/embedding-version.js';
import { suppressConsole } from './test-utils.js';

// The pending-work probes scan the whole exchanges table (measured cold: ~44s and
// ~8GB pulled through the page cache per run) and ran on EVERY session start,
// evicting the fact-vector pages the per-prompt injection search needs. They now
// run at most once per interval; each run also compacts sparse fact vec tables.

const REPO = path.resolve(__dirname, '..');
const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

interface LogLine {
  action: string; reason?: string; spawned?: string[]; failures?: string[]; warning?: string;
  compaction?: Array<{ table: string; action: string; error?: string }>;
  vec_reconcile?: Array<{ table: string; removed: number; reinserted: number; missing_no_embedding: number }>;
  analyze?: { tables: number; stat_rows: number; ms: number };
}

/** Active facts for the given ids — a vector whose fact is absent is removed by the run's reconcile step. */
function addFacts(db: ReturnType<typeof initDatabase>, ids: string[], opts: { active?: boolean; embedding?: Buffer } = {}): void {
  const ins = db.prepare(`INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at, is_active, embedding, embedding_version)
    VALUES (?, ?, 'decision', 'global', '[]', 't', 't', ?, ?, ?)`);
  db.transaction(() => { for (const id of ids) ins.run(id, `fact ${id}`, opts.active === false ? 0 : 1, opts.embedding ?? null, EMBEDDING_VERSION); })();
}

describe('session-start-maintenance throttle + compaction', () => {
  let cfg: string;
  let dbPath: string;

  const run = (extra: Record<string, string> = {}) => spawnSync(process.execPath, ['scripts/session-start-maintenance.js'], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, MEMORY_BANK_CONFIG_DIR: cfg, MEMORY_BANK_DB_PATH: dbPath, MEMORY_BANK_SESSION_START_SPAWN: '0', ...extra },
  });
  const log = (): LogLine[] => {
    const p = path.join(cfg, 'conversation-index', 'logs', 'maintenance.jsonl');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };

  beforeEach(() => {
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-maint-'));
    dbPath = path.join(cfg, 'db.sqlite');
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(cfg, { recursive: true, force: true });
  });

  it('runs once, then skips inside the interval and logs both', () => {
    const a = run();
    expect(a.status, a.stderr).toBe(0);
    const b = run();
    expect(b.status, b.stderr).toBe(0);
    expect(b.stderr).toMatch(/skipped — last run \d+m ago \(interval 360m/);
    const lines = log();
    expect(lines.map((l) => l.action)).toEqual(['ran', 'skipped']);
  });

  it('MEMORY_BANK_MAINTENANCE_INTERVAL_MIN=0 runs every time', () => {
    run({ MEMORY_BANK_MAINTENANCE_INTERVAL_MIN: '0' });
    run({ MEMORY_BANK_MAINTENANCE_INTERVAL_MIN: '0' });
    expect(log().map((l) => l.action)).toEqual(['ran', 'ran']);
  });

  it('a run already in progress makes a concurrent start skip', () => {
    fs.mkdirSync(path.join(cfg, 'conversation-index', 'state', 'session-start-maintenance.claim'), { recursive: true });
    const r = run({ MEMORY_BANK_MAINTENANCE_INTERVAL_MIN: '0' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/another maintenance run is in progress/);
    expect(log().map((l) => l.action)).toEqual(['skipped']);
  });

  const claimDir = () => path.join(cfg, 'conversation-index', 'state', 'session-start-maintenance.claim');
  const stampFile = () => path.join(cfg, 'conversation-index', 'state', 'session-start-maintenance.stamp');

  it("a live run's claim is not taken over (the skipping start leaves it in place); past 2h it is a reused pid and is reclaimed", () => {
    fs.mkdirSync(claimDir(), { recursive: true });
    fs.writeFileSync(path.join(claimDir(), 'pid'), String(process.pid)); // alive: this test process
    const setAge = (ms: number) => { const t = new Date(Date.now() - ms); fs.utimesSync(claimDir(), t, t); };
    setAge(60 * 60_000); // 1h: far longer than a run (~50s) yet under the cap — still trusted
    const r = run({ MEMORY_BANK_MAINTENANCE_INTERVAL_MIN: '0' });
    expect(r.stderr).toMatch(/another maintenance run is in progress/);
    expect(fs.readFileSync(path.join(claimDir(), 'pid'), 'utf8')).toBe(String(process.pid));
    setAge(3 * 60 * 60_000); // 3h: no run lasts that long — the pid was reused
    const r2 = run({ MEMORY_BANK_MAINTENANCE_INTERVAL_MIN: '0' });
    expect(r2.status, r2.stderr).toBe(0);
    expect(log().map((l) => l.action)).toEqual(['skipped', 'ran']);
    expect(fs.existsSync(claimDir())).toBe(false);
  });

  it('a claim whose run is dead is reclaimed and the run proceeds; its own claim is released', () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid; // exited by now
    fs.mkdirSync(claimDir(), { recursive: true });
    fs.writeFileSync(path.join(claimDir(), 'pid'), String(dead));
    const r = run({ MEMORY_BANK_MAINTENANCE_INTERVAL_MIN: '0' });
    expect(r.status, r.stderr).toBe(0);
    expect(log().map((l) => l.action)).toEqual(['ran']);
    expect(fs.existsSync(claimDir())).toBe(false);
    expect(fs.readdirSync(path.dirname(claimDir())).filter((f) => f.includes('.reclaim-'))).toEqual([]);
  });

  it('a step that fails makes the run "partial": logged with the cause, retried after 60m instead of 6h — compacted tables still logged', () => {
    process.env.TEST_DB_PATH = dbPath;
    const db = initDatabase();
    try {
      const q = getVecQuant(db, 'vec_facts');
      const ins = db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vecParamSql(q)})`);
      db.transaction(() => {
        for (let i = 0; i < 3072; i++) ins.run(`f-${i}`, embeddingToVecBlob(Array.from({ length: 384 }, (_, j) => Math.sin(i + j) * 0.05), q));
        db.prepare("DELETE FROM vec_facts WHERE CAST(substr(id, 3) AS INTEGER) % 3 != 0").run();
      })();
      // vec_facts_kr in a schema the rebuild refuses, sparse enough to be picked
      db.exec('DROP TABLE vec_facts_kr');
      db.exec('CREATE VIRTUAL TABLE vec_facts_kr USING vec0(id TEXT PRIMARY KEY, embedding int8[384], +note TEXT)');
      const insK = db.prepare('INSERT INTO vec_facts_kr (id, embedding, note) VALUES (?, vec_int8(?), ?)');
      db.transaction(() => {
        for (let i = 0; i < 2048; i++) insK.run(`k-${i}`, Buffer.from(new Int8Array(384).fill(i % 50).buffer), 'n');
        db.prepare("DELETE FROM vec_facts_kr WHERE CAST(substr(id, 3) AS INTEGER) % 4 != 0").run();
      })();
      addFacts(db, Array.from({ length: 1024 }, (_, i) => `f-${i * 3}`));
      addFacts(db, Array.from({ length: 512 }, (_, i) => `k-${i * 4}`));
    } finally {
      db.close();
    }
    const a = run();
    expect(a.status, a.stderr).toBe(0);
    expect(a.stderr).toMatch(/1 step\(s\) failed — compaction vec_facts_kr: .*unsupported vec0 schema.* \(retry after 60m\)/);
    expect(JSON.parse(fs.readFileSync(stampFile(), 'utf8')).action).toBe('partial');
    const first = log()[0];
    expect(first.action).toBe('partial');
    expect(first.compaction?.find((c) => c.table === 'vec_facts')?.action).toBe('compacted');
    expect(first.compaction?.find((c) => c.table === 'vec_facts_kr')?.error).toMatch(/unsupported vec0 schema/);
    expect(first.failures).toHaveLength(1);

    // A persistent failure must not bring back the per-session probe: the next start is throttled.
    const b = run();
    expect(b.stderr).toMatch(/last run 0m ago was partial \(retry after 60m\)/);
    const back = new Date(Date.now() - 61 * 60_000);
    fs.utimesSync(stampFile(), back, back);
    run(); // past the retry interval (well inside the 6h one) → runs again
    expect(log().map((l) => l.action)).toEqual(['partial', 'skipped', 'partial']);
  });

  it('a fully successful run stamps "ran" and throttles for the whole interval', () => {
    run();
    expect(JSON.parse(fs.readFileSync(stampFile(), 'utf8')).action).toBe('ran');
    const back = new Date(Date.now() - 61 * 60_000);
    fs.utimesSync(stampFile(), back, back);
    const b = run();
    expect(b.stderr).toMatch(/last run 61m ago \(interval 360m/);
  });

  it('a stamp that is not a partial JSON stamp (a bare ISO date) throttles for the full interval', () => {
    fs.mkdirSync(path.dirname(stampFile()), { recursive: true });
    fs.writeFileSync(stampFile(), new Date().toISOString());
    const back = new Date(Date.now() - 61 * 60_000);
    fs.utimesSync(stampFile(), back, back);
    expect(run().stderr).toMatch(/last run 61m ago \(interval 360m/);
  });

  it('a claim dir that cannot be created (permissions) is a failure with its cause, not "another run in progress"', () => {
    const state = path.dirname(claimDir());
    fs.mkdirSync(state, { recursive: true });
    fs.chmodSync(state, 0o500); // the claim mkdir fails with EACCES
    try {
      const r = run({ MEMORY_BANK_MAINTENANCE_INTERVAL_MIN: '0' });
      expect(r.stderr).not.toMatch(/another maintenance run is in progress/);
      const [l] = log() as Array<LogLine & { error?: string }>;
      expect(l.action).toBe('failed');
      expect(l.error).toMatch(/cannot create the maintenance claim: .*EACCES/);
    } finally {
      fs.chmodSync(state, 0o700);
    }
  });

  it('an invalid interval runs at the default and says so in the log line', () => {
    run({ MEMORY_BANK_MAINTENANCE_INTERVAL_MIN: 'six hours' });
    const [l] = log();
    expect(l.action).toBe('ran');
    expect(l.warning).toMatch(/invalid MEMORY_BANK_MAINTENANCE_INTERVAL_MIN=six hours — using 360/);
  });

  it('a run that fails is logged as failed, writes no stamp, and the next start retries', () => {
    const asDir = path.join(cfg, 'not-a-db');
    fs.mkdirSync(asDir); // opening a directory as the DB throws inside the claimed run
    const a = run({ MEMORY_BANK_DB_PATH: asDir });
    expect(a.status, a.stderr).toBe(0);
    expect(fs.existsSync(path.join(cfg, 'conversation-index', 'state', 'session-start-maintenance.stamp'))).toBe(false);
    run({ MEMORY_BANK_DB_PATH: asDir });
    const lines = log();
    expect(lines.map((l) => l.action)).toEqual(['failed', 'failed']);
    expect((lines[0] as LogLine & { error?: string }).error).toBeTruthy();
    expect(fs.existsSync(path.join(cfg, 'conversation-index', 'state', 'session-start-maintenance.claim'))).toBe(false);
  });

  it('compacts a sparse fact vec table and reports pending-work spawns without spawning', () => {
    process.env.TEST_DB_PATH = dbPath;
    const db = initDatabase();
    try {
      const q = getVecQuant(db, 'vec_facts');
      const ins = db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vecParamSql(q)})`);
      db.transaction(() => {
        for (let i = 0; i < 3072; i++) ins.run(`f-${i}`, embeddingToVecBlob(Array.from({ length: 384 }, (_, j) => Math.sin(i + j) * 0.05), q));
        db.prepare("DELETE FROM vec_facts WHERE CAST(substr(id, 3) AS INTEGER) % 3 != 0").run();
      })();
      addFacts(db, Array.from({ length: 1024 }, (_, i) => `f-${i * 3}`));
      expect(vecTableFill(db, 'vec_facts')!.chunks).toBe(3);
    } finally {
      db.close();
    }
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    const ran = log()[0];
    expect(ran.action).toBe('ran');
    expect(ran.compaction?.find((c) => c.table === 'vec_facts')?.action).toBe('compacted');
    const db2 = initDatabase();
    try {
      expect(vecTableFill(db2, 'vec_facts')!.chunks).toBe(1);
    } finally {
      db2.close();
    }
  });

  it('gathers planner statistics for the fact tables and logs the run', () => {
    process.env.TEST_DB_PATH = dbPath;
    const db = initDatabase();
    try {
      addFacts(db, Array.from({ length: 50 }, (_, i) => `f-${i}`));
      expect(db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'`).get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    const ran = log()[0];
    expect(ran.action).toBe('ran');
    expect(ran.analyze?.tables).toBe(6);
    expect(ran.analyze?.stat_rows).toBeGreaterThanOrEqual(5);
    const db2 = initDatabase();
    try {
      const analyzed = (db2.prepare('SELECT DISTINCT tbl FROM sqlite_stat1').all() as Array<{ tbl: string }>).map((t) => t.tbl);
      expect(analyzed).toContain('facts');
      expect(analyzed).not.toContain('exchanges');
    } finally {
      db2.close();
    }
  });

  it('brings the fact vector tables back in step with the facts table and logs the counts', () => {
    process.env.TEST_DB_PATH = dbPath;
    const vector = (seed: number) => Array.from({ length: 384 }, (_, j) => Math.sin(seed + j) * 0.05);
    const db = initDatabase();
    try {
      const q = getVecQuant(db, 'vec_facts');
      const ins = (table: string, id: string, seed: number) =>
        db.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ${vecParamSql(q)})`).run(id, embeddingToVecBlob(vector(seed), q));
      addFacts(db, ['active-with-vector']);
      addFacts(db, ['inactive-with-vector'], { active: false });
      addFacts(db, ['active-lost-vector'], { embedding: Buffer.from(new Float32Array(vector(9)).buffer) });
      ins('vec_facts', 'active-with-vector', 1);
      ins('vec_facts', 'inactive-with-vector', 2);
      ins('vec_facts', 'no-such-fact', 3);
      ins('vec_facts_kr', 'inactive-with-vector', 2);
    } finally {
      db.close();
    }
    const r = run({ MEMORY_BANK_MAINTENANCE_INTERVAL_MIN: '0' });
    expect(r.status, r.stderr).toBe(0);
    expect(log()[0].action).toBe('ran');
    expect(log()[0].vec_reconcile).toEqual([
      { table: 'vec_facts', removed: 2, reinserted: 1, missing_no_embedding: 0 },
      { table: 'vec_facts_kr', removed: 1, reinserted: 0, missing_no_embedding: 0 },
    ]);
    const db2 = initDatabase();
    try {
      expect(db2.prepare('SELECT id FROM vec_facts_rowids ORDER BY id').all()).toEqual([{ id: 'active-lost-vector' }, { id: 'active-with-vector' }]);
      expect(db2.prepare('SELECT id FROM vec_facts_kr_rowids').all()).toEqual([]);
    } finally {
      db2.close();
    }
    // nothing left for the next run
    run({ MEMORY_BANK_MAINTENANCE_INTERVAL_MIN: '0' });
    expect(log()[1].vec_reconcile).toEqual([
      { table: 'vec_facts', removed: 0, reinserted: 0, missing_no_embedding: 0 },
      { table: 'vec_facts_kr', removed: 0, reinserted: 0, missing_no_embedding: 0 },
    ]);
  });
});
