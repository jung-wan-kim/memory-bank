/** Who called the hook — recorded in the inject log, never used for ranking. */
export interface InjectRequestMeta {
    client?: string;
    entrypoint?: string;
}
/**
 * Compute the UserPromptSubmit context block for a prompt: top-K similar
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
export declare function computeInjectContext(userPrompt: string, project: string, via: 'daemon' | 'fallback', sessionId?: string, meta?: InjectRequestMeta): Promise<string>;
