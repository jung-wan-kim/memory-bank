import { SearchResult, MultiConceptResult } from './types.js';
export interface SearchOptions {
    limit?: number;
    mode?: 'vector' | 'text' | 'both';
    after?: string;
    before?: string;
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
