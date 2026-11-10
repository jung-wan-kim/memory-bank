import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';

/**
 * Save-time classification in one call (2026-11-10). saveExtractedFacts
 * classified each saved fact with its own LLM call — a session's 20 facts were
 * 20 headless sessions (30 days live: about 2,534 single-fact calls) while the
 * batch path existed and only the backfill worker used it.
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
import { saveExtractedFacts } from '../src/fact-extractor.js';
import {
  classifyAndLinkFacts,
  classifyAndLinkFact,
  IndexRepairError,
  MAX_CLASSIFY_ATTEMPTS,
  BATCH_CLASSIFY_SYSTEM_PROMPT,
  DETECT_RELATION_SYSTEM_PROMPT,
} from '../src/ontology-classifier.js';
import { createDomain, createCategory } from '../src/ontology-db.js';

/** Deterministic unit vector per text (FNV-1a seed → LCG): different texts are far apart. */
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
type Payload = { facts: Array<{ index: number; fact: string }> };

describe('save-time classification in one call', () => {
  let dir: string;
  let db: Database.Database;
  let restoreConsole: () => void;
  /** What the model answers per fact text; a missing entry leaves that fact out of the reply. */
  let reply: (factText: string) => Record<string, unknown> | null;
  let relationVerdict: string | null;
  let classifyError: Error | null;

  const classifyCalls = () => llm.mock.calls.filter((c) => c[0] === BATCH_CLASSIFY_SYSTEM_PROMPT);
  const relationCalls = () => llm.mock.calls.filter((c) => c[0] === DETECT_RELATION_SYSTEM_PROMPT);
  const payloadOf = (call: unknown[]) => JSON.parse(call[1] as string) as Payload;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-batch-save-'));
    process.env.TEST_DB_PATH = path.join(dir, 'db.sqlite');
    db = initDatabase();
    restoreConsole = suppressConsole();
    reply = () => ({ domain: 'Backend', category: 'API Design', is_new_category: true });
    relationVerdict = null;
    classifyError = null;
    llm.mockReset();
    llm.mockImplementation(async (system: string, message: string) => {
      if (system === DETECT_RELATION_SYSTEM_PROMPT) {
        return JSON.stringify({ has_relation: relationVerdict !== null, relation_type: relationVerdict, reasoning: 'test' });
      }
      if (classifyError) throw classifyError;
      const payload = JSON.parse(message) as Payload;
      return JSON.stringify(payload.facts.flatMap((f) => {
        const item = reply(f.fact);
        return item ? [{ index: f.index, is_new_domain: false, ...item }] : [];
      }));
    });
  });

  afterEach(() => {
    restoreConsole();
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** `near` puts the facts within relation range of each other (one shared vector). */
  const save = (texts: string[], near = false) => texts.map((text) => {
    const embedding = textVec(near ? 'shared topic' : text);
    const id = insertFact(db, {
      fact: text, category: 'decision', scope_type: 'project', scope_project: '/tmp/batch-project',
      source_exchange_ids: [], embedding,
    });
    return { factId: id, embedding };
  });
  const row = (id: string) => db.prepare('SELECT ontology_category_id AS category, ontology_attempts AS attempts FROM facts WHERE id = ?')
    .get(id) as { category: string | null; attempts: number };
  const relationRows = () => (db.prepare('SELECT COUNT(*) AS n FROM ontology_relations').get() as { n: number }).n;

  it('five facts are classified by one LLM call', async () => {
    const items = save(['fact one', 'fact two', 'fact three', 'fact four', 'fact five']);

    const result = await classifyAndLinkFacts(db, items);

    expect(classifyCalls()).toHaveLength(1);
    expect(payloadOf(classifyCalls()[0]).facts.map((f) => f.fact)).toEqual(['fact one', 'fact two', 'fact three', 'fact four', 'fact five']);
    expect(items.map((i) => row(i.factId).category !== null)).toEqual([true, true, true, true, true]);
    expect(result).toMatchObject({ classified: 5, failed: 0, fallback: 0, transient: 0 });
  });

  it('a fact the reply leaves out takes one attempt and stays for the backfill; the rest are saved', async () => {
    const items = save(['fact one', 'fact two', 'fact three']);
    reply = (text) => (text === 'fact two' ? null : { domain: 'Backend', category: 'API Design', is_new_category: true });

    const result = await classifyAndLinkFacts(db, items);

    // A reply that does not carry every index is not applied (its numbers may be shifted): the facts are asked
    // again in halves — [one, two] then [three] — and the half still short of an item fact by fact.
    expect(classifyCalls().map((c) => payloadOf(c).facts.length)).toEqual([3, 2, 1, 1, 1]);
    expect(row(items[0].factId).category).not.toBeNull();
    expect(row(items[2].factId).category).not.toBeNull();
    expect(row(items[1].factId)).toEqual({ category: null, attempts: 1 });
    expect(result).toMatchObject({ classified: 2, failed: 1, fallback: 0 });
    // The backfill worker's own selection picks it up.
    const pending = db.prepare(
      `SELECT id FROM facts WHERE is_active = 1 AND ontology_category_id IS NULL AND COALESCE(ontology_attempts, 0) < ?`,
    ).all(MAX_CLASSIFY_ATTEMPTS) as Array<{ id: string }>;
    expect(pending.map((p) => p.id)).toEqual([items[1].factId]);
  });

  it('a failed call burns no attempt for any fact, throws nothing, and relations are still judged', async () => {
    const items = save(['fact one', 'fact two', 'fact three'], true);
    classifyError = new Error('socket hang up');
    relationVerdict = 'SUPPORTS';

    const result = await classifyAndLinkFacts(db, items);

    expect(items.map((i) => row(i.factId))).toEqual([
      { category: null, attempts: 0 }, { category: null, attempts: 0 }, { category: null, attempts: 0 },
    ]);
    expect(result).toMatchObject({ classified: 0, failed: 0, transient: 3 });
    expect(relationCalls().length).toBeGreaterThan(0);
    expect(relationRows()).toBeGreaterThan(0);
  });

  it('the third failed attempt parks the fact in General/Misc', async () => {
    const items = save(['fact one', 'fact two']);
    db.prepare('UPDATE facts SET ontology_attempts = ? WHERE id = ?').run(MAX_CLASSIFY_ATTEMPTS - 1, items[0].factId);
    reply = (text) => (text === 'fact one' ? null : { domain: 'Backend', category: 'API Design', is_new_category: true });

    const result = await classifyAndLinkFacts(db, items);

    const parked = db.prepare(
      `SELECT c.name AS category, d.name AS domain FROM facts f JOIN ontology_categories c ON c.id = f.ontology_category_id
       JOIN ontology_domains d ON d.id = c.domain_id WHERE f.id = ?`,
    ).get(items[0].factId);
    expect(parked).toEqual({ category: 'Misc', domain: 'General' });
    expect(result).toMatchObject({ classified: 1, failed: 0, fallback: 1 });
  });

  it('a broken category index surfaces after the relations of every fact were judged, with no attempt burned', async () => {
    const items = save(['fact one', 'fact two', 'fact three'], true);
    const domain = createDomain(db, 'Existing');
    createCategory(db, domain.id, 'Existing Category');
    db.exec('DROP TABLE vec_categories');
    relationVerdict = 'SUPPORTS';

    await expect(classifyAndLinkFacts(db, items)).rejects.toBeInstanceOf(IndexRepairError);

    expect(classifyCalls()).toHaveLength(0);
    expect(relationCalls().length).toBeGreaterThan(0);
    expect(items.map((i) => row(i.factId).attempts)).toEqual([0, 0, 0]);
  });

  it('ids that are missing or inactive are left out', async () => {
    const items = save(['fact one', 'fact two']);
    db.prepare('UPDATE facts SET is_active = 0 WHERE id = ?').run(items[1].factId);

    await classifyAndLinkFacts(db, [...items, { factId: 'no-such-fact' }]);

    expect(payloadOf(classifyCalls()[0]).facts.map((f) => f.fact)).toEqual(['fact one']);
  });

  it('more facts than one call carries are split into calls of 20', async () => {
    const items = save(Array.from({ length: 25 }, (_, i) => `fact number ${i}`));

    const result = await classifyAndLinkFacts(db, items);

    expect(classifyCalls().map((c) => payloadOf(c).facts.length)).toEqual([20, 5]);
    expect(result.classified).toBe(25);
  });

  it('facts saved together never get SUPERSEDES between them', async () => {
    const items = save(['the API is REST', 'the API is GraphQL', 'the API is gRPC'], true);
    relationVerdict = 'SUPERSEDES';

    const result = await classifyAndLinkFacts(db, items);

    expect(relationCalls().length).toBeGreaterThan(0);
    expect(relationRows()).toBe(0);
    expect(result.relations.siblingSupersedes).toBe(relationCalls().length);
  });

  it('classifyAndLinkFact (one fact) is the same path: one classification call, relations judged', async () => {
    const [existing] = save(['an earlier fact'], true);
    const [one] = save(['a later fact'], true);
    relationVerdict = 'SUPPORTS';

    await classifyAndLinkFact(db, one.factId, one.embedding);

    expect(classifyCalls()).toHaveLength(1);
    expect(row(one.factId).category).not.toBeNull();
    expect(row(existing.factId).category).toBeNull();
    expect(relationRows()).toBe(1);
  });

  describe('saveExtractedFacts', () => {
    const extracted = (texts: string[]) => texts.map((fact) => ({
      fact, category: 'decision' as const, scope_type: 'project' as const, confidence: 0.9,
    }));

    it('a session of four facts costs one classification call, not four', async () => {
      const ids = await saveExtractedFacts(db, extracted([
        'The service exposes a REST API', 'Requests are authenticated with JWT',
        'Responses are cached for five minutes', 'Errors use the problem+json format',
      ]), '/tmp/batch-project', ['ex-1', 'ex-2']);

      expect(ids).toHaveLength(4);
      expect(classifyCalls()).toHaveLength(1);
      expect(payloadOf(classifyCalls()[0]).facts).toHaveLength(4);
      expect(ids.map((id) => row(id).category !== null)).toEqual([true, true, true, true]);
    });

    it('a failed classification call leaves the four facts saved and unclassified', async () => {
      classifyError = new Error('socket hang up');

      const ids = await saveExtractedFacts(db, extracted([
        'The service exposes a REST API', 'Requests are authenticated with JWT',
        'Responses are cached for five minutes', 'Errors use the problem+json format',
      ]), '/tmp/batch-project', ['ex-1']);

      expect(ids).toHaveLength(4);
      expect(ids.map((id) => row(id))).toEqual(Array.from({ length: 4 }, () => ({ category: null, attempts: 0 })));
      expect((db.prepare('SELECT COUNT(*) AS n FROM facts WHERE is_active = 1').get() as { n: number }).n).toBe(4);
    });
  });
});
