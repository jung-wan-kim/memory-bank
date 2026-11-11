import { SearchResult, MultiConceptResult } from './types.js';
import type DatabaseType from 'better-sqlite3';
/** Default mmap window for the search connection (writable, used only for reads): 256MB covers the fact vector tables. */
export declare const DEFAULT_SEARCH_MMAP_BYTES = 268435456;
/**
 * Bytes for `PRAGMA mmap_size` on the search connection — MEMORY_BANK_SQLITE_MMAP_BYTES (integer ≥ 0; 0 turns
 * mmap off) or the default. A value that is not a non-negative integer falls back to the default and says so
 * once on stderr (a silent fallback would hide a typo in the user's shell profile).
 */
export declare function searchMmapBytes(raw?: string | undefined, warn?: (msg: string) => void): number;
export declare function getSearchDb(): DatabaseType.Database;
export interface SearchOptions {
    limit?: number;
    mode?: 'vector' | 'text' | 'both';
    after?: string;
    before?: string;
    coding_agent?: string;
    /** Also return machine-generated turns (NOISE_EXCHANGE_SQL). Default false. */
    include_noise?: boolean;
    /**
     * Keyword pass: only exchanges that contain EVERY word of the query — no partial-match ladder. Used by
     * the multi-concept search, where "some of the words" is not a match.
     */
    require_all_tokens?: boolean;
    /**
     * Vector pass: the k of its first KNN round, instead of the guess (8 × limit when rows are filtered). For a
     * caller that has just searched the same index under the same filters and saw the k that took
     * (SearchMeta.vector.k): how many of the nearest vectors pass is a property of the index and the filters,
     * and every round is a scan of the whole index. The turns returned do not depend on it (a larger k can
     * only bring a more complete snapshot of a returned turn into view).
     */
    vector_first_k?: number;
}
/** First characters of the prompts another memory plugin's observer session sends — not a person asking. */
export declare const NOISE_OBSERVER_PREFIX = "<observed_from_primary_session>";
/**
 * SQL condition over `exchanges AS e` that is TRUE for a machine-noise row — the one definition of what the
 * conversation search leaves out unless SearchOptions.include_noise is set:
 *  - a sub-agent warm-up turn: a sidechain row whose user message is exactly "Warmup";
 *  - an observer prompt of another memory plugin: the user message starts with NOISE_OBSERVER_PREFIX.
 * On the live index these are 150,715 + 131,638 of 341,817 rows (82.6%); a search for a real question
 * returned 16 observer prompts and 2 warm-ups in its 18 results. Rows are only hidden here — nothing is
 * deleted, and a person's own "Warmup" in the main chain stays.
 * substr(), not LIKE: the `_` in the prefix is a LIKE wildcard.
 * The two texts come from noise.ts — the rule that keeps such turns out of the index (isNoiseExchange) —
 * so what the index refuses and what the search hides cannot drift apart (test/noise-search-parity.test.ts).
 */
export declare const NOISE_EXCHANGE_SQL: string;
/** sqlite-vec refuses a KNN whose k is above this ("k value in knn query too large … the limit is 4096"). */
export declare const VEC_KNN_K_MAX = 4096;
/**
 * From this k up a KNN costs what one at the ceiling costs: vec0 scans every vector whatever k is, and
 * selects the nearest min(k, 1024) of each 1,024-vector chunk. Measured on 341,840 int8 vectors:
 * k 10 → 45 ms, 50 → 60 ms, 400 → 145 ms, 1,600 → 300 ms, 4,096 → 300 ms. The vector pass therefore never
 * asks for a k between this and the ceiling — it would pay the ceiling's price for fewer candidates, and
 * then often for one more round at the ceiling.
 */
export declare const VEC_KNN_FLAT_K = 1024;
/**
 * A coding_agent filter on at most this many rows is applied in the keyword query from the agent's own row
 * list (idx_coding_agent, read once per query) instead of from each matching exchange row.
 *
 * The keyword query always scans the keyword index first (see filteredSql). How the agent condition is then
 * tested decides the cost, measured on a 341,840-row index (ms, first run, `limit` 10):
 *   rows of the agent          0     457    5,017   20,133   316,233
 *   test on the exchange row   1,500–4,800  48–1,600  4–64   1–79    1–18
 *   test on the row list       4–55         4–51      2–21   8–24    21–61
 * Testing the row opens every match of the query until `limit` rows pass, and the agent column sits behind
 * the message text (overflow pages) — cheap when most rows pass, seconds when few do. The row list costs one
 * index read of the agent's rows per query — cheap while the list is short.
 */
export declare const RARE_AGENT_ROWS = 20000;
/**
 * Whether a stored "summary" is not one: empty, an LLM/CLI failure message that was written out as the
 * result ("Invalid API key · Please run /login", "API Error: Rate limit reached" — 1,907 of the 3,005 short
 * summaries on the live disk), or a worker's JSON reply. Such a file is never shown as a conversation summary.
 */
export declare function isErrorSummary(text: string): boolean;
/** How a search ran — what a caller needs to tell "nothing matched" from "the search was cut short". */
export interface SearchMeta {
    /**
     * Vector pass: the k of the last KNN, how many candidates it returned, how many of them passed the row
     * conditions (date, agent, embedding version), and whether k hit the sqlite-vec ceiling before `limit`
     * rows passed (the index held more candidates that were never looked at).
     */
    vector?: {
        k: number;
        candidates: number;
        matched: number;
        truncated: boolean;
    };
    /**
     * Keyword pass: whether it used the FTS index or a full LIKE scan of every exchange (and why), and
     * whether its look-ahead past machine-noise matches ended before `limit` rows were found.
     */
    text?: {
        path: 'fts' | 'like-scan';
        reason?: string;
        truncated: boolean;
    };
    /** Snapshot copies of a turn that were folded into the turn's one result. */
    folded?: number;
}
export type SearchHit = SearchResult & {
    summary?: string;
};
export declare function searchConversations(query: string, options?: SearchOptions): Promise<SearchHit[]>;
/** searchConversations plus how the search ran (SearchMeta) — pass both to formatResults. */
export declare function searchConversationsDetailed(query: string, options?: SearchOptions): Promise<{
    results: SearchHit[];
    meta: SearchMeta;
}>;
/** Lines a caller should show with the results: what the search could not look at. */
export declare function searchNotes(meta: SearchMeta | undefined): string[];
/** Characters of each message a json search result carries — the full exchange is one `read` away. */
export declare const SEARCH_JSON_MESSAGE_CHARS = 500;
/**
 * The `search` tool's json answer. It used to serialize every exchange in full (limit 10 → up to 165K
 * characters, limit 50 → 272K); a result now carries the location, the match and a clipped look.
 */
export declare function searchResultsToJson(results: SearchHit[], meta: SearchMeta | undefined, mode: string): string;
/** The json answer of a multi-concept search, clipped the same way. */
export declare function multiConceptResultsToJson(results: MultiConceptResult[], concepts: string[]): string;
export declare function formatResults(results: SearchHit[], meta?: SearchMeta): Promise<string>;
/**
 * Conversations that match ALL concepts, at most `limit`, in one ranking (fuseConceptMatches) of
 *  - exchanges that contain every word of every concept (keyword index), in the keyword pass's order, and
 *  - conversations in which every concept has a semantically near exchange, by average similarity.
 * The second alone — intersecting each concept's nearest 5×limit exchanges — returned nothing on a large
 * index even when dozens of exchanges contained all the words (the lists rarely share a conversation).
 */
export declare function searchMultipleConcepts(concepts: string[], options?: Omit<SearchOptions, 'mode'>): Promise<MultiConceptResult[]>;
export interface KnowledgeContext {
    facts: Array<{
        fact: string;
        category: string;
        domain: string;
        categoryName: string;
        similarity: number;
        relatedFacts: Array<{
            fact: string;
            relationType: string;
        }>;
        /** Neighbours not listed in relatedFacts (the per-fact cap). */
        relatedOmitted?: number;
    }>;
}
/** Characters of a fact in the Related Knowledge section — the full text is one search_facts away. */
export declare const KNOWLEDGE_FACT_CHARS = 300;
/**
 * Enrich search results with knowledge graph context.
 * Finds related facts from the ontology and expands via graph traversal.
 */
export declare function getKnowledgeContext(query: string, project?: string | null, limit?: number): Promise<KnowledgeContext>;
/**
 * Format knowledge context as a readable section appended to search results.
 */
export declare function formatKnowledgeContext(context: KnowledgeContext): string;
export declare function formatMultiConceptResults(results: MultiConceptResult[], concepts: string[]): Promise<string>;
