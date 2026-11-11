/**
 * One-time cleanup of EXACT duplicates: active facts of one scope whose
 * sentences are equal after collapsing whitespace and case — the same
 * identity the injection dedup uses (fact-text.ts factTextKey). Measured
 * 2026-11: 336 groups, 1,309 rows, 973 of them redundant, most from before the
 * consolidation cursor existed (those facts were never driven) or from groups
 * of 2–4 that the old candidate search could not see.
 *
 * No LLM and no vectors are involved: equal text is equal text. Per group the
 * OLDEST fact `(created_at, id)` stays — the same choice consolidation makes
 * for a DUPLICATE — and the others are deactivated (their vector rows go with
 * them, as deactivateFact does). Whether the survivor also takes the others'
 * confirmations is the caller's decision (`counts`): the largest groups are
 * session boilerplate ("the project is a git repository…" ×55), and a summed
 * count lifts exactly those to the top of the session-start facts. Sources are
 * always united. Ontology relations of a deactivated fact are NOT re-pointed.
 *
 * Finding the groups reads only (the script's dry run opens the database
 * read-only). Applying is one transaction that first copies every row it
 * changes into a backup table; `restoreExactDedupe` undoes it from there.
 */
import Database from 'better-sqlite3';
export type DedupeCounts = 'sum' | 'keep';
export interface ExactDuplicateGroup {
    survivorId: string;
    removedIds: string[];
    scopeType: string;
    scopeProject: string | null;
    /** The normalized sentence the members share — the apply step re-checks it. */
    sentenceKey: string;
}
/** Sentence identity: whitespace runs collapsed, trimmed, lower-cased. Nothing looser — "nearly the same" is the LLM's call. */
export declare function exactSentenceKey(fact: string): string;
/** Groups of active facts with one scope and one sentence, oldest member first. Reads only. */
export declare function findExactDuplicateGroups(db: Database.Database): ExactDuplicateGroup[];
export interface ExactDedupeApply {
    /** Groups merged. */
    groups: number;
    /** Facts deactivated. */
    deactivated: number;
    /** Groups left alone because a member changed (text, scope or active state) since they were found. */
    groupsChangedSinceCheck: number;
    /** Table holding the old values of every changed row; null when nothing changed. */
    backupTable: string | null;
}
/**
 * Merge every group into its oldest member. `counts: 'sum'` adds the removed
 * facts' consolidated_count to the survivor's, 'keep' leaves the survivor's
 * count alone. The survivor's updated_at is not touched (a cleanup is not a
 * new confirmation). One write transaction, the backup table included.
 */
export declare function applyExactDedupe(db: Database.Database, groups: ExactDuplicateGroup[], opts: {
    counts: DedupeCounts;
    now?: Date;
}): ExactDedupeApply;
export interface ExactDedupeRestore {
    /** Deactivated facts switched back on, with their vector rows. */
    reactivated: number;
    /** Survivors whose count (and, when unchanged since, sources) went back. */
    survivorsRestored: number;
    /** Backed-up facts no longer in the state the cleanup left them — not touched. */
    skippedChanged: number;
}
/**
 * Undo applyExactDedupe from its backup table. A removed fact is switched back
 * on only if it is still inactive; a survivor gives back exactly the count it
 * was given (later confirmations stay) and gets its old sources back only if
 * nothing was added to them since. Refuses when a vector table's dtype/scale
 * differs from the backup's.
 */
export declare function restoreExactDedupe(db: Database.Database, backupTable: string): ExactDedupeRestore;
