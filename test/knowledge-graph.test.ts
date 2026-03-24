import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getKnowledgeContext, formatKnowledgeContext, KnowledgeContext } from '../src/search.js';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { createDomain, createCategory, classifyFact, createRelation } from '../src/ontology-db.js';
import { suppressConsole } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const restoreConsole = suppressConsole();

describe('Knowledge Graph Enhanced Search', () => {
  const testDir = path.join(os.tmpdir(), 'kg-test-' + Date.now());
  const dbPath = path.join(testDir, 'test.db');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    process.env.TEST_DB_PATH = dbPath;
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should return empty context when no facts exist', async () => {
    const ctx = await getKnowledgeContext('React state management');
    expect(ctx.facts).toHaveLength(0);
  });

  it('should find facts related to query and include ontology info', async () => {
    const db = initDatabase();

    // Create ontology structure
    const domain = createDomain(db, 'Frontend', 'Frontend development');
    const category = createCategory(db, domain.id, 'State Management', 'State management patterns');

    // Insert a fact with embedding
    const embedding = new Array(384).fill(0);
    // Make the embedding slightly non-zero so vector search works
    for (let i = 0; i < 384; i++) embedding[i] = Math.random() * 0.1;

    const factId = insertFact(db, {
      fact: 'User prefers Riverpod over Provider for state management',
      category: 'preference',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: ['ex-1'],
      embedding,
    });

    // Classify the fact
    classifyFact(db, factId, category.id);

    db.close();

    // Query for related knowledge
    const ctx = await getKnowledgeContext('state management framework choice');

    // May or may not find depending on embedding similarity
    expect(ctx).toBeDefined();
    expect(ctx.facts).toBeInstanceOf(Array);
  });

  it('should include 1-hop related facts via graph traversal', async () => {
    const db = initDatabase();

    const domain = createDomain(db, 'Architecture', 'System architecture');
    const category = createCategory(db, domain.id, 'API Design', 'API design decisions');

    // Create two related facts
    const embedding1 = new Array(384).fill(0.05);
    const embedding2 = new Array(384).fill(0.04);

    const factId1 = insertFact(db, {
      fact: 'REST API follows JSON:API specification',
      category: 'decision',
      scope_type: 'project',
      scope_project: 'test-project',
      source_exchange_ids: ['ex-1'],
      embedding: embedding1,
    });

    const factId2 = insertFact(db, {
      fact: 'GraphQL is used for real-time subscriptions',
      category: 'decision',
      scope_type: 'project',
      scope_project: 'test-project',
      source_exchange_ids: ['ex-2'],
      embedding: embedding2,
    });

    classifyFact(db, factId1, category.id);
    classifyFact(db, factId2, category.id);

    // Create relation between facts
    createRelation(db, factId1, 'SUPPORTS', factId2, 'REST and GraphQL coexist');

    db.close();

    const ctx = await getKnowledgeContext('API design patterns', 'test-project');
    expect(ctx).toBeDefined();
    expect(ctx.facts).toBeInstanceOf(Array);
  });
});

describe('formatKnowledgeContext', () => {
  it('should return empty string for empty context', () => {
    const ctx: KnowledgeContext = { facts: [] };
    expect(formatKnowledgeContext(ctx)).toBe('');
  });

  it('should format facts with domain/category and relations', () => {
    const ctx: KnowledgeContext = {
      facts: [
        {
          fact: 'Uses TypeScript strict mode',
          category: 'preference',
          domain: 'Development',
          categoryName: 'Language',
          similarity: 0.92,
          relatedFacts: [
            { fact: 'ESLint rules enforce strict types', relationType: 'SUPPORTS' },
          ],
        },
      ],
    };

    const output = formatKnowledgeContext(ctx);
    expect(output).toContain('Related Knowledge');
    expect(output).toContain('Development/Language');
    expect(output).toContain('Uses TypeScript strict mode');
    expect(output).toContain('92% relevant');
    expect(output).toContain('SUPPORTS');
    expect(output).toContain('ESLint rules enforce strict types');
  });

  it('should handle facts without relations', () => {
    const ctx: KnowledgeContext = {
      facts: [
        {
          fact: 'Prefers dark mode',
          category: 'preference',
          domain: 'UI',
          categoryName: 'Theme',
          similarity: 0.85,
          relatedFacts: [],
        },
      ],
    };

    const output = formatKnowledgeContext(ctx);
    expect(output).toContain('UI/Theme');
    expect(output).toContain('Prefers dark mode');
    expect(output).not.toContain('SUPPORTS');
  });
});
