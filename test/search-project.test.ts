import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, insertExchange } from '../src/db.js';
import { searchConversations } from '../src/search.js';
import { parseSearchArgs, SearchArgError } from '../src/search-args.js';
import type { ConversationExchange } from '../src/types.js';
import { suppressConsole } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// F3: `memory-bank search ... --project Quotation` must treat --project as a
// scope option (not a query concept) and filter results to that project.
const restoreConsole = suppressConsole();

function makeExchange(id: string, project: string, text: string): ConversationExchange {
  return {
    id,
    project,
    timestamp: '2026-01-01T00:00:00Z',
    userMessage: text,
    assistantMessage: `response about ${text}`,
    archivePath: `/tmp/f3-${id}.jsonl`,
    lineStart: 1,
    lineEnd: 2,
  };
}

describe('searchConversations project filter (F3)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-search-project-'));
    process.env.TEST_DB_PATH = path.join(testDir, 'test.db');

    const db = initDatabase();
    const embedding = new Array(384).fill(0);
    // Project names are stored as encoded paths (as the indexer records them).
    insertExchange(db, makeExchange('q1', '-Users-juntea-Quotation', 'project-scoped memory alpha'), embedding);
    insertExchange(db, makeExchange('q2', '-Users-juntea-OtherProject', 'project-scoped memory alpha'), embedding);
    db.close();
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('scopes results to the given project (substring of encoded project path)', async () => {
    const results = await searchConversations('project-scoped memory', {
      mode: 'text',
      project: 'Quotation',
    });
    expect(results.length).toBe(1);
    expect(results[0].exchange.project).toBe('-Users-juntea-Quotation');
  });

  it('does not leak foreign-project records', async () => {
    const results = await searchConversations('project-scoped memory', {
      mode: 'text',
      project: 'Quotation',
    });
    expect(results.some(r => r.exchange.project.includes('OtherProject'))).toBe(false);
  });

  it('scopes to OtherProject when requested', async () => {
    const results = await searchConversations('project-scoped memory', {
      mode: 'text',
      project: 'OtherProject',
    });
    expect(results.length).toBe(1);
    expect(results[0].exchange.project).toBe('-Users-juntea-OtherProject');
  });

  it('returns both projects when no project filter is set (preserves existing behavior)', async () => {
    const results = await searchConversations('project-scoped memory', { mode: 'text' });
    const projects = new Set(results.map(r => r.exchange.project));
    expect(projects.has('-Users-juntea-Quotation')).toBe(true);
    expect(projects.has('-Users-juntea-OtherProject')).toBe(true);
  });
});

describe('parseSearchArgs --project parsing (F3)', () => {
  it('treats --project as a scope option, not a query term (exact F3 shape)', () => {
    const parsed = parseSearchArgs(['--text', '--project', 'Quotation', 'project-scoped memory']);
    expect(parsed.project).toBe('Quotation');
    expect(parsed.queries).toEqual(['project-scoped memory']);
    expect(parsed.mode).toBe('text');
    expect(parsed.help).toBe(false);
  });

  it('parses --project regardless of position relative to query', () => {
    expect(parseSearchArgs(['--project', 'Quotation', 'hello'])).toMatchObject({
      project: 'Quotation',
      queries: ['hello'],
    });
    expect(parseSearchArgs(['hello', '--project', 'Quotation'])).toMatchObject({
      project: 'Quotation',
      queries: ['hello'],
    });
  });

  it('rejects --project with no value (malformed option use at the boundary)', () => {
    expect(() => parseSearchArgs(['--project'])).toThrow(SearchArgError);
    expect(() => parseSearchArgs(['--text', '--project'])).toThrow(SearchArgError);
  });

  it('preserves existing query and option behavior', () => {
    const parsed = parseSearchArgs(['--after', '2026-01-01', '--limit', '5', 'hello world']);
    expect(parsed.after).toBe('2026-01-01');
    expect(parsed.limit).toBe(5);
    expect(parsed.queries).toEqual(['hello world']);
    expect(parsed.project).toBeUndefined();
  });

  it('defaults mode to both and limit to 10', () => {
    const parsed = parseSearchArgs(['hello']);
    expect(parsed.mode).toBe('both');
    expect(parsed.limit).toBe(10);
  });

  it('surfaces help requests', () => {
    expect(parseSearchArgs(['--help']).help).toBe(true);
    expect(parseSearchArgs(['-h']).help).toBe(true);
  });
});

afterEach(() => {
  restoreConsole();
});
