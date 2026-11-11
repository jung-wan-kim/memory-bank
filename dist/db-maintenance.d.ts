import type Database from 'better-sqlite3';
/**
 * Housekeeping the SessionStart maintenance run does on the FACT side of the
 * database (scripts/session-start-maintenance.js): planner statistics, and
 * keeping the fact vector tables in step with the facts table.
 */
/**
 * Tables ANALYZE covers: the fact and ontology side only. The conversation
 * side is left out on purpose — analyzing `exchanges`, its FTS shadow tables
 * or `tool_calls` reads their indexes whole (GBs on a grown index), and no
 * query over them was mis-planned.
 */
export declare const ANALYZE_TABLES: readonly ["facts", "fact_revisions", "ontology_domains", "ontology_categories", "ontology_relations", "extraction_log"];
/** Rows ANALYZE samples per index (PRAGMA analysis_limit) — keeps it at a few ms however large a table grows. */
export declare const ANALYSIS_LIMIT = 1000;
export interface AnalyzeOutcome {
    tables: string[];
    /** sqlite_stat1 rows for those tables after the run (0 = nothing was gathered). */
    stat_rows: number;
    ms: number;
}
/**
 * Gather planner statistics for the fact-side tables.
 *
 * Without sqlite_stat1 the planner assumes every equality index narrows to
 * about ten rows and picks the narrowest one — on the facts table that was an
 * index on a 2-valued column. Measured on a 46,507-fact table: the key-facts
 * query 40.7ms → 0.021ms and facts-by-category 46.3ms → 0.41ms after
 * `ANALYZE facts`, which itself took 3ms. Statistics are plain tables: a
 * process running older code reads them or ignores them, nothing breaks.
 */
export declare function analyzeFactTables(db: Database.Database): AnalyzeOutcome;
export interface VecReconcileOutcome {
    table: 'vec_facts' | 'vec_facts_kr';
    /** Vector rows removed: their fact is inactive or no longer exists. */
    removed: number;
    /** Vector rows written back from facts.embedding for active facts that had none (vec_facts only). */
    reinserted: number;
    /**
     * Active, current-version facts still without a vector row because the facts
     * row holds no usable embedding (vec_facts only). Reported, not repaired here.
     */
    missing_no_embedding: number;
}
/**
 * Bring the fact vector tables back in step with the facts table.
 *
 *  - A vector whose fact is inactive or gone is deleted. deactivateFact removes
 *    the vector now, but rows deactivated by older code kept theirs (measured
 *    live: 593 in vec_facts, 146 in vec_facts_kr) and every KNN still scans them.
 *  - An active fact at the current embedding version with no vec_facts row gets
 *    its row back from facts.embedding (the same float32 vector the row was
 *    first indexed from). Nothing else heals this: the re-embed worker only
 *    selects stale versions, so such a fact stayed invisible to vector search
 *    (measured live: 2 facts since 2026-07).
 *
 * vec_facts_kr rows cannot be written back here — the Korean vector is not
 * stored in the facts table; the re-embed worker rebuilds a missing one.
 * Running it again changes nothing.
 */
export declare function reconcileFactVectors(db: Database.Database): VecReconcileOutcome[];
