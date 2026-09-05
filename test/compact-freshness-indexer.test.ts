import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/embeddings.js', () => ({
  EMBEDDING_VERSION: 'test-embedding-v1',
  initEmbeddings: vi.fn(async () => undefined),
  generateExchangeEmbedding: vi.fn(async () => Array(384).fill(0)),
}));

import { evaluateCompactFreshness } from '../src/compact-freshness.js';

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let tempRoot = '';

describe('compact freshness production path', () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-compact-'));
    const projects = path.join(tempRoot, 'projects');
    const project = path.join(projects, '-tmp-project');
    fs.mkdirSync(project, { recursive: true });

    process.env.TEST_PROJECTS_DIR = projects;
    process.env.TEST_ARCHIVE_DIR = path.join(tempRoot, 'archive');
    process.env.TEST_DB_PATH = path.join(tempRoot, 'index', 'db.sqlite');
    process.env.MEMORY_BANK_CONFIG_DIR = path.join(tempRoot, 'config');

    const messages = [
      {
        type: 'user',
        sessionId: SESSION_ID,
        timestamp: '2026-08-13T09:00:00.000Z',
        message: { role: 'user', content: 'first compact fixture question' },
      },
      {
        type: 'assistant',
        sessionId: SESSION_ID,
        timestamp: '2026-08-13T09:00:01.000Z',
        message: { role: 'assistant', content: 'first compact fixture answer' },
      },
      {
        type: 'user',
        sessionId: SESSION_ID,
        timestamp: '2026-08-13T09:00:02.000Z',
        message: { role: 'user', content: 'latest compact fixture question' },
      },
      {
        type: 'assistant',
        sessionId: SESSION_ID,
        timestamp: '2026-08-13T09:00:03.000Z',
        message: { role: 'assistant', content: 'latest compact fixture answer' },
      },
    ];
    fs.writeFileSync(
      path.join(project, `${SESSION_ID}.jsonl`),
      `${messages.map(message => JSON.stringify(message)).join('\n')}\n`,
      'utf8'
    );
  });

  afterEach(() => {
    delete process.env.TEST_PROJECTS_DIR;
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.TEST_DB_PATH;
    delete process.env.MEMORY_BANK_CONFIG_DIR;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('indexes the current session and confirms its latest DB frontier', async () => {
    const receipt = await evaluateCompactFreshness(SESSION_ID);

    expect(receipt).toMatchObject({
      status: 'fresh',
      reason: 'current_session_indexed',
      exchangeCount: 2,
      frontier: 4,
    });
    expect(receipt.lastIndexed).toBeTypeOf('number');
  });
});
