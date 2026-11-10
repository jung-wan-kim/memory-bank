import Database from 'better-sqlite3';
import type { Fact, ConsolidationResult } from './types.js';
import { callHaiku, parseJsonResponse } from './llm.js';
// 값 사용분은 별도 import — `export … from` 은 재수출만 하고 로컬 바인딩을 만들지 않는다.
import { LlmCallError, classifyLlmError } from './llm-error-class.js';
import {
  getNewFactsSince,
  getAllNewFactsSince,
  searchSimilarFactsSameScope,
  updateFact,
  deactivateFact,
  insertRevision,
} from './fact-db.js';
import { factTextRejectReason } from './fact-validity.js';

export const CONSOLIDATION_SYSTEM_PROMPT = `Compare two facts and determine their relationship.

## Relationship types (choose one)
- DUPLICATE: same content - merge
- CONTRADICTION: conflicting - new fact replaces old
- EVOLUTION: old fact evolved - update
- INDEPENDENT: separate - keep both

## Output format
{
  "relation": "DUPLICATE|CONTRADICTION|EVOLUTION|INDEPENDENT",
  "merged_fact": "<the final fact sentence for DUPLICATE/CONTRADICTION/EVOLUTION, written out>",
  "reason": "one-line justification"
}`;

const MAX_HAIKU_CALLS = 10;
// Cross-run retries for a driver fact whose comparison CALL keeps failing before
// it is skipped (advanced past). A short/transient outage is retried (held) until
// it recovers — a success resets the counter — while a persistently failing fact
// reaches MAX and is skipped so it can't wedge the cursor. This spans runs on
// purpose: a real provider outage lasts across separate worker runs, which a
// run-local counter cannot see.
const MAX_CONSOLIDATION_ATTEMPTS = 3;
// e5 passage-passage scale (measured): near-dup 0.99, paraphrase 0.97,
// related-but-distinct ~0.91, unrelated <=0.86. 0.95 selects dup candidates.
const SIMILARITY_THRESHOLD = 0.95;

export function buildConsolidationPrompt(existingFact: string, newFact: string): string {
  return `Existing fact: "${existingFact}"\nNew fact: "${newFact}"`;
}

// 3분류기는 src/llm-error-class.ts 가 단일 소스 — llm.ts 의 재시도 루프와 이 drain
// 루프가 같은 판정을 써야 "재시도는 하는데 커서는 넘어간다" 류의 불일치가 안 생긴다.
// 기존 importer(테스트 포함)를 위해 그대로 re-export 한다.
export type { LlmErrorClass } from './llm-error-class.js';
export { LlmCallError, EmptyLlmResponseError, classifyLlmError, isTransientLlmError } from './llm-error-class.js';

type Verdict = 'DUPLICATE' | 'CONTRADICTION' | 'EVOLUTION' | 'INDEPENDENT' | 'none';

/**
 * What one driver's comparison did, filled in as it happens so the caller can
 * read it after a throw too: a throw BEFORE the LLM (candidate search) spent no
 * call, a throw after it (parse, embedding, DB write) did.
 */
interface ComparisonTally {
  /** The comparison LLM call was made (whether it resolved, rejected or returned garbage). */
  llmCalled: boolean;
  /** The candidate search stopped at the KNN k limit with matches possibly unread. */
  searchCapped: boolean;
}

/**
 * The pair in creation order `(created_at, id)` — the same key the drain
 * cursor walks. Which fact is "existing" and which is "new" is a property of
 * the pair, not of which one is the driver: a backlog is driven oldest first,
 * so the nearest neighbour is often the LATER fact (measured on the 2,256-fact
 * backlog of 2026-11: 388 of 849 comparisons). Reading that pair driver-as-new
 * told the LLM the older sentence was the newer one — CONTRADICTION then
 * switched off the latest decision and EVOLUTION overwrote it.
 */
function inCreationOrder(a: Fact, b: Fact): [older: Fact, newer: Fact] {
  const aFirst = a.created_at < b.created_at || (a.created_at === b.created_at && a.id < b.id);
  return aFirst ? [a, b] : [b, a];
}

/**
 * Consolidate ONE driver fact against a same-scope neighbour (if any).
 * Shared by consolidateAllPending and the back-compat consolidateFacts wrapper.
 *
 * `tally.llmCalled` reports whether an LLM call was actually made — the caller
 * MUST use this (not the verdict, and not "it threw") for budget accounting: a
 * call that returns malformed/unparseable text still consumed the budget even
 * though its verdict is 'none', and a candidate search that throws consumed
 * none. A provider rejection is thrown as LlmCallError; any other throw is an
 * internal failure.
 */
async function consolidateOne(
  db: Database.Database,
  driver: Fact,
  tally: ComparisonTally,
): Promise<Verdict> {
  if (!driver.embedding) return 'none';
  const embeddingArray = Array.from(driver.embedding);
  // SAME-SCOPE only (no cross-scope leak): project fact → its own project,
  // global fact → global. The scope gate is inside the search, before its
  // limit, so an in-scope match isn't starved by closer out-of-scope rows.
  const scope = driver.scope_type === 'global'
    ? ({ type: 'global' } as const)
    : driver.scope_project
      ? ({ type: 'project', project: driver.scope_project } as const)
      : null;
  if (!scope) return 'none';
  const candidates = searchSimilarFactsSameScope(db, embeddingArray, scope, 5, SIMILARITY_THRESHOLD, {
    onCapReached: () => { tally.searchCapped = true; },
  }).filter((s) => s.fact.id !== driver.id);
  if (candidates.length === 0) return 'none';

  const [existingFact, newFact] = inCreationOrder(candidates[0].fact, driver);
  // Tag ONLY the provider call's rejection as an LlmCallError. Anything after
  // this (parseJsonResponse, the rewrite's embedding, applyConsolidationResult
  // DB writes) throws as a plain error, so the drain loop can hold on an
  // internal bug instead of treating it as a skippable "bad fact".
  let response: string;
  tally.llmCalled = true;
  try {
    response = await callHaiku(CONSOLIDATION_SYSTEM_PROMPT, buildConsolidationPrompt(existingFact.fact, newFact.fact));
  } catch (e) {
    throw new LlmCallError(e);
  }
  const result = parseJsonResponse<ConsolidationResult>(response);
  // Unparseable output = the call happened (budget spent) but produced no usable
  // verdict. Treated as a no-op ('none'), NOT an error: consolidation is a
  // best-effort background dedup, so we advance past this comparison rather than
  // hold the cursor. The pair is not lost — both facts stay active, and the
  // comparison re-triggers whenever either is a driver/candidate for a future
  // fact. This also means no single fact (a transiently non-JSON response, or a
  // deliberately "poison" candidate) can hold the cursor and starve the backlog.
  if (!result) return 'none';
  const plan = planConsolidation(existingFact, newFact, result);
  // A rewritten sentence needs its own vector: without it the row keeps the
  // OLD sentence's embedding and index entry (measured 2026-11: 72 of 80
  // rewritten facts), so search, injection and later comparisons match the old
  // meaning. The embedding module is loaded only here — a run that rewrites
  // nothing (most of them) never pays the model load.
  const embedding = plan.rewrite ? await embedSentence(plan.rewrite.text) : undefined;
  applyConsolidationPlan(db, existingFact, newFact, plan, result.reason, embedding);
  return result.relation;
}

/** Vector of a stored fact sentence ('passage' mode, as the extractor embeds facts). Loads the model on first use. */
async function embedSentence(text: string): Promise<number[]> {
  const { generateEmbedding } = await import('./embeddings.js');
  return generateEmbedding(text);
}

/**
 * @deprecated Back-compat wrapper for the removed per-project consolidator.
 * Prefer `consolidateAllPending`. Now scope-isolated (via consolidateOne), so
 * it can no longer leak project-private text into global facts. Kept as a
 * public export so existing importers don't crash at module load.
 */
export async function consolidateFacts(
  db: Database.Database,
  project: string,
  lastConsolidatedAt: string,
): Promise<{ processed: number; merged: number; contradictions: number; evolutions: number }> {
  // No initEmbeddings() — candidates come from stored vectors; the embedding
  // model is loaded only when a verdict rewrites a sentence (see consolidateOne).
  const newFacts = getNewFactsSince(db, project, lastConsolidatedAt);
  let haikuCalls = 0, merged = 0, contradictions = 0, evolutions = 0;
  for (const newFact of newFacts) {
    if (haikuCalls >= MAX_HAIKU_CALLS) break;
    const stillActive = db.prepare('SELECT 1 FROM facts WHERE id = ? AND is_active = 1').get(newFact.id);
    if (!stillActive) continue;
    const tally: ComparisonTally = { llmCalled: false, searchCapped: false };
    try {
      const verdict = await consolidateOne(db, newFact, tally);
      if (tally.llmCalled) haikuCalls++; // count the CALL, not the verdict (malformed output still spent budget)
      if (verdict === 'DUPLICATE') merged++;
      else if (verdict === 'CONTRADICTION') contradictions++;
      else if (verdict === 'EVOLUTION') evolutions++;
    } catch (error) {
      // This loop has no hold: every failure — a rejected call or an internal
      // one — counts against the budget, otherwise a persistently failing step
      // would be attempted once for every one of N similar facts.
      haikuCalls++;
      console.error(`Consolidation failed for fact ${newFact.id}:`, error);
    }
  }
  return { processed: newFacts.length, merged, contradictions, evolutions };
}

/**
 * Consolidate the ENTIRE backlog in one pass: every new fact (any scope, any
 * project) processed exactly once, under a single shared Haiku budget. The
 * consolidate worker calls this once while holding the global lock, instead of
 * looping consolidateFacts per project — which reprocessed shared global facts
 * once per project (up to `MAX_HAIKU_CALLS × projectCount` calls) and, for
 * INDEPENDENT/CONTRADICTION verdicts (new fact stays active), kept re-comparing
 * the same global fact every pass.
 *
 * Each fact is compared within its own scope: a project fact against its
 * project + global (via its scope_project), a global fact against the whole
 * store (scope_project is null → no scope filter). Because a fact merged away
 * by an earlier comparison is deactivated, it neither reappears in this list
 * nor as a later candidate.
 */
/**
 * Why a fact's comparison failed. 'internal' is everything that is not a
 * provider rejection (candidate search, parsing, embedding, DB write); the
 * other three are classifyLlmError's reading of a provider rejection.
 */
export type ConsolidationErrorKind = 'internal' | 'transient' | 'deterministic' | 'unknown';

export interface ConsolidationError {
  factId: string;
  kind: ConsolidationErrorKind;
  message: string;
  /** true = the cursor stays in front of this fact (the next run retries it); false = it was skipped past. */
  held: boolean;
}

export interface ConsolidationRunResult {
  processed: number;
  merged: number;
  contradictions: number;
  evolutions: number;
  /** Comparison LLM calls actually made — an error before the call is not one. */
  haikuCalls: number;
  cursor: { createdAt: string; id: string } | null;
  /**
   * The last failure of this run, null when none. A held failure is always the
   * last one (the run stops there). The caller must surface it: the worker runs
   * detached with stdio ignored, so console.error reaches no one.
   */
  lastError: ConsolidationError | null;
  /** Drivers whose candidate search stopped at the KNN k limit (possibly unread matches). */
  cappedSearches: number;
}

export async function consolidateAllPending(
  db: Database.Database,
  since: { createdAt: string; id: string } | null,
): Promise<ConsolidationRunResult> {
  // NOTE: no initEmbeddings() here. Candidates are found with the facts'
  // ALREADY-STORED vectors (searchSimilarFactsSameScope does a vec MATCH on the
  // stored blob) and judged by an LLM (callHaiku). Loading the local embedding
  // model was a ~1s no-op on every run, wasteful because the consolidate worker
  // is spawned on SessionStart — most runs have an empty backlog. The model is
  // loaded only when a verdict rewrites a sentence (consolidateOne).
  const newFacts = getAllNewFactsSince(db, since);
  let haikuCalls = 0;
  let merged = 0;
  let contradictions = 0;
  let evolutions = 0;
  let processed = 0;
  let cappedSearches = 0;
  let lastError: ConsolidationError | null = null;
  // KEYSET progress cursor `(created_at, id)`: the last fact FULLY examined this
  // run. Persisted by the caller so the next run resumes strictly after it.
  // Because (created_at, id) is unique, we can always advance to the last
  // examined fact without risking a skip — even when a whole timestamp group is
  // larger than the per-run budget (the pre-keyset created_at-only cursor
  // stalled forever in that case and starved the rest of the backlog).
  let cursor = since;

  for (let i = 0; i < newFacts.length; i++) {
    const newFact = newFacts[i];
    if (haikuCalls >= MAX_HAIKU_CALLS) break; // budget wall — cursor stays at the last examined fact

    // Re-read: an earlier comparison this run may have deactivated this fact.
    const stillActive = db.prepare('SELECT 1 FROM facts WHERE id = ? AND is_active = 1').get(newFact.id);
    if (stillActive) {
      const tally: ComparisonTally = { llmCalled: false, searchCapped: false };
      try {
        // Same-scope isolation + budget accounting via the shared helper.
        const verdict = await consolidateOne(db, newFact, tally);
        if (tally.llmCalled) haikuCalls++; // count the CALL, not the verdict
        if (tally.searchCapped) cappedSearches++;
        if (verdict === 'DUPLICATE') merged++;
        else if (verdict === 'CONTRADICTION') contradictions++;
        else if (verdict === 'EVOLUTION') evolutions++;
        // Clear any prior failure count once this fact resolves successfully
        // (the guard keeps this a no-op write for the common zero case).
        db.prepare('UPDATE facts SET consolidation_attempts = 0 WHERE id = ? AND consolidation_attempts > 0').run(newFact.id);
      } catch (error) {
        // Count the call only when it was made. "A throw = one call" stopped
        // being true once the candidate search could throw: 2,552 runs logged
        // `haiku=1` for a search failure that never reached the LLM.
        if (tally.llmCalled) haikuCalls++;
        if (tally.searchCapped) cappedSearches++;
        console.error(`Consolidation call failed for fact ${newFact.id}:`, error);
        const kind: ConsolidationErrorKind = error instanceof LlmCallError ? classifyLlmError(error) : 'internal';
        lastError = {
          factId: newFact.id,
          kind,
          message: error instanceof Error ? error.message : String(error),
          held: true,
        };

        // A non-LLM error (parser/DB/internal bug, NOT an LlmCallError) must NEVER
        // advance the cursor — hold so the bug surfaces instead of silently
        // marking the fact processed and draining the backlog. (Skipping after N
        // failures would hide the bug behind per-fact skips; the worker instead
        // logs the error, counts consecutive failures and backs off — see
        // consolidate-health.ts.)
        if (kind === 'internal') {
          break;
        }

        // SKIP is reserved for a RECOGNIZED deterministic per-request rejection
        // (400/413/422, too-long, max_tokens...) — the one case where the fact
        // ITSELF is provably at fault. Transient (outage/auth) AND unknown both
        // HOLD: an unrecognized provider error ("HTTP 500", "Error code: 503") is
        // far more likely an unusual outage shape than a poison fact, so holding
        // never drains the backlog during an outage. (Residual: a per-fact poison
        // that never presents as a recognized deterministic error holds — but the
        // global lock + budget mean it just stops, no flood, and the repeated
        // fact id in the log makes it diagnosable.)
        if (kind !== 'deterministic') {
          break;
        }

        // Deterministic per-fact rejection: ledger it and, after MAX attempts,
        // SKIP (advance past it) so one un-processable fact can't wedge the
        // cursor. Below MAX, hold so a mis-classified blip still gets a couple of
        // retries. Advancing is safe: the fact stays active/searchable, it just
        // isn't consolidated.
        const attempts = (db.prepare(
          'UPDATE facts SET consolidation_attempts = COALESCE(consolidation_attempts, 0) + 1 WHERE id = ? RETURNING consolidation_attempts'
        ).get(newFact.id) as { consolidation_attempts: number } | undefined)?.consolidation_attempts ?? 0;
        if (attempts >= MAX_CONSOLIDATION_ATTEMPTS) {
          console.error(`Consolidation skip fact ${newFact.id} after ${attempts} deterministic failures`);
          lastError.held = false;
          processed++;
          cursor = { createdAt: newFact.created_at, id: newFact.id };
          continue;
        }
        break; // hold — retry this fact next run
      }
    }
    // Fully examined (including a no-op / no-candidate / no-embedding fact — none
    // of which need reprocessing as a driver): advance the keyset cursor past it.
    processed++;
    cursor = { createdAt: newFact.created_at, id: newFact.id };
  }

  return { processed, merged, contradictions, evolutions, haikuCalls, cursor, lastError, cappedSearches };
}

/** A verdict resolved against its pair: which stored sentence (if any) it rewrites. */
interface ConsolidationPlan {
  relation: ConsolidationResult['relation'];
  /** merged_fact after normalization — null when absent, blank or template residue. */
  mergedFact: string | null;
  /** The fact whose stored sentence changes and its new sentence; null when no sentence changes. */
  rewrite: { factId: string; text: string } | null;
}

function planConsolidation(existingFact: Fact, newFact: Fact, result: ConsolidationResult): ConsolidationPlan {
  // Normalize merged_fact: empty/whitespace-only is absent, and so is a copy of
  // the prompt's example value (fact-validity.ts) — the new fact's own text is
  // used instead, exactly as for an empty one. Logged so it stays countable.
  let mergedFact = result.merged_fact?.trim() || null;
  const mergedReject = mergedFact ? factTextRejectReason(mergedFact) : null;
  if (mergedReject) {
    console.error(`Consolidation: merged_fact rejected (${mergedReject}) for ${existingFact.id} — using the new fact's text`);
    mergedFact = null;
  }

  let rewrite: ConsolidationPlan['rewrite'] = null;
  if (result.relation === 'CONTRADICTION') {
    // The new fact stays; it takes the merged sentence when there is one.
    if (mergedFact && mergedFact !== newFact.fact) rewrite = { factId: newFact.id, text: mergedFact };
  } else if (result.relation === 'EVOLUTION') {
    // The existing fact stays and takes the merged (or the new fact's) sentence.
    const text = mergedFact || newFact.fact;
    if (text !== existingFact.fact) rewrite = { factId: existingFact.id, text };
  }
  return { relation: result.relation, mergedFact, rewrite };
}

/**
 * Apply a verdict to its pair. `existingFact` is the OLDER fact and `newFact`
 * the later one (consolidateOne orders them; see inCreationOrder).
 *
 * `opts.embedding` is the vector of the sentence the verdict writes. It is
 * required when the rewritten fact has a stored vector: writing the sentence
 * alone would leave that vector describing the old sentence.
 */
export function applyConsolidationResult(
  db: Database.Database,
  existingFact: Fact,
  newFact: Fact,
  result: ConsolidationResult,
  opts: { embedding?: number[] } = {},
): void {
  applyConsolidationPlan(db, existingFact, newFact, planConsolidation(existingFact, newFact, result), result.reason, opts.embedding);
}

function applyConsolidationPlan(
  db: Database.Database,
  existingFact: Fact,
  newFact: Fact,
  plan: ConsolidationPlan,
  reason: string,
  embedding: number[] | undefined,
): void {
  const { mergedFact, rewrite } = plan;
  if (rewrite && !embedding) {
    const target = rewrite.factId === existingFact.id ? existingFact : newFact;
    if (target.embedding) {
      throw new Error(`Consolidation: the sentence of ${target.id} changes but no embedding of the new sentence was given`);
    }
  }
  // Nothing to write — and no reason to wait for the write lock.
  if (plan.relation === 'INDEPENDENT') return;
  const rewriteOf = (factId: string) => (rewrite?.factId === factId ? { fact: rewrite.text, ...(embedding ? { embedding } : {}) } : {});

  // One write transaction per verdict: a failure between the steps used to
  // leave a count raised or a revision written for a merge that did not
  // happen, and the retry on the next run raised the count again.
  db.transaction(() => {
    // The fact that vanishes in a merge hands its confirmations and sources to
    // the one that stays — read here, inside the transaction, not from the
    // snapshot taken before the LLM call. (Its ontology relations are not
    // re-pointed here.)
    const absorbed = () => {
      const gone = db.prepare('SELECT consolidated_count, source_exchange_ids FROM facts WHERE id = ?')
        .get(newFact.id) as { consolidated_count: number | null; source_exchange_ids: string | null } | undefined;
      return {
        // at least 1: the merge itself is one more confirmation of the surviving fact
        consolidated_count_add: Math.max(1, gone?.consolidated_count ?? 1),
        add_source_exchange_ids: JSON.parse(gone?.source_exchange_ids || '[]') as string[],
      };
    };

    switch (plan.relation) {
      case 'DUPLICATE':
        updateFact(db, existingFact.id, absorbed());
        deactivateFact(db, newFact.id);
        break;

      case 'CONTRADICTION':
        deactivateFact(db, existingFact.id);
        insertRevision(db, {
          fact_id: existingFact.id,
          previous_fact: existingFact.fact,
          new_fact: mergedFact || newFact.fact,
          reason,
          source_exchange_id: null,
        });
        if (mergedFact) {
          updateFact(db, newFact.id, { fact: mergedFact, ...rewriteOf(newFact.id) });
        }
        break;

      case 'EVOLUTION':
        insertRevision(db, {
          fact_id: existingFact.id,
          previous_fact: existingFact.fact,
          new_fact: mergedFact || newFact.fact,
          reason,
          source_exchange_id: null,
        });
        updateFact(db, existingFact.id, {
          fact: mergedFact || newFact.fact,
          ...rewriteOf(existingFact.id),
          ...absorbed(),
        });
        deactivateFact(db, newFact.id);
        break;

    }
  }).immediate();
}
