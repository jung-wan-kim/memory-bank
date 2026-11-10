import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';
import type { ConversationExchange } from '../src/types.js';

/**
 * verify / repair must never treat "I did not list it" as "it is gone", never
 * delete without being asked, and never start a large job without saying so.
 * Measured on one live index (2026-11-10): `--repair` judged 131,380 rows
 * (38%) orphaned — 121,971 of them had their file on disk, in a sub-folder the
 * listing does not descend into — and planned 262,662 summary calls.
 */

const calls = { summaries: 0, embeddings: 0 };
vi.mock('../src/summarizer.js', () => ({
  REFUSED_SUMMARY: '[No summary: the model declined to summarize this conversation.]',
  summarizeConversation: async () => { calls.summaries++; return 'A summary.'; },
}));
vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();
  return {
    ...actual,
    initEmbeddings: async () => {},
    generateExchangeEmbedding: async () => { calls.embeddings++; return new Array(384).fill(0.01); },
    generateEmbedding: async () => new Array(384).fill(0.01),
  };
});

const EMB = new Array(384).fill(0.01);
const line = (type: 'user' | 'assistant', content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, message: { role: type, content }, timestamp: '2026-11-01T00:00:00Z', ...extra });
const conversation = (question: string, answer = 'An answer.') => [line('user', question), line('assistant', answer)].join('\n');

let testDir: string;
let archiveDir: string;
let restoreConsole: () => void;
// The runner's own MEMORY_BANK_CONFIG_DIR (it keeps tests off the real config dir) is put back, not deleted.
const outerConfigDir = process.env.MEMORY_BANK_CONFIG_DIR;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-verify-safety-'));
  archiveDir = path.join(testDir, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  process.env.TEST_PROJECTS_DIR = path.join(testDir, 'projects');
  process.env.TEST_ARCHIVE_DIR = archiveDir;
  process.env.TEST_DB_PATH = path.join(testDir, 'db.sqlite');
  process.env.MEMORY_BANK_CONFIG_DIR = path.join(testDir, 'cfg');
  calls.summaries = 0;
  calls.embeddings = 0;
  restoreConsole = suppressConsole();
});
afterEach(() => {
  restoreConsole();
  delete process.env.TEST_PROJECTS_DIR;
  delete process.env.TEST_ARCHIVE_DIR;
  delete process.env.TEST_DB_PATH;
  if (outerConfigDir === undefined) delete process.env.MEMORY_BANK_CONFIG_DIR;
  else process.env.MEMORY_BANK_CONFIG_DIR = outerConfigDir;
  fs.rmSync(testDir, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const p = path.join(archiveDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

async function insertRow(id: string, archivePath: string, lineStart = 1, toolCalls = 0): Promise<void> {
  const { initDatabase, insertExchange } = await import('../src/db.js');
  const db = initDatabase();
  try {
    const exchange: ConversationExchange = {
      id, project: 'proj', timestamp: '2026-11-01T00:00:00Z', userMessage: `q ${id}`, assistantMessage: `a ${id}`,
      archivePath, lineStart, lineEnd: lineStart + 1,
      toolCalls: Array.from({ length: toolCalls }, (_, i) => ({
        id: `${id}:${i}`, exchangeId: id, toolName: 'Read', isError: false, timestamp: '2026-11-01T00:00:01Z',
      })),
    };
    insertExchange(db, exchange, EMB);
  } finally {
    db.close();
  }
}

/** Every user table's row count plus a digest of the exchange ids — what a run that "changes nothing" must leave equal. */
async function fingerprint(): Promise<string> {
  const db = new Database(process.env.TEST_DB_PATH!, { readonly: true });
  try {
    const out: Record<string, unknown> = {};
    for (const t of ['exchanges', 'tool_calls', 'vec_exchanges_rowids', 'facts']) {
      out[t] = (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    }
    out.ids = (db.prepare('SELECT id, last_indexed FROM exchanges ORDER BY id').all());
    return JSON.stringify(out);
  } finally {
    db.close();
  }
}

describe('verifyIndex: a row is orphaned only when its file is really gone', () => {
  it('rows whose file sits in a sub-folder of the project are not orphaned', async () => {
    const { verifyIndex } = await import('../src/verify.js');
    const deep = write('proj/session-1/subagents/agent-a1.jsonl', conversation('sub-agent task'));
    const deeper = write('proj/session-1/subagents/more/agent-a2.jsonl', conversation('another task'));
    await insertRow('deep-1', deep);
    await insertRow('deep-2', deeper);

    const result = await verifyIndex();
    expect(result.orphaned).toEqual([]);
    expect(result.totals.exchanges).toBe(2);
  });

  it('a file that exists only compressed (.jsonl.zst) is not orphaned; a file that is gone is', async () => {
    const { verifyIndex } = await import('../src/verify.js');
    const compressed = path.join(archiveDir, 'proj', 'old.jsonl');
    fs.mkdirSync(path.dirname(compressed), { recursive: true });
    fs.writeFileSync(compressed + '.zst', 'compressed bytes');
    const gone = path.join(archiveDir, 'proj', 'session-9', 'subagents', 'agent-gone.jsonl');
    await insertRow('zst-1', compressed);
    await insertRow('gone-1', gone);
    await insertRow('gone-2', gone, 3);

    const result = await verifyIndex();
    expect(result.orphaned.map((o) => o.uuid).sort()).toEqual(['gone-1', 'gone-2']);
    expect(new Set(result.orphaned.map((o) => o.path))).toEqual(new Set([gone]));
  });
});

describe('verifyIndex: "no summary" and "not indexed" are different findings', () => {
  it('an indexed conversation without a summary is missingSummary only; an unindexed one with a summary is notIndexed only', async () => {
    const { verifyIndex } = await import('../src/verify.js');
    const { parseConversation } = await import('../src/parser.js');
    const { initDatabase, insertExchange } = await import('../src/db.js');

    const indexedNoSummary = write('proj/indexed.jsonl', conversation('indexed question'));
    const db = initDatabase();
    for (const ex of await parseConversation(indexedNoSummary, 'proj', indexedNoSummary)) insertExchange(db, ex, EMB);
    db.close();

    const summarizedNotIndexed = write('proj/summarized.jsonl', conversation('summarized question'));
    fs.writeFileSync(summarizedNotIndexed.replace('.jsonl', '-summary.txt'), 'has a summary');

    const result = await verifyIndex();
    expect(result.missingSummary).toEqual([{ path: indexedNoSummary }]);
    expect(result.notIndexed).toEqual([{ path: summarizedNotIndexed }]);
    expect(result.outdated).toEqual([]);
    expect(result.totals.conversations).toBe(2);
  });

  it('files a repair would neither index nor summarize are in no list: no exchange, worker prompt, machine noise, exclusion marker', async () => {
    const { verifyIndex } = await import('../src/verify.js');
    const { WORKER_PROMPT_PREFIXES } = await import('../src/paths.js');
    const { EXCLUSION_MARKERS } = await import('../src/conversation-guard.js');
    write('proj/empty.jsonl', line('user', 'a question nobody answered yet'));
    write('proj/worker.jsonl', conversation(`${WORKER_PROMPT_PREFIXES[0]} Extract facts from: ...`));
    write('proj/agent-warm.jsonl', [line('user', 'Warmup', { isSidechain: true }), line('assistant', 'Ready.', { isSidechain: true })].join('\n'));
    write('proj/observer.jsonl', conversation('<observed_from_primary_session>\n<what_happened>…</what_happened>'));
    write('proj/opted-out.jsonl', conversation(`${EXCLUSION_MARKERS[0]}\nSummarize this conversation`));

    const result = await verifyIndex();
    expect(result.missingSummary).toEqual([]);
    expect(result.notIndexed).toEqual([]);
    expect(result.corrupted).toEqual([]);
    expect(result.totals.conversations).toBe(5);
  });

  it('a file that cannot be read is reported as unreadable and concluded nothing else about', async () => {
    const { verifyIndex } = await import('../src/verify.js');
    const bad = path.join(archiveDir, 'proj', 'bad.jsonl');
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    fs.writeFileSync(bad + '.zst', 'this is not zstd data');

    const result = await verifyIndex();
    expect(result.corrupted.map((c) => c.path)).toEqual([bad]);
    expect(result.corrupted[0].error).not.toBe('');
    expect(result.notIndexed).toEqual([]);
    expect(result.missingSummary).toEqual([]);
  });

  it('a file touched after indexing whose exchanges are all in the index is not outdated', async () => {
    const { verifyIndex } = await import('../src/verify.js');
    const { parseConversation } = await import('../src/parser.js');
    const { initDatabase, insertExchange } = await import('../src/db.js');
    const file = write('proj/grown.jsonl', conversation('a question'));
    fs.writeFileSync(file.replace('.jsonl', '-summary.txt'), 'summary');
    const db = initDatabase();
    for (const ex of await parseConversation(file, 'proj', file)) insertExchange(db, ex, EMB);
    db.close();

    // one more line that forms no exchange (a user message with no answer yet), written later
    fs.appendFileSync(file, '\n' + line('user', 'a follow-up with no answer yet'));
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);

    const result = await verifyIndex();
    expect(result.outdated).toEqual([]);
    expect(result.notIndexed).toEqual([]);
  });
});

describe('repairIndex: deletes only on request, after a backup', () => {
  it('rows whose file is gone are kept by default', async () => {
    const { verifyIndex, repairIndex } = await import('../src/verify.js');
    await insertRow('gone-1', path.join(archiveDir, 'proj', 'gone.jsonl'), 1, 2);
    const before = await fingerprint();

    const issues = await verifyIndex();
    expect(issues.orphaned).toHaveLength(1);
    const outcome = await repairIndex(issues);

    expect(outcome.deletedRows).toBe(0);
    expect(outcome.backupPath).toBeNull();
    expect(await fingerprint()).toBe(before);
  });

  it('pruneMissing backs the rows up (exchanges + tool calls) and then deletes them', async () => {
    const { verifyIndex, repairIndex } = await import('../src/verify.js');
    const kept = write('proj/kept.jsonl', conversation('kept'));
    fs.writeFileSync(kept.replace('.jsonl', '-summary.txt'), 'summary');
    await insertRow('gone-1', path.join(archiveDir, 'proj', 'gone.jsonl'), 1, 2);
    await insertRow('gone-2', path.join(archiveDir, 'proj', 'gone.jsonl'), 3, 1);
    await insertRow('deep-1', write('proj/s/subagents/agent-1.jsonl', conversation('deep')), 1, 1);

    const issues = await verifyIndex();
    const outcome = await repairIndex(issues, { pruneMissing: true });

    expect(outcome.deletedRows).toBe(2);
    expect(outcome.backupPath).not.toBeNull();
    const bak = new Database(outcome.backupPath!, { readonly: true });
    try {
      expect(bak.prepare('SELECT id, user_message FROM exchanges ORDER BY id').all())
        .toEqual([{ id: 'gone-1', user_message: 'q gone-1' }, { id: 'gone-2', user_message: 'q gone-2' }]);
      expect((bak.prepare('SELECT count(*) AS n FROM tool_calls').get() as { n: number }).n).toBe(3);
    } finally {
      bak.close();
    }
    const db = new Database(process.env.TEST_DB_PATH!, { readonly: true });
    try {
      const ids = (db.prepare('SELECT id FROM exchanges ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain('deep-1');
      expect(ids).not.toContain('gone-1');
      expect(ids).not.toContain('gone-2');
      expect(db.prepare('SELECT DISTINCT exchange_id FROM tool_calls ORDER BY 1').all()).toEqual([{ exchange_id: 'deep-1' }]);
    } finally {
      db.close();
    }
  });

  it('a file that is back when the repair runs keeps its rows', async () => {
    const { verifyIndex, repairIndex } = await import('../src/verify.js');
    const file = path.join(archiveDir, 'proj', 'back.jsonl');
    await insertRow('back-1', file);
    const issues = await verifyIndex();
    expect(issues.orphaned).toHaveLength(1);

    write('proj/back.jsonl', conversation('it is back'));
    const outcome = await repairIndex(issues, { pruneMissing: true });
    expect(outcome.deletedRows).toBe(0);
    expect(outcome.backupPath).toBeNull();
    const db = new Database(process.env.TEST_DB_PATH!, { readonly: true });
    try {
      expect((db.prepare(`SELECT count(*) AS n FROM exchanges WHERE id = 'back-1'`).get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('repairIndex: re-indexing goes through the same guards as sync', () => {
  it('worker prompts, machine noise and marked conversations handed to repair are not indexed or summarized', async () => {
    const { repairIndex } = await import('../src/verify.js');
    const { WORKER_PROMPT_PREFIXES } = await import('../src/paths.js');
    const { EXCLUSION_MARKERS } = await import('../src/conversation-guard.js');
    const worker = write('proj/worker.jsonl', conversation(`${WORKER_PROMPT_PREFIXES[0]} Extract facts from: ...`));
    const warm = write('proj/agent-warm.jsonl', [line('user', 'Warmup', { isSidechain: true }), line('assistant', 'Ready.', { isSidechain: true })].join('\n'));
    const marked = write('proj/marked.jsonl', conversation(`${EXCLUSION_MARKERS[0]}\nSummarize this conversation`));
    const real = write('proj/real.jsonl', [
      line('user', `${WORKER_PROMPT_PREFIXES[1]} classify this`), line('assistant', 'classified'),
      line('user', 'a real question'), line('assistant', 'a real answer'),
    ].join('\n'));
    const paths = [worker, warm, marked, real];

    // A caller-built list (an older verify listed exactly these): repair must still refuse them.
    const outcome = await repairIndex({
      missingSummary: paths.map((p) => ({ path: p })),
      notIndexed: paths.map((p) => ({ path: p })),
      orphaned: [], outdated: [], corrupted: [],
      totals: { exchanges: 0, conversations: 4 },
    });

    const db = new Database(process.env.TEST_DB_PATH!, { readonly: true });
    try {
      expect(db.prepare('SELECT user_message, archive_path FROM exchanges').all())
        .toEqual([{ user_message: 'a real question', archive_path: real }]);
    } finally {
      db.close();
    }
    expect(calls.embeddings).toBe(1);
    expect(calls.summaries).toBe(1);
    expect(fs.existsSync(real.replace('.jsonl', '-summary.txt'))).toBe(true);
    for (const p of [worker, warm, marked]) expect(fs.existsSync(p.replace('.jsonl', '-summary.txt')), p).toBe(false);
    expect(outcome.skippedFiles).toBe(3);
    expect(outcome.reindexedFiles).toBe(1);
  });

  it('a conversation of an excluded project handed to repair is left alone', async () => {
    const { repairIndex } = await import('../src/verify.js');
    const file = write('secret-project/c.jsonl', conversation('a private question'));
    process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS = 'secret-project';
    try {
      const outcome = await repairIndex({
        missingSummary: [{ path: file }], notIndexed: [{ path: file }], orphaned: [], outdated: [], corrupted: [],
        totals: { exchanges: 0, conversations: 1 },
      });
      expect(outcome.skippedFiles).toBe(1);
    } finally {
      delete process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS;
    }
    expect(calls.embeddings).toBe(0);
    expect(calls.summaries).toBe(0);
  });

  it('noSummaries makes no summary call; a conversation that only lacks a summary is summarized without being re-embedded', async () => {
    const { verifyIndex, repairIndex } = await import('../src/verify.js');
    const { parseConversation } = await import('../src/parser.js');
    const { initDatabase, insertExchange } = await import('../src/db.js');
    const indexed = write('proj/indexed.jsonl', conversation('indexed question'));
    const db = initDatabase();
    for (const ex of await parseConversation(indexed, 'proj', indexed)) insertExchange(db, ex, EMB);
    db.close();
    write('proj/new.jsonl', conversation('new question'));

    const issues = await verifyIndex();
    await repairIndex(issues, { noSummaries: true });
    expect(calls.summaries).toBe(0);
    expect(calls.embeddings).toBe(1); // only the conversation that was not indexed

    calls.embeddings = 0;
    await repairIndex(await verifyIndex());
    expect(calls.summaries).toBe(2);
    expect(calls.embeddings).toBe(0);
  });
});

describe('repairIndex: the plan comes first, and a large one needs --yes', () => {
  const issuesOf = (o: Partial<import('../src/verify.js').VerificationResult>): import('../src/verify.js').VerificationResult => ({
    missingSummary: [], notIndexed: [], orphaned: [], outdated: [], corrupted: [], totals: { exchanges: 0, conversations: 0 }, ...o,
  });
  const paths = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ path: `/arch/p/${prefix}${i}.jsonl` }));

  it('planRepair counts rows, files and LLM calls, and names every count over 5% (and over 20)', async () => {
    const { planRepair } = await import('../src/verify.js');
    const orphaned = Array.from({ length: 60 }, (_, i) => ({ uuid: `o${i}`, path: '/arch/p/gone.jsonl' }));
    const base = issuesOf({
      orphaned, notIndexed: paths(30, 'n'), missingSummary: [...paths(30, 'n'), ...paths(25, 'm')],
      outdated: [{ path: '/arch/p/n0.jsonl', fileTime: 2, dbTime: 1 }, { path: '/arch/p/out.jsonl', fileTime: 2, dbTime: 1 }],
      totals: { exchanges: 1000, conversations: 400 },
    });

    const reportOnly = planRepair(base);
    expect(reportOnly.missingFileRows).toBe(60);
    expect(reportOnly.deleteRows).toBe(0);
    expect(reportOnly.reindexFiles).toBe(31); // 30 not indexed + 1 outdated that is not among them
    expect(reportOnly.summaryCalls).toBe(56); // 55 without a summary + 1 outdated that is not among them
    expect(reportOnly.overThreshold).toHaveLength(2); // 31 and 56 are both over max(20, 5% of 400 = 20)
    expect(reportOnly.overThreshold.join('\n')).toMatch(/conversations to re-index: 31 is over 20/);
    expect(reportOnly.overThreshold.join('\n')).toMatch(/summary \(LLM\) calls: 56 is over 20/);

    const prune = planRepair(base, { pruneMissing: true, noSummaries: true });
    expect(prune.deleteRows).toBe(60);
    expect(prune.summaryCalls).toBe(0);
    expect(prune.overThreshold.join('\n')).toMatch(/rows to delete: 60 is over 50 \(5% of 1000/);
  });

  it('a small index is not held up: counts at or under 20 never need --yes', async () => {
    const { planRepair } = await import('../src/verify.js');
    const plan = planRepair(issuesOf({
      orphaned: Array.from({ length: 20 }, (_, i) => ({ uuid: `o${i}`, path: '/arch/p/gone.jsonl' })),
      notIndexed: paths(20, 'n'), missingSummary: paths(20, 'n'),
      totals: { exchanges: 20, conversations: 20 },
    }), { pruneMissing: true });
    expect(plan.overThreshold).toEqual([]);
  });

  it('over the threshold without yes: stops before changing anything — no delete, no backup, no embedding, no summary', async () => {
    const { verifyIndex, repairIndex, RepairAbortedError } = await import('../src/verify.js');
    for (let i = 0; i < 25; i++) write(`proj/c${i}.jsonl`, conversation(`question ${i}`));
    await insertRow('gone-1', path.join(archiveDir, 'proj', 'gone.jsonl'), 1, 1);
    const before = await fingerprint();

    const issues = await verifyIndex();
    expect(issues.notIndexed).toHaveLength(25);
    let thrown: unknown;
    try { await repairIndex(issues, { pruneMissing: true }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(RepairAbortedError);
    expect((thrown as Error).message).toMatch(/conversations to re-index: 25 is over 20/);
    expect((thrown as Error).message).toMatch(/--yes/);

    expect(await fingerprint()).toBe(before);
    expect(calls.embeddings).toBe(0);
    expect(calls.summaries).toBe(0);
    expect(fs.existsSync(path.join(process.env.MEMORY_BANK_CONFIG_DIR!, 'conversation-index', 'backups'))).toBe(false);
    expect(fs.readdirSync(path.join(archiveDir, 'proj')).filter((f) => f.endsWith('-summary.txt'))).toEqual([]);
  });

  it('the same plan with yes runs', async () => {
    const { verifyIndex, repairIndex } = await import('../src/verify.js');
    for (let i = 0; i < 25; i++) write(`proj/c${i}.jsonl`, conversation(`question ${i}`));
    const outcome = await repairIndex(await verifyIndex(), { yes: true });
    expect(outcome.reindexedFiles).toBe(25);
    expect(outcome.indexedExchanges).toBe(25);
    expect(calls.summaries).toBe(25);
    const after = await verifyIndex();
    expect(after.notIndexed).toEqual([]);
    expect(after.missingSummary).toEqual([]);
  });
});
