import { l2DistanceToSimilarity } from './db.js';
import { factVectorDistance, searchSimilarFacts } from './fact-db.js';
import { getRelatedFacts } from './ontology-db.js';
import { truncateFact } from './fact-text.js';
import { categoryLabel } from './fact-validity.js';
/**
 * Which facts a prompt's context block would carry — the selection half of the
 * UserPromptSubmit injection, kept apart from the session ledger, the log and
 * delivery so that the live hook (inject-core.ts) and the offline replay bench
 * (bench/inject-replay.mjs) run the SAME code: a bench with its own copy of the
 * pipeline would measure that copy.
 */
export const TOP_K = 5;
// Probe-baseline relevance gate (e5 scores are compressed, so absolute
// thresholds cannot separate relevant from irrelevant). A fact is injected
// only when sim(query, fact) exceeds the query's own background baseline by
// this margin. Measured on KR/EN real-DB pairs: related +0.047~+0.123,
// unrelated -0.028~-0.091; long compound "memory" facts can leak in at
// +0.04~+0.045, so the margin sits just above that noise band.
export const BASELINE_MARGIN = 0.045;
export const MAX_CONTEXT_FACTS = 8;
// Token budget: fact 평균 140자·p90 207자 실측 — 절단 없이 8건이면 ~470 tok/프롬프트.
// fact 당 160자(fact-text.ts FACT_CHAR_CAP) + 블록 1,000자 예산으로 상한. 잘린 내용이 필요하면 search_facts 로 조회.
export const BLOCK_CHAR_BUDGET = 1000;
export const BLOCK_HEADER = '📌 관련 과거 결정:';
/** Neighbours per seed whose margin is computed when the relation gate is on (relation degree reaches 122 live). */
export const REL_SCORE_CAP = 30;
/**
 * What the live injection runs — the replay bench's pre-registered decision
 * (docs/bench/2026-10-19-inject-replay.md; test/inject-select.test.ts reads its
 * decisions block and fails when this drifts from it):
 *  - relMargin null: every candidate margin lost more than 10% of the relation
 *    lines judged directly useful, so the relation gate was rejected;
 *  - scopeFamily true: on the 127 prompts whose cwd the family widens (the
 *    registered reading), judged-useful lines per prompt rose +0.13 (95% CI
 *    0.05–0.23), precision(=2) Δ +0.03 (CI −0.02–0.07). Limit: the whole gain
 *    (16 lines) was on prompts of ONE repository — by where the prompt's cwd
 *    was: worktrees placed inside its folder +12, linked worktrees outside it
 *    +4, the repository folder itself 0; the 22 affected prompts of the other
 *    repositories gained nothing and are too few (< 30) to judge on their own.
 */
export const PRODUCTION_SELECT_OPTIONS = Object.freeze({
    relMargin: null,
    scopeFamily: true,
});
/** sim − baseline of one stored fact, or null when it has no current-version vector. */
export function neighbourMargin(db, factId, embedding, baseline) {
    const distance = factVectorDistance(db, factId, embedding);
    return distance === null ? null : l2DistanceToSimilarity(distance) - baseline;
}
const isSafetyEdge = (relation) => relation.relation_type === 'CONTRADICTS' || relation.relation_type === 'SUPERSEDES';
/**
 * The relation gate over one seed's neighbours: affirmative neighbours that
 * clear relMargin, best margin first, then the exempt safety edges in their
 * usual order — getRelatedFacts already ranks affirmative edges (weight 1.0)
 * ahead of safety edges (0.7). At most REL_SCORE_CAP neighbours are scored.
 */
function gateNeighbours(db, related, embedding, baseline, relMargin) {
    const passed = [];
    const safety = [];
    const settled = []; // judged and dropped for good: below the margin, or no vector
    let gatedOut = 0;
    let unscored = 0;
    let scoredCount = 0;
    for (const r of related) {
        if (isSafetyEdge(r.relation)) {
            safety.push({ fact: r.fact, relation: r.relation, margin: null });
            continue;
        }
        if (scoredCount >= REL_SCORE_CAP) {
            unscored++;
            continue;
        }
        scoredCount++;
        const margin = neighbourMargin(db, r.fact.id, embedding, baseline);
        if (margin === null) {
            unscored++;
            settled.push(r.fact.id);
        }
        else if (margin < relMargin) {
            gatedOut++;
            settled.push(r.fact.id);
        }
        else
            passed.push({ fact: r.fact, relation: r.relation, margin });
    }
    passed.sort((a, b) => b.margin - a.margin);
    return { keep: [...passed, ...safety], gatedOut, unscored, settled };
}
/**
 * Top-K similar facts gated by the probe baseline, expanded with 1-hop ontology
 * relations of the first three hits.
 */
export function selectInjectFacts(db, embedding, baseline, project, opts = PRODUCTION_SELECT_OPTIONS) {
    let tStage = Date.now();
    // threshold 0: take top-k by distance, then gate by baseline margin below
    const candidates = searchSimilarFacts(db, embedding, project, TOP_K, 0, {
        scopeFamily: opts.scopeFamily, visibleId: opts.visibleFactId,
    });
    const search_ms = Date.now() - tStage;
    const scored = candidates.map((r) => ({ fact: r.fact, margin: l2DistanceToSimilarity(r.distance) - baseline }));
    const gated = scored.filter((r) => r.margin >= BASELINE_MARGIN);
    const topMargins = scored.map((r) => r.margin);
    if (gated.length === 0) {
        return { candidates: candidates.length, topMargins, gated, lines: [], relGatedOut: 0, relUnscored: 0, timings: { search_ms } };
    }
    tStage = Date.now();
    const seenIds = new Set(gated.map((r) => r.fact.id));
    const settledIds = new Set(); // neighbours a previous seed already gated out — not scored or counted again
    const lines = gated.map((r) => ({ fact: r.fact, note: '', origin: 'vec', margin: r.margin }));
    let relGatedOut = 0;
    let relUnscored = 0;
    for (const { fact } of gated.slice(0, 3)) {
        if (lines.length >= MAX_CONTEXT_FACTS)
            break;
        const related = getRelatedFacts(db, fact.id, 1, 0.6, 0.2, project, {
            scopeFamily: opts.scopeFamily, visibleFact: opts.visibleFactId, visibleRelation: opts.visibleRelation,
        }).filter((r) => !seenIds.has(r.fact.id) && !settledIds.has(r.fact.id));
        let keep;
        if (opts.relMargin === null) {
            keep = related.map((r) => ({ fact: r.fact, relation: r.relation, margin: null }));
        }
        else {
            const gated = gateNeighbours(db, related, embedding, baseline, opts.relMargin);
            keep = gated.keep;
            relGatedOut += gated.gatedOut;
            relUnscored += gated.unscored;
            for (const id of gated.settled)
                settledIds.add(id);
        }
        for (const { fact: relFact, relation, margin } of keep) {
            if (!seenIds.has(relFact.id) && lines.length < MAX_CONTEXT_FACTS) {
                seenIds.add(relFact.id);
                lines.push({ fact: relFact, note: `[${relation.relation_type}]`, origin: 'rel', margin });
            }
        }
    }
    return {
        candidates: candidates.length, topMargins, gated, lines, relGatedOut, relUnscored,
        timings: { search_ms, related_ms: Date.now() - tStage },
    };
}
/**
 * Block text for the given lines, in order, under BLOCK_CHAR_BUDGET — fact 당
 * 160자 절단, 하위 관련도부터 탈락 (lines are in relevance order, so the tail is
 * cut). The first line is always kept. `shown` = how many leading items made it.
 */
export function formatInjectBlock(items) {
    const lines = [BLOCK_HEADER];
    let blockChars = BLOCK_HEADER.length;
    let shown = 0;
    for (const { fact, note } of items) {
        const dateStr = fact.created_at.slice(0, 10);
        // categoryLabel, not the stored value: a row stored before the writers folded categories can hold anything.
        const line = `- ${note ? note + ' ' : ''}[${categoryLabel(fact.category)}] ${truncateFact(fact.fact)} (${dateStr})`;
        if (blockChars + line.length > BLOCK_CHAR_BUDGET && shown > 0)
            break;
        lines.push(line);
        blockChars += line.length + 1;
        shown++;
    }
    return { lines, shown };
}
