import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';

/**
 * Category reuse (2026-11-10). Live DB: 7,146 categories, 62% with two active
 * facts or fewer, the same name under several domains for 792 names (1,974
 * rows). The classifier looked a returned name up by exact match inside the
 * returned domain only, so a candidate's name written under another domain, or
 * with a hyphen instead of a space, became a new row.
 */

vi.mock('../src/llm.js', async (io) => ({ ...(await io<typeof import('../src/llm.js')>()), callHaiku: vi.fn() }));
vi.mock('../src/embeddings.js', async (io) => ({
  ...(await io<typeof import('../src/embeddings.js')>()),
  initEmbeddings: async () => {},
  generateEmbedding: vi.fn(async (text: string) => textVec(text)),
}));

import { callHaiku } from '../src/llm.js';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { classifyFactsBatch, BATCH_CLASSIFY_SYSTEM_PROMPT } from '../src/ontology-classifier.js';
import { createDomain, createCategory, classifyFact, upsertCategoryEmbedding } from '../src/ontology-db.js';
import type { Fact } from '../src/types.js';

/** Deterministic unit vector per text (FNV-1a seed → LCG). */
function textVec(text: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const v: number[] = [];
  let s = h || 1;
  for (let i = 0; i < 384; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; v.push(s / 4294967296 - 0.5); }
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / n);
}

const llm = callHaiku as unknown as ReturnType<typeof vi.fn>;

describe('category reuse by normalized name', () => {
  let dir: string;
  let db: Database.Database;
  let restoreConsole: () => void;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cat-reuse-'));
    process.env.TEST_DB_PATH = path.join(dir, 'db.sqlite');
    db = initDatabase();
    restoreConsole = suppressConsole();
    llm.mockReset();
  });

  afterEach(() => {
    restoreConsole();
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const category = (domainId: string, name: string, description?: string) => {
    const c = createCategory(db, domainId, name, description);
    upsertCategoryEmbedding(db, c.id, textVec(description ? `${name}: ${description}` : name));
    return c;
  };
  /** A category row as a pre-1.7.10 process (or a sync import) writes it. */
  const legacyCategory = (id: string, domainId: string, name: string, createdAt: string) => {
    db.prepare('INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, NULL, ?)')
      .run(id, domainId, name, createdAt);
    upsertCategoryEmbedding(db, id, textVec(name));
    return id;
  };
  const fact = (text: string, categoryId?: string, active = true): Fact => {
    const id = insertFact(db, {
      fact: text, category: 'decision', scope_type: 'project', scope_project: '/tmp/reuse-project',
      source_exchange_ids: [], embedding: textVec(text),
    });
    if (categoryId) classifyFact(db, id, categoryId);
    if (!active) db.prepare('UPDATE facts SET is_active = 0 WHERE id = ?').run(id);
    return {
      id, fact: text, category: 'decision', scope_type: 'project', scope_project: '/tmp/reuse-project',
      source_exchange_ids: [], embedding: new Float32Array(textVec(text)),
      created_at: '', updated_at: '', consolidated_count: 1, is_active: active,
    };
  };
  const answer = (...items: Array<Record<string, unknown>>) =>
    llm.mockResolvedValueOnce(JSON.stringify(items.map((it, i) => ({ index: i, is_new_domain: false, is_new_category: false, ...it }))));
  const categoryCount = () => (db.prepare('SELECT COUNT(*) AS n FROM ontology_categories').get() as { n: number }).n;
  const domainNames = () => (db.prepare('SELECT name FROM ontology_domains ORDER BY name').all() as Array<{ name: string }>).map((d) => d.name);
  const assigned = (id: string) => (db.prepare('SELECT ontology_category_id AS c FROM facts WHERE id = ?').get(id) as { c: string | null }).c;
  const sentPayload = () => JSON.parse(llm.mock.calls[llm.mock.calls.length - 1][1] as string) as {
    facts: Array<{ candidates: Array<{ domain: string; category: string; facts?: number }> }>;
  };

  it("a candidate's name returned under another domain reuses the candidate — no new row", async () => {
    const automation = createDomain(db, 'Automation');
    createDomain(db, 'Security');
    const existing = category(automation.id, 'Session Management', 'How browser sessions are kept');
    const f = fact('Agent browser sessions are reused across runs');
    answer({ domain: 'Security', category: 'Session Management' });

    const result = await classifyFactsBatch(db, [f]);

    expect(result.classified).toEqual([f.id]);
    expect(categoryCount()).toBe(1);
    expect(assigned(f.id)).toBe(existing.id);
    expect(result.assignments.get(f.id)).toEqual({ domainId: automation.id, categoryId: existing.id });
  });

  it('hyphen, case and spacing variants of an existing name are the same category', async () => {
    const km = createDomain(db, 'Knowledge Management');
    const existing = category(km.id, 'Memory-Bank Architecture');
    const f = fact('The plugin stores facts in SQLite');
    answer({ domain: 'Knowledge Management', category: 'memory bank  ARCHITECTURE', is_new_category: true });

    await classifyFactsBatch(db, [f]);

    expect(categoryCount()).toBe(1);
    expect(assigned(f.id)).toBe(existing.id);
  });

  it('a name that exists anywhere is reused even when it was not among the candidates, and the proposed new domain is not created', async () => {
    const backend = createDomain(db, 'Backend');
    const target = category(backend.id, 'Error Handling');
    const f = fact('Frontend forms show validation errors inline');
    // 30 categories at distance 0 from the fact push the target out of the candidate window.
    const filler = createDomain(db, 'Filler');
    for (let i = 0; i < 30; i++) {
      const c = createCategory(db, filler.id, `Filler Topic ${i}`);
      upsertCategoryEmbedding(db, c.id, textVec(f.fact));
    }
    const before = categoryCount();
    answer({ domain: 'Brand New Area', category: 'Error-Handling', is_new_domain: true, is_new_category: true, domain_description: 'x', category_description: 'y' });

    await classifyFactsBatch(db, [f]);

    expect(sentPayload().facts[0].candidates.map((c) => c.category)).not.toContain('Error Handling');
    expect(categoryCount()).toBe(before);
    expect(assigned(f.id)).toBe(target.id);
    expect(domainNames()).not.toContain('Brand New Area');
  });

  it('an existing (domain, name) pair wins over a more used namesake in another domain', async () => {
    const frontend = createDomain(db, 'Frontend');
    const backend = createDomain(db, 'Backend');
    createDomain(db, 'DevOps');
    const small = category(frontend.id, 'Testing');
    const big = category(backend.id, 'Testing');
    for (let i = 0; i < 3; i++) fact(`backend test note ${i}`, big.id);
    fact('frontend test note', small.id);

    const a = fact('Component tests run in jsdom');
    answer({ domain: 'Frontend', category: 'Testing' });
    await classifyFactsBatch(db, [a]);
    expect(assigned(a.id)).toBe(small.id);

    // No such category under DevOps: the most used namesake takes it.
    const b = fact('Pipelines run the test suite on every push');
    answer({ domain: 'DevOps', category: 'testing' });
    await classifyFactsBatch(db, [b]);
    expect(assigned(b.id)).toBe(big.id);
    expect(categoryCount()).toBe(2);
  });

  it('two legacy rows of one name in one domain resolve to the more used row, every time', async () => {
    const d = createDomain(db, 'Development Workflow');
    const small = legacyCategory('cat-small', d.id, 'Git Workflow', '2026-06-13T00:00:00.000Z');
    const big = legacyCategory('cat-big', d.id, 'Git Workflow', '2026-06-14T00:00:00.000Z');
    fact('small note', small);
    for (let i = 0; i < 3; i++) fact(`big note ${i}`, big);

    const f = fact('Commits are squashed before merge');
    answer({ domain: 'Development Workflow', category: 'Git Workflow' });
    await classifyFactsBatch(db, [f]);

    expect(assigned(f.id)).toBe(big);
    expect(categoryCount()).toBe(2);
  });

  it('candidates carry the active fact count, and namesakes are folded into the most used one', async () => {
    const automation = createDomain(db, 'Automation');
    const security = createDomain(db, 'Security');
    const devops = createDomain(db, 'DevOps');
    const big = category(automation.id, 'Session Management');
    const small = category(security.id, 'session-management');
    category(devops.id, 'Deploy');
    for (let i = 0; i < 3; i++) fact(`automation session note ${i}`, big.id);
    fact('security session note', small.id);
    fact('an inactive security note', small.id, false);

    const f = fact('Sessions expire after an hour');
    answer({ domain: 'Automation', category: 'Session Management' });
    await classifyFactsBatch(db, [f]);

    const candidates = sentPayload().facts[0].candidates;
    const sessions = candidates.filter((c) => c.category.toLowerCase().replace(/[^a-z]/g, '') === 'sessionmanagement');
    expect(sessions).toEqual([expect.objectContaining({ domain: 'Automation', category: 'Session Management', facts: 3 })]);
    expect(candidates.find((c) => c.category === 'Deploy')).toEqual(expect.objectContaining({ domain: 'DevOps', facts: 0 }));
    expect(assigned(f.id)).toBe(big.id);
  });

  it('the prompt tells the model what "facts" means and to copy a reused candidate exactly', () => {
    expect(BATCH_CLASSIFY_SYSTEM_PROMPT).toMatch(/"facts"/);
    expect(BATCH_CLASSIFY_SYSTEM_PROMPT).toMatch(/copy its "domain" and "category" exactly/);
  });

  it('is_new_category=false with a near-miss name reuses the one candidate it can only mean', async () => {
    const frontend = createDomain(db, 'Frontend');
    const existing = category(frontend.id, 'State Management');
    const f = fact('Riverpod holds the app state');
    answer({ domain: 'Frontend', category: 'State Managements', is_new_category: false });

    await classifyFactsBatch(db, [f]);

    expect(categoryCount()).toBe(1);
    expect(assigned(f.id)).toBe(existing.id);
  });

  it('the same near-miss name with is_new_category=true is a new category (the flag is what is read)', async () => {
    const frontend = createDomain(db, 'Frontend');
    const existing = category(frontend.id, 'State Management');
    const f = fact('Riverpod holds the app state');
    answer({ domain: 'Frontend', category: 'State Managements', is_new_category: true });

    await classifyFactsBatch(db, [f]);

    expect(categoryCount()).toBe(2);
    expect(assigned(f.id)).not.toBe(existing.id);
  });

  it('is_new_category=false that matches nothing still creates the category, and says so', async () => {
    const frontend = createDomain(db, 'Frontend');
    category(frontend.id, 'State Management');
    const f = fact('Routes are declared in one file');
    const errors: string[] = [];
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    answer({ domain: 'Frontend', category: 'Routing', is_new_category: false });

    await classifyFactsBatch(db, [f]);

    expect(categoryCount()).toBe(2);
    expect(errors.filter((e) => /claimed an existing category/.test(e))).toHaveLength(1);
  });

  it('a new category stores its normalized key', async () => {
    createDomain(db, 'Frontend');
    const f = fact('Routes are declared in one file');
    answer({ domain: 'Frontend', category: 'Client-Side Routing', is_new_category: true });

    await classifyFactsBatch(db, [f]);

    const row = db.prepare('SELECT name, name_key FROM ontology_categories').get() as { name: string; name_key: string };
    expect(row).toEqual({ name: 'Client-Side Routing', name_key: 'clientsiderouting' });
  });

  describe('what the classifier is shown of a fact', () => {
    type SentFact = { fact: string; project?: string };
    const sentFacts = () => (JSON.parse(llm.mock.calls[llm.mock.calls.length - 1][1] as string) as { facts: SentFact[] }).facts;

    // 639 live facts open with a machine header (namespace=… context_area=…,
    // about 200 characters); 554 of them were filed under "Memory-Bank
    // Architecture" from the wrapper's wording — the model saw 400 characters.
    it('a long fact is shown up to 1,000 characters — the text after a wrapper header is in view', async () => {
      const header = `Tool wrapper fact. namespace=some-tool:project-x novel_id=${'n'.repeat(60)} context_area=${'c'.repeat(60)} entity_id=${'e'.repeat(60)}. `;
      const body = `${'Filler sentence about the setting. '.repeat(8)}THE-ACTUAL-TOPIC is described here. `;
      const text = header + body + 'z'.repeat(3000);
      expect(text.indexOf('THE-ACTUAL-TOPIC')).toBeGreaterThan(400);
      const f = fact(text);
      answer({ domain: 'Creative Writing', category: 'World Building', is_new_domain: true, is_new_category: true });

      await classifyFactsBatch(db, [f]);

      const sent = sentFacts()[0].fact;
      expect(sent).toContain('THE-ACTUAL-TOPIC');
      expect(sent.length).toBe(1001);
      expect(sent.endsWith('…')).toBe(true);
    });

    it('a fact within the limit is shown whole', async () => {
      const f = fact('Routes are declared in one file');
      answer({ domain: 'Frontend', category: 'Routing', is_new_domain: true, is_new_category: true });

      await classifyFactsBatch(db, [f]);

      expect(sentFacts()[0].fact).toBe('Routes are declared in one file');
    });

    it('a project fact carries the project folder name; a global fact carries none', async () => {
      const projectFact = fact('Routes are declared in one file');
      const globalFact: Fact = { ...fact('Prefers small commits'), scope_type: 'global', scope_project: null };
      answer(
        { domain: 'Frontend', category: 'Routing', is_new_domain: true, is_new_category: true },
        { domain: 'Workflow', category: 'Commit Style', is_new_domain: true, is_new_category: true },
      );

      await classifyFactsBatch(db, [projectFact, globalFact]);

      expect(sentFacts()[0].project).toBe('reuse-project');
      expect('project' in sentFacts()[1]).toBe(false);
      expect(BATCH_CLASSIFY_SYSTEM_PROMPT).toMatch(/"project"/);
    });
  });

  it('a domain is matched by normalized name too', async () => {
    createDomain(db, 'DevOps');
    const f = fact('Deploys go through a staging slot');
    answer({ domain: 'Dev Ops', category: 'Deployment', is_new_domain: true, is_new_category: true });

    await classifyFactsBatch(db, [f]);

    expect(domainNames()).toEqual(['DevOps']);
  });
});
