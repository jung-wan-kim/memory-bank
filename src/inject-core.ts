import { getSearchDb } from './search.js';
import { l2DistanceToSimilarity } from './db.js';
import { searchSimilarFacts } from './fact-db.js';
import { generateEmbedding, initEmbeddings, queryBaseline } from './embeddings.js';
import { getRelatedFacts } from './ontology-db.js';
import { detectRepeat, formatRepeatContext } from './repeat-detector.js';
import { appendInjectLog } from './inject-log.js';
import { loadLedger, appendLedger } from './inject-ledger.js';
import { injectionQuery } from './prompt-gate.js';
import { factTextKey, truncateFact } from './fact-text.js';
import type { Fact } from './types.js';

const TOP_K = 5;
// Probe-baseline relevance gate (e5 scores are compressed, so absolute
// thresholds cannot separate relevant from irrelevant). A fact is injected
// only when sim(query, fact) exceeds the query's own background baseline by
// this margin. Measured on KR/EN real-DB pairs: related +0.047~+0.123,
// unrelated -0.028~-0.091; long compound "memory" facts can leak in at
// +0.04~+0.045, so the margin sits just above that noise band.
const BASELINE_MARGIN = 0.045;
const MAX_CONTEXT_FACTS = 8;
// Token budget: fact 평균 140자·p90 207자 실측 — 절단 없이 8건이면 ~470 tok/프롬프트.
// fact 당 160자(fact-text.ts FACT_CHAR_CAP) + 블록 1,000자 예산으로 상한. 잘린 내용이 필요하면 search_facts 로 조회.
const BLOCK_CHAR_BUDGET = 1000;
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
      // threshold 0: take top-k by distance, then gate by baseline margin below
      tStage = Date.now();
      const candidates = searchSimilarFacts(db, embedding, project, TOP_K, 0);
      timings.search_ms = Date.now() - tStage;
      const results = candidates.filter((r) => {
        const similarity = l2DistanceToSimilarity(r.distance);
        return similarity - baseline >= BASELINE_MARGIN;
      });

      if (results.length === 0) {
        appendInjectLog({
          ...base, ...queryLen, ...timings, status: 'no-match',
          candidates: candidates.length, injected: 0, duration_ms: Date.now() - t0,
        });
        return { context: '', ledgerKeys: [] };
      }

      // Expand with 1-hop relations
      tStage = Date.now();
      const seenIds = new Set(results.map((r) => r.fact.id));
      const expandedFacts = [...results.map((r) => ({ fact: r.fact, note: '' }))];
      for (const { fact } of results.slice(0, 3)) {
        const related = getRelatedFacts(db, fact.id, 1, 0.6, 0.2, project);
        for (const { fact: relFact, relation } of related) {
          if (!seenIds.has(relFact.id) && expandedFacts.length < MAX_CONTEXT_FACTS) {
            seenIds.add(relFact.id);
            expandedFacts.push({ fact: relFact, note: `[${relation.relation_type}]` });
          }
        }
      }
      timings.related_ms = Date.now() - tStage;

      // 세션 dedup: 이 세션에서 이미 주입한 fact 는 대화 컨텍스트에 이미 있다 —
      // 재주입은 순수 토큰 낭비. 원장에 id 도 본문 키도 없는 fact 만 주입한다.
      // 본문 키는 블록 안에서도 적용한다 — id 만 다른 같은 문장이 한 블록에 두 번 실리지 않게.
      const ledger = loadLedger(sessionId);
      const fresh: Array<{ fact: Fact; note: string; textKey: string }> = [];
      const blockTextKeys = new Set<string>();
      let dedupedCount = 0;
      let textDeduped = 0;
      for (const item of expandedFacts) {
        if (ledger.has(item.fact.id)) { dedupedCount++; continue; }
        const textKey = factTextKey(item.fact);
        if (ledger.has(textKey) || blockTextKeys.has(textKey)) { textDeduped++; continue; }
        blockTextKeys.add(textKey);
        fresh.push({ ...item, textKey });
      }
      if (fresh.length === 0) {
        appendInjectLog({
          ...base, ...queryLen, ...timings, status: 'deduped',
          candidates: candidates.length, injected: 0, deduped: dedupedCount,
          text_deduped: textDeduped, duration_ms: Date.now() - t0,
        });
        return { context: '', ledgerKeys: [] };
      }

      // Format context block — fact 당 160자 절단 + 블록 1,000자 예산
      // (하위 관련도부터 탈락: fresh 는 관련도순이므로 뒤에서 끊긴다)
      const lines = ['📌 관련 과거 결정:'];
      let blockChars = lines[0].length;
      const ledgerKeys: string[] = [];
      let injectedCount = 0;
      let fromVec = 0;
      let fromRel = 0;
      for (const { fact, note, textKey } of fresh) {
        const dateStr = fact.created_at.slice(0, 10);
        const line = `- ${note ? note + ' ' : ''}[${fact.category}] ${truncateFact(fact.fact)} (${dateStr})`;
        if (blockChars + line.length > BLOCK_CHAR_BUDGET && injectedCount > 0) break;
        lines.push(line);
        blockChars += line.length + 1;
        ledgerKeys.push(fact.id, textKey);
        injectedCount++;
        if (note) fromRel++; else fromVec++;
      }

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
        candidates: candidates.length, injected: injectedCount,
        deduped: dedupedCount, text_deduped: textDeduped,
        from_vec: fromVec, from_rel: fromRel, chars: block.length,
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

/**
 * computeInjectResult + an immediate ledger commit, for an in-process caller
 * that uses the block right away. The hook client does not use this: it
 * commits only after its stdout write succeeds (deliver() in
 * scripts/inject-context.js).
 */
export async function computeInjectContext(
  userPrompt: string,
  project: string,
  via: 'daemon' | 'fallback',
  sessionId?: string,
  meta: InjectRequestMeta = {},
): Promise<string> {
  const { context, ledgerKeys } = await computeInjectResult(userPrompt, project, via, sessionId, meta);
  if (ledgerKeys.length > 0) appendLedger(sessionId, loadLedger(sessionId), ledgerKeys);
  return context;
}
