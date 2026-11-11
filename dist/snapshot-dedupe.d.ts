import type Database from 'better-sqlite3';
export interface SnapshotDedupePlan {
    /** Turns that have more than one row. */
    turns: number;
    /** Rows to remove (every row of those turns but one). */
    extraRows: number;
    /** Conversation files those turns are in. */
    files: number;
    /** Most rows held for a single turn. */
    maxRowsPerTurn: number;
    /** Facts whose source_exchange_ids name a row to remove. */
    factsToRewrite: number;
    /** Facts whose source_exchange_ids is not valid JSON — left alone, not searched. */
    factsWithInvalidSources: number;
}
/**
 * Find the duplicate snapshots (fills temp.snapshot_stale) and count what an
 * apply would do. Reads only — safe on a read-only connection (the worklist
 * lives in the temp schema).
 */
export declare function planSnapshotDedupe(db: Database.Database): SnapshotDedupePlan;
export interface SnapshotDedupeResult {
    plan: SnapshotDedupePlan;
    backupPath: string | null;
    deletedRows: number;
    rewrittenFacts: number;
    /** Duplicate rows still there after the run (0 unless another process wrote some meanwhile). */
    remainingExtraRows: number;
}
/** Facts whose source list is re-pointed in one write transaction (see repointFactsAtKeptSnapshots). */
export declare const REPOINT_BATCH_ROWS = 500;
export interface RepointFactsOptions {
    /** Facts per write transaction (default REPOINT_BATCH_ROWS). */
    batchSize?: number;
    /** Commit a batch once it has held the write lock this long (default DELETE_BATCH_MAX_MS). 0 = one fact per batch. */
    maxBatchMs?: number;
    /** Wait this long between two batches (default DELETE_BATCH_PAUSE_MS). 0 = none. */
    pauseMs?: number;
    /** Called after each committed batch with the facts gone through so far; no transaction is open here. */
    onBatch?: (done: number) => void;
}
/**
 * Point the facts that name a snapshot in temp.snapshot_stale at the row that
 * stays (planSnapshotDedupe must have filled the table on this connection).
 * Returns how many facts were changed. The fact itself is not touched —
 * updated_at stays.
 *
 * It was one write transaction that searched every fact's source list
 * (json_each over 61MB on the measured DB) and then wrote 13,573 rows: the
 * write lock was held for 3.3 to 5.4s, and every other process waits 5s for
 * it and then fails. Now, the shape repointQueuedExchangeSources (db.ts) has:
 *  1. the search and the new lists are done WITHOUT the write lock;
 *  2. the writes go REPOINT_BATCH_ROWS facts per transaction (or until the
 *     batch has taken DELETE_BATCH_MAX_MS), with a pause between two batches
 *     in which a waiting process takes the lock;
 *  3. inside its batch each fact is read again: unchanged since step 1, it
 *     gets the list computed there; changed meanwhile, the list is computed
 *     from what is stored now (and left alone if that names no such snapshot).
 * A run that stops between two batches has re-pointed some facts and not the
 * others; no row was deleted yet, and running it again finishes.
 */
export declare function repointFactsAtKeptSnapshots(db: Database.Database, opts?: RepointFactsOptions): number;
export interface SnapshotDedupeOptions {
    /** How the fact sources are re-pointed (batch size, pauses, progress). */
    repoint?: RepointFactsOptions;
}
/**
 * Back up, re-point the facts, delete the extra rows. Order matters for an
 * interrupted run: facts are re-pointed BEFORE the rows go, so no fact ever
 * names a deleted row; a re-run finds the rows that are left and finishes.
 */
export declare function applySnapshotDedupe(db: Database.Database, backupPath: string, opts?: SnapshotDedupeOptions): SnapshotDedupeResult;
