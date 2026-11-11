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
export declare const OWNER_ONLY_DIR_MODE = 448;
export declare const OWNER_ONLY_FILE_MODE = 384;
/** Marker (in the index dir) of a finished one-time pass over an existing install. */
export declare const PERMS_MARKER = ".owner-only-v1";
/** Create a directory (and missing parents) owner-only. An existing one is left as it is. */
export declare function ensurePrivateDir(dir: string): string;
/**
 * Create a file owner-only if it does not exist yet (its directory too).
 * `wx` so that a file another process created in between is never truncated.
 */
export declare function ensurePrivateFile(file: string): void;
export interface TightenResult {
    /** Directories and files whose mode was changed. */
    changed: string[];
    /** Paths that could not be changed, with the reason. */
    failed: Array<{
        path: string;
        error: string;
    }>;
    /** Symlinked folders below the index dir (or the archive link) that were left as they are — not followed. */
    skippedLinks: string[];
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
export declare function tightenConfigTree(indexDir: string): TightenResult;
/**
 * The one-time pass for an install that predates owner-only creation. Runs
 * when the marker is absent; the marker is written only after a pass with no
 * failure, so a failed pass is tried again on the next open and says why on
 * stderr each time. Never throws — permissions must not stop the database
 * from opening.
 */
export declare function tightenConfigTreeOnce(indexDir: string): TightenResult | null;
/**
 * Called by initDatabase() before it opens the database: a new database file
 * is created 0600, and an existing standard install
 * (`…/conversation-index/db.sqlite`) gets its one-time pass. A database at an
 * overridden path (MEMORY_BANK_DB_PATH / TEST_DB_PATH) is created owner-only
 * too, but the directories around it are someone else's layout and are left
 * alone.
 */
export declare function preparePrivateDbFile(dbPath: string): void;
