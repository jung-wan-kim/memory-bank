/** Who called the hook — recorded in the inject log, never used for ranking. */
export interface InjectRequestMeta {
    client?: string;
    entrypoint?: string;
    /** Cold fallback only: why the daemon did not answer ('daemon-timeout', 'no-daemon'). */
    fallback_reason?: string;
}
/**
 * The block plus the ledger keys (fact id + text key per injected fact) that
 * mark it as shown in this session. Committing those keys is the job of
 * whoever DELIVERS the block: the daemon only computes it, and a client that
 * gave up waiting falls back to its own computation — when the daemon still
 * committed, the abandoned block's facts were recorded as shown though they
 * never reached the session, and stayed suppressed for the rest of it
 * (measured 2026-10-03: the fallback then injected 2 facts, deduped 6).
 */
export interface InjectResult {
    context: string;
    ledgerKeys: string[];
}
/**
 * Compute the UserPromptSubmit context block for a prompt, WITHOUT recording it
 * in the session ledger (see InjectResult): top-K similar
 * facts gated by the probe baseline, expanded with 1-hop ontology relations,
 * deduped against the session ledger by id and by text. Repeated-prompt
 * detection runs only when MEMORY_BANK_REPEAT_DETECT=1. Returns '' when there
 * is nothing to inject.
 *
 * Shared by BOTH execution paths:
 *  - the warm in-process daemon inside the MCP server (embeddings already
 *    loaded → ~150ms), and
 *  - the cold fallback in scripts/inject-context.js (fresh node process,
 *    ~2.3s dominated by model load) used when no MCP server is running.
 *
 * `via` tags the inject log so the two paths stay distinguishable.
 */
export declare function computeInjectResult(userPrompt: string, project: string, via: 'daemon' | 'fallback', sessionId?: string, meta?: InjectRequestMeta): Promise<InjectResult>;
/**
 * computeInjectResult + the ledger commit, for a caller that delivers the block
 * itself right away (the cold fallback in scripts/inject-context.js).
 */
export declare function computeInjectContext(userPrompt: string, project: string, via: 'daemon' | 'fallback', sessionId?: string, meta?: InjectRequestMeta): Promise<string>;
