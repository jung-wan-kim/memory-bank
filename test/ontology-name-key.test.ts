import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { initDatabase } from '../src/db.js';
import {
  ontologyNameKey,
  looseOntologyNameKey,
  ensureCategoryNameKeys,
  findCategoriesByNameKey,
  getCategoryByName,
  getDomainByName,
  createCategory,
  createDomain,
} from '../src/ontology-db.js';

describe('ontologyNameKey', () => {
  it.each([
    ['Memory-Bank Architecture', 'memorybankarchitecture'],
    ['memory bank  ARCHITECTURE', 'memorybankarchitecture'],
    ['MemoryBank_Architecture.', 'memorybankarchitecture'],
    ['CI/CD', 'cicd'],
    ['Testing & QA', 'testingandqa'],
    ['Testing and QA', 'testingandqa'],
    ['ＡＰＩ Design', 'apidesign'], // full-width letters (NFKC)
    ['상태 관리', '상태관리'],
  ])('%s → %s', (name, key) => {
    expect(ontologyNameKey(name)).toBe(key);
  });

  it('different names keep different keys', () => {
    expect(ontologyNameKey('State Management')).not.toBe(ontologyNameKey('State Machines'));
    expect(ontologyNameKey('Testing')).not.toBe(ontologyNameKey('Test'));
  });

  it('a name with no letter or digit is its own key, never the empty one', () => {
    expect(ontologyNameKey('  ??  ')).toBe('??');
    expect(ontologyNameKey('??')).not.toBe(ontologyNameKey('!!'));
  });
});

describe('looseOntologyNameKey', () => {
  it('folds a plural s, "and" and word order — and nothing else', () => {
    expect(looseOntologyNameKey('State Managements')).toBe(looseOntologyNameKey('State Management'));
    expect(looseOntologyNameKey('Policies & Access')).toBe(looseOntologyNameKey('Access Policy'));
    expect(looseOntologyNameKey('Access')).toBe('access'); // "ss" is not a plural
    expect(looseOntologyNameKey('State Management')).not.toBe(looseOntologyNameKey('State Machine'));
  });
});

describe('ontology_categories.name_key migration', () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-name-key-'));
    dbPath = path.join(dir, 'db.sqlite');
    process.env.TEST_DB_PATH = dbPath;
    db = initDatabase();
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const columns = (h: Database.Database = db) =>
    (h.prepare(`SELECT name FROM pragma_table_info('ontology_categories')`).all() as Array<{ name: string }>).map((c) => c.name);
  /** A row as code without the column writes it (1.7.9 and older, the sync import). */
  const legacyRow = (id: string, domainId: string, name: string, h: Database.Database = db) =>
    h.prepare(`INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, NULL, '2026-06-13T00:00:00.000Z')`)
      .run(id, domainId, name);
  const keys = () => Object.fromEntries(
    (db.prepare('SELECT id, name_key FROM ontology_categories').all() as Array<{ id: string; name_key: string | null }>).map((r) => [r.id, r.name_key]),
  );

  it('a database opened by initDatabase() has no name_key until the taxonomy is used', () => {
    expect(columns()).not.toContain('name_key');
  });

  it('adds the column and its index, fills every existing row, and a second run changes nothing', () => {
    const d = createDomain(db, 'Knowledge Management');
    legacyRow('c1', d.id, 'Memory-Bank Architecture');
    legacyRow('c2', d.id, 'Memory Bank Architecture');
    legacyRow('c3', d.id, 'Fact Extraction');

    expect(ensureCategoryNameKeys(db)).toBe(3);

    expect(columns()).toContain('name_key');
    expect(keys()).toEqual({ c1: 'memorybankarchitecture', c2: 'memorybankarchitecture', c3: 'factextraction' });
    const index = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_ontology_categories_name_key'`).get() as { sql: string } | undefined;
    expect(index?.sql).toMatch(/ontology_categories\(name_key\)/);

    const changesBefore = db.prepare('SELECT total_changes() AS n').get() as { n: number };
    expect(ensureCategoryNameKeys(db)).toBe(0);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changesBefore);
  });

  it('a second connection that already sees the column adds nothing and fills nothing', () => {
    const d = createDomain(db, 'Backend');
    legacyRow('c1', d.id, 'API Design');
    ensureCategoryNameKeys(db);

    const other = new Database(dbPath);
    sqliteVec.load(other);
    try {
      expect(ensureCategoryNameKeys(other)).toBe(0);
      expect(columns(other).filter((c) => c === 'name_key')).toHaveLength(1);
    } finally {
      other.close();
    }
  });

  it('a row written afterwards without the key (older process, sync import) is found by the next lookup', () => {
    const d = createDomain(db, 'Backend');
    createCategory(db, d.id, 'API Design'); // migrates
    legacyRow('late', d.id, 'Rate-Limiting');
    expect(keys()['late']).toBeNull();

    expect(getCategoryByName(db, 'rate limiting', d.id)?.id).toBe('late');
    expect(keys()['late']).toBe('ratelimiting');
    // …so the classifier's create path returns it instead of inserting a twin.
    expect(createCategory(db, d.id, 'Rate Limiting').id).toBe('late');
    expect((db.prepare('SELECT COUNT(*) AS n FROM ontology_categories').get() as { n: number }).n).toBe(2);
  });

  it('createCategory is idempotent on (domain, name key); another domain still gets its own row', () => {
    const a = createDomain(db, 'Frontend');
    const b = createDomain(db, 'Backend');
    const first = createCategory(db, a.id, 'State Management', 'first description');
    const again = createCategory(db, a.id, 'state-management', 'second description');
    const elsewhere = createCategory(db, b.id, 'State Management');

    expect(again).toEqual(first);
    expect(elsewhere.id).not.toBe(first.id);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ontology_categories').get() as { n: number }).n).toBe(2);
  });

  it('findCategoriesByNameKey orders namesakes by active facts, then age, then id', () => {
    const a = createDomain(db, 'A');
    const b = createDomain(db, 'B');
    legacyRow('old-empty', a.id, 'Deploy');
    db.prepare(`INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES ('new-empty', ?, 'deploy', NULL, '2026-07-01T00:00:00.000Z')`).run(b.id);
    db.prepare(`INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES ('used', ?, 'DEPLOY', NULL, '2026-08-01T00:00:00.000Z')`).run(b.id);
    const now = new Date().toISOString();
    const fact = db.prepare(`INSERT INTO facts (id, fact, category, scope_type, created_at, updated_at, is_active, ontology_category_id) VALUES (?, ?, 'decision', 'global', ?, ?, ?, ?)`);
    fact.run('f1', 'deploys run from main', now, now, 1, 'used');
    fact.run('f2', 'an inactive note about deploys', now, now, 0, 'new-empty');

    expect(findCategoriesByNameKey(db, 'deploy').map((c) => [c.id, c.active_facts])).toEqual([
      ['used', 1], ['old-empty', 0], ['new-empty', 0],
    ]);
    expect(findCategoriesByNameKey(db, 'deploy', b.id).map((c) => c.id)).toEqual(['used', 'new-empty']);
    expect(getCategoryByName(db, 'Deploy')).toEqual({
      id: 'used', domain_id: b.id, name: 'DEPLOY', description: null, created_at: '2026-08-01T00:00:00.000Z',
    });
  });

  it('getDomainByName: exact name first, then the name key', () => {
    const devops = createDomain(db, 'DevOps');
    expect(getDomainByName(db, 'devops')?.id).toBe(devops.id);
    expect(getDomainByName(db, 'Dev-Ops')?.id).toBe(devops.id);
    expect(getDomainByName(db, 'Dev Operations')).toBeNull();
  });
});
