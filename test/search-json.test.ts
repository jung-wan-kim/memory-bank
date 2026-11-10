import { describe, it, expect } from 'vitest';
import {
  searchResultsToJson,
  multiConceptResultsToJson,
  SEARCH_JSON_MESSAGE_CHARS,
  type SearchHit,
} from '../src/search.js';
import type { MultiConceptResult } from '../src/types.js';

// SQ-14 — the json response serialized every exchange in full (user + assistant text, indented): limit 10
// answered with 38K–165K characters, limit 50 with 272K. A result now carries what the markdown carries —
// where the exchange is and a clipped look at it — and the full text is one `read` away.

const hit = (i: number, chars: number): SearchHit => ({
  exchange: {
    id: `ex-${i}`,
    project: 'demo',
    timestamp: '2026-10-01T00:00:00.000Z',
    userMessage: `question ${i} ` + 'q'.repeat(chars),
    assistantMessage: `answer ${i} ` + 'a'.repeat(chars),
    archivePath: `/archive/demo/session-${i}.jsonl`,
    lineStart: i * 10 + 1,
    lineEnd: i * 10 + 9,
    codingAgent: 'claude-code',
    toolCalls: [{ id: 't', exchangeId: `ex-${i}`, toolName: 'Bash', toolInput: { command: 'x'.repeat(chars) }, isError: false, timestamp: '2026-10-01T00:00:00.000Z' }],
  },
  similarity: 0.9,
  matchedBy: 'vector',
  snippet: `question ${i}`,
  summary: 'a summary',
});

describe('search json response', () => {
  it('clips each message and stays within a per-result budget at limit 50', () => {
    expect(SEARCH_JSON_MESSAGE_CHARS).toBe(500);
    const text = searchResultsToJson(Array.from({ length: 50 }, (_, i) => hit(i, 20_000)), { folded: 0 }, 'both');
    expect(text.length).toBeLessThanOrEqual(50 * 1_800);

    const parsed = JSON.parse(text) as {
      count: number; mode: string; notes: string[]; hint: string;
      results: Array<{ exchange: Record<string, unknown>; similarity: number; matchedBy: string; snippet: string; clipped: boolean }>;
    };
    expect(parsed.count).toBe(50);
    expect(parsed.mode).toBe('both');
    expect(parsed.hint).toMatch(/read/);
    const first = parsed.results[0];
    expect((first.exchange.userMessage as string).length).toBeLessThanOrEqual(SEARCH_JSON_MESSAGE_CHARS + 1);
    expect((first.exchange.assistantMessage as string).length).toBeLessThanOrEqual(SEARCH_JSON_MESSAGE_CHARS + 1);
    expect(first.exchange.userMessage).toMatch(/^question 0 q+…$/);
    expect(first.clipped).toBe(true);
    // where to read the full exchange
    expect(first.exchange).toMatchObject({ id: 'ex-0', archivePath: '/archive/demo/session-0.jsonl', lineStart: 1, lineEnd: 9, project: 'demo' });
    expect(first.exchange.toolCalls).toBeUndefined();
    expect(first).toMatchObject({ similarity: 0.9, matchedBy: 'vector', snippet: 'question 0' });
  });

  it('leaves short messages whole and says they were not clipped', () => {
    const parsed = JSON.parse(searchResultsToJson([hit(1, 10)], undefined, 'text')) as {
      results: Array<{ exchange: { userMessage: string; assistantMessage: string }; clipped: boolean }>;
    };
    expect(parsed.results[0].exchange.userMessage).toBe('question 1 qqqqqqqqqq');
    expect(parsed.results[0].exchange.assistantMessage).toBe('answer 1 aaaaaaaaaa');
    expect(parsed.results[0].clipped).toBe(false);
  });

  it('carries the search notes', () => {
    const parsed = JSON.parse(searchResultsToJson([], { vector: { k: 4096, candidates: 4096, matched: 0, truncated: true } }, 'vector')) as { notes: string[]; count: number };
    expect(parsed.count).toBe(0);
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0]).toMatch(/nearest 4096 vector candidates/);
  });

  it('multi-concept results are clipped the same way', () => {
    const results: MultiConceptResult[] = Array.from({ length: 20 }, (_, i) => ({
      exchange: hit(i, 20_000).exchange,
      snippet: `question ${i}`,
      conceptSimilarities: [0.9, 0.8],
      averageSimilarity: 0.85,
    }));
    const text = multiConceptResultsToJson(results, ['alpha', 'beta']);
    expect(text.length).toBeLessThanOrEqual(20 * 1_800);
    const parsed = JSON.parse(text) as { concepts: string[]; count: number; results: Array<{ exchange: { userMessage: string }; conceptSimilarities: number[]; averageSimilarity: number }> };
    expect(parsed.concepts).toEqual(['alpha', 'beta']);
    expect(parsed.count).toBe(20);
    expect(parsed.results[0].exchange.userMessage.length).toBeLessThanOrEqual(SEARCH_JSON_MESSAGE_CHARS + 1);
    expect(parsed.results[0]).toMatchObject({ conceptSimilarities: [0.9, 0.8], averageSimilarity: 0.85 });
  });
});
