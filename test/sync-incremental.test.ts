import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';

/**
 * What a sync does to a conversation it has already seen, and which
 * conversations it leaves out. Measured on one live index (2026-11-10): every
 * sync re-embedded and re-wrote every exchange of a file that had grown
 * (1,657 rows rewritten in a day for 25 new exchanges); a marker inside tool
 * OUTPUT dropped the whole session; 9 of 10 summary slots went to files with
 * nothing to summarize.
 */

const calls = { embeddings: [] as string[], summaries: [] as string[] };
vi.mock('../src/summarizer.js', () => ({
  REFUSED_SUMMARY: '[No summary: the model declined to summarize this conversation.]',
  summarizeConversation: async (exchanges: Array<{ userMessage: string }>) => {
    calls.summaries.push(exchanges.map((e) => e.userMessage).join(' | '));
    return 'A summary.';
  },
}));
vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();
  return {
    ...actual,
    initEmbeddings: async () => {},
    generateExchangeEmbedding: async (userMessage: string) => { calls.embeddings.push(userMessage); return new Array(384).fill(0.01); },
    generateEmbedding: async () => new Array(384).fill(0.01),
  };
});

const line = (type: 'user' | 'assistant', content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, message: { role: type, content }, timestamp: '2026-11-01T00:00:00Z', ...extra });
const turn = (question: string, answer = `answer to ${question}`) => [line('user', question), line('assistant', answer)];
const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

let testDir: string;
let sourceDir: string;
let destDir: string;
let restoreConsole: () => void;
let clock = Date.now();

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-sync-incr-'));
  sourceDir = path.join(testDir, 'source');
  destDir = path.join(testDir, 'dest');
  fs.mkdirSync(path.join(sourceDir, 'proj'), { recursive: true });
  process.env.TEST_DB_PATH = path.join(testDir, 'db.sqlite');
  calls.embeddings = [];
  calls.summaries = [];
  restoreConsole = suppressConsole();
});
afterEach(() => {
  restoreConsole();
  delete process.env.TEST_DB_PATH;
  fs.rmSync(testDir, { recursive: true, force: true });
});

/** Write a source conversation with an mtime later than every earlier write (sync copies only newer files). */
function writeSource(name: string, lines: string[], project = 'proj'): string {
  const p = path.join(sourceDir, project, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join('\n'));
  clock += 5000;
  fs.utimesSync(p, new Date(clock), new Date(clock));
  return p;
}
function rows(sql = 'SELECT id, user_message, last_indexed FROM exchanges ORDER BY line_start'): Array<Record<string, unknown>> {
  const db = new Database(process.env.TEST_DB_PATH!, { readonly: true });
  try {
    return db.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}
async function sync(options: import('../src/sync.js').SyncOptions = {}) {
  const { syncConversations } = await import('../src/sync.js');
  return syncConversations(sourceDir, destDir, { skipSummaries: true, ...options });
}

describe('sync: an exchange already in the index is not embedded or written again', () => {
  it('re-syncing a file whose exchanges are all indexed makes ZERO embedding calls and rewrites no row', async () => {
    const lines = [...turn('first question'), ...turn('second question')];
    writeSource('a.jsonl', lines);
    const first = await sync();
    expect(first.indexed).toBe(1);
    expect(calls.embeddings).toEqual(['first question', 'second question']);
    const before = rows();
    expect(before).toHaveLength(2);

    // the file changed on disk (a line that forms no exchange) — copied and parsed again
    calls.embeddings = [];
    writeSource('a.jsonl', [...lines, line('user', 'a third question, not answered yet')]);
    const second = await sync();
    expect(second.copied).toBe(1);
    expect(second.errors).toEqual([]);
    expect(calls.embeddings).toEqual([]);
    expect(rows()).toEqual(before); // same ids, same last_indexed: not rewritten
  });

  it('when the file grows by one exchange, exactly that one is embedded', async () => {
    const lines = [...turn('first question'), ...turn('second question')];
    writeSource('a.jsonl', lines);
    await sync();
    const before = rows();

    calls.embeddings = [];
    writeSource('a.jsonl', [...lines, ...turn('third question')]);
    await sync();
    expect(calls.embeddings).toEqual(['third question']);
    const after = rows();
    expect(after.map((r) => r.user_message)).toEqual(['first question', 'second question', 'third question']);
    expect(after.slice(0, 2)).toEqual(before);
  });

  it('a turn whose answer grew is embedded again and replaces its shorter snapshot', async () => {
    writeSource('a.jsonl', [...turn('first question'), line('user', 'long task'), line('assistant', 'working on it')]);
    await sync();
    calls.embeddings = [];
    writeSource('a.jsonl', [...turn('first question'), line('user', 'long task'), line('assistant', 'working on it'), line('assistant', 'done')]);
    await sync();
    expect(calls.embeddings).toEqual(['long task']);
    const after = rows('SELECT user_message, assistant_message, line_start, line_end FROM exchanges ORDER BY line_start');
    expect(after).toEqual([
      { user_message: 'first question', assistant_message: 'answer to first question', line_start: 1, line_end: 2 },
      { user_message: 'long task', assistant_message: 'working on it\n\ndone', line_start: 3, line_end: 5 },
    ]);
  });

  it('an exchange whose vector row is missing is embedded again (the row alone is not "indexed")', async () => {
    writeSource('a.jsonl', turn('first question'));
    await sync();
    const db = new Database(process.env.TEST_DB_PATH!);
    (await import('sqlite-vec')).load(db);
    db.prepare('DELETE FROM vec_exchanges').run();
    db.close();

    calls.embeddings = [];
    writeSource('a.jsonl', [...turn('first question'), line('user', 'pending')]);
    await sync();
    expect(calls.embeddings).toEqual(['first question']);
    expect(rows('SELECT count(*) AS n FROM vec_exchanges_rowids')).toEqual([{ n: 1 }]);
  });
});

describe('sync: exclusion markers are judged on user messages only', () => {
  it('a marker that only appears in tool output or in an assistant message does not drop the session', async () => {
    const { EXCLUSION_MARKERS } = await import('../src/conversation-guard.js');
    writeSource('reads-the-source.jsonl', [
      line('user', 'open src/sync.ts and explain the exclusion list'),
      line('assistant', [{ type: 'text', text: 'Reading the file.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/sync.ts' } }]),
      line('user', [{ type: 'tool_result', tool_use_id: 't1', content: `const EXCLUSION_MARKERS = ['${EXCLUSION_MARKERS[0]}', '${EXCLUSION_MARKERS[1]}'];` }]),
      line('assistant', `The list holds ${EXCLUSION_MARKERS[1]} and two more.`),
    ]);
    const result = await sync();
    expect(result.errors).toEqual([]);
    expect(result.indexed).toBe(1);
    expect(rows('SELECT user_message FROM exchanges')).toEqual([{ user_message: 'open src/sync.ts and explain the exclusion list' }]);
  });

  it('a marker in a user message drops the session — every marker, wherever the message sits, answered or not', async () => {
    const { EXCLUSION_MARKERS } = await import('../src/conversation-guard.js');
    expect(EXCLUSION_MARKERS).toHaveLength(3);
    EXCLUSION_MARKERS.forEach((marker, i) => {
      writeSource(`first-${i}.jsonl`, turn(`${marker}\nSummarize this conversation`));
      writeSource(`later-${i}.jsonl`, [...turn('an ordinary question'), ...turn(`please note: ${marker}`)]);
      // the marked message is never answered (the next user message follows directly) — it ends up in no exchange
      writeSource(`unanswered-${i}.jsonl`, [line('user', `${marker}`), ...turn('an ordinary question')]);
      writeSource(`blocks-${i}.jsonl`, [line('user', [{ type: 'text', text: `prefix ${marker} suffix` }]), line('assistant', 'ok')]);
    });
    writeSource('control.jsonl', turn('a control question'));

    const result = await sync();
    expect(result.copied).toBe(13);
    expect(result.errors).toEqual([]);
    expect(result.indexed).toBe(1);
    expect(rows('SELECT user_message FROM exchanges')).toEqual([{ user_message: 'a control question' }]);
  });

  it('a file that cannot be read is an error and is NOT indexed in this run (never "no marker found")', async () => {
    const src = writeSource('unreadable.jsonl', turn('a question'));
    writeSource('fine.jsonl', turn('a fine question'));
    // A newer compressed copy in the archive wins over the plain copy sync writes — and it is not zstd.
    const dest = path.join(destDir, 'proj', 'unreadable.jsonl');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + '.zst', 'this is not zstd data');
    const soon = new Date(Date.now() + 3_600_000);
    fs.utimesSync(dest + '.zst', soon, soon);
    const later = new Date(Date.now() + 7_200_000);
    fs.utimesSync(src, later, later);

    const result = await sync();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe(dest);
    expect(result.errors[0].error).not.toBe('');
    expect(result.indexed).toBe(1);
    expect(rows('SELECT user_message FROM exchanges')).toEqual([{ user_message: 'a fine question' }]);
  });

  it('parseGuarded rejects for an unreadable file instead of answering "not excluded"', async () => {
    const { parseGuarded } = await import('../src/conversation-guard.js');
    const bad = path.join(testDir, 'bad.jsonl');
    fs.writeFileSync(bad + '.zst', 'this is not zstd data');
    await expect(parseGuarded(bad, 'proj', bad)).rejects.toThrow();
    const missing = path.join(testDir, 'missing.jsonl');
    await expect(parseGuarded(missing, 'proj', missing)).rejects.toThrow(/ENOENT/);
  });
});

describe('sync: machine noise is not indexed', () => {
  it('agent warm-up turns, observer prompts and worker prompts are skipped; what a person wrote is kept', async () => {
    const { WORKER_PROMPT_PREFIXES } = await import('../src/paths.js');
    writeSource('agent-warm.jsonl', [line('user', 'Warmup', { isSidechain: true }), line('assistant', 'Ready.', { isSidechain: true })]);
    writeSource('observer.jsonl', turn('<observed_from_primary_session>\n<what_happened>Read</what_happened>'));
    writeSource('worker.jsonl', turn(`${WORKER_PROMPT_PREFIXES[3]}\nFact A: …`));
    writeSource('human.jsonl', [
      ...turn('Warmup 순서 알려줘'),
      ...turn('Warmup'), // typed by a person on the main chain
      line('user', 'Warmup 뒤에 뭘 하지?', { isSidechain: true }), line('assistant', '스트레칭', { isSidechain: true }),
      ...turn('이 태그는 뭐야: <observed_from_primary_session>'),
    ]);

    const result = await sync();
    expect(result.errors).toEqual([]);
    expect(rows('SELECT user_message FROM exchanges ORDER BY line_start')).toEqual([
      { user_message: 'Warmup 순서 알려줘' },
      { user_message: 'Warmup' },
      { user_message: 'Warmup 뒤에 뭘 하지?' },
      { user_message: '이 태그는 뭐야: <observed_from_primary_session>' },
    ]);
    expect(calls.embeddings).toHaveLength(4);
  });
});

describe('sync: the summary limit is spent on conversations that can be summarized', () => {
  it('files with nothing to summarize take no slot — the one real conversation behind 40 of them is summarized in the same run', async () => {
    for (let i = 0; i < 40; i++) writeSource(`${uuid(i)}.jsonl`, [line('user', `question ${i} with no answer yet`)]);
    const real = writeSource(`${uuid(999)}.jsonl`, turn('the real conversation'));

    const result = await sync({ skipSummaries: false, skipIndex: true, summaryLimit: 2 });
    expect(result.errors).toEqual([]);
    expect(result.summarized).toBe(1);
    expect(calls.summaries).toEqual(['the real conversation']);
    const summaryOf = (src: string) => path.join(destDir, 'proj', path.basename(src).replace('.jsonl', '-summary.txt'));
    expect(fs.readFileSync(summaryOf(real), 'utf8')).toBe('A summary.');
    // nothing is written for the empty ones: they are looked at again once they hold a conversation
    expect(fs.readdirSync(path.join(destDir, 'proj')).filter((f) => f.endsWith('-summary.txt'))).toHaveLength(1);
  });

  it('the limit still caps the summary calls of one run, and the next run continues', async () => {
    for (let i = 0; i < 5; i++) writeSource(`${uuid(i)}.jsonl`, turn(`conversation ${i}`));
    const first = await sync({ skipSummaries: false, skipIndex: true, summaryLimit: 2 });
    expect(first.summarized).toBe(2);
    expect(calls.summaries).toHaveLength(2);
    const second = await sync({ skipSummaries: false, skipIndex: true, summaryLimit: 2 });
    expect(second.summarized).toBe(2);
    const third = await sync({ skipSummaries: false, skipIndex: true, summaryLimit: 2 });
    expect(third.summarized).toBe(1);
    expect(new Set(calls.summaries).size).toBe(5);
  });

  it('marked conversations and machine-noise-only sessions are not summarized and take no slot', async () => {
    const { EXCLUSION_MARKERS } = await import('../src/conversation-guard.js');
    for (let i = 0; i < 6; i++) writeSource(`${uuid(i)}.jsonl`, turn(`${EXCLUSION_MARKERS[2]} conversation ${i}`));
    for (let i = 10; i < 16; i++) writeSource(`${uuid(i)}.jsonl`, turn('<observed_from_primary_session>\n<what_happened>Read</what_happened>'));
    writeSource(`${uuid(999)}.jsonl`, [...turn('<observed_from_primary_session> noise'), ...turn('a real question')]);

    const result = await sync({ skipSummaries: false, skipIndex: true, summaryLimit: 1 });
    expect(result.summarized).toBe(1);
    expect(calls.summaries).toEqual(['a real question']); // the noise turn is not sent to the summarizer either
  });
});
