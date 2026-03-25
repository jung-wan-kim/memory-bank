import Database from 'better-sqlite3';
import type { Fact, FactRevision } from './types.js';
interface InsertFactParams {
    fact: string;
    category: string;
    scope_type: string;
    scope_project: string | null;
    source_exchange_ids: string[];
    embedding: number[] | null;
}
interface UpdateFactParams {
    fact?: string;
    embedding?: number[] | null;
    consolidated_count_increment?: boolean;
}
interface InsertRevisionParams {
    fact_id: string;
    previous_fact: string;
    new_fact: string;
    reason: string | null;
    source_exchange_id: string | null;
}
export declare function insertFact(db: Database.Database, params: InsertFactParams): string;
export declare function getActiveFacts(db: Database.Database): Fact[];
export declare function getFactsByProject(db: Database.Database, project: string): Fact[];
export declare function updateFact(db: Database.Database, id: string, params: UpdateFactParams): void;
export declare function deactivateFact(db: Database.Database, id: string): void;
export declare function deleteFact(db: Database.Database, id: string): void;
export declare function insertRevision(db: Database.Database, params: InsertRevisionParams): string;
export declare function getRevisions(db: Database.Database, factId: string): FactRevision[];
export declare function searchSimilarFacts(db: Database.Database, embedding: number[], project: string | null, limit?: number, threshold?: number): Array<{
    fact: Fact;
    distance: number;
}>;
/**
 * Get top facts using a relevance score that combines:
 * - Confirmation count (consolidated_count) — how established is this fact
 * - Recency (updated_at) — how recent is this fact
 * - Scope priority — project-specific facts rank higher than global for that project
 *
 * Score = (log2(consolidated_count + 1) * 3) + recency_bonus + scope_bonus
 *   recency_bonus: 5 if updated in last 7 days, 3 if last 30 days, 1 if last 90 days, 0 otherwise
 *   scope_bonus: 2 for project-scoped facts, 0 for global
 */
export declare function getTopFacts(db: Database.Database, project: string, limit?: number): Fact[];
/**
 * Legacy: get facts by pure confirmation count (for backward compatibility).
 */
export declare function getTopFactsByCount(db: Database.Database, project: string, limit?: number): Fact[];
export declare function getNewFactsSince(db: Database.Database, project: string, since: string): Fact[];
/**
 * Search facts across ALL projects (no scope filter).
 * Used for cross-project knowledge transfer.
 */
export declare function searchAllFacts(db: Database.Database, embedding: number[], limit?: number, threshold?: number): Array<{
    fact: Fact;
    distance: number;
}>;
export {};
