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
}
export declare function searchConversations(query: string, options?: SearchOptions): Promise<SearchResult[]>;
export declare function formatResults(results: Array<SearchResult & {
    summary?: string;
}>): Promise<string>;
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
    }>;
}
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
