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
export function extractStatus(x: unknown): number | undefined {
  const o = x as {
    status?: unknown; statusCode?: unknown;
    response?: { status?: unknown; statusCode?: unknown };
  } | undefined;
  for (const c of [o?.status, o?.statusCode, o?.response?.status, o?.response?.statusCode]) {
    if (typeof c === 'number') return c;
  }
  return undefined;
}

/**
 * Wraps a rejection from the LLM provider call (callHaiku) so the drain loop can
 * tell a provider error apart from an internal bug (parser/DB/mutation). ONLY a
 * provider error is eligible for classification + bounded skip; an internal
 * error must hold, never advance the cursor.
 */
export class LlmCallError extends Error {
  readonly reason: unknown;
  readonly status?: number;
  constructor(reason: unknown) {
    const r = reason as { message?: string } | undefined;
    super(r?.message ?? String(reason));
    this.name = 'LlmCallError';
    this.reason = reason;
    this.status = extractStatus(reason);
  }
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
export class EmptyLlmResponseError extends Error {
  constructor(detail = 'LLM returned an empty response') {
    super(detail);
    this.name = 'EmptyLlmResponseError';
  }
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
export function classifyLlmError(err: unknown): LlmErrorClass {
  // An empty body is a call-level failure by construction — no phrase matching.
  const unwrapped = err instanceof LlmCallError ? err.reason : err;
  if (unwrapped instanceof EmptyLlmResponseError) return 'transient';

  // Classify the underlying provider rejection, not the wrapper.
  const e = unwrapped as { message?: string } | undefined;
  const byCode = (code: number): LlmErrorClass => {
    if (code === 401 || code === 403 || code === 404) return 'transient'; // systemic/config — hold, resumes on fix
    if (code === 429 || code >= 500) return 'transient';                  // rate limit / server error
    if (code === 400 || code === 413 || code === 422) return 'deterministic'; // per-request bad/oversized
    return 'unknown';
  };
  const structured = extractStatus(unwrapped);
  if (structured !== undefined) return byCode(structured);

  const m = (e?.message ?? String(err)).toLowerCase();
  // A status number LABELLED in the message ("status code 400", "status: 503") —
  // but never a bare incidental number ("retry after 400 ms").
  const labelled = m.match(/status(?:\s*code)?\s*[:=]?\s*(\d{3})\b/);
  if (labelled) return byCode(parseInt(labelled[1], 10));
  // Provider SDKs also report the code with an error-word prefix and no "status"
  // label: "API Error: 500 Internal Server Error", "http error 429".
  //
  // 🚨 에러 단어(error/failure/code)는 **필수**다. 선택적으로 두면
  // "response 400 ms timeout" 의 400 이 HTTP 400 으로 읽혀 타임아웃이
  // deterministic 으로 뒤집히고, 그 배치는 영구 폐기된다 — 이 변경이 없애려던
  // 손실 클래스가 되살아난다 (Codex 적대 리뷰 R3 CRITICAL, 실측 재현).
  // 인식이 애매하면 'unknown' 으로 떨어뜨리는 편이 안전하다: 추출 경로는
  // unknown 을 이연하므로 데이터가 사라지지 않는다.
  const prefixed = m.match(/\b(?:api|http|request|response|server)\s+(?:error|failure|code)\s*[:=-]?\s*(\d{3})\b/);
  if (prefixed) return byCode(parseInt(prefixed[1], 10));

  // DETERMINISTIC (per-request) phrases checked FIRST so a specific request-size
  // / param error isn't swallowed by the broader transient phrases below.
  if (/too (large|long)|prompt is too long|context length|maximum.*token|max_?tokens|content.*too|invalid[_ ]?request|bad request|unprocessable/.test(m)) {
    return 'deterministic';
  }
  // TRANSIENT phrases: rate limit / server / network / outage, plus auth-KEY
  // errors (kept narrow — "invalid api key", not "invalid api request").
  // 'internal server error' / 'fetch failed' / stream teardown are added from the
  // 2026-07-17 review: they are provider-side or transport failures with no
  // status field, and mis-reading them as per-request faults loses data.
  if (/unauthor|forbidden|invalid.*(api.?key|access.?token|credential)|timeout|etimedout|econnreset|econnrefused|enotfound|epipe|socket hang up|network|fetch failed|stream (disconnect|closed|ended|aborted)|premature close|overloaded|temporarily|rate.?limit|too many requests|internal server error|server error|service unavailable|bad gateway|gateway timeout/.test(m)) {
    return 'transient';
  }
  return 'unknown'; // unrecognized → caller bounds it (retry MAX then advance)
}

/**
 * Back-compat boolean: true only for a RECOGNIZED transient (outage/auth). An
 * 'unknown' error is NOT a recognized transient, so this returns false for it —
 * the drain loop uses classifyLlmError directly and bounds 'unknown' rather than
 * holding on it.
 */
export function isTransientLlmError(err: unknown): boolean {
  return classifyLlmError(err) === 'transient';
}
