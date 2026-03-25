import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, suppressConsole } from './test-utils.js';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

// Mock LLM
vi.mock('../src/llm.js', () => ({
  callHaiku: vi.fn(),
  parseJsonResponse: vi.fn(),
}));

// Mock embeddings
vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
}));

import { callHaiku, parseJsonResponse } from '../src/llm.js';
import { askAvatar } from '../src/avatar-responder.js';

function initTestSchema(db: Database.Database) {
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      fact TEXT NOT NULL,
      category TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'project',
      scope_project TEXT,
      source_exchange_ids TEXT DEFAULT '[]',
      embedding BLOB,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      consolidated_count INTEGER DEFAULT 1,
      is_active BOOLEAN DEFAULT 1,
      ontology_category_id TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[384]
    );
    CREATE TABLE IF NOT EXISTS ontology_domains (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ontology_categories (
      id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ontology_relations (
      id TEXT PRIMARY KEY,
      source_fact_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      target_fact_id TEXT NOT NULL,
      reasoning TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function insertTestFact(db: Database.Database, id: string, fact: string, embedding: number[], project: string | null = 'test-project') {
  const now = new Date().toISOString();
  const embBuf = Buffer.from(new Float32Array(embedding).buffer);
  db.prepare(`
    INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, embedding, created_at, updated_at, consolidated_count, is_active)
    VALUES (?, ?, 'decision', 'project', ?, '[]', ?, ?, ?, 1, 1)
  `).run(id, fact, project, embBuf, now, now);
  db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, ?)').run(id, embBuf);
}

describe('avatar-responder', () => {
  let db: Database.Database;
  let cleanup: () => void;
  let restoreConsole: () => void;

  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
    initTestSchema(db);
    restoreConsole = suppressConsole();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreConsole();
    cleanup();
  });

  it('should return empty response when no facts found', async () => {
    const result = await askAvatar(db, 'What framework do I use?');
    expect(result.answer).toContain('관련된 과거 결정을 찾을 수 없습니다');
    expect(result.confidence).toBe(0);
    expect(result.sources).toEqual([]);
  });

  it('should return LLM-generated answer with cited sources', async () => {
    const emb = new Array(384).fill(0.1);
    insertTestFact(db, 'fact-react', 'Use React for all frontend projects', emb);

    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
      answer: 'React를 사용합니다.',
      confidence: 0.9,
      cited_fact_ids: ['fact-react'],
    });
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('{}');

    const result = await askAvatar(db, 'What frontend framework?', 'test-project');

    expect(result.answer).toBe('React를 사용합니다.');
    expect(result.confidence).toBe(0.9);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0].fact.id).toBe('fact-react');
  });

  it('should clamp confidence to [0, 1]', async () => {
    const emb = new Array(384).fill(0.1);
    insertTestFact(db, 'fact-x', 'Some fact', emb);

    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
      answer: 'Test',
      confidence: 1.5,
      cited_fact_ids: [],
    });
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('{}');

    const result = await askAvatar(db, 'question');
    expect(result.confidence).toBe(1);
  });

  it('should clamp negative confidence to 0', async () => {
    const emb = new Array(384).fill(0.1);
    insertTestFact(db, 'fact-y', 'Another fact', emb);

    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
      answer: 'Test',
      confidence: -0.5,
      cited_fact_ids: [],
    });
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('{}');

    const result = await askAvatar(db, 'question');
    expect(result.confidence).toBe(0);
  });

  it('should fallback to raw response when JSON parse fails', async () => {
    const emb = new Array(384).fill(0.1);
    insertTestFact(db, 'fact-z', 'Some fact', emb);

    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('Raw text response');

    const result = await askAvatar(db, 'question');
    expect(result.answer).toBe('Raw text response');
    expect(result.confidence).toBe(0);
    expect(result.sources).toEqual([]);
  });

  it('should handle missing confidence in LLM response', async () => {
    const emb = new Array(384).fill(0.1);
    insertTestFact(db, 'fact-w', 'A fact', emb);

    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
      answer: 'Answer',
      cited_fact_ids: [],
    });
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('{}');

    const result = await askAvatar(db, 'question');
    expect(result.confidence).toBe(0);
  });

  it('should include all sources when cited_fact_ids is empty', async () => {
    const emb = new Array(384).fill(0.1);
    insertTestFact(db, 'fact-a', 'Fact A', emb);
    insertTestFact(db, 'fact-b', 'Fact B', emb);

    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
      answer: 'Both facts',
      confidence: 0.8,
      cited_fact_ids: [],
    });
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('{}');

    const result = await askAvatar(db, 'question');
    expect(result.sources.length).toBe(2);
  });

  it('should calculate relevance scores for sources', async () => {
    const emb = new Array(384).fill(0.1);
    insertTestFact(db, 'fact-rel', 'Relevant fact', emb);

    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
      answer: 'Answer',
      confidence: 0.9,
      cited_fact_ids: ['fact-rel'],
    });
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('{}');

    const result = await askAvatar(db, 'question');
    expect(result.sources.length).toBe(1);
    expect(result.sources[0].relevance).toBeGreaterThan(0);
    expect(result.sources[0].relevance).toBeLessThanOrEqual(1);
  });
});
