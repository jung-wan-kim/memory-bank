/**
 * LLM 실패 3분류 — 단일 소스.
 *
 * consolidator 의 drain 루프와 llm.ts 의 재시도 루프가 **같은 판정**을 써야 한다:
 * 한쪽만 어떤 에러를 transient 로 보면 재시도는 하는데 커서는 넘어가는(또는 그 반대)
 * 불일치가 생긴다. 그래서 정의를 이 모듈에 두고 양쪽이 import 한다
 * (consolidator 는 기존 importer 를 위해 re-export — coupling drift 차단).
 */
export type LlmErrorClass = 'transient' | 'deterministic' | 'unknown';
/**
 * Extract an HTTP status from the common provider-error shapes: a top-level
 * `status`/`statusCode` (Anthropic SDK APIError) OR a nested `response.status`/
 * `response.statusCode` (axios / fetch-wrapper style). Reading only the top
 * level misses nested shapes and misclassifies a real 400/413 as 'unknown'.
 */
export declare function extractStatus(x: unknown): number | undefined;
/**
 * Wraps a rejection from the LLM provider call (callHaiku) so the drain loop can
 * tell a provider error apart from an internal bug (parser/DB/mutation). ONLY a
 * provider error is eligible for classification + bounded skip; an internal
 * error must hold, never advance the cursor.
 */
export declare class LlmCallError extends Error {
    readonly reason: unknown;
    readonly status?: number;
    constructor(reason: unknown);
}
/**
 * The provider call completed without producing any text — the Agent SDK stream
 * ended with no result message, or the result was empty/whitespace.
 *
 * This is a CALL-level failure, not "the model legitimately answered nothing":
 * every caller here asks for JSON, so an empty body is never a valid answer.
 * Returning '' for it (the old behaviour) made a failed call indistinguishable
 * from a successful empty one, so callers "consumed" the failure as a real
 * verdict — budget spent, batch dropped, session marked done. Classified
 * 'transient' so it is retried and, if it persists, surfaces as a throw.
 */
export declare class EmptyLlmResponseError extends Error {
    constructor(detail?: string);
}
/**
 * Classify a callHaiku rejection into three states so the drain loop can satisfy
 * BOTH "an outage must never silently skip the backlog" AND "one un-processable
 * fact must never wedge the cursor forever" — a binary flag cannot do both under
 * a single monotonic cursor with imperfect error recognition:
 *
 *   - 'transient'     recognized outage/auth (429/5xx/401/403/404, rate-limit,
 *                     timeout, network...) or an empty response. The provider —
 *                     not the fact — is at fault, so the caller HOLDS the cursor
 *                     and retries; it resumes cleanly on recovery, never
 *                     skipping during an outage however long it lasts.
 *   - 'deterministic' recognized per-request rejection (400/413/422, too-long,
 *                     max_tokens, bad request...). Only THIS fact is at fault, so
 *                     the caller burns an attempt and advances after MAX.
 *   - 'unknown'       neither recognized. Treated like 'deterministic' by the
 *                     caller (bounded retry → advance) so an UNRECOGNIZED error
 *                     can never wedge the whole backlog forever. This is safe:
 *                     "skipping" a fact only means it isn't consolidated/deduped
 *                     — the fact stays active and searchable, it is never deleted
 *                     — whereas an unbounded hold halts ALL future consolidation.
 *
 * Numbers are read from the STRUCTURED status, or from a status number that is
 * explicitly LABELLED in the message ("status code 400"). A bare incidental
 * number ("retry after 400 ms") is never read as a status — it falls through to
 * phrase matching or 'unknown'.
 */
export declare function classifyLlmError(err: unknown): LlmErrorClass;
/**
 * Back-compat boolean: true only for a RECOGNIZED transient (outage/auth). An
 * 'unknown' error is NOT a recognized transient, so this returns false for it —
 * the drain loop uses classifyLlmError directly and bounds 'unknown' rather than
 * holding on it.
 */
export declare function isTransientLlmError(err: unknown): boolean;
