import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { suppressConsole } from './test-utils.js';

// Mock embeddings (avoid loading the model)
vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.05)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
}));

const originalEnv = { ...process.env };

describe('sync-export/import', () => {
  let tmpDir: string;
  let restoreConsole: () => void;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-sync-'));
    process.env.MEMORY_BANK_CONFIG_DIR = tmpDir;
    delete process.env.TEST_DB_PATH;
    delete process.env.MEMORY_BANK_DB_PATH;
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    Object.keys(process.env).forEach(key => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should export empty database', async () => {
    const { exportForSync } = await import('../src/sync-export.js');
    const result = exportForSync();
    expect(result.facts).toBe(0);
    expect(result.domains).toBe(0);
    expect(result.categories).toBe(0);
    expect(result.relations).toBe(0);
  });

  it('should create sync directory', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    const dir = getSyncDir();
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir).toContain('sync');
  });

  it('should export facts and ontology to JSONL', async () => {
    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();

    try {
      // Insert test data
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?, ?, ?, ?)`).run(
        'dom-1', 'Frontend', 'Frontend dev', now
      );
      db.prepare(`INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        'cat-1', 'dom-1', 'React', 'React patterns', now
      );
      db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at, consolidated_count, is_active, ontology_category_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'fact-1', 'Use React hooks', 'decision', 'project', 'test-proj', '[]', now, now, 1, 1, 'cat-1'
      );
      db.prepare(`INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
        'rel-1', 'fact-1', 'SUPPORTS', 'fact-1', 'self reference test', now
      );
    } finally {
      db.close();
    }

    const { exportForSync } = await import('../src/sync-export.js');
    const result = exportForSync();

    expect(result.facts).toBe(1);
    expect(result.domains).toBe(1);
    expect(result.categories).toBe(1);
    expect(result.relations).toBe(1);

    // Verify files exist
    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    expect(fs.existsSync(path.join(syncDir, 'facts.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(syncDir, 'ontology-domains.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(syncDir, 'ontology-categories.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(syncDir, 'ontology-relations.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(syncDir, 'meta.json'))).toBe(true);

    // Verify meta.json contents
    const meta = JSON.parse(fs.readFileSync(path.join(syncDir, 'meta.json'), 'utf-8'));
    expect(meta.facts_count).toBe(1);
    expect(meta.hostname).toBeTruthy();
    expect(meta.exported_at).toBeTruthy();
  });

  it('should import returns zeros when no sync files exist', async () => {
    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(0);
    expect(result.newDomains).toBe(0);
  });

  it('should import facts from JSONL files', async () => {
    // Create sync files manually
    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    const now = new Date().toISOString();

    fs.writeFileSync(path.join(syncDir, 'ontology-domains.jsonl'),
      JSON.stringify({ id: 'imp-dom-1', name: 'Backend', description: 'Backend dev', created_at: now }) + '\n'
    );
    fs.writeFileSync(path.join(syncDir, 'ontology-categories.jsonl'),
      JSON.stringify({ id: 'imp-cat-1', domain_id: 'imp-dom-1', name: 'API', description: 'API patterns', created_at: now }) + '\n'
    );
    fs.writeFileSync(path.join(syncDir, 'facts.jsonl'),
      JSON.stringify({
        id: 'imp-fact-1', fact: 'Use REST for APIs', category: 'decision',
        scope_type: 'project', scope_project: 'api-proj', source_exchange_ids: '[]',
        created_at: now, updated_at: now, consolidated_count: 1, ontology_category_id: 'imp-cat-1'
      }) + '\n'
    );
    fs.writeFileSync(path.join(syncDir, 'ontology-relations.jsonl'),
      JSON.stringify({
        id: 'imp-rel-1', source_fact_id: 'imp-fact-1', relation_type: 'INFLUENCES',
        target_fact_id: 'imp-fact-1', reasoning: 'test', created_at: now
      }) + '\n'
    );

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();

    expect(result.newDomains).toBe(1);
    expect(result.newCategories).toBe(1);
    expect(result.newFacts).toBe(1);
    expect(result.newRelations).toBe(1);
  });

  it('should skip duplicate records on re-import', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    const now = new Date().toISOString();

    const domainLine = JSON.stringify({ id: 'dup-dom', name: 'DevOps', description: 'DevOps', created_at: now });
    fs.writeFileSync(path.join(syncDir, 'ontology-domains.jsonl'), domainLine + '\n');
    fs.writeFileSync(path.join(syncDir, 'facts.jsonl'),
      JSON.stringify({
        id: 'dup-fact', fact: 'Use Docker', category: 'decision',
        scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
        created_at: now, updated_at: now, consolidated_count: 1, ontology_category_id: null
      }) + '\n'
    );

    const { importFromSync } = await import('../src/sync-import.js');

    // First import
    const first = await importFromSync();
    expect(first.newDomains).toBe(1);
    expect(first.newFacts).toBe(1);

    // Second import - should skip duplicates
    const second = await importFromSync();
    expect(second.newDomains).toBe(0);
    expect(second.newFacts).toBe(0);
  });

  it('should skip malformed JSONL lines', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    const now = new Date().toISOString();

    fs.writeFileSync(path.join(syncDir, 'facts.jsonl'),
      'not valid json\n' +
      JSON.stringify({
        id: 'valid-fact', fact: 'Valid fact', category: 'decision',
        scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
        created_at: now, updated_at: now, consolidated_count: 1, ontology_category_id: null
      }) + '\n'
    );

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(1); // Only the valid line
  });

  it('should round-trip export then import', async () => {
    // Insert data and export
    const { initDatabase } = await import('../src/db.js');
    let db = initDatabase();
    const now = new Date().toISOString();

    try {
      db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at, consolidated_count, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'rt-fact', 'Round trip test', 'pattern', 'global', null, '["ex-1"]', now, now, 2, 1
      );
    } finally {
      db.close();
    }

    const { exportForSync } = await import('../src/sync-export.js');
    exportForSync();

    // Delete the fact from DB
    db = initDatabase();
    try {
      db.prepare('DELETE FROM facts WHERE id = ?').run('rt-fact');
    } finally {
      db.close();
    }

    // Import should restore it
    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(1);

    // Verify fact is back
    db = initDatabase();
    try {
      const row = db.prepare('SELECT * FROM facts WHERE id = ?').get('rt-fact') as Record<string, unknown>;
      expect(row).toBeTruthy();
      expect(row['fact']).toBe('Round trip test');
      expect(row['category']).toBe('pattern');
    } finally {
      db.close();
    }
  });
});
