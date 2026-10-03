import { EMBEDDING_MODEL, EMBEDDING_VERSION } from './embedding-version.js';
export { EMBEDDING_MODEL, EMBEDDING_VERSION };
export type EmbeddingMode = 'query' | 'passage';
export declare function initEmbeddings(): Promise<void>;
/**
 * @param mode 'passage' for stored/indexed content (facts, exchanges),
 *             'query' for search queries. Defaults to 'passage' because most
 *             call sites embed content; search paths must pass 'query'.
 */
export declare function generateEmbedding(text: string, mode?: EmbeddingMode): Promise<number[]>;
export declare function generateExchangeEmbedding(userMessage: string, assistantMessage: string, toolNames?: string[]): Promise<number[]>;
/**
 * Query-side anisotropy normalization (probe baseline).
 *
 * e5 similarity scores sit in a compressed band (~0.72-0.9 even for unrelated
 * pairs), so a fixed absolute threshold cannot separate relevant from
 * irrelevant. Instead, compare each query↔fact score against the query's own
 * baseline: its best similarity to a fixed set of neutral "background probe"
 * sentences. A fact is relevant only if it beats that baseline by a margin
 * (measured: related pairs +0.047~+0.123, unrelated pairs -0.028~-0.091).
 */
export declare const BACKGROUND_PROBES: string[];
/** Max cosine similarity between the query embedding and the background probes. */
export declare function queryBaseline(queryEmbedding: number[]): Promise<number>;
