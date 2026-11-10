import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initDatabase, insertExchange, deleteExchange, deleteExchanges, isExchangeCurrent, EXCHANGE_TURN_INDEX, TOOL_INPUT_MAX_CHARS } from '../src/db.js';
import { parseConversation } from '../src/parser.js';
import { EMBEDDING_VERSION } from '../src/embedding-version.js';
import { suppressConsole } from './test-utils.js';

// 저장 계층의 불변식: 한 턴 = 한 행, 재색인해도 tool_calls 가 늘지 않음, 삭제는 전부 아니면 전무.
// 새로 만든 DB 는 tool_calls FK 에 ON DELETE CASCADE 가 없다(옛 DB 일부에만 있다) — 그 스키마에서 성립해야 한다.

const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());
const EMB = new Array(384).fill(0.01);

const userLine = (text: string, ts: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: ts, sessionId: 's1' });
const assistantLine = (text: string, ts: string, tools: Array<{ name: string; input: unknown }> = []) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }, ...tools.map((t) => ({ type: 'tool_use', name: t.name, input: t.input }))],
    },
    timestamp: ts,
    sessionId: 's1',
  });

describe('exchange storage invariants (fresh DB, no CASCADE)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-exstore-'));
    process.env.TEST_DB_PATH = path.join(dir, 'db.sqlite');
    fs.mkdirSync(path.join(dir, 'archive', 'proj'), { recursive: true });
    file = path.join(dir, 'archive', 'proj', 'conv.jsonl');
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const count = (db: Database.Database, sql: string, ...params: unknown[]) =>
    (db.prepare(sql).get(...params) as { n: number }).n;

  async function indexFile(db: Database.Database): Promise<string[]> {
    const exchanges = await parseConversation(file, 'proj', file);
    for (const ex of exchanges) insertExchange(db, ex, EMB);
    return exchanges.map((e) => e.id);
  }

  it('the schema under test really has no ON DELETE CASCADE and enforces foreign keys', () => {
    const db = initDatabase();
    try {
      const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'tool_calls'`).get() as { sql: string }).sql;
      expect(ddl).not.toMatch(/ON DELETE CASCADE/i);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it('indexing the same conversation twice leaves the tool_calls count unchanged', async () => {
    fs.writeFileSync(file, [
      userLine('배포 스크립트 고쳐 줘', '2026-11-01T00:00:00Z'),
      assistantLine('파일을 읽습니다', '2026-11-01T00:00:01Z', [{ name: 'Read', input: { file_path: '/a' } }, { name: 'Grep', input: { pattern: 'x' } }]),
      assistantLine('고쳤습니다', '2026-11-01T00:00:02Z', [{ name: 'Edit', input: { file_path: '/a' } }]),
    ].join('\n'));
    const db = initDatabase();
    try {
      const first = await indexFile(db);
      expect(first).toHaveLength(1);
      expect(count(db, 'SELECT count(*) AS n FROM tool_calls')).toBe(3);
      const idsAfterFirst = db.prepare('SELECT id FROM tool_calls ORDER BY id').all();

      await indexFile(db);
      await indexFile(db);
      expect(count(db, 'SELECT count(*) AS n FROM tool_calls')).toBe(3);
      expect(db.prepare('SELECT id FROM tool_calls ORDER BY id').all()).toEqual(idsAfterFirst);
      expect(count(db, 'SELECT count(*) AS n FROM exchanges')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('tool call ids are <exchangeId>:<position>, the same on every parse', async () => {
    fs.writeFileSync(file, [
      userLine('질문', '2026-11-01T00:00:00Z'),
      assistantLine('답', '2026-11-01T00:00:01Z', [{ name: 'Read', input: {} }, { name: 'Bash', input: {} }]),
    ].join('\n'));
    const a = await parseConversation(file, 'proj', file);
    const b = await parseConversation(file, 'proj', file);
    expect(a[0].toolCalls!.map((t) => t.id)).toEqual([`${a[0].id}:0`, `${a[0].id}:1`]);
    expect(b[0].toolCalls!.map((t) => t.id)).toEqual(a[0].toolCalls!.map((t) => t.id));
    expect(a[0].toolCalls!.map((t) => t.exchangeId)).toEqual([a[0].id, a[0].id]);
  });

  it('a re-index whose exchange now has fewer tool calls drops the ones that are gone', () => {
    const db = initDatabase();
    try {
      const base = {
        id: 'ex-1', project: 'proj', timestamp: '2026-11-01T00:00:00Z', userMessage: 'q', assistantMessage: 'a',
        archivePath: file, lineStart: 1, lineEnd: 3,
      };
      const call = (n: number) => ({ id: `ex-1:${n}`, exchangeId: 'ex-1', toolName: `T${n}`, isError: false, timestamp: '2026-11-01T00:00:01Z' });
      insertExchange(db, { ...base, toolCalls: [call(0), call(1), call(2)] }, EMB);
      insertExchange(db, { ...base, toolCalls: [call(0)] }, EMB);
      expect(db.prepare('SELECT tool_name FROM tool_calls ORDER BY id').all()).toEqual([{ tool_name: 'T0' }]);
      insertExchange(db, { ...base }, EMB);
      expect(count(db, 'SELECT count(*) AS n FROM tool_calls')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('deleteExchange removes an exchange that has tool calls, with its tool calls and vector', async () => {
    fs.writeFileSync(file, [
      userLine('질문', '2026-11-01T00:00:00Z'),
      assistantLine('답', '2026-11-01T00:00:01Z', [{ name: 'Read', input: {} }]),
    ].join('\n'));
    const db = initDatabase();
    try {
      const [id] = await indexFile(db);
      expect(count(db, 'SELECT count(*) AS n FROM tool_calls WHERE exchange_id = ?', id)).toBe(1);
      deleteExchange(db, id);
      expect(count(db, 'SELECT count(*) AS n FROM exchanges')).toBe(0);
      expect(count(db, 'SELECT count(*) AS n FROM tool_calls')).toBe(0);
      expect(count(db, 'SELECT count(*) AS n FROM vec_exchanges_rowids')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('deleteExchange is all-or-nothing: when the exchange row cannot be deleted, its tool calls and vector stay', async () => {
    fs.writeFileSync(file, [
      userLine('질문', '2026-11-01T00:00:00Z'),
      assistantLine('답', '2026-11-01T00:00:01Z', [{ name: 'Read', input: {} }]),
    ].join('\n'));
    const db = initDatabase();
    try {
      const [id] = await indexFile(db);
      db.exec(`CREATE TRIGGER block_delete BEFORE DELETE ON exchanges BEGIN SELECT RAISE(ABORT, 'blocked for the test'); END`);
      expect(() => deleteExchange(db, id)).toThrow(/blocked for the test/);
      expect(count(db, 'SELECT count(*) AS n FROM exchanges')).toBe(1);
      expect(count(db, 'SELECT count(*) AS n FROM tool_calls')).toBe(1);
      expect(count(db, 'SELECT count(*) AS n FROM vec_exchanges_rowids')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('deleteExchanges deletes across batches and reports how many', () => {
    const db = initDatabase();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) {
        const id = `ex-${i}`;
        ids.push(id);
        insertExchange(db, {
          id, project: 'proj', timestamp: '2026-11-01T00:00:00Z', userMessage: `q${i}`, assistantMessage: `a${i}`,
          archivePath: `${file}.${i}`, lineStart: 1, lineEnd: 2,
          toolCalls: [{ id: `${id}:0`, exchangeId: id, toolName: 'Read', isError: false, timestamp: '2026-11-01T00:00:01Z' }],
        }, EMB);
      }
      expect(deleteExchanges(db, ids.slice(0, 5), 2)).toBe(5);
      expect(db.prepare('SELECT id FROM exchanges ORDER BY id').all()).toEqual([{ id: 'ex-5' }, { id: 'ex-6' }]);
      expect(count(db, 'SELECT count(*) AS n FROM tool_calls')).toBe(2);
      expect(count(db, 'SELECT count(*) AS n FROM vec_exchanges_rowids')).toBe(2);
    } finally {
      db.close();
    }
  });

  it('a turn whose answer grew between two syncs stays ONE row (the shorter snapshot is replaced)', async () => {
    const lines = [
      userLine('사람의 질문 A', '2026-11-01T00:00:00Z'),
      assistantLine('답의 앞부분', '2026-11-01T00:00:01Z', [{ name: 'Read', input: {} }]),
    ];
    fs.writeFileSync(file, lines.join('\n'));
    const db = initDatabase();
    try {
      const [shortId] = await indexFile(db);
      lines.push(assistantLine('답의 뒷부분', '2026-11-01T00:00:02Z', [{ name: 'Edit', input: {} }]));
      fs.writeFileSync(file, lines.join('\n'));
      const [longId] = await indexFile(db);

      expect(longId).not.toBe(shortId);
      const rows = db.prepare('SELECT id, line_start, line_end, assistant_message FROM exchanges WHERE archive_path = ?').all(file) as
        Array<{ id: string; line_start: number; line_end: number; assistant_message: string }>;
      expect(rows.map((r) => r.id)).toEqual([longId]);
      expect(rows[0].line_end).toBe(3);
      expect(rows[0].assistant_message).toContain('답의 뒷부분');
      // the shorter snapshot's vector and tool calls went with it
      expect(db.prepare('SELECT id FROM vec_exchanges_rowids').all()).toEqual([{ id: longId }]);
      expect(db.prepare('SELECT DISTINCT exchange_id FROM tool_calls').all()).toEqual([{ exchange_id: longId }]);
      expect(count(db, 'SELECT count(*) AS n FROM tool_calls')).toBe(2);
      // and the FTS index no longer answers for the removed row
      expect(count(db, `SELECT count(*) AS n FROM exchanges_fts WHERE exchanges_fts MATCH '"사람의"'`)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('facts and revisions that named the replaced snapshot as their source now name the row that replaced it', async () => {
    const lines = [
      userLine('사람의 질문 A', '2026-11-01T00:00:00Z'),
      assistantLine('답의 앞부분', '2026-11-01T00:00:01Z'),
    ];
    fs.writeFileSync(file, lines.join('\n'));
    const db = initDatabase();
    try {
      const [shortId] = await indexFile(db);
      // a fact extracted while only the shorter snapshot existed (facts carry every exchange id of their session)
      const addFact = (id: string, sources: string | null) => db.prepare(
        `INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at) VALUES (?, ?, 'decision', 'global', ?, 't', 'u')`
      ).run(id, `fact ${id}`, sources);
      addFact('f-from-short', JSON.stringify(['other-exchange', shortId]));
      addFact('f-unrelated', JSON.stringify(['other-exchange']));
      addFact('f-no-sources', null);
      db.prepare(`INSERT INTO fact_revisions (id, fact_id, previous_fact, new_fact, source_exchange_id, created_at) VALUES ('r1', 'f-from-short', 'old', 'new', ?, 't')`).run(shortId);
      db.prepare(`INSERT INTO fact_revisions (id, fact_id, previous_fact, new_fact, source_exchange_id, created_at) VALUES ('r2', 'f-unrelated', 'old', 'new', 'other-exchange', 't')`).run();

      lines.push(assistantLine('답의 뒷부분', '2026-11-01T00:00:02Z'));
      fs.writeFileSync(file, lines.join('\n'));
      const [longId] = await indexFile(db);
      expect(longId).not.toBe(shortId);

      const sources = Object.fromEntries((db.prepare('SELECT id, source_exchange_ids AS s, updated_at AS u FROM facts ORDER BY id').all() as Array<{ id: string; s: string | null; u: string }>).map((r) => [r.id, r]));
      expect(sources['f-from-short'].s).toBe(JSON.stringify(['other-exchange', longId]));
      expect(sources['f-unrelated'].s).toBe(JSON.stringify(['other-exchange']));
      expect(sources['f-no-sources'].s).toBeNull();
      expect(sources['f-from-short'].u).toBe('u'); // not a change of the fact itself
      expect(db.prepare('SELECT id, source_exchange_id AS s FROM fact_revisions ORDER BY id').all())
        .toEqual([{ id: 'r1', s: longId }, { id: 'r2', s: 'other-exchange' }]);
      // every exchange a fact names can be looked up (what trace_fact does)
      expect(db.prepare('SELECT count(*) AS n FROM exchanges WHERE id = ?').get(longId)).toEqual({ n: 1 });
      expect(db.prepare('SELECT count(*) AS n FROM exchanges WHERE id = ?').get(shortId)).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('other turns of the same file and the same line of another file are left alone', () => {
    const db = initDatabase();
    try {
      const mk = (id: string, archivePath: string, lineStart: number) => insertExchange(db, {
        id, project: 'proj', timestamp: '2026-11-01T00:00:00Z', userMessage: `q ${id}`, assistantMessage: `a ${id}`,
        archivePath, lineStart, lineEnd: lineStart + 1,
      }, EMB);
      mk('a-1', '/arch/a.jsonl', 1);
      mk('a-3', '/arch/a.jsonl', 3);
      mk('b-1', '/arch/b.jsonl', 1);
      mk('a-1-longer', '/arch/a.jsonl', 1);
      expect(db.prepare('SELECT id FROM exchanges ORDER BY id').all()).toEqual([{ id: 'a-1-longer' }, { id: 'a-3' }, { id: 'b-1' }]);
    } finally {
      db.close();
    }
  });

  it('isExchangeCurrent: true only for the same id at the current embedding version with its vector row', () => {
    const db = initDatabase();
    try {
      const ex = {
        id: 'cur-1', project: 'proj', timestamp: '2026-11-01T00:00:00Z', userMessage: 'q', assistantMessage: 'a',
        archivePath: '/arch/c.jsonl', lineStart: 1, lineEnd: 2,
      };
      expect(isExchangeCurrent(db, 'cur-1')).toBe(false);
      insertExchange(db, ex, EMB);
      expect(isExchangeCurrent(db, 'cur-1')).toBe(true);
      expect(isExchangeCurrent(db, 'other')).toBe(false);

      db.prepare('UPDATE exchanges SET embedding_version = ? WHERE id = ?').run(EMBEDDING_VERSION - 1, 'cur-1');
      expect(isExchangeCurrent(db, 'cur-1')).toBe(false);
      db.prepare('UPDATE exchanges SET embedding_version = ? WHERE id = ?').run(EMBEDDING_VERSION, 'cur-1');
      expect(isExchangeCurrent(db, 'cur-1')).toBe(true);

      db.prepare('DELETE FROM vec_exchanges WHERE id = ?').run('cur-1');
      expect(isExchangeCurrent(db, 'cur-1')).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('stored tool input is capped', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-toolinput-'));
    process.env.TEST_DB_PATH = path.join(dir, 'db.sqlite');
  });
  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const store = (toolInput: unknown): string | null => {
    const db = initDatabase();
    try {
      insertExchange(db, {
        id: 'ex-1', project: 'proj', timestamp: 't', userMessage: 'q', assistantMessage: 'a',
        archivePath: '/arch/t.jsonl', lineStart: 1, lineEnd: 2,
        toolCalls: [{ id: 'ex-1:0', exchangeId: 'ex-1', toolName: 'Write', toolInput, isError: false, timestamp: 't' }],
      }, EMB);
      return (db.prepare('SELECT tool_input FROM tool_calls').get() as { tool_input: string | null }).tool_input;
    } finally {
      db.close();
    }
  };

  // tool_calls was 35.9% of one live DB (1.5GB); the only reader of tool_input shows its first 300 characters.
  it('a 5KB input is stored at the cap, says how much was cut, and its first 300 characters are unchanged', () => {
    const input = { file_path: '/a/b.ts', content: 'x'.repeat(5000) };
    const full = JSON.stringify(input);
    const stored = store(input)!;
    expect(stored.length).toBeLessThan(TOOL_INPUT_MAX_CHARS + 60);
    expect(stored.startsWith(full.slice(0, TOOL_INPUT_MAX_CHARS))).toBe(true);
    expect(stored.slice(0, 300)).toBe(full.slice(0, 300));
    expect(stored).toMatch(new RegExp(`…\\[truncated: ${full.length - TOOL_INPUT_MAX_CHARS} more chars\\]$`));
  });

  it('an input within the cap is stored whole; no input is stored as NULL', () => {
    const input = { command: 'ls -la', description: '파일 목록' };
    expect(store(input)).toBe(JSON.stringify(input));
    expect(store(undefined)).toBeNull();
  });

  it('the cut never splits a character: the stored text is valid UTF-16 and round-trips through UTF-8', () => {
    // an astral character (two UTF-16 units) straddling the cap
    const head = JSON.stringify({ content: '' }).length - 2; // length of `{"content":"`
    const input = { content: 'a'.repeat(TOOL_INPUT_MAX_CHARS - head - 1) + '😀'.repeat(50) };
    expect(JSON.stringify(input).charCodeAt(TOOL_INPUT_MAX_CHARS - 1)).toBe(0xd83d); // the cap falls between the two halves
    const stored = store(input)!;
    expect(Buffer.from(stored, 'utf8').toString('utf8')).toBe(stored);
    expect(stored).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(stored).toMatch(/…\[truncated: \d+ more chars\]$/);
  });
});

describe('schema checks that run on every open', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-schema-'));
    process.env.TEST_DB_PATH = path.join(dir, 'db.sqlite');
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const indexNames = (db: Database.Database) =>
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>).map((r) => r.name);
  const plan = (db: Database.Database, sql: string) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(' | ');

  // The four product query shapes that carried `is_active = 1` next to a selective column.
  const FACT_QUERIES = [
    `SELECT * FROM facts WHERE ontology_category_id = 'x' AND is_active = 1`,
    `SELECT * FROM facts WHERE is_active = 1 AND scope_type = 'project' AND scope_project = 'x' ORDER BY consolidated_count DESC LIMIT 20`,
    `SELECT * FROM facts WHERE is_active = 1 AND scope_type = 'global' ORDER BY consolidated_count DESC LIMIT 20`,
    `SELECT * FROM facts WHERE category = 'decision' AND is_active = 1`,
  ];

  it('a fresh DB has no idx_facts_active and no fact query plans through it', () => {
    const db = initDatabase();
    try {
      expect(indexNames(db)).not.toContain('idx_facts_active');
      expect(indexNames(db)).toContain('idx_facts_active_created_id');
      for (const q of FACT_QUERIES) expect(plan(db, q), q).not.toMatch(/idx_facts_active\b(?!_)/);
    } finally {
      db.close();
    }
  });

  it('an existing DB that has idx_facts_active loses it on open, and opening again changes nothing', () => {
    const first = initDatabase();
    first.exec('CREATE INDEX idx_facts_active ON facts(is_active)');
    expect(plan(first, FACT_QUERIES[0])).toMatch(/idx_facts_active \(/);
    first.close();

    const db = initDatabase();
    try {
      expect(indexNames(db)).not.toContain('idx_facts_active');
      for (const q of FACT_QUERIES) expect(plan(db, q), q).not.toMatch(/idx_facts_active\b(?!_)/);
    } finally {
      db.close();
    }
    const again = initDatabase();
    try {
      expect(indexNames(again)).not.toContain('idx_facts_active');
    } finally {
      again.close();
    }
  });

  it('the (archive_path, line_start) index exists on a fresh DB and serves the snapshot lookup', () => {
    const db = initDatabase();
    try {
      expect(indexNames(db)).toContain(EXCHANGE_TURN_INDEX);
      expect(plan(db, `SELECT id FROM exchanges WHERE archive_path = 'p' AND line_start = 1 AND id <> 'x'`))
        .toMatch(new RegExp(`${EXCHANGE_TURN_INDEX} \\(archive_path=\\? AND line_start=\\?\\)`));
    } finally {
      db.close();
    }
  });

  it('a DB that already holds exchanges is NOT given the index on open (its build reads the whole table under the write lock)', () => {
    // An older build's DB: exchanges present, no (archive_path, line_start) index.
    const old = initDatabase();
    insertExchange(old, {
      id: 'old-1', project: 'p', timestamp: 't', userMessage: 'q', assistantMessage: 'a',
      archivePath: '/arch/a.jsonl', lineStart: 1, lineEnd: 2,
    }, EMB);
    old.exec(`DROP INDEX ${EXCHANGE_TURN_INDEX}`);
    old.close();

    const db = initDatabase();
    try {
      expect(indexNames(db)).not.toContain(EXCHANGE_TURN_INDEX);
      // the lookup still works, through the path index
      insertExchange(db, {
        id: 'new-1', project: 'p', timestamp: 't', userMessage: 'q', assistantMessage: 'a longer',
        archivePath: '/arch/a.jsonl', lineStart: 1, lineEnd: 3,
      }, EMB);
      expect(db.prepare('SELECT id FROM exchanges').all()).toEqual([{ id: 'new-1' }]);
    } finally {
      db.close();
    }
  });

  it('an UPDATE that does not touch the message columns leaves the FTS index untouched; a message UPDATE re-indexes it', () => {
    const db = initDatabase();
    try {
      insertExchange(db, {
        id: 'fts-1', project: 'p', timestamp: 't', userMessage: 'alpha question', assistantMessage: 'bravo answer',
        archivePath: '/arch/f.jsonl', lineStart: 1, lineEnd: 2,
      }, EMB);
      const ftsState = () => JSON.stringify(db.prepare('SELECT id, hex(block) AS b FROM exchanges_fts_data ORDER BY id').all());
      const before = ftsState();

      db.prepare('UPDATE exchanges SET embedding = NULL, embedding_version = ?, last_indexed = ? WHERE id = ?').run(EMBEDDING_VERSION, 123, 'fts-1');
      expect(ftsState()).toBe(before);

      db.prepare('UPDATE exchanges SET assistant_message = ? WHERE id = ?').run('charlie answer', 'fts-1');
      const hits = (term: string) => (db.prepare(`SELECT count(*) AS n FROM exchanges_fts WHERE exchanges_fts MATCH ?`).get(`"${term}"`) as { n: number }).n;
      expect(hits('charlie')).toBe(1);
      expect(hits('bravo')).toBe(0);
      expect(hits('alpha')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('an older DB whose update trigger has no column list gets the column-limited trigger on open, once', () => {
    const first = initDatabase();
    first.exec('DROP TRIGGER exchanges_fts_au');
    first.exec(`
      CREATE TRIGGER exchanges_fts_au AFTER UPDATE ON exchanges BEGIN
        INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)
        VALUES('delete', old.rowid, old.user_message, old.assistant_message);
        INSERT INTO exchanges_fts(rowid, user_message, assistant_message)
        VALUES (new.rowid, new.user_message, new.assistant_message);
      END
    `);
    first.close();

    const triggerSql = (db: Database.Database) =>
      (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'exchanges_fts_au'`).get() as { sql: string }).sql;
    const db = initDatabase();
    let sqlAfterFirstOpen: string;
    try {
      sqlAfterFirstOpen = triggerSql(db);
      expect(sqlAfterFirstOpen).toMatch(/AFTER UPDATE OF user_message, assistant_message ON exchanges/);
    } finally {
      db.close();
    }
    const again = initDatabase();
    try {
      expect(triggerSql(again)).toBe(sqlAfterFirstOpen);
      // an older process's CREATE TRIGGER IF NOT EXISTS does not bring the wide trigger back
      again.exec(`CREATE TRIGGER IF NOT EXISTS exchanges_fts_au AFTER UPDATE ON exchanges BEGIN SELECT 1; END`);
      expect(triggerSql(again)).toBe(sqlAfterFirstOpen);
    } finally {
      again.close();
    }
  });
});
