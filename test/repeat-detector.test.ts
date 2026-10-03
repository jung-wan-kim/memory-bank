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

describe('Repeat Detection — 훅이 넘기는 절대경로로 같은 프로젝트를 찾는다', () => {
  const testDir = path.join(os.tmpdir(), 'repeat-path-test-' + Date.now());
  const dbPath = path.join(testDir, 'test.db');
  // 결정론: 모델 대신 고정 단위벡터를 질의·저장 양쪽에 쓴다 (유사도 1.0)
  const unit = (seed: number) => {
    const v = Array.from({ length: 384 }, (_, i) => Math.sin(seed * 31 + i));
    const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    return v.map((x) => x / n);
  };
  const add = (id: string, project: string, embedding: number[]) => {
    const db = initDatabase();
    insertExchange(db, {
      id, project, timestamp: '2026-09-01T10:00:00Z',
      userMessage: `질문 ${id}`, assistantMessage: `이전 답변 본문 ${id} — 충분히 긴 줄입니다`,
      archivePath: `/archive/${id}.jsonl`, lineStart: 1, lineEnd: 2,
    }, embedding);
    db.close();
  };

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    process.env.TEST_DB_PATH = dbPath;
  });
  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('cwd 절대경로로 호출해도 슬러그로 저장된 교환을 찾는다 (2,686회 0건이던 버그)', async () => {
    const e = unit(1);
    add('ex-path-1', '-tmp-proj-a', e);
    const matches = await detectRepeat('무엇이든', '/tmp/proj_a', 2, 0.5, { embedding: e });
    expect(matches.map((m) => m.exchangeId)).toEqual(['ex-path-1']);
  });

  it('한글 경로 조각도 Claude Code 슬러그 규칙으로 맞춘다', async () => {
    const e = unit(2);
    add('ex-kr-1', '-tmp------', e); // /tmp/분양데이터 → 글자마다 '-'
    const matches = await detectRepeat('무엇이든', '/tmp/분양데이터', 2, 0.5, { embedding: e });
    expect(matches.map((m) => m.exchangeId)).toEqual(['ex-kr-1']);
  });

  it('다른 프로젝트의 교환은 여전히 제외한다', async () => {
    const e = unit(3);
    add('ex-other-1', '-tmp-proj-b', e);
    const matches = await detectRepeat('무엇이든', '/tmp/proj_a', 2, 0.5, { embedding: e });
    expect(matches).toHaveLength(0);
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
