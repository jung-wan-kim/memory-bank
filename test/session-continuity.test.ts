import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getLastSessionContext, formatSessionContinuity, LastSessionContext } from '../src/session-continuity.js';
import { initDatabase, insertExchange } from '../src/db.js';
import { suppressConsole } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

suppressConsole();

describe('Session Continuity', () => {
  const testDir = path.join(os.tmpdir(), 'session-cont-test-' + Date.now());
  const dbPath = path.join(testDir, 'test.db');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    process.env.TEST_DB_PATH = dbPath;
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should return null when no sessions exist', () => {
    const ctx = getLastSessionContext('test-project');
    expect(ctx).toBeNull();
  });

  it('should find the last session for a project', () => {
    const db = initDatabase();
    const embedding = new Array(384).fill(0.05);

    // Insert exchange with session_id
    insertExchange(db, {
      id: 'ex-1',
      project: 'test-project',
      timestamp: '2026-03-24T10:00:00Z',
      userMessage: 'Fix the auth bug',
      assistantMessage: 'Found the issue in token refresh logic. Fixed by adding expiry check.',
      archivePath: '/test/path.jsonl',
      lineStart: 1,
      lineEnd: 2,
      sessionId: 'session-abc',
      gitBranch: 'fix/auth-bug',
    }, embedding);

    insertExchange(db, {
      id: 'ex-2',
      project: 'test-project',
      timestamp: '2026-03-24T10:05:00Z',
      userMessage: 'Now add tests for it',
      assistantMessage: 'Added 3 test cases for token refresh.',
      archivePath: '/test/path.jsonl',
      lineStart: 3,
      lineEnd: 4,
      sessionId: 'session-abc',
    }, embedding);

    db.close();

    const ctx = getLastSessionContext('test-project');
    expect(ctx).not.toBeNull();
    expect(ctx!.sessionId).toBe('session-abc');
    expect(ctx!.exchangeCount).toBe(2);
    expect(ctx!.lastUserMessage).toContain('add tests');
  });

  it('should not return sessions from other projects', () => {
    const db = initDatabase();
    const embedding = new Array(384).fill(0.05);

    insertExchange(db, {
      id: 'ex-3',
      project: 'project-a',
      timestamp: '2026-03-24T10:00:00Z',
      userMessage: 'Deploy to prod',
      assistantMessage: 'Deployed successfully.',
      archivePath: '/test/a.jsonl',
      lineStart: 1,
      lineEnd: 2,
      sessionId: 'session-xyz',
    }, embedding);

    db.close();

    const ctx = getLastSessionContext('project-b');
    expect(ctx).toBeNull();
  });
});

describe('formatSessionContinuity', () => {
  it('should format context with all fields', () => {
    const ctx: LastSessionContext = {
      sessionId: 'session-abc',
      project: 'test-project',
      timestamp: '2026-03-24T10:05:00Z',
      exchangeCount: 5,
      lastUserMessage: 'Add unit tests for auth module',
      lastAssistantSummary: 'Added 3 test cases covering token refresh, expiry, and revocation.',
      toolsUsed: ['Agent', 'Skill'],
      gitBranch: 'fix/auth-bug',
    };

    const output = formatSessionContinuity(ctx);
    expect(output).toContain('이전 세션');
    expect(output).toContain('2026-03-24');
    expect(output).toContain('5 exchanges');
    expect(output).toContain('Add unit tests');
    expect(output).toContain('fix/auth-bug');
    expect(output).toContain('Agent');
  });

  it('should handle missing optional fields', () => {
    const ctx: LastSessionContext = {
      sessionId: 'session-abc',
      project: 'test-project',
      timestamp: '2026-03-24T10:05:00Z',
      exchangeCount: 1,
      lastUserMessage: 'Hello',
      lastAssistantSummary: '',
      toolsUsed: [],
      gitBranch: null,
    };

    const output = formatSessionContinuity(ctx);
    expect(output).toContain('이전 세션');
    expect(output).not.toContain('브랜치');
    expect(output).not.toContain('사용 도구');
  });
});
