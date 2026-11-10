import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { suppressConsole } from './test-utils.js';

/**
 * `index --rebuild` regenerates the conversation index and nothing else. It
 * used to unlink the database file — the one file that also holds facts, the
 * ontology and user tags, none of which the archive can bring back — while
 * other processes had it open.
 */

const calls = { summaries: 0, embeddings: 0 };
vi.mock('../src/summarizer.js', () => ({
  REFUSED_SUMMARY: '[No summary: the model declined to summarize this conversation.]',
  summarizeConversation: async () => { calls.summaries++; return 'A summary.'; },
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
const line = (type: 'user' | 'assistant', content: string) =>
  JSON.stringify({ type, message: { role: type, content }, timestamp: '2026-11-01T00:00:00Z' });
const conversation = (question: string) => [line('user', question), line('assistant', `answer to ${question}`)].join('\n');

let testDir: string;
let archiveDir: string;
let dbPath: string;
let restoreConsole: () => void;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-rebuild-'));
  archiveDir = path.join(testDir, 'archive');
  dbPath = path.join(testDir, 'db.sqlite');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.mkdirSync(path.join(testDir, 'projects'), { recursive: true });
  process.env.TEST_PROJECTS_DIR = path.join(testDir, 'projects');
  process.env.TEST_ARCHIVE_DIR = archiveDir;
  process.env.TEST_DB_PATH = dbPath;
  process.env.MEMORY_BANK_CONFIG_DIR = path.join(testDir, 'cfg');
  calls.summaries = 0;
  calls.embeddings = 0;
  restoreConsole = suppressConsole();
});
afterEach(() => {
  restoreConsole();
  delete process.env.TEST_PROJECTS_DIR;
  delete process.env.TEST_ARCHIVE_DIR;
  delete process.env.TEST_DB_PATH;
  delete process.env.MEMORY_BANK_CONFIG_DIR;
  fs.rmSync(testDir, { recursive: true, force: true });
});

const count = (db: Database.Database, table: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Facts, a tagged fact, a revision, taxonomy, relations, an extraction log row + `exchanges` indexed rows with tool calls. */
async function seed(exchanges = 5): Promise<void> {
  const { initDatabase, insertExchange } = await import('../src/db.js');
  const db = initDatabase();
  try {
    const now = '2026-11-01T00:00:00Z';
    const fact = db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at, is_active, tags)
      VALUES (?, ?, 'decision', 'global', NULL, '[]', ?, ?, ?, ?)`);
    fact.run('f1', 'Use WAL mode for the index database', now, now, 1, '["verified"]');
    fact.run('f2', 'Batch vec0 deletes in groups of 2000', now, now, 1, null);
    fact.run('f3', 'An older decision that was replaced', now, now, 0, null);
    db.prepare(`INSERT INTO fact_revisions (id, fact_id, previous_fact, new_fact, reason, created_at) VALUES ('r1', 'f2', 'old', 'new', 'evolved', ?)`).run(now);
    db.prepare(`INSERT INTO ontology_domains (id, name) VALUES ('d1', 'Storage')`).run();
    db.prepare(`INSERT INTO ontology_categories (id, domain_id, name) VALUES ('c1', 'd1', 'SQLite')`).run();
    db.prepare(`INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id) VALUES ('rel1', 'f1', 'SUPPORTS', 'f2')`).run();
    db.prepare(`INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id) VALUES ('rel2', 'f2', 'SUPERSEDES', 'f3')`).run();
    db.prepare(`INSERT INTO extraction_log (session_id, processed_at, extracted, saved) VALUES ('s1', ?, 3, 2)`).run(now);
    for (let i = 0; i < exchanges; i++) {
      insertExchange(db, {
        id: `ex-${i}`, project: 'proj', timestamp: now, userMessage: `zebra question ${i}`, assistantMessage: `answer ${i}`,
        archivePath: `/gone/elsewhere/${i}.jsonl`, lineStart: 1, lineEnd: 2,
        toolCalls: [{ id: `ex-${i}:0`, exchangeId: `ex-${i}`, toolName: 'Read', isError: false, timestamp: now }],
      }, EMB);
    }
  } finally {
    db.close();
  }
}

const FACT_TABLES = ['facts', 'fact_revisions', 'ontology_domains', 'ontology_categories', 'ontology_relations', 'extraction_log'];
/** Full content of the fact layer — what a rebuild must leave byte-for-byte alone. */
function factLayer(): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return JSON.stringify(FACT_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]));
  } finally {
    db.close();
  }
}

describe('clearConversationIndex', () => {
  it('empties exchanges, tool calls, vectors and the text index; facts and relations are not touched', async () => {
    await seed(5);
    const { initDatabase } = await import('../src/db.js');
    const { clearConversationIndex } = await import('../src/rebuild.js');
    const before = factLayer();
    const db = initDatabase();
    try {
      const vecDdlBefore = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'vec_exchanges'`).get() as { sql: string }).sql;
      expect(count(db, 'exchanges')).toBe(5);
      expect(count(db, 'tool_calls')).toBe(5);

      const cleared = clearConversationIndex(db, { batchSize: 2 });
      expect(cleared).toEqual({ exchanges: 5, toolCalls: 5 });
      expect(count(db, 'exchanges')).toBe(0);
      expect(count(db, 'tool_calls')).toBe(0);
      expect(count(db, 'vec_exchanges_rowids')).toBe(0);
      expect((db.prepare(`SELECT count(*) AS n FROM exchanges_fts WHERE exchanges_fts MATCH '"zebra"'`).get() as { n: number }).n).toBe(0);
      expect((db.prepare(`SELECT value FROM fts_meta WHERE key = 'exchanges_fts_built'`).get() as { value: string }).value).toBe('1');
      expect((db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'vec_exchanges'`).get() as { sql: string }).sql).toBe(vecDdlBefore);
      expect(count(db, 'facts')).toBe(3);
      expect(count(db, 'ontology_relations')).toBe(2);
    } finally {
      db.close();
    }
    expect(factLayer()).toBe(before);
  });

  it('the emptied index takes new exchanges again: row, vector, text match and delete trigger all work', async () => {
    await seed(3);
    const { initDatabase, insertExchange, deleteExchange } = await import('../src/db.js');
    const { clearConversationIndex } = await import('../src/rebuild.js');
    const db = initDatabase();
    try {
      clearConversationIndex(db, { batchSize: 2 });
      insertExchange(db, {
        id: 'new-1', project: 'proj', timestamp: 't', userMessage: 'quokka question', assistantMessage: 'answer',
        archivePath: '/arch/new.jsonl', lineStart: 1, lineEnd: 2,
      }, EMB);
      const hits = (term: string) => (db.prepare(`SELECT count(*) AS n FROM exchanges_fts WHERE exchanges_fts MATCH ?`).get(`"${term}"`) as { n: number }).n;
      expect(hits('quokka')).toBe(1);
      expect(count(db, 'vec_exchanges_rowids')).toBe(1);
      expect((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'exchanges_fts_ad'`).get() as { name: string }).name).toBe('exchanges_fts_ad');
      deleteExchange(db, 'new-1');
      expect(hits('quokka')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('a second connection that was open before the rebuild keeps reading and writing — during it and after it', async () => {
    await seed(7);
    const { initDatabase } = await import('../src/db.js');
    const { clearConversationIndex } = await import('../src/rebuild.js');
    const inodeBefore = fs.statSync(dbPath).ino;

    const other = initDatabase(); // e.g. a running MCP server
    const db = initDatabase();
    const seenDuring: number[] = [];
    let writesDuring = 0;
    try {
      expect(count(other, 'facts')).toBe(3);
      clearConversationIndex(db, {
        batchSize: 2,
        onBatch: () => {
          seenDuring.push(count(other, 'facts'));
          other.prepare(`INSERT INTO extraction_log (session_id, processed_at) VALUES (?, 't')`).run(`during-${writesDuring++}`);
        },
      });

      expect(seenDuring.length).toBeGreaterThanOrEqual(4);
      expect(new Set(seenDuring)).toEqual(new Set([3]));
      // after: the same handle still reads and writes the same file
      expect(count(other, 'facts')).toBe(3);
      expect(count(other, 'ontology_relations')).toBe(2);
      expect(count(other, 'exchanges')).toBe(0);
      other.prepare(`INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at) VALUES ('f-after', 'written after the rebuild', 'knowledge', 'global', '[]', 't', 't')`).run();
      expect(count(db, 'facts')).toBe(4);
      expect(count(other, 'extraction_log')).toBe(1 + writesDuring);
      expect(other.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
      other.close();
    }
    expect(fs.statSync(dbPath).ino).toBe(inodeBefore);
  });

  it('works on a DB whose text index was never backfilled (deleting through the trigger fails there)', async () => {
    // An older build's DB: exchanges rows that predate the FTS table.
    const old = new Database(dbPath);
    sqliteVec.load(old);
    old.exec(`CREATE TABLE exchanges (id TEXT PRIMARY KEY, project TEXT NOT NULL, timestamp TEXT NOT NULL, user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL, archive_path TEXT NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL);
      INSERT INTO exchanges VALUES ('old-1', 'p', 't', 'q1', 'a1', '/arch/a.jsonl', 1, 2);
      INSERT INTO exchanges VALUES ('old-2', 'p', 't', 'q2', 'a2', '/arch/a.jsonl', 3, 4);`);
    old.close();
    const { initDatabase } = await import('../src/db.js');
    const { clearConversationIndex } = await import('../src/rebuild.js');
    const db = initDatabase();
    try {
      expect((db.prepare(`SELECT value FROM fts_meta WHERE key = 'exchanges_fts_built'`).get() as { value: string }).value).toBe('0');
      expect(() => db.prepare(`DELETE FROM exchanges WHERE id = 'old-1'`).run()).toThrow(/malformed/);

      expect(clearConversationIndex(db).exchanges).toBe(2);
      expect(count(db, 'exchanges')).toBe(0);
      expect((db.prepare(`SELECT value FROM fts_meta WHERE key = 'exchanges_fts_built'`).get() as { value: string }).value).toBe('1');
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });
});

describe('resetVectorsAndTextIndex', () => {
  it('a row another process indexed meanwhile keeps its vector (same bytes) and its text match; vectors of deleted rows are gone', async () => {
    await seed(3);
    const { initDatabase } = await import('../src/db.js');
    const { resetVectorsAndTextIndex } = await import('../src/rebuild.js');
    const db = initDatabase();
    try {
      // ex-0 and ex-2 are gone as a clear leaves them (tool calls, then the row without the FTS trigger); their vectors are still in vec_exchanges
      db.exec('DROP TRIGGER exchanges_fts_ad');
      db.prepare(`DELETE FROM tool_calls WHERE exchange_id IN ('ex-0', 'ex-2')`).run();
      db.prepare(`DELETE FROM exchanges WHERE id IN ('ex-0', 'ex-2')`).run();
      const ddlBefore = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'vec_exchanges'`).get() as { sql: string }).sql;
      const bytesBefore = Buffer.from((db.prepare(`SELECT embedding FROM vec_exchanges WHERE id = 'ex-1'`).get() as { embedding: Buffer }).embedding);
      expect(count(db, 'vec_exchanges_rowids')).toBe(3);

      expect(resetVectorsAndTextIndex(db)).toEqual({ vectorsKept: 1 });

      expect(db.prepare('SELECT id FROM vec_exchanges_rowids').all()).toEqual([{ id: 'ex-1' }]);
      const bytesAfter = Buffer.from((db.prepare(`SELECT embedding FROM vec_exchanges WHERE id = 'ex-1'`).get() as { embedding: Buffer }).embedding);
      expect(bytesAfter.equals(bytesBefore)).toBe(true);
      expect((db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'vec_exchanges'`).get() as { sql: string }).sql).toBe(ddlBefore);
      // one chunk's worth of slots at most: the dead slots did not come along
      expect((db.prepare('SELECT count(*) AS n FROM vec_exchanges_chunks').get() as { n: number }).n).toBe(1);
      // the text index answers for the row that is there, and only for it
      expect(db.prepare(`SELECT e.id FROM exchanges_fts f JOIN exchanges e ON e.rowid = f.rowid WHERE exchanges_fts MATCH '"zebra"'`).all()).toEqual([{ id: 'ex-1' }]);
    } finally {
      db.close();
    }
  });
});

describe('backupFactLayer', () => {
  it('copies every fact-layer row into a new file and refuses to overwrite one', async () => {
    await seed(1);
    const { initDatabase } = await import('../src/db.js');
    const { backupFactLayer } = await import('../src/rebuild.js');
    const backupPath = path.join(testDir, 'backups', 'facts.sqlite');
    const db = initDatabase();
    try {
      expect(backupFactLayer(db, backupPath)).toEqual({
        facts: 3, fact_revisions: 1, ontology_domains: 1, ontology_categories: 1, ontology_relations: 2, extraction_log: 1,
      });
      expect(() => backupFactLayer(db, backupPath)).toThrow(/backup already exists/);
      // the connection is usable afterwards (the backup file is detached)
      expect(count(db, 'facts')).toBe(3);
    } finally {
      db.close();
    }
    const bak = new Database(backupPath, { readonly: true });
    try {
      expect(bak.prepare('SELECT id, fact, tags, is_active FROM facts ORDER BY id').all()).toEqual([
        { id: 'f1', fact: 'Use WAL mode for the index database', tags: '["verified"]', is_active: 1 },
        { id: 'f2', fact: 'Batch vec0 deletes in groups of 2000', tags: null, is_active: 1 },
        { id: 'f3', fact: 'An older decision that was replaced', tags: null, is_active: 0 },
      ]);
      expect(bak.prepare('SELECT id, relation_type FROM ontology_relations ORDER BY id').all())
        .toEqual([{ id: 'rel1', relation_type: 'SUPPORTS' }, { id: 'rel2', relation_type: 'SUPERSEDES' }]);
    } finally {
      bak.close();
    }
  });
});

describe('rebuildConversationIndex', () => {
  function writeArchive(rel: string, content: string): string {
    const p = path.join(archiveDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  }
  /** Index an archive file the way a sync did (parser ids), with one tool call per exchange. */
  async function indexFile(file: string, project = 'proj'): Promise<number> {
    const { initDatabase, insertExchange } = await import('../src/db.js');
    const { parseConversation } = await import('../src/parser.js');
    const db = initDatabase();
    try {
      const exchanges = await parseConversation(file, project, file);
      for (const ex of exchanges) {
        insertExchange(db, { ...ex, toolCalls: [{ id: `${ex.id}:0`, exchangeId: ex.id, toolName: 'Read', isError: false, timestamp: 't' }] }, EMB);
      }
      return exchanges.length;
    } finally {
      db.close();
    }
  }
  const exchangeState = () => {
    const d = new Database(dbPath, { readonly: true });
    try {
      return JSON.stringify({
        rows: d.prepare('SELECT id, last_indexed FROM exchanges ORDER BY id').all(),
        tools: count(d, 'tool_calls'), vectors: count(d, 'vec_exchanges_rowids'),
      });
    } finally {
      d.close();
    }
  };
  const backupDir = () => path.join(testDir, 'cfg', 'conversation-index', 'backups');

  it('without yes: says what stays and what goes, and changes nothing', async () => {
    await seed(0);
    const a = writeArchive('proj-a/11111111-1111-1111-1111-111111111111.jsonl', [conversation('q1'), conversation('q2')].join('\n'));
    expect(await indexFile(a)).toBe(2);
    const { rebuildConversationIndex, RebuildNotConfirmedError } = await import('../src/rebuild.js');
    const before = factLayer();
    const exchangesBefore = exchangeState();

    let thrown: unknown;
    try { await rebuildConversationIndex(); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(RebuildNotConfirmedError);
    const err = thrown as InstanceType<typeof RebuildNotConfirmedError>;
    expect(err.counts.preserved).toMatchObject({ facts: 3, activeFacts: 2, taggedFacts: 1, relations: 2, revisions: 1, categories: 1, domains: 1, extractionLog: 1 });
    expect(err.counts.cleared).toEqual({ exchanges: 2, toolCalls: 2, vectors: 2 });
    expect(err.reach).toMatchObject({ archiveConversations: 1, unreachable: { exchanges: 0, files: 0 } });

    expect(factLayer()).toBe(before);
    expect(exchangeState()).toBe(exchangesBefore);
    expect(fs.existsSync(backupDir())).toBe(false);
  });

  it('with yes: facts and relations are unchanged, a backup of them exists, and the index is re-created from the ARCHIVE', async () => {
    await seed(0);
    // In the archive only — the projects dir (what the old rebuild re-indexed from) is empty.
    const a = writeArchive('proj-a/11111111-1111-1111-1111-111111111111.jsonl', conversation('how do we deploy'));
    const b = writeArchive('proj-b/22222222-2222-2222-2222-222222222222.jsonl', [conversation('first question'), conversation('second question')].join('\n'));
    await indexFile(a, 'proj-a');
    // b was never indexed; it is, after the rebuild
    const summary = a.replace('.jsonl', '-summary.txt');
    fs.writeFileSync(summary, 'An existing summary.');
    const { rebuildConversationIndex } = await import('../src/rebuild.js');
    const before = factLayer();
    const inodeBefore = fs.statSync(dbPath).ino;
    calls.embeddings = 0;

    const result = await rebuildConversationIndex({ yes: true });

    expect(factLayer()).toBe(before);
    expect(fs.statSync(dbPath).ino).toBe(inodeBefore);
    expect(result.cleared).toEqual({ exchanges: 1, toolCalls: 1 });
    expect(result.counts.preserved.facts).toBe(3);
    expect(result.counts.preserved.relations).toBe(2);
    expect(result.reach.unreachable).toEqual({ exchanges: 0, files: 0 });
    expect(result.lostExchangesBackupPath).toBeNull();

    const bak = new Database(result.backupPath, { readonly: true });
    try {
      expect(count(bak, 'facts')).toBe(3);
      expect(count(bak, 'ontology_relations')).toBe(2);
    } finally {
      bak.close();
    }

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT archive_path, user_message FROM exchanges ORDER BY archive_path, line_start').all()).toEqual([
        { archive_path: a, user_message: 'how do we deploy' },
        { archive_path: b, user_message: 'first question' },
        { archive_path: b, user_message: 'second question' },
      ]);
      expect(count(db, 'vec_exchanges_rowids')).toBe(3);
      expect(count(db, 'facts')).toBe(3);
      expect(count(db, 'ontology_relations')).toBe(2);
    } finally {
      db.close();
    }
    expect(result.reindex.indexedExchanges).toBe(3);
    expect(calls.embeddings).toBe(3);

    // summaries are files, not index: kept, none written, no LLM call
    expect(fs.readFileSync(summary, 'utf8')).toBe('An existing summary.');
    expect(fs.existsSync(b.replace('.jsonl', '-summary.txt'))).toBe(false);
    expect(calls.summaries).toBe(0);
    expect(result.removedSummaries).toBeNull();
    expect(result.missingSummaries).toBe(1);
  });

  it('refuses — changing nothing — when indexed exchanges cannot be re-created: file in a sub-folder, or gone', async () => {
    await seed(0);
    const top = writeArchive('proj/11111111-1111-1111-1111-111111111111.jsonl', conversation('a top-level conversation'));
    const deep = writeArchive('proj/session-1/subagents/agent-a1.jsonl', [conversation('sub-agent task 1'), conversation('sub-agent task 2')].join('\n'));
    const gone = writeArchive('proj/33333333-3333-3333-3333-333333333333.jsonl', conversation('a conversation whose file was removed'));
    await indexFile(top);
    await indexFile(deep);
    await indexFile(gone);
    fs.unlinkSync(gone);
    const { rebuildConversationIndex, RebuildWouldLoseIndexError } = await import('../src/rebuild.js');
    const before = factLayer();
    const exchangesBefore = exchangeState();

    let thrown: unknown;
    try { await rebuildConversationIndex({ yes: true }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(RebuildWouldLoseIndexError);
    const err = thrown as InstanceType<typeof RebuildWouldLoseIndexError>;
    expect(err.reach.unreachable).toEqual({ exchanges: 3, files: 2 });
    expect(new Set(err.reach.unreachablePaths)).toEqual(new Set([deep, gone]));
    expect(err.message).toMatch(/3 indexed exchange\(s\) from 2 file\(s\) cannot be re-created/);
    expect(err.message).toMatch(/--allow-index-loss/);

    expect(factLayer()).toBe(before);
    expect(exchangeState()).toBe(exchangesBefore);
    expect(fs.existsSync(backupDir())).toBe(false);
    expect(calls.embeddings).toBe(0);
  });

  it('allowIndexLoss: goes ahead, and the exchanges that will not come back are backed up first', async () => {
    await seed(0);
    const top = writeArchive('proj/11111111-1111-1111-1111-111111111111.jsonl', conversation('a top-level conversation'));
    const deep = writeArchive('proj/session-1/subagents/agent-a1.jsonl', [conversation('sub-agent task 1'), conversation('sub-agent task 2')].join('\n'));
    await indexFile(top);
    await indexFile(deep);
    const { rebuildConversationIndex } = await import('../src/rebuild.js');
    const before = factLayer();

    const result = await rebuildConversationIndex({ yes: true, allowIndexLoss: true });

    expect(factLayer()).toBe(before);
    expect(result.cleared).toEqual({ exchanges: 3, toolCalls: 3 });
    expect(result.lostExchangesBackupPath).not.toBeNull();
    const bak = new Database(result.lostExchangesBackupPath!, { readonly: true });
    try {
      expect(bak.prepare('SELECT user_message, archive_path FROM exchanges ORDER BY line_start').all()).toEqual([
        { user_message: 'sub-agent task 1', archive_path: deep },
        { user_message: 'sub-agent task 2', archive_path: deep },
      ]);
      expect(count(bak, 'tool_calls')).toBe(2);
    } finally {
      bak.close();
    }
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT archive_path, user_message FROM exchanges').all()).toEqual([{ archive_path: top, user_message: 'a top-level conversation' }]);
    } finally {
      db.close();
    }
  });

  it('resetSummaries also deletes the summary files (and still makes no LLM call)', async () => {
    await seed(0);
    const a = writeArchive('proj-a/11111111-1111-1111-1111-111111111111.jsonl', conversation('how do we deploy'));
    await indexFile(a, 'proj-a');
    const summary = a.replace('.jsonl', '-summary.txt');
    fs.writeFileSync(summary, 'An existing summary.');
    const { rebuildConversationIndex } = await import('../src/rebuild.js');

    const result = await rebuildConversationIndex({ yes: true, resetSummaries: true });
    expect(result.removedSummaries).toBe(1);
    expect(fs.existsSync(summary)).toBe(false);
    expect(calls.summaries).toBe(0);
    expect(result.missingSummaries).toBe(1);
  });
});
