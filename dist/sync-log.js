import fs from 'fs';
import path from 'path';
import { getIndexDir } from './paths.js';
/**
 * One line per sync run in `<index dir>/logs/sync.jsonl`.
 *
 * The SessionStart hook starts the sync detached with stdio ignored, so what
 * it printed — counts and per-file errors — went nowhere: a conversation that
 * was copied but could not be read or indexed left no trace anywhere (measured
 * 2026-11-10: 7 archived conversations with an exchange and no row, cause
 * unknown for lack of any log).
 */
const LOG_MAX_BYTES = 1024 * 1024;
/** Per-file errors kept per line; the count is always the full number. */
export const SYNC_LOG_ERROR_SAMPLES = 20;
export function syncLogPath() {
    return path.join(getIndexDir(), 'logs', 'sync.jsonl');
}
/** Append one line. A log that cannot be written is reported on stderr and never fails the sync. */
export function appendSyncLog(entry) {
    const file = syncLogPath();
    const { errors, ...rest } = entry;
    const line = { ts: new Date().toISOString(), pid: process.pid, ...rest };
    if (errors) {
        line.errors = errors.length;
        if (errors.length > 0)
            line.error_samples = errors.slice(0, SYNC_LOG_ERROR_SAMPLES);
    }
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
            if (fs.statSync(file).size > LOG_MAX_BYTES)
                fs.renameSync(file, `${file}.1`);
        }
        catch { /* no file yet */ }
        fs.appendFileSync(file, JSON.stringify(line) + '\n');
    }
    catch (e) {
        console.error('sync: cannot write the sync log:', e instanceof Error ? e.message : e);
    }
}
