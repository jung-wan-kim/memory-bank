import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';

vi.mock('../src/llm.js', () => ({
  callHaiku: vi.fn().mockResolvedValue('{}'),
  parseJsonResponse: vi.fn().mockReturnValue({ relation: 'INDEPENDENT', merged_fact: '', reason: 'stub' }),
}));

import { callHaiku } from '../src/llm.js';
import { initDatabase } from '../src/db.js';
import { insertFact, searchSimilarFactsSameScope } from '../src/fact-db.js';
import { consolidateAllPending, buildConsolidationPrompt } from '../src/consolidator.js';

/**
 * The same fact stored once in English (with a Korean translation) and once
 * written in Korean. A multilingual model scores same-language pairs far
 * higher than cross-language ones (measured on live facts: Korean↔English
 * 0.927–0.932, same language 0.990), so the English driver's main vector does
 * not reach the Korean-written fact — only its own Korean vector does. The
 * search used the main vector alone, so whether the pair was ever compared
 * depended on which of the two happened to be the driver.
 */

const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
const unit = (v: number[]) => { const n = Math.sqrt(dot(v, v)); return v.map((x) => x / n); };
const add = (a: number[], b: number[], k: number) => a.map((x, i) => x + k * b[i]);

// Three orthonormal directions: the meaning, and one offset per language.
const next = rng(606);
const raw = () => Array.from({ length: 384 }, () => next() - 0.5);
const orth = (v: number[], ...against: number[][]) => unit(against.reduce((acc, b) => add(acc, b, -dot(acc, b)), v));
const MEANING = unit(raw());
const EN = orth(raw(), MEANING);
const KR = orth(raw(), MEANING, EN);
const NOISE = orth(raw(), MEANING, EN, KR);
// cos(english, korean) = 1 / (1 + 0.2744²) ≈ 0.93 — below the 0.95 candidate gate;
// the two Korean vectors differ only by a little noise (cos ≈ 0.998).
const ENGLISH_VECTOR = unit(add(MEANING, EN, 0.2744));
const KOREAN_VECTOR = unit(add(MEANING, KR, 0.2744));
const KOREAN_VECTOR_2 = unit(add(add(MEANING, KR, 0.2744), NOISE, 0.06));

const T0 = Date.parse('2026-09-26T00:00:00.000Z');
const day = (n: number) => new Date(T0 + n * 86_400_000).toISOString();
const ENGLISH_FACT = 'The Pro plan costs 9 dollars a month';
const KOREAN_FACT = 'Pro 요금제는 한 달에 9달러다';

describe('candidates through the driver\'s own Korean vector', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-kr-'));
    process.env.TEST_DB_PATH = path.join(dir, 'test.db');
    db = initDatabase();
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** English sentence + its Korean translation (two vectors). */
  function seedEnglish(at: string): string {
    const id = insertFact(db, {
      fact: ENGLISH_FACT, category: 'knowledge', scope_type: 'project', scope_project: '/pricing', source_exchange_ids: [],
      embedding: ENGLISH_VECTOR, fact_kr: 'Pro 요금제는 월 9달러다', embedding_kr: KOREAN_VECTOR_2,
    });
    db.prepare('UPDATE facts SET created_at = ? WHERE id = ?').run(at, id);
    return id;
  }
  /** The sentence itself is Korean: its MAIN vector is a Korean-language vector, and it has no translation. */
  function seedKoreanWritten(at: string): string {
    const id = insertFact(db, {
      fact: KOREAN_FACT, category: 'knowledge', scope_type: 'project', scope_project: '/pricing', source_exchange_ids: [],
      embedding: KOREAN_VECTOR,
    });
    db.prepare('UPDATE facts SET created_at = ? WHERE id = ?').run(at, id);
    return id;
  }
  const scope = { type: 'project', project: '/pricing' } as const;
  const prompts = () => (callHaiku as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[1]));

  it('fixture: the English main vector alone does not reach the Korean-written fact', () => {
    const english = seedEnglish(day(1));
    seedKoreanWritten(day(2));
    expect(searchSimilarFactsSameScope(db, ENGLISH_VECTOR, scope, 5, 0.95).map((h) => h.fact.id)).toEqual([english]);
  });

  it('with the driver\'s stored Korean vector the Korean-written fact is a candidate', () => {
    const english = seedEnglish(day(1));
    const korean = seedKoreanWritten(day(2));
    const hits = searchSimilarFactsSameScope(db, ENGLISH_VECTOR, scope, 5, 0.95, { krVectorOfFactId: english });
    expect(hits.map((h) => h.fact.id)).toEqual([english, korean]);
  });

  it('a driver without a Korean vector searches exactly as before', () => {
    const english = seedEnglish(day(1));
    const korean = seedKoreanWritten(day(2));
    const hits = searchSimilarFactsSameScope(db, KOREAN_VECTOR, scope, 5, 0.95, { krVectorOfFactId: korean });
    expect(hits.map((h) => h.fact.id)).toEqual([korean, english]); // via the English fact's Korean vector, as it always could
  });

  it('English driver, Korean-written fact already behind the cursor: the pair is compared', async () => {
    const korean = seedKoreanWritten(day(1));
    seedEnglish(day(2));

    const result = await consolidateAllPending(db, { createdAt: day(1), id: korean });

    expect(prompts()).toEqual([buildConsolidationPrompt(KOREAN_FACT, ENGLISH_FACT)]);
    expect(result.haikuCalls).toBe(1);
  });

  it('Korean-written driver, English fact already behind the cursor: compared as before', async () => {
    const english = seedEnglish(day(1));
    seedKoreanWritten(day(2));

    const result = await consolidateAllPending(db, { createdAt: day(1), id: english });

    expect(prompts()).toEqual([buildConsolidationPrompt(ENGLISH_FACT, KOREAN_FACT)]);
    expect(result.haikuCalls).toBe(1);
  });
});
