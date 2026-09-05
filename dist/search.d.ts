import { SearchResult, ConversationExchange, MultiConceptResult } from './types.js';
import type DatabaseType from 'better-sqlite3';
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
/**
 * Stable JSON projection shared by the MCP response path and tests. Keeping
 * provenance in this projection prevents the transport layer from silently
 * dropping fields that searchConversations correctly computed.
 */
export declare function serializeSearchResult(result: SearchResult): {
    exchange: ConversationExchange;
    similarity: number | null;
    matchSource: "text" | "vector" | "both";
    textScore: number | null;
    vectorScore: number | null;
    snippet: string;
};
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
