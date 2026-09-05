import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/embeddings.js', () => ({
  EMBEDDING_VERSION: 'test-embedding-v1',
  initEmbeddings: vi.fn(async () => undefined),
  generateExchangeEmbedding: vi.fn(async () => Array(384).fill(0)),
}));

import { indexConversations } from '../src/indexer.js';

const RECENT_SESSION = '11111111-2222-3333-4444-555555555555';
const OLD_SESSION = '99999999-8888-7777-6666-555555555555';
const DAY = 86_400_000;

let tempRoot = '';
let projectDir = '';
let dbPath = '';

function writeSession(sessionId: string, question: string, answer: string, ageDays: number): string {
  const messages = [
    {
      type: 'user',
      sessionId,
      timestamp: '2026-08-13T09:00:00.000Z',
      message: { role: 'user', content: question },
    },
    {
      type: 'assistant',
      sessionId,
      timestamp: '2026-08-13T09:00:01.000Z',
      message: { role: 'assistant', content: answer },
    },
  ];

  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, `${messages.map(message => JSON.stringify(message)).join('\n')}\n`, 'utf8');

  const when = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(filePath, when, when);
  return filePath;
}

describe('retention filter on the index-all path', () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-retention-indexer-'));
    const projects = path.join(tempRoot, 'projects');
    projectDir = path.join(projects, '-tmp-project');
    fs.mkdirSync(projectDir, { recursive: true });
    dbPath = path.join(tempRoot, 'index', 'db.sqlite');

    process.env.TEST_PROJECTS_DIR = projects;
    process.env.TEST_ARCHIVE_DIR = path.join(tempRoot, 'archive');
    process.env.TEST_DB_PATH = dbPath;
    process.env.MEMORY_BANK_CONFIG_DIR = path.join(tempRoot, 'config');

    writeSession(RECENT_SESSION, 'recent retention question', 'recent retention answer', 1);
    writeSession(OLD_SESSION, 'aged out retention question', 'aged out retention answer', 15);
  });

  afterEach(() => {
    delete process.env.TEST_PROJECTS_DIR;
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.TEST_DB_PATH;
    delete process.env.MEMORY_BANK_CONFIG_DIR;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('indexes and archives the recent session only', async () => {
    await indexConversations(undefined, undefined, 1, true);

    const db = new Database(dbPath, { readonly: true });
    const countFor = (sessionId: string) =>
      (db.prepare('SELECT COUNT(*) as count FROM exchanges WHERE session_id = ?').get(sessionId) as { count: number }).count;

    const recentCount = countFor(RECENT_SESSION);
    const oldCount = countFor(OLD_SESSION);
    db.close();

    expect(oldCount).toBe(0);
    expect(recentCount).toBeGreaterThanOrEqual(1);

    const archiveProject = path.join(process.env.TEST_ARCHIVE_DIR!, '-tmp-project');
    expect(fs.existsSync(path.join(archiveProject, `${OLD_SESSION}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(archiveProject, `${RECENT_SESSION}.jsonl`))).toBe(true);

    // The source itself is never touched by retention.
    expect(fs.existsSync(path.join(projectDir, `${OLD_SESSION}.jsonl`))).toBe(true);
  });
});
