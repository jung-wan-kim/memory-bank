import type Database from 'better-sqlite3';
export interface KoreanRestoreResult {
    /** Active facts with no Korean sentence whose current sentence one of their own revisions wrote. */
    candidates: number;
    /** Of those, facts that got the Korean sentence (and a Korean vector) of the fact merged into them. */
    restored: number;
    /** Restorable facts left for a later pass because the per-pass limit was reached. */
    remaining: number;
}
/** Facts restored in one pass at most — bounds the embedding time of a pass (one local embedding each). */
export declare const KOREAN_RESTORE_LIMIT = 200;
export declare function restoreKoreanFromMergedFacts(db: Database.Database, embed: (text: string) => Promise<number[]>, opts?: {
    limit?: number;
}): Promise<KoreanRestoreResult>;
/**
 * Every pass until nothing restorable is left, for a caller that has just
 * removed Korean sentences and wants back the ones that exist for the new
 * sentences. `candidates` is the count before the first pass. Stops when a
 * pass restores nothing (rows that changed under it are not waited for).
 */
export declare function restoreKoreanToEnd(db: Database.Database, embed: (text: string) => Promise<number[]>, opts?: {
    limit?: number;
}): Promise<{
    candidates: number;
    restored: number;
}>;
export declare function koreanRestoreStatePath(): string;
/**
 * Passes in a row that may throw before the restore is left alone for a plugin
 * version. A pass that threw has not run to the end, so the next call runs it
 * again — recording it like a finished one left the facts without their Korean
 * sentence for the whole version after one bad moment (measured: another
 * connection held the write lock for 30s while the pass ran). The limit is for
 * a failure that comes back every time (each try reads every revision and
 * writes a log line). 3: chosen, not measured.
 *
 * A held write lock does not count toward it: it says nothing about the pass,
 * and it ends when the other writer does.
 */
export declare const KOREAN_RESTORE_MAX_FAILED_PASSES = 3;
/** A restore pass that threw. The message is the failure's own. */
export declare class KoreanRestoreError extends Error {
    /** true: the next call runs the pass again. false: this was the last try for this plugin version. */
    readonly retry: boolean;
    constructor(message: string, 
    /** true: the next call runs the pass again. false: this was the last try for this plugin version. */
    retry: boolean);
}
/**
 * Run restoreKoreanFromMergedFacts unless it already ran to the end for this
 * plugin version. Returns null when it did not run. A pass that stopped at its
 * limit runs again on the next call. So does a pass that threw — the failure
 * is thrown to the caller as a KoreanRestoreError that says whether there is a
 * next try: after KOREAN_RESTORE_MAX_FAILED_PASSES failed passes in a row the
 * restore is left alone for this version (a held write lock is not counted).
 */
export declare function restoreKoreanOncePerVersion(db: Database.Database, pluginVersion: string | null, embed: (text: string) => Promise<number[]>, opts?: {
    limit?: number;
}): Promise<KoreanRestoreResult | null>;
