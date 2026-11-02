import { getSearchDb } from './search.js';
import { generateEmbedding, initEmbeddings, queryBaseline } from './embeddings.js';
import { detectRepeat, formatRepeatContext } from './repeat-detector.js';
import { appendInjectLog, pluginVersion, sessionKey, shortId } from './inject-log.js';
import { loadLedger } from './inject-ledger.js';
import { injectionQuery } from './prompt-gate.js';
import { factTextKey } from './fact-text.js';
import { formatInjectBlock, PRODUCTION_SELECT_OPTIONS, selectInjectFacts, type SelectedLine } from './inject-select.js';
// detectRepeat 는 exchanges 전체(335k) 벡터검색이다. OS 페이지 캐시가 식은 상태에서
// 583~844ms 가 걸려 주입 지연의 대부분을 차지했다(2026-10-03 실측: 데몬 웜 24ms).
// 게다가 cwd 와 슬러그를 비교하던 버그로 2,686회 주입 동안 결과를 한 번도 내지
// 못했다 — 비용만 내고 가치는 0. 비교는 고쳤지만 가치가 측정되기 전까지 기본은 끈다.
// 켜려면 MCP 서버 환경에 MEMORY_BANK_REPEAT_DETECT=1.
// better-sqlite3 는 동기라 시작한 검색을 타이머로 선점할 수 없다(Promise.race 는
// 무효 — Codex 리뷰 지적). 대신 시작 "전" 경과 예산을 확인해 생략한다.
const REPEAT_ELAPSED_BUDGET_MS = 700;

function repeatDetectEnabled(): boolean {
  return process.env.MEMORY_BANK_REPEAT_DETECT === '1';
}

/** Who called the hook — recorded in the inject log, never used for ranking. */
export interface InjectRequestMeta {
  client?: string;
  entrypoint?: string;
  /** Cold fallback only: why the daemon did not answer ('no-daemon', 'daemon-timeout', 'daemon-closed', 'daemon-error'). */
  fallback_reason?: string;
  /**
   * One id per hook run, sent to the daemon and used again by the fallback. When
   * the client gives up, the daemon's line and the fallback line share it, so a
   * block computed but never delivered is not counted as a second injection.
   */
  req_id?: string;
  /** Which thin client made the hook request: the native binary or the node script (inject log only). */
  client_impl?: 'native' | 'node';
}

/**
 * The block plus the ledger keys (fact id + text key per injected fact) that
 * mark it as shown in this session. Committing those keys is the job of
 * whoever DELIVERS the block: the daemon only computes it, and a client that
 * gave up waiting falls back to its own computation — when the daemon still
 * committed, the abandoned block's facts were recorded as shown though they
 * never reached the session, and stayed suppressed for the rest of it
 * (measured 2026-10-03: the fallback then injected 2 facts, deduped 6).
 *
 * `failed` marks a computation that threw (model load, DB). The block is empty
 * either way, but an empty failure must not reach the client as an empty
 * success — the daemon answers {ok:false} so the client tries its own path.
 */
export interface InjectResult {
  context: string;
  ledgerKeys: string[];
  failed?: boolean;
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
export async function computeInjectResult(
  userPrompt: string,
  project: string,
  via: 'daemon' | 'fallback',
  sessionId?: string,
  meta: InjectRequestMeta = {},
): Promise<InjectResult> {
  const t0 = Date.now();
  const base = {
    project,
    prompt_len: userPrompt?.length ?? 0,
    via,
    client: meta.client || undefined,
    entrypoint: meta.entrypoint || undefined,
    has_session: Boolean(sessionId),
    fallback_reason: meta.fallback_reason || undefined,
    req_id: meta.req_id || undefined,
    client_impl: meta.client_impl === 'native' || meta.client_impl === 'node' ? meta.client_impl : undefined,
    session_key: sessionKey(sessionId),
    plugin_version: pluginVersion(),
  };
  const gate = injectionQuery(userPrompt);
  if (gate.reason !== null) {
    appendInjectLog({ ...base, status: 'skipped', reason: gate.reason });
    return { context: '', ledgerKeys: [] };
  }
  // Usually the prompt itself; the arguments of an expanded slash command or the
  // text after leading system reminders otherwise (prompt-gate.ts).
  const query = gate.query;
  const queryLen = query.length !== base.prompt_len ? { query_len: query.length } : {};

  const timings: { embed_ms?: number; search_ms?: number; related_ms?: number; repeat_ms?: number } = {};
  try {
    let tStage = Date.now();
    await initEmbeddings();
    const embedding = await generateEmbedding(query, 'query');
    const baseline = await queryBaseline(embedding);
    timings.embed_ms = Date.now() - tStage;

    // Cached long-lived handle (file-identity checked) — initDatabase()'s
    // full migration pass per request costs ~38ms and is pure overhead in the
    // warm daemon. NOT closed here: getSearchDb owns its lifecycle.
    const db = getSearchDb();
    {
      const selection = selectInjectFacts(db, embedding, baseline, project, PRODUCTION_SELECT_OPTIONS);
      timings.search_ms = selection.timings.search_ms;
      const candidates = selection.candidates;
      const decision = {
        top_margins: selection.topMargins.map((m) => Math.round(m * 1000) / 1000),
        gated_ids: selection.gated.map((g) => shortId(g.fact.id)),
        ...(PRODUCTION_SELECT_OPTIONS.relMargin !== null
          ? { rel_gated_out: selection.relGatedOut, rel_unscored: selection.relUnscored }
          : {}),
      };

      if (selection.gated.length === 0) {
        appendInjectLog({
          ...base, ...queryLen, ...timings, status: 'no-match',
          candidates, injected: 0, ...decision, duration_ms: Date.now() - t0,
        });
        return { context: '', ledgerKeys: [] };
      }
      timings.related_ms = selection.timings.related_ms;

      // 세션 dedup: 이 세션에서 이미 주입한 fact 는 대화 컨텍스트에 이미 있다 —
      // 재주입은 순수 토큰 낭비. 원장에 id 도 본문 키도 없는 fact 만 주입한다.
      // 본문 키는 블록 안에서도 적용한다 — id 만 다른 같은 문장이 한 블록에 두 번 실리지 않게.
      const ledger = loadLedger(sessionId);
      const fresh: Array<SelectedLine & { textKey: string }> = [];
      const blockTextKeys = new Set<string>();
      let dedupedCount = 0;
      let textDeduped = 0;
      for (const item of selection.lines) {
        if (ledger.has(item.fact.id)) { dedupedCount++; continue; }
        const textKey = factTextKey(item.fact);
        if (ledger.has(textKey) || blockTextKeys.has(textKey)) { textDeduped++; continue; }
        blockTextKeys.add(textKey);
        fresh.push({ ...item, textKey });
      }
      if (fresh.length === 0) {
        appendInjectLog({
          ...base, ...queryLen, ...timings, status: 'deduped',
          candidates, injected: 0, deduped: dedupedCount,
          text_deduped: textDeduped, ...decision, duration_ms: Date.now() - t0,
        });
        return { context: '', ledgerKeys: [] };
      }

      const { lines, shown } = formatInjectBlock(fresh);
      const injectedItems = fresh.slice(0, shown);
      const ledgerKeys = injectedItems.flatMap(({ fact, textKey }) => [fact.id, textKey]);
      const injectedCount = injectedItems.length;
      const fromRel = injectedItems.filter((item) => item.origin === 'rel').length;
      const fromVec = injectedCount - fromRel;

      // Detect repeated prompts — opt-in (see REPEAT_ELAPSED_BUDGET_MS). 동기
      // sqlite 검색이라 시작 후엔 선점 불가 — 예산을 이미 썼으면 시작 자체를 생략.
      if (repeatDetectEnabled() && Date.now() - t0 < REPEAT_ELAPSED_BUDGET_MS) {
        tStage = Date.now();
        try {
          const repeats = await detectRepeat(query, project, 2, 0.85, { embedding, db });
          const repeatCtx = formatRepeatContext(repeats);
          if (repeatCtx) {
            lines.push('');
            lines.push(repeatCtx);
          }
        } catch { /* best-effort */ }
        timings.repeat_ms = Date.now() - tStage;
      }

      const block = lines.join('\n') + '\n';
      appendInjectLog({
        ...base, ...queryLen, ...timings, status: 'injected',
        candidates, injected: injectedCount,
        deduped: dedupedCount, text_deduped: textDeduped,
        from_vec: fromVec, from_rel: fromRel, chars: block.length,
        ...decision, injected_ids: injectedItems.map((item) => shortId(item.fact.id)),
        duration_ms: Date.now() - t0,
      });
      return { context: block, ledgerKeys };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendInjectLog({
      ...base, ...queryLen, ...timings, status: 'error',
      duration_ms: Date.now() - t0, error: message.slice(0, 300),
    });
    return { context: '', ledgerKeys: [], failed: true }; // non-fatal: never disrupt the user's prompt
  }
}
