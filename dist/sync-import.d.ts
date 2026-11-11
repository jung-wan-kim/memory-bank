/**
 * The highest consolidated_count an imported fact is stored with. The count
 * orders the session-start block ("most confirmed first"), and the file value
 * was stored as it came: one line with 999999 put a planted fact on the first
 * line of every project. The highest count this install has reached itself is
 * 51 (2026-11-11), so the bound changes no real row. It is a sanity bound, not
 * a ranking defence — a planted line can still claim a count up to it.
 */
export declare const MAX_IMPORTED_CONSOLIDATED_COUNT = 100;
/**
 * Why a relation in the sync files was not imported: one of its two facts is not in this database.
 *  - endpoint-refused: the fact was refused by this import (validity, credential-shaped, instruction-like)
 *  - endpoint-failed: the fact failed to import this run (the next import retries both)
 *  - endpoint-duplicate: the same sentence is already here under another id, so the file's id was not imported
 *  - endpoint-missing: the fact is neither here nor importable from the file (a torn line, an inactive fact — the
 *    export lists active facts only)
 */
export type SkippedRelationReason = 'endpoint-refused' | 'endpoint-failed' | 'endpoint-duplicate' | 'endpoint-missing';
/**
 * Import facts and ontology from sync/ JSONL files into local DB.
 * Only inserts records that don't already exist (by ID).
 * Generates embeddings for new facts.
 *
 * Nothing in the files is passed over silently: a row that is not imported —
 * other than one already here under its own id — is counted in the result by
 * cause, and the counts are written to logs/sync-import.jsonl (action
 * 'skipped' — counts and ids only, no text).
 */
export declare function importFromSync(): Promise<{
    newFacts: number;
    newDomains: number;
    newCategories: number;
    newRelations: number;
    rejectedJunk: number;
    duplicateFacts: number;
    detachedCategoryRefs: number;
    failedFacts: number;
    failedFactErrors: string[];
    rejectedSecrets: number;
    rejectedSecretReasons: Record<string, number>;
    rejectedInstructionLike: number;
    rejectedInstructionLikeSamples: string[];
    foldedCategories: number;
    clampedCounts: number;
    malformedLines: number;
    malformedLinesByFile: Record<string, number>;
    skippedRelations: number;
    skippedRelationReasons: Partial<Record<SkippedRelationReason, number>>;
    filesNotMatchingMeta: string[];
}>;
