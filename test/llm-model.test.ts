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
/** Messages the mocked Agent SDK stream emits; null → one plain success result. */
let agentMessages: Array<Record<string, unknown>> | null = null;
/** Per-call scripts: each query() takes the next one; when empty, agentMessages applies. */
const agentQueue: Array<Array<Record<string, unknown>>> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    queryCalls.push(args);
    const scripted = agentQueue.shift();
    return {
      async *[Symbol.asyncIterator]() {
        if (agentThrows) throw agentThrows;
        for (const m of scripted ?? agentMessages ?? [{ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'agent-ok' }]) {
          yield m as never;
        }
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

/** A refused Agent SDK turn, as SDK 0.3.293 emits it. */
const refusalTurn = [
  { type: 'system', subtype: 'model_refusal_no_fallback', original_model: 'claude-haiku-5-5', request_id: null, api_refusal_category: 'cyber' },
  { type: 'result', subtype: 'success', is_error: true, stop_reason: 'refusal', result: 'Claude Code is unable to respond to this request' },
];

beforeEach(() => {
  queryCalls.length = 0;
  createCalls.length = 0;
  agentThrows = null;
  agentMessages = null;
  agentQueue.length = 0;
  apiResponse = {};
  process.env.MEMORY_BANK_LLM_RETRY_BASE_MS = '0';
  delete process.env.MEMORY_BANK_FACT_MODEL;
  delete process.env.MEMORY_BANK_API_MODEL; // the summarizer's override — a value left in the shell would mask its default
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

describe('Agent SDK 경로의 오류 턴 (기본 경로)', () => {
  // SDK 문서: subtype 'success' 라도 is_error 면 result 에 답이 아니라 오류 문구가 들어 있다.
  // 예전엔 그 문구를 답으로 돌려줘 호출자가 JSON 없음 → 배치를 조용히 비웠다.

  it('거절은 LlmRefusalError(범주 포함)로 즉시 throw 하고, API 키 경로로 다시 보내지 않는다', async () => {
    agentMessages = refusalTurn;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.MEMORY_BANK_LLM_RETRIES = '3';
    const { callHaiku } = await import('../src/llm.js');
    const { LlmRefusalError, classifyLlmError } = await import('../src/llm-error-class.js');
    const err = await callHaiku('sys', 'ping').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRefusalError);
    expect((err as InstanceType<typeof LlmRefusalError>).category).toBe('cyber');
    expect(classifyLlmError(err)).toBe('deterministic');
    expect(queryCalls.length).toBe(1);
    expect(createCalls.length).toBe(0);
  });

  it('API 오류로 끝난 턴은 오류 문구로 throw 해 분류기가 읽는다 (500 → transient, 재시도)', async () => {
    agentMessages = [{ type: 'result', subtype: 'success', is_error: true, stop_reason: null, result: 'API Error: 500 Internal Server Error' }];
    process.env.MEMORY_BANK_LLM_RETRIES = '1';
    const { callHaiku } = await import('../src/llm.js');
    const { classifyLlmError } = await import('../src/llm-error-class.js');
    const err = await callHaiku('sys', 'ping').catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/API Error: 500/);
    expect(classifyLlmError(err)).toBe('transient');
    expect(queryCalls.length).toBe(2); // 1 + 재시도 1
  });

  it('오류 subtype 으로 끝난 턴도 throw 한다', async () => {
    agentMessages = [{ type: 'result', subtype: 'error_during_execution', is_error: true, stop_reason: null, errors: ['spawn failed'] }];
    process.env.MEMORY_BANK_LLM_RETRIES = '0';
    const { callHaiku } = await import('../src/llm.js');
    await expect(callHaiku('sys', 'ping')).rejects.toThrow(/error_during_execution: spawn failed/);
  });

  it('요약기는 오류 턴의 문구를 요약으로 돌려주지 않고 throw 한다', async () => {
    agentMessages = [{ type: 'result', subtype: 'success', is_error: true, stop_reason: null, result: 'API Error: 500 Internal Server Error' }];
    const { summarizeConversation } = await import('../src/summarizer.js');
    await expect(summarizeConversation([1, 2].map((i) => ({
      id: `e${i}`, project: 'p', timestamp: `2026-10-08T00:0${i}:00Z`, archivePath: '/a.jsonl', lineStart: i, lineEnd: i + 1,
      userMessage: `질문 ${i}`, assistantMessage: `답 ${i}`,
    })))).rejects.toThrow(/Summary call failed .*API Error: 500/);
  });

  // 거절은 다음 실행에도 같다. 아무것도 안 쓰면 sync 가 매번 다시 요약하고, 한 번에
  // summaryLimit 개만 디렉터리 순서로 처리하므로 늘 거절되는 대화가 그 자리를 영구히 차지한다.
  it('요약기는 거절된 대화에 거절 표식을 돌려준다 (오류 문구가 아니라, 끝없는 재시도도 아니라)', async () => {
    agentMessages = refusalTurn;
    const { summarizeConversation, REFUSED_SUMMARY } = await import('../src/summarizer.js');
    expect(await summarizeConversation([1, 2].map((i) => ({
      id: `e${i}`, project: 'p', timestamp: `2026-10-08T00:0${i}:00Z`, archivePath: '/a.jsonl', lineStart: i, lineEnd: i + 1,
      userMessage: `JWT 인증을 리프레시 토큰과 함께 구현해 줘 (${i})`, assistantMessage: `토큰 회전을 포함한 인증 컨텍스트를 만들었습니다 (${i})`,
    })))).toBe(REFUSED_SUMMARY);
    expect(queryCalls.length).toBe(1);
  });

  // result 메시지 없이 끝난 스트림을 '' 로 돌려주면 빈 요약 파일이 쓰이고 다시는 요약되지 않았다.
  it('요약기는 결과 메시지 없이 끝난 스트림을 빈 요약이 아니라 실패로 throw 한다', async () => {
    agentMessages = [];
    const { summarizeConversation } = await import('../src/summarizer.js');
    await expect(summarizeConversation([1, 2].map((i) => ({
      id: `e${i}`, project: 'p', timestamp: `2026-10-08T00:0${i}:00Z`, archivePath: '/a.jsonl', lineStart: i, lineEnd: i + 1,
      userMessage: `질문 ${i}`, assistantMessage: `답 ${i}`,
    })))).rejects.toThrow(/without a result/);
  });

  // 성공 턴인데 본문이 비었거나 태그 안이 비면 '' 가 요약으로 쓰였다 (4차 검토 N6).
  it.each([
    ['본문이 빈 성공 턴', ''],
    ['빈 summary 태그', '<summary>  </summary>'],
  ])('요약기는 %s 을 빈 요약이 아니라 실패로 throw 한다', async (_label, text) => {
    agentMessages = [{ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: text }];
    const { summarizeConversation } = await import('../src/summarizer.js');
    await expect(summarizeConversation([1, 2].map((i) => ({
      id: `e${i}`, project: 'p', timestamp: `2026-10-08T00:0${i}:00Z`, archivePath: '/a.jsonl', lineStart: i, lineEnd: i + 1,
      userMessage: `질문 ${i}`, assistantMessage: `답 ${i}`,
    })))).rejects.toThrow(/no summary text/);
  });
});

describe('API 키 경로의 max_tokens 소진', () => {
  // 사고하는 모델(덮어쓴 Sonnet 5.5 — thinking 을 끌 수 없다)에 답 길이로 잡은 한도를
  // 주면 사고가 한도를 다 쓴다. 설정 문제이지 요청의 잘못이 아니므로 빈 응답(transient)
  // 으로 남아 배치가 이연돼야 한다 — deterministic 이면 추출 배치가 영구 폐기된다.
  it('본문 없이 max_tokens 로 끝나면 이연(transient)되고 영구 폐기되지 않는다', async () => {
    useApiPath();
    process.env.MEMORY_BANK_FACT_MODEL = 'claude-sonnet-5-5';
    process.env.MEMORY_BANK_LLM_RETRIES = '1';
    apiResponse = { stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '', signature: 's' }] };
    const { callHaiku } = await import('../src/llm.js');
    const { classifyLlmError, EmptyLlmResponseError } = await import('../src/llm-error-class.js');
    const err = await callHaiku('sys', 'ping', 256).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmptyLlmResponseError);
    expect(classifyLlmError(err)).toBe('transient');
    expect(createCalls.length).toBe(2); // 1 + 재시도 1
  });
});

describe('Agent SDK 거절 신호와 대체 모델 (2차 검토)', () => {
  it('거절 알림(model_refusal_no_fallback)만 있고 stop_reason 이 비어 있어도 거절로 판정한다', async () => {
    agentMessages = [
      { type: 'system', subtype: 'model_refusal_no_fallback', original_model: 'claude-haiku-5-5', request_id: null, api_refusal_category: null },
      { type: 'result', subtype: 'success', is_error: true, stop_reason: null, result: 'unable to respond' },
    ];
    process.env.MEMORY_BANK_LLM_RETRIES = '3';
    const { callHaiku } = await import('../src/llm.js');
    const { LlmRefusalError } = await import('../src/llm-error-class.js');
    await expect(callHaiku('sys', 'ping')).rejects.toBeInstanceOf(LlmRefusalError);
    expect(queryCalls.length).toBe(1);
  });

  it('대체 모델이 답한 턴은 그 답을 돌려준다 (거절로 버리지 않는다)', async () => {
    agentMessages = [
      { type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry', original_model: 'claude-haiku-5-5', fallback_model: 'claude-sonnet-5-5', request_id: null, content: '' },
      { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: '{"ok":true}' },
    ];
    const { callHaiku } = await import('../src/llm.js');
    expect(await callHaiku('sys', 'ping')).toBe('{"ok":true}');
  });

  it('요약기는 is_error 없이 stop_reason 만 refusal 인 턴도 그 문구를 요약으로 쓰지 않는다', async () => {
    agentMessages = [{ type: 'result', subtype: 'success', is_error: false, stop_reason: 'refusal', result: 'I cannot help with that' }];
    const { summarizeConversation, REFUSED_SUMMARY } = await import('../src/summarizer.js');
    expect(await summarizeConversation([1, 2].map((i) => ({
      id: `e${i}`, project: 'p', timestamp: `2026-10-08T00:0${i}:00Z`, archivePath: '/a.jsonl', lineStart: i, lineEnd: i + 1,
      userMessage: `질문 ${i}`, assistantMessage: `답 ${i}`,
    })))).toBe(REFUSED_SUMMARY);
  });

  const longConversation = () => Array.from({ length: 24 }, (_, i) => ({
    id: `e${i}`, project: 'p', timestamp: `2026-10-08T00:${String(i).padStart(2, '0')}:00Z`, archivePath: '/a.jsonl', lineStart: i, lineEnd: i + 1,
    userMessage: `질문 ${i}`, assistantMessage: `답 ${i}`,
  })); // 8개씩 3청크
  const ok = (text: string) => [{ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: `<summary>${text}</summary>` }];
  const fail500 = [{ type: 'result', subtype: 'success', is_error: true, stop_reason: null, result: 'API Error: 500 Internal Server Error' }];
  const fail400 = [{ type: 'result', subtype: 'success', is_error: true, stop_reason: null, result: 'API Error: 400 prompt is too long' }];
  const cutOff = [{ type: 'result', subtype: 'success', is_error: true, stop_reason: 'max_tokens', result: "API Error: Claude's response exceeded the 4096 output token maximum." }];
  const emptyOk = [{ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: '' }];

  // 청크 하나가 일시 장애로 실패하면 나머지 청크도 실패할 공산이 크고, 통과한 청크만으로 만든
  // 요약은 영구히 쓰인다. 중단해 파일을 쓰지 않아야 다음 sync 가 다시 요약한다.
  it('긴 대화의 청크 호출이 실패하면 남은 청크를 부르지 않고 throw 한다 (부분 요약을 쓰지 않는다)', async () => {
    agentQueue.push(ok('첫 청크'), fail500, ok('셋째 청크'), ok('합성'));
    const { summarizeConversation } = await import('../src/summarizer.js');
    await expect(summarizeConversation(longConversation())).rejects.toThrow(/API Error: 500/);
    expect(queryCalls.length).toBe(2);
  });

  it('긴 대화의 거절된 청크는 건너뛰고 나머지로 요약한다', async () => {
    agentQueue.push(ok('첫 청크'), refusalTurn, ok('셋째 청크'), ok('합성 결과'));
    const { summarizeConversation } = await import('../src/summarizer.js');
    expect(await summarizeConversation(longConversation())).toBe('합성 결과');
    expect(queryCalls.length).toBe(4);
    expect(String((queryCalls[3] as unknown as { prompt: string }).prompt)).toContain('1. 첫 청크\n2. 셋째 청크');
  });

  // 다시 해도 같은 이유로 실패하는 청크에서 중단하면, sync 마다 그 앞 청크를 전부 다시
  // 부르고도 요약은 끝내 쓰이지 않는다 (4차 검토 N2). 거절처럼 건너뛴다.
  it('긴 대화의 청크가 다시 해도 같은 이유로 실패(400)하면 건너뛰고 나머지로 요약한다', async () => {
    agentQueue.push(ok('첫 청크'), fail400, ok('셋째 청크'), ok('합성 결과'));
    const { summarizeConversation } = await import('../src/summarizer.js');
    await expect(summarizeConversation(longConversation())).resolves.toBe('합성 결과');
    expect(queryCalls.length).toBe(4);
  });

  it('400 청크 다음에 통과한 청크가 있으면 계속한다', async () => {
    agentQueue.push(fail400, ok('둘째 청크'), ok('셋째 청크'), ok('합성 결과'));
    const { summarizeConversation } = await import('../src/summarizer.js');
    await expect(summarizeConversation(longConversation())).resolves.toBe('합성 결과');
    expect(queryCalls.length).toBe(4);
  });

  // 모든 요청이 400 을 받는 상황(설정·계정)에서 청크마다 부르면 sync 마다 대화당 N회가 된다 (5차 검토 F-B).
  it('통과한 청크 없이 400 이 두 번 나면 남은 청크를 부르지 않고 throw 한다', async () => {
    agentMessages = fail400;
    const { summarizeConversation } = await import('../src/summarizer.js');
    await expect(summarizeConversation(longConversation())).rejects.toThrow(/API Error: 400/);
    expect(queryCalls.length).toBe(2);
  });

  it('거절과 400 만으로 끝나 통과한 청크가 없으면 아무것도 쓰지 않도록 throw 한다 (거절 표식도 아니다)', async () => {
    agentQueue.push(refusalTurn, fail400, refusalTurn);
    const { summarizeConversation } = await import('../src/summarizer.js');
    await expect(summarizeConversation(longConversation())).rejects.toThrow(/all 3 chunks were refused or rejected/);
  });

  // 출력 한도 초과는 분류기에서 "다시 해도 같은 실패"로 읽힌다. 건너뛰면 부분 요약이 영구히
  // 쓰이는데, 이는 요청이 아니라 설정(사고하는 모델의 한도) 문제다 (5차 검토 F-A).
  it('출력 한도에 걸린 청크는 건너뛰지 않고 요약 전체를 실패로 끝낸다', async () => {
    agentQueue.push(ok('첫 청크'), cutOff, ok('셋째 청크'), ok('합성'));
    const { summarizeConversation } = await import('../src/summarizer.js');
    await expect(summarizeConversation(longConversation())).rejects.toThrow(/output token cap/);
    expect(queryCalls.length).toBe(2);
  });

  it('본문이 빈 청크(분류 불명)는 건너뛰지 않고 요약 전체를 실패로 끝낸다', async () => {
    agentQueue.push(ok('첫 청크'), emptyOk, ok('셋째 청크'), ok('합성'));
    const { summarizeConversation } = await import('../src/summarizer.js');
    await expect(summarizeConversation(longConversation())).rejects.toThrow(/no summary text/);
    expect(queryCalls.length).toBe(2);
  });

  it('긴 대화의 청크가 전부 거절되면 거절 표식을 돌려준다', async () => {
    agentMessages = refusalTurn;
    const { summarizeConversation, REFUSED_SUMMARY } = await import('../src/summarizer.js');
    expect(await summarizeConversation(longConversation())).toBe(REFUSED_SUMMARY);
    expect(queryCalls.length).toBe(3);
  });
});

describe('요약기의 사고 예산 분기', () => {
  it('대체 모델도 thinking.budget 오류를 내면 그 문구를 요약으로 돌려주지 않고 throw 한다', async () => {
    agentMessages = [{ type: 'result', subtype: 'success', is_error: true, stop_reason: null, result: 'API Error: 400 thinking.budget_tokens must be less than max_tokens' }];
    const { summarizeConversation } = await import('../src/summarizer.js');
    await expect(summarizeConversation([1, 2].map((i) => ({
      id: `e${i}`, project: 'p', timestamp: `2026-10-08T00:0${i}:00Z`, archivePath: '/a.jsonl', lineStart: i, lineEnd: i + 1,
      userMessage: `질문 ${i}`, assistantMessage: `답 ${i}`,
    })))).rejects.toThrow(/thinking budget/);
    expect(queryCalls.length).toBe(2); // 기본 모델 1회 + 대체 모델 1회
  });
});
