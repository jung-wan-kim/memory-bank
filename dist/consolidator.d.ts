import Database from 'better-sqlite3';
import type { Fact, ConsolidationResult } from './types.js';
export declare const CONSOLIDATION_SYSTEM_PROMPT = "Compare two facts and determine their relationship.\n\n## Relationship types (choose one)\n- DUPLICATE: same content - merge\n- CONTRADICTION: conflicting - new fact replaces old\n- EVOLUTION: old fact evolved - update\n- INDEPENDENT: separate - keep both\n\n## Output format\n{\n  \"relation\": \"DUPLICATE|CONTRADICTION|EVOLUTION|INDEPENDENT\",\n  \"merged_fact\": \"final sentence for merge/replace\",\n  \"reason\": \"one-line justification\"\n}";
export declare function buildConsolidationPrompt(existingFact: string, newFact: string): string;
export type { LlmErrorClass } from './llm-error-class.js';
export { LlmCallError, EmptyLlmResponseError, classifyLlmError, isTransientLlmError } from './llm-error-class.js';
/**
 * @deprecated Back-compat wrapper for the removed per-project consolidator.
 * Prefer `consolidateAllPending`. Now scope-isolated (via consolidateOne), so
 * it can no longer leak project-private text into global facts. Kept as a
 * public export so existing importers don't crash at module load.
 */
export declare function consolidateFacts(db: Database.Database, project: string, lastConsolidatedAt: string): Promise<{
    processed: number;
    merged: number;
    contradictions: number;
    evolutions: number;
}>;
/**
 * Consolidate the ENTIRE backlog in one pass: every new fact (any scope, any
 * project) processed exactly once, under a single shared Haiku budget. The
 * consolidate worker calls this once while holding the global lock, instead of
 * looping consolidateFacts per project — which reprocessed shared global facts
 * once per project (up to `MAX_HAIKU_CALLS × projectCount` calls) and, for
 * INDEPENDENT/CONTRADICTION verdicts (new fact stays active), kept re-comparing
 * the same global fact every pass.
 *
 * Each fact is compared within its own scope: a project fact against its
 * project + global (via its scope_project), a global fact against the whole
 * store (scope_project is null → no scope filter). Because a fact merged away
 * by an earlier comparison is deactivated, it neither reappears in this list
 * nor as a later candidate.
 */
export declare function consolidateAllPending(db: Database.Database, since: {
    createdAt: string;
    id: string;
} | null): Promise<{
    processed: number;
    merged: number;
    contradictions: number;
    evolutions: number;
    haikuCalls: number;
    cursor: {
        createdAt: string;
        id: string;
    } | null;
}>;
export declare function applyConsolidationResult(db: Database.Database, existingFact: Fact, newFact: Fact, result: ConsolidationResult): void;
