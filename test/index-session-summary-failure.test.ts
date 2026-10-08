import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getFixturePath, suppressConsole } from './test-utils.js';

/**
 * A failed summary must not cost the exchange index (2026-10-08).
 *
 * summarizeConversation now throws on an error turn instead of
 * returning the error text as the summary. indexSession called it with no
 * try, so the throw skipped every insertExchange and db.close() — and since
 * the archive copy was already fresh, the next sync never re-indexed the file.
 */

const summaryMode: { fail: boolean } = { fail: true };

vi.mock('../src/summarizer.js', () => ({
  summarizeConversation: async () => {
    if (summaryMode.fail) throw new Error('Summary call failed (error_during_execution): API Error: 500');
    return 'A summary';
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

const SESSION = '0f3c2a9e-5b7d-4c11-9a6e-2d8f4b1c7e55';
let tmpDir: string;
let restoreConsole: () => void;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-index-session-'));
  const projectDir = path.join(tmpDir, 'projects', '-tmp-demo-project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.copyFileSync(getFixturePath('short-conversation.jsonl'), path.join(projectDir, `${SESSION}.jsonl`));
  process.env.TEST_PROJECTS_DIR = path.join(tmpDir, 'projects');
  process.env.TEST_ARCHIVE_DIR = path.join(tmpDir, 'archive');
  process.env.TEST_DB_PATH = path.join(tmpDir, 'test.sqlite');
  summaryMode.fail = true;
  restoreConsole = suppressConsole();
});
afterEach(() => {
  restoreConsole();
  delete process.env.TEST_PROJECTS_DIR;
  delete process.env.TEST_ARCHIVE_DIR;
  delete process.env.TEST_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function indexedExchanges(): number {
  const db = new Database(process.env.TEST_DB_PATH!, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM exchanges').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('indexSession', () => {
  it('indexes the exchanges even when the summary fails, and writes no summary file', async () => {
    const { indexSession } = await import('../src/indexer.js');
    await expect(indexSession(SESSION)).resolves.toBeUndefined();

    expect(indexedExchanges()).toBeGreaterThan(0);
    // No summary file → the next sync summarizes this conversation again.
    const summary = path.join(tmpDir, 'archive', '-tmp-demo-project', `${SESSION}-summary.txt`);
    expect(fs.existsSync(summary)).toBe(false);
  });

  it('writes the summary when it succeeds', async () => {
    summaryMode.fail = false;
    const { indexSession } = await import('../src/indexer.js');
    await indexSession(SESSION);
    const summary = path.join(tmpDir, 'archive', '-tmp-demo-project', `${SESSION}-summary.txt`);
    expect(fs.readFileSync(summary, 'utf-8')).toBe('A summary');
  });
});
