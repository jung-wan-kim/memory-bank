/**
 * How a fact appears in an injected context block, shared by the per-prompt
 * injection (inject-core.ts) and the SessionStart key-facts block
 * (scripts/fact-consolidate-hook.js). Kept free of heavy imports: the
 * SessionStart hook runs synchronously before Claude's first response.
 */
/** Per-fact cap — facts average 140 chars, p90 207 (measured). The full text is one search_facts away. */
export declare const FACT_CHAR_CAP = 160;
export declare function truncateFact(text: string): string;
/**
 * Text identity of a fact for in-session dedup. The same sentence is stored
 * under several ids (memory-doc double imports, re-extraction), and id-only
 * dedup let those copies through — 8.9% of injected lines were exact text
 * repeats inside one block (measured 2026-10-03).
 */
export declare function factTextKey(fact: {
    fact: string;
}): string;
