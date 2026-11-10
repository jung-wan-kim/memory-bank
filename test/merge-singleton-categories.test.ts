import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { initEmbeddings, generateEmbedding } from '../src/embeddings.js';
import { insertFact } from '../src/fact-db.js';
import { createDomain, createCategory, classifyFact, upsertCategoryEmbedding } from '../src/ontology-db.js';

// scripts/merge-singleton-categories.mjs imports ../dist — `npm test` builds first (pretest).
// The script embeds each candidate with the real model, so the fixture's
// category vectors are real embeddings too (the model is local, no LLM).
const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/merge-singleton-categories.mjs');

describe('merge-singleton-categories.mjs', () => {
  let dir: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;
  let ids: { stable: string; singleton: string; unrelated: string; movedFact: string };

  const run = (args: string[] = [], extraEnv: Record<string, string> = {}) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  const open = () => new Database(dbPath, { readonly: true });
  const tables = () => {
    const db = open();
    try {
      return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>).map((t) => t.name);
    } finally { db.close(); }
  };
  const categoryIds = () => {
    const db = open();
    try {
      return (db.prepare('SELECT id FROM ontology_categories ORDER BY id').all() as Array<{ id: string }>).map((c) => c.id);
    } finally { db.close(); }
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-singleton-'));
    dbPath = path.join(dir, 'db.sqlite');
    env = { ...process.env, MEMORY_BANK_CONFIG_DIR: path.join(dir, 'cfg'), TEST_DB_PATH: dbPath };
    delete env.DRY_RUN;
    delete env.MERGE_SIM_THRESHOLD;
    delete env.MERGE_MAX_FACTS;
    process.env.TEST_DB_PATH = dbPath;

    await initEmbeddings();
    const db = initDatabase();
    try {
      const domain = createDomain(db, 'DevOps');
      const category = async (name: string, description: string) => {
        const c = createCategory(db, domain.id, name, description);
        upsertCategoryEmbedding(db, c.id, await generateEmbedding(`${name}: ${description}`, 'passage'));
        return c.id;
      };
      const fact = (text: string, categoryId: string) => {
        const id = insertFact(db, {
          fact: text, category: 'decision', scope_type: 'global', scope_project: null,
          source_exchange_ids: [], embedding: null,
        });
        classifyFact(db, id, categoryId);
        return id;
      };
      const stable = await category('Deployment Pipeline', 'How releases are built and deployed');
      const singleton = await category('Deployment Pipelines', 'How releases are built and deployed');
      const unrelated = await category('Brand Colors', 'Palette used by the marketing site');
      fact('Deploys run from the main branch', stable);
      fact('Each deploy is tagged with the commit', stable);
      const movedFact = fact('Staging is deployed before production', singleton);
      fact('The accent color is teal', unrelated);
      ids = { stable, singleton, unrelated, movedFact };
    } finally {
      db.close();
    }
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('DRY_RUN=1 previews the merge and leaves the database byte-identical — no merge-log table either', () => {
    const before = fs.readFileSync(dbPath);
    const tablesBefore = tables();

    const r = run([], { DRY_RUN: '1' });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/merge "Deployment Pipelines" \(1f\) → "Deployment Pipeline"/);
    expect(r.stdout).not.toMatch(/merge "Brand Colors"/);
    expect(r.stdout).toMatch(/merged 1 categories, reassigned 0 facts\. categories 3 → 3 \(dry-run, no change\)/);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    expect(tables()).toEqual(tablesBefore);
    expect(tables()).not.toContain('category_merge_log');
  });

  it('--dry-run is the same preview', () => {
    const before = fs.readFileSync(dbPath);

    const r = run(['--dry-run']);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\(dry-run, no change\)/);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });

  it('an argument it does not know stops the run before the database is opened', () => {
    const before = fs.readFileSync(dbPath);

    const r = run(['--dryrun']);

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown argument: --dryrun/);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    expect(categoryIds()).toEqual([ids.stable, ids.singleton, ids.unrelated].sort());
  });

  it('a real run moves the fact, removes the singleton and logs which facts moved', () => {
    const r = run();

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/merged 1 categories, reassigned 1 facts\. categories 3 → 2/);
    expect(categoryIds()).toEqual([ids.stable, ids.unrelated].sort());
    const db = open();
    try {
      expect(db.prepare('SELECT ontology_category_id AS c FROM facts WHERE id = ?').get(ids.movedFact)).toEqual({ c: ids.stable });
      const log = db.prepare('SELECT source_id, source_name, target_id, facts_reassigned, fact_ids FROM category_merge_log').all();
      expect(log).toEqual([{
        source_id: ids.singleton, source_name: 'Deployment Pipelines', target_id: ids.stable,
        facts_reassigned: 1, fact_ids: JSON.stringify([ids.movedFact]),
      }]);
    } finally { db.close(); }
  });

  it('a merge-log table from the first version of the script gets the fact_ids column', () => {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE category_merge_log (
      merged_at TEXT NOT NULL, source_id TEXT NOT NULL, source_name TEXT,
      target_id TEXT NOT NULL, target_name TEXT, domain TEXT, similarity REAL, facts_reassigned INTEGER
    )`);
    db.close();

    const r = run();

    expect(r.status, r.stderr).toBe(0);
    const after = open();
    try {
      expect(after.prepare('SELECT fact_ids FROM category_merge_log').get()).toEqual({ fact_ids: JSON.stringify([ids.movedFact]) });
    } finally { after.close(); }
  });
});
