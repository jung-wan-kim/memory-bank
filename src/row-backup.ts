import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getIndexDir } from './paths.js';

/**
 * Row backups taken before a maintenance command deletes or empties something.
 *
 * A backup is a plain sqlite file holding copies of the rows (CREATE TABLE AS
 * SELECT — data only, no indexes or constraints). It is written and counted in
 * ONE transaction with the read of the source rows, and the caller deletes
 * only after this returns: a copy that does not hold exactly the rows it was
 * asked for throws, and the half-written file is removed.
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
export function newBackupPath(label: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(getIndexDir(), 'backups', `${label}-${ts}.sqlite`);
}

/** Copy the given SELECTs into a new sqlite file; returns rows copied per table. */
export function writeRowBackup(
  db: Database.Database,
  backupPath: string,
  copies: BackupCopy[],
): Record<string, number> {
  // Never clobber: a backup is the only copy of rows about to be deleted.
  if (fs.existsSync(backupPath)) throw new Error(`backup already exists: ${backupPath}`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });

  const counts: Record<string, number> = {};
  db.exec(`ATTACH DATABASE '${backupPath.replace(/'/g, "''")}' AS bak`);
  try {
    // IMMEDIATE: the write lock up front, so no other process changes the
    // source rows between the copy and the count it is verified against.
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const copy of copies) {
        if (!/^[a-z_][a-z0-9_]*$/i.test(copy.table)) throw new Error(`invalid backup table name: ${copy.table}`);
        const params = copy.params ?? [];
        const expected = (db.prepare(`SELECT count(*) AS n FROM (${copy.select})`).get(...params) as { n: number }).n;
        db.prepare(`CREATE TABLE bak.${copy.table} AS ${copy.select}`).run(...params);
        const copied = (db.prepare(`SELECT count(*) AS n FROM bak.${copy.table}`).get() as { n: number }).n;
        if (copied !== expected) {
          throw new Error(`backup row mismatch for ${copy.table}: copied ${copied}, expected ${expected}`);
        }
        counts[copy.table] = copied;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } catch (e) {
    try { db.exec('DETACH DATABASE bak'); } catch { /* reported below */ }
    // A failed run must not leave a half-written file that looks like a backup.
    try { fs.unlinkSync(backupPath); } catch { /* nothing was written */ }
    throw e;
  }
  db.exec('DETACH DATABASE bak');
  return counts;
}

/**
 * Back up the given exchanges with their tool calls. Returns how many rows of
 * each the file holds — an id that no longer exists is simply not in it, so
 * the caller compares the count with what it is about to delete.
 */
export function backupExchangeRows(
  db: Database.Database,
  ids: readonly string[],
  backupPath: string,
): { exchanges: number; toolCalls: number } {
  db.exec('CREATE TEMP TABLE IF NOT EXISTS backup_ids (id TEXT PRIMARY KEY)');
  db.exec('DELETE FROM temp.backup_ids');
  const add = db.prepare('INSERT OR IGNORE INTO temp.backup_ids (id) VALUES (?)');
  db.transaction(() => { for (const id of ids) add.run(id); })();
  try {
    const counts = writeRowBackup(db, backupPath, [
      { table: 'exchanges', select: 'SELECT * FROM exchanges WHERE id IN (SELECT id FROM temp.backup_ids)' },
      { table: 'tool_calls', select: 'SELECT * FROM tool_calls WHERE exchange_id IN (SELECT id FROM temp.backup_ids)' },
    ]);
    return { exchanges: counts.exchanges, toolCalls: counts.tool_calls };
  } finally {
    db.exec('DELETE FROM temp.backup_ids');
  }
}
