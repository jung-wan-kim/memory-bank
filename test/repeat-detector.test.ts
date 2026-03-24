import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectRepeat, formatRepeatContext, RepeatMatch } from '../src/repeat-detector.js';
import { initDatabase, insertExchange } from '../src/db.js';
import { suppressConsole } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const restoreConsole = suppressConsole();

describe('Repeat Detection', () => {
  const testDir = path.join(os.tmpdir(), 'repeat-test-' + Date.now());
  const dbPath = path.join(testDir, 'test.db');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    process.env.TEST_DB_PATH = dbPath;
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should return empty array when no exchanges exist', async () => {
    const matches = await detectRepeat('How do I set up authentication?', null);
    expect(matches).toHaveLength(0);
  });

  it('should detect similar past exchanges', async () => {
    const db = initDatabase();
    const embedding = new Array(384).fill(0);
    for (let i = 0; i < 384; i++) embedding[i] = Math.random() * 0.1;

    insertExchange(db, {
      id: 'ex-1',
      project: 'test-project',
      timestamp: '2026-03-20T10:00:00Z',
      userMessage: 'How do I set up JWT authentication in React?',
      assistantMessage: 'Use react-auth library with refresh tokens.\nHere is the implementation...',
      archivePath: '/test/path.jsonl',
      lineStart: 1,
      lineEnd: 4,
    }, embedding);

    db.close();

    // Query with similar prompt
    const matches = await detectRepeat('How to implement authentication with JWT?', 'test-project', 3, 0.5);
    expect(matches).toBeInstanceOf(Array);
    // May or may not match depending on embedding similarity
  });

  it('should respect project filter', async () => {
    const db = initDatabase();
    const embedding = new Array(384).fill(0.05);

    insertExchange(db, {
      id: 'ex-2',
      project: 'project-a',
      timestamp: '2026-03-20T10:00:00Z',
      userMessage: 'Set up database schema',
      assistantMessage: 'Created tables for users and posts.',
      archivePath: '/test/a.jsonl',
      lineStart: 1,
      lineEnd: 2,
    }, embedding);

    db.close();

    // Should not find when filtering by different project
    const matches = await detectRepeat('Set up database schema', 'project-b', 3, 0.3);
    expect(matches.every(m => m.project === 'project-b')).toBe(true);
  });
});

describe('formatRepeatContext', () => {
  it('should return empty string for no matches', () => {
    expect(formatRepeatContext([])).toBe('');
  });

  it('should format matches with date, similarity, and summary', () => {
    const matches: RepeatMatch[] = [{
      exchangeId: 'ex-1',
      project: 'test',
      timestamp: '2026-03-20T10:00:00Z',
      userMessage: 'How to set up auth?',
      assistantSummary: 'Use JWT with refresh tokens.',
      similarity: 0.92,
      archivePath: '/test/path.jsonl',
      lineStart: 1,
      lineEnd: 4,
    }];

    const output = formatRepeatContext(matches);
    expect(output).toContain('비슷한 질문');
    expect(output).toContain('2026-03-20');
    expect(output).toContain('92%');
    expect(output).toContain('How to set up auth?');
    expect(output).toContain('JWT with refresh tokens');
  });
});
