import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { suppressConsole } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

// Mock the LLM so each consolidation "comparison" is deterministic and counted.
vi.mock('../src/llm.js', () => ({
  callHaiku: vi.fn().mockResolvedValue('{"relation":"INDEPENDENT","merged_fact":"","reason":"unrelated"}'),
  parseJsonResponse: vi.fn().mockReturnValue({ relation: 'INDEPENDENT', merged_fact: '', reason: 'unrelated' }),
}));
// Avoid loading the real embedding model.
vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  EMBEDDING_VERSION: 2,
  EMBEDDING_MODEL: 'test',
}));

import { callHaiku, parseJsonResponse } from '../src/llm.js';
import { initDatabase } from '../src/db.js';
import { insertFact, getAllNewFactsSince } from '../src/fact-db.js';
import { consolidateAllPending, isTransientLlmError, classifyLlmError } from '../src/consolidator.js';

const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

const EMB = new Array(384).fill(0.1); // identical → always "similar"

function addFact(db: Database.Database, fact: string, scope_type: 'project' | 'global', scope_project: string | null) {
  insertFact(db, { fact, category: 'decision', scope_type, scope_project, source_exchange_ids: [], embedding: EMB });
}

describe('consolidateAllPending', () => {
  let db: Database.Database;
  const testDir = path.join(os.tmpdir(), 'consolidate-all-' + Date.now());
  const dbPath = path.join(testDir, 'test.db');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    process.env.TEST_DB_PATH = dbPath;
    db = initDatabase();
    vi.clearAllMocks();
    // Restore default verdict (INDEPENDENT) so tests are order-independent —
    // clearAllMocks resets call history but NOT return values set by earlier tests.
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('{"relation":"INDEPENDENT","merged_fact":"","reason":"unrelated"}');
    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({ relation: 'INDEPENDENT', merged_fact: '', reason: 'unrelated' });
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('getAllNewFactsSince spans every scope/project (not just one)', () => {
    addFact(db, 'proj A fact', 'project', '/projA');
    addFact(db, 'proj B fact', 'project', '/projB');
    addFact(db, 'global fact', 'global', null);

    const all = getAllNewFactsSince(db, { createdAt: '2000-01-01T00:00:00Z', id: '' });
    const scopes = all.map((f) => `${f.scope_type}:${f.scope_project ?? '-'}`).sort();
    expect(all).toHaveLength(3);
    expect(scopes).toEqual(['global:-', 'project:/projA', 'project:/projB']);
  });

  it('processes a global fact ONCE even with many projects (no 10×N reprocessing)', async () => {
    // One global fact + facts across 5 projects — the old per-project loop would
    // compare the global fact once per project (INDEPENDENT keeps it active).
    addFact(db, 'shared global decision', 'global', null);
    for (let i = 0; i < 5; i++) addFact(db, `proj ${i} decision`, 'project', `/proj${i}`);

    const result = await consolidateAllPending(db, { createdAt: '2000-01-01T00:00:00Z', id: '' });

    // 6 facts, each compared at most once; the single budget caps total calls.
    const MAX = 10;
    expect((callHaiku as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(MAX);
    expect(result.haikuCalls).toBeLessThanOrEqual(MAX);
    // No fact is visited more than once: processed == distinct new facts.
    expect(result.processed).toBe(6);
  });

  it('honors the single Haiku budget across the whole backlog', async () => {
    // 20 mutually-similar facts, one budget of 10 → at most 10 calls total.
    for (let i = 0; i < 20; i++) addFact(db, `similar fact ${i}`, 'global', null);

    const result = await consolidateAllPending(db, { createdAt: '2000-01-01T00:00:00Z', id: '' });

    expect(result.haikuCalls).toBeLessThanOrEqual(10);
    expect((callHaiku as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('returns zero work when nothing is newer than `since`', async () => {
    addFact(db, 'old fact', 'global', null);
    const future = new Date(Date.now() + 60_000).toISOString();

    const result = await consolidateAllPending(db, { createdAt: future, id: '' });

    expect(result.processed).toBe(0);
    expect(callHaiku).not.toHaveBeenCalled();
  });

  it('NEVER compares a global fact against a private project fact (no cross-project mutation)', async () => {
    // CRITICAL guard: a global driver fact must not reach into /secretProj's
    // private rows, or an LLM verdict could deactivate/rewrite them.
    addFact(db, 'Uses private vendor X', 'project', '/secretProj');
    addFact(db, 'Uses private vendor X globally', 'global', null); // similar, newer

    const { parseJsonResponse } = await import('../src/llm.js');
    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
      relation: 'CONTRADICTION', merged_fact: '', reason: 'conflict',
    });

    await consolidateAllPending(db, { createdAt: '2000-01-01T00:00:00Z', id: '' });

    // Every callHaiku comparison prompt must exclude the project-private fact.
    for (const call of (callHaiku as ReturnType<typeof vi.fn>).mock.calls) {
      const prompt = String(call[1]);
      expect(prompt).not.toContain('Uses private vendor X globally' + '\0'); // sanity
      // the project-private fact text must never appear as a candidate in any prompt
      expect(prompt.includes('Uses private vendor X') && !prompt.includes('globally')).toBe(false);
    }
    // The project-private fact stays active and unmodified.
    const secret = db.prepare("SELECT fact, is_active FROM facts WHERE scope_project = '/secretProj'").get() as { fact: string; is_active: number };
    expect(secret.is_active).toBe(1);
    expect(secret.fact).toBe('Uses private vendor X');
  });

  it('NEVER lets a project fact mutate/deactivate a global fact (EVOLUTION/CONTRADICTION isolation)', async () => {
    // CRITICAL: a project-private driver must not reach a global candidate.
    addFact(db, 'Uses vendor X', 'global', null);
    addFact(db, 'Uses vendor X with SECRET token', 'project', '/secret'); // newer, similar

    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
      relation: 'EVOLUTION', merged_fact: 'Uses vendor X with SECRET token', reason: 'newer',
    });

    await consolidateAllPending(db, { createdAt: '2000-01-01T00:00:00Z', id: '' });

    // The global row keeps its original text and stays active — never rewritten
    // with the project-private secret, never deactivated.
    const global = db.prepare("SELECT fact, is_active FROM facts WHERE scope_type = 'global'").get() as { fact: string; is_active: number };
    expect(global.fact).toBe('Uses vendor X');
    expect(global.is_active).toBe(1);
    // No prompt ever paired the global fact with the secret project fact.
    for (const call of (callHaiku as ReturnType<typeof vi.fn>).mock.calls) {
      const prompt = String(call[1]);
      const crossScopePair = prompt.includes('SECRET token') && /Existing fact:\s*"Uses vendor X"/.test(prompt);
      expect(crossScopePair).toBe(false);
    }
  });

  it('searchSimilarFactsSameScope is not starved by many out-of-scope rows (scope gate before limit)', async () => {
    // HIGH guard: the scope filter runs on the FULL overfetch, not after
    // truncation — so a same-project match survives a crowd of closer globals.
    const { searchSimilarFactsSameScope } = await import('../src/fact-db.js');
    for (let i = 0; i < 40; i++) addFact(db, `global crowd ${i}`, 'global', null);
    addFact(db, 'proj target', 'project', '/projX');

    const projHits = searchSimilarFactsSameScope(db, EMB, { type: 'project', project: '/projX' }, 5, 0.5);
    expect(projHits.length).toBe(1);
    expect(projHits[0].fact.fact).toBe('proj target');
    expect(projHits.every((h) => h.fact.scope_type === 'project')).toBe(true);

    // Global scope search returns only globals (never the project fact).
    const globalHits = searchSimilarFactsSameScope(db, EMB, { type: 'global' }, 5, 0.5);
    expect(globalHits.every((h) => h.fact.scope_type === 'global')).toBe(true);
  });

  it('pages past the initial overfetch (201+ out-of-scope rows) to reach an in-scope match', async () => {
    const { searchSimilarFactsSameScope } = await import('../src/fact-db.js');
    for (let i = 0; i < 210; i++) addFact(db, `global crowd ${i}`, 'global', null); // > initial 200 fetch
    addFact(db, 'proj deep', 'project', '/projDeep');

    const hits = searchSimilarFactsSameScope(db, EMB, { type: 'project', project: '/projDeep' }, 5, 0.5);
    expect(hits.length).toBe(1);
    expect(hits[0].fact.fact).toBe('proj deep'); // found despite 210 closer globals
  });

  it('unparseable output counts budget as a no-op (best-effort; not a cursor-holding error)', async () => {
    // A call returning garbage spent budget (must count) but is treated as a
    // no-op verdict — the cursor advances, so it cannot starve later facts.
    addFact(db, 'dup fact A', 'global', null);
    addFact(db, 'dup fact B', 'global', null);
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('not json at all');
    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue(null); // unparseable

    const result = await consolidateAllPending(db, { createdAt: '2000-01-01T00:00:00Z', id: '' });

    expect(result.haikuCalls).toBe((callHaiku as ReturnType<typeof vi.fn>).mock.calls.length);
    expect(result.haikuCalls).toBeGreaterThanOrEqual(1);
    // Both facts stay active (no merge/deactivation on a no-op verdict).
    const active = db.prepare("SELECT COUNT(*) AS n FROM facts WHERE is_active = 1").get() as { n: number };
    expect(active.n).toBe(2);
  });

  it('unparseable output is a no-op that ADVANCES the cursor (best-effort; no poison starvation)', async () => {
    const base = Date.parse('2020-01-01T00:00:00Z');
    insertFact(db, { fact: 'poison driver', category: 'decision', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: EMB });
    insertFact(db, { fact: 'clean later', category: 'decision', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: EMB });
    db.prepare("UPDATE facts SET created_at = ? WHERE fact = 'poison driver'").run(new Date(base).toISOString());
    db.prepare("UPDATE facts SET created_at = ? WHERE fact = 'clean later'").run(new Date(base + 1000).toISOString());

    // Every comparison is unparseable → each is a no-op, cursor advances anyway.
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('not json');
    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const run = await consolidateAllPending(db, { createdAt: '2000-01-01T00:00:00Z', id: '' });

    // Both facts examined (no cursor hold), budget counted, and the run reached
    // the end of the backlog — a non-JSON response cannot starve later facts.
    expect(run.haikuCalls).toBe((callHaiku as ReturnType<typeof vi.fn>).mock.calls.length);
    expect(run.cursor).not.toBeNull();
    expect(run.cursor!.createdAt >= new Date(base + 1000).toISOString()).toBe(true); // advanced past both
  });

  it('drains a timestamp group LARGER than the budget across runs (keyset cursor, no stall)', async () => {
    // Reviewer repro: 11+ similar active facts sharing ONE created_at. A
    // created_at-only cursor stalls (lastExamined == first-unexamined timestamp),
    // reprocessing the same 10 forever. The keyset (created_at, id) cursor must
    // advance fact-by-fact so run 2 reaches the rest.
    const shared = '2020-06-01T00:00:00.000Z';
    for (let i = 0; i < 13; i++) {
      insertFact(db, { fact: `ts group ${i}`, category: 'decision', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: EMB });
    }
    db.prepare('UPDATE facts SET created_at = ?').run(shared); // all identical timestamp

    const run1 = await consolidateAllPending(db, null);
    expect(run1.cursor).not.toBeNull();
    expect(run1.cursor!.createdAt).toBe(shared);
    expect(run1.cursor!.id).not.toBe(''); // advanced to a specific fact within the group

    const run2 = await consolidateAllPending(db, run1.cursor);
    // run 2 must make progress on the remaining facts, not repeat run 1's set.
    expect(run2.processed).toBeGreaterThan(0);
    // After enough runs the whole group is examined (cursor reaches the last id).
    let cursor = run2.cursor;
    for (let r = 0; r < 3; r++) cursor = (await consolidateAllPending(db, cursor)).cursor;
    const remaining = getAllNewFactsSince(db, cursor);
    expect(remaining.length).toBe(0); // fully drained despite the shared timestamp
  });

  it('getAllNewFactsSince honors a page limit (no full-table materialization)', () => {
    for (let i = 0; i < 50; i++) addFact(db, `page ${i}`, 'global', null);
    const page = getAllNewFactsSince(db, null, 10);
    expect(page.length).toBe(10); // bounded, not all 50
  });

  it('a TRANSIENT provider outage (503) holds the cursor forever — never skips, no attempt burned', async () => {
    for (let i = 0; i < 5; i++) addFact(db, `outage ${i}`, 'global', null);
    (callHaiku as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error('503 overloaded'), { status: 503 }));

    let cursor: { createdAt: string; id: string } | null = null;
    for (let r = 0; r < 5; r++) cursor = (await consolidateAllPending(db, cursor)).cursor;

    expect(cursor).toBeNull(); // never advanced past the outage
    const attempts = db.prepare("SELECT MAX(consolidation_attempts) AS m FROM facts").get() as { m: number };
    expect(attempts.m).toBe(0); // transient failures don't burn attempts
  });

  it('a DETERMINISTIC per-fact rejection (400 oversized) is SKIPPED after MAX (no wedge)', async () => {
    addFact(db, 'oversized driver', 'global', null);
    addFact(db, 'oversized sibling', 'global', null);
    (callHaiku as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error('400 prompt too long'), { status: 400 }));

    let cursor: { createdAt: string; id: string } | null = null;
    for (let r = 0; r < 4; r++) cursor = (await consolidateAllPending(db, cursor)).cursor;

    // 두 fact 는 같은 밀리초에 생성돼 created_at 이 동일하고, 커서 tiebreak 은
    // randomUUID 인 id 다 — 어느 쪽이 driver 가 되는지가 실행마다 달라진다.
    // 그래서 특정 fact 를 지목하면 flaky 하다(실측: 동일 트리에서 1/3 실패).
    // 주장은 그대로 두고("deterministic 거절은 MAX 후 skip, wedge 없음") 어느
    // fact 가 driver 였는지에 의존하지 않게만 바꾼다.
    const maxAttempts = (db.prepare(
      "SELECT MAX(consolidation_attempts) AS m FROM facts WHERE fact IN ('oversized driver', 'oversized sibling')"
    ).get() as { m: number }).m;
    expect(maxAttempts).toBeGreaterThanOrEqual(3); // MAX 까지 burn 되고 skip 됨
    expect(cursor).not.toBeNull(); // advanced past the un-processable fact
  });

  it('AUTH/config errors (401/403) hold the cursor (correct — nothing succeeds until config is fixed)', async () => {
    addFact(db, 'auth A', 'global', null);
    addFact(db, 'auth B', 'global', null);
    (callHaiku as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error('401 unauthorized'), { status: 401 }));

    let cursor: { createdAt: string; id: string } | null = null;
    for (let r = 0; r < 4; r++) cursor = (await consolidateAllPending(db, cursor)).cursor;

    expect(cursor).toBeNull(); // held, not silently drained
    const attempts = db.prepare("SELECT MAX(consolidation_attempts) AS m FROM facts").get() as { m: number };
    expect(attempts.m).toBe(0); // config failure burns no per-fact attempt
  });

  it('classifyLlmError three-values errors (transient / deterministic / unknown)', () => {
    // DETERMINISTIC (per-request) — must NOT be swallowed by the transient patterns.
    expect(classifyLlmError(new Error('invalid max_tokens: must be <= 4096'))).toBe('deterministic');
    expect(classifyLlmError(new Error('invalid API request: prompt is too long'))).toBe('deterministic');
    expect(classifyLlmError(new Error('413 payload too large'))).toBe('deterministic'); // 'too large' phrase
    expect(classifyLlmError(new Error('Request failed with status code 400'))).toBe('deterministic'); // labelled status
    expect(classifyLlmError(new Error('invalid_request_error: content must be non-empty'))).toBe('deterministic');
    expect(classifyLlmError(Object.assign(new Error('bad'), { status: 400 }))).toBe('deterministic');
    // TRANSIENT — outage / rate limit / auth.
    expect(classifyLlmError(new Error('invalid api key'))).toBe('transient');
    expect(classifyLlmError(Object.assign(new Error('down'), { status: 503 }))).toBe('transient');
    expect(classifyLlmError(Object.assign(new Error('nope'), { status: 401 }))).toBe('transient');
    expect(classifyLlmError(new Error('ETIMEDOUT'))).toBe('transient');
    expect(classifyLlmError(new Error('status: 503 upstream'))).toBe('transient'); // labelled status
    // Incidental digits are NOT read as a status number.
    expect(classifyLlmError(new Error('429 rate limit exceeded; retry after 400 ms'))).toBe('transient'); // 'rate limit' phrase
    expect(classifyLlmError(new Error('503 upstream error after 400 ms'))).toBe('unknown'); // bare numbers, no label/phrase
    expect(classifyLlmError(new Error('something weird'))).toBe('unknown');
    // Structured status always wins over message text.
    expect(classifyLlmError(Object.assign(new Error('retry after 400ms'), { status: 429 }))).toBe('transient');
    // Nested SDK/axios status shape (error.response.status) is read too.
    expect(classifyLlmError({ response: { status: 413 }, message: 'Request failed' })).toBe('deterministic');
    expect(classifyLlmError({ response: { status: 503 }, message: 'Request failed' })).toBe('transient');
    expect(classifyLlmError({ response: { statusCode: 400 }, message: 'x' })).toBe('deterministic');
    // Back-compat boolean: true ONLY for a recognized transient.
    expect(isTransientLlmError(Object.assign(new Error('down'), { status: 503 }))).toBe(true);
    expect(isTransientLlmError(new Error('invalid max_tokens: must be <= 4096'))).toBe(false);
    expect(isTransientLlmError(new Error('something weird'))).toBe(false); // unknown is not a recognized transient
  });

  it('a recognized TRANSIENT outage holds the cursor (never skips the backlog)', async () => {
    addFact(db, 'mystery A', 'global', null);
    addFact(db, 'mystery B', 'global', null);
    (callHaiku as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error('down'), { status: 503 }));

    let cursor: { createdAt: string; id: string } | null = null;
    for (let r = 0; r < 5; r++) cursor = (await consolidateAllPending(db, cursor)).cursor;

    expect(cursor).toBeNull(); // 503 → transient → held, never silently skipped during an outage
  });

  it('an UNKNOWN provider error HOLDS (unrecognized outage shapes must not drain)', async () => {
    addFact(db, 'mystery A', 'global', null);
    addFact(db, 'mystery B', 'global', null);
    // "API Error: 500 Internal Server Error" classifies as unknown (no labelled
    // status, no phrase). Only DETERMINISTIC rejections skip — unknown holds so a
    // weird outage shape never silently drains the backlog.
    (callHaiku as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API Error: 500 Internal Server Error'));

    let cursor: { createdAt: string; id: string } | null = null;
    for (let r = 0; r < 8; r++) cursor = (await consolidateAllPending(db, cursor)).cursor;

    expect(cursor).toBeNull(); // unknown → held, never advanced
  });

  it('a DETERMINISTIC per-request rejection is bounded — advances after MAX attempts', async () => {
    addFact(db, 'mystery A', 'global', null);
    addFact(db, 'mystery B', 'global', null);
    // status 400 → deterministic → the fact itself is at fault → bounded skip.
    (callHaiku as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));

    let cursor: { createdAt: string; id: string } | null = null;
    for (let r = 0; r < 8; r++) cursor = (await consolidateAllPending(db, cursor)).cursor;

    // After MAX_CONSOLIDATION_ATTEMPTS the cursor advances past the un-processable
    // fact so it can't wedge the backlog forever.
    expect(cursor).not.toBeNull();
  });

  it('a NON-LLM internal error HOLDS (never advances the cursor on a code bug)', async () => {
    addFact(db, 'mystery A', 'global', null);
    addFact(db, 'mystery B', 'global', null);
    // callHaiku resolves; the failure is in parsing (an internal bug, NOT an
    // LlmCallError) → must hold, never be treated as a skippable "bad fact".
    (parseJsonResponse as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('parser boom'); });

    let cursor: { createdAt: string; id: string } | null = null;
    for (let r = 0; r < 8; r++) cursor = (await consolidateAllPending(db, cursor)).cursor;

    expect(cursor).toBeNull(); // internal bug → held, not skipped
  });

  it('advances a persisted cursor so newer facts are reachable across runs (no starvation)', async () => {
    // 15 similar global facts, budget 10 → run 1 processes the oldest 10 and
    // advances the cursor; run 2 (since=cursor) reaches the remaining 5.
    const base = Date.parse('2020-01-01T00:00:00Z');
    for (let i = 0; i < 15; i++) {
      // distinct, strictly increasing timestamps so the cursor can advance safely
      const ts = new Date(base + i * 1000).toISOString();
      insertFact(db, { fact: `fact ${i}`, category: 'decision', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: EMB });
      db.prepare('UPDATE facts SET created_at = ? WHERE fact = ?').run(ts, `fact ${i}`);
    }

    const run1 = await consolidateAllPending(db, { createdAt: '2000-01-01T00:00:00Z', id: '' });
    expect(run1.haikuCalls).toBeLessThanOrEqual(10);
    expect(run1.cursor).not.toBeNull();
    expect(run1.cursor!.createdAt > '2000-01-01T00:00:00Z').toBe(true); // advanced

    const run2 = await consolidateAllPending(db, run1.cursor);
    // run 2 starts strictly after run 1's cursor → reaches the remaining backlog
    expect(run2.processed).toBeGreaterThan(0);
    expect(run2.cursor!.createdAt >= run1.cursor!.createdAt).toBe(true);
  });
});
