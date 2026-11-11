import { WORKER_PROMPT_PREFIXES } from './paths.js';
import { OBSERVER_PROMPT_PREFIX, WARMUP_MESSAGE } from './noise.js';
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
export function buildPollutionWhere(opts = {}) {
    const prefixes = opts.prefixes ?? WORKER_PROMPT_PREFIXES;
    const col = opts.alias ? `${opts.alias}.` : '';
    const SLUG_SUFFIX = '-memory-bank-llm';
    const clauses = [`${col}project LIKE ?`];
    const params = [`%${SLUG_SUFFIX}`];
    if (opts.legacyPrompts) {
        for (const p of prefixes) {
            // Exact prefix via substr equality — no LIKE metacharacter pitfalls.
            clauses.push(`substr(${col}user_message, 1, ?) = ?`);
            params.push(p.length, p);
        }
    }
    if (opts.warmup) {
        clauses.push(`(${col}is_sidechain = 1 AND ${col}user_message = ?)`);
        params.push(WARMUP_MESSAGE);
    }
    if (opts.observer) {
        clauses.push(`substr(${col}user_message, 1, ?) = ?`);
        params.push(OBSERVER_PROMPT_PREFIX.length, OBSERVER_PROMPT_PREFIX);
    }
    return { where: clauses.join(' OR '), params };
}
/** Worklist table of a purge: the ids captured BEFORE any delete (temp schema). */
export const PURGE_WORKLIST_TABLE = 'purge_ids';
/**
 * What is still there after a purge's deletes, counted against the WORKLIST —
 * the ids captured before the first delete. The check used to count vectors
 * with `id IN (SELECT id FROM exchanges WHERE <predicate>)`, which is always 0
 * once the exchange rows are gone: a vector left behind could never be seen.
 */
export function countPurgeLeftovers(db) {
    const n = (sql) => db.prepare(sql).get().n;
    const ids = `SELECT id FROM temp.${PURGE_WORKLIST_TABLE}`;
    return {
        exchanges: n(`SELECT count(*) AS n FROM exchanges WHERE id IN (${ids})`),
        toolCalls: n(`SELECT count(*) AS n FROM tool_calls WHERE exchange_id IN (${ids})`),
        vectors: n(`SELECT count(*) AS n FROM vec_exchanges_rowids WHERE id IN (${ids})`),
    };
}
