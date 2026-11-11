import type Database from 'better-sqlite3';
/** Keyset position `(created_at, id)` of the last fact the drain fully examined. */
export interface ConsolidateCursor {
    createdAt: string;
    id: string;
}
export declare function consolidateCursorPath(): string;
/**
 * The cursor file as it stands. `problem` is set when a file exists but cannot
 * be used (unreadable, not JSON — a legacy bare timestamp included — or the
 * wrong shape): the run then starts from the beginning, which costs the whole
 * walk again, and the caller must say so. No file is not a problem.
 */
export declare function loadConsolidateCursor(): {
    cursor: ConsolidateCursor | null;
    problem: string | null;
};
/** The persisted cursor; null when absent, legacy or corrupt (= start from the beginning). */
export declare function readConsolidateCursor(): ConsolidateCursor | null;
/** Where a run starts, and what had to be said about the stored position. */
export interface ConsolidateStart {
    /** The start position (null = the beginning). Never ahead of `now`. */
    cursor: ConsolidateCursor | null;
    /** Why the cursor file could not be used (the run starts from the beginning), else null. */
    problem: string | null;
    /** The stored time, when it lay ahead of the clock and `cursor` was pulled back to `now`; else null. */
    clampedFrom: string | null;
}
/**
 * Where the next run starts: the persisted cursor, else an explicit
 * LAST_CONSOLIDATED_AT (manual/scoped runs), else null — the beginning, so no
 * active fact is ever skipped.
 *
 * A stored time ahead of the clock (written while the clock was ahead) is
 * pulled back to `now`: left as it was, every fact created at the real time
 * sorts before it and is never pending. The worker writes the pulled-back
 * cursor to the file at the end of its run, so this happens once. Facts
 * created between the clock's return and that run are not driven by this pass
 * (they stay candidates of later facts) — the same accepted limit as a fact
 * imported with an old created_at (getAllNewFactsSince).
 */
export declare function consolidateStart(now: Date, env?: NodeJS.ProcessEnv): ConsolidateStart;
/** consolidateStart's position alone (see there). */
export declare function consolidateStartCursor(env?: NodeJS.ProcessEnv): ConsolidateCursor | null;
/**
 * Whether any active fact lies after the cursor and not after `now` — the same
 * keyset predicate and time bound as the drain's getAllNewFactsSince, served by
 * idx_facts_active_created_id. Plain SQL only: it runs on the hook's read-only
 * handle, which has no sqlite-vec loaded.
 */
export declare function hasPendingConsolidation(db: Database.Database, cursor: ConsolidateCursor | null, now?: Date): boolean;
/** consolidator.ts's ConsolidationErrorKind, plus 'fatal': the run died outside any fact (DB open, lock). */
export type ConsolidateFailureKind = 'internal' | 'transient' | 'deterministic' | 'unknown' | 'fatal';
/** The failure a run ended held on. factId is null for a 'fatal' one. */
export interface ConsolidateFailure {
    factId: string | null;
    kind: ConsolidateFailureKind;
    message: string;
}
/** state/fact-consolidate-health.json — present only while runs keep ending held. */
export interface ConsolidateHealth {
    /** When the current streak of held runs began. */
    firstFailureAt: string;
    lastFailureAt: string;
    /** Runs in a row that ended held without the cursor moving first. */
    consecutiveFailures: number;
    factId: string | null;
    kind: ConsolidateFailureKind;
    message: string;
    /** No run before this time (backoff); null while the streak is short. */
    nextAttemptAt: string | null;
    /** Version that recorded the streak — a different version retries at once (it may carry the fix). */
    pluginVersion: string | null;
}
/** Held runs in a row that are retried on every start; from the next one on, attempts are spaced out. */
export declare const CONSOLIDATE_BACKOFF_AFTER = 5;
/** Wait before the next attempt: 0 up to the limit, then 5 min doubling per further failure, at most 6 h. */
export declare function consolidateBackoffMs(consecutiveFailures: number): number;
export declare function consolidateHealthPath(): string;
/**
 * Read the health record. `problem` is set when a file exists but cannot be
 * used (unreadable, not JSON, wrong shape): the caller then starts a new
 * streak and must say so — a record that vanishes without a word would reset
 * the backoff unnoticed. Every field a consumer reads is checked here.
 */
export declare function loadConsolidateHealth(): {
    health: ConsolidateHealth | null;
    problem: string | null;
};
/**
 * The record after a run. `failure` is the failure the run ended HELD on (null
 * when it ended any other way — nothing pending, budget reached, or a fact
 * skipped past); `progressed` is whether the cursor moved during the run.
 *
 *  - no held failure            → null (the record is removed)
 *  - held, cursor did not move  → the streak continues: count + 1
 *  - held after the cursor moved → a new streak of 1 (a different fact is stuck)
 */
export declare function nextConsolidateHealth(prev: ConsolidateHealth | null, run: {
    progressed: boolean;
    failure: ConsolidateFailure | null;
}, now: Date, pluginVersion: string | null): ConsolidateHealth | null;
/** Write the record (atomically), or remove it for null. Throws when it cannot — the caller logs that. */
export declare function saveConsolidateHealth(health: ConsolidateHealth | null): void;
/**
 * The time before which no run should start, or null when a run may start now.
 * A record written by another plugin version does not hold a run back: the
 * installed code changed, so the failure may be gone.
 */
export declare function consolidateBackoffUntil(health: ConsolidateHealth | null, now: Date, pluginVersion: string | null): string | null;
/**
 * The recorded next-attempt time when consolidateBackoffUntil does not wait
 * for it because it lies further ahead of the clock than the longest wait
 * (same version only) — for the worker to log before it runs. null otherwise.
 */
export declare function consolidateBackoffAheadOfClock(health: ConsolidateHealth | null, now: Date, pluginVersion: string | null): string | null;
/**
 * Whether starting the consolidate worker is worth a process: not while a
 * backoff is running, and not when no active fact lies after the cursor. The
 * worker checks the backoff again itself (it can be started by hand).
 */
export declare function consolidateWorkerGate(db: Database.Database, now: Date, pluginVersion: string | null, env?: NodeJS.ProcessEnv): {
    start: boolean;
    reason: string;
};
export declare function consolidateLockPath(): string;
/**
 * Take the consolidate lock. `acquired: false` without `problem` = another
 * worker holds it or is taking it — it drains the whole backlog, so stepping
 * aside loses nothing. With `problem`, the lock could not be set up at all
 * (missing or read-only directory, a file system without hard links, two
 * unfinished takeovers): the worker must not run, and must say why.
 */
export declare function acquireConsolidateLock(file?: string): {
    acquired: boolean;
    problem?: string;
};
/** Remove the lock if this process holds it. */
export declare function releaseConsolidateLock(file?: string): void;
