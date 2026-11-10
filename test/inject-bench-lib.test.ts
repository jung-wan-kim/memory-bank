import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  THRESHOLDS, alignWindow, bootstrapDelta, decide, decideC2, decideC3, decisionsBlock, extractIdentifiers, foldSample,
  isBypassFact, kwLines, leakProbes, lostJ2Rel, makeAsOf, meanDelta, parseDecisionsBlock, perPromptCounts, aggregate,
  ratioDelta, searchedLogRows, splitOf, toEpoch, validateJudgeReply, validity, labelItems, leakFold, blockDiffers,
  buildFactIndex, repoOf, unboundMeta, driftedInputs, missingRows, determinismEntry, determinismBound, affectedReadings, PROJECT_FACTS_SQL,
  placementOf, widenedFactIds, sqliteDigest, driftedCode, codeDigest, REPLAY_ENTRY, moduleClosure, embeddingModelFiles,
  gitState, replayBinding, bindingDrift, recordRoots, JUDGE_SYSTEM, JUDGE_RETRY_MARK, judgeRetryUser, isRetryMessage, judgeMessage, judgeUserMessage,
  judgeMessageSha, firstAttemptSha, indexCalls, replyGivesRowScores, judgeSeedCandidates, legacyBinding, dependencyDigest,
} from '../bench/inject-bench-lib.mjs';
import { execFileSync } from 'child_process';
import crypto from 'crypto';

/**
 * Pure rules of the injection replay bench (plan 2026-10-19). These decide the
 * report's numbers and the production defaults, so each path is pinned here:
 * sample selection, as-of visibility, judge-reply acceptance, the validity
 * gates and the pre-registered decision rules.
 */

const gate = (m: string) => (m.startsWith('<task-notification>') ? { reason: 'task-notification', query: '' } : m.length < 5 ? { reason: 'short', query: '' } : { reason: null, query: m });

describe('sample', () => {
  it('searchedLogRows keeps searched rows once per req_id and drops skipped / session-start / incomplete rows', () => {
    const rows = [
      { status: 'injected', project: '/p', prompt_len: 10, req_id: 'r1', via: 'daemon' },
      { status: 'no-match', project: '/p', prompt_len: 10, req_id: 'r1', via: 'fallback' },
      { status: 'skipped', project: '/p', prompt_len: 10 },
      { status: 'injected', project: '/p', via: 'session-start', prompt_len: 3 },
      { status: 'deduped', project: '', prompt_len: 10 },
      { status: 'error', project: '/q', prompt_len: 7 },
    ];
    expect(searchedLogRows(rows).map((r: { status: string }) => r.status)).toEqual(['injected', 'error']);
  });

  it('foldSample applies the current gate, drops synthetic turns, folds one query, counts every drop', () => {
    const aligned = [
      { project: '/p', ts: '2026-10-01T00:00:02Z', sessionId: 's1', exchangeId: 'e2', message: 'How do we deploy the billing service?' },
      { project: '/p', ts: '2026-10-01T00:00:01Z', sessionId: 's0', exchangeId: 'e1', message: 'How do we deploy the billing service?' },
      { project: '/p', ts: '2026-10-01T00:00:03Z', sessionId: 's1', exchangeId: 'e3', message: '<task-notification>x</task-notification>' },
      { project: '/p', ts: '2026-10-01T00:00:04Z', sessionId: 's1', exchangeId: 'e4', message: 'Base directory for this skill: /x\n\nDo things' },
      { project: '/p', ts: '2026-10-01T00:00:05Z', sessionId: 's1', exchangeId: 'e5', message: 'Stop hook feedback:\n[bash x] failed' },
    ];
    const { sample, dropped } = foldSample(aligned, gate);
    expect(sample).toHaveLength(1);
    expect(sample[0]).toMatchObject({ exchangeId: 'e1', sessionId: 's0', split: splitOf('How do we deploy the billing service?') });
    expect(dropped).toEqual({ gate: { 'task-notification': 1 }, synthetic: 2, duplicate: 1 });
  });

  it('alignWindow spans ±180 s and the last second’s milliseconds', () => {
    const [lo, hi] = alignWindow('2026-10-01T00:10:00.500Z');
    expect(lo).toBe('2026-10-01T00:07:00');
    expect(hi).toBe('2026-10-01T00:13:00.999Z');
    expect('2026-10-01T00:13:00.250Z' <= hi).toBe(true);
  });

  it('splitOf is fixed by the text and roughly halves', () => {
    expect(splitOf('abc')).toBe(splitOf('abc'));
    const n = Array.from({ length: 400 }, (_, i) => splitOf(`q${i}`)).filter((s) => s === 'train').length;
    expect(n).toBeGreaterThan(160);
    expect(n).toBeLessThan(240);
  });
});

describe('as-of', () => {
  const index = {
    factCreated: new Map([['old', toEpoch('2026-09-01T00:00:00Z')], ['new', toEpoch('2026-10-02T00:00:00Z')], ['mine', toEpoch('2026-09-01T00:00:00Z')]]),
    factSessions: new Map([['mine', new Set(['s1'])]]),
    factRevised: new Map<string, number>(),
  };
  const asOf = makeAsOf(index, { ts: '2026-10-01T00:00:00Z', sessionId: 's1' });
  it('hides a fact rewritten after the prompt (its text is the later one; the vector is not); an earlier rewrite is fine', () => {
    const idx = {
      ...index,
      factCreated: new Map([...index.factCreated, ['evolved', toEpoch('2026-09-01T00:00:00Z')], ['settled', toEpoch('2026-09-01T00:00:00Z')]]),
      factRevised: new Map([['evolved', toEpoch('2026-10-05T00:00:00Z')], ['settled', toEpoch('2026-09-15T00:00:00Z')]]),
    };
    const a = makeAsOf(idx, { ts: '2026-10-01T00:00:00Z', sessionId: 's9' });
    expect(a.visibleFactId('evolved')).toBe(false);
    expect(a.visibleFactId('settled')).toBe(true);
    expect(makeAsOf(idx, { ts: '2026-10-06T00:00:00Z', sessionId: 's9' }).visibleFactId('evolved')).toBe(true);
  });
  it('hides facts created after the prompt and facts extracted from the prompt’s own session', () => {
    expect(asOf.visibleFactId('old')).toBe(true);
    expect(asOf.visibleFactId('new')).toBe(false);
    expect(asOf.visibleFactId('mine')).toBe(false);
    expect(asOf.visibleFactId('unknown')).toBe(false);
    expect(makeAsOf(index, { ts: '2026-10-01T00:00:00Z', sessionId: 's2' }).visibleFactId('mine')).toBe(true);
  });
  it('a CONTRADICTION merge that rewrote the NEW fact counts as its rewrite (the revision row names the old fact)', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE facts (id TEXT, fact TEXT, created_at TEXT);
             CREATE TABLE bench_fact_sessions (fact_id TEXT, session_id TEXT);
             CREATE TABLE fact_revisions (fact_id TEXT, new_fact TEXT, created_at TEXT);`);
    const fact = db.prepare('INSERT INTO facts VALUES (?, ?, ?)');
    fact.run('old', 'deploy target is heroku', '2026-09-01T00:00:00Z');
    fact.run('new', 'deploy target is vercel, merged', '2026-09-10T00:00:00Z');
    fact.run('later', 'deploy target is vercel, merged', '2026-10-10T00:00:00Z');
    fact.run('evolved', 'cache ttl is 60s', '2026-09-01T00:00:00Z');
    fact.run('other', 'unrelated sentence', '2026-09-01T00:00:00Z');
    fact.run('sameInstant', 'deploy target is vercel, merged', '2026-10-05T00:00:00Z');   // existed at the revision's instant
    const rev = db.prepare('INSERT INTO fact_revisions VALUES (?, ?, ?)');
    rev.run('old', 'deploy target is vercel, merged', '2026-10-05T00:00:00Z');
    rev.run('evolved', 'cache ttl is 60s', '2026-10-06T00:00:00Z');
    const idx = buildFactIndex(db);
    db.close();
    expect(idx.factRevised.get('old')).toBe(toEpoch('2026-10-05T00:00:00Z'));
    expect(idx.factRevised.get('new'), 'the merged text landed on the new fact').toBe(toEpoch('2026-10-05T00:00:00Z'));
    expect(idx.factRevised.has('later'), 'created after the revision — its text is its own').toBe(false);
    expect(idx.factRevised.get('evolved')).toBe(toEpoch('2026-10-06T00:00:00Z'));
    expect(idx.factRevised.has('other')).toBe(false);
    expect(idx.factRevised.get('sameInstant'), 'created at the revision instant counts as existing then').toBe(toEpoch('2026-10-05T00:00:00Z'));
    expect(makeAsOf(idx, { ts: '2026-10-01T00:00:00Z', sessionId: 's9' }).visibleFactId('new')).toBe(false);
    expect(makeAsOf(idx, { ts: '2026-10-07T00:00:00Z', sessionId: 's9' }).visibleFactId('new')).toBe(true);
  });
  it('compares relation times as instants — SQLite "YYYY-MM-DD HH:MM:SS" and ISO alike', () => {
    expect(asOf.visibleRelation({ created_at: '2026-09-30 23:59:59' })).toBe(true);
    expect(asOf.visibleRelation({ created_at: '2026-10-01 00:00:01' })).toBe(false);
    expect(asOf.visibleRelation({ created_at: '2026-10-01T00:00:00.000Z' })).toBe(true);
    expect(asOf.visibleRelation({ created_at: 'garbage' })).toBe(false);
  });
});

describe('kw lane', () => {
  it('extracts identifier-like tokens only, lowercased, without URLs or the project path', () => {
    const ids = extractIdentifiers('fix computeInjectResult in src/inject-core.ts and BASELINE_MARGIN for v1.7.8 see https://x.io/a_b', '/Users/me/proj');
    expect(ids).toEqual(['computeinjectresult', 'src/inject-core.ts', 'baseline_margin', 'v1.7.8']);
    expect(extractIdentifiers('please explain how deployment works here')).toEqual([]);
  });
  it('picks the rarest identifier’s facts, at most two, never a gate-bypass fact', () => {
    const f = (id: string, fact: string, at = '2026-09-01T00:00:00Z') => ({ id, fact, created_at: at });
    const matches = new Map([
      ['common_ident', Array.from({ length: 25 }, (_, i) => f(`c${i}`, 'x'))],
      ['rare_ident', [f('r1', 'reader_first_response_gate can be bypassed with READER_FIRST=0 environment variable'), f('r2', 'rare_ident lives in src/a.ts', '2026-09-02T00:00:00Z'), f('r3', 'rare_ident is old')]],
    ]);
    const { picked, bypassSkipped } = kwLines(['common_ident', 'rare_ident'], matches, ['r3']);
    expect(picked.map((x: { id: string }) => x.id)).toEqual(['r2']);
    expect(bypassSkipped).toBe(1);
    expect(isBypassFact('the push gate can be disabled with GATE=0')).toBe(true);
    expect(isBypassFact('the push gate runs the full suite')).toBe(false);
  });
});

describe('judge response', () => {
  const labels = ['f1', 'f2', 'f3'];
  it('accepts exactly the sent ids with scores 0/1/2', () => {
    const v = validateJudgeReply([{ id: 'f2', score: 0 }, { id: 'f1', score: 2 }, { id: 'f3', score: 1 }], labels);
    expect(v.ok).toBe(true);
    expect(Object.fromEntries(v.scores)).toEqual({ f1: 2, f2: 0, f3: 1 });
  });
  it.each([
    ['missing id', [{ id: 'f1', score: 2 }, { id: 'f2', score: 0 }]],
    ['extra id', [{ id: 'f1', score: 2 }, { id: 'f2', score: 0 }, { id: 'f3', score: 1 }, { id: 'f4', score: 1 }]],
    ['repeated id', [{ id: 'f1', score: 2 }, { id: 'f1', score: 2 }, { id: 'f2', score: 0 }, { id: 'f3', score: 1 }]],
    ['score 3', [{ id: 'f1', score: 3 }, { id: 'f2', score: 0 }, { id: 'f3', score: 1 }]],
    ['score as string', [{ id: 'f1', score: '2' }, { id: 'f2', score: 0 }, { id: 'f3', score: 1 }]],
    ['object not array', { f1: 2, f2: 0, f3: 1 }],
    ['null (non-JSON reply)', null],
  ])('rejects %s', (_name, parsed) => {
    expect(validateJudgeReply(parsed, labels).ok).toBe(false);
  });
  it('labelItems shuffles deterministically per seed and labels f1..fn', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ factId: `x${i}` }));
    const a = labelItems(items, 's').map((x: { factId: string }) => x.factId);
    expect(labelItems(items, 's').map((x: { factId: string }) => x.factId)).toEqual(a);
    expect(labelItems(items, 't').map((x: { factId: string }) => x.factId)).not.toEqual(a);
    expect(labelItems(items, 's').map((x: { label: string }) => x.label)).toEqual(items.map((_, i) => `f${i + 1}`));
  });
});

describe('metrics', () => {
  const lines = new Map([['q1', [{ id: 'a', origin: 'vec' }, { id: 'b', origin: 'rel' }]], ['q2', [{ id: 'c', origin: 'rel' }]], ['q3', []]]);
  const scores: Record<string, number> = { 'q1|a': 2, 'q1|b': 0, 'q2|c': 2 };
  const score = (q: string, id: string) => scores[`${q}|${id}`];
  it('counts lines by score and origin; a prompt with an unjudged line is dropped and listed', () => {
    const { counts, unjudged } = perPromptCounts(['q1', 'q2', 'q3'], lines, score);
    expect(counts.get('q1')).toMatchObject({ lines: 2, j2: 1, j0: 1, rel: 1, relJ0: 1 });
    expect(counts.get('q3')).toMatchObject({ lines: 0 });
    const r = perPromptCounts(['q1'], new Map([['q1', [{ id: 'zz', origin: 'vec' }]]]), score);
    expect(r.unjudged).toEqual(['q1']);
    const agg = aggregate([...counts.values()]);
    expect(agg).toMatchObject({ prompts: 3, lines: 3, j2: 2, rel: 2, precision_j2: 2 / 3, rel_precision_ge1: 0.5 });
    expect(unjudged).toEqual([]);
  });
  it('lostJ2Rel counts j2 relation lines the alternative no longer carries', () => {
    const alt = new Map([['q1', [{ id: 'a', origin: 'vec' }]], ['q2', []]]);
    expect(lostJ2Rel(['q1', 'q2'], lines, alt, score)).toBe(1);
  });
  it('bootstrap is seeded, brackets the point, and returns nulls on an undefined stat', () => {
    const pairs = Array.from({ length: 50 }, (_, i) => ({ base: { j2: 0, lines: 2 }, alt: { j2: i % 2, lines: 2 } }));
    const a = bootstrapDelta(pairs, meanDelta('j2'), { seed: 'x', B: 500 });
    expect(a).toEqual(bootstrapDelta(pairs, meanDelta('j2'), { seed: 'x', B: 500 }));
    expect(a.point).toBeCloseTo(0.5);
    expect(a.lo).toBeLessThanOrEqual(a.point);
    expect(a.hi).toBeGreaterThanOrEqual(a.point);
    expect(bootstrapDelta([], meanDelta('j2'))).toMatchObject({ point: null, lo: null });
    expect(ratioDelta('j2', 'lines')([{ base: { j2: 0, lines: 0 }, alt: { j2: 1, lines: 2 } }])).toBeNull();
  });
});

describe('validity', () => {
  const good = { controlSameJ2Rate: 0.05, controlOtherJ2Rate: 0.0, agreement: 0.9, agreementPairs: 150, rejudgePrompts: 30, deterministic: true, heldoutPrompts: 150, hardPrompts: 100, judgeCalls: 200, judgeFailures: 1 };
  it('passes when every gate holds', () => {
    expect(validity(good).valid).toBe(true);
  });
  it.each([
    ['V1', { controlSameJ2Rate: 0.11 }], ['V2', { controlOtherJ2Rate: 0.06 }], ['V3', { agreement: 0.84 }], ['V3', { agreementPairs: 99 }], ['V3', { rejudgePrompts: 29 }],
    ['V4', { deterministic: false }], ['V5', { heldoutPrompts: 99 }], ['V5', { hardPrompts: 29 }], ['V6', { judgeFailures: 5 }],
    ['V1', { controlSameJ2Rate: null }],
  ])('fails %s', (gateName, change) => {
    const v = validity({ ...good, ...change });
    expect(v.valid).toBe(false);
    expect(v.gates[gateName as 'V1'].pass).toBe(false);
  });
});

describe('decision', () => {
  const agg = (relPrec: number | null, rel: number, relJ2: number) => ({ rel_precision_ge1: relPrec, rel, relJ2 });
  const st = (relPrec: number | null, lost: number, hi: number | null = -0.1, rel = 100, relJ2 = 20) =>
    ({ agg: agg(relPrec, rel, relJ2), lostJ2Rel: lost, relJ0Delta: { point: hi === null ? null : hi - 0.05, lo: hi === null ? null : hi - 0.1, hi } });
  const base = (over: Record<string, unknown> = {}) => ({
    train: { v0: st(0.5, 0), rel020: st(0.55, 1), rel030: st(0.62, 2), rel045: st(0.8, 9), ...over },
    heldout: { v0: st(0.5, 0), rel020: st(0.55, 0), rel030: st(0.6, 1, -0.05), rel045: st(0.8, 5) },
  });
  it('C3 keep: the smallest margin passing the train rule, confirmed on held-out', () => {
    const d = decideC3(base());
    expect(d).toMatchObject({ decision: 'keep', relMargin: 0.03 });
  });
  it('C3 reject on train: no margin gains 10pp without losing more than 10% of j2 relation lines', () => {
    const d = decideC3(base({ rel030: st(0.62, 3), rel045: st(0.8, 9) }));
    expect(d.decision).toBe('reject');
    expect(d.relMargin).toBeNull();
  });
  it('C3 reject on held-out: CI upper bound not below zero', () => {
    const s = base();
    s.heldout.rel030 = st(0.6, 1, 0.01);
    expect(decideC3(s)).toMatchObject({ decision: 'reject', relMargin: null });
  });
  it('C3 not decidable without relation lines', () => {
    const s = base();
    s.train.v0 = st(null, 0, -0.1, 0, 0);
    expect(decideC3(s).decision).toBe('not-decidable');
  });
  it('C2 keep / reject / not-decidable', () => {
    const ci = (lo: number) => ({ point: lo + 0.1, lo, hi: lo + 0.2 });
    expect(decideC2({ affected: 40, j2Delta: ci(0.01), precisionJ2Delta: ci(-0.04) })).toMatchObject({ decision: 'keep', scopeFamily: true });
    expect(decideC2({ affected: 40, j2Delta: ci(-0.01), precisionJ2Delta: ci(0) })).toMatchObject({ decision: 'reject', scopeFamily: false });
    expect(decideC2({ affected: 40, j2Delta: ci(0.1), precisionJ2Delta: ci(-0.06) })).toMatchObject({ decision: 'reject', scopeFamily: false });
    expect(decideC2({ affected: THRESHOLDS.C2_min_affected - 1, j2Delta: ci(1), precisionJ2Delta: ci(0) })).toMatchObject({ decision: 'not-decidable', scopeFamily: false });
  });
  it('an invalid harness decides nothing: production stays current', () => {
    const d = decide(false, { decision: 'keep', relMargin: 0.03 }, { decision: 'keep', scopeFamily: true });
    expect(d.verdict).toBe('invalid');
    expect(d.production).toEqual({ relMargin: null, scopeFamily: false });
    expect(decide(true, { decision: 'keep', relMargin: 0.03 }, { decision: 'reject', scopeFamily: false }).production).toEqual({ relMargin: 0.03, scopeFamily: false });
  });
  it('the decisions block round-trips through the committed markdown', () => {
    const d = decide(true, { decision: 'keep', relMargin: 0.045 }, { decision: 'reject', scopeFamily: false });
    const md = `# x\n\n${decisionsBlock(d)}\n`;
    expect(parseDecisionsBlock(md)).toEqual({ verdict: 'valid', production: { relMargin: 0.045, scopeFamily: false } });
    expect(parseDecisionsBlock('no block')).toBeNull();
  });
  it('leak probes are folded 40-char windows every 20 chars over the whole text — every 59-char run holds one', () => {
    expect(leakProbes(['  How   do we deploy the billing service to production today please', 'short'])[0])
      .toBe('how do we deploy the billing service to');
    expect(leakProbes(['short'])).toEqual([]);
    const long = Array.from({ length: 600 }, (_, i) => String.fromCharCode(0x4e00 + i)).join(''); // no window repeats
    const probes = leakProbes([long]);
    expect(probes.length).toBe(30);
    for (let i = 0; i + 59 <= long.length; i++) expect(probes.some((w) => long.slice(i, i + 59).includes(w)), `offset ${i}`).toBe(true);
    expect(probes.some((w) => w.endsWith(long.slice(-5))), 'windows reach the end of the text').toBe(true);
  });
  it('--check-determinism without lines files names the run order instead of crashing', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-det-'));
    try {
      const script = fileURLToPath(new URL('../bench/inject-replay.mjs', import.meta.url));
      const r = spawnSync(process.execPath, [script, '--check-determinism', '--out', out], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/run --replay first \(order: --build → --replay → --check-determinism\)/);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
  it('the report decides C2 on the registered reading and refuses meta lists of other bytes (scripts pinned)', () => {
    const judge = fs.readFileSync(fileURLToPath(new URL('../bench/inject-judge.mjs', import.meta.url)), 'utf8');
    const replay = fs.readFileSync(fileURLToPath(new URL('../bench/inject-replay.mjs', import.meta.url)), 'utf8');
    expect(judge).toContain('const unbound = unboundMeta(meta.hashes, lineSha);\n  if (unbound.length) fail(');
    expect(judge).toContain('const affected = usable(meta.affectedRegistered);\n  const c2stats = c2For(affected);');
    expect(judge).toContain('const c2 = decideC2(c2stats);');
    expect(judge, 'grouped by repository (replay-time roots), not by worktree').toContain('const repoOfQ = (q) => repoOf(rootsOfQ(q), projectOf.get(q));');
    expect(judge, 'roots as resolved at replay time, never the disk at report time').toContain('const rootsOfQ = (q) => meta.roots[projectOf.get(q)];');
    expect(judge).not.toContain('resolveRepoRoots');
    expect(replay).toContain('const roots = recordRoots(rootsOf, project, resolveRepoRoots);\n      widenedOf.set(project, widenedFactIds(projectFacts, project, scopeMatcher(project, true), roots.length > 0));');
    expect(replay, 'bound before the sample is read').toMatch(/const bound = replayBinding\(REPO, OUT, EMBEDDING_MODEL\);\n  const sample = JSON\.parse/);
    expect(replay, 'and checked again at the end').toContain('const drift = bindingDrift(bound, replayBinding(REPO, OUT, EMBEDDING_MODEL));\n  if (drift.length) fail(');
    expect(replay).toContain('const { inputs, code } = bound;');
    expect(judge, 'the report compares the whole code digest but the Node version').toContain('const codeChanged = driftedCode(withoutNode(meta.code?.files), withoutNode(codeDigest(REPO, EMBEDDING_MODEL)));');
    expect(judge, 'every scored judgment row is bound').toContain("if ((j.bound && (b.seed !== j.bound.seed || b.message !== j.bound.message)) || rebuilt(j, b.seed) !== b.message) { binding.drifted++; continue; }");
    expect(judge, 'and every binding count in the stop list stops the report').toContain(`const BINDING_STOPS = [
  'unbound', 'drifted', 'noReply', 'noCall', 'badItems', 'callReused', 'transcriptMismatch', 'keptWithoutRow', 'malformedRows', 'failedUnbound',
  'duplicateRows', 'overlapItems', 'noSelfRecord', 'notLegacy', 'retiredLost', 'answeredByOther', 'evidenceDrift',
];`);
    expect(judge).toContain('if (BINDING_STOPS.some((k) => binding[k])) fail(`judgment rows not bound');
    expect(judge, 'the judge records what it sends with the function the report checks with').toContain('const bound = { seed: task.seed, message: judgeMessageSha(task.prompt, task.want, task.seed, text) };');
    expect(judge, 'a judged row keeps the reply it got').toContain('if (v.ok) return { ...v, retried: attempt > 0, reply: text, message, attempts: attempt + 1 };');
    expect(judge, 'and --judge keeps each call under its row\'s key, success or failure').toContain('      append(rec);\n      keep(rec, reply);\n    } else {');
    expect(judge).toContain("      const rec = { qid: task.prompt.qid, pass: task.pass, model: MODEL, at: new Date().toISOString(), items: task.want, bound, failed: reply.reason };\n      append(rec);\n      keep(rec, reply);");
    expect(judge).toContain('retried: reply.retried, reply: reply.reply,');
    expect(judge, '--judge binds what it wrote before any report reads it').toContain('// every scored row — these new ones too — is bound to its recorded call before a report reads it\n  await bindLegacy();');
    expect(judge, 'and labels the call with the same seed').toContain('const labeled = labelItems(task.want.map((w) => ({ ...w, text: text(w.factId) })), task.seed);');
    expect(judge, 'a failed first call is asked again in full (its controls too)').toContain('const items = scoredMainItems(prior, MODEL);');
    expect(judge, 'and a re-judge asks the scored main items only').toContain('const itemsNow = scoredMainItems(loadJudgments(), MODEL);');
    expect(judge, '--judge checks its arguments, then retires, before it asks anything').toMatch(/const limit = intArg\('--limit'[^\n]*\n  closeTornTail\(JUDGMENTS\);\n  closeTornTail\(JUDGE_CALLS\);\n  const \{ sample, lines \} = await loadBench\(\);\n  const retired = await retireStale\(sample, lines\);\n/);
    expect(judge, 'retiring records the marked calls in the bindings, then marks them, then the rows go').toMatch(/write\(BINDINGS, JSON\.stringify\(\{ \.\.\.\(doc \?\? \{ version: 6 \}\), retired, retiredRows: [^\n]*\n  write\(JUDGE_CALLS, calls\.map[^\n]*\n  const rest = [^\n]*\n  write\(JUDGMENTS, rest/);
    expect(replay).toContain('const reading = affectedReadings(widened(p.project), asOf.visibleFactId);');
    expect(replay).toContain('if (reading.registered) { affected.add(p.qid); meta.affectedRegistered.push(p.qid); }');
    expect(replay).toContain('const projectFacts = db.prepare(PROJECT_FACTS_SQL).all();');
    expect(replay).toContain('variants[v] = determinismEntry(a, b, used);');
    expect(judge).toContain('const deterministic = determinismBound(det, lineSha);');
  });
  it('a prompt\'s judged main items are its scored main rows\' — never a failed row\'s, another model\'s or a re-judge\'s', async () => {
    const { scoredMainItems } = await import('../bench/inject-bench-lib.mjs');
    const it_ = (id: string, kind = 'line') => ({ factId: id, kind });
    const rows = [
      { qid: 'q1', pass: 'main', model: 'm', items: [it_('a'), it_('x', 'control_same')], failed: 'invalid reply' },
      { qid: 'q1', pass: 'main', model: 'm', items: [it_('a'), it_('y', 'control_same')], scores: { a: 1, y: 0 } },
      { qid: 'q1', pass: 'main', model: 'm', items: [it_('b')], scores: { b: 2 } },
      { qid: 'q1', pass: 'rejudge', model: 'm', items: [it_('a'), it_('y', 'control_same'), it_('b')], scores: { a: 1, y: 0, b: 2 } },
      { qid: 'q1', pass: 'main', model: 'other', items: [it_('c')], scores: { c: 0 } },
      { qid: 'q2', pass: 'main', model: 'm', items: [it_('d')], failed: 'invalid reply' },
    ];
    const got = scoredMainItems(rows, 'm');
    expect(Object.fromEntries([...got].map(([q, items]) => [q, items.map((x: { factId: string }) => x.factId)]))).toEqual({ q1: ['a', 'y', 'b'] });
  });
  it('affected readings, determinism entries and input binding (shared by replay and report)', () => {
    expect(PROJECT_FACTS_SQL, 'the registered reading counts facts active now').toMatch(/WHERE is_active = 1 AND scope_type = 'project'$/);
    expect(affectedReadings([], () => true)).toEqual({ registered: false, asOf: false });
    expect(affectedReadings(['a', 'b'], () => false)).toEqual({ registered: true, asOf: false });
    expect(affectedReadings(['a', 'b'], (id) => id === 'b')).toEqual({ registered: true, asOf: true });
    expect(determinismEntry('x', 'x', 'x').identical).toBe(true);
    expect(determinismEntry('x', 'x', 'y').identical, 'two runs agree with each other but not with the judged file').toBe(false);
    expect(determinismEntry('x', 'y', 'x').identical).toBe(false);
    const det = { identical: true, variants: { v0: { a: 'h0', b: 'h0' }, kw: { a: 'h1', b: 'h1' } } };
    expect(determinismBound(det, { v0: 'h0', kw: 'h1' })).toBe(true);
    expect(determinismBound(det, { v0: 'h0', kw: 'h2' })).toBe(false);
    expect(determinismBound({ ...det, identical: false }, { v0: 'h0', kw: 'h1' })).toBe(false);
    expect(determinismBound(null, { v0: 'h0' })).toBe(false);
    expect(driftedInputs({ sample: 'a', snapshot: 'b' }, { sample: 'a', snapshot: 'c' })).toEqual(['snapshot']);
    expect(driftedInputs(undefined, { sample: 'a' })).toEqual(['sample']);
    expect(missingRows(['q1', 'q2'], { v0: new Map([['q1', []], ['q2', []]]), kw: new Map([['q1', []]]) })).toEqual([{ variant: 'kw', missing: 1 }]);
  });
  it('placement, widened ids, code and SQLite digests (replay records, report compares)', () => {
    expect(placementOf('/r/docs', ['/r'])).toBe('repo-folder');
    expect(placementOf('/r', ['/r'])).toBe('repo-folder');
    expect(placementOf('/r/.claude/worktrees/w', ['/r/.claude/worktrees/w', '/r'])).toBe('worktree-inside');
    expect(placementOf('/r/.claude/worktrees', ['/r']), 'one root: the repository folder (a plain folder in a container has no family)').toBe('repo-folder');
    expect(placementOf('/u/.auto-issue-worktrees/ORG-r/issue-1', ['/u/.auto-issue-worktrees/ORG-r/issue-1', '/r'])).toBe('worktree-outside');
    expect(placementOf('/r-x', ['/r-x', '/r']), 'a sibling whose name extends the repository is outside it').toBe('worktree-outside');
    expect(placementOf('/x', [])).toBe('no-family');
    const facts = [{ id: 'a', scope_project: '/r' }, { id: 'b', scope_project: '/r/docs' }, { id: 'c', scope_project: '/other' }];
    const inFamily = (s: string | null) => s === '/r' || (s ?? '').startsWith('/r/');
    expect(widenedFactIds(facts, '/r/docs', inFamily, true), 'the exact path is not a widening').toEqual(['a']);
    expect(widenedFactIds(facts, '/r/docs', inFamily, false)).toEqual([]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-digest-'));
    try {
      const f = path.join(dir, 's.sqlite');
      fs.writeFileSync(f, 'main');
      const before = sqliteDigest(f);
      fs.writeFileSync(`${f}-wal`, 'pages');
      expect(sqliteDigest(f), 'uncheckpointed WAL pages change the digest').not.toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('moduleClosure follows every load of the replay (static, literal import(), the dist helper) and refuses what it cannot follow', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-closure-'));
    const put = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
    try {
      put(REPLAY_ENTRY, "import a from './lib.mjs';\nimport fs from 'node:fs';\nimport os from 'os';\nimport Db from 'better-sqlite3';\nconst m = await import(dist('mod.js'));\nawait import('./dyn.mjs');\n");
      put('bench/lib.mjs', "export * from '../dist/dep.js';\n// prose: the value comes from \"name: description\" in passage mode\n");
      put('bench/dyn.mjs', 'export const x = 1;\n');
      put('dist/mod.js', "import { y } from './dep.js';\nimport '@scope/pkg/sub';\n");
      put('dist/dep.js', 'export const y = 2;\n');
      put('dist/unused.js', 'export const z = 3;\n');
      expect(moduleClosure(dir)).toEqual({
        files: ['bench/dyn.mjs', REPLAY_ENTRY, 'bench/lib.mjs', 'dist/dep.js', 'dist/mod.js'].sort(),
        packages: ['@scope/pkg', 'better-sqlite3'],
      });
      put('dist/dep.js', "export const y = 2;\nconst k = await import(name);\n");
      expect(() => moduleClosure(dir), 'a computed import').toThrow(/cannot follow/);
      put('dist/dep.js', "const r = require('x');\n");
      expect(() => moduleClosure(dir), 'a CommonJS require').toThrow(/cannot follow/);
      put('dist/dep.js', "const n = 'mod.js';\nawait import(dist(n));\n");
      expect(() => moduleClosure(dir), 'a computed dist name').toThrow(/cannot follow/);
      put('dist/dep.js', "const n = 'mod.js';\nexecFileSync(process.execPath, [dist(n)]);\n");
      expect(() => moduleClosure(dir), 'a computed dist path run as a child process').toThrow(/cannot follow/);
      put('dist/dep.js', "import './gone.js';\n");
      expect(() => moduleClosure(dir), 'a relative import naming no file').toThrow(/dist\/gone\.js is imported but is not a file/);
      put('dist/dep.js', 'export const y = 2;\n');
      // the digest: modules, package versions, the model id and the model files a person placed — any entry changing (or vanishing) is drift
      put('node_modules/better-sqlite3/package.json', '{"version":"1.2.3"}');
      const before = codeDigest(dir, 'Org/model');
      expect(before['package:better-sqlite3']).toBe('1.2.3');
      expect(before['package:@scope/pkg'], 'a package that is not installed').toBe('missing');
      expect(before['embedding-model']).toBe('Org/model');
      // The package's download cache is not in the digest (R2-REL-1): the library fills it the first time the model is
      // loaded — by the replay itself or by another process — so a file appearing there, or caught half-written, is not
      // a change of code. A downloaded model is bound by its id.
      const cached = 'node_modules/@xenova/transformers/.cache/Org/model/onnx/model_quantized.onnx';
      put('node_modules/@xenova/transformers/.cache/Org/model/tokenizer.json', '{}');
      put(cached, 'the first half of the fi');
      expect(embeddingModelFiles(dir, 'Org/model')).toEqual([]);
      const withModel = codeDigest(dir, 'Org/model');
      expect(driftedCode(before, withModel), 'the cache filled between two digests').toEqual([]);
      expect(Object.keys(withModel).filter((k) => k.includes('.cache')), 'no cache file is recorded').toEqual([]);
      put(cached, 'the first half of the file, then the rest');
      expect(driftedCode(withModel, codeDigest(dir, 'Org/model')), 'a download finishing').toEqual([]);
      // The local models folder (transformers reads it before it downloads anything) is filled by hand: its files count,
      // and a linked weight file is still a weight file.
      const local = 'node_modules/@xenova/transformers/models/Org/model/onnx/model_quantized.onnx';
      put('weights-store/real.onnx', 'w3');
      fs.mkdirSync(path.dirname(path.join(dir, local)), { recursive: true });
      fs.symlinkSync(path.join(dir, 'weights-store', 'real.onnx'), path.join(dir, local));
      expect(embeddingModelFiles(dir, 'Org/model')).toEqual([local]);
      const linked = codeDigest(dir, 'Org/model');
      expect(driftedCode(withModel, linked), 'a model placed in the local folder').toEqual([local]);
      put('weights-store/real.onnx', 'w4');
      expect(driftedCode(linked, codeDigest(dir, 'Org/model')), 'the linked file\'s bytes').toEqual([local]);
      fs.rmSync(path.join(dir, local));
      expect(driftedCode(linked, codeDigest(dir, 'Org/model')), 'the placed model taken away').toEqual([local]);
      expect(driftedCode(withModel, codeDigest(dir, 'Org/model')), 'back to the downloaded model').toEqual([]);
      expect(driftedCode(withModel, codeDigest(dir, 'Org/other')), 'another model').toContain('embedding-model');
      put('dist/dep.js', 'export const y = 3;\n');
      expect(driftedCode(withModel, codeDigest(dir, 'Org/model'))).toContain('dist/dep.js');
      put('node_modules/better-sqlite3/package.json', '{"version":"1.2.4"}');
      expect(driftedCode(withModel, codeDigest(dir, 'Org/model'))).toContain('package:better-sqlite3');
      const { 'dist/dep.js': _gone, ...withoutDep } = withModel;
      expect(driftedCode(withModel, withoutDep), 'an entry the replay recorded that is gone now').toEqual(['dist/dep.js']);
      expect(driftedCode(withoutDep, withModel), 'an entry the replay never recorded').toEqual(['dist/dep.js']);
      expect(driftedCode(undefined, { a: 'x' })).toEqual(['a']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // The real replay: the modules that decide its lines — selection, scope, text cap, model id, canonical project — are all in it.
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const real = moduleClosure(repo);
    expect(real.files).toEqual(expect.arrayContaining(['bench/inject-replay.mjs', 'bench/inject-bench-lib.mjs', 'dist/inject-select.js', 'dist/project-family.js',
      'dist/fact-db.js', 'dist/ontology-db.js', 'dist/embeddings.js', 'dist/db.js', 'dist/fact-text.js', 'dist/embedding-version.js', 'dist/project-canon.js']));
    expect(real.packages).toEqual(expect.arrayContaining(['@xenova/transformers', 'better-sqlite3', 'sqlite-vec']));
    const realDigest = codeDigest(repo, 'Xenova/multilingual-e5-small');
    expect(realDigest.node, 'the Node version').toBe(`${process.version} ${process.platform}-${process.arch}`);
    expect(Object.keys(realDigest), 'sub-dependencies and native binaries').toEqual(expect.arrayContaining(['package:onnxruntime-node', 'native:node_modules/better-sqlite3/build/Release/better_sqlite3.node']));
    expect(Object.keys(realDigest).filter((k) => k.includes('/.cache/')), 'no downloaded model file, whether this checkout has fetched the model or not').toEqual([]);
  });
  it('dependencyDigest follows dependencies (own node_modules first) and installed optional ones, with native binaries; a missing required one is recorded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-deps-'));
    const put = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
    const pkg = (rel: string, version: string, deps: Record<string, string> = {}, optional: Record<string, string> = {}) =>
      put(`${rel}/package.json`, JSON.stringify({ version, dependencies: deps, optionalDependencies: optional }));
    try {
      pkg('node_modules/a', '1.0.0', { b: '^1', gone: '^1' }, { 'opt-here': '1', 'opt-absent': '1' });
      pkg('node_modules/b', '1.0.0');
      pkg('node_modules/a/node_modules/b', '2.0.0', { c: '1', d: '1' });   // a's own b wins over the top-level one
      pkg('node_modules/c', '3.0.0');
      pkg('node_modules/a/node_modules/d', '4.1.0');   // b needs d: found in the enclosing a/node_modules, not the top level
      pkg('node_modules/d', '4.0.0');
      put('node_modules/c/lib/libc.so.1', 'versioned shared object');
      pkg('node_modules/opt-here', '0.1.0');
      put('node_modules/opt-here/bin/lib.dylib', 'native-1');
      put('node_modules/opt-here/bin/readme.txt', 'not native');
      put('node_modules/opt-here/node_modules/x/x.node', 'nested package — not opt-here\'s own binary');
      const d = dependencyDigest(dir, ['a']);
      expect(d).toEqual({
        'package:a': '1.0.0', 'package:a/node_modules/b': '2.0.0', 'package:c': '3.0.0', 'package:a/node_modules/d': '4.1.0', 'package:gone': 'missing', 'package:opt-here': '0.1.0',
        'native:node_modules/opt-here/bin/lib.dylib': crypto.createHash('sha256').update('native-1').digest('hex'),
        'native:node_modules/c/lib/libc.so.1': crypto.createHash('sha256').update('versioned shared object').digest('hex'),
      });
      put('node_modules/opt-here/bin/lib.dylib', 'native-2');
      expect(driftedCode(d, dependencyDigest(dir, ['a']))).toEqual(['native:node_modules/opt-here/bin/lib.dylib']);
      pkg('node_modules/c', '3.0.1');
      expect(driftedCode(d, dependencyDigest(dir, ['a']))).toContain('package:c');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('gitState: HEAD and whether src/bench/dist are dirty (a temporary repository)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-git-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
    try {
      expect(gitState(dir), 'no repository').toEqual({ git: null, dirty: null });
      git('init', '-q');
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'a');
      fs.writeFileSync(path.join(dir, 'notes.md'), 'n');
      git('add', '.');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'c');
      const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      expect(gitState(dir)).toEqual({ git: head, dirty: false });
      fs.writeFileSync(path.join(dir, 'notes.md'), 'changed');
      expect(gitState(dir).dirty, 'outside src/bench/dist').toBe(false);
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'changed');
      expect(gitState(dir)).toEqual({ git: head, dirty: true });
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'a');
      fs.mkdirSync(path.join(dir, 'bench'));
      fs.writeFileSync(path.join(dir, 'bench', 'new.mjs'), 'untracked');
      expect(gitState(dir).dirty, 'an untracked bench file').toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('replayBinding / bindingDrift / recordRoots: what the replay records is what it read, roots in the resolver\'s order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-bind-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-bind-repo-'));
    try {
      fs.mkdirSync(path.join(repo, 'bench'));
      fs.writeFileSync(path.join(repo, REPLAY_ENTRY), 'export const x = 1;\n');
      fs.writeFileSync(path.join(dir, 'sample.json'), '[]');
      fs.writeFileSync(path.join(dir, 'snapshot.sqlite'), 'db');
      const a = replayBinding(repo, dir, 'Org/model');
      expect(bindingDrift(a, replayBinding(repo, dir, 'Org/model'))).toEqual([]);
      fs.writeFileSync(path.join(dir, 'sample.json'), '[1]');
      expect(bindingDrift(a, replayBinding(repo, dir, 'Org/model'))).toEqual(['sample']);
      fs.writeFileSync(path.join(dir, 'sample.json'), '[]');
      fs.writeFileSync(path.join(dir, 'snapshot.sqlite-wal'), 'pages');
      expect(bindingDrift(a, replayBinding(repo, dir, 'Org/model'))).toEqual(['snapshot']);
      fs.rmSync(path.join(dir, 'snapshot.sqlite-wal'));
      fs.writeFileSync(path.join(repo, REPLAY_ENTRY), 'export const x = 2;\n');
      expect(bindingDrift(a, replayBinding(repo, dir, 'Org/model'))).toEqual([REPLAY_ENTRY]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
    const rootsOf: Record<string, string[]> = {};
    const resolved = ['/r/.claude/worktrees/w', '/r'];
    let calls = 0;
    const resolve = () => { calls++; return resolved; };
    expect(recordRoots(rootsOf, '/r/.claude/worktrees/w', resolve)).toEqual(['/r/.claude/worktrees/w', '/r']);
    resolved.reverse();
    expect(rootsOf['/r/.claude/worktrees/w'], 'a copy, in the order resolved').toEqual(['/r/.claude/worktrees/w', '/r']);
    recordRoots(rootsOf, '/r/.claude/worktrees/w', resolve);
    expect(calls, 'resolved once per cwd').toBe(1);
    expect(recordRoots(rootsOf, 'constructor', () => [])).toEqual([]);
  });
  it('judge binding: the message is the system text + user message; any text, seed or prompt change is another message', () => {
    const prompt = { project: '/p', query: 'Which tool runs migrations?' };
    const items = [{ factId: 'a', kind: 'line' }, { factId: 'b', kind: 'line' }, { factId: 'c', kind: 'control_same' }];
    const texts: Record<string, string> = { a: '[decision] Flyway runs migrations', b: '[note] lunch is stew', c: '[note] plants on Monday' };
    const textOf = (id: string) => texts[id];
    const labeled = labelItems(items.map((it) => ({ ...it, text: textOf(it.factId) })), 'q:main:0');
    expect(judgeMessage(prompt, labeled)).toBe(`${JUDGE_SYSTEM}\n\n${judgeUserMessage(prompt, labeled)}`);
    const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
    const m0 = judgeMessageSha(prompt, items, 'q:main:0', textOf);
    expect(m0).toBe(sha(judgeMessage(prompt, labeled)));
    expect(judgeMessageSha(prompt, items, 'q:main:3', textOf), 'another seed labels the notes in another order').not.toBe(m0);
    expect(judgeMessageSha({ ...prompt, query: 'Which tool?' }, items, 'q:main:0', textOf)).not.toBe(m0);
    expect(judgeMessageSha({ ...prompt, project: '/other' }, items, 'q:main:0', textOf)).not.toBe(m0);
    expect(judgeMessageSha(prompt, items, 'q:main:0', (id) => (id === 'b' ? '[note] lunch is soup' : textOf(id))), 'one fact text').not.toBe(m0);
    // what the judge received: the first attempt, or a retry (first message + a note)
    const sent = judgeMessage(prompt, labeled);
    expect(firstAttemptSha(sent)).toBe(m0);
    expect(firstAttemptSha(judgeRetryUser(sent, 'missing id f2'))).toBe(m0);
    expect(isRetryMessage(judgeRetryUser(sent, 'missing id f2'))).toBe(true);
    expect(isRetryMessage(sent)).toBe(false);
    // a prompt that quotes the retry note is not cut there: only the note a retry appends at the end is
    const quoting = { ...prompt, query: `why did it say${JUDGE_RETRY_MARK}missing id f2)?` };
    const quotingMsg = judgeMessage(quoting, labeled);
    expect(firstAttemptSha(quotingMsg), 'a first attempt quoting the note').toBe(sha(quotingMsg));
    expect(isRetryMessage(quotingMsg)).toBe(false);
    expect(firstAttemptSha(judgeRetryUser(quotingMsg, 'bad json')), 'its retry').toBe(sha(quotingMsg));
    expect(firstAttemptSha(`${sent}${JUDGE_RETRY_MARK}missing id f2). Answer again`), 'a note without the full tail is no retry').not.toBe(m0);
    expect(judgeSeedCandidates({ qid: 'q', pass: 'rejudge' }, 9)).toEqual(['q:rejudge']);
    expect(judgeSeedCandidates({ qid: 'q', pass: 'main' }, 2)).toEqual(['q:main:0', 'q:main:1', 'q:main:2']);
    expect(judgeSeedCandidates({ qid: 'q', pass: 'main', bound: { seed: 'q:main:7' } }, 2), 'the seed a row recorded when judged').toEqual(['q:main:7']);
    // a legacy row binds to a call whose message is the row's AND whose reply gives the row's scores, from the row's model
    const later = labelItems(items.map((it) => ({ ...it, text: textOf(it.factId) })), 'q:main:2');
    const scores = { a: 2, b: 0, c: 1 };
    const replyOf = (lab: typeof later, sc: Record<string, number>) => JSON.stringify(lab.map((it) => ({ id: it.label, score: sc[it.factId] })));
    const row = { qid: 'q', pass: 'main', model: 'm1', items, scores };
    const parse = (t: string) => { try { return JSON.parse(t); } catch { return null; } };
    expect(replyGivesRowScores(row, 'q:main:2', replyOf(later, scores), textOf, parse)).toBe(true);
    expect(replyGivesRowScores(row, 'q:main:2', replyOf(later, { ...scores, b: 1 }), textOf, parse), 'one score differs').toBe(false);
    expect(replyGivesRowScores(row, 'q:main:0', replyOf(later, scores), textOf, parse), 'labels of another seed').toBe(false);
    const call = { message: judgeMessage(prompt, later), reply: replyOf(later, scores), model: 'm1' };
    const calls = indexCalls([{ message: 'an unrelated worker prompt', reply: '[]', model: 'm1' }, call]);
    expect(legacyBinding(row, prompt, textOf, calls, 5, parse)).toEqual({ seed: 'q:main:2', message: sha(judgeMessage(prompt, later)), call });
    expect(legacyBinding(row, prompt, textOf, calls, 1, parse), 'the seed is past the candidates').toBeNull();
    expect(legacyBinding(row, prompt, (id) => (id === 'a' ? '[decision] Liquibase' : textOf(id)), calls, 5, parse), 'the text judged differs').toBeNull();
    expect(legacyBinding({ ...row, model: 'm2' }, prompt, textOf, calls, 5, parse), 'another model answered').toBeNull();
    expect(legacyBinding({ ...row, scores: { ...scores, c: 2 } }, prompt, textOf, calls, 5, parse), 'the row holds other scores').toBeNull();
    const retry = { ...call, message: judgeRetryUser(call.message, 'missing id f1') };
    const failedFirst = { ...call, reply: 'not json' };
    expect(legacyBinding(row, prompt, textOf, indexCalls([failedFirst, retry]), 5, parse)?.call, 'the retry that answered, not the first attempt').toBe(retry);
    expect(legacyBinding(row, prompt, textOf, indexCalls([retry, failedFirst]), 5, parse)?.call, 'in either order').toBe(retry);
    // one call answers one row: a call already binding another row is passed over
    const filed = { ...call, file: 'llm/one.jsonl' };
    expect(legacyBinding(row, prompt, textOf, indexCalls([filed]), 5, parse, new Set(['llm/one.jsonl'])), 'the only call is taken').toBeNull();
    const second = { ...call, file: 'llm/two.jsonl' };
    expect(legacyBinding(row, prompt, textOf, indexCalls([filed, second]), 5, parse, new Set(['llm/one.jsonl']))?.call, 'the other recording of the same call').toBe(second);
  });
  it('repoOf groups a linked worktree with its repository; unboundMeta names variants whose meta hash differs', () => {
    expect(repoOf(['/r/.wt/a', '/r'], '/r/.wt/a/src')).toBe('/r');
    expect(repoOf(['/r'], '/r/docs')).toBe('/r');
    expect(repoOf([], '/x')).toBe('/x');
    expect(unboundMeta({ v0: 'a', family: 'b' }, { v0: 'a', family: 'c', kw: 'd' })).toEqual(['family', 'kw']);
    expect(unboundMeta(undefined, { v0: 'a' })).toEqual(['v0']);
    expect(unboundMeta({ v0: 'a' }, { v0: 'a' })).toEqual([]);
  });
  it('leak fold catches a copy that differs in case, Unicode form, markdown escapes or spacing', () => {
    const fact = 'Release notes are written in Korean — 릴리즈 노트는 한국어로 쓴다 and attached to the GitHub release';
    const copy = `> release NOTES are written in korean — ${'릴리즈 노트는 한국어로 쓴다'.normalize('NFD')} and attached to the GitHub\\_release`;
    const body = leakFold(copy);
    expect(leakProbes([fact]).some((w) => body.includes(w))).toBe(true);
    expect(leakProbes(['A completely different sentence about lunch menus on Fridays']).some((w) => body.includes(w))).toBe(false);
  });
  it('blockDiffers lists prompts whose shown ids differ', () => {
    const a = new Map([['q1', [{ id: 'x' }]], ['q2', [{ id: 'x' }, { id: 'y' }]]]);
    const b = new Map([['q1', [{ id: 'x' }]], ['q2', [{ id: 'y' }, { id: 'x' }]], ['q3', [{ id: 'z' }]]]);
    expect(blockDiffers(['q1', 'q2', 'q3', 'q4'], a, b)).toEqual(['q2', 'q3']);
  });
});
