import fs from 'fs';
import path from 'path';

/**
 * Owner-only permissions for what this plugin stores.
 *
 * Claude Code writes its transcripts 0600. The index held the same text in
 * files created with the process umask — database, backups, sync files and
 * logs 0644 in directories 0755 — so any other account on the machine could
 * read every indexed conversation. New directories are created 0700 and a new
 * database 0600 (SQLite gives -wal/-shm the mode of the main file); an
 * existing install is tightened once.
 *
 * POSIX only: on Windows these modes mean nothing and every function returns
 * without touching anything.
 */
export const OWNER_ONLY_DIR_MODE = 0o700;
export const OWNER_ONLY_FILE_MODE = 0o600;

/** Marker (in the index dir) of a finished one-time pass over an existing install. */
export const PERMS_MARKER = '.owner-only-v1';

const POSIX = process.platform !== 'win32';

/** Create a directory (and missing parents) owner-only. An existing one is left as it is. */
export function ensurePrivateDir(dir: string): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
  }
  return dir;
}

/**
 * Create a file owner-only if it does not exist yet (its directory too).
 * `wx` so that a file another process created in between is never truncated.
 */
export function ensurePrivateFile(file: string): void {
  if (!POSIX || fs.existsSync(file)) return;
  ensurePrivateDir(path.dirname(file));
  try {
    fs.closeSync(fs.openSync(file, 'wx', OWNER_ONLY_FILE_MODE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export interface TightenResult {
  /** Directories and files whose mode was changed. */
  changed: string[];
  /** Paths that could not be changed, with the reason. */
  failed: Array<{ path: string; error: string }>;
}

function tighten(target: string, mode: number, result: TightenResult): void {
  try {
    const stat = fs.lstatSync(target);
    if ((stat.mode & 0o077) === 0) return;
    fs.chmodSync(target, mode);
    result.changed.push(target);
  } catch (error) {
    result.failed.push({ path: target, error: (error as Error).message });
  }
}

/**
 * Tighten an existing install: the index dir, its `sync` and `logs` dirs and
 * the sibling archive dir become 0700, and the regular files directly inside
 * the first three (database, -wal/-shm, backups, sync files, logs) 0600.
 *
 * The archive is closed at its top directory only — it holds hundreds of
 * thousands of files, and a 0700 parent already keeps other accounts out.
 * Symlinks are never followed, and executables (the native client under
 * `bin/`) keep their mode.
 */
export function tightenConfigTree(indexDir: string): TightenResult {
  const result: TightenResult = { changed: [], failed: [] };
  if (!POSIX) return result;

  const dirs = [indexDir, path.join(indexDir, 'sync'), path.join(indexDir, 'logs')];
  const archiveDir = path.join(path.dirname(indexDir), 'conversation-archive');
  for (const dir of [...dirs, archiveDir]) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      continue; // not there — nothing to tighten
    }
    if (!stat.isDirectory()) continue; // a symlink or a file: not ours to change
    tighten(dir, OWNER_ONLY_DIR_MODE, result);
    if (dir === archiveDir) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      result.failed.push({ path: dir, error: (error as Error).message });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      try {
        if ((fs.lstatSync(file).mode & 0o111) !== 0) continue; // executable: leave
      } catch {
        continue; // gone meanwhile (a -wal/-shm removed by a checkpoint)
      }
      tighten(file, OWNER_ONLY_FILE_MODE, result);
    }
  }
  return result;
}

/**
 * The one-time pass for an install that predates owner-only creation. Runs
 * when the marker is absent; the marker is written only after a pass with no
 * failure, so a failed pass is tried again on the next open and says why on
 * stderr each time. Never throws — permissions must not stop the database
 * from opening.
 */
export function tightenConfigTreeOnce(indexDir: string): TightenResult | null {
  if (!POSIX) return null;
  const marker = path.join(indexDir, PERMS_MARKER);
  if (fs.existsSync(marker)) return null;
  const result = tightenConfigTree(indexDir);
  if (result.failed.length > 0) {
    const first = result.failed[0];
    process.stderr.write(`memory-bank: could not make ${result.failed.length} path(s) owner-only (first: ${first.path}: ${first.error}) — will retry\n`);
    return result;
  }
  try {
    fs.writeFileSync(marker, `${new Date().toISOString()} changed=${result.changed.length}\n`, { mode: OWNER_ONLY_FILE_MODE });
  } catch (error) {
    process.stderr.write(`memory-bank: could not record the owner-only pass (${marker}): ${(error as Error).message}\n`);
  }
  return result;
}

/**
 * Called by initDatabase() before it opens the database: a new database file
 * is created 0600, and an existing standard install
 * (`…/conversation-index/db.sqlite`) gets its one-time pass. A database at an
 * overridden path (MEMORY_BANK_DB_PATH / TEST_DB_PATH) is created owner-only
 * too, but the directories around it are someone else's layout and are left
 * alone.
 */
export function preparePrivateDbFile(dbPath: string): void {
  if (!POSIX) return;
  ensurePrivateFile(dbPath);
  const indexDir = path.dirname(dbPath);
  if (path.basename(dbPath) === 'db.sqlite' && path.basename(indexDir) === 'conversation-index') {
    tightenConfigTreeOnce(indexDir);
  }
}
