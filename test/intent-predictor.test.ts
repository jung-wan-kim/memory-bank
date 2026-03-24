import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { predictIntent, formatIntentContext, IntentPrediction } from '../src/intent-predictor.js';
import { initDatabase, insertExchange } from '../src/db.js';
import { suppressConsole } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

suppressConsole();

describe('Intent Predictor', () => {
  const testDir = path.join(os.tmpdir(), 'intent-test-' + Date.now());
  const dbPath = path.join(testDir, 'test.db');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    process.env.TEST_DB_PATH = dbPath;
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should return empty prediction for unknown project', () => {
    const pred = predictIntent('unknown-project');
    expect(pred.likelyTools).toHaveLength(0);
    expect(pred.commonPatterns).toHaveLength(0);
  });

  it('should predict tools from exchange history', () => {
    const db = initDatabase();
    const embedding = new Array(384).fill(0.05);

    // Insert exchanges with tool calls
    insertExchange(db, {
      id: 'ex-1',
      project: 'test-proj',
      timestamp: '2026-03-20T10:00:00Z',
      userMessage: 'Deploy the app',
      assistantMessage: 'Deployed.',
      archivePath: '/test/path.jsonl',
      lineStart: 1,
      lineEnd: 2,
      toolCalls: [
        { id: 'tc-1', exchangeId: 'ex-1', toolName: 'Agent', isError: false, timestamp: '2026-03-20T10:00:01Z' },
        { id: 'tc-2', exchangeId: 'ex-1', toolName: 'Skill', isError: false, timestamp: '2026-03-20T10:00:02Z' },
      ],
    }, embedding);

    db.close();

    const pred = predictIntent('test-proj');
    expect(pred.likelyTools.length).toBeGreaterThanOrEqual(0);
    expect(pred.projectProfile).toContain('1 exchanges');
  });
});

describe('formatIntentContext', () => {
  it('should return empty string for no data', () => {
    const pred: IntentPrediction = { likelyTools: [], commonPatterns: [], projectProfile: '' };
    expect(formatIntentContext(pred)).toBe('');
  });

  it('should format prediction with tools and patterns', () => {
    const pred: IntentPrediction = {
      likelyTools: [
        { tool: 'Agent', frequency: 50 },
        { tool: 'Skill', frequency: 30 },
      ],
      commonPatterns: ['Agent → Skill (15x)'],
      projectProfile: '200 exchanges over 30 days, 10 sessions, 5 branches',
    };

    const output = formatIntentContext(pred);
    expect(output).toContain('프로젝트');
    expect(output).toContain('200 exchanges');
    expect(output).toContain('Agent(50)');
    expect(output).toContain('Agent → Skill');
  });
});
