import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { suppressConsole } from './test-utils.js';
import type { ConversationExchange } from '../src/types.js';

/**
 * repairIndex: a failed summary must not block re-indexing (2026-10-08).
 * summarizeConversation now throws on an error turn; inside the repair
 * loop's try that skipped the exchange re-index for the whole file.
 */

const REFUSED = '[No summary: the model declined to summarize this conversation.]';
const summaryMode: { value: 'fail' | 'refuse' } = { value: 'fail' };
vi.mock('../src/summarizer.js', () => ({
  REFUSED_SUMMARY: REFUSED,
  summarizeConversation: async () => {
    if (summaryMode.value === 'refuse') return REFUSED;
    throw new Error('Summary call failed (error_during_execution): API Error: 500');
  },
}));
vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();
  return {
    ...actual,
    initEmbeddings: async () => {},
    generateExchangeEmbedding: async () => new Array(384).fill(0.01),
    generateEmbedding: async () => new Array(384).fill(0.01),
  };
});

let testDir: string;
let restoreConsole: () => void;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-repair-summary-'));
  fs.mkdirSync(path.join(testDir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(testDir, 'archive'), { recursive: true });
  process.env.TEST_PROJECTS_DIR = path.join(testDir, 'projects');
  process.env.TEST_ARCHIVE_DIR = path.join(testDir, 'archive');
  process.env.TEST_DB_PATH = path.join(testDir, 'db.sqlite');
  summaryMode.value = 'fail';
  restoreConsole = suppressConsole();
});
afterEach(() => {
  restoreConsole();
  delete process.env.TEST_PROJECTS_DIR;
  delete process.env.TEST_ARCHIVE_DIR;
  delete process.env.TEST_DB_PATH;
  fs.rmSync(testDir, { recursive: true, force: true });
});

async function repairOutdated(): Promise<{ summaryPath: string; reindexed: boolean }> {
  const { initDatabase, insertExchange } = await import('../src/db.js');
  const { verifyIndex, repairIndex } = await import('../src/verify.js');

  const projectArchive = path.join(testDir, 'archive', 'test-project');
  fs.mkdirSync(projectArchive, { recursive: true });
  const conversationPath = path.join(projectArchive, 'outdated.jsonl');
  const line = (type: string, content: string, ts: string) =>
    JSON.stringify({ type, message: { role: type, content }, timestamp: ts });
  fs.writeFileSync(conversationPath, [line('user', 'Hello', '2024-01-01T00:00:00Z'), line('assistant', 'Hi there!', '2024-01-01T00:00:01Z')].join('\n'));
  // verifyIndex counts a file without a summary as "missing", not "outdated"
  const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
  fs.writeFileSync(summaryPath, 'Old summary');

  const db = initDatabase();
  const exchange: ConversationExchange = {
    id: 'outdated-1', project: 'test-project', timestamp: '2024-01-01T00:00:00Z',
    userMessage: 'Hello', assistantMessage: 'Hi there!', archivePath: conversationPath, lineStart: 1, lineEnd: 2,
  };
  insertExchange(db, exchange, new Array(384).fill(0.1));
  const before = (db.prepare('SELECT last_indexed FROM exchanges WHERE id = ?').get('outdated-1') as { last_indexed: number }).last_indexed;
  db.close();

  await new Promise((r) => setTimeout(r, 10));
  fs.appendFileSync(conversationPath, '\n' + [line('user', 'New message', '2024-01-01T00:00:02Z'), line('assistant', 'New response', '2024-01-01T00:00:03Z')].join('\n'));

  const issues = await verifyIndex();
  expect(issues.outdated.length).toBe(1);
  await new Promise((r) => setTimeout(r, 10));
  await repairIndex(issues);

  const dbAfter = initDatabase();
  try {
    const after = dbAfter.prepare('SELECT MAX(last_indexed) AS last_indexed FROM exchanges WHERE archive_path = ?').get(conversationPath) as { last_indexed: number };
    return { summaryPath, reindexed: after.last_indexed > before };
  } finally {
    dbAfter.close();
  }
}

describe('repairIndex with a failing summary', () => {
  // The old summary was kept at first (2026-10-08 round 2), but then it never got
  // redone: the file exists, so sync skips it, and the exchanges are indexed as
  // current. Removed, the next sync (or repair) writes a fresh one.
  it('re-indexes the outdated file and removes the stale summary so it is redone', async () => {
    const { summaryPath, reindexed } = await repairOutdated();
    expect(reindexed).toBe(true);
    expect(fs.existsSync(summaryPath)).toBe(false);
  });

  // A compressed copy left behind still counts as "has a summary" (archiveFileExists).
  it('removes a compressed copy of the stale summary too', async () => {
    const zst = path.join(testDir, 'archive', 'test-project', 'outdated-summary.txt.zst');
    fs.mkdirSync(path.dirname(zst), { recursive: true });
    fs.writeFileSync(zst, 'compressed old summary');
    const { summaryPath } = await repairOutdated();
    expect(fs.existsSync(summaryPath)).toBe(false);
    expect(fs.existsSync(zst)).toBe(false);
  });

  // The refusal marker is final; written over an existing summary it would
  // replace real content with nothing for good (4th review N3).
  it('writes the refusal marker when there is no summary to keep', async () => {
    summaryMode.value = 'refuse';
    const { verifyIndex, repairIndex } = await import('../src/verify.js');
    const projectArchive = path.join(testDir, 'archive', 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });
    const conversationPath = path.join(projectArchive, 'missing.jsonl');
    const line = (type: string, content: string, ts: string) =>
      JSON.stringify({ type, message: { role: type, content }, timestamp: ts });
    fs.writeFileSync(conversationPath, [line('user', 'Hello', '2024-01-01T00:00:00Z'), line('assistant', 'Hi there!', '2024-01-01T00:00:01Z')].join('\n'));

    const issues = await verifyIndex();
    expect(issues.missing.map((m) => m.path)).toContain(conversationPath);
    await repairIndex(issues);
    const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
    expect(fs.existsSync(summaryPath)).toBe(true);
    expect(fs.readFileSync(summaryPath, 'utf-8')).toBe(REFUSED);
  });

  it('keeps the existing summary when the new one is refused', async () => {
    summaryMode.value = 'refuse';
    const { summaryPath, reindexed } = await repairOutdated();
    expect(reindexed).toBe(true);
    expect(fs.readFileSync(summaryPath, 'utf-8')).toBe('Old summary');
  });
});
