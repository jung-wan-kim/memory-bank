import fs from 'fs';
import path from 'path';
import { getIndexDir } from './paths.js';
/** `<indexDir>/backups/<label>-<timestamp>.sqlite` — never an existing file. */
export function newBackupPath(label) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(getIndexDir(), 'backups', `${label}-${ts}.sqlite`);
}
/** Copy the given SELECTs into a new sqlite file; returns rows copied per table. */
export function writeRowBackup(db, backupPath, copies) {
    // Never clobber: a backup is the only copy of rows about to be deleted.
    if (fs.existsSync(backupPath))
        throw new Error(`backup already exists: ${backupPath}`);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    const counts = {};
    db.exec(`ATTACH DATABASE '${backupPath.replace(/'/g, "''")}' AS bak`);
    try {
        // A read snapshot of the source, NOT its write lock. The count and the
        // copy below read the same snapshot (WAL: the transaction's first read
        // pins it), so the copy is verified against exactly what it was taken
        // from — as it was under BEGIN IMMEDIATE — while other processes keep
        // writing. Under the write lock a large copy (measured: about a minute
        // for 131,380 exchanges) failed every other process's write, and every
        // DB open, with "database is locked" after their 5s wait. Only the backup
        // file is written in this transaction.
        // The snapshot does not stop rows from ARRIVING meanwhile: a caller that
        // deletes by the ids it backed up needs nothing more; one that deletes
        // more than that checks for late rows itself (rebuild:
        // exchangesMissingFromBackup).
        db.exec('BEGIN');
        try {
            for (const copy of copies) {
                if (!/^[a-z_][a-z0-9_]*$/i.test(copy.table))
                    throw new Error(`invalid backup table name: ${copy.table}`);
                const params = copy.params ?? [];
                const expected = db.prepare(`SELECT count(*) AS n FROM (${copy.select})`).get(...params).n;
                db.prepare(`CREATE TABLE bak.${copy.table} AS ${copy.select}`).run(...params);
                const copied = db.prepare(`SELECT count(*) AS n FROM bak.${copy.table}`).get().n;
                if (copied !== expected) {
                    throw new Error(`backup row mismatch for ${copy.table}: copied ${copied}, expected ${expected}`);
                }
                counts[copy.table] = copied;
            }
            db.exec('COMMIT');
        }
        catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    }
    catch (e) {
        try {
            db.exec('DETACH DATABASE bak');
        }
        catch { /* reported below */ }
        // A failed run must not leave a half-written file that looks like a backup.
        try {
            fs.unlinkSync(backupPath);
        }
        catch { /* nothing was written */ }
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
export function backupExchangeRows(db, ids, backupPath) {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS backup_ids (id TEXT PRIMARY KEY)');
    db.exec('DELETE FROM temp.backup_ids');
    const add = db.prepare('INSERT OR IGNORE INTO temp.backup_ids (id) VALUES (?)');
    db.transaction(() => { for (const id of ids)
        add.run(id); })();
    try {
        const counts = writeRowBackup(db, backupPath, [
            { table: 'exchanges', select: 'SELECT * FROM exchanges WHERE id IN (SELECT id FROM temp.backup_ids)' },
            { table: 'tool_calls', select: 'SELECT * FROM tool_calls WHERE exchange_id IN (SELECT id FROM temp.backup_ids)' },
        ]);
        return { exchanges: counts.exchanges, toolCalls: counts.tool_calls };
    }
    finally {
        db.exec('DELETE FROM temp.backup_ids');
    }
}
