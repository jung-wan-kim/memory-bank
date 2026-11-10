import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { getOntologyTree, createDomain, createCategory, createRelation } from '../src/ontology-db.js';
import {
  formatOntologyBrowse,
  ONTOLOGY_MAX_OUTPUT_CHARS,
  ONTOLOGY_FACT_CHARS,
} from '../src/ontology-browse.js';

// SQ-02 / ONT-02 / STG-03③ / ROB-07 — search_ontology built the whole tree with one facts query per
// category (7,146 queries on the live DB, each walking every active fact through the two-valued
// is_active index: minutes), then printed every fact of every category with no ceiling (millions of chars).

let seq = 0;
function addFact(db: Database.Database, categoryId: string | null, text: string, over: { count?: number; active?: number; created?: string } = {}): string {
  const id = `fact-${String(++seq).padStart(6, '0')}`;
  const created = over.created ?? '2026-01-01T00:00:00.000Z';
  db.prepare(`
    INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at, consolidated_count, is_active, ontology_category_id, embedding_version)
    VALUES (?, ?, 'decision', 'global', NULL, '[]', ?, ?, ?, ?, ?, 1)
  `).run(id, text, created, created, over.count ?? 1, over.active ?? 1, categoryId);
  return id;
}

describe('getOntologyTree', () => {
  let tmpDir: string;
  let db: Database.Database;
  const prevDb = process.env.MEMORY_BANK_DB_PATH;

  beforeEach(() => {
    seq = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ontology-'));
    process.env.MEMORY_BANK_DB_PATH = path.join(tmpDir, 'db.sqlite');
    db = initDatabase();
  });

  afterEach(() => {
    db.close();
    if (prevDb === undefined) delete process.env.MEMORY_BANK_DB_PATH; else process.env.MEMORY_BANK_DB_PATH = prevDb;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedSmall() {
    const infra = createDomain(db, 'Infrastructure', 'servers and deploys');
    const front = createDomain(db, 'Frontend');
    const deploy = createCategory(db, infra.id, 'Deploy Pipeline', 'how releases ship');
    const dbCat = createCategory(db, infra.id, 'Database');
    const emptyCat = createCategory(db, infra.id, 'Unused Corner');
    const state = createCategory(db, front.id, 'State Management');
    const f1 = addFact(db, deploy.id, 'Deploys go through the staging gate first', { count: 5 });
    const f2 = addFact(db, deploy.id, 'Rollbacks use the previous image tag', { count: 9 });
    addFact(db, deploy.id, 'A retired deploy rule', { active: 0, count: 50 });
    addFact(db, dbCat.id, 'Migrations are applied by hand with psql', { count: 2 });
    addFact(db, state.id, 'State lives on the server, not in localStorage', { count: 1 });
    return { infra, front, deploy, dbCat, emptyCat, state, f1, f2 };
  }

  it('returns domains → categories → active facts with per-category totals', () => {
    const { f1, f2 } = seedSmall();
    const tree = getOntologyTree(db);
    expect(tree.map((d) => d.domain.name)).toEqual(['Frontend', 'Infrastructure']);
    const infra = tree[1];
    expect(infra.categories.map((c) => [c.category.name, c.factCount])).toEqual([
      ['Database', 1],
      ['Deploy Pipeline', 2],
      ['Unused Corner', 0],
    ]);
    // highest confirmation count first; the inactive fact is neither counted nor returned
    expect(infra.categories[1].facts.map((f) => f.id)).toEqual([f2, f1]);
    expect(infra.categories[2].facts).toEqual([]);
  });

  it('filters by domain and category name in SQL (partial, case-insensitive) and escapes LIKE wildcards', () => {
    seedSmall();
    expect(getOntologyTree(db, { domain: 'infra' }).map((d) => d.domain.name)).toEqual(['Infrastructure']);
    const byCategory = getOntologyTree(db, { category: 'DEPLOY' });
    expect(byCategory.map((d) => d.domain.name)).toEqual(['Infrastructure']);
    expect(byCategory[0].categories.map((c) => c.category.name)).toEqual(['Deploy Pipeline']);
    // `_` and `%` are literal characters of the filter, not wildcards
    expect(getOntologyTree(db, { category: 'Deploy_Pipeline' })).toEqual([]);
    expect(getOntologyTree(db, { domain: '%' })).toEqual([]);
  });

  it('caps the facts of each category at factsPerCategory and still reports the total', () => {
    const { f2 } = seedSmall();
    const tree = getOntologyTree(db, { category: 'deploy', factsPerCategory: 1 });
    expect(tree[0].categories[0].factCount).toBe(2);
    expect(tree[0].categories[0].facts.map((f) => f.id)).toEqual([f2]);
    const countsOnly = getOntologyTree(db, { factsPerCategory: 0 });
    expect(countsOnly.flatMap((d) => d.categories).every((c) => c.facts.length === 0)).toBe(true);
    expect(countsOnly[1].categories[1].factCount).toBe(2);
  });

  it('runs a fixed number of statements, however many categories there are', () => {
    const domain = createDomain(db, 'Wide');
    db.transaction(() => {
      for (let i = 0; i < 300; i++) {
        const cat = createCategory(db, domain.id, `Category ${String(i).padStart(3, '0')}`);
        addFact(db, cat.id, `Fact of category ${i}`);
      }
    })();

    let prepared = 0;
    const realPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => { prepared++; return realPrepare(sql); }) as typeof db.prepare;
    const tree = getOntologyTree(db);
    db.prepare = realPrepare;

    expect(tree[0].categories).toHaveLength(300);
    expect(prepared).toBeLessThanOrEqual(2);
  });

  it('reaches facts through the category index, never the two-valued is_active index', () => {
    seedSmall();
    const plans: string[] = [];
    const realPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const params = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 'x');
      plans.push((realPrepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail).join('\n'));
      return realPrepare(sql);
    }) as typeof db.prepare;
    getOntologyTree(db, { domain: 'infra', category: 'deploy', factsPerCategory: 3 });
    db.prepare = realPrepare;

    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan).toMatch(/USING (COVERING )?INDEX idx_facts_ontology \(ontology_category_id=\?\)/);
      expect(plan).not.toMatch(/idx_facts_active/);
    }
  });
});

describe('formatOntologyBrowse (search_ontology output)', () => {
  let tmpDir: string;
  let db: Database.Database;
  const prevDb = process.env.MEMORY_BANK_DB_PATH;

  beforeEach(() => {
    seq = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ontology-fmt-'));
    process.env.MEMORY_BANK_DB_PATH = path.join(tmpDir, 'db.sqlite');
    db = initDatabase();
  });

  afterEach(() => {
    db.close();
    if (prevDb === undefined) delete process.env.MEMORY_BANK_DB_PATH; else process.env.MEMORY_BANK_DB_PATH = prevDb;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** `domains` domains × `perDomain` categories × `factsEach` facts of `factChars` chars. */
  function seedWide(domains: number, perDomain: number, factsEach: number, factChars = 200) {
    db.transaction(() => {
      for (let d = 0; d < domains; d++) {
        const domain = createDomain(db, `Domain ${String(d).padStart(2, '0')}`, `description of domain ${d}`);
        for (let c = 0; c < perDomain; c++) {
          const cat = createCategory(db, domain.id, `Topic ${String(d).padStart(2, '0')}-${String(c).padStart(3, '0')}`);
          for (let f = 0; f < factsEach; f++) {
            addFact(db, cat.id, `Fact ${d}-${c}-${f} ${'w'.repeat(factChars)}`, { count: factsEach - f });
          }
        }
      }
    })();
  }

  it('says so when there is no ontology', () => {
    expect(formatOntologyBrowse(db, {})).toMatch(/No ontology data found/);
  });

  it('without a filter: counts only, no fact text, and how to drill down', () => {
    seedWide(3, 4, 2);
    const text = formatOntologyBrowse(db, {});
    expect(text).toContain('# Ontology Tree');
    expect(text).toMatch(/3 domains · 12 categories · 24 active facts/);
    expect(text).toMatch(/## Domain 00 — 8 facts in 4 categories/);
    expect(text).toMatch(/- Topic 00-000 \(2\)/);
    expect(text).not.toContain('Fact 0-0-0');
    expect(text).toMatch(/`domain`/);
    expect(text).toMatch(/`category`/);
  });

  it('with a category filter: the top facts of each matching category, the rest counted', () => {
    seedWide(1, 2, 8);
    const text = formatOntologyBrowse(db, { category: 'Topic 00-001' });
    expect(text).toMatch(/### Topic 00-001/);
    expect(text).toMatch(/8 facts, top 5 shown/);
    expect(text).toContain('Fact 0-1-0');
    expect(text).toContain('Fact 0-1-4');
    expect(text).not.toContain('Fact 0-1-5');
    expect(text).not.toContain('Fact 0-0-0');
    expect(text).toMatch(/3 more facts/);
    expect(text).toMatch(/ID: fact-\d+ \| Confirmed: 8x \| 2026-01-01/);
  });

  it('facts_per_category and max_categories are honoured, and what was left out is counted', () => {
    seedWide(1, 6, 4);
    const text = formatOntologyBrowse(db, { domain: 'Domain 00', facts_per_category: 2, max_categories: 3 });
    expect([...text.matchAll(/^### /gm)]).toHaveLength(3);
    expect([...text.matchAll(/^- \*\*\[decision\]\*\*/gm)]).toHaveLength(6);
    expect(text).toMatch(/3 more categories \(12 facts\)/);
  });

  it('hides empty categories and says how many', () => {
    const domain = createDomain(db, 'Sparse');
    const used = createCategory(db, domain.id, 'Used');
    createCategory(db, domain.id, 'Empty One');
    createCategory(db, domain.id, 'Empty Two');
    addFact(db, used.id, 'The only fact here');
    const text = formatOntologyBrowse(db, {});
    expect(text).toMatch(/- Used \(1\)/);
    expect(text).not.toContain('Empty One');
    expect(text).toMatch(/2 empty categories not listed/);
  });

  it('clips a long fact and points at search_facts for the full text', () => {
    const domain = createDomain(db, 'Long');
    const cat = createCategory(db, domain.id, 'Novel Settings');
    addFact(db, cat.id, 'L'.repeat(5000));
    const text = formatOntologyBrowse(db, { category: 'novel' });
    expect(text).toMatch(new RegExp(`L{${ONTOLOGY_FACT_CHARS - 1}}…`));
    expect(text).not.toMatch(new RegExp(`L{${ONTOLOGY_FACT_CHARS}}`));
  });

  it('caps relations per fact when include_relations is on', () => {
    const domain = createDomain(db, 'Graph');
    const cat = createCategory(db, domain.id, 'Hub');
    const hub = addFact(db, cat.id, 'The hub fact', { count: 99 });
    for (let i = 0; i < 12; i++) {
      const spoke = addFact(db, null, `Spoke number ${i} ${'s'.repeat(400)}`);
      createRelation(db, hub, i === 11 ? 'CONTRADICTS' : 'SUPPORTS', spoke);
    }
    const text = formatOntologyBrowse(db, { category: 'hub', include_relations: true });
    const relationLines = [...text.matchAll(/^  - ↔ \[(\w+)\] "(.*)"$/gm)];
    expect(relationLines).toHaveLength(5);
    // a contradiction is never one of the hidden ones
    expect(relationLines[0][1]).toBe('CONTRADICTS');
    expect(relationLines.every((m) => m[2].length <= 160)).toBe(true);
    expect(text).toMatch(/7 more related facts/);
  });

  it('5,000 categories and 30,000 facts: under the output ceiling, in bounded time, with the remainder counted', () => {
    seedWide(25, 200, 6);
    expect(ONTOLOGY_MAX_OUTPUT_CHARS).toBe(20_000);

    const t0 = performance.now();
    const overview = formatOntologyBrowse(db, {});
    const overviewMs = performance.now() - t0;
    expect(overview.length).toBeLessThanOrEqual(ONTOLOGY_MAX_OUTPUT_CHARS + 500);
    expect(overview).toMatch(/25 domains · 5000 categories · 30000 active facts/);
    expect(overview).not.toMatch(/Fact \d+-\d+-\d+/);
    expect(overviewMs).toBeLessThan(5000);

    // The widest request the schema allows still stops at the ceiling and says what is missing.
    const t1 = performance.now();
    const everything = formatOntologyBrowse(db, { category: 'Topic', facts_per_category: 50, max_categories: 200, include_relations: true });
    const everythingMs = performance.now() - t1;
    expect(everything.length).toBeLessThanOrEqual(ONTOLOGY_MAX_OUTPUT_CHARS + 500);
    expect(everything).toMatch(/Output limit \(20000 chars\) reached/);
    expect(everything).toMatch(/narrow the `domain` \/ `category` filter/);
    expect(everythingMs).toBeLessThan(5000);
  });
});
