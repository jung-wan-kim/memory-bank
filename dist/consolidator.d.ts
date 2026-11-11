import Database from 'better-sqlite3';
import type { Fact, ConsolidationResult } from './types.js';
export declare const CONSOLIDATION_SYSTEM_PROMPT = "Compare two facts and determine their relationship.\n\n## Relationship types (choose one)\n- DUPLICATE: same content - merge\n- CONTRADICTION: conflicting - new fact replaces old\n- EVOLUTION: old fact evolved - update\n- INDEPENDENT: separate - keep both\n\n## Output format\n{\n  \"relation\": \"DUPLICATE|CONTRADICTION|EVOLUTION|INDEPENDENT\",\n  \"merged_fact\": \"<the final fact sentence for DUPLICATE/CONTRADICTION/EVOLUTION, written out>\",\n  \"merged_fact_kr\": \"<merged_fact in natural Korean>\",\n  \"reason\": \"one-line justification\"\n}\n(merged_fact_kr: the same sentence as merged_fact, in natural Korean \u2014 API/tool/framework names, file paths and commands stay in English.)";
/**
 * The verdict as the LLM returns it: the Korean sentence of merged_fact comes
 * in the same response, so a rewritten fact keeps a Korean sentence without a
 * second call.
 */
export type ConsolidationVerdict = ConsolidationResult & {
    merged_fact_kr?: unknown;
};
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
/**
 * Why a fact's comparison failed. 'internal' is everything that is not a
 * provider rejection (candidate search, parsing, embedding, DB write); the
 * other three are classifyLlmError's reading of a provider rejection.
 */
export type ConsolidationErrorKind = 'internal' | 'transient' | 'deterministic' | 'unknown';
export interface ConsolidationError {
    factId: string;
    kind: ConsolidationErrorKind;
    message: string;
    /** true = the cursor stays in front of this fact (the next run retries it); false = it was skipped past. */
    held: boolean;
}
export interface ConsolidationRunResult {
    processed: number;
    merged: number;
    contradictions: number;
    evolutions: number;
    /** Comparison LLM calls actually made — an error before the call is not one. */
    haikuCalls: number;
    cursor: {
        createdAt: string;
        id: string;
    } | null;
    /**
     * The last failure of this run, null when none. A held failure is always the
     * last one (the run stops there). The caller must surface it: the worker runs
     * detached with stdio ignored, so console.error reaches no one.
     */
    lastError: ConsolidationError | null;
    /** Drivers whose candidate search stopped at the KNN k limit (possibly unread matches). */
    cappedSearches: number;
    /** Verdicts that changed a stored sentence. */
    rewrites: number;
    /**
     * Of those, rewrites that left the fact with no Korean sentence: the new
     * sentence was not another fact's and the verdict carried no usable
     * merged_fact_kr. Such a fact answers Korean queries through its main vector
     * only, until scripts/translate-facts.mjs fills fact_kr.
     */
    rewritesWithoutKorean: number;
    /**
     * Active facts dated later than the run's "now" (stamped while the clock was
     * ahead). They are not driven — the cursor would follow them ahead of the
     * clock and nothing created at the real time would be pending again — and
     * wait until their time comes. 0 on a store whose times are sane.
     */
    aheadOfClock: number;
    /**
     * Verdicts that were not applied because one of the two facts changed while
     * the call was in flight (switched off or rewritten by another writer).
     */
    changedPairs: number;
    /**
     * Pairs ordered by creation time because facts.content_at could not be added
     * (first use of the column while another process held the write lock). 0 on
     * a store that has the column. The caller must surface it: for such a pair
     * the fact shown as "existing" can be the one holding the later content.
     */
    withoutContentTime: number;
}
export declare function consolidateAllPending(db: Database.Database, since: {
    createdAt: string;
    id: string;
} | null, opts?: {
    now?: Date;
}): Promise<ConsolidationRunResult>;
/**
 * Apply a verdict to its pair. `existingFact` is the fact with the OLDER
 * content and `newFact` the later one (consolidateOne orders them; see
 * inContentOrder). The fact that stays records the later of the two content
 * times.
 *
 * `opts.embedding` is the vector of the sentence the verdict writes. It is
 * required when the rewritten fact has a stored vector: writing the sentence
 * alone would leave that vector describing the old sentence.
 *
 * The rewritten fact's Korean sentence follows the new sentence (see
 * rewriteKorean): a sentence taken over from the other fact brings that fact's
 * Korean sentence and stored vector; a sentence the verdict wrote takes
 * `result.merged_fact_kr`, with `opts.embeddingKr` as its vector (without one
 * the sentence is stored and the re-embed worker builds the vector); otherwise
 * the fact is left with none.
 *
 * Returns false, having written nothing, when the two facts are no longer what
 * was passed in — one of them inactive, gone, or holding another sentence. The
 * verdict was about those sentences; the LLM call that produced it takes
 * seconds, and a cleanup script or another writer can change a fact meanwhile.
 * (Applied blindly, a merge into a fact switched off in that window switched
 * the other one off as well — both gone.)
 */
export declare function applyConsolidationResult(db: Database.Database, existingFact: Fact, newFact: Fact, result: ConsolidationVerdict, opts?: {
    embedding?: number[];
    embeddingKr?: number[];
}): boolean;
