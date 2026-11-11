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
export function ensurePrivateDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    }
    return dir;
}
/**
 * Create a file owner-only if it does not exist yet (its directory too).
 * `wx` so that a file another process created in between is never truncated.
 */
export function ensurePrivateFile(file) {
    if (!POSIX || fs.existsSync(file))
        return;
    ensurePrivateDir(path.dirname(file));
    try {
        fs.closeSync(fs.openSync(file, 'wx', OWNER_ONLY_FILE_MODE));
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
}
function tighten(target, mode, result) {
    try {
        const stat = fs.lstatSync(target);
        if ((stat.mode & 0o077) === 0)
            return;
        fs.chmodSync(target, mode);
        result.changed.push(target);
    }
    catch (error) {
        result.failed.push({ path: target, error: error.message });
    }
}
/**
 * Tighten an existing install: the index dir, its `sync` and `logs` dirs and
 * the sibling archive dir become 0700, and the regular files directly inside
 * the first three (database, -wal/-shm, backups, sync files, logs) 0600.
 *
 * The archive is closed at its top directory only — it holds hundreds of
 * thousands of files, and a 0700 parent already keeps other accounts out.
 * Executables (the native client under `bin/`) keep their mode.
 *
 * Symlinks: the index dir itself may be one (the index kept on another volume
 * and linked into the config dir). The database is created and opened through
 * it, so the directory it points at is the one tightened — skipping it as "a
 * symlink" left that directory 0755 and the database 0644 while the pass
 * recorded itself as done. A symlink BELOW the index dir (a `sync` folder
 * linked into a cloud folder) and a linked archive are not followed: where
 * they point is the user's layout. They are returned in `skippedLinks` so the
 * caller can say so.
 */
export function tightenConfigTree(indexDir) {
    const result = { changed: [], failed: [], skippedLinks: [] };
    if (!POSIX)
        return result;
    // Only when the index dir is itself the link: an ordinary install keeps the paths it was given.
    let root = indexDir;
    let linked = false;
    try {
        linked = fs.lstatSync(indexDir).isSymbolicLink();
    }
    catch { /* not there — the loop below skips it */ }
    if (linked) {
        try {
            root = fs.realpathSync(indexDir);
        }
        catch (error) {
            // A link whose target cannot be resolved: nothing was tightened — a failure, not a finished pass.
            result.failed.push({ path: indexDir, error: error.message });
            return result;
        }
    }
    const dirs = [root, path.join(root, 'sync'), path.join(root, 'logs')];
    const archiveDir = path.join(path.dirname(indexDir), 'conversation-archive');
    for (const dir of [...dirs, archiveDir]) {
        let stat;
        try {
            stat = fs.lstatSync(dir);
        }
        catch {
            continue; // not there — nothing to tighten
        }
        if (stat.isSymbolicLink()) {
            result.skippedLinks.push(dir);
            continue;
        } // not followed, but reported
        if (!stat.isDirectory())
            continue; // a file: not ours to change
        tighten(dir, OWNER_ONLY_DIR_MODE, result);
        if (dir === archiveDir)
            continue;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch (error) {
            result.failed.push({ path: dir, error: error.message });
            continue;
        }
        for (const entry of entries) {
            if (!entry.isFile())
                continue;
            const file = path.join(dir, entry.name);
            try {
                if ((fs.lstatSync(file).mode & 0o111) !== 0)
                    continue; // executable: leave
            }
            catch {
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
export function tightenConfigTreeOnce(indexDir) {
    if (!POSIX)
        return null;
    const marker = path.join(indexDir, PERMS_MARKER);
    if (fs.existsSync(marker))
        return null;
    const result = tightenConfigTree(indexDir);
    if (result.failed.length > 0) {
        const first = result.failed[0];
        process.stderr.write(`memory-bank: could not make ${result.failed.length} path(s) owner-only (first: ${first.path}: ${first.error}) — will retry\n`);
        return result;
    }
    if (result.skippedLinks.length > 0) {
        // Said once (the marker below ends the pass): these were not followed, so their modes are whatever they were.
        process.stderr.write(`memory-bank: left ${result.skippedLinks.length} symlinked folder(s) as they are (${result.skippedLinks.join(', ')}) — a symlink is not followed; set the permissions of what it points at yourself\n`);
    }
    try {
        fs.writeFileSync(marker, `${new Date().toISOString()} changed=${result.changed.length} skipped_links=${result.skippedLinks.length}\n`, { mode: OWNER_ONLY_FILE_MODE });
    }
    catch (error) {
        process.stderr.write(`memory-bank: could not record the owner-only pass (${marker}): ${error.message}\n`);
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
export function preparePrivateDbFile(dbPath) {
    if (!POSIX)
        return;
    ensurePrivateFile(dbPath);
    const indexDir = path.dirname(dbPath);
    if (path.basename(dbPath) === 'db.sqlite' && path.basename(indexDir) === 'conversation-index') {
        tightenConfigTreeOnce(indexDir);
    }
}
