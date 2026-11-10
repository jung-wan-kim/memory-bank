import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { spawn, spawnSync } from 'child_process';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { initDatabase, getVecQuant, embeddingToVecBlob, vecParamSql, normalizeVecDistance, l2DistanceToSimilarity, FACT_VEC_INT8_SCALE } from '../src/db.js';
import { assessDbHolders, holderCodeRoot, parseEtime, staleInstallDirs, listMemoryBankProcesses, isInside, VEC_SCALE_MIN_VERSION } from '../src/vec-migrate-guard.js';
import { suppressConsole } from './test-utils.js';

// scripts/migrate-vec-facts-int8.mjs imports ../dist — run `npm run build` first (`npm test` does not
// build: its pretest step only checks that dist/ is a build of the current sources).
const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/migrate-vec-facts-int8.mjs');

const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

function vec(seed: number): number[] {
  const v = Array.from({ length: 384 }, (_, i) => Math.sin(seed * 2.3 + i * 0.71) * 0.1 + Math.cos(i * seed) * 0.02);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

function openRaw(p: string) {
  const db = new Database(p);
  sqliteVec.load(db);
  return db;
}

function bytesById(db: Database.Database, table: string): Map<string, string> {
  return new Map((db.prepare(`SELECT id, embedding FROM ${table}`).all() as Array<{ id: string; embedding: Buffer }>)
    .map((r) => [r.id, Buffer.from(r.embedding).toString('hex')]));
}

describe('migrate-vec-facts-int8.mjs', () => {
  let dir: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;

  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, '--db', dbPath, ...args], { env, encoding: 'utf8' });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-f8-'));
    dbPath = path.join(dir, 'db.sqlite');
    env = {
      ...process.env, MEMORY_BANK_CONFIG_DIR: path.join(dir, 'cfg'), TEST_DB_PATH: dbPath,
      MEMORY_BANK_PLUGIN_CACHE_DIR: path.join(dir, 'plugin-cache'), // no installed plugin dirs here
      MEMORY_BANK_PROCESS_SCAN_ROOT: dir, // this machine's own sessions are not this temp DB's concern
    };
    process.env.TEST_DB_PATH = dbPath;
    // A pre-2026-07 DB: float32 fact tables, no scale record, with holes.
    initDatabase().close();
    const db = openRaw(dbPath);
    for (const t of ['vec_facts', 'vec_facts_kr']) {
      db.exec(`DROP TABLE ${t}`);
      db.exec(`CREATE VIRTUAL TABLE ${t} USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[384])`);
      db.prepare('DELETE FROM vec_int8_scale WHERE table_name = ?').run(t);
      const ins = db.prepare(`INSERT INTO ${t} (id, embedding) VALUES (?, ?)`);
      db.transaction(() => {
        for (let i = 0; i < 1500; i++) ins.run(`f-${i}`, Buffer.from(new Float32Array(vec(i + (t === 'vec_facts_kr' ? 0.5 : 0))).buffer));
        for (let i = 0; i < 1500; i += 4) db.prepare(`DELETE FROM ${t} WHERE id = ?`).run(`f-${i}`);
      })();
    }
    db.close();
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('dry-run changes nothing', () => {
    const before = fs.readFileSync(dbPath);
    const r = run('--dry-run');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/vec_facts: float32, 1125 rows → int8@600/);
    expect(r.stdout).toMatch(/dry-run: 2 table\(s\) would change/);
    const db = openRaw(dbPath);
    try {
      expect(getVecQuant(db, 'vec_facts').dtype).toBe('float32');
      expect(getVecQuant(db, 'vec_facts_kr').dtype).toBe('float32');
    } finally { db.close(); }
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });

  it('float32 → int8@600 with a verified backup, rows kept, every vector still finds itself; --restore brings the bytes back', () => {
    const db0 = openRaw(dbPath);
    const original = { vec_facts: bytesById(db0, 'vec_facts'), vec_facts_kr: bytesById(db0, 'vec_facts_kr') };
    db0.close();

    const r = run('--backup-dir', path.join(dir, 'bk'));
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/vec_categories: int8@127 — kept/); // fresh-DB default stays at 127

    const db = openRaw(dbPath);
    try {
      for (const t of ['vec_facts', 'vec_facts_kr'] as const) {
        expect(getVecQuant(db, t)).toEqual({ dtype: 'int8', scale: FACT_VEC_INT8_SCALE });
        expect(bytesById(db, t).size).toBe(original[t].size);
        const q = getVecQuant(db, t);
        const stmt = db.prepare(`SELECT id, distance FROM ${t} WHERE embedding MATCH ${vecParamSql(q)} ORDER BY distance LIMIT 1`);
        for (let i = 1; i < 1500; i += 37) {
          if (i % 4 === 0) continue;
          const self = vec(i + (t === 'vec_facts_kr' ? 0.5 : 0));
          const hit = stmt.get(embeddingToVecBlob(self, q)) as { id: string; distance: number };
          expect(hit.id).toBe(`f-${i}`);
          expect(l2DistanceToSimilarity(normalizeVecDistance(hit.distance, q))).toBeGreaterThan(0.999);
        }
      }
      // A fact added after the migration must survive a restore (dequantized).
      const q = getVecQuant(db, 'vec_facts');
      db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vecParamSql(q)})`).run('added-later', embeddingToVecBlob(vec(5000), q));
    } finally { db.close(); }

    const backups = fs.readdirSync(path.join(dir, 'bk'));
    expect(backups).toHaveLength(1);
    const lines = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'bk', backups[0]))).toString('utf8').trim().split('\n');
    const header = JSON.parse(lines[0]);
    expect(header.tables).toEqual({ vec_facts: { dtype: 'float32', rows: 1125 }, vec_facts_kr: { dtype: 'float32', rows: 1125 } });
    expect(lines.length - 1).toBe(2250);

    const back = run('--restore', path.join(dir, 'bk', backups[0]));
    expect(back.status, back.stderr + back.stdout).toBe(0);
    expect(back.stdout).toMatch(/vec_facts: ✅ float32 1126 rows \(from backup 1125, rewritten since 0 and added since 1 dequantized, 0 deleted since not restored\)/);
    const db2 = openRaw(dbPath);
    try {
      expect(getVecQuant(db2, 'vec_facts')).toEqual({ dtype: 'float32', scale: 1 });
      const restored = bytesById(db2, 'vec_facts');
      for (const [id, hex] of original.vec_facts) expect(restored.get(id)).toBe(hex);
      expect(restored.has('added-later')).toBe(true);
      expect(bytesById(db2, 'vec_facts_kr')).toEqual(original.vec_facts_kr);
      const rec = db2.prepare("SELECT count(*) AS n FROM vec_int8_scale WHERE table_name IN ('vec_facts','vec_facts_kr')").get() as { n: number };
      expect(rec.n).toBe(0);
    } finally { db2.close(); }
  });

  it('restore never brings back a backup vector the row was rewritten with since (re-embed / updateFact)', () => {
    const r = run('--backup-dir', path.join(dir, 'bk'));
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const newer = vec(9999);
    const db = openRaw(dbPath);
    try {
      const q = getVecQuant(db, 'vec_facts');
      db.prepare('DELETE FROM vec_facts WHERE id = ?').run('f-1');
      db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vecParamSql(q)})`).run('f-1', embeddingToVecBlob(newer, q));
    } finally { db.close(); }
    const back = run('--restore', path.join(dir, 'bk', fs.readdirSync(path.join(dir, 'bk'))[0]));
    expect(back.status, back.stderr + back.stdout).toBe(0);
    expect(back.stdout).toMatch(/vec_facts: ✅ float32 1125 rows \(from backup 1124, rewritten since 1 and added since 0/);
    const db2 = openRaw(dbPath);
    try {
      const got = new Float32Array(Uint8Array.from(db2.prepare("SELECT embedding FROM vec_facts WHERE id = 'f-1'").get().embedding).buffer);
      const dist = Math.sqrt(newer.reduce((acc, x, i) => acc + (x - got[i]) ** 2, 0));
      expect(dist).toBeLessThan(0.01); // the rewritten vector (dequantized), not the old backup one
    } finally { db2.close(); }
  });

  it('parses --db=PATH, rejects unknown arguments and a backup taken from another DB', () => {
    const r = spawnSync(process.execPath, [SCRIPT, `--db=${dbPath}`, '--dry-run'], { env, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`db: ${dbPath}`);
    const bad = spawnSync(process.execPath, [SCRIPT, '--db', dbPath, '--dryrun'], { env, encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/unknown argument: --dryrun/);

    expect(run('--backup-dir', path.join(dir, 'bk')).status).toBe(0);
    const copy = path.join(dir, 'copy.sqlite');
    fs.copyFileSync(dbPath, copy);
    const file = path.join(dir, 'bk', fs.readdirSync(path.join(dir, 'bk'))[0]);
    const other = spawnSync(process.execPath, [SCRIPT, '--db', copy, '--restore', file], { env, encoding: 'utf8' });
    expect(other.status).toBe(2);
    expect(other.stderr).toMatch(/backup was taken from/);
  });

  it('--restore rejects the migration-only arguments (no silent real restore under --dry-run), and repeats', () => {
    expect(run('--backup-dir', path.join(dir, 'bk')).status).toBe(0);
    const file = path.join(dir, 'bk', fs.readdirSync(path.join(dir, 'bk'))[0]);
    const before = fs.readFileSync(dbPath);
    for (const extra of [['--dry-run'], ['--backup-dir', path.join(dir, 'x')]]) {
      const r = run('--restore', file, ...extra);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toMatch(new RegExp(`${extra[0]} cannot be used with --restore`));
    }
    const mig = run('--allow-other-db', '--dry-run');
    expect(mig.status).toBe(1);
    expect(mig.stderr).toMatch(/--allow-other-db cannot be used with a migration/);
    const dup = run('--db', dbPath, '--dry-run');
    expect(dup.status).toBe(1);
    expect(dup.stderr).toMatch(/--db given more than once/);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    const db = openRaw(dbPath);
    try { expect(getVecQuant(db, 'vec_facts')).toEqual({ dtype: 'int8', scale: FACT_VEC_INT8_SCALE }); } finally { db.close(); }
  });

  it('a backup taken with a relative --db restores from another working directory', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--db', 'db.sqlite', '--backup-dir', 'bk'], { env, encoding: 'utf8', cwd: dir });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const file = path.join(dir, 'bk', fs.readdirSync(path.join(dir, 'bk'))[0]);
    const header = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n')[0]);
    expect(header.db).toBe(fs.realpathSync(path.join(dir, 'db.sqlite'))); // absolute and symlink-free (tmpdir is /var → /private/var on macOS)
    const back = spawnSync(process.execPath, [SCRIPT, '--db', dbPath, '--restore', file], { env, encoding: 'utf8', cwd: os.tmpdir() });
    expect(back.status, back.stdout + back.stderr).toBe(0);
  });

  it('a failed second swap leaves the first table migrated (scale recorded, readable) and the failure reported', () => {
    // An extra auxiliary column is a schema the rebuild refuses — the second table fails after the first committed.
    const db0 = openRaw(dbPath);
    try {
      db0.exec('DROP TABLE vec_facts_kr');
      db0.exec('CREATE VIRTUAL TABLE vec_facts_kr USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[384], +note TEXT)');
      db0.prepare('INSERT INTO vec_facts_kr (id, embedding, note) VALUES (?, ?, ?)').run('k-1', Buffer.from(new Float32Array(vec(1)).buffer), 'x');
    } finally { db0.close(); }
    const r = run('--backup-dir', path.join(dir, 'bk'));
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/vec_facts: ✅ 1125 rows → int8@600/);
    expect(r.stderr).toMatch(/unsupported vec0 schema/);
    const db = openRaw(dbPath);
    try {
      expect(getVecQuant(db, 'vec_facts')).toEqual({ dtype: 'int8', scale: FACT_VEC_INT8_SCALE });
      expect(getVecQuant(db, 'vec_facts_kr').dtype).toBe('float32');
      expect(bytesById(db, 'vec_facts_kr').size).toBe(1);
    } finally { db.close(); }
  });

  it('refuses while memory-bank code older than 1.7.7 runs WITHOUT holding the DB yet (opens it on first search)', async () => {
    const lazyRoot = path.join(dir, 'lazy-plugin');
    fs.mkdirSync(path.join(lazyRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(lazyRoot, 'package.json'), JSON.stringify({ name: 'memory-bank', version: '1.7.6' }));
    fs.writeFileSync(path.join(lazyRoot, 'dist', 'mcp-server.js'), "console.log('up'); setTimeout(()=>{}, 60000);");
    const idle = spawn(process.execPath, [path.join(lazyRoot, 'dist', 'mcp-server.js')], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve) => idle.stdout!.once('data', () => resolve()));
      const r = run('--backup-dir', path.join(dir, 'bk'));
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stdout).toMatch(new RegExp(`process ${idle.pid}: BLOCKS — runs 1\\.7\\.6 < 1\\.7\\.7`));
      expect(fs.existsSync(path.join(dir, 'bk'))).toBe(false);
    } finally {
      idle.kill();
    }
    await new Promise((resolve) => idle.once('exit', resolve));
  });

  it('refuses (rc 2, nothing swapped) while a process running old code holds the DB, or an install dir is stale', async () => {
    // A fake 1.7.6 code root whose dist/holder.js opens the DB and waits.
    const oldRoot = path.join(dir, 'old-plugin');
    fs.mkdirSync(path.join(oldRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(oldRoot, 'package.json'), JSON.stringify({ version: '1.7.6' }));
    fs.writeFileSync(path.join(oldRoot, 'dist', 'holder.js'),
      `const D=require(${JSON.stringify(createRequire(import.meta.url).resolve('better-sqlite3'))}); const db=new D(process.argv[2]); db.prepare('select 1').get(); console.log('open'); setTimeout(()=>{}, 60000);`);
    const holder = spawn(process.execPath, [path.join(oldRoot, 'dist', 'holder.js'), dbPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve) => holder.stdout!.once('data', () => resolve()));
      const r = run('--backup-dir', path.join(dir, 'bk'));
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stdout).toMatch(new RegExp(`process ${holder.pid}: BLOCKS — runs 1\\.7\\.6 < 1\\.7\\.7`));
      expect(fs.existsSync(path.join(dir, 'bk'))).toBe(false); // refused before the backup
    } finally {
      holder.kill();
    }
    await new Promise((resolve) => holder.once('exit', resolve));

    const stale = path.join(dir, 'plugin-cache', 'memory-bank-dev', 'memory-bank', '1.7.6');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'package.json'), JSON.stringify({ version: '1.7.6' }));
    const r2 = run('--backup-dir', path.join(dir, 'bk'));
    expect(r2.status, r2.stdout + r2.stderr).toBe(2);
    expect(r2.stdout).toMatch(/install dir .*1\.7\.6: BLOCKS — carries 1\.7\.6 < 1\.7\.7/);
    const db = openRaw(dbPath);
    try { expect(getVecQuant(db, 'vec_facts').dtype).toBe('float32'); } finally { db.close(); }
  });

  it('a damaged backup is refused before anything is swapped', () => {
    const r = run('--backup-dir', path.join(dir, 'bk'));
    expect(r.status).toBe(0);
    const file = path.join(dir, 'bk', fs.readdirSync(path.join(dir, 'bk'))[0]);
    const lines = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim().split('\n');
    lines.splice(5, 1); // drop one row
    fs.writeFileSync(file, zlib.gzipSync(lines.join('\n') + '\n'));
    const back = run('--restore', file);
    expect(back.status).toBe(1);
    expect(back.stderr).toMatch(/sha256 mismatch/);
    const db = openRaw(dbPath);
    try { expect(getVecQuant(db, 'vec_facts').dtype).toBe('int8'); } finally { db.close(); }
  });
});

describe('vec-migrate-guard', () => {
  const now = Date.now();
  const pkg = (version: string, mtimeMs: number) => () => ({ version, mtimeMs });
  const CMD = '/opt/homebrew/bin/node /Users/u/.claude/plugins/cache/memory-bank-dev/memory-bank/1.7.6/dist/mcp-server.js';

  it('finds the code root of plugin, repo and worker commands', () => {
    expect(holderCodeRoot(CMD)).toBe('/Users/u/.claude/plugins/cache/memory-bank-dev/memory-bank/1.7.6');
    expect(holderCodeRoot('node /repo/memory-bank/scripts/reembed-worker.js --x')).toBe('/repo/memory-bank');
    expect(holderCodeRoot('python3 something.py')).toBeNull();
  });

  it('staleInstallDirs reports installed plugin dirs whose content version is old (after live-apply: none)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugcache-'));
    try {
      const mk = (ver: string, content: string) => {
        const d = path.join(root, 'memory-bank-dev', 'memory-bank', ver);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: content }));
        return d;
      };
      const old = mk('1.7.6', '1.7.6');
      mk('1.7.5', '1.7.7'); // live-applied: old dir name, new content
      mk('1.7.7', '1.7.7');
      const bare = path.join(root, 'memory-bank-dev', 'memory-bank', '1.7.4');
      fs.mkdirSync(bare); // no package.json: which code a hook spawned from it runs is unknown → blocks
      fs.writeFileSync(path.join(root, 'memory-bank-dev', 'memory-bank', '.DS_Store'), ''); // not a dir → ignored
      fs.mkdirSync(path.join(root, 'memory-bank-dev', 'memory-bank', '.live-apply.lock')); // live-apply bookkeeping → ignored
      const got = staleInstallDirs('1.7.7', root).sort((a, b) => a.dir.localeCompare(b.dir)); // readdir order is not guaranteed
      expect(got).toEqual([{ dir: bare, version: null }, { dir: old, version: '1.7.6' }]);
      expect(staleInstallDirs('1.7.7', path.join(root, 'missing'))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('process scan: judges the MCP server child, skips its wrapper (never opens the DB), respects the scan-root boundary', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbscan-'));
    const plugin = path.join(root, 'plugin');
    const procs: ReturnType<typeof spawn>[] = [];
    try {
      for (const d of ['dist', 'cli']) fs.mkdirSync(path.join(plugin, d), { recursive: true });
      fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'memory-bank', version: '1.7.6' }));
      const idle = "process.stdout.write('up'); setTimeout(() => {}, 60000);";
      fs.writeFileSync(path.join(plugin, 'dist', 'mcp-server.js'), idle);
      fs.writeFileSync(path.join(plugin, 'cli', 'mcp-server-wrapper.js'), idle);
      for (const f of ['dist/mcp-server.js', 'cli/mcp-server-wrapper.js']) {
        const c = spawn(process.execPath, [path.join(plugin, f)], { stdio: ['ignore', 'pipe', 'ignore'] });
        procs.push(c);
        await new Promise<void>((resolve) => c.stdout!.once('data', () => resolve()));
      }
      const pids = listMemoryBankProcesses(process.pid, root).map((h) => h.pid);
      expect(pids).toContain(procs[0].pid);
      expect(pids).not.toContain(procs[1].pid);
      expect(listMemoryBankProcesses(process.pid, `${root}x`).map((h) => h.pid)).not.toContain(procs[0].pid);
      expect(isInside(`${root}/a`, root)).toBe(true);
      expect(isInside(root, root)).toBe(true);
      expect(isInside(`${root}x/a`, root)).toBe(false); // a string prefix is not containment
      expect(isInside(`${root}/..x`, root)).toBe(true);  // a child named "..x" is inside
      expect(isInside(path.dirname(root), root)).toBe(false);
    } finally {
      for (const c of procs) c.kill();
      await Promise.all(procs.map((c) => new Promise((resolve) => (c.exitCode !== null ? resolve(null) : c.once('exit', resolve)))));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses ps etime', () => {
    expect(parseEtime('05:07')).toBe(307);
    expect(parseEtime('1:02:03')).toBe(3723);
    expect(parseEtime('2-01:00:00')).toBe(2 * 86400 + 3600);
    expect(parseEtime('garbage')).toBeNull();
  });

  it('blocks old versions, processes older than their code, unknown processes; passes new code started after the update', () => {
    const v = (version: string, mtime: number, startedAtMs: number | null, command = CMD) =>
      assessDbHolders([{ pid: 1, command, startedAtMs }], pkg(version, mtime))[0];
    expect(VEC_SCALE_MIN_VERSION).toBe('1.7.7');
    expect(v('1.7.6', now - 60_000, now - 1_000).ok).toBe(false);
    expect(v('1.7.7', now - 1_000, now - 60_000).ok).toBe(false);            // live-apply landed, child not swapped yet
    expect(v('1.7.7', now - 60_000, now - 59_000).ok).toBe(false);           // inside the 2s ambiguity margin
    expect(v('1.7.7', now - 60_000, null).ok).toBe(false);
    expect(v('1.7.7', now - 60_000, now - 1_000, 'sqlite3 db.sqlite').ok).toBe(false);
    expect(v('1.7.7', now - 60_000, now - 1_000).ok).toBe(true);
    expect(v('1.8.0', now - 60_000, now - 1_000).ok).toBe(true);
    expect(assessDbHolders([{ pid: 1, command: CMD, startedAtMs: now }], () => null)[0].ok).toBe(false);
  });
});
