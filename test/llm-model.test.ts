import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * 기본 모델 고정 + Haiku 5.5 의 API 키 경로 계약 (2026-10-08).
 *
 * 'haiku' 별칭은 번들 CLI 버전마다 다른 모델로 풀렸다(SDK 0.1.77 → claude-haiku-4-5-20251001,
 * 0.3.293 → claude-haiku-5-5, 실측). 그래서 모델 id 를 직접 넘기는지 query() 인자로 확인한다.
 * API 키 경로는 Haiku 5.5 에서 두 가지가 달라진다:
 *  - 사고가 기본으로 켜지고 max_tokens 를 함께 쓴다 → 기본 모델일 때만 thinking 을 끈다
 *    (Opus 5.5 / Sonnet 5.5 는 'disabled' 를 400 으로 거부하므로 덮어쓴 모델엔 보내지 않는다)
 *  - 거절(stop_reason: refusal)은 본문이 없다 → 빈 응답(transient, 무한 보류)이 아니라
 *    deterministic 으로 즉시 throw 해야 한 fact 가 커서를 영구히 붙잡지 않는다
 */

const queryCalls: Array<{ options: Record<string, unknown> }> = [];
let agentThrows: unknown = null;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    queryCalls.push(args);
    return {
      async *[Symbol.asyncIterator]() {
        if (agentThrows) throw agentThrows;
        yield { type: 'result', result: 'agent-ok' } as never;
      },
    };
  },
}));

const createCalls: Array<Record<string, unknown>> = [];
let apiResponse: Record<string, unknown> = {};

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (params: Record<string, unknown>) => {
        createCalls.push(params);
        return apiResponse;
      },
    };
  },
}));

beforeEach(() => {
  queryCalls.length = 0;
  createCalls.length = 0;
  agentThrows = null;
  apiResponse = {};
  process.env.MEMORY_BANK_LLM_RETRY_BASE_MS = '0';
  delete process.env.MEMORY_BANK_FACT_MODEL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MEMORY_BANK_API_TOKEN;
});
afterEach(() => {
  delete process.env.MEMORY_BANK_LLM_RETRY_BASE_MS;
  delete process.env.MEMORY_BANK_LLM_RETRIES;
  delete process.env.MEMORY_BANK_FACT_MODEL;
  delete process.env.ANTHROPIC_API_KEY;
});

/** Agent SDK 를 실패시켜 API 키 경로로 넘긴다. */
function useApiPath() {
  agentThrows = new Error('Native agent unavailable');
  process.env.ANTHROPIC_API_KEY = 'test-key';
}

describe('기본 모델', () => {
  it('Agent SDK 경로는 별칭이 아니라 claude-haiku-5-5 를 넘긴다', async () => {
    const { callHaiku, DEFAULT_LLM_MODEL } = await import('../src/llm.js');
    expect(DEFAULT_LLM_MODEL).toBe('claude-haiku-5-5');
    expect(await callHaiku('sys', 'ping')).toBe('agent-ok');
    expect(queryCalls[0].options.model).toBe('claude-haiku-5-5');
  });

  it('MEMORY_BANK_FACT_MODEL 로 덮어쓸 수 있다', async () => {
    process.env.MEMORY_BANK_FACT_MODEL = 'claude-sonnet-5-5';
    const { callHaiku } = await import('../src/llm.js');
    await callHaiku('sys', 'ping');
    expect(queryCalls[0].options.model).toBe('claude-sonnet-5-5');
  });

  it('요약기도 같은 기본 모델을 쓴다', async () => {
    const { summarizeConversation } = await import('../src/summarizer.js');
    await summarizeConversation([1, 2].map((i) => ({
      id: `e${i}`, project: 'p', timestamp: `2026-10-08T00:0${i}:00Z`, archivePath: '/a.jsonl', lineStart: i, lineEnd: i + 1,
      userMessage: `JWT 인증을 리프레시 토큰과 함께 구현해 줘 (${i})`, assistantMessage: `토큰 회전을 포함한 인증 컨텍스트를 만들었습니다 (${i})`,
    })));
    expect(queryCalls.length).toBeGreaterThan(0);
    expect(queryCalls[0].options.model).toBe('claude-haiku-5-5');
  });
});

describe('API 키 경로 (Haiku 5.5)', () => {
  it('기본 모델이면 claude-haiku-5-5 로, 사고를 끈 채 요청한다', async () => {
    useApiPath();
    apiResponse = { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }] };
    const { callHaiku } = await import('../src/llm.js');
    expect(await callHaiku('sys', 'ping', 256)).toBe('{"ok":true}');
    expect(createCalls[0].model).toBe('claude-haiku-5-5');
    expect(createCalls[0].max_tokens).toBe(256);
    expect(createCalls[0].thinking).toEqual({ type: 'disabled' });
  });

  it('덮어쓴 모델에는 thinking 을 보내지 않는다 (Sonnet 5.5 는 disabled 를 400 으로 거부)', async () => {
    useApiPath();
    process.env.MEMORY_BANK_FACT_MODEL = 'claude-sonnet-5-5';
    apiResponse = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
    const { callHaiku } = await import('../src/llm.js');
    await callHaiku('sys', 'ping');
    expect(createCalls[0].model).toBe('claude-sonnet-5-5');
    expect('thinking' in createCalls[0]).toBe(false);
  });

  it('본문을 위치가 아니라 type 으로 읽는다 (사고 블록이 앞에 올 수 있다)', async () => {
    useApiPath();
    apiResponse = {
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'answer' }],
    };
    const { callHaiku } = await import('../src/llm.js');
    expect(await callHaiku('sys', 'ping')).toBe('answer');
  });

  it('거절은 재시도하지 않고 deterministic 으로 즉시 throw 한다', async () => {
    useApiPath();
    process.env.MEMORY_BANK_LLM_RETRIES = '3';
    apiResponse = { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [] };
    const { callHaiku } = await import('../src/llm.js');
    const { LlmRefusalError, classifyLlmError } = await import('../src/llm-error-class.js');
    const err = await callHaiku('sys', 'ping').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRefusalError);
    expect((err as InstanceType<typeof LlmRefusalError>).category).toBe('cyber');
    expect(classifyLlmError(err)).toBe('deterministic');
    expect(createCalls.length).toBe(1); // 재시도 없음 — 같은 입력은 다시 거절된다
  });
});
