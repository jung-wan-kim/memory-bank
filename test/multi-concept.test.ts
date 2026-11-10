import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConversationExchange } from '../src/types.js';

/**
 * Multi-concept search over a temp database with seeded vectors.
 *
 * This file used to query "the actual database" — the developer's live one,
 * through a write connection — and wrapped every assertion in `if (results…)`,
 * so on an empty database it checked nothing. Here the database is a temp file
 * and every vector is chosen, so each expected result is known in advance.
 *
 * Vector space of the seed (384 dims, unit vectors): axis 0 = "React",
 * axis 1 = "Router", axes 2-3 = two concepts no exchange mentions, axis 4 =
 * "Database", axes 10+ = one private noise axis per filler exchange. An exchange's similarity is
 * `1 - L2 distance` (search.ts): 1 for the same direction, 1 - √2 ≈ -0.41 for
 * an orthogonal one, 1 - √(2 - √2) ≈ 0.23 for the halfway vector.
 */

const DIM = 384;
const AXIS = { react: 0, router: 1, unrelatedA: 2, unrelatedB: 3, database: 4 };

function unit(components: Record<number, number>): number[] {
  const v = new Array(DIM).fill(0);
  for (const [axis, value] of Object.entries(components)) v[Number(axis)] = value;
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return v.map((x) => x / norm);
}

/** Query embedding: one axis per known concept word. */
function conceptVector(text: string): number[] {
  const t = text.toLowerCase();
  const components: Record<number, number> = {};
  if (t.includes('react')) components[AXIS.react] = 1;
  if (t.includes('router')) components[AXIS.router] = 1;
  if (t.includes('xyzabc123')) components[AXIS.unrelatedA] = 1;
  if (t.includes('qwerty789')) components[AXIS.unrelatedB] = 1;
  if (t.includes('database')) components[AXIS.database] = 1;
  if (Object.keys(components).length === 0) throw new Error(`test embedding: no axis for ${JSON.stringify(text)}`);
  return unit(components);
}

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();
  return {
    ...actual,
    initEmbeddings: async () => {},
    generateEmbedding: async (text: string) => conceptVector(text),
  };
});

const BOTH_STRONG = '/archive/demo/conv-both-strong.jsonl';
const BOTH_WEAK = '/archive/demo/conv-both-weak.jsonl';

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

function exchange(id: string, archivePath: string, userMessage: string): ConversationExchange {
  return {
    id,
    project: 'demo',
    timestamp: '2026-01-01T00:00:00Z',
    userMessage,
    assistantMessage: `answer to: ${userMessage}`,
    archivePath,
    lineStart: 1,
    lineEnd: 2,
  };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-multi-concept-'));
  for (const key of ['MEMORY_BANK_DB_PATH', 'TEST_DB_PATH']) saved[key] = process.env[key];
  delete process.env.TEST_DB_PATH;
  process.env.MEMORY_BANK_DB_PATH = path.join(tmpDir, 'db.sqlite');

  const { initDatabase, insertExchange } = await import('../src/db.js');
  const db = initDatabase();
  try {
    // One conversation with an exchange squarely on each concept: similarity 1 to both.
    insertExchange(db, exchange('a1', BOTH_STRONG, 'React component state'), unit({ [AXIS.react]: 1 }));
    insertExchange(db, exchange('a2', BOTH_STRONG, 'Router configuration'), unit({ [AXIS.router]: 1 }));
    // One exchange halfway between the two concepts: similarity ≈ 0.23 to each.
    insertExchange(db, exchange('b1', BOTH_WEAK, 'React Router together'), unit({ [AXIS.react]: 1, [AXIS.router]: 1 }));
    // Five conversations about React only and five about Router only: nearer to their own
    // concept than the halfway exchange (cosine 0.87-0.94 against 0.71), orthogonal to the
    // other. They fill the top of each single-concept list.
    for (let i = 1; i <= 5; i++) {
      insertExchange(db, exchange(`c${i}`, `/archive/demo/conv-react-only-${i}.jsonl`, `React only ${i}`),
        unit({ [AXIS.react]: 1, [10 + i]: 0.30 + 0.05 * i }));
      insertExchange(db, exchange(`d${i}`, `/archive/demo/conv-router-only-${i}.jsonl`, `Router only ${i}`),
        unit({ [AXIS.router]: 1, [20 + i]: 0.33 + 0.05 * i }));
      // …and five about a third concept that shares no conversation with React.
      insertExchange(db, exchange(`e${i}`, `/archive/demo/conv-database-only-${i}.jsonl`, `Database only ${i}`),
        unit({ [AXIS.database]: 1, [30 + i]: 0.30 + 0.05 * i }));
    }
  } finally {
    db.close();
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('multi-concept search', () => {
  it('returns only the conversation that is in the top results of every concept', async () => {
    const { searchMultipleConcepts } = await import('../src/search.js');
    // limit 1 → the 5 nearest exchanges per concept. For "React" those are a1 and four
    // React-only fillers; for "Router", a2 and four Router-only fillers. The halfway
    // exchange is in neither list, and no filler is in both.
    const results = await searchMultipleConcepts(['React', 'Router'], { limit: 1 });

    expect(results.map((r) => r.exchange.archivePath)).toEqual([BOTH_STRONG]);
    expect(results[0].conceptSimilarities).toHaveLength(2);
    expect(results[0].conceptSimilarities[0]).toBeCloseTo(1, 2);
    expect(results[0].conceptSimilarities[1]).toBeCloseTo(1, 2);
    expect(results[0].averageSimilarity).toBeCloseTo(1, 2);
  });

  it('returns nothing when no conversation is in the top results of every concept', async () => {
    const { searchMultipleConcepts } = await import('../src/search.js');
    // "React" → a1 and four React-only fillers; "Database" → the five Database-only
    // conversations. Each list is full of good matches, and they share no conversation.
    expect(await searchMultipleConcepts(['React', 'Database'], { limit: 1 })).toEqual([]);
  });

  it('orders matches by average similarity, highest first', async () => {
    const { searchMultipleConcepts } = await import('../src/search.js');
    // limit 5 → 25 nearest per concept, which is every seeded exchange: all 17
    // conversations are candidates and the order is decided by the averages.
    const results = await searchMultipleConcepts(['React', 'Router'], { limit: 5 });

    expect(results).toHaveLength(5);
    expect(results[0].exchange.archivePath).toBe(BOTH_STRONG);
    expect(results[1].exchange.archivePath).toBe(BOTH_WEAK);
    expect(results[1].averageSimilarity).toBeCloseTo(1 - Math.sqrt(2 - Math.SQRT2), 2);
    // A single-concept filler averages its own concept (≈0.6) with the orthogonal one (≈-0.41).
    expect(results[2].averageSimilarity).toBeLessThan(0.2);
    const averages = results.map((r) => r.averageSimilarity);
    expect(averages).toEqual([...averages].sort((a, b) => b - a));
    for (const r of results) {
      expect(r.conceptSimilarities).toHaveLength(2);
      const mean = (r.conceptSimilarities[0] + r.conceptSimilarities[1]) / 2;
      expect(r.averageSimilarity).toBeCloseTo(mean, 10);
    }
  });

  it('respects the limit', async () => {
    const { searchMultipleConcepts } = await import('../src/search.js');
    const results = await searchMultipleConcepts(['React', 'Router'], { limit: 2 });
    expect(results.map((r) => r.exchange.archivePath)).toEqual([BOTH_STRONG, BOTH_WEAK]);
  });

  it('scores concepts no exchange mentions far below related ones', async () => {
    const { searchMultipleConcepts } = await import('../src/search.js');
    const unrelated = await searchMultipleConcepts(['xyzabc123', 'qwerty789'], { limit: 5 });
    const related = await searchMultipleConcepts(['React', 'Router'], { limit: 5 });

    // Every seeded vector is orthogonal to both unknown concepts.
    expect(unrelated).toHaveLength(5);
    expect(unrelated[0].averageSimilarity).toBeCloseTo(1 - Math.SQRT2, 1);
    expect(unrelated[0].averageSimilarity).toBeLessThan(related[0].averageSimilarity);
  });

  it('returns nothing for an empty concept list', async () => {
    const { searchMultipleConcepts } = await import('../src/search.js');
    expect(await searchMultipleConcepts([], { limit: 5 })).toEqual([]);
  });
});
