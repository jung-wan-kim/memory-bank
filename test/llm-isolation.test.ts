import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Agent SDK 호출 격리 + 추출 단계의 템플릿 누출 차단 (2026-10-03).
 *
 * SDK 0.1.77 에 묶인 CLI 2.0.77 은 호출마다 워밍업 세션 3개를 띄웠고(그중 일부가
 * 'version 2.1.280 or newer is required' 400), 0.3.288 로 올리자 워밍업은 사라졌지만
 * 기본으로 실리는 내장 도구·사용자 MCP 서버 정의 때문에 호출당 프롬프트가 ~32,500
 * 토큰이 됐다. tools: [] + strictMcpConfig 로 ~390 토큰(실측). 이 옵션이 세 호출부
 * 모두에 실리는지 query() 인자를 잡아 확인한다.
 */

const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
let nextResult = '';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args);
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', result: nextResult } as never;
      },
    };
  },
}));

beforeEach(() => {
  calls.length = 0;
  nextResult = '';
  process.env.MEMORY_BANK_LLM_RETRY_BASE_MS = '0';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MEMORY_BANK_API_TOKEN;
});

function expectIsolated(options: Record<string, unknown>) {
  expect(options.tools, '내장 도구 정의를 싣지 않는다').toEqual([]);
  expect(options.strictMcpConfig, '사용자 MCP 서버를 싣지 않는다').toBe(true);
  expect(options.settingSources, '사용자 설정·훅을 싣지 않는다').toEqual([]);
}

describe('headless query() 격리', () => {
  it('callHaiku', async () => {
    nextResult = 'pong';
    const { callHaiku } = await import('../src/llm.js');
    expect(await callHaiku('sys', 'ping')).toBe('pong');
    expectIsolated(calls[0].options);
  });

  it('summarizer', async () => {
    nextResult = '<summary>요약</summary>';
    const { summarizeConversation } = await import('../src/summarizer.js');
    // 교환 1개짜리 짧은 대화는 LLM 없이 '사소한 대화'로 끝나므로 2개를 준다
    await summarizeConversation([1, 2].map((i) => ({
      id: `e${i}`, project: 'p', timestamp: `2026-10-03T00:0${i}:00Z`, archivePath: '/a.jsonl', lineStart: i, lineEnd: i + 1,
      userMessage: `JWT 인증을 리프레시 토큰과 함께 구현해 줘 (${i})`, assistantMessage: `토큰 회전을 포함한 인증 컨텍스트를 만들었습니다 (${i})`,
    })));
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expectIsolated(c.options);
  });

  it('translate-facts 스크립트도 같은 상수를 쓴다', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'translate-facts.mjs'), 'utf8');
    expect(src).toMatch(/\.\.\.ISOLATED_QUERY_OPTIONS/);
    expect(src).not.toMatch(/settingSources:\s*\[\]/);
  });
});

describe('추출 단계의 템플릿 누출 차단', () => {
  it('LLM 이 템플릿 값을 돌려줘도 저장 후보에서 빠진다', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-extract-guard-'));
    const prev = process.env.TEST_DB_PATH;
    process.env.TEST_DB_PATH = path.join(tmp, 't.db');
    try {
      const { initDatabase, insertExchange } = await import('../src/db.js');
      const { extractFactsFromExchanges } = await import('../src/fact-extractor.js');
      const db = initDatabase();
      for (let i = 0; i < 3; i++) {
        insertExchange(db, {
          id: `x${i}`, project: '-p', timestamp: `2026-10-03T00:0${i}:00Z`, sessionId: 'sess-guard',
          userMessage: `배포 파이프라인을 Vercel 프리뷰로 바꾸자. 모든 PR 마다 프리뷰를 만든다 (${i})`,
          assistantMessage: `좋습니다. vercel.json 을 수정해 PR 마다 프리뷰 배포가 생성되도록 설정했습니다 (${i})`,
          archivePath: '/a.jsonl', lineStart: i, lineEnd: i + 1,
        }, new Array(384).fill(0.01));
      }
      nextResult = JSON.stringify([
        { fact: '...', category: '...', scope_type: '...', confidence: 0.95 },
        { fact: 'concise statement', category: 'decision|preference|pattern|knowledge|constraint', scope_type: 'project|global', confidence: 0.95 },
        { fact: 'Every pull request gets a Vercel preview deployment', fact_kr: 'PR 마다 Vercel 프리뷰 배포', category: 'decision', scope_type: 'project', confidence: 0.95 },
      ]);
      const facts = await extractFactsFromExchanges(db, 'sess-guard');
      db.close();
      expect(facts.map((f) => f.fact)).toEqual(['Every pull request gets a Vercel preview deployment']);
    } finally {
      if (prev === undefined) delete process.env.TEST_DB_PATH; else process.env.TEST_DB_PATH = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('query() 실패 지점이 자가치유를 부른다', () => {
  it('callHaiku', async () => {
    const heal = await import('../src/deps-heal.js');
    const spy = vi.spyOn(heal, 'noteSdkFailure').mockImplementation(() => {});
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const err = new Error('Native CLI binary for darwin-arm64 not found.');
    vi.spyOn(sdk, 'query').mockImplementation(() => { throw err; });
    process.env.MEMORY_BANK_LLM_RETRIES = '0';
    try {
      const { callHaiku } = await import('../src/llm.js');
      await expect(callHaiku('sys', 'ping')).rejects.toThrow(/Native CLI binary/);
      expect(spy).toHaveBeenCalledWith(err, 'memory-bank llm');
    } finally {
      delete process.env.MEMORY_BANK_LLM_RETRIES;
      vi.restoreAllMocks();
    }
  });
});
