import type Database from 'better-sqlite3';
/**
 * Row backups taken before a maintenance command deletes or empties something.
 *
 * A backup is a plain sqlite file holding copies of the rows (CREATE TABLE AS
 * SELECT — data only, no indexes or constraints). It is written and counted in
 * ONE transaction with the read of the source rows (one read snapshot — the
 * source's write lock is not taken), and the caller deletes only after this
 * returns: a copy that does not hold exactly the rows it was asked for throws,
 * and the half-written file is removed.
 *
 * Restore by hand: ATTACH the file and `INSERT INTO main.<table> SELECT * FROM
 * bak.<table>` (vectors are not in it — the re-embed worker rebuilds those).
 */
export interface BackupCopy {
    /** Table name inside the backup file. */
    table: string;
    /** SELECT producing the rows to copy (main DB; may read temp tables). */
    select: string;
    params?: unknown[];
}
/** `<indexDir>/backups/<label>-<timestamp>.sqlite` — never an existing file. */
export declare function newBackupPath(label: string): string;
/** Copy the given SELECTs into a new sqlite file; returns rows copied per table. */
export declare function writeRowBackup(db: Database.Database, backupPath: string, copies: BackupCopy[]): Record<string, number>;
/**
 * Back up the given exchanges with their tool calls. Returns how many rows of
 * each the file holds — an id that no longer exists is simply not in it, so
 * the caller compares the count with what it is about to delete.
 */
export declare function backupExchangeRows(db: Database.Database, ids: readonly string[], backupPath: string): {
    exchanges: number;
    toolCalls: number;
};
