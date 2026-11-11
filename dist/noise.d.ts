/**
 * Machine noise: exchanges no person wrote and no search should return.
 * Measured on one production index (2026-11-10): 82.6% of all exchange rows —
 *   - 150,715 rows (44.1%): the agent warm-up turn, a sidechain user message
 *     that is exactly `Warmup` (149,778 files, 148,847 of them holding nothing
 *     else);
 *   - 131,638 rows (38.5%): another memory plugin's observer sessions, whose
 *     every prompt starts with `<observed_from_primary_session>`.
 * Both are matched exactly (equality / leading text) so a person's own message
 * such as "Warmup 순서 알려줘", or the word Warmup on the main chain, is kept.
 * The SQL twin of this predicate is the warmup / observer part of
 * buildPollutionWhere (pollution-predicate.ts); the two are pinned against
 * each other in test/noise.test.ts.
 */
export declare const WARMUP_MESSAGE = "Warmup";
export declare const OBSERVER_PROMPT_PREFIX = "<observed_from_primary_session>";
export declare function isNoiseExchange(userMessage: string | null | undefined, isSidechain: boolean | number | null | undefined): boolean;
/**
 * The one answer to "does this exchange go into the index?" — used by every
 * indexing path through indexExchanges (index-exchanges.ts). False for the
 * plugin's own worker prompts (ephemeral state) and for machine noise.
 */
export declare function shouldIndexExchange(exchange: {
    userMessage: string;
    isSidechain?: boolean | number | null;
}): boolean;
