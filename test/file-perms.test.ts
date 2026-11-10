import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePrivateFile, tightenConfigTree, tightenConfigTreeOnce, preparePrivateDbFile, PERMS_MARKER } from '../src/file-perms.js';

/**
 * SEC-05: Claude Code writes transcripts 0600, and the index stored the same
 * text world-readable (database, backups, sync files, logs 0644 in 0755 dirs).
 * What this plugin creates is owner-only, and an existing install is tightened
 * once. Everything runs in a temp config dir; the modes asserted are the ones
 * the files actually have on disk.
 */

const mode = (p: string) => fs.statSync(p).mode & 0o777;
const othersCanAccess = (p: string) => (fs.statSync(p).mode & 0o077) !== 0;

const ENV_KEYS = ['MEMORY_BANK_CONFIG_DIR', 'MEMORY_BANK_DB_PATH', 'TEST_DB_PATH', 'TEST_ARCHIVE_DIR', 'PERSONAL_SUPERPOWERS_DIR', 'XDG_CONFIG_HOME'];

describe.skipIf(process.platform === 'win32')('owner-only storage', () => {
  let tmp: string;
  let previousUmask: number;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-perms-'));
    for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
    process.env.MEMORY_BANK_CONFIG_DIR = path.join(tmp, 'config');
    // The usual desktop umask: without explicit modes, files come out 0644 and dirs 0755.
    previousUmask = process.umask(0o022);
  });
  afterEach(() => {
    process.umask(previousUmask);
    for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the config, index and archive dirs 0700', async () => {
    const { getSuperpowersDir, getIndexDir, getArchiveDir } = await import('../src/paths.js');
    expect(mode(getSuperpowersDir())).toBe(0o700);
    expect(mode(getIndexDir())).toBe(0o700);
    expect(mode(getArchiveDir())).toBe(0o700);
  });

  it('creates a new database 0600, and SQLite gives -wal/-shm the same mode', async () => {
    const { initDatabase } = await import('../src/db.js');
    const { getDbPath } = await import('../src/paths.js');
    const db = initDatabase();
    try {
      const dbPath = getDbPath();
      db.prepare(`INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end)
        VALUES ('e1', 'p', '2026-01-01T00:00:00Z', 'private question', 'private answer', '/a.jsonl', 1, 2)`).run();
      expect(mode(dbPath)).toBe(0o600);
      expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
      expect(mode(`${dbPath}-wal`)).toBe(0o600);
      expect(mode(`${dbPath}-shm`)).toBe(0o600);
      expect(mode(path.dirname(dbPath))).toBe(0o700);
    } finally {
      db.close();
    }
  });

  it('creates a database at an overridden path 0600 too, without touching the directory it was given', async () => {
    const shared = path.join(tmp, 'someone-elses-dir');
    fs.mkdirSync(shared, { mode: 0o755 });
    process.env.MEMORY_BANK_DB_PATH = path.join(shared, 'custom.sqlite');
    const { initDatabase } = await import('../src/db.js');
    initDatabase().close();
    expect(mode(path.join(shared, 'custom.sqlite'))).toBe(0o600);
    expect(mode(shared)).toBe(0o755);
    expect(fs.existsSync(path.join(shared, PERMS_MARKER))).toBe(false);
  });

  it('creates the sync dir 0700', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    expect(mode(getSyncDir())).toBe(0o700);
  });

  it('ensurePrivateFile never truncates a file that already exists', () => {
    const file = path.join(tmp, 'existing.sqlite');
    fs.writeFileSync(file, 'content', { mode: 0o644 });
    ensurePrivateFile(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('content');
    expect(mode(file)).toBe(0o644); // an existing file is the one-time pass's job, not this function's
  });

  describe('an install from before owner-only creation', () => {
    let indexDir: string;
    let archiveDir: string;

    beforeEach(() => {
      // What v1.7.9 left on disk: 0755 dirs, 0644 files.
      indexDir = path.join(tmp, 'config', 'conversation-index');
      archiveDir = path.join(tmp, 'config', 'conversation-archive');
      for (const dir of [indexDir, path.join(indexDir, 'sync'), path.join(indexDir, 'logs'), path.join(indexDir, 'bin'), path.join(archiveDir, 'project-a')]) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      }
      for (const file of ['db.sqlite', 'backup-20261003-pre-cleanup.sqlite', 'sync/facts.jsonl', 'logs/inject-context.jsonl']) {
        fs.writeFileSync(path.join(indexDir, file), 'x', { mode: 0o644 });
      }
      fs.writeFileSync(path.join(indexDir, 'bin', 'memory-bank-inject-client'), '#!/bin/sh\n', { mode: 0o755 });
      fs.writeFileSync(path.join(archiveDir, 'project-a', 'summary.txt'), 'x', { mode: 0o644 });
    });

    it('is closed to other accounts by one pass, which reports what it changed', () => {
      const before = ['db.sqlite', 'backup-20261003-pre-cleanup.sqlite', 'sync/facts.jsonl', 'logs/inject-context.jsonl'].map((f) => path.join(indexDir, f));
      for (const file of before) expect(othersCanAccess(file), file).toBe(true);

      const result = tightenConfigTree(indexDir);

      expect(result.failed).toEqual([]);
      for (const file of before) expect(mode(file), file).toBe(0o600);
      for (const dir of [indexDir, path.join(indexDir, 'sync'), path.join(indexDir, 'logs'), archiveDir]) expect(mode(dir), dir).toBe(0o700);
      expect(result.changed.sort()).toEqual([...before, indexDir, path.join(indexDir, 'sync'), path.join(indexDir, 'logs'), archiveDir].sort());
      // The archive is closed at its top directory; its contents and the executable native client keep their modes.
      expect(mode(path.join(archiveDir, 'project-a', 'summary.txt'))).toBe(0o644);
      expect(mode(path.join(indexDir, 'bin', 'memory-bank-inject-client'))).toBe(0o755);
      // A second pass finds nothing left to change.
      expect(tightenConfigTree(indexDir)).toEqual({ changed: [], failed: [], skippedLinks: [] });
    });

    it('gets that pass the first time its database is opened, and only then', async () => {
      const { initDatabase } = await import('../src/db.js');
      fs.rmSync(path.join(indexDir, 'db.sqlite')); // the placeholder above is not a database
      initDatabase().close();
      expect(mode(indexDir)).toBe(0o700);
      expect(mode(path.join(indexDir, 'backup-20261003-pre-cleanup.sqlite'))).toBe(0o600);
      expect(mode(path.join(indexDir, 'sync', 'facts.jsonl'))).toBe(0o600);
      expect(mode(archiveDir)).toBe(0o700);
      expect(fs.existsSync(path.join(indexDir, PERMS_MARKER))).toBe(true);

      // Later opens do not chmod again: a mode the user set afterwards stays.
      fs.chmodSync(path.join(indexDir, 'sync'), 0o750);
      initDatabase().close();
      expect(mode(path.join(indexDir, 'sync'))).toBe(0o750);
      expect(tightenConfigTreeOnce(indexDir)).toBeNull();
    });

    it('does not follow a symlinked directory', () => {
      const outside = path.join(tmp, 'outside');
      fs.mkdirSync(outside, { mode: 0o755 });
      fs.writeFileSync(path.join(outside, 'not-ours.txt'), 'x', { mode: 0o644 });
      fs.rmSync(path.join(indexDir, 'logs'), { recursive: true });
      fs.symlinkSync(outside, path.join(indexDir, 'logs'));
      const result = tightenConfigTree(indexDir);
      expect(result.failed).toEqual([]);
      expect(mode(outside)).toBe(0o755);
      expect(mode(path.join(outside, 'not-ours.txt'))).toBe(0o644);
    });

    it('tightens the directory a symlinked index dir points at (SEC-7)', () => {
      // The index kept somewhere else (another volume) and linked into the config dir. The database is
      // created and opened through the link, so the directory behind it is the one that holds the text.
      // The pass used to skip it as "a symlink", change nothing there, and still record itself as done.
      const real = path.join(tmp, 'elsewhere', 'index-data');
      fs.mkdirSync(path.dirname(real), { recursive: true });
      fs.renameSync(indexDir, real);
      fs.symlinkSync(real, indexDir);
      expect(othersCanAccess(path.join(real, 'db.sqlite'))).toBe(true);

      const result = tightenConfigTreeOnce(indexDir);

      expect(result?.failed).toEqual([]);
      expect(result?.skippedLinks).toEqual([]);
      for (const dir of [real, path.join(real, 'sync'), path.join(real, 'logs')]) expect(mode(dir), dir).toBe(0o700);
      for (const file of ['db.sqlite', 'backup-20261003-pre-cleanup.sqlite', 'sync/facts.jsonl', 'logs/inject-context.jsonl']) {
        expect(mode(path.join(real, file)), file).toBe(0o600);
      }
      expect(mode(path.join(real, 'bin', 'memory-bank-inject-client')), 'executables keep their mode').toBe(0o755);
      expect(fs.lstatSync(indexDir).isSymbolicLink(), 'the link itself is left as it is').toBe(true);
      expect(fs.existsSync(path.join(real, PERMS_MARKER))).toBe(true);
      expect(tightenConfigTreeOnce(indexDir)).toBeNull();
    });

    it('says which symlinked folder below the index dir it left alone (SEC-7)', () => {
      const outside = path.join(tmp, 'outside');
      fs.mkdirSync(outside, { mode: 0o755 });
      fs.writeFileSync(path.join(outside, 'not-ours.txt'), 'x', { mode: 0o644 });
      fs.rmSync(path.join(indexDir, 'sync'), { recursive: true });
      fs.symlinkSync(outside, path.join(indexDir, 'sync'));
      const written: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });
      let result;
      try {
        result = tightenConfigTreeOnce(indexDir);
      } finally {
        spy.mockRestore();
      }

      // Not followed — where the link points is the user's layout — but not passed over in silence either.
      expect(result?.skippedLinks).toEqual([path.join(indexDir, 'sync')]);
      expect(mode(outside)).toBe(0o755);
      expect(mode(path.join(outside, 'not-ours.txt'))).toBe(0o644);
      expect(written.join(''), 'stderr names the folder').toContain(path.join(indexDir, 'sync'));
      expect(written.join('')).toMatch(/symlink/);
      // The rest was tightened and the pass is recorded: the link is reported once, not at every open.
      expect(mode(path.join(indexDir, 'db.sqlite'))).toBe(0o600);
      expect(fs.readFileSync(path.join(indexDir, PERMS_MARKER), 'utf8')).toMatch(/skipped_links=1/);
    });

    it('does not report a finished pass when the index link points nowhere (SEC-7)', () => {
      fs.rmSync(indexDir, { recursive: true });
      fs.symlinkSync(path.join(tmp, 'unmounted-volume', 'index-data'), indexDir);
      const result = tightenConfigTree(indexDir);
      expect(result.changed).toEqual([]);
      expect(result.failed.map((f) => f.path)).toEqual([indexDir]);
    });

    it('preparePrivateDbFile leaves a non-standard layout alone', () => {
      const elsewhere = path.join(tmp, 'elsewhere');
      fs.mkdirSync(elsewhere, { mode: 0o755 });
      fs.writeFileSync(path.join(elsewhere, 'neighbour.txt'), 'x', { mode: 0o644 });
      preparePrivateDbFile(path.join(elsewhere, 'my.db'));
      expect(mode(path.join(elsewhere, 'my.db'))).toBe(0o600);
      expect(mode(elsewhere)).toBe(0o755);
      expect(mode(path.join(elsewhere, 'neighbour.txt'))).toBe(0o644);
    });
  });
});
