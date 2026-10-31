/**
 * Oversize guard (ported from obra/episodic-memory #139). A single message that
 * pastes a whole transcript or tool dump is not a memory, and embedding it
 * bloats the index for no recall gain. The embedder only reads the first 2000
 * characters anyway (embeddings.ts), so the rest is pure storage.
 */
export declare const DEFAULT_MAX_MESSAGE_BYTES: number;
export declare function getMaxMessageBytes(env?: NodeJS.ProcessEnv): number;
export declare function isOversizeExchange(exchange: {
    userMessage?: string;
    assistantMessage?: string;
}, maxBytes: number): boolean;
