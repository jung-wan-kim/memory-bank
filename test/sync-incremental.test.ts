import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

// Count embeddings instead of running the model: the point of these tests is
// how much work a sync does, not the vectors.
const embedCalls: string[] = [];
vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();
  return {
    ...actual,
    initEmbeddings: vi.fn(async () => {}),
    generateExchangeEmbedding: vi.fn(async (user: string) => {
      embedCalls.push(user);
      return new Array(384).fill(0.01);
    }),
  };
});

const summarized: string[] = [];
vi.mock('../src/summarizer.js', () => ({
  summarizeConversation: vi.fn(async (exchanges: Array<{ archivePath: string }>) => {
    summarized.push(exchanges[0].archivePath);
    return 'summary';
  }),
}));

const { syncConversations, shouldSkipConversation } = await import('../src/sync.js');

let n = 0;
function line(type: 'user' | 'assistant', content: string): string {
  n++;
  return JSON.stringify({
    type,
    uuid: `uuid-${n}`,
    parentUuid: n > 1 ? `uuid-${n - 1}` : null,
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    timestamp: new Date(Date.UTC(2026, 9, 31, 0, 0, n)).toISOString(),
    isSidechain: false,
    message: { role: type, content },
  }) + '\n';
}

function bump(file: string, secondsAhead: number): void {
  const t = new Date(Date.now() + secondsAhead * 1000);
  fs.utimesSync(file, t, t);
}

describe('incremental sync (obra #152 port)', () => {
  let testDir: string;
  let sourceDir: string;
  let destDir: string;
  let src: string;

  beforeEach(() => {
    n = 0;
    embedCalls.length = 0;
    summarized.length = 0;
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-sync-incr-'));
    sourceDir = path.join(testDir, 'source');
    destDir = path.join(testDir, 'dest');
    fs.mkdirSync(path.join(sourceDir, 'proj'), { recursive: true });
    src = path.join(sourceDir, 'proj', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
    process.env.TEST_DB_PATH = path.join(testDir, 'test.db');
    process.env.MEMORY_BANK_SKIP_SUMMARIES = '1';
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    delete process.env.MEMORY_BANK_SKIP_SUMMARIES;
    delete process.env.MEMORY_BANK_MAX_MESSAGE_BYTES;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function rows(): Array<{ id: string; line_start: number; assistant_message: string }> {
    const db = new Database(process.env.TEST_DB_PATH!);
    sqliteVec.load(db);
    const out = db.prepare(
      'SELECT id, line_start, assistant_message FROM exchanges ORDER BY line_start'
    ).all() as Array<{ id: string; line_start: number; assistant_message: string }>;
    const vecs = (db.prepare('SELECT COUNT(*) AS c FROM vec_exchanges').get() as { c: number }).c;
    db.close();
    expect(vecs).toBe(out.length); // no orphaned or missing vectors
    return out;
  }

  it('re-embeds only the last indexed exchange and the ones appended after it', async () => {
    fs.writeFileSync(src, line('user', 'q1') + line('assistant', 'a1') + line('user', 'q2') + line('assistant', 'a2'));
    await syncConversations(sourceDir, destDir);
    expect(embedCalls).toEqual(['q1', 'q2']);

    embedCalls.length = 0;
    fs.appendFileSync(src, line('user', 'q3') + line('assistant', 'a3') + line('user', 'q4') + line('assistant', 'a4'));
    bump(src, 5);
    await syncConversations(sourceDir, destDir);

    // q2 is the resume point (it may have been mid-reply); q1 is never touched again.
    expect(embedCalls).toEqual(['q2', 'q3', 'q4']);
    expect(rows().map(r => r.assistant_message)).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('replaces a reply that was still streaming at the previous sync instead of keeping both', async () => {
    fs.writeFileSync(src, line('user', 'q1') + line('assistant', 'a1') + line('user', 'q2') + line('assistant', 'part one'));
    await syncConversations(sourceDir, destDir);
    const before = rows();
    expect(before).toHaveLength(2);

    fs.appendFileSync(src, line('assistant', 'part two'));
    bump(src, 5);
    await syncConversations(sourceDir, destDir);

    const after = rows();
    expect(after).toHaveLength(2);
    expect(after[1].assistant_message).toContain('part one');
    expect(after[1].assistant_message).toContain('part two');
    expect(after[1].id).not.toBe(before[1].id); // id hashes the last assistant line
    expect(after[0].id).toBe(before[0].id);
  });

  it('re-indexing an exchange replaces its tool calls instead of adding them again', async () => {
    const toolLine = (id: string) => JSON.stringify({
      type: 'assistant', uuid: `t-${id}`, parentUuid: null, sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      timestamp: '2026-10-31T00:00:00Z', isSidechain: false,
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/x' } }] },
    }) + '\n';
    fs.writeFileSync(src, line('user', 'q1') + toolLine('tool-1') + line('assistant', 'a1'));
    await syncConversations(sourceDir, destDir);
    fs.appendFileSync(src, line('user', 'q2') + line('assistant', 'a2'));
    bump(src, 5);
    await syncConversations(sourceDir, destDir); // q1 is the resume point: re-indexed under the same id
    fs.appendFileSync(src, line('user', 'q3') + line('assistant', 'a3'));
    bump(src, 10);
    await syncConversations(sourceDir, destDir);
    const db = new Database(process.env.TEST_DB_PATH!);
    const tools = (db.prepare('SELECT COUNT(*) AS c FROM tool_calls').get() as { c: number }).c;
    db.close();
    expect(tools).toBe(1);
  });

  it('does not re-embed an unchanged file', async () => {
    fs.writeFileSync(src, line('user', 'q1') + line('assistant', 'a1'));
    await syncConversations(sourceDir, destDir);
    embedCalls.length = 0;
    await syncConversations(sourceDir, destDir);
    expect(embedCalls).toEqual([]);
  });

  it('skips oversize exchanges (obra #139)', async () => {
    process.env.MEMORY_BANK_MAX_MESSAGE_BYTES = '100';
    fs.writeFileSync(src, line('user', 'small') + line('assistant', 'ok') + line('user', 'x'.repeat(500)) + line('assistant', 'ok'));
    await syncConversations(sourceDir, destDir);
    expect(embedCalls).toEqual(['small']);
  });
});

describe('summary candidates', () => {
  let testDir: string;
  let sourceDir: string;
  let destDir: string;

  beforeEach(() => {
    n = 0;
    summarized.length = 0;
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-sync-sum-'));
    sourceDir = path.join(testDir, 'source');
    destDir = path.join(testDir, 'dest');
    fs.mkdirSync(path.join(sourceDir, 'proj'), { recursive: true });
    process.env.TEST_DB_PATH = path.join(testDir, 'test.db');
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    delete process.env.MEMORY_BANK_SKIP_SUMMARIES;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function session(i: number, ageSeconds: number): string {
    const id = `0000000${i}-bbbb-cccc-dddd-eeeeeeeeeeee`;
    const file = path.join(sourceDir, 'proj', `${id}.jsonl`);
    fs.writeFileSync(file, line('user', `question ${i}`) + line('assistant', `answer ${i}`));
    bump(file, -ageSeconds);
    return path.join(destDir, 'proj', `${id}.jsonl`);
  }

  it('summarizes the newest conversations first, up to the limit', async () => {
    const oldest = session(1, 300);
    const newest = session(2, 10);
    const middle = session(3, 100);
    const result = await syncConversations(sourceDir, destDir, { skipIndex: true, summaryLimit: 2 });
    expect(result.summarized).toBe(2);
    expect(summarized).toEqual([newest, middle]);
    expect(fs.existsSync(oldest.replace('.jsonl', '-summary.txt'))).toBe(false);
  });

  it('MEMORY_BANK_SKIP_SUMMARIES=1 skips the summary pass', async () => {
    session(1, 10);
    process.env.MEMORY_BANK_SKIP_SUMMARIES = '1';
    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });
    expect(result.summarized).toBe(0);
    expect(summarized).toEqual([]);
  });
});

describe('shouldSkipConversation streaming scan', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-marker-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const MARKER = '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>';

  it('finds a marker split across the 1 MiB chunk boundary', () => {
    const file = path.join(dir, 'split.jsonl');
    const pad = 'a'.repeat((1 << 20) - 20);
    fs.writeFileSync(file, pad + MARKER + '\n');
    expect(shouldSkipConversation(file)).toBe(true);
  });

  it('a clean file is not skipped; a missing one fails closed', () => {
    const file = path.join(dir, 'clean.jsonl');
    fs.writeFileSync(file, 'b'.repeat(3 << 20));
    expect(shouldSkipConversation(file)).toBe(false);
    expect(shouldSkipConversation(path.join(dir, 'missing.jsonl'))).toBe(true);
  });
});
