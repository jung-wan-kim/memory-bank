import type Database from 'better-sqlite3';
export declare function getSyncDir(): string;
/** Where this install records its own last export (see OwnExportState). */
export declare function ownExportStatePath(): string;
/**
 * Export facts, ontology domains/categories, and relations to JSONL files for
 * cross-device sync (cc-sync, iCloud, etc). The local SQLite DB itself is not synced.
 *
 * A file is rewritten only when its content changed: each file's sha256 and
 * byte count are kept in meta.json, and a file whose new content hashes the same
 * — and that still exists at that size — is left alone, mtime included. The
 * export used to rewrite everything at every session end, straight onto the
 * final paths: 103MB per session on a DB with 30k facts (measured 2026-11-10),
 * for files that had not changed and that nothing was collecting. The
 * fingerprint is the content itself, not (count, max(updated_at)): a category
 * re-assignment does not touch updated_at, and a deactivation plus an insert
 * keeps the count.
 *
 * Files that are written go through a temp file + rename (writeAtomic).
 * meta.json is written last, and only when a data file was written or the meta
 * on disk does not describe this content.
 *
 * An active fact the import refuses is not exported (syncFactRefusal — fact
 * validity, a credential-shaped string, an instruction aimed at the model):
 * the files used to carry rows stored before those checks existed, a bot token
 * among them, and every receiving device refused the same 875 lines at every
 * session start (measured 2026-11-11). The fact stays in this database as it
 * is — scripts/redact-secret-facts.mjs deactivates the credential-shaped ones.
 * `withheld` / `withheldByReason` and meta.json's `withheld_facts` say how many
 * were left out and why (counts only). Relations are exported as before: one
 * that names a fact the receiving device does not have is counted there.
 *
 * The facts are judged when something the judgment depends on changed — a row
 * of an active fact, or the judgment code — and otherwise the last judgment
 * stands (JudgedFacts): the counts above and the fingerprint of facts.jsonl
 * come from the record, and the file, being up to date, is not touched. When
 * facts.jsonl has to be written, it is written from a judgment made in that
 * call, never from the record.
 *
 * `written` names the files this call rewrote ([] = nothing changed).
 */
export declare function exportForSync(): {
    facts: number;
    domains: number;
    categories: number;
    relations: number;
    written: string[];
    withheld: number;
    withheldByReason: Record<string, number>;
};
/**
 * Data files in sync/ whose size is not the one meta.json declares: the folder
 * was read while an export or a folder-sync tool was still delivering it (a
 * data file and meta.json from different exports). [] when meta.json is
 * absent, unreadable, or written by a version that recorded no sizes — there
 * is nothing to compare against. Sizes only: the content is not re-hashed.
 */
export declare function syncFilesNotMatchingMeta(syncDir: string): string[];
/**
 * Whether sync/ still holds exactly what THIS install exported last and the
 * local DB still has every row it had then — in which case an import has
 * nothing to add and need not read the files (it read ~100MB and ran ~80k id
 * lookups at every session start to find 0 new rows; measured 2026-11-10).
 *
 * All of these must hold, else false (the import runs in full, as before):
 *  - meta.json names this host, and its text is byte-for-byte the one this
 *    install recorded in ownExportStatePath(). The hostname alone is not
 *    enough: two of a user's machines can share one, and the device that never
 *    imports the other's files would stay silent about it.
 *  - every data file is still there at the size and mtime it had after the
 *    export (a tool that replaced one file but not meta.json is caught here).
 *  - no table behind the export has fewer rows than at export time. The import
 *    is also how a rebuilt or restored DB gets its facts back from this
 *    install's own files — that must keep working. Row totals (inactive facts
 *    included, so an inactive row cannot stand in for a lost active one), not
 *    the exported counts.
 *
 * Known limit: rows lost AND at least as many new ones added since the export
 * read as "nothing lost". The files' content is not re-hashed (that is the
 * read this check exists to avoid).
 */
export declare function ownExportStillInDb(db: Database.Database, syncDir: string): boolean;
