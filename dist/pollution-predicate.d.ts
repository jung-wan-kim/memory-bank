import type Database from 'better-sqlite3';
/**
 * SQL predicate + params matching WORKER-PROMPT POLLUTION exchanges — the
 * plugin's own Haiku worker sessions that ephemeral-state cleanup (purge) must
 * remove and indexing must never store. Single source of truth: the prefixes
 * come from paths.ts WORKER_PROMPT_PREFIXES, so adding a new worker prompt there
 * (for the indexing guard) automatically extends the purge too — the old code
 * duplicated the list in the purge script, where the two silently drifted (a
 * new prompt would be excluded from indexing but never purged).
 *
 * Two pollution families:
 *   - SLUG: project slug ends with `-memory-bank-llm` (worker sessions indexed
 *     under their own temp workdir slug). Always included.
 *   - WORKER-PROMPT (opt-in via `legacyPrompts`): sessions from before the fixed
 *     workdir ran with the CALLER project's cwd, so they sit under REAL project
 *     slugs and can only be identified by the exact system-prompt lead.
 *
 * Two MACHINE-NOISE families, both opt-in (the SQL twin of isNoiseExchange in
 * noise.ts — pinned against it row by row in test/noise.test.ts):
 *   - WARMUP (`warmup`): a sidechain exchange whose user message is exactly
 *     the agent warm-up turn.
 *   - OBSERVER (`observer`): another memory plugin's observer prompt (exact
 *     leading text).
 *
 * @param opts.legacyPrompts also match worker-prompt leads under real slugs
 * @param opts.warmup also match agent warm-up turns
 * @param opts.observer also match observer prompts
 * @param opts.alias table alias for the exchanges columns ('' for none)
 * @param opts.prefixes worker-prompt leads (defaults to canonical; injectable for tests)
 */
export declare function buildPollutionWhere(opts?: {
    legacyPrompts?: boolean;
    warmup?: boolean;
    observer?: boolean;
    alias?: string;
    prefixes?: readonly string[];
}): {
    where: string;
    params: Array<number | string>;
};
/** Worklist table of a purge: the ids captured BEFORE any delete (temp schema). */
export declare const PURGE_WORKLIST_TABLE = "purge_ids";
/**
 * What is still there after a purge's deletes, counted against the WORKLIST —
 * the ids captured before the first delete. The check used to count vectors
 * with `id IN (SELECT id FROM exchanges WHERE <predicate>)`, which is always 0
 * once the exchange rows are gone: a vector left behind could never be seen.
 */
export declare function countPurgeLeftovers(db: Database.Database): {
    exchanges: number;
    toolCalls: number;
    vectors: number;
};
