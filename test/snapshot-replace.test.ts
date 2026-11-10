import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';
import type { ConversationExchange } from '../src/types.js';

/**
 * 한 턴 = 한 행을 지키는 교체 규칙.
 *
 *  - 같은 턴(같은 파일·같은 시작 줄)의 더 긴 사본이 이미 색인돼 있으면, 늦게 도착한 더 짧은
 *    사본은 쓰지 않는다. 동기화가 파일을 읽어 둔 사이 SessionEnd 색인이 최종본을 넣으면,
 *    읽어 둔 짧은 사본이 온전한 행을 지웠다(검수 LSO-1).
 *  - 사본을 교체할 때 그 행을 출처로 지목한 사실을 새 행으로 옮기는 일은 삽입 트랜잭션
 *    밖에서 한다. 삽입 트랜잭션 안에서 사실 표 전체를 훑어, 자란 턴 한 건마다 쓰기 잠금을
 *    1.6~2.4초 쥐었다(검수 LSO-2, 실DB: 사실 46,507행·출처 목록 61MB).
 *  - verify 는 색인된 사본이 파일의 턴보다 짧으면, 그 사본이 파일보다 나중에 쓰였어도
 *    '오래됨'으로 본다.
 */

const calls = { embeddings: 0 };
vi.mock('../src/summarizer.js', () => ({
  REFUSED_SUMMARY: '[No summary: the model declined to summarize this conversation.]',
  summarizeConversation: async () => 'A summary.',
}));
vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();
  return {
    ...actual,
    initEmbeddings: async () => {},
    generateExchangeEmbedding: async () => { calls.embeddings++; return new Array(384).fill(0.01); },
    generateEmbedding: async () => new Array(384).fill(0.01),
  };
});

const EMB = new Array(384).fill(0.01);
const SESSION = 'session-1';
const userLine = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-11-01T00:00:00Z', sessionId: SESSION });
const assistantLine = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: '2026-11-01T00:00:01Z', sessionId: SESSION });

let testDir: string;
let archiveDir: string;
let file: string;
let restoreConsole: () => void;
const outerConfigDir = process.env.MEMORY_BANK_CONFIG_DIR;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-snapshot-replace-'));
  archiveDir = path.join(testDir, 'archive');
  fs.mkdirSync(path.join(archiveDir, 'proj'), { recursive: true });
  file = path.join(archiveDir, 'proj', 'conv.jsonl');
  process.env.TEST_PROJECTS_DIR = path.join(testDir, 'projects');
  process.env.TEST_ARCHIVE_DIR = archiveDir;
  process.env.TEST_DB_PATH = path.join(testDir, 'db.sqlite');
  process.env.MEMORY_BANK_CONFIG_DIR = path.join(testDir, 'cfg');
  calls.embeddings = 0;
  restoreConsole = suppressConsole();
});
afterEach(() => {
  restoreConsole();
  delete process.env.TEST_PROJECTS_DIR;
  delete process.env.TEST_ARCHIVE_DIR;
  delete process.env.TEST_DB_PATH;
  if (outerConfigDir === undefined) delete process.env.MEMORY_BANK_CONFIG_DIR;
  else process.env.MEMORY_BANK_CONFIG_DIR = outerConfigDir;
  fs.rmSync(testDir, { recursive: true, force: true });
});

const turn = (id: string, lineStart: number, lineEnd: number, extra: Partial<ConversationExchange> = {}): ConversationExchange => ({
  id, project: 'proj', timestamp: '2026-11-01T00:00:00Z', userMessage: `question at ${lineStart}`,
  assistantMessage: `answer up to line ${lineEnd}`, archivePath: '/arch/proj/a.jsonl', lineStart, lineEnd, sessionId: SESSION, ...extra,
});

const rowsOf = (db: Database.Database, archivePath: string) =>
  db.prepare('SELECT id, line_start AS s, line_end AS e FROM exchanges WHERE archive_path = ? ORDER BY line_start, line_end').all(archivePath);
const queue = (db: Database.Database) =>
  db.prepare('SELECT from_id, to_id, session_id FROM exchange_repoints ORDER BY from_id').all();
const addFact = (db: Database.Database, id: string, sources: string[]) => db.prepare(
  `INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at) VALUES (?, ?, 'decision', 'global', ?, 't', 'u')`,
).run(id, `fact ${id}`, JSON.stringify(sources));
const sourcesOf = (db: Database.Database, id: string) =>
  JSON.parse((db.prepare('SELECT source_exchange_ids AS s FROM facts WHERE id = ?').get(id) as { s: string }).s) as string[];
const markExtracted = (db: Database.Database, sessionId = SESSION) =>
  db.prepare(`INSERT INTO extraction_log (session_id, processed_at, extracted, saved) VALUES (?, '2026-11-01T00:10:00.000Z', 1, 1)`).run(sessionId);

describe('늦게 도착한 더 짧은 사본은 온전한 행을 지우지 못한다', () => {
  it('insertExchange 는 같은 턴의 더 긴 행이 있으면 쓰지 않고 false 를 돌려준다', async () => {
    const { initDatabase, insertExchange } = await import('../src/db.js');
    const db = initDatabase();
    try {
      const full = turn('full-3-6', 3, 6, { toolCalls: [{ id: 'full-3-6:0', exchangeId: 'full-3-6', toolName: 'Read', isError: false, timestamp: 't' }] });
      expect(insertExchange(db, turn('first-1-2', 1, 2), EMB)).toBe(true);
      expect(insertExchange(db, full, EMB)).toBe(true);

      expect(insertExchange(db, turn('short-3-5', 3, 5), EMB)).toBe(false);

      expect(rowsOf(db, '/arch/proj/a.jsonl')).toEqual([{ id: 'first-1-2', s: 1, e: 2 }, { id: 'full-3-6', s: 3, e: 6 }]);
      expect(db.prepare('SELECT id FROM vec_exchanges_rowids ORDER BY id').all()).toEqual([{ id: 'first-1-2' }, { id: 'full-3-6' }]);
      expect(db.prepare('SELECT exchange_id FROM tool_calls').all()).toEqual([{ exchange_id: 'full-3-6' }]);
      expect(db.prepare('SELECT assistant_message AS a FROM exchanges WHERE id = ?').get('full-3-6')).toEqual({ a: 'answer up to line 6' });
      expect(queue(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('더 긴 사본은 예전처럼 짧은 행을 교체한다', async () => {
    const { initDatabase, insertExchange } = await import('../src/db.js');
    const db = initDatabase();
    try {
      insertExchange(db, turn('short-3-5', 3, 5), EMB);
      expect(insertExchange(db, turn('full-3-6', 3, 6), EMB)).toBe(true);
      expect(rowsOf(db, '/arch/proj/a.jsonl')).toEqual([{ id: 'full-3-6', s: 3, e: 6 }]);
    } finally {
      db.close();
    }
  });

  it('동기화가 읽어 둔 사본을 SessionEnd 색인 뒤에 써도 마지막 답이 색인에 남는다', async () => {
    const { initDatabase } = await import('../src/db.js');
    const { indexExchanges } = await import('../src/index-exchanges.js');
    const { parseConversation } = await import('../src/parser.js');
    const lines = [userLine('첫 질문'), assistantLine('첫 답'), userLine('둘째 질문'), assistantLine('둘째 답의 앞부분')];
    const db = initDatabase();
    try {
      // 1. 동기화가 S1 을 색인한다.
      fs.writeFileSync(file, lines.join('\n'));
      await indexExchanges(db, await parseConversation(file, 'proj', file));
      // 2. 두 번째 동기화가 S2 를 읽어 둔다(아직 쓰지 않음).
      lines.push(assistantLine('둘째 답의 가운데'));
      fs.writeFileSync(file, lines.join('\n'));
      const readBySecondSync = await parseConversation(file, 'proj', file);
      // 3. 세션이 끝나 SessionEnd 색인이 최종본 S3 를 넣는다.
      lines.push(assistantLine('둘째 답의 마지막 문장'));
      fs.writeFileSync(file, lines.join('\n'));
      await indexExchanges(db, await parseConversation(file, 'proj', file));
      expect(rowsOf(db, file).map((r) => (r as { e: number }).e)).toEqual([2, 6]);

      // 4. 두 번째 동기화가 읽어 둔 S2 를 쓴다.
      const before = calls.embeddings;
      const result = await indexExchanges(db, readBySecondSync);

      expect(result).toMatchObject({ indexed: 0, unchanged: 1, superseded: 1 });
      expect(calls.embeddings).toBe(before); // 쓰지 않을 사본은 임베딩도 만들지 않는다
      expect(rowsOf(db, file).map((r) => (r as { e: number }).e)).toEqual([2, 6]);
      const last = db.prepare('SELECT assistant_message AS a FROM exchanges WHERE archive_path = ? AND line_start = 3').get(file) as { a: string };
      expect(last.a).toContain('둘째 답의 마지막 문장');
    } finally {
      db.close();
    }
  });
});

describe('교체된 사본의 출처 옮기기는 삽입 트랜잭션 밖에서 한다', () => {
  it('사본을 교체하는 insertExchange 는 사실 표를 읽지 않고, 옮길 쌍을 적어 둔다', async () => {
    const { initDatabase, insertExchange } = await import('../src/db.js');
    const db = initDatabase();
    try {
      insertExchange(db, turn('short-3-5', 3, 5), EMB);
      addFact(db, 'f1', ['other', 'short-3-5']);

      const statements: string[] = [];
      const prepare = db.prepare.bind(db);
      const exec = db.exec.bind(db);
      (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => { statements.push(sql); return prepare(sql); };
      (db as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => { statements.push(sql); return exec(sql); };
      try {
        expect(insertExchange(db, turn('full-3-6', 3, 6), EMB)).toBe(true);
      } finally {
        (db as unknown as { prepare: unknown }).prepare = prepare;
        (db as unknown as { exec: unknown }).exec = exec;
      }

      expect(statements.length).toBeGreaterThan(3);
      expect(statements.filter((sql) => /\b(facts|fact_revisions)\b/.test(sql))).toEqual([]);
      expect(queue(db)).toEqual([{ from_id: 'short-3-5', to_id: 'full-3-6', session_id: SESSION }]);
      expect(sourcesOf(db, 'f1')).toEqual(['other', 'short-3-5']); // 아직 그대로 — 옮기기는 뒤에
    } finally {
      db.close();
    }
  });

  it('repointQueuedExchangeSources 는 추출된 세션의 사실·개정 출처를 새 행으로 옮기고 대기열을 비운다', async () => {
    const { initDatabase, insertExchange, repointQueuedExchangeSources } = await import('../src/db.js');
    const db = initDatabase();
    try {
      insertExchange(db, turn('short-3-5', 3, 5), EMB);
      markExtracted(db);
      addFact(db, 'f-from-short', ['other', 'short-3-5']);
      addFact(db, 'f-both', ['short-3-5', 'full-3-6']);
      addFact(db, 'f-unrelated', ['other']);
      db.prepare(`INSERT INTO fact_revisions (id, fact_id, previous_fact, new_fact, source_exchange_id, created_at) VALUES ('r1', 'f-from-short', 'old', 'new', 'short-3-5', 't')`).run();
      db.prepare(`INSERT INTO fact_revisions (id, fact_id, previous_fact, new_fact, source_exchange_id, created_at) VALUES ('r2', 'f-unrelated', 'old', 'new', 'other', 't')`).run();
      insertExchange(db, turn('full-3-6', 3, 6), EMB);

      const result = repointQueuedExchangeSources(db);

      expect(result).toEqual({ pairs: 1, scanned: true, facts: 2, revisions: 1 });
      expect(sourcesOf(db, 'f-from-short')).toEqual(['other', 'full-3-6']);
      expect(sourcesOf(db, 'f-both')).toEqual(['full-3-6']); // 같은 행을 두 번 적지 않는다
      expect(sourcesOf(db, 'f-unrelated')).toEqual(['other']);
      expect(db.prepare('SELECT updated_at AS u FROM facts WHERE id = ?').get('f-from-short')).toEqual({ u: 'u' }); // 사실 자체는 안 바뀜
      expect(db.prepare('SELECT id, source_exchange_id AS s FROM fact_revisions ORDER BY id').all())
        .toEqual([{ id: 'r1', s: 'full-3-6' }, { id: 'r2', s: 'other' }]);
      expect(queue(db)).toEqual([]);
      // 다시 불러도 할 일이 없다
      expect(repointQueuedExchangeSources(db)).toEqual({ pairs: 0, scanned: false, facts: 0, revisions: 0 });
    } finally {
      db.close();
    }
  });

  it('추출된 적 없는 세션의 사본이면 사실 표를 읽지 않고 대기열만 비운다', async () => {
    const { initDatabase, insertExchange, repointQueuedExchangeSources } = await import('../src/db.js');
    const db = initDatabase();
    try {
      insertExchange(db, turn('short-3-5', 3, 5), EMB);
      insertExchange(db, turn('full-3-6', 3, 6), EMB);
      expect(queue(db)).toHaveLength(1);

      const statements: string[] = [];
      const prepare = db.prepare.bind(db);
      (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => { statements.push(sql); return prepare(sql); };
      let result;
      try {
        result = repointQueuedExchangeSources(db);
      } finally {
        (db as unknown as { prepare: unknown }).prepare = prepare;
      }

      expect(result).toEqual({ pairs: 1, scanned: false, facts: 0, revisions: 0 });
      expect(statements.filter((sql) => /\bFROM facts\b|\bFROM fact_revisions\b/i.test(sql))).toEqual([]);
      expect(queue(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('세션 id 가 없는 교환은 표식을 물을 수 없으므로 사실 표를 읽어 옮긴다', async () => {
    const { initDatabase, insertExchange, repointQueuedExchangeSources } = await import('../src/db.js');
    const db = initDatabase();
    try {
      insertExchange(db, turn('short-3-5', 3, 5, { sessionId: undefined }), EMB);
      addFact(db, 'f1', ['short-3-5']);
      insertExchange(db, turn('full-3-6', 3, 6, { sessionId: undefined }), EMB);
      expect(repointQueuedExchangeSources(db)).toEqual({ pairs: 1, scanned: true, facts: 1, revisions: 0 });
      expect(sourcesOf(db, 'f1')).toEqual(['full-3-6']);
    } finally {
      db.close();
    }
  });

  it('한 턴이 두 번 자라도(a→b→c) a·b 를 지목한 사실이 모두 c 를 가리킨다', async () => {
    const { initDatabase, insertExchange, repointQueuedExchangeSources } = await import('../src/db.js');
    const db = initDatabase();
    try {
      markExtracted(db);
      insertExchange(db, turn('a-3-4', 3, 4), EMB);
      addFact(db, 'f-a', ['a-3-4']);
      insertExchange(db, turn('b-3-5', 3, 5), EMB);
      addFact(db, 'f-b', ['b-3-5']);
      insertExchange(db, turn('c-3-6', 3, 6), EMB);
      expect(queue(db)).toEqual([
        { from_id: 'a-3-4', to_id: 'c-3-6', session_id: SESSION },
        { from_id: 'b-3-5', to_id: 'c-3-6', session_id: SESSION },
      ]);

      expect(repointQueuedExchangeSources(db)).toMatchObject({ pairs: 2, facts: 2 });
      expect(sourcesOf(db, 'f-a')).toEqual(['c-3-6']);
      expect(sourcesOf(db, 'f-b')).toEqual(['c-3-6']);
    } finally {
      db.close();
    }
  });

  it('indexExchanges 가 끝나면 출처가 옮겨져 있고 대기열이 비어 있다', async () => {
    const { initDatabase } = await import('../src/db.js');
    const { indexExchanges } = await import('../src/index-exchanges.js');
    const { parseConversation } = await import('../src/parser.js');
    const lines = [userLine('사람의 질문'), assistantLine('답의 앞부분')];
    const db = initDatabase();
    try {
      fs.writeFileSync(file, lines.join('\n'));
      const [short] = await parseConversation(file, 'proj', file);
      await indexExchanges(db, [short]);
      markExtracted(db);
      addFact(db, 'f1', ['other', short.id]);

      lines.push(assistantLine('답의 뒷부분'));
      fs.writeFileSync(file, lines.join('\n'));
      const [full] = await parseConversation(file, 'proj', file);
      expect(full.id).not.toBe(short.id);
      const result = await indexExchanges(db, [full]);

      expect(result).toMatchObject({ indexed: 1, superseded: 0 });
      expect(sourcesOf(db, 'f1')).toEqual(['other', full.id]);
      expect(queue(db)).toEqual([]);
      // 사실이 지목한 교환은 모두 찾을 수 있다(trace_fact 가 하는 조회)
      expect(db.prepare('SELECT count(*) AS n FROM exchanges WHERE id = ?').get(full.id)).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it('출처를 옮기기 전에 프로세스가 끝나도 쌍이 남아, 다음 색인이 마저 옮긴다', async () => {
    const { initDatabase, insertExchange } = await import('../src/db.js');
    const { indexExchanges } = await import('../src/index-exchanges.js');
    let db = initDatabase();
    try {
      insertExchange(db, turn('short-3-5', 3, 5), EMB);
      markExtracted(db);
      addFact(db, 'f1', ['short-3-5']);
      insertExchange(db, turn('full-3-6', 3, 6), EMB); // 옮기기 전에 끝남
    } finally {
      db.close();
    }

    db = initDatabase();
    try {
      expect(queue(db)).toHaveLength(1);
      await indexExchanges(db, [turn('other-file-1-2', 1, 2, { archivePath: '/arch/proj/b.jsonl', userMessage: '다른 파일의 질문', assistantMessage: '다른 파일의 답' })]);
      expect(sourcesOf(db, 'f1')).toEqual(['full-3-6']);
      expect(queue(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('verify 는 색인된 사본이 파일의 턴보다 짧으면 오래됨으로 본다', () => {
  it('짧은 사본이 파일보다 나중에 쓰였어도 잡고, repair 가 온전한 턴으로 바꾼다', async () => {
    const { initDatabase, insertExchange } = await import('../src/db.js');
    const { parseConversation } = await import('../src/parser.js');
    const { verifyIndex, repairIndex } = await import('../src/verify.js');
    fs.writeFileSync(file, [userLine('사람의 질문'), assistantLine('답의 앞부분'), assistantLine('답의 마지막 문장')].join('\n'));
    fs.writeFileSync(file.replace('.jsonl', '-summary.txt'), 'A summary.');
    const [full] = await parseConversation(file, 'proj', file);
    expect([full.lineStart, full.lineEnd]).toEqual([1, 3]);

    // 색인에는 앞부분만 담은 사본이 있다 — 파일이 마지막으로 바뀐 뒤에 쓰였다(last_indexed > mtime).
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(file, past, past);
    const db = initDatabase();
    try {
      insertExchange(db, { ...full, id: 'short-1-2', lineEnd: 2, assistantMessage: '답의 앞부분' }, EMB);
    } finally {
      db.close();
    }

    const issues = await verifyIndex();
    expect(issues.outdated.map((o) => o.path)).toEqual([file]);
    expect(issues.notIndexed).toEqual([]);

    await repairIndex(issues, { noSummaries: true });
    const after = initDatabase();
    try {
      expect(rowsOf(after, file)).toEqual([{ id: full.id, s: 1, e: 3 }]);
    } finally {
      after.close();
    }
    expect((await verifyIndex()).outdated).toEqual([]);
  });

  it('색인된 사본이 파일의 턴과 같으면 오래됨이 아니다', async () => {
    const { initDatabase } = await import('../src/db.js');
    const { indexExchanges } = await import('../src/index-exchanges.js');
    const { parseConversation } = await import('../src/parser.js');
    const { verifyIndex } = await import('../src/verify.js');
    fs.writeFileSync(file, [userLine('사람의 질문'), assistantLine('답')].join('\n'));
    fs.writeFileSync(file.replace('.jsonl', '-summary.txt'), 'A summary.');
    const db = initDatabase();
    try {
      await indexExchanges(db, await parseConversation(file, 'proj', file));
    } finally {
      db.close();
    }
    const issues = await verifyIndex();
    expect(issues.outdated).toEqual([]);
    expect(issues.notIndexed).toEqual([]);
  });
});
