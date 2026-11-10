import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';

/**
 * 배치 분류 응답의 번호를 믿어도 되는 때.
 *
 * 응답 항목은 index 값으로만 사실에 대응된다. 모델이 한 항목을 빼고 나머지를 0부터 다시
 * 세거나 1부터 세면 모든 번호가 범위 안의 정수라, 뒤따르는 사실들이 한 칸씩 밀린 분류에
 * 조용히 붙었다(검수 LSO-6). 이제 응답이 요청한 번호를 빠짐없이 한 번씩 담을 때만 적용하고,
 * 아니면 그 배치를 버리고 더 작은 묶음으로 다시 묻는다 — 사실 하나짜리 호출은 번호가
 * 무엇이든 그 사실의 답이다.
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
import { classifyAndLinkFacts, BATCH_CLASSIFY_SYSTEM_PROMPT, DETECT_RELATION_SYSTEM_PROMPT } from '../src/ontology-classifier.js';

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
type Item = Record<string, unknown> & { index: number };
type Payload = { facts: Array<{ index: number; fact: string }> };

describe('batch classification: a reply is applied only when it carries every index exactly once', () => {
  let dir: string;
  let db: Database.Database;
  let restoreConsole: () => void;
  /** What a misbehaving model does to the correct reply of one call. */
  let transform: (items: Item[], asked: Payload['facts']) => unknown;

  // The right category of "fact about X" is "Cat X" — a fact filed under another fact's category shows by name.
  const TOPICS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
  const save = (topics = TOPICS) => topics.map((topic) => {
    const text = `fact about ${topic}`;
    const embedding = textVec(text);
    const factId = insertFact(db, { fact: text, category: 'decision', scope_type: 'project', scope_project: '/tmp/numbering-project', source_exchange_ids: [], embedding });
    return { factId, embedding, topic };
  });
  const filed = (items: Array<{ factId: string; topic: string }>) => items.map((i) => {
    const r = db.prepare(
      `SELECT c.name AS category, f.ontology_attempts AS attempts FROM facts f
       LEFT JOIN ontology_categories c ON c.id = f.ontology_category_id WHERE f.id = ?`,
    ).get(i.factId) as { category: string | null; attempts: number };
    return { topic: i.topic, category: r.category, attempts: r.attempts };
  });
  const wrong = (rows: ReturnType<typeof filed>) => rows.filter((r) => r.category !== null && r.category !== `Cat ${r.topic}`);
  const classifyCalls = () => llm.mock.calls.filter((c) => c[0] === BATCH_CLASSIFY_SYSTEM_PROMPT);
  const askedSizes = () => classifyCalls().map((c) => (JSON.parse(c[1] as string) as Payload).facts.length);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-numbering-'));
    process.env.TEST_DB_PATH = path.join(dir, 'db.sqlite');
    db = initDatabase();
    restoreConsole = suppressConsole();
    transform = (items) => items;
    llm.mockReset();
    llm.mockImplementation(async (system: string, message: string) => {
      if (system === DETECT_RELATION_SYSTEM_PROMPT) return JSON.stringify({ has_relation: false, relation_type: null, reasoning: 'none' });
      const payload = JSON.parse(message) as Payload;
      const items = payload.facts.map((f) => ({
        index: f.index, domain: 'Numbering', category: `Cat ${f.fact.replace('fact about ', '')}`, is_new_domain: false, is_new_category: true,
      }));
      return JSON.stringify(transform(items, payload.facts));
    });
  });
  afterEach(() => {
    restoreConsole();
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the control: a complete reply, in any order, is applied from one call', async () => {
    const items = save();
    transform = (reply) => [...reply].reverse();

    const result = await classifyAndLinkFacts(db, items);

    expect(askedSizes()).toEqual([5]);
    expect(filed(items)).toEqual(TOPICS.map((topic) => ({ topic, category: `Cat ${topic}`, attempts: 0 })));
    expect(result).toMatchObject({ classified: 5, failed: 0, transient: 0, fallback: 0 });
  });

  it('one item left out and the rest renumbered from 0: no fact is filed under another fact\'s category', async () => {
    const items = save();
    // Whenever asked about more than one fact, the model drops its second item and numbers what is left 0..n-2.
    transform = (reply) => (reply.length < 2 ? reply : reply.filter((_, k) => k !== 1).map((item, k) => ({ ...item, index: k })));

    const result = await classifyAndLinkFacts(db, items);

    expect(wrong(filed(items))).toEqual([]);
    expect(filed(items)).toEqual(TOPICS.map((topic) => ({ topic, category: `Cat ${topic}`, attempts: 0 })));
    expect(result).toMatchObject({ classified: 5, failed: 0 });
    expect(askedSizes()[0]).toBe(5);
    expect(askedSizes().length).toBeGreaterThan(1); // the 5-fact reply was not applied; smaller batches were asked
    expect(askedSizes().filter((n) => n === 1).length).toBeGreaterThan(0);
  });

  it('indices counted from 1: nothing is shifted by one', async () => {
    const items = save();
    transform = (reply) => reply.map((item) => ({ ...item, index: item.index + 1 }));

    const result = await classifyAndLinkFacts(db, items);

    expect(wrong(filed(items))).toEqual([]);
    expect(result).toMatchObject({ classified: 5, failed: 0 });
    expect(filed(items).every((r) => r.attempts === 0)).toBe(true);
  });

  it('items in order with no index at all: each fact is asked on its own', async () => {
    const items = save();
    transform = (reply) => reply.map(({ index: _dropped, ...rest }) => rest);

    const result = await classifyAndLinkFacts(db, items);

    expect(wrong(filed(items))).toEqual([]);
    expect(result).toMatchObject({ classified: 5, failed: 0 });
  });

  it('a duplicated index makes the whole reply untrusted', async () => {
    const items = save(['alpha', 'bravo', 'charlie']);
    transform = (reply) => (reply.length < 2 ? reply : reply.map((item, k) => (k === 2 ? { ...item, index: 0 } : item)));

    const result = await classifyAndLinkFacts(db, items);

    expect(wrong(filed(items))).toEqual([]);
    expect(result).toMatchObject({ classified: 3, failed: 0 });
    expect(askedSizes().length).toBeGreaterThan(1);
  });

  it('a fact the model leaves out every time takes one attempt; the others are filed right', async () => {
    const items = save();
    transform = (reply, asked) => reply.filter((item) => asked[item.index].fact !== 'fact about charlie');

    const result = await classifyAndLinkFacts(db, items);

    const rows = filed(items);
    expect(wrong(rows)).toEqual([]);
    expect(rows.find((r) => r.topic === 'charlie')).toEqual({ topic: 'charlie', category: null, attempts: 1 });
    expect(rows.filter((r) => r.topic !== 'charlie').every((r) => r.category === `Cat ${r.topic}` && r.attempts === 0)).toBe(true);
    expect(result).toMatchObject({ classified: 4, failed: 1 });
  });

  it('an index given as a numeric string is that number', async () => {
    const items = save();
    transform = (reply) => reply.map((item) => ({ ...item, index: String(item.index) }));

    const result = await classifyAndLinkFacts(db, items);

    expect(askedSizes()).toEqual([5]);
    expect(filed(items)).toEqual(TOPICS.map((topic) => ({ topic, category: `Cat ${topic}`, attempts: 0 })));
    expect(result).toMatchObject({ classified: 5, failed: 0 });
  });

  it('a reply with no usable item at all is one failed call, not a series of smaller ones', async () => {
    const items = save(['alpha', 'bravo', 'charlie']);
    transform = () => [];

    const result = await classifyAndLinkFacts(db, items);

    expect(askedSizes()).toEqual([3]);
    expect(filed(items).map((r) => [r.category, r.attempts])).toEqual([[null, 1], [null, 1], [null, 1]]);
    expect(result).toMatchObject({ classified: 0, failed: 3 });
  });

  it('a single fact: the one item of the reply is its answer whatever number it carries', async () => {
    const items = save(['alpha']);
    transform = (reply) => reply.map((item) => ({ ...item, index: 7 }));

    const result = await classifyAndLinkFacts(db, items);

    expect(askedSizes()).toEqual([1]);
    expect(filed(items)).toEqual([{ topic: 'alpha', category: 'Cat alpha', attempts: 0 }]);
    expect(result).toMatchObject({ classified: 1, failed: 0 });
  });

  it('a single fact answered with two items is a failed attempt (which one is it?)', async () => {
    const items = save(['alpha']);
    transform = (reply) => [reply[0], { ...reply[0], category: 'Cat other' }];

    const result = await classifyAndLinkFacts(db, items);

    expect(filed(items)).toEqual([{ topic: 'alpha', category: null, attempts: 1 }]);
    expect(result).toMatchObject({ classified: 0, failed: 1 });
  });
});
