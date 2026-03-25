import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, suppressConsole } from './test-utils.js';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

// Mock LLM module
vi.mock('../src/llm.js', () => ({
  callHaiku: vi.fn(),
  parseJsonResponse: vi.fn(),
}));

// Mock embeddings (avoid loading the model)
vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
}));

import { callHaiku, parseJsonResponse } from '../src/llm.js';
import { classifyFactToOntology, detectRelations, classifyAndLinkFact } from '../src/ontology-classifier.js';
import {
  createDomain,
  createCategory,
  getDomainByName,
  getRelationsForFact,
} from '../src/ontology-db.js';
import type { Fact } from '../src/types.js';

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
    CREATE TABLE IF NOT EXISTS fact_revisions (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL,
      previous_fact TEXT NOT NULL,
      new_fact TEXT NOT NULL,
      change_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function insertTestFact(db: Database.Database, id: string, fact: string, embedding: number[] | null, project: string = 'test-project') {
  const now = new Date().toISOString();
  const embBuf = embedding ? Buffer.from(new Float32Array(embedding).buffer) : null;
  db.prepare(`
    INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, embedding, created_at, updated_at, consolidated_count, is_active)
    VALUES (?, ?, 'decision', 'project', ?, '[]', ?, ?, ?, 1, 1)
  `).run(id, fact, project, embBuf, now, now);

  if (embedding) {
    db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, ?)').run(
      id, Buffer.from(new Float32Array(embedding).buffer)
    );
  }
}

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: 'fact-1',
    fact: 'Use TypeScript for all frontend projects',
    category: 'decision',
    scope_type: 'project',
    scope_project: 'test-project',
    source_exchange_ids: [],
    embedding: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    consolidated_count: 1,
    is_active: true,
    ...overrides,
  };
}

describe('ontology-classifier', () => {
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

  describe('classifyFactToOntology', () => {
    it('should create new domain and category from LLM response', async () => {
      (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        domain: 'Frontend',
        category: 'TypeScript',
        is_new_domain: true,
        is_new_category: true,
        domain_description: 'Frontend development',
        category_description: 'TypeScript usage patterns',
      });
      (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('{"domain":"Frontend"}');

      const fact = makeFact();
      const result = await classifyFactToOntology(db, fact);

      expect(result.domainId).toBeTruthy();
      expect(result.categoryId).toBeTruthy();

      const domain = getDomainByName(db, 'Frontend');
      expect(domain).toBeTruthy();
      expect(domain!.name).toBe('Frontend');
    });

    it('should reuse existing domain', async () => {
      const existingDomain = createDomain(db, 'Frontend', 'Frontend development');
      (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        domain: 'Frontend',
        category: 'React',
        is_new_domain: false,
        is_new_category: true,
        category_description: 'React patterns',
      });
      (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('{}');

      const fact = makeFact();
      const result = await classifyFactToOntology(db, fact);

      expect(result.domainId).toBe(existingDomain.id);
    });

    it('should reuse existing category within domain', async () => {
      const domain = createDomain(db, 'Frontend', 'Frontend dev');
      const category = createCategory(db, domain.id, 'TypeScript', 'TS patterns');

      (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        domain: 'Frontend',
        category: 'TypeScript',
        is_new_domain: false,
        is_new_category: false,
      });
      (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('{}');

      const fact = makeFact();
      const result = await classifyFactToOntology(db, fact);

      expect(result.domainId).toBe(domain.id);
      expect(result.categoryId).toBe(category.id);
    });

    it('should fallback to General/Misc on LLM parse failure', async () => {
      (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('invalid response');

      const fact = makeFact();
      const result = await classifyFactToOntology(db, fact);

      const domain = getDomainByName(db, 'General');
      expect(domain).toBeTruthy();
      expect(result.domainId).toBe(domain!.id);
    });
  });

  describe('detectRelations', () => {
    it('should skip when fact has no embedding', async () => {
      const fact = makeFact({ embedding: null });
      await detectRelations(db, fact);
      expect(callHaiku).not.toHaveBeenCalled();
    });

    it('should detect SUPPORTS relation between similar facts', async () => {
      const embeddingArr = new Array(384).fill(0.1);
      insertTestFact(db, 'existing-1', 'Always use strict TypeScript mode', embeddingArr);

      (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        has_relation: true,
        relation_type: 'SUPPORTS',
        reasoning: 'Both facts advocate for TypeScript usage',
      });
      (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('{}');

      const newFact = makeFact({
        id: 'fact-new',
        embedding: new Float32Array(embeddingArr),
      });

      await detectRelations(db, newFact);

      const relations = getRelationsForFact(db, 'fact-new');
      expect(relations.length).toBe(1);
      expect(relations[0].relation_type).toBe('SUPPORTS');
    });

    it('should skip self-references', async () => {
      const embeddingArr = new Array(384).fill(0.1);
      insertTestFact(db, 'fact-1', 'Use TypeScript', embeddingArr);

      const fact = makeFact({ embedding: new Float32Array(embeddingArr) });
      await detectRelations(db, fact);

      const relations = getRelationsForFact(db, 'fact-1');
      expect(relations.length).toBe(0);
    });

    it('should handle LLM errors gracefully', async () => {
      const embeddingArr = new Array(384).fill(0.1);
      insertTestFact(db, 'existing-2', 'Use React for UI', embeddingArr);

      (callHaiku as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API timeout'));

      const fact = makeFact({ id: 'new-fact', embedding: new Float32Array(embeddingArr) });
      await detectRelations(db, fact);
      // Should not throw
    });

    it('should not create relation when LLM says no relation', async () => {
      const embeddingArr = new Array(384).fill(0.1);
      insertTestFact(db, 'existing-3', 'Use PostgreSQL', embeddingArr);

      (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        has_relation: false,
        relation_type: null,
        reasoning: 'No meaningful relation',
      });
      (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('{}');

      const fact = makeFact({ id: 'unrelated', embedding: new Float32Array(embeddingArr) });
      await detectRelations(db, fact);

      const relations = getRelationsForFact(db, 'unrelated');
      expect(relations.length).toBe(0);
    });
  });

  describe('classifyAndLinkFact', () => {
    it('should skip non-existent fact', async () => {
      await classifyAndLinkFact(db, 'nonexistent-id');
      expect(callHaiku).not.toHaveBeenCalled();
    });

    it('should classify active fact', async () => {
      const embeddingArr = new Array(384).fill(0.1);
      insertTestFact(db, 'fact-classify', 'Use Vitest for testing', embeddingArr);

      (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        domain: 'Testing',
        category: 'Framework',
        is_new_domain: true,
        is_new_category: true,
        domain_description: 'Testing tools',
        category_description: 'Test frameworks',
      });
      (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('{}');

      await classifyAndLinkFact(db, 'fact-classify', embeddingArr);

      const domain = getDomainByName(db, 'Testing');
      expect(domain).toBeTruthy();
    });

    it('should attach embedding if fact lacks one', async () => {
      // Insert fact WITHOUT embedding
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at, consolidated_count, is_active)
        VALUES (?, ?, 'decision', 'project', 'test-project', '[]', ?, ?, 1, 1)`).run(
        'fact-no-emb', 'Use ESLint', now, now
      );

      (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        domain: 'Quality',
        category: 'Linting',
        is_new_domain: true,
        is_new_category: true,
      });
      (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('{}');

      const embeddingArr = new Array(384).fill(0.2);
      await classifyAndLinkFact(db, 'fact-no-emb', embeddingArr);

      const domain = getDomainByName(db, 'Quality');
      expect(domain).toBeTruthy();
    });

    it('should handle classification errors gracefully', async () => {
      const embeddingArr = new Array(384).fill(0.1);
      insertTestFact(db, 'fact-err', 'Error test', embeddingArr);

      (callHaiku as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LLM error'));

      // Should not throw
      await classifyAndLinkFact(db, 'fact-err', embeddingArr);
    });
  });
});
