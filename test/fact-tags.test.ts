import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './test-utils.js';
import {
  normalizeTag,
  parseTags,
  getFactTags,
  addFactTags,
  removeFactTags,
  setFactTags,
  listTags,
  findFactsByTags,
  MAX_TAGS_PER_FACT,
} from '../src/fact-db.js';

const PROJECT = '/tmp/tag-test-project';

/** Minimal facts table mirroring the production schema, including the `tags`
 *  column added by migrateSchema. initDatabase() resolves a real config path,
 *  so tests build the table directly (same approach as avatar-responder.test). */
function initTestSchema(db: Database.Database): void {
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
      ontology_category_id TEXT,
      fact_kr TEXT,
      coding_agent TEXT DEFAULT 'claude-code',
      embedding_version INTEGER NOT NULL DEFAULT 2,
      tags TEXT
    );
  `);
}

function seedFact(db: Database.Database, id: string, project: string | null = PROJECT): void {
  db.prepare(
    `INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids,
                        created_at, updated_at, consolidated_count, is_active, embedding_version)
     VALUES (?, ?, 'decision', ?, ?, '[]', datetime('now'), datetime('now'), 1, 1, 1)`
  ).run(id, `fact ${id}`, project ? 'project' : 'global', project);
}

describe('fact tags', () => {
  let db: Database.Database;
  let cleanup: () => void;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    initTestSchema(db);
    seedFact(db, 'f1');
  });

  afterEach(() => cleanup());

  describe('normalizeTag', () => {
    it('lowercases and collapses whitespace to hyphens', () => {
      expect(normalizeTag('  Needs   Check ')).toBe('needs-check');
    });

    it('accepts Korean and the allowed symbol set', () => {
      expect(normalizeTag('결제')).toBe('결제');
      expect(normalizeTag('api/v2_beta.1:draft')).toBe('api/v2_beta.1:draft');
    });

    it('rejects values that could break JSON encoding or LIKE matching', () => {
      expect(normalizeTag('bad"tag')).toBeNull();
      expect(normalizeTag('bad\\tag')).toBeNull();
      expect(normalizeTag('   ')).toBeNull();
      expect(normalizeTag('x'.repeat(65))).toBeNull();
    });
  });

  describe('parseTags', () => {
    it('degrades to [] on hand-corrupted values instead of throwing', () => {
      // A row edited via sqlite3 must not take down every read path.
      expect(parseTags('not json')).toEqual([]);
      expect(parseTags('{"a":1}')).toEqual([]);
      expect(parseTags(null)).toEqual([]);
      expect(parseTags('["ok", 42, ""]')).toEqual(['ok']);
    });
  });

  describe('add / remove / set', () => {
    it('starts empty and adds normalized tags', () => {
      expect(getFactTags(db, 'f1')).toEqual([]);
      expect(addFactTags(db, 'f1', ['Verified', 'Mobile']).tags).toEqual(['verified', 'mobile']);
    });

    it('is a set union — duplicates are reported as not added', () => {
      addFactTags(db, 'f1', ['verified']);
      const r = addFactTags(db, 'f1', ['VERIFIED']);
      expect(r.added).toEqual([]);
      expect(r.tags).toEqual(['verified']);
    });

    it('rejects the whole call when any tag is invalid (no partial apply)', () => {
      addFactTags(db, 'f1', ['keep']);
      expect(() => addFactTags(db, 'f1', ['ok', 'bad"tag'])).toThrow(/invalid tag/);
      expect(getFactTags(db, 'f1')).toEqual(['keep']);
    });

    it('enforces the per-fact tag ceiling', () => {
      const many = Array.from({ length: MAX_TAGS_PER_FACT }, (_, i) => `t${i}`);
      expect(setFactTags(db, 'f1', many)).toHaveLength(MAX_TAGS_PER_FACT);
      expect(() => addFactTags(db, 'f1', ['one-too-many'])).toThrow(/too many tags/);
    });

    it('reports absent tags on remove rather than failing', () => {
      addFactTags(db, 'f1', ['a', 'b']);
      const r = removeFactTags(db, 'f1', ['b', 'never-set']);
      expect(r.removed).toEqual(['b']);
      expect(r.absent).toContain('never-set');
      expect(r.tags).toEqual(['a']);
    });

    it('clears tags with set([]) and stores NULL, not "[]"', () => {
      addFactTags(db, 'f1', ['a']);
      expect(setFactTags(db, 'f1', [])).toEqual([]);
      const row = db.prepare('SELECT tags FROM facts WHERE id = ?').get('f1') as { tags: string | null };
      expect(row.tags).toBeNull();
    });

    it('fails loud on an unknown fact id', () => {
      expect(() => addFactTags(db, 'no-such-fact', ['x'])).toThrow(/fact not found/);
      expect(() => getFactTags(db, 'no-such-fact')).toThrow(/fact not found/);
    });
  });

  describe('findFactsByTags', () => {
    beforeEach(() => {
      seedFact(db, 'f2');
      seedFact(db, 'f3');
      addFactTags(db, 'f1', ['mobile', 'verified']);
      addFactTags(db, 'f2', ['mobile']);
      addFactTags(db, 'f3', ['api-v2']);
    });

    it('requires every tag by default', () => {
      const ids = findFactsByTags(db, ['mobile', 'verified'], { project: PROJECT }).map(f => f.id);
      expect(ids).toEqual(['f1']);
    });

    it('matches any tag when asked', () => {
      const ids = findFactsByTags(db, ['verified', 'api-v2'], { project: PROJECT, match: 'any' })
        .map(f => f.id)
        .sort();
      expect(ids).toEqual(['f1', 'f3']);
    });

    it('does not prefix-match — "api" must not hit "api-v2"', () => {
      // The LIKE pattern includes the surrounding JSON quotes precisely so a
      // shorter tag cannot match a longer one.
      expect(findFactsByTags(db, ['api'], { project: PROJECT })).toHaveLength(0);
    });

    it('returns facts with their tags parsed', () => {
      const [fact] = findFactsByTags(db, ['api-v2'], { project: PROJECT });
      expect(fact.tags).toEqual(['api-v2']);
    });

    it('excludes inactive facts unless asked', () => {
      db.prepare('UPDATE facts SET is_active = 0 WHERE id = ?').run('f2');
      expect(findFactsByTags(db, ['mobile'], { project: PROJECT }).map(f => f.id)).toEqual(['f1']);
      const withInactive = findFactsByTags(db, ['mobile'], { project: PROJECT, includeInactive: true });
      expect(withInactive.map(f => f.id).sort()).toEqual(['f1', 'f2']);
    });

    it('crosses project scope — a tag groups facts the project filter would split', () => {
      seedFact(db, 'g1', null); // global scope
      addFactTags(db, 'g1', ['mobile']);
      const ids = findFactsByTags(db, ['mobile'], { project: PROJECT }).map(f => f.id).sort();
      expect(ids).toEqual(['f1', 'f2', 'g1']);
    });
  });

  describe('listTags', () => {
    it('counts tags across facts, most used first', () => {
      seedFact(db, 'f2');
      addFactTags(db, 'f1', ['mobile', 'verified']);
      addFactTags(db, 'f2', ['mobile']);
      expect(listTags(db, { project: PROJECT })).toEqual([
        { tag: 'mobile', count: 2 },
        { tag: 'verified', count: 1 },
      ]);
    });

    it('returns an empty index when nothing is tagged', () => {
      expect(listTags(db, { project: PROJECT })).toEqual([]);
    });
  });

  describe('pipeline independence', () => {
    it('survives a fact content update (tags are an overlay, not content)', () => {
      addFactTags(db, 'f1', ['verified']);
      db.prepare("UPDATE facts SET fact = 'rewritten by consolidator' WHERE id = 'f1'").run();
      expect(getFactTags(db, 'f1')).toEqual(['verified']);
    });
  });
});
