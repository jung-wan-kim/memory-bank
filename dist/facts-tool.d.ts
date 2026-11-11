import type Database from 'better-sqlite3';
/**
 * Text of the fact tools (search_facts, trace_fact, cross_project_insights, explore_graph), given the query
 * embedding. Kept out of mcp-server.ts — that module starts the server when imported — so the tools' output
 * can be tested: what they filter, what they cap, and what they say they left out.
 */
/** Source conversations listed per traced fact (a fact can record thousands of source ids). */
export declare const TRACE_MAX_SOURCES = 5;
/** Connected facts listed per seed in explore_graph, and the characters of each. */
export declare const EXPLORE_MAX_CONNECTED = 20;
export declare const EXPLORE_FACT_CHARS = 300;
export interface FactSearchParams {
    query: string;
    project: string;
    category?: string;
    coding_agent?: string;
    tags?: string[];
    include_revisions?: boolean;
    limit: number;
}
export declare function formatFactSearch(db: Database.Database, queryEmbedding: number[], params: FactSearchParams): string;
export declare function formatFactTrace(db: Database.Database, queryEmbedding: number[], params: {
    query: string;
    project: string;
    limit: number;
}): string;
export declare function formatCrossProjectInsights(db: Database.Database, queryEmbedding: number[], params: {
    query: string;
    currentProject: string;
    limit: number;
}): string;
export declare function formatGraphExploration(db: Database.Database, queryEmbedding: number[], params: {
    query: string;
    hops: number;
    project?: string;
}): string;
