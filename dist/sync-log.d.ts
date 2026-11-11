/** Per-file errors kept per line; the count is always the full number. */
export declare const SYNC_LOG_ERROR_SAMPLES = 20;
export interface SyncLogEntry {
    /** ran = finished (per-file errors are in `errors`); failed = threw; terminated = stopped by a signal. */
    action: 'ran' | 'failed' | 'terminated';
    version: string;
    duration_ms: number;
    copied?: number;
    skipped?: number;
    indexed?: number;
    summarized?: number;
    errors?: Array<{
        file: string;
        error: string;
    }>;
    error?: string;
    signal?: string;
}
export declare function syncLogPath(): string;
/** Append one line. A log that cannot be written is reported on stderr and never fails the sync. */
export declare function appendSyncLog(entry: SyncLogEntry): void;
