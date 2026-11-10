import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';

import { initDatabase } from '../src/db.js';
import { searchConversationsDetailed, searchNotes, getSearchDb, RARE_AGENT_ROWS } from '../src/search.js';

// F2 — with a coding_agent filter the keyword query let SQLite pick the join order, and without statistics
// it drove from idx_coding_agent: one keyword-index probe per row of that agent. On an index where every
// row is 'claude-code' (341,840 rows) a Korean query took 300 s and the server answered nothing meanwhile.
describe('keyword pass with a coding_agent filter', () => {
  let tmpDir: string;
  const prevDb = process.env.MEMORY_BANK_DB_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-agent-plan-'));
    process.env.MEMORY_BANK_DB_PATH = path.join(tmpDir, 'db.sqlite');
  });

  afterEach(() => {
    if (prevDb === undefined) delete process.env.MEMORY_BANK_DB_PATH; else process.env.MEMORY_BANK_DB_PATH = prevDb;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  interface Row { id: string; agent: string; user: string; timestamp?: string; sidechain?: boolean }

  /** Rows without vectors (the keyword pass does not need them) — thousands in one transaction. */
  function seed(rows: Row[]): void {
    const db = initDatabase();
    const insert = db.prepare(`
      INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end,
                             is_sidechain, coding_agent, embedding_version)
      VALUES (?, 'demo', ?, ?, 'an answer', ?, 1, 2, ?, ?, 1)
    `);
    db.transaction(() => {
      for (const r of rows) {
        insert.run(r.id, r.timestamp ?? '2026-10-01T00:00:00.000Z', r.user, `/seed/archive/${r.id}.jsonl`, r.sidechain ? 1 : 0, r.agent);
      }
    })();
    db.close();
  }

  const filler = (count: number, agent: string, word = 'filler'): Row[] =>
    Array.from({ length: count }, (_, i) => ({ id: `${agent}-${word}-${i}`, agent, user: `${word} turn number ${i}` }));

  /** Every statement the search prepares on its connection while `run` executes. */
  async function capture<T>(run: () => Promise<T>): Promise<{ value: T; sql: string[]; db: Database.Database }> {
    const db = getSearchDb();
    const sql: string[] = [];
    const original = db.prepare.bind(db);
    (db as { prepare: unknown }).prepare = (text: string) => { sql.push(text); return original(text); };
    try {
      return { value: await run(), sql, db };
    } finally {
      delete (db as { prepare?: unknown }).prepare;
    }
  }

  /** Query-plan steps of a captured keyword statement (its parameters are bound as NULL — the plan does not depend on them). */
  function plan(db: Database.Database, sql: string): string[] {
    const stmt = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
    const params = new Array((sql.match(/\?/g) ?? []).length).fill(null);
    return (stmt.all(...params) as Array<{ detail: string }>).map((step) => step.detail);
  }

  const keywordStatements = (sql: string[]): string[] =>
    sql.filter((text) => /exchanges_fts MATCH/.test(text) && /JOIN\s+exchanges AS e/.test(text));

  function expectKeywordIndexDrives(db: Database.Database, statements: string[]): void {
    expect(statements.length).toBeGreaterThan(0);
    for (const text of statements) {
      const steps = plan(db, text);
      // The keyword index is the outer loop, scanned once by its MATCH…
      expect(steps[0]).toMatch(/^SCAN fts VIRTUAL TABLE/);
      // …never probed once per exchange row (an "=" in the index string is a rowid lookup into the index).
      expect(steps.join(' | ')).not.toMatch(/fts VIRTUAL TABLE INDEX \d+:=/);
      expect(steps.join(' | ')).not.toMatch(/SEARCH e USING INDEX idx_(coding_agent|timestamp)/);
    }
  }

  it('an agent most rows carry: the keyword index is scanned once, not probed per row of the agent', async () => {
    seed([
      ...filler(RARE_AGENT_ROWS + 50, 'claude-code'),
      { id: 'hit-new', agent: 'claude-code', user: '텔레그램 알림을 보낸다', timestamp: '2026-10-05T00:00:00.000Z' },
      { id: 'hit-old', agent: 'claude-code', user: '텔레그램으로 알림이 온다', timestamp: '2025-02-01T00:00:00.000Z' },
      { id: 'other-agent', agent: 'codex', user: '텔레그램 알림 설정' },
      { id: 'one-word', agent: 'claude-code', user: '텔레그램 봇 토큰' },
    ]);

    const { value, sql, db } = await capture(() =>
      searchConversationsDetailed('텔레그램 알림', { mode: 'text', limit: 10, coding_agent: 'claude-code' }));
    expect(value.results.map((r) => r.exchange.id).sort()).toEqual(['hit-new', 'hit-old']);
    expect(value.meta.text).toEqual({ path: 'fts', truncated: false });
    expectKeywordIndexDrives(db, keywordStatements(sql));

    // with a date filter on top: same plan, the filter still applies
    const dated = await capture(() =>
      searchConversationsDetailed('텔레그램 알림', { mode: 'text', limit: 10, coding_agent: 'claude-code', after: '2026-01-01' }));
    expect(dated.value.results.map((r) => r.exchange.id)).toEqual(['hit-new']);
    expectKeywordIndexDrives(dated.db, keywordStatements(dated.sql));
  });

  it('a date filter alone keeps the same join order', async () => {
    seed([
      ...filler(40, 'claude-code'),
      { id: 'recent', agent: 'claude-code', user: 'paddle webhook retry', timestamp: '2026-10-05T00:00:00.000Z' },
      { id: 'old', agent: 'claude-code', user: 'paddle webhook retry', timestamp: '2025-02-01T00:00:00.000Z' },
    ]);
    const { value, sql, db } = await capture(() =>
      searchConversationsDetailed('paddle webhook', { mode: 'text', limit: 10, before: '2025-12-31' }));
    expect(value.results.map((r) => r.exchange.id)).toEqual(['old']);
    expectKeywordIndexDrives(db, keywordStatements(sql));
  });

  it('an agent few rows carry: its rows are found behind thousands of matches of another agent', async () => {
    seed([
      // every one of these matches the query word and belongs to the other agent
      ...filler(RARE_AGENT_ROWS + 50, 'claude-code', 'webhook'),
      { id: 'codex-1', agent: 'codex', user: 'the webhook arrives late' },
      { id: 'codex-2', agent: 'codex', user: 'webhook signature check' },
      { id: 'codex-noise', agent: 'codex', user: 'Warmup', sidechain: true },
      { id: 'codex-other', agent: 'codex', user: 'an unrelated question' },
    ]);

    const { value, sql, db } = await capture(() =>
      searchConversationsDetailed('webhook', { mode: 'text', limit: 10, coding_agent: 'codex' }));
    expect(value.results.map((r) => r.exchange.id).sort()).toEqual(['codex-1', 'codex-2']);
    expect(value.results.every((r) => r.exchange.codingAgent === 'codex')).toBe(true);
    expect(value.meta.text).toEqual({ path: 'fts', truncated: false });
    const statements = keywordStatements(sql);
    expectKeywordIndexDrives(db, statements);
    // The agent test is answered from the agent's own (short) row list — the exchange row of a match that
    // belongs to another agent is never opened for it.
    expect(statements.every((text) => /\+fts\.rowid IN \(SELECT/.test(text))).toBe(true);
  });

  it('an agent no row carries: nothing to scan, and the answer does not claim the search was cut short', async () => {
    seed([...filler(60, 'claude-code', 'webhook')]);

    const { value, sql } = await capture(() =>
      searchConversationsDetailed('webhook', { mode: 'text', limit: 10, coding_agent: 'opencode' }));
    expect(value.results).toEqual([]);
    expect(value.meta.text).toEqual({ path: 'fts', truncated: false });
    // no keyword query that reads exchange rows was even prepared
    expect(keywordStatements(sql)).toEqual([]);

    // the vector pass does not run either: it would scan to the sqlite-vec ceiling and call the result cut short
    const both = await searchConversationsDetailed('webhook', { mode: 'both', limit: 10, coding_agent: 'opencode' });
    expect(both.results).toEqual([]);
    expect(both.meta.vector).toEqual({ k: 0, candidates: 0, matched: 0, truncated: false });
    expect(searchNotes(both.meta)).toEqual([]);
  });
});
