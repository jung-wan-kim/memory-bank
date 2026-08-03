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

export const CONSOLIDATION_SYSTEM_PROMPT = `Compare two facts and determine their relationship.

## Relationship types (choose one)
- DUPLICATE: same content - merge
- CONTRADICTION: conflicting - new fact replaces old
- EVOLUTION: old fact evolved - update
- INDEPENDENT: separate - keep both

## Output format
{
  "relation": "DUPLICATE|CONTRADICTION|EVOLUTION|INDEPENDENT",
  "merged_fact": "final sentence for merge/replace",
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

/**
 * Consolidate ONE driver fact against a same-scope neighbour (if any).
 * Shared by consolidateAllPending and the back-compat consolidateFacts wrapper.
 *
 * `called` reports whether an LLM call was actually made — the caller MUST use
 * this (not the verdict) for budget accounting, because a call that returns
 * malformed/unparseable text still consumed the budget even though its verdict
 * is 'none'. Throws only on a transient LLM failure the caller should retry.
 */
async function consolidateOne(
  db: Database.Database,
  newFact: Fact,
): Promise<{ called: boolean; verdict: 'DUPLICATE' | 'CONTRADICTION' | 'EVOLUTION' | 'INDEPENDENT' | 'none' }> {
  if (!newFact.embedding) return { called: false, verdict: 'none' };
  const embeddingArray = Array.from(newFact.embedding);
  // SAME-SCOPE only (no cross-scope leak): project fact → its own project,
  // global fact → global. The scope gate is inside the search, before its
  // limit, so an in-scope match isn't starved by closer out-of-scope rows.
  const scope = newFact.scope_type === 'global'
    ? ({ type: 'global' } as const)
    : newFact.scope_project
      ? ({ type: 'project', project: newFact.scope_project } as const)
      : null;
  if (!scope) return { called: false, verdict: 'none' };
  const candidates = searchSimilarFactsSameScope(db, embeddingArray, scope, 5, SIMILARITY_THRESHOLD)
    .filter((s) => s.fact.id !== newFact.id);
  if (candidates.length === 0) return { called: false, verdict: 'none' };

  const closest = candidates[0];
  // Tag ONLY the provider call's rejection as an LlmCallError. Anything after
  // this (parseJsonResponse, applyConsolidationResult DB writes) throws as a
  // plain error, so the drain loop can hold on an internal bug instead of
  // treating it as a skippable "bad fact".
  let response: string;
  try {
    response = await callHaiku(CONSOLIDATION_SYSTEM_PROMPT, buildConsolidationPrompt(closest.fact.fact, newFact.fact));
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
  if (!result) return { called: true, verdict: 'none' };
  applyConsolidationResult(db, closest.fact, newFact, result);
  return { called: true, verdict: result.relation };
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
  // No initEmbeddings() — consolidation uses stored vectors + the LLM, never the
  // local embedding model (see consolidateAllPending).
  const newFacts = getNewFactsSince(db, project, lastConsolidatedAt);
  let haikuCalls = 0, merged = 0, contradictions = 0, evolutions = 0;
  for (const newFact of newFacts) {
    if (haikuCalls >= MAX_HAIKU_CALLS) break;
    const stillActive = db.prepare('SELECT 1 FROM facts WHERE id = ? AND is_active = 1').get(newFact.id);
    if (!stillActive) continue;
    try {
      const { called, verdict } = await consolidateOne(db, newFact);
      if (called) haikuCalls++; // count the CALL, not the verdict (malformed output still spent budget)
      if (verdict === 'DUPLICATE') merged++;
      else if (verdict === 'CONTRADICTION') contradictions++;
      else if (verdict === 'EVOLUTION') evolutions++;
    } catch (error) {
      // A throw means callHaiku was reached and failed — that attempt still
      // counts against the budget, otherwise a persistently-failing LLM would
      // let this loop attempt a call for every one of N similar facts.
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
export async function consolidateAllPending(
  db: Database.Database,
  since: { createdAt: string; id: string } | null,
): Promise<{ processed: number; merged: number; contradictions: number; evolutions: number; haikuCalls: number; cursor: { createdAt: string; id: string } | null }> {
  // NOTE: no initEmbeddings() here — consolidation never generates an embedding.
  // It compares facts using their ALREADY-STORED vectors (searchSimilarFactsSameScope
  // does a vec MATCH on the stored blob) and an LLM (callHaiku). Loading the local
  // embedding model was a ~1s no-op on every run, wasteful because the consolidate
  // worker is spawned on every SessionStart — most runs have an empty backlog.
  const newFacts = getAllNewFactsSince(db, since);
  let haikuCalls = 0;
  let merged = 0;
  let contradictions = 0;
  let evolutions = 0;
  let processed = 0;
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
      try {
        // Same-scope isolation + budget accounting via the shared helper.
        const { called, verdict } = await consolidateOne(db, newFact);
        if (called) haikuCalls++; // count the CALL, not the verdict
        if (verdict === 'DUPLICATE') merged++;
        else if (verdict === 'CONTRADICTION') contradictions++;
        else if (verdict === 'EVOLUTION') evolutions++;
        // Clear any prior failure count once this fact resolves successfully
        // (the guard keeps this a no-op write for the common zero case).
        db.prepare('UPDATE facts SET consolidation_attempts = 0 WHERE id = ? AND consolidation_attempts > 0').run(newFact.id);
      } catch (error) {
        haikuCalls++;
        console.error(`Consolidation call failed for fact ${newFact.id}:`, error);

        // A non-LLM error (parser/DB/internal bug, NOT an LlmCallError) must NEVER
        // advance the cursor — hold so the bug surfaces instead of silently
        // marking the fact processed and draining the backlog.
        if (!(error instanceof LlmCallError)) {
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
        if (classifyLlmError(error) !== 'deterministic') {
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

  return { processed, merged, contradictions, evolutions, haikuCalls, cursor };
}

export function applyConsolidationResult(
  db: Database.Database,
  existingFact: Fact,
  newFact: Fact,
  result: ConsolidationResult,
): void {
  // Normalize merged_fact: treat empty/whitespace-only as absent
  const mergedFact = result.merged_fact?.trim() || null;

  switch (result.relation) {
    case 'DUPLICATE':
      updateFact(db, existingFact.id, { consolidated_count_increment: true });
      deactivateFact(db, newFact.id);
      break;

    case 'CONTRADICTION':
      deactivateFact(db, existingFact.id);
      insertRevision(db, {
        fact_id: existingFact.id,
        previous_fact: existingFact.fact,
        new_fact: mergedFact || newFact.fact,
        reason: result.reason,
        source_exchange_id: null,
      });
      if (mergedFact) {
        updateFact(db, newFact.id, { fact: mergedFact });
      }
      break;

    case 'EVOLUTION':
      insertRevision(db, {
        fact_id: existingFact.id,
        previous_fact: existingFact.fact,
        new_fact: mergedFact || newFact.fact,
        reason: result.reason,
        source_exchange_id: null,
      });
      updateFact(db, existingFact.id, {
        fact: mergedFact || newFact.fact,
        consolidated_count_increment: true,
      });
      deactivateFact(db, newFact.id);
      break;

    case 'INDEPENDENT':
      // Keep both, do nothing
      break;
  }
}
