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
      // facts are looked up per category through an index on ontology_category_id (whatever its name) …
      expect(plan).toMatch(/SEARCH f USING (COVERING )?INDEX \w+ \(ontology_category_id=\?/);
      // … never by walking every active fact (idx_facts_active has two values) or the whole table
      expect(plan).not.toMatch(/idx_facts_active\b/);
      expect(plan).not.toMatch(/SCAN f\b/);
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

  it('with a domain filter: that domain\'s categories beyond the overview\'s eight', () => {
    seedWide(2, 30, 1);
    const overview = formatOntologyBrowse(db, {});
    expect([...overview.matchAll(/^- Topic 00-\d+ \(1\)$/gm)]).toHaveLength(8);
    expect(overview).toMatch(/22 more categories \(22 facts\)/);

    const oneDomain = formatOntologyBrowse(db, { domain: 'Domain 00' });
    expect([...oneDomain.matchAll(/^- Topic 00-\d+ \(1\)$/gm)]).toHaveLength(30);
    expect(oneDomain).not.toContain('Topic 01-');
    expect(oneDomain).not.toMatch(/more categor/);
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

  // Found on the real ontology shape: the largest category's 50 facts are more than the whole ceiling, and
  // the answer was a header plus "limit reached" — nothing else.
  it('a category whose facts exceed the ceiling is shown as far as it fits, the rest counted', () => {
    const domain = createDomain(db, 'Big');
    const big = createCategory(db, domain.id, 'Huge Category');
    const small = createCategory(db, domain.id, 'Small Category');
    const hubs: string[] = [];
    for (let i = 0; i < 120; i++) hubs.push(addFact(db, big.id, `Huge fact ${i} ${'h'.repeat(600)}`, { count: 500 - i }));
    addFact(db, small.id, 'The small fact');
    for (const hub of hubs.slice(0, 60)) {
      for (let n = 0; n < 6; n++) createRelation(db, hub, 'SUPPORTS', addFact(db, null, `Neighbour ${n} of a hub ${'n'.repeat(300)}`));
    }

    const text = formatOntologyBrowse(db, { facts_per_category: 50, max_categories: 200, include_relations: true });
    expect(text.length).toBeLessThanOrEqual(ONTOLOGY_MAX_OUTPUT_CHARS);
    expect(text).toMatch(/### Huge Category/);
    const shown = [...text.matchAll(/^- \*\*\[decision\]\*\* Huge fact (\d+) /gm)].map((m) => Number(m[1]));
    // most confirmed first, without a gap, as many as fit — and well more than none
    expect(shown.length).toBeGreaterThanOrEqual(10);
    expect(shown).toEqual(Array.from({ length: shown.length }, (_, i) => i));
    expect(text).toContain(`${120 - shown.length} more facts`);
    expect(text).toMatch(/Output limit \(20000 chars\) reached: 1 category \(1 fact\)/);
    expect(text).not.toContain('The small fact');
  });

  it('loads facts only for the categories that can fit under the ceiling', () => {
    seedWide(2, 150, 3); // 300 one-line categories would all be "listed" with max_categories 200
    const loaded: number[] = [];
    const realPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (!/ROW_NUMBER\(\)/.test(sql)) return stmt;
      const realAll = stmt.all.bind(stmt);
      stmt.all = ((...args: unknown[]) => { const rows = realAll(...args); loaded.push(rows.length); return rows; }) as typeof stmt.all;
      return stmt;
    }) as typeof db.prepare;
    const text = formatOntologyBrowse(db, { facts_per_category: 3, max_categories: 200 });
    db.prepare = realPrepare;

    expect(loaded).toHaveLength(1);
    // 20,000 chars / (16 + 3×40) per block → at most 148 categories can fit → at most 444 fact rows
    expect(loaded[0]).toBeLessThanOrEqual(444);
    // every category that was printed has its facts (none was printed without its facts being loaded):
    // three each, except that the last block may have been cut short by the ceiling
    const printed = [...text.matchAll(/^### /gm)].length;
    expect(printed).toBeGreaterThanOrEqual(10);
    const factLines = [...text.matchAll(/^- \*\*\[decision\]\*\*/gm)].length;
    expect(factLines).toBeGreaterThanOrEqual((printed - 1) * 3 + 1);
    expect(factLines).toBeLessThanOrEqual(printed * 3);
    expect(text).not.toMatch(/top 0 shown/);
  });

  it('5,000 categories and 30,000 facts: under the output ceiling, in bounded time, with the remainder counted', () => {
    seedWide(25, 200, 6);
    expect(ONTOLOGY_MAX_OUTPUT_CHARS).toBe(20_000);

    const t0 = performance.now();
    const overview = formatOntologyBrowse(db, {});
    const overviewMs = performance.now() - t0;
    expect(overview.length).toBeLessThanOrEqual(ONTOLOGY_MAX_OUTPUT_CHARS);
    expect(overview).toMatch(/25 domains · 5000 categories · 30000 active facts/);
    expect(overview).not.toMatch(/Fact \d+-\d+-\d+/);
    expect(overviewMs).toBeLessThan(5000);

    // The widest request the schema allows still stops at the ceiling and says what is missing.
    const t1 = performance.now();
    const everything = formatOntologyBrowse(db, { category: 'Topic', facts_per_category: 50, max_categories: 200, include_relations: true });
    const everythingMs = performance.now() - t1;
    expect(everything.length).toBeLessThanOrEqual(ONTOLOGY_MAX_OUTPUT_CHARS);
    expect(everything).toMatch(/Output limit \(20000 chars\) reached/);
    expect(everything).toMatch(/narrow the `domain` \/ `category` filter/);
    expect(everythingMs).toBeLessThan(5000);
  });
});
