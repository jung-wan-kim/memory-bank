/**
 * Index one session's transcript right before its facts are extracted.
 *
 * Conversations are indexed only by the SessionStart sync, and facts are
 * extracted at SessionEnd from the index. A session that starts and ends with
 * no other session starting in between is therefore extracted before any of
 * its exchanges are indexed (measured 2026-11-10: 93.7% of the SessionEnd
 * worker's results were 0/0, 88% of those in under 0.2 s — no LLM call). The
 * SessionEnd worker calls this first, so the extractor reads the whole session.
 *
 * The indexing itself is indexer.ts's indexSession (the `index-session` CLI
 * path). Two things it does not do are handled here:
 *  - indexSession indexes any transcript it finds; sync skips one that carries
 *    an exclusion marker. A session the user marked as not-to-be-indexed must
 *    stay unindexed on this path too, so the marker check runs first.
 *  - importing indexer.ts sets CLAUDE_CODE_MAX_OUTPUT_TOKENS for the whole
 *    process (the summarizer's cap). No summary is made here, and the
 *    extraction calls that follow in the same worker keep their own setting.
 */
export { EXCLUSION_MARKERS as INDEX_EXCLUSION_MARKERS } from './conversation-guard.js';
export type PreindexResult = {
    status: 'indexed';
} | {
    status: 'no_transcript';
} | {
    status: 'excluded_marker';
} | {
    status: 'invalid_session_id';
} | {
    status: 'failed';
    error: string;
};
/**
 * The transcript indexSession would pick for this session (same walk: the first
 * non-excluded project folder holding a .jsonl whose name contains the id), or null.
 */
export declare function findSessionTranscript(sessionId: string): string | null;
/**
 * Index `sessionId`'s transcript (no summary). Never throws: the caller is a
 * detached worker whose next step — extraction — reports for itself whether
 * anything is indexed.
 */
export declare function preindexSession(sessionId: string): Promise<PreindexResult>;
