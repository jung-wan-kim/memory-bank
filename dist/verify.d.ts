export interface VerificationResult {
    /** Conversations with something to summarize and no summary file. Fixing one is an LLM call. */
    missingSummary: Array<{
        path: string;
    }>;
    /** Conversations with indexable exchanges and no row in the index. */
    notIndexed: Array<{
        path: string;
    }>;
    /**
     * Index rows whose archive file is gone from disk (neither `.jsonl` nor
     * `.jsonl.zst`). Reported only — repair deletes them just with pruneMissing.
     */
    orphaned: Array<{
        uuid: string;
        path: string;
    }>;
    /**
     * Conversations holding an exchange the index does not have as it stands:
     * changed after they were indexed, or indexed with a shorter snapshot of a
     * turn than the file holds.
     */
    outdated: Array<{
        path: string;
        fileTime: number;
        dbTime: number;
    }>;
    /** Files that could not be read to the end — never re-indexed, never judged "clean". */
    corrupted: Array<{
        path: string;
        error: string;
    }>;
    /**
     * Readable `.zst` files with bytes after their last complete zstd frame that
     * begin no frame (how many bytes). The conversation is read up to that frame
     * — these are not "unreadable" and nothing is repaired — but the ignored
     * tail is told, in one line of the verify output (count and size range).
     */
    trailingBytes: Array<{
        path: string;
        bytes: number;
    }>;
    /**
     * What the repair thresholds are measured against: indexed exchanges, the
     * conversation files walked, and — of those files — the ones that hold
     * something to index (not excluded, at least one indexable exchange).
     */
    totals: VerificationTotals;
}
export interface VerificationTotals {
    exchanges: number;
    conversations: number;
    indexable: number;
}
/**
 * The conversation files verify, repair and rebuild look at: every `.jsonl`
 * (plain or `.zst`, canonical name) directly inside a project folder of the
 * archive that is not excluded. Sub-folders are not descended into — rows
 * indexed from files below that level are never judged by this listing (their
 * file is checked on disk instead) and never re-created by a re-index.
 */
export declare function listArchiveConversations(opts?: {
    onExcludedProject?: (project: string) => void;
}): Array<{
    project: string;
    path: string;
}>;
export declare function verifyIndex(): Promise<VerificationResult>;
export interface RepairOptions {
    /** Delete index rows whose archive file is gone (backed up first). Default: report them only. */
    pruneMissing?: boolean;
    /** Make no summary (LLM) call. */
    noSummaries?: boolean;
    /** Go ahead although a count of the plan is over its threshold. */
    yes?: boolean;
}
/** A count needs `yes` when it is over BOTH this share of the total and the floor. */
export declare const REPAIR_THRESHOLD_RATIO = 0.05;
/** Chosen, not measured: below this many items a share of a small index means nothing. */
export declare const REPAIR_THRESHOLD_FLOOR = 20;
/**
 * Summary (LLM) calls a repair starts without `yes`, whatever share of the
 * archive they are. Chosen, not measured: each call is a headless model
 * session of 10-14s, so 100 is about 20 minutes of account usage.
 */
export declare const REPAIR_LLM_CALLS_MAX = 100;
export interface RepairPlan {
    /** Rows whose file is gone. */
    missingFileRows: number;
    /** Of those, rows this run deletes (0 unless pruneMissing). */
    deleteRows: number;
    /** Conversations to parse and index (not indexed + outdated). */
    reindexFiles: number;
    /** Summary (LLM) calls: no summary file + outdated (0 with noSummaries). */
    summaryCalls: number;
    totals: VerificationTotals;
    /** One line per count over its threshold; empty = the plan runs without `yes`. */
    overThreshold: string[];
}
export declare function planRepair(issues: VerificationResult, opts?: RepairOptions): RepairPlan;
export declare function formatRepairPlan(plan: RepairPlan, opts?: RepairOptions): string[];
/** Thrown before anything is changed when the plan is over a threshold and `yes` was not given. */
export declare class RepairAbortedError extends Error {
    readonly plan: RepairPlan;
    constructor(plan: RepairPlan);
}
export interface RepairOutcome {
    plan: RepairPlan;
    deletedRows: number;
    /** Backup of the deleted rows, null when nothing was deleted. */
    backupPath: string | null;
    reindexedFiles: number;
    indexedExchanges: number;
    summariesWritten: number;
    /** Conversations left alone: excluded project or exclusion marker. */
    skippedFiles: number;
    failed: Array<{
        path: string;
        error: string;
    }>;
}
export declare function repairIndex(issues: VerificationResult, opts?: RepairOptions): Promise<RepairOutcome>;
