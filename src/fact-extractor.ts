import Database from 'better-sqlite3';
import type { ExtractedFact } from './types.js';
import { callHaiku, parseJsonResponse } from './llm.js';
import { classifyLlmError, LlmCallError } from './llm-error-class.js';
import { insertFact } from './fact-db.js';
import { generateEmbedding, initEmbeddings } from './embeddings.js';
import { classifyAndLinkFacts } from './ontology-classifier.js';
import { randomUUID } from 'node:crypto';
import { factRejectReason, factKrRejectReason, normalizeCategory } from './fact-validity.js';
import { secretRejectReason } from './secret-scan.js';
import { resolveRepoRoots } from './project-family.js';
import {
  claimSessionSql, renewClaimSql, failureMarkerUpsertSql, freshClaimPredicate,
  isExcludedProjectPath, EXTRACTION_STATE, MAX_INTERNAL_RETRIES, ensureSeenExchangesColumn,
} from './pending-extraction.js';

export const EXTRACTION_SYSTEM_PROMPT = `You are an expert at extracting long-term facts from conversations.

## Rules
- 1 fact = 1 sentence (concise)
- Ignore trivial exchanges (greetings, "yes", "thanks")
- Code snippets are NOT facts - extract only decisions/patterns
- Credentials are NOT facts - never copy an API key, token, password or any other
  secret value into a fact (that a credential exists, or where it is kept, can be one)
- No duplicate facts within the same batch
- Prefer durable facts (decisions, conventions, constraints, lessons) over
  session-ephemeral details ("user is currently editing file X" is NOT a fact)
- The session's environment is NOT a fact: where the project folder is, that it
  is a git repository, which branch is checked out
- Capture problem→solution lessons as "pattern"
  (e.g., "X error in this project is caused by Y and fixed by Z")

## scope determination
- project: specific files/paths/DB/API/framework/business logic
- global: coding style, language/response format, common tool usage

## Output format (JSON array)
[
  {
    "fact": "<one English sentence stating the fact>",
    "fact_kr": "<the same sentence in natural Korean>",
    "category": "decision",
    "scope_type": "project",
    "confidence": 0.9
  }
]
(This shows the shape only. Write real sentences in "fact" and "fact_kr" — never copy the bracketed text.)

## fact_kr rules
- Natural Korean translation of "fact"
- Keep technical terms (API/tool/framework names, file paths, commands) in English

## category choices
- decision: architecture/technology decisions
- preference: user preferences
- pattern: repeated patterns
- knowledge: project knowledge
- constraint: constraints

## confidence criteria
- 0.9+: explicit decision/declaration
- 0.7-0.9: inferred from behavior
- Below 0.7: do not extract`;

/** 선점(claim)을 잃어 작업을 중단할 때 던진다. 호출자는 이것을 실패가 아니라
 *  "다른 러너가 이 세션을 가져갔다"로 읽어야 한다 — 예산을 소모하지 않는다. */
export class ClaimLostError extends Error {
  constructor(message: string) { super(message); this.name = 'ClaimLostError'; }
}

const BATCH_SIZE = 5; // configurable-ok
// 세션당 저장 상한 = min(절대 상한, max(바닥, 배치당 몫 × 선택 배치 수)).
// 바닥 20 은 예전 고정 상한이다 — 배치 4개 이하인 세션은 결과가 달라지지 않는다.
const MAX_FACTS_PER_SESSION = 20; // configurable-ok
const FACTS_PER_SELECTED_BATCH = 5; // configurable-ok — 단일 배치 세션의 배치당 사실 중앙값(실측 5)
// MEMORY_BANK_MAX_EXTRACT_CALLS 로 배치 수를 올려도 넘지 않는 상한(저장 뒤 사실마다 분류 LLM 1회).
// 배치 수 자체의 상한도 이 값이다(MAX_EXTRACT_CALLS_CEILING).
const ABSOLUTE_MAX_FACTS_PER_SESSION = 60; // configurable-ok
const CONFIDENCE_THRESHOLD = 0.7; // configurable-ok
const DEFAULT_MAX_LLM_CALLS = 12; // configurable-ok — per-session LLM call budget

/** Trivial acknowledgements (EN/KR) that carry no extractable signal. */
const TRIVIAL_USER_PATTERN = /^(ok(ay)?|yes|no|y|n|thanks?|thank you|good|nice|great|done|go|proceed|continue|응|넵?|네|예|아니오?|ㅇㅇ|ㅇㅋ|ㄱㄱ|좋아요?|그래|고마워요?|감사(합니다|해요)?|해줘|진행해?줘?|계속(해줘)?)[.!~\s]*$/i;

/**
 * Whether an exchange is worth sending to the extraction LLM.
 * Filters harness artifacts (local command output), bare slash commands,
 * and trivial acknowledgements — they waste LLM calls and produce noise facts.
 */
export function isSubstantiveExchange(userMessage: string, assistantMessage: string): boolean {
  const user = (userMessage ?? '').trim();
  const assistant = (assistantMessage ?? '').trim();

  if (!user) return false;
  // Harness/system artifacts injected as user turns, not human input
  if (
    user.startsWith('<local-command-stdout>') ||
    user.startsWith('<local-command-caveat>') ||
    user.startsWith('<command-name>') ||
    user.startsWith('Caveat:')
  ) return false;
  // Bare slash commands like /clear, /model, /codex:review
  if (/^\/[\w:-]+$/.test(user)) return false;
  // Trivial acknowledgement with no substantive reply
  if (TRIVIAL_USER_PATTERN.test(user) && assistant.length < 200) return false;
  // Near-empty prompt with a near-empty answer
  if (user.length < 5 && assistant.length < 80) return false;
  return true;
}

/** Normalize fact text for cross-batch duplicate detection within a session. */
export function normalizeFactText(fact: string): string {
  return fact.toLowerCase().replace(/\s+/g, ' ').replace(/[.!。]+$/g, '').trim();
}

/**
 * Confidence gate for extracted facts. Rejects missing/NaN confidence —
 * `undefined < 0.7` is false, so a naive `<` check would accept unscored
 * facts from malformed LLM output.
 */
export function passesConfidenceGate(confidence: unknown): boolean {
  return typeof confidence === 'number'
    && !Number.isNaN(confidence)
    && confidence >= CONFIDENCE_THRESHOLD;
}

/**
 * Cap LLM calls for long sessions by picking evenly spread batches, so the
 * beginning, middle, and end of a session are all represented instead of
 * only the head.
 */
export function selectSpreadBatches<T>(batches: T[], maxBatches: number): T[] {
  if (batches.length <= maxBatches) return batches;
  if (maxBatches <= 1) return [batches[0]];
  const selected: T[] = [];
  const step = (batches.length - 1) / (maxBatches - 1);
  const used = new Set<number>();
  for (let i = 0; i < maxBatches; i++) {
    const idx = Math.round(i * step);
    if (!used.has(idx)) {
      used.add(idx);
      selected.push(batches[idx]);
    }
  }
  return selected;
}

/** 세션당 저장 상한 — 선택된 배치 수에 비례하고, 바닥과 절대 상한 사이에 든다. */
export function sessionFactCap(selectedBatches: number): number {
  return Math.min(
    ABSOLUTE_MAX_FACTS_PER_SESSION,
    Math.max(MAX_FACTS_PER_SESSION, FACTS_PER_SELECTED_BATCH * selectedBatches),
  );
}

/**
 * 배치별 후보에서 `cap` 건을 고른다. 합이 상한 이하면 전부(순서 그대로).
 * 넘으면 배치마다 신뢰도 높은 것부터 한 건씩 돌아가며 뽑는다 — 어느 배치도 다른
 * 배치의 후보 때문에 통째로 밀려나지 않는다. 마지막 바퀴에 자리가 모자라면 그 바퀴
 * 후보 중 신뢰도 높은 것, 같으면 뒤쪽 배치 것을 고른다(긴 세션의 결론은 뒤에 있다).
 * 결과는 원래 순서(배치 순, 배치 안에서는 LLM 이 낸 순)다.
 */
export function selectFactsAcrossBatches<T extends { confidence: number }>(perBatch: T[][], cap: number): T[] {
  const total = perBatch.reduce((n, batch) => n + batch.length, 0);
  if (total <= cap) return perBatch.flat();

  const ranked = perBatch.map((batch) =>
    batch.map((_, i) => i).sort((x, y) => batch[y].confidence - batch[x].confidence || x - y));
  const keep = perBatch.map(() => new Set<number>());
  let kept = 0;
  for (let rank = 0; kept < cap; rank++) {
    const round: number[] = [];
    for (let b = 0; b < perBatch.length; b++) if (rank < ranked[b].length) round.push(b);
    if (round.length === 0) break;
    const room = cap - kept;
    const chosen = round.length <= room
      ? round
      : [...round]
        .sort((x, y) => perBatch[y][ranked[y][rank]].confidence - perBatch[x][ranked[x][rank]].confidence || y - x)
        .slice(0, room);
    for (const b of chosen) keep[b].add(ranked[b][rank]);
    kept += chosen.length;
  }
  return perBatch.flatMap((batch, b) => batch.filter((_, i) => keep[b].has(i)));
}

/**
 * The most extraction batches MEMORY_BANK_MAX_EXTRACT_CALLS can ask for. A
 * session stores at most ABSOLUTE_MAX_FACTS_PER_SESSION facts, picked one per
 * batch in turn (selectFactsAcrossBatches): with this many batches every slot is
 * already taken by a batch's best fact, so a further batch is a call whose
 * result cannot be stored. Without a ceiling the value was used as given —
 * 1000 sent all 80 batches of a 400-exchange session (measured).
 */
export const MAX_EXTRACT_CALLS_CEILING = ABSOLUTE_MAX_FACTS_PER_SESSION; // configurable-ok

/**
 * How many extraction batches one session may send (MEMORY_BANK_MAX_EXTRACT_CALLS,
 * default 12, at most MAX_EXTRACT_CALLS_CEILING). `clampedFrom` is the value
 * asked for when it was above the ceiling. Anything that is not a positive
 * integer is the default — it is not read by its leading digits ('1e3' is not 1).
 *
 * This bounds the BATCHES, not every LLM call of a session: a batch whose call
 * fails for a transient reason is tried again inside callHaiku (3 attempts by
 * default), and every stored fact gets its ontology classification and
 * relation calls on top.
 */
export function extractCallBudget(): { calls: number; clampedFrom?: number } {
  const raw = (process.env.MEMORY_BANK_MAX_EXTRACT_CALLS ?? '').trim();
  if (!/^\d+$/.test(raw)) return { calls: DEFAULT_MAX_LLM_CALLS };
  const asked = Number(raw);
  if (asked < 1) return { calls: DEFAULT_MAX_LLM_CALLS };
  return asked > MAX_EXTRACT_CALLS_CEILING ? { calls: MAX_EXTRACT_CALLS_CEILING, clampedFrom: asked } : { calls: asked };
}

// Self-referential repos whose conversations must NOT be extracted (e.g.
// memory-bank's own monitoring/cron sessions — extracting them creates noise
// facts and an endless feedback loop). Comma-separated cwd paths, env-overridable.
// 🚨 제외 목록은 **단일 소스**(getExtractionConfig)에서 온다. 여기서 따로 파싱하면
// pending SQL 필터와 이 판정이 갈라져, 제외 대상이 선정된 뒤에야 걸러지거나(슬롯 낭비)
// 정규화가 한쪽에만 적용된다(R22 MEDIUM — 후행 슬래시 수정이 이쪽에만 들어갔었다).
// 파일 헤더가 명시한 "두 소비자는 동일 술어" 계약이 그것이다.

function isExcludedProject(project: string | null | undefined): boolean {
  // 판정(경로 경계 비교)은 pending-extraction.ts 의 isExcludedProjectPath 하나다.
  return isExcludedProjectPath(project);
}

/**
 * 이 세션의 project 사실을 묶을 범위. linked worktree(그 하위 폴더 포함)에서 끝난 세션은
 * 본 저장소 루트로 읽고, 그 밖에는 받은 경로 그대로다.
 *
 * scope_project 는 세션이 끝난 순간의 cwd 였다. worktree 는 일이 끝나면 지워지고, 지워진
 * 경로의 사실은 어느 저장소에서도 보이지 않는다(읽는 쪽의 저장소 묶음 판정 —
 * project-family.ts — 은 디스크에 없는 경로를 어느 저장소의 것으로도 보지 않는다. 저장소
 * 밖에 둔 worktree 의 사실은 폴더가 있는 동안에도 저장소에서 안 보인다). 추출 시점에는
 * 폴더가 있어 본 저장소를 확인할 수 있으므로 그때 옮겨 적는다.
 *
 * 판정은 resolveRepoRoots 하나다 — `.git` 파일이 가리키는 관리 폴더의 역참조까지 맞아야
 * 본 저장소로 인정한다. 그래서 아래는 전부 받은 경로 그대로다: 저장소 루트와 그 하위 폴더
 * (예전부터 정확한 경로가 범위였다), 저장소가 아닌 폴더, 디스크에 없는 경로(어느
 * 저장소였는지 알 수 없다 — 추측하지 않는다), 홈 폴더가 본 저장소인 경우, 슬러그 꼴 이름.
 *
 * 본 저장소가 추출 제외 목록에 있으면 옮기지 않는다 — 제외된 범위에 사실을 넣지 않는다
 * (그 세션을 추출할지는 예전 판정 그대로다: 저장소 밖의 worktree 는 예전에도 추출됐다).
 *
 * 원래 폴더는 사실의 source_exchange_ids → exchanges.cwd 로 되짚을 수 있다.
 */
export function extractionScopeProject(project: string): string {
  if (typeof project !== 'string' || project === '') return project;
  const roots = resolveRepoRoots(project);
  // [worktree 자기 루트, 본 저장소 루트] 일 때만 linked worktree 다(project-family.ts 의 계약).
  if (roots.length !== 2) return project;
  const main = roots[1];
  return isExcludedProject(main) ? project : main;
}

/**
 * 자격증명 모양 문자열이 든 사실인가(영문·한글 어느 쪽이든). 사유(종류)만 돌려준다 —
 * 호출자는 이것을 세고 로그에 남기되 문장 자체는 로그에 쓰지 않는다.
 */
function factSecretReason(fact: { fact: unknown; fact_kr?: unknown }): string | null {
  return secretRejectReason(fact.fact) ?? secretRejectReason(fact.fact_kr);
}

/** { 'secret-jwt': 2, … } → 'secret-jwt×2, …' (로그용 — 값은 싣지 않는다) */
function describeReasonCounts(counts: Record<string, number>): string {
  return Object.entries(counts).map(([reason, n]) => `${reason}×${n}`).join(', ');
}

export function buildExtractionPrompt(
  exchanges: Array<{ user_message: string; assistant_message: string }>,
): string {
  return exchanges.map((ex, i) => {
    const userSnippet = ex.user_message.slice(0, 1000);
    const assistantSnippet = ex.assistant_message.slice(0, 1000);
    return `### Exchange ${i + 1}\nUser: ${userSnippet}\nAssistant: ${assistantSnippet}`;
  }).join('\n\n');
}

/**
 * @param stats 선택적 out-param. deterministic 실패로 **폐기된 배치 수**를 돌려준다
 *   (dead-letter 회계). 선택적이라 기존 호출자는 그대로 동작한다.
 *   `truncatedFacts` 는 세션 상한 때문에 저장 대상에서 빠진 후보 수다.
 */
export async function extractFactsFromExchanges(
  db: Database.Database,
  sessionId: string,
  stats?: ExtractionStats,
  /**
   * 배치마다 호출되는 리스 갱신 훅. 리스보다 오래 걸리는 정상 추출이 회수 대상이
   * 되어 다른 워커가 선점하는 것을 막는다(R7 HIGH-1). throw 하면 즉시 중단한다 —
   * 이미 claim 을 잃었다는 뜻이므로 계속하면 중복 작업이다.
   */
  renewLease?: () => void,
): Promise<ExtractedFact[]> {
  const exchanges = db.prepare(`
    SELECT id, user_message, assistant_message
    FROM exchanges
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `).all(sessionId) as Array<{ id: string; user_message: string; assistant_message: string }>;

  if (stats) stats.seenExchanges = exchanges.length;

  const substantive = exchanges.filter(
    ex => isSubstantiveExchange(ex.user_message, ex.assistant_message),
  );
  if (substantive.length === 0) return [];

  const batches: Array<typeof substantive> = [];
  for (let i = 0; i < substantive.length; i += BATCH_SIZE) {
    batches.push(substantive.slice(i, i + BATCH_SIZE));
  }
  const budget = extractCallBudget();
  if (budget.clampedFrom !== undefined && batches.length > budget.calls) {
    console.error(
      `fact-extractor: MEMORY_BANK_MAX_EXTRACT_CALLS=${budget.clampedFrom} is above the ceiling — `
      + `${budget.calls} of ${batches.length} batches are sent`,
    );
  }
  const selectedBatches = selectSpreadBatches(batches, budget.calls);

  // 🚨 세션 상한은 배치 루프를 **다 돈 뒤에** 적용한다. 예전에는 루프 맨 위에서
  // "20건이 찼으면 중단"이라, 긴 세션은 앞쪽 2~3개 배치에서 상한이 차고 뒤쪽 배치는
  // LLM 에 가지도 않았다(실측 2026-11-10: 20건에서 끊긴 74회의 대조된 사실 82.5% 가
  // 앞 1/5 구간, 뒤 1/5 는 1.7%). selectSpreadBatches 가 고르게 골라도 무효였다.
  const candidatesPerBatch: ExtractedFact[][] = [];
  const seen = new Set<string>();
  // transient(공급자 장애·빈 응답)로 실패한 배치. >0 이면 이 세션은 "처리 완료"가 아니다.
  const transientFailures: unknown[] = [];

  for (let b = 0; b < selectedBatches.length; b++) {
    const batchFacts: ExtractedFact[] = [];
    candidatesPerBatch.push(batchFacts);

    const prompt = buildExtractionPrompt(selectedBatches[b]);
    renewLease?.(); // 배치 직전 갱신 — LLM 왕복이 리스를 넘겨도 회수되지 않는다

    try {
      const response = await callHaiku(EXTRACTION_SYSTEM_PROMPT, prompt);
      const extracted = parseJsonResponse<ExtractedFact[]>(response, 'array');

      if (extracted && Array.isArray(extracted)) {
        const rejectReasons: Record<string, number> = {};
        const secretReasons: Record<string, number> = {};
        let unknownCategories = 0;
        for (const fact of extracted) {
          if (typeof fact?.fact !== 'string' || fact.fact.trim() === '') continue;
          // Template residue ('...', 'concise statement', 'a|b|c' category), a copy
          // of the prompt's example and session-environment boilerplate are
          // dropped here, before the save transaction — insertFact would throw
          // on them and roll back the whole batch.
          const rejectReason = factRejectReason(fact);
          if (rejectReason) { rejectReasons[rejectReason] = (rejectReasons[rejectReason] ?? 0) + 1; continue; }
          // 자격증명이 든 사실은 후보가 되지 않는다(상한 자리도 차지하지 않는다).
          const secretReason = factSecretReason(fact);
          if (secretReason) { secretReasons[secretReason] = (secretReasons[secretReason] ?? 0) + 1; continue; }
          if (!passesConfidenceGate(fact.confidence)) continue;

          const key = normalizeFactText(fact.fact);
          if (seen.has(key)) continue; // cross-batch duplicate within this session
          seen.add(key);
          // 한글 문장 칸만 자리표시자·예시 문장이면 그 칸만 버리고 사실은 살린다.
          if (factKrRejectReason(fact.fact_kr)) fact.fact_kr = undefined;
          // 다섯 분류 밖의 이름('requirement', 'process' …)은 접어서 저장한다 — 그대로 두면
          // 어떤 category 필터에도 걸리지 않는다. 표에 없는 이름은 knowledge 로 두고 센다.
          const folded = normalizeCategory(fact.category);
          if (!folded.known) unknownCategories++;
          fact.category = folded.category;
          batchFacts.push(fact);
        }
        const rejected = Object.values(rejectReasons).reduce((n, c) => n + c, 0);
        if (rejected > 0) {
          if (stats) {
            stats.rejectedInvalid ??= {};
            for (const [reason, n] of Object.entries(rejectReasons)) {
              stats.rejectedInvalid[reason] = (stats.rejectedInvalid[reason] ?? 0) + n;
            }
          }
          console.error(
            `fact-extractor: dropped ${rejected} fact(s) refused by fact-validity from batch ${b + 1}`
            + ` (${describeReasonCounts(rejectReasons)})`,
          );
        }
        if (unknownCategories > 0) {
          console.error(`fact-extractor: ${unknownCategories} fact(s) in batch ${b + 1} had an unknown category — stored as knowledge`);
        }
        const secretCount = Object.values(secretReasons).reduce((n, c) => n + c, 0);
        if (secretCount > 0) {
          if (stats) stats.rejectedSecrets = (stats.rejectedSecrets ?? 0) + secretCount;
          console.error(
            `fact-extractor: dropped ${secretCount} fact(s) carrying a credential-shaped string from batch ${b + 1}`
            + ` (${describeReasonCounts(secretReasons)})`,
          );
        }
      }
    } catch (error) {
      // 실패를 3분류한다 — 예전에는 전부 삼켜서, 공급자 장애로 한 건도 못 뽑은
      // 세션이 extraction_log 에 '완료(0건)'로 기록되고 pending 쿼리에서 영구 제외됐다
      // (그 대화의 fact 는 영원히 추출되지 않음 = 데이터 손실).
      //
      // 🚨 추출 경로는 consolidation 과 위험이 비대칭이라 'unknown' 처리가 다르다:
      // consolidation 에서 건너뛴 fact 는 살아 있고 검색되지만(중복제거만 미실행),
      // 추출에서 건너뛴 배치는 **fact 가 애초에 만들어지지 않는다** — 되돌릴 수 없다.
      // 그래서 인식 못 한 에러(unknown)는 '이 요청 잘못'으로 단정하지 않고 transient
      // 와 같이 이연한다(다음 run 재시도). 무한 재시도 위험은 callHaiku 가 이미 유한
      // 재시도로 흡수했고, 워커가 이연 건수를 로그로 표면화한다.
      // (Codex 적대 리뷰 2026-07-17: 'API Error: 500 …' 이 unknown 으로 떨어져
      //  배치 폐기 → 세션 완료 기록 = 원 결함 재현. 분류기 보강 + 이 이연이 이중 방어.)
      const cls = classifyLlmError(error);
      if (cls === 'deterministic') {
        // 요청 자체가 잘못됨(400/413/max_tokens): 같은 입력은 같은 결과이므로 이
        // 배치만 포기하고 진행한다 — 여기서 이연하면 세션이 큐를 영구히 막는다.
        // 단 폐기를 **기록**한다(dead-letter): 조용히 버리면 그 교환들의 fact 가
        // 사라진 사실 자체가 보이지 않는다 (Codex 리뷰 2026-07-17).
        if (stats) stats.droppedBatches += 1;
        console.error(`Batch ${b} extraction failed (deterministic — batch dropped, recorded):`, error);
      } else {
        transientFailures.push(error);
        console.error(`Batch ${b} extraction failed (${cls} — session deferred, will retry):`, error);
        // The whole session is deferred and its facts discarded (throw below),
        // so the remaining batches would be spent for nothing — during a usage
        // limit that is up to 12 batches × 3 attempts per session per run.
        break;
      }
    }
  }

  // 공급자 장애가 하나라도 있었으면 이 세션을 완료로 기록하면 안 된다. 호출자
  // (extractAndSaveFacts)가 extraction_log 기록을 건너뛰도록 throw 로 표면화한다.
  if (transientFailures.length > 0) {
    throw new LlmCallError(transientFailures[0]);
  }

  const candidates = candidatesPerBatch.reduce((n, batch) => n + batch.length, 0);
  const cap = sessionFactCap(selectedBatches.length);
  const allFacts = selectFactsAcrossBatches(candidatesPerBatch, cap);
  const truncated = candidates - allFacts.length;
  if (stats) stats.truncatedFacts = truncated;
  if (truncated > 0) {
    console.error(
      `fact-extractor: session ${sessionId} — 후보 ${candidates}건 중 ${allFacts.length}건만 저장 대상`
      + `(상한 ${cap}, 배치 ${selectedBatches.length}개), ${truncated}건은 신뢰도순으로 잘림`,
    );
  }

  return allFacts;
}

export async function saveExtractedFacts(
  db: Database.Database,
  facts: ExtractedFact[],
  project: string,
  sourceExchangeIds: string[],
  codingAgent?: string,
  /**
   * 🚨 저장 구간은 파이프라인에서 **가장 긴** 단계다 — fact 당 임베딩 2회 +
   * classifyAndLinkFact(내부에서 callHaiku = 헤드리스 세션 1회)를 세션 상한(sessionFactCap)까지 반복.
   * 여기가 리스 밖이면 정상 작업이 회수돼 다른 워커가 같은 세션을 저장한다
   * (Codex R8 HIGH: R7 HIGH-1 의 잔존 구간). fact 마다 갱신·소유권 확인한다.
   */
  renewLease?: () => void,
  /**
   * 🚨 완료 마커를 **fact 삽입과 같은 트랜잭션 안에서** 쓰기 위한 커밋 훅.
   * 갱신 행 수를 반환하며 0 이면(=선점을 잃음) 트랜잭션 전체가 롤백된다.
   *
   * 체크포인트(리스 확인)를 아무리 촘촘히 박아도 **마지막 확인과 커밋 사이**에는
   * 항상 창이 남는다 — R7(배치)→R8(저장 루프)→R9(루프 꼬리)로 같은 결함이 세 번
   * 좁아지기만 했다. 원인은 "저장"과 "소유권 확정"이 서로 다른 시점이라는 구조다.
   * 둘을 원자적으로 묶으면 창의 크기와 무관하게 닫힌다: 커밋 순간 소유권이 없으면
   * fact 도 남지 않으므로 중복이 생길 수 없다.
   */
  commitMarker?: (extracted: number, saved: number) => number,
): Promise<string[]> {
  // 저장 직전 판정: 자격증명이 든 사실은 어떤 호출자가 넘겼든 여기서 걸러진다.
  // (추출 루프가 이미 한 번 걸렀으므로 그 경로에서는 0건이다.)
  const secretReasons: Record<string, number> = {};
  facts = facts.filter((fact) => {
    const reason = factSecretReason(fact);
    if (reason) secretReasons[reason] = (secretReasons[reason] ?? 0) + 1;
    return !reason;
  });
  if (Object.keys(secretReasons).length > 0) {
    console.error(
      `fact-extractor: refused to save fact(s) carrying a credential-shaped string (${describeReasonCounts(secretReasons)})`,
    );
  }

  await initEmbeddings();

  // 1단계(비동기): 임베딩만 먼저 계산한다 — 트랜잭션은 동기여야 하므로.
  const prepared: Array<{ fact: ExtractedFact; embedding: number[]; embeddingKr: number[] | null }> = [];
  for (const fact of facts) {
    renewLease?.(); // 잃었으면 여기서 중단 — 비싼 임베딩을 더 돌리지 않는다
    prepared.push({
      fact,
      embedding: await generateEmbedding(fact.fact),
      embeddingKr: fact.fact_kr ? await generateEmbedding(fact.fact_kr) : null,
    });
  }

  // 2단계(동기·원자적): fact 삽입 + 완료 마커를 한 트랜잭션으로. 마커가 0행이면
  // 선점을 잃은 것이므로 throw → 삽입까지 통째로 롤백된다(부분 저장 잔존 없음).
  const savedIds: string[] = [];
  const commit = db.transaction(() => {
    for (const p of prepared) {
      savedIds.push(insertFact(db, {
        fact: p.fact.fact,
        category: p.fact.category,
        scope_type: p.fact.scope_type,
        scope_project: p.fact.scope_type === 'project' ? project : null,
        source_exchange_ids: sourceExchangeIds,
        embedding: p.embedding,
        coding_agent: codingAgent,
        fact_kr: p.fact.fact_kr ?? null,
        embedding_kr: p.embeddingKr,
      }));
    }
    if (commitMarker && commitMarker(facts.length, savedIds.length) === 0) {
      throw new ClaimLostError(
        '완료 마커가 0행 — 저장 중 선점을 잃었습니다. fact 삽입을 롤백합니다(중복 방지).',
      );
    }
  });
  try {
    commit();
  } catch (e) {
    savedIds.length = 0; // 롤백됐으므로 호출자에게 저장 0건으로 보고
    throw e;
  }

  // 3단계(비동기, 커밋 이후): 온톨로지 분류. 파생 작업이라 실패해도 fact 는 유효하다.
  // 저장한 fact 전부를 분류 호출 1회로 보낸다(예전: fact 마다 1회 — 20건이면 헤드리스 세션 20개).
  try {
    await classifyAndLinkFacts(db, savedIds.map((id, i) => ({ factId: id, embedding: prepared[i].embedding })));
  } catch (err) {
    console.error(`Ontology pipeline failed for ${savedIds.length} fact(s):`, err);
  }

  return savedIds;
}

/**
 * 추출 실패의 분류 — **라우팅(예산 소모 여부)과 보고(로그·카운터)가 같은 정의를 쓴다.**
 *
 * 🚨 이전에는 소비자가 3분류(handoff/provider/internal)인데 실제 이연 판정은 4분류였다:
 * deterministic 한 공급자 거절(400/413/422 · prompt-too-long)은 재시도해도 같은 결과라
 * 재시도 예산(-4, 3회 후 -2 영구제외)을 **소모하는데**, 워커는 그것을 'provider' 로 세어
 * "will retry next run" 이라 보고하고 internalFailures 도 0 이라 아무 경보가 없었다.
 * 즉 예산이 조용히 타들어가는 동안 로그는 "곧 재시도됨"이라고 말했다(Codex R12 HIGH).
 * 분류를 4분류로 맞추고 라우팅 술어까지 같은 모듈에 둬서 둘이 어긋날 수 없게 한다.
 */
export type ExtractionFailureKind =
  | 'handoff'                // 다른 러너가 인수 — 실패 아님. 예산 무관, 경보 아님
  | 'provider_transient'     // 장애·빈응답·rate limit — 예산 미소모, 다음 run 재시도
  // ⚠️ 현재 이 파이프라인에서는 **도달하지 않는다**: 배치 루프가 deterministic 거절을
  //    드롭(dropped_batches)하고 transient 만 모아 던지므로, catch 에 오는 LlmCallError
  //    는 항상 non-deterministic 이다. 유일한 다른 LLM 경로(classifyAndLinkFact)는 자체
  //    catch 로 전량 삼킨다. 분류를 남겨두는 이유는 **라우팅 계약을 명시**하기 위함이며
  //    (도달하게 되면 예산을 소모하는 것이 맞다), 도달 여부는 테스트가 주장하지 않는다.
  | 'provider_deterministic' // 요청 자체가 거절됨 — 재시도 무의미, 예산 소모
  | 'internal';              // 런타임·DB·파서 — 예산 소모 + 운영 점검 대상

export function classifyExtractionFailure(err: unknown): ExtractionFailureKind {
  if (err instanceof ClaimLostError) return 'handoff';
  if (err instanceof LlmCallError) {
    return classifyLlmError(err) === 'deterministic' ? 'provider_deterministic' : 'provider_transient';
  }
  return 'internal';
}

/**
 * 소비자 보고·집계 표 — 라벨·문구뿐 아니라 **카운터 버킷과 예산 소모 여부까지** 여기서
 * 나온다. 워커가 자체 분기를 들면 "예산 판정과 카운터가 반대로 붙는" 실수를 테스트가
 * 잡지 못한다(문자열 검사는 워커가 결과를 무시해도 통과) — 분기 자체를 없앤다.
 *
 * `escalate`: 운영자가 손을 대야 하는 실패인가. R12 수정 과정에서 요약줄의
 * "INTERNAL failures — 런타임/DB 점검 필요" 경보가 일반 예산 회계로 대체돼 사라졌던
 * 것을 이 플래그로 복원한다(Codex R13 MEDIUM — 내가 만든 회귀).
 */
export const FAILURE_REPORT: Record<ExtractionFailureKind, {
  label: string; note: string;
  bucket: 'handoff' | 'transient' | 'budget';
  consumesBudget: boolean;
  escalate: boolean;
}> = {
  handoff: {
    label: 'HANDOFF', note: '다른 러너가 인수 — 실패 아님',
    bucket: 'handoff', consumesBudget: false, escalate: false,
  },
  provider_transient: {
    label: 'ERROR', note: '공급자 일시 실패 — 예산 미소모, 다음 run 재시도',
    bucket: 'transient', consumesBudget: false, escalate: false,
  },
  provider_deterministic: {
    label: 'ERROR', note: '요청 거절 — 재시도 무의미, 예산 소모(반복 시 영구 제외)',
    bucket: 'budget', consumesBudget: true, escalate: false,
  },
  internal: {
    label: 'ERROR', note: '런타임/DB 점검 필요 — 예산 소모',
    bucket: 'budget', consumesBudget: true, escalate: true,
  },
};

/**
 * 이 실패가 재시도 예산을 소모하는가. runFactExtraction 의 라우팅과 워커의 보고가
 * **같은 술어**를 보게 해서 "예산은 타는데 로그는 재시도된다고 말하는" 모순을 막는다.
 */
export function failureConsumesBudget(kind: ExtractionFailureKind): boolean {
  // 표에서 파생 — 명시 비교로 두면 새 분류가 조용히 false 로 떨어진다(Codex R13 LOW).
  // Record 타입이라 분류를 추가하면 표가 컴파일 에러를 낸다(강제력 대칭).
  return FAILURE_REPORT[kind].consumesBudget;
}

/** extractFactsFromExchanges 의 out-param (dead-letter·상한 회계). */
export interface ExtractionStats {
  droppedBatches: number;
  /** 세션 상한 때문에 저장 대상에서 빠진 후보 수 */
  truncatedFacts?: number;
  /** 자격증명 모양 문자열이 들어 있어 버린 사실 수 */
  rejectedSecrets?: number;
  /** fact-validity 가 거부한 사실 수(사유별) — 템플릿 잔여물·프롬프트 예시·세션 환경 상용구 */
  rejectedInvalid?: Record<string, number>;
  /** 이번 추출이 읽은 그 세션의 교환 수 — 완료 마커(seen_exchanges)에 남긴다 */
  seenExchanges?: number;
}

/** runFactExtraction 의 결과. `skipped` 가 있으면 이 세션은 이번 실행에서 처리되지 않았다. */
export interface ExtractionRunResult {
  extracted: number;
  saved: number;
  /** 세션 상한 때문에 잘린 후보 수(0 이면 없음) — 워커가 로그에 남긴다 */
  truncated?: number;
  /** 자격증명 모양 문자열이 들어 있어 저장하지 않은 사실 수(0 이면 없음) */
  rejectedSecrets?: number;
  /** fact-validity 가 거부한 사실 수(사유별, 없으면 생략) — 프롬프트를 바꾼 뒤 예시 베끼기가 느는지 로그로 본다 */
  rejectedInvalid?: Record<string, number>;
  /** project 사실을 받은 경로가 아닌 본 저장소 루트에 묶었을 때만 — 그 루트(worktree 세션) */
  scopeProject?: string;
  skipped?:
    | 'claim_not_acquired' | 'claim_error'
    | 'excluded_project' | 'excluded_project_unmarked'
    | 'not_indexed' | 'no_new_exchanges';
}

export async function runFactExtraction(
  db: Database.Database,
  sessionId: string,
  project: string,
  codingAgent?: string,
  /**
   * claimVariant: 선점 조건. 'hook'(기본)은 살아있는 claim 만 존중하고 확정 마커
   * 위에서도 선점한다(--resume 세션 재추출은 의도된 동작). 'worker'는 자기가
   * pending 으로 선정했던 상태(미기록 / -4 / 리스만료 claim)일 때만 선점한다 —
   * 선정 후 훅이 먼저 확정했다면 그 위를 덮지 않아 중복 추출이 생기지 않는다.
   * 선점·복원을 이 함수가 단독으로 소유하므로 호출자 간 로직 분기가 없다.
   */
  opts?: { claimVariant?: 'worker' | 'hook' },
  /**
   * 🚨 `skipped` 는 "처리 안 함"의 **사유**다. 이게 없으면 호출자가 claim 미획득을
   * "fact 0건 처리 완료"와 구분하지 못해 정상 세션으로 계상하고, 유일한 흔적인
   * console.error 는 detached 워커의 stdio:'ignore' 로 폐기된다 — 무경보 기아
   * (Codex R18 독립 발견).
   *
   * `not_indexed`: 이 세션의 교환이 색인 DB 에 하나도 없다. 마커를 쓰지 않으므로
   * 색인된 뒤 backfill 이 다시 집는다.
   * `no_new_exchanges`: 완료 마커가 이미 있고 그 뒤로 교환이 늘지 않았다(훅 변형).
   */
): Promise<ExtractionRunResult> {
  // Skip self-referential repos (memory-bank's own monitoring sessions) — mark
  // as processed with zero facts so they are never re-attempted, no LLM calls.
  if (isExcludedProject(project)) {
    // 🚨 마커가 **실제로 써졌는지**를 반환값이 구분해야 한다. 삼키고 'excluded_project'
    // 를 돌려주면 호출자가 "영구 마커가 써진 정상 흐름"으로 단정해 버킷·경보 없이
    // 넘기고, INSERT 가 일시 실패한 세션은 마커 없이 매 run 슬롯만 점유한다
    // (무경보 무진전 — 이 스레드가 계속 닫아온 클래스, Codex R20 MEDIUM).
    let markerWritten = false;
    try {
      // 🚨 다른 마커 쓰기는 전부 소유권·상태 가드가 있는데(claim WHERE owned,
      // failureMarkerUpsertSql, writeCompletionMarker 의 ownGuard) **이 경로만 무가드**
      // 였다. 살아있는 claim(-3) 위에 0/0 을 덮으면 소유자는 리스갱신 실패로 중단되고,
      // 그 롤백은 extracted=-3 을 요구하므로 무효가 되어 행이 0/0 확정마커로 남는다 →
      // 세션이 pending 에서 영구 제외되고 워커는 'handoff' 로 거짓 계상한다
      // (Codex R21 HIGH, 재현됨). 처리 **중**인 세션만 건드리지 않는다 — 리스가
      // 만료된 claim 은 죽은 소유자의 것이므로 회수 대상이다. `<> CLAIMED` 로 두면
      // 만료 claim 까지 존중해 그 세션이 마커를 영원히 못 받고 매 run 재선정된다
      // (R22 HIGH, 5/5 run 진전 0). 코드베이스의 다른 모든 경로와 같은 술어를 쓴다.
      const res = db.prepare(`
        INSERT INTO extraction_log (session_id, processed_at, extracted, saved)
        VALUES (?, ?, 0, 0)
        ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
          extracted = 0, saved = 0
        WHERE NOT (${freshClaimPredicate()})
      `).run(sessionId, new Date().toISOString());
      markerWritten = res.changes > 0;
      if (!markerWritten) {
        console.error(
          `extraction: session ${sessionId} 제외 마커를 쓰지 않았습니다 — 다른 러너가 선점 중`,
        );
      }
    } catch (e) {
      console.error(
        `extraction: session ${sessionId} 제외 마커 기록 실패 — 다음 run 재선정됩니다: `
        + `${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return {
      extracted: 0, saved: 0,
      skipped: markerWritten ? 'excluded_project' : 'excluded_project_unmarked',
    };
  }

  // 🚨 색인된 교환이 0개인 세션은 "0건 처리 완료"가 아니다 — 아직 입력이 없는 것이다.
  // 색인은 SessionStart 의 sync 에서만 일어나고 이 함수는 SessionEnd 에 불리므로,
  // 여기서 0/0 완료 마커를 쓰면 정상 종료한 세션이 pending 에서 영구 제외된다
  // (실측 2026-11-10: 7월 이후 0건 마커 15,833개 중 6,548개가 지금은 실질 교환이 있다).
  // 마커도 claim 도 남기지 않고 사유만 돌려준다 — 색인된 뒤 backfill 이 다시 집는다.
  let indexedExchanges: number;
  try {
    indexedExchanges = (db.prepare('SELECT COUNT(*) AS n FROM exchanges WHERE session_id = ?')
      .get(sessionId) as { n: number }).n;
  } catch (e) {
    // 선점 전의 DB 오류 — 마커·예산에 아무 변화가 없으므로 실패 분류기에 넘기지 않는다.
    console.error(
      `extraction: session ${sessionId} — 색인 교환 수 조회 실패(${e instanceof Error ? e.message : String(e)}), 이번 실행은 보류합니다`,
    );
    return { extracted: 0, saved: 0, skipped: 'claim_error' };
  }
  if (indexedExchanges === 0) {
    console.error(`extraction: session ${sessionId} — 색인된 교환 0개, 완료 마커를 쓰지 않습니다(not_indexed)`);
    return { extracted: 0, saved: 0, skipped: 'not_indexed' };
  }

  // 🚨 훅 변형은 확정 마커 위에서도 선점한다(--resume 으로 교환이 늘어난 세션의 재추출).
  // 그런데 같은 세션의 SessionEnd 가 60초 안에 두 번 오는 일이 잦고(실측 840쌍), 교환이
  // 그대로인 두 번째 실행은 같은 입력을 통째로 다시 추출해 사실이 두 벌이 된다. 완료
  // 마커가 기억하는 교환 수(seen_exchanges)와 지금 수가 같으면 할 일이 없다.
  // 교환 수를 모르는 옛 마커(NULL)·컬럼을 만들지 못한 DB 는 예전 동작(재추출) 그대로다.
  // 컬럼은 변형과 무관하게 보장한다 — backfill 이 끝낸 세션의 마커도 교환 수를 남겨야
  // 뒤이은 SessionEnd 가 그것을 다시 추출하지 않는다.
  const hasSeenColumn = ensureSeenExchangesColumn(db);
  if ((opts?.claimVariant ?? 'hook') === 'hook' && hasSeenColumn) {
    let prior: { extracted: number; seen_exchanges: number | null } | undefined;
    try {
      prior = db.prepare('SELECT extracted, seen_exchanges FROM extraction_log WHERE session_id = ?')
        .get(sessionId) as { extracted: number; seen_exchanges: number | null } | undefined;
    } catch (e) {
      // 읽지 못하면 판단하지 않는다 — 아래 선점 단계가 같은 DB 오류를 보류로 처리한다.
      console.error(`extraction: session ${sessionId} — 이전 마커 조회 실패(${e instanceof Error ? e.message : String(e)})`);
    }
    if (prior && prior.extracted >= 0 && prior.seen_exchanges === indexedExchanges) {
      console.error(
        `extraction: session ${sessionId} — 지난 추출 뒤 새 교환 없음(${indexedExchanges}개 그대로), 다시 추출하지 않습니다`,
      );
      return { extracted: 0, saved: 0, skipped: 'no_new_exchanges' };
    }
  }

  // 🚨 LLM 을 부르기 **전에** 세션을 선점한다. SessionEnd 훅과 backfill 워커는
  // 서로를 직렬화할 수단이 없고 마커는 파이프라인 끝에 써지므로, 선점이 없으면
  // 둘이 같은 세션을 각자 추출해 fact 가 두 벌 저장된다(Codex R6 HIGH).
  // 마커 시점에 막는 것은 늦다 — 그때는 이미 비용도 중복도 발생한 뒤다.
  // 선점 이전 상태를 기억해 둔다 — 실패 시 그대로 되돌려야 재시도 카운터(saved)가
  // 보존된다. 무조건 DELETE 로 풀면 매 run 카운터가 0 으로 리셋돼 예산이 영원히
  // 소진되지 않는다(무한 재시도 = R3 기아의 다른 얼굴).
  const owner = randomUUID();
  let preClaim: { extracted: number; saved: number } | undefined;
  let holdsClaim = false;
  try {
    preClaim = db.prepare('SELECT extracted, saved FROM extraction_log WHERE session_id = ?')
      .get(sessionId) as { extracted: number; saved: number } | undefined;
    const claimed = db.prepare(claimSessionSql(opts?.claimVariant ?? 'hook'))
      .run(sessionId, new Date().toISOString(), owner).changes;
    if (claimed === 0) {
      console.error(`extraction: session ${sessionId} — 다른 라이터가 선점/확정함, 이번 실행은 건너뜁니다`);
      return { extracted: 0, saved: 0, skipped: 'claim_not_acquired' };
    }
    holdsClaim = true;
  } catch (e) {
    // 🚨 실패를 2분류한다. 전부 "오래된 DB"로 보고 선점 없이 진행하면, SQLITE_BUSY
    // 같은 **일시 오류가 상호배제를 우회**해 중복 LLM 호출·중복 insert 를 낸다
    // (R7 HIGH-3, external-probe-gate-classification: 일시 오류는 보류이지 통과가 아님).
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      console.error(`extraction: session ${sessionId} — extraction_log 부재(구버전 DB), 선점 없이 진행`);
    } else if (/no such column:? ?claim_owner|has no column named claim_owner/i.test(msg)) {
      // 마이그레이션이 락으로 지연된 경우다. 조용히 스킵하면 그 run 의 pending 세션이
      // 무음으로 빠지므로, 컬럼을 즉시 추가해 자가치유한 뒤 한 번만 재시도한다.
      try {
        try {
          db.prepare('ALTER TABLE extraction_log ADD COLUMN claim_owner TEXT').run();
        } catch (eAlter) {
          // 동시 실행이 먼저 추가했으면 목적은 이미 달성 — 보류할 이유가 없다.
          // (R8 수정이 한 층 아래에서 같은 '문구 불일치'를 만들었던 자리다.)
          if (!/duplicate column name/i.test(eAlter instanceof Error ? eAlter.message : String(eAlter))) throw eAlter;
        }
        const retried = db.prepare(claimSessionSql(opts?.claimVariant ?? 'hook'))
          .run(sessionId, new Date().toISOString(), owner).changes;
        if (retried === 0) {
          console.error(`extraction: session ${sessionId} — 다른 라이터가 선점/확정함, 건너뜁니다`);
          return { extracted: 0, saved: 0, skipped: 'claim_not_acquired' };
        }
        holdsClaim = true;
        console.error(`extraction: claim_owner 컬럼을 즉시 추가하고 선점 재시도 성공 (session ${sessionId})`);
      } catch (e2) {
        console.error(
          `extraction: session ${sessionId} — claim_owner 마이그레이션 실패(${e2 instanceof Error ? e2.message : e2}), `
          + `이번 실행은 보류합니다(다음 run 재시도)`,
        );
        return { extracted: 0, saved: 0, skipped: 'claim_error' };
      }
    } else {
      console.error(`extraction: session ${sessionId} — claim 실패(${msg}), 이번 실행은 보류합니다`);
      return { extracted: 0, saved: 0, skipped: 'claim_error' };
    }
  }

  /**
   * 리스 갱신 겸 소유권 확인. 잃었으면 즉시 throw 해서 중단한다 —
   * 계속 진행하면 새 소유자와 중복 작업이 된다.
   */
  const renewLease = () => {
    if (!holdsClaim) return;
    const renewed = db.prepare(renewClaimSql())
      .run(new Date().toISOString(), sessionId, owner).changes;
    if (renewed === 0) {
      holdsClaim = false; // 남의 행이 되었으므로 롤백도 하지 않는다
      throw new ClaimLostError(`claim lost for session ${sessionId} (리스 회수됨) — 중복 방지를 위해 중단`);
    }
  };

  /** 내 claim 만 되돌린다 — 소유권 토큰으로 다른 러너의 claim 을 건드리지 않는다. */
  const releaseClaim = () => {
    if (!holdsClaim) return;
    try {
      if (preClaim) {
        db.prepare(
          'UPDATE extraction_log SET extracted = ?, saved = ?, claim_owner = NULL '
          + `WHERE session_id = ? AND extracted = ${EXTRACTION_STATE.CLAIMED} AND claim_owner = ?`,
        ).run(preClaim.extracted, preClaim.saved, sessionId, owner);
      } else {
        db.prepare(
          `DELETE FROM extraction_log WHERE session_id = ? AND extracted = ${EXTRACTION_STATE.CLAIMED} AND claim_owner = ?`,
        ).run(sessionId, owner);
      }
    } catch { /* 로그 테이블 부재 — 원 에러를 그대로 올린다 */ }
  };

  /** 내부 실패 마커(-4 예산 / 소진 시 -2). 내 claim 위에서만 쓴다. */
  const writeInternalFailureMarker = (kind: ExtractionFailureKind = 'internal') => {
    if (!holdsClaim) return;
    try {
      const attempts = (preClaim?.extracted === EXTRACTION_STATE.RETRIABLE_INTERNAL ? preClaim.saved : 0) + 1;
      const exhausted = attempts >= MAX_INTERNAL_RETRIES;
      db.prepare(failureMarkerUpsertSql()).run(
        sessionId, new Date().toISOString(),
        exhausted ? EXTRACTION_STATE.PERMANENT : EXTRACTION_STATE.RETRIABLE_INTERNAL,
        exhausted ? 0 : attempts, owner,
      );
      console.error(
        `extraction: session ${sessionId} 실패 [${kind}] (attempt ${attempts}/${MAX_INTERNAL_RETRIES}`
        + `${exhausted ? ' — 예산 소진, 영구 마커로 승격' : ' — 다음 run 재시도'}) — ${FAILURE_REPORT[kind].note}`,
      );
    } catch { /* best-effort */ }
  };

  const stats: ExtractionStats = { droppedBatches: 0 };
  let facts: ExtractedFact[];
  let saved = 0;
  // worktree 에서 끝난 세션의 project 사실은 본 저장소 루트에 묶는다(extractionScopeProject).
  let scopeProject = project;
  try {
    facts = await extractFactsFromExchanges(db, sessionId, stats, renewLease);

    // 🚨 저장 **직전** 소유권을 재확인한다. 마지막 갱신 이후에 claim 을 빼앗겼다면
    // (배치가 1개뿐이면 갱신도 1회뿐이라 창이 넓다) 여기서 멈춰야 한다 — 그대로
    // 저장하면 새 소유자와 함께 fact 를 두 벌 쓰게 된다.
    renewLease();

    if (facts.length > 0) {
      const agent = codingAgent || detectAgentFromSession(db, sessionId);
      const exchangeIds = (db.prepare(
        'SELECT id FROM exchanges WHERE session_id = ?'
      ).all(sessionId) as Array<{ id: string }>).map(r => r.id);
      scopeProject = extractionScopeProject(project);
      saved = (await saveExtractedFacts(
        db, facts, scopeProject, exchangeIds, agent, renewLease, writeCompletionMarker,
      )).length;
    }
  } catch (e) {
    // 실패를 분류한다 — 이 판정을 워커가 아니라 **선점 소유자**가 내려야
    // 소유권 토큰으로 안전하게 마커를 쓸 수 있다(호출자 간 로직 중복도 사라진다).
    //  · 공급자 실패(LlmCallError, transient/unknown) → claim 해제 후 rethrow.
    //    예산을 쓰지 않고 다음 run 에 즉시 재시도된다.
    //  · 내부 실패(임베딩/DB/파서) → 재시도 예산 마커(-4, 소진 시 -2) 후 rethrow.
    // 분류·라우팅을 소비자와 **같은 함수**로 판정한다(문구와 동작이 어긋나지 않게).
    const kind = classifyExtractionFailure(e);
    if (kind === 'handoff') {
      // 남의 행이므로 해제할 것도 기록할 것도 없다(SQL 가드가 이미 0행이지만 계약을 코드로).
      console.error(`extraction: session ${sessionId} — 다른 러너가 인수함(claim 이양), 이번 실행 종료`);
    } else if (failureConsumesBudget(kind)) {
      writeInternalFailureMarker(kind); // deterministic 거절 · 내부 실패 — 예산 소모
    } else {
      releaseClaim();                   // 공급자 일시 실패 — 예산 미소모, 즉시 재시도
    }
    throw e;
  }

  // 완료 마커 — saveExtractedFacts 의 트랜잭션 안에서 호출된다(원자적 커밋).
  // fact 가 0건이면 트랜잭션이 없으므로 여기서 직접 호출한다.
  function writeCompletionMarker(extracted: number, savedCount: number): number {
    // dropped_batches 컬럼은 마이그레이션이 지연될 수 있다 — 없으면 4-컬럼 폴백으로
    // **마커는 반드시** 남긴다(미기록 = 재추출 = 중복, Codex R5 HIGH-1).
    const logColumns = (db.prepare(`SELECT name FROM pragma_table_info('extraction_log')`)
      .all() as Array<{ name: string }>).map(c => c.name);
    const hasDropped = logColumns.includes('dropped_batches');
    // seen_exchanges(이번 추출이 읽은 교환 수)도 같은 방식 — 컬럼이 있을 때만 싣는다.
    const hasSeen = logColumns.includes('seen_exchanges');
    const seenCol = hasSeen ? ', seen_exchanges' : '';
    const seenVal = hasSeen ? ', ?' : '';
    const seenSet = hasSeen ? ', seen_exchanges = excluded.seen_exchanges' : '';
    const seenArgs = hasSeen ? [stats.seenExchanges ?? null] : [];
    // 소유권 가드: 그사이 선점이 넘어갔다면 새 소유자의 상태를 덮지 않는다.
    // (claim 없이 도는 구버전 DB 경로는 가드 없이 기존 동작.)
    const ownGuard = holdsClaim ? ' WHERE extraction_log.claim_owner = ?' : '';
    const ownArgs = holdsClaim ? [owner] : [];
    const now = new Date().toISOString();
    let res: { changes: number };
    try {
      res = hasDropped
      ? db.prepare(`
          INSERT INTO extraction_log (session_id, processed_at, extracted, saved, dropped_batches, claim_owner${seenCol})
          VALUES (?, ?, ?, ?, ?, NULL${seenVal})
          ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
            extracted = excluded.extracted, saved = excluded.saved,
            dropped_batches = excluded.dropped_batches, claim_owner = NULL${seenSet}${ownGuard}
        `).run(sessionId, now, extracted, savedCount, stats.droppedBatches, ...seenArgs, ...ownArgs)
      : db.prepare(`
          INSERT INTO extraction_log (session_id, processed_at, extracted, saved${seenCol})
          VALUES (?, ?, ?, ?${seenVal})
          ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
            extracted = excluded.extracted, saved = excluded.saved${seenSet}${ownGuard}
        `).run(sessionId, now, extracted, savedCount, ...seenArgs, ...ownArgs);
    } catch (e) {
      // 아주 오래된 DB 는 extraction_log 자체가 없다. 이 경로는 선점도 없었으므로
      // (holdsClaim=false) '소유권 상실'이 아니다 — 추출 결과를 롤백하면 안 된다.
      // 그 외 오류는 진짜 문제이므로 던져서 트랜잭션을 되돌린다.
      if (!holdsClaim && /no such table/i.test(e instanceof Error ? e.message : String(e))) {
        console.error(`extraction: session ${sessionId} — extraction_log 부재(구버전 DB), 마커 생략`);
        return 1; // 롤백 사유 아님
      }
      throw e;
    }
    if (!hasDropped && stats.droppedBatches > 0) {
      console.error(
        `extraction: session ${sessionId} — dropped_batches 컬럼 부재로 폐기 카운터 `
        + `${stats.droppedBatches}건을 기록하지 못했습니다(마이그레이션 지연). 마커는 기록됨.`,
      );
    }
    if (hasDropped && stats.droppedBatches > 0 && res.changes > 0) {
      console.error(
        `extraction: session ${sessionId} completed with ${stats.droppedBatches} dropped batch(es) `
        + `(deterministic LLM failures — those exchanges produced no facts; `
        + `query: SELECT session_id, dropped_batches FROM extraction_log WHERE dropped_batches > 0)`,
      );
    }
    return res.changes; // 0 = 소유권 상실 → 호출자가 롤백/표면화
  }

  if (facts.length === 0) {
    try {
      if (writeCompletionMarker(0, 0) === 0 && holdsClaim) {
        console.error(`extraction: session ${sessionId} 완료 마커 미기록(소유권 상실 추정) — 다음 run 재시도`);
      }
    } catch (e) {
      console.error(
        `extraction: session ${sessionId} 마커 기록 실패 — 다음 run 에서 재추출될 수 있습니다: `
        + `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return {
    extracted: facts.length, saved,
    ...(stats.truncatedFacts ? { truncated: stats.truncatedFacts } : {}),
    ...(stats.rejectedSecrets ? { rejectedSecrets: stats.rejectedSecrets } : {}),
    ...(stats.rejectedInvalid ? { rejectedInvalid: stats.rejectedInvalid } : {}),
    ...(scopeProject !== project ? { scopeProject } : {}),
  };
}

/**
 * Detect the coding agent from a session's exchanges.
 * Returns the coding_agent of the first exchange in the session, or 'claude-code' as default.
 */
function detectAgentFromSession(db: Database.Database, sessionId: string): string {
  const row = db.prepare(
    'SELECT coding_agent FROM exchanges WHERE session_id = ? LIMIT 1'
  ).get(sessionId) as { coding_agent: string | null } | undefined;
  return row?.coding_agent || 'claude-code';
}
