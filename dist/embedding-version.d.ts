/**
 * Embedding model identity, split out of embeddings.ts (2026-10-03) so that
 * modules needing only the version stamp — db.ts and fact-db.ts, and through
 * them the synchronous SessionStart hook — do not load @xenova/transformers
 * and its native onnxruntime/sharp bindings just to read a constant. The hook
 * blocks Claude's first response, so that import cost is paid at every
 * session start. embeddings.ts re-exports both names.
 */
export declare const EMBEDDING_MODEL: string;
export declare const EMBEDDING_VERSION: number;
