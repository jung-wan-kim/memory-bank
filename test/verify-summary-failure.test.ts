import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { suppressConsole } from './test-utils.js';
import type { ConversationExchange } from '../src/types.js';

/**
 * repairIndex: a failed summary must not block re-indexing (2026-10-08).
 * summarizeConversation now throws on an error/refusal turn; inside the repair
 * loop's try that skipped the exchange re-index for the whole file.
 */

vi.mock('../src/summarizer.js', () => ({
  summarizeConversation: async () => {
    throw new Error('Summary call failed (refusal): unable to respond');
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
  restoreConsole = suppressConsole();
});
afterEach(() => {
  restoreConsole();
  delete process.env.TEST_PROJECTS_DIR;
  delete process.env.TEST_ARCHIVE_DIR;
  delete process.env.TEST_DB_PATH;
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('repairIndex with a failing summary', () => {
  it('re-indexes the outdated file and keeps the old summary instead of an error text', async () => {
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
      expect(after.last_indexed).toBeGreaterThan(before);
    } finally {
      dbAfter.close();
    }
    expect(fs.readFileSync(summaryPath, 'utf-8')).toBe('Old summary');
  });
});
