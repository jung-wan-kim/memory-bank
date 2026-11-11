import type Database from 'better-sqlite3';
import { RepairOutcome } from './verify.js';
/**
 * `index --rebuild`: regenerate the CONVERSATION index and nothing else.
 *
 * The command used to unlink the database file. That file has long held more
 * than the conversation index — facts, their revisions, the ontology, user
 * tags, the extraction log — none of which can be regenerated from the archive
 * (measured on one live DB: 46,507 facts, 42,801 relations, 7,146 categories
 * would have gone), and every other process holding the file open got
 * SQLITE_CORRUPT on its next statement. Now the file stays: only the
 * conversation-side tables are emptied, in place.
 */
export interface RebuildCounts {
    /**
     * Kept: no row of these is added, removed or rewritten — with one exception,
     * a fact's source ids that name an older copy of a turn (RebuildResult.repointedFacts).
     */
    preserved: {
        facts: number;
        activeFacts: number;
        taggedFacts: number;
        relations: number;
        revisions: number;
        categories: number;
        domains: number;
        extractionLog: number;
    };
    /** Emptied, then re-created from the conversation archive. */
    cleared: {
        exchanges: number;
        toolCalls: number;
        vectors: number;
    };
}
/** What the re-index after a clear can and cannot bring back. */
export interface RebuildReach {
    /** Conversation files the re-index reads (listArchiveConversations). */
    archiveConversations: number;
    /**
     * Indexed exchanges whose file is NOT one of those — in a sub-folder of its
     * project, in an excluded project, or gone from the archive — or is one of
     * them but cannot be read to its end (`unreadable`). Clearing them is final:
     * no re-index of this code re-creates them.
     */
    unreachable: {
        exchanges: number;
        files: number;
    };
    /** The archive paths of those exchanges (what the pre-rebuild backup copies). */
    unreachablePaths: string[];
    /**
     * The part of `unreachable` whose file IS among the conversations the
     * re-index reads but fails to read (a `.zst` cut short, corrupt bytes, over
     * the decompression cap). Zero until addUnreadableFiles has read the files.
     */
    unreadable: {
        exchanges: number;
        files: number;
    };
}
/**
 * Compare what is indexed with what a re-index would read. Reads the path
 * index only (no row is visited).
 */
export declare function measureRebuildReach(db: Database.Database): RebuildReach;
/**
 * Read every listed conversation that has indexed rows to its end — the way
 * the re-index will — and count the rows of the ones that cannot be read as
 * unreachable. "Its path is in the listing" is not "it can be re-created": a
 * `.zst` the compressor was interrupted on is listed, and the re-index reports
 * it unreadable and indexes nothing from it — after the clear that was the
 * loss of every row of that conversation, with no backup and exit 0.
 * Reads only. Costs one pass over those files (the re-index reads them again).
 */
export declare function addUnreadableFiles(db: Database.Database, reach: RebuildReach, opts?: {
    onProgress?: (read: number) => void;
}): Promise<Array<{
    path: string;
    error: string;
}>>;
/**
 * Copy the exchanges (and their tool calls) indexed from the given archive
 * paths into a new sqlite file — the rows a rebuild is about to clear and
 * cannot re-create. Vectors are not copied (the re-embed worker makes a
 * missing one from the text).
 */
export declare function backupExchangesOfPaths(db: Database.Database, archivePaths: readonly string[], backupPath: string): {
    exchanges: number;
    toolCalls: number;
};
/**
 * How many exchanges indexed from the given archive paths are NOT in the
 * backup written by backupExchangesOfPaths. The backup copies a read snapshot
 * (it does not hold the write lock — see writeRowBackup), so a row another
 * process indexed while it was being written is not in it; the rebuild is
 * about to clear every row, and for these files no re-index brings one back.
 * Reads only.
 */
export declare function exchangesMissingFromBackup(db: Database.Database, archivePaths: readonly string[], backupPath: string): number;
export declare function countForRebuild(db: Database.Database): RebuildCounts;
/** The tables a rebuild must never lose — copied before anything is emptied. */
export declare const FACT_LAYER_TABLES: readonly ["facts", "fact_revisions", "ontology_domains", "ontology_categories", "ontology_relations", "extraction_log"];
/**
 * Copy the fact layer into a new sqlite file (rows only). The rebuild changes
 * one thing in these tables (source ids that name an older copy of a turn —
 * after this copy is written); the copy exists so that a bug or a crash in a
 * command that empties half of the database can never cost what cannot be
 * re-derived, and it holds the source lists as they were.
 */
export declare function backupFactLayer(db: Database.Database, backupPath: string): Record<string, number>;
/**
 * Swap vec_exchanges for a fresh table of the same DDL that holds only the
 * vectors of the rows `exchanges` has right now, and rebuild the FTS index
 * from the content table — two write transactions with a pause between them,
 * the vectors and then the text index. As one they held the write lock for over 5s at the end of a
 * rebuild of a large index (dropping 341,840 vectors: 2.3s, emptying the text
 * index: 1.5s with a warm cache, more with a cold one), and every other
 * process's write failed after its 5s wait. A row another process indexes
 * between the two is indexed by the insert trigger and read again by the
 * 'rebuild'; a run that dies between them leaves the text index marked "not
 * built" (search scans), as an interrupted clear does.
 *
 * After a clear, `exchanges` is empty or holds the few rows another process
 * indexed since the last delete batch; those keep their vector (same bytes),
 * so no exchange row is ever left without one.
 */
export declare function resetVectorsAndTextIndex(db: Database.Database, opts?: {
    /** Called between the two transactions (none is open). */
    onVectorsReset?: () => void;
    /** Wait between the two (default DELETE_BATCH_PAUSE_MS). 0 = none. */
    pauseMs?: number;
}): {
    vectorsKept: number;
};
/**
 * While clearing, batches follow each other at once: a process waiting for
 * the write lock retries every 100ms at most and has only the microseconds
 * between two batches to land in. After this long without a gap the clear
 * waits (pauseForOtherWriters) before its next batch. Measured on a 341,840
 * exchange index: a waiter sat through the last exchange batches and the
 * vector reset — 4.6s to 5.1s, at the edge of its 5s limit.
 */
export declare const CLEAR_YIELD_EVERY_MS = 1000;
export interface ClearOptions {
    /** Rows per transaction. Default 2000. */
    batchSize?: number;
    /** Length of each wait for other writers (default DELETE_BATCH_PAUSE_MS). 0 = none. */
    pauseMs?: number;
    /** Called after each committed batch (progress; other connections can write here). */
    onBatch?: (progress: {
        table: 'tool_calls' | 'exchanges';
        deleted: number;
    }) => void;
}
/**
 * Empty the conversation side of the index — tool_calls, exchanges, their
 * vectors and their FTS index — leaving every other table as it is.
 *
 *  - tool_calls and exchanges go in batches, one short transaction each, so
 *    other processes keep writing in between and the WAL is checkpointed as it
 *    goes (one transaction over 340K rows would hold the write lock for as
 *    long as it takes to read the whole table).
 *  - exchanges rows are deleted WITHOUT the FTS delete trigger: each batch
 *    drops the trigger, deletes, and re-creates it inside its own transaction,
 *    so no other connection ever sees it missing. Letting it fire would
 *    tokenize every deleted row's text into the FTS index only to throw the
 *    index away — and on a DB whose FTS index was never backfilled it fails
 *    outright (FTS5 reports a delete from an empty index as corruption).
 *  - vec_exchanges is dropped and re-created with its own DDL (same dtype):
 *    vec0 never reuses deleted slots, and deleting 50K+ rows from one in a
 *    single transaction corrupted its chunk bookkeeping (observed live).
 *  - last, the FTS index is rebuilt from whatever `exchanges` holds by then
 *    ('rebuild' = delete-all + re-read the content table). After a clear that
 *    is nothing, or the few rows another process indexed meanwhile — whose
 *    vectors are carried over the same way.
 *
 * An interrupted clear leaves a smaller, consistent table set, with the text
 * index marked "not built" (search scans instead of trusting an index that
 * still lists deleted rows). Running the rebuild again finishes it.
 */
export declare function clearConversationIndex(db: Database.Database, opts?: ClearOptions): {
    exchanges: number;
    toolCalls: number;
};
export interface RebuildOptions {
    /** Without it the rebuild prints what it would do and changes nothing. */
    yes?: boolean;
    /**
     * Go ahead although some indexed exchanges cannot be re-created (see
     * RebuildReach.unreachable). Without it such a rebuild is refused.
     */
    allowIndexLoss?: boolean;
    /** Also delete every summary file (they are re-made by sync / `--repair`, one LLM call each). */
    resetSummaries?: boolean;
}
export interface RebuildResult {
    counts: RebuildCounts;
    reach: RebuildReach;
    /** Backup of the fact layer. */
    backupPath: string;
    /** Backup of the exchanges cleared for good (allowIndexLoss); null when there were none. */
    lostExchangesBackupPath: string | null;
    /**
     * Facts whose source list named an older copy of a turn and was moved to the
     * copy the re-index re-creates (see rebuildConversationIndex). The one thing
     * a rebuild changes in the fact layer; 0 when no turn had more than one row.
     */
    repointedFacts: number;
    cleared: {
        exchanges: number;
        toolCalls: number;
    };
    /** Summary files deleted; null when they were left alone (the default). */
    removedSummaries: number | null;
    reindex: RepairOutcome;
    /** Conversations with no summary file after the rebuild. */
    missingSummaries: number;
}
/** Thrown, with nothing changed, when the rebuild was not confirmed. */
export declare class RebuildNotConfirmedError extends Error {
    readonly counts: RebuildCounts;
    readonly reach: RebuildReach;
    constructor(counts: RebuildCounts, reach: RebuildReach);
}
/**
 * Thrown, with nothing changed, when the rebuild would clear exchanges it has
 * no way to re-create and that loss was not explicitly accepted.
 */
export declare class RebuildWouldLoseIndexError extends Error {
    readonly counts: RebuildCounts;
    readonly reach: RebuildReach;
    constructor(counts: RebuildCounts, reach: RebuildReach);
}
export declare function formatRebuildCounts(counts: RebuildCounts, reach: RebuildReach): string[];
/**
 * The whole `index --rebuild`: print what stays, what goes and what will not
 * come back; refuse if exchanges would be lost for good and that was not
 * accepted; back up the fact layer; point the facts that name an older copy
 * of a turn at the copy that comes back (the only change to the fact layer —
 * source ids, nothing else); empty the conversation tables in place;
 * re-index from the ARCHIVE (the projects dir only holds the recent weeks —
 * re-indexing from it brought back 915 of 290,398 archived conversations on
 * the measured machine) through the same guarded path as repair.
 *
 * Summaries are files next to the conversations, not part of the database:
 * they stay unless resetSummaries. The rebuild makes no LLM call — missing
 * summaries are left to sync and `--repair`, which count their calls first.
 */
export declare function rebuildConversationIndex(opts?: RebuildOptions): Promise<RebuildResult>;
