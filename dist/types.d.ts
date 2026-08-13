export interface ToolCall {
    id: string;
    exchangeId: string;
    toolName: string;
    toolInput?: any;
    toolResult?: string;
    isError: boolean;
    timestamp: string;
}
export interface ConversationExchange {
    id: string;
    project: string;
    timestamp: string;
    userMessage: string;
    assistantMessage: string;
    archivePath: string;
    lineStart: number;
    lineEnd: number;
    parentUuid?: string;
    isSidechain?: boolean;
    sessionId?: string;
    cwd?: string;
    gitBranch?: string;
    claudeVersion?: string;
    thinkingLevel?: string;
    thinkingDisabled?: boolean;
    thinkingTriggers?: string;
    codingAgent?: string;
    toolCalls?: ToolCall[];
}
export interface SearchResult {
    exchange: ConversationExchange;
    /**
     * Backward-compatible aggregate score for vector-backed rows. Literal text
     * search does not currently calculate a comparable ranked score, so those
     * rows return null instead of the former synthetic 1.0 placeholder.
     */
    similarity: number | null;
    /** Which retrieval surface(s) produced this row. */
    matchSource: 'text' | 'vector' | 'both';
    /** Literal-search score, or null when the text backend is unranked. */
    textScore: number | null;
    /** Semantic vector similarity, or null when no vector matched this row. */
    vectorScore: number | null;
    snippet: string;
}
export interface MultiConceptResult {
    exchange: ConversationExchange;
    snippet: string;
    conceptSimilarities: number[];
    averageSimilarity: number;
}
export type FactCategory = 'decision' | 'preference' | 'pattern' | 'knowledge' | 'constraint';
export type FactScopeType = 'global' | 'project';
export type FactRelation = 'DUPLICATE' | 'CONTRADICTION' | 'EVOLUTION' | 'INDEPENDENT';
export interface Fact {
    id: string;
    fact: string;
    category: FactCategory;
    scope_type: FactScopeType;
    scope_project: string | null;
    source_exchange_ids: string[];
    embedding: Float32Array | null;
    created_at: string;
    updated_at: string;
    consolidated_count: number;
    is_active: boolean;
    ontology_category_id?: string | null;
    coding_agent?: string | null;
    /** User-assigned free-form labels. Never written by the automatic pipeline. */
    tags?: string[];
}
export interface FactRevision {
    id: string;
    fact_id: string;
    previous_fact: string;
    new_fact: string;
    reason: string | null;
    source_exchange_id: string | null;
    created_at: string;
}
export interface FactSearchResult {
    fact: Fact;
    similarity: number;
}
export interface ExtractedFact {
    fact: string;
    fact_kr?: string;
    category: FactCategory;
    scope_type: FactScopeType;
    confidence: number;
}
export interface ConsolidationResult {
    relation: FactRelation;
    merged_fact: string;
    reason: string;
}
export interface OntologyDomain {
    id: string;
    name: string;
    description: string | null;
    created_at: string;
}
export interface OntologyCategory {
    id: string;
    domain_id: string;
    name: string;
    description: string | null;
    created_at: string;
}
export type RelationType = 'INFLUENCES' | 'SUPERSEDES' | 'SUPPORTS' | 'CONTRADICTS';
export interface OntologyRelation {
    id: string;
    source_fact_id: string;
    relation_type: RelationType;
    target_fact_id: string;
    reasoning: string | null;
    created_at: string;
}
export interface AvatarResponse {
    answer: string;
    sources: Array<{
        fact: Fact;
        domain: string;
        category: string;
        relevance: number;
    }>;
    confidence: number;
    relatedDecisions: Array<{
        fact: Fact;
        relation: RelationType;
    }>;
}
export interface DomainTree {
    domain: OntologyDomain;
    categories: Array<{
        category: OntologyCategory;
        facts: Fact[];
    }>;
}
