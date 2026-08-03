import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * callHaiku 복구 계약 (사용자 피드백: "에러나거나 0바이트인데 재시도·복구가 없다").
 *
 * Agent SDK 를 모킹해 실제 LLM 호출 없이 재시도 의미론만 검증한다:
 *  - 빈 응답은 실패로 취급되어 재시도되고, 재시도가 성공하면 정상 반환
 *  - transient 는 재시도 소진 후 '' 가 아니라 throw (호출자가 실패를 인지)
 *  - deterministic 은 재시도하지 않고 즉시 throw (예산 낭비 차단)
 */

// query() 를 모킹 — 호출마다 다음 시나리오를 방출한다.
const scenarios: Array<{ result?: string; throws?: unknown; noResultMessage?: boolean }> = [];
let queryCalls = 0;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (_args: unknown) => {
    const scenario = scenarios[Math.min(queryCalls, scenarios.length - 1)];
    queryCalls++;
    return {
      async *[Symbol.asyncIterator]() {
        if (scenario?.throws) throw scenario.throws;
        if (scenario?.noResultMessage) return; // 스트림이 result 없이 끝남
        yield { type: 'result', result: scenario?.result ?? '' } as never;
      },
    };
  },
}));

async function llm() {
  return await import('../src/llm.js');
}

beforeEach(() => {
  scenarios.length = 0;
  queryCalls = 0;
  process.env.MEMORY_BANK_LLM_RETRY_BASE_MS = '0'; // 테스트에서 백오프 대기 없음
  delete process.env.ANTHROPIC_API_KEY;            // Anthropic SDK 폴백 비활성 (구독 경로만)
  delete process.env.MEMORY_BANK_API_TOKEN;
});
afterEach(() => {
  delete process.env.MEMORY_BANK_LLM_RETRY_BASE_MS;
  delete process.env.MEMORY_BANK_LLM_RETRIES;
});

describe('callHaiku 재시도/복구', () => {
  it('AC1: 빈 응답을 재시도하고, 재시도가 성공하면 결과를 반환한다', async () => {
    const { callHaiku } = await llm();
    scenarios.push({ result: '' }, { result: '{"ok":true}' });
    const out = await callHaiku('sys', 'user');
    expect(out).toBe('{"ok":true}');
    expect(queryCalls).toBe(2); // 1회차 빈응답 → 2회차 성공
  });

  it('AC1b: result 메시지 없이 끝난 스트림도 실패로 보고 재시도한다', async () => {
    const { callHaiku } = await llm();
    scenarios.push({ noResultMessage: true }, { result: 'recovered' });
    expect(await callHaiku('sys', 'user')).toBe('recovered');
    expect(queryCalls).toBe(2);
  });

  it('AC2: 재시도를 소진하면 빈 문자열이 아니라 throw 한다 (fail-loud)', async () => {
    const { callHaiku } = await llm();
    process.env.MEMORY_BANK_LLM_RETRIES = '2';
    scenarios.push({ result: '' }); // 매번 빈 응답
    await expect(callHaiku('sys', 'user')).rejects.toThrow(/empty response/i);
    expect(queryCalls).toBe(3); // 1 + 재시도 2
  });

  it('AC2b: transient 에러(503)도 재시도 후 throw 한다', async () => {
    const { callHaiku } = await llm();
    process.env.MEMORY_BANK_LLM_RETRIES = '1';
    scenarios.push({ throws: Object.assign(new Error('service unavailable'), { status: 503 }) });
    await expect(callHaiku('sys', 'user')).rejects.toThrow(/service unavailable/);
    expect(queryCalls).toBe(2); // 1 + 재시도 1
  });

  it('AC2c: transient 가 회복되면 재시도로 성공한다', async () => {
    const { callHaiku } = await llm();
    scenarios.push(
      { throws: Object.assign(new Error('rate limit'), { status: 429 }) },
      { result: 'after-recovery' },
    );
    expect(await callHaiku('sys', 'user')).toBe('after-recovery');
    expect(queryCalls).toBe(2);
  });

  it('AC3: deterministic 에러는 재시도하지 않고 즉시 throw 한다 (예산 낭비 차단)', async () => {
    const { callHaiku } = await llm();
    process.env.MEMORY_BANK_LLM_RETRIES = '3';
    scenarios.push({ throws: Object.assign(new Error('prompt is too long'), { status: 413 }) });
    await expect(callHaiku('sys', 'user')).rejects.toThrow(/too long/);
    expect(queryCalls).toBe(1); // 재시도 없음
  });

  it('재시도 횟수는 env 로 조절되고 0 이면 재시도하지 않는다', async () => {
    const { callHaiku } = await llm();
    process.env.MEMORY_BANK_LLM_RETRIES = '0';
    scenarios.push({ result: '' });
    await expect(callHaiku('sys', 'user')).rejects.toThrow();
    expect(queryCalls).toBe(1);
  });

  it('백오프는 상한이 있다 — 오타 하나로 워커가 정지하지 않는다 (Codex MEDIUM)', async () => {
    const { callHaiku } = await import('../src/llm.js');
    process.env.MEMORY_BANK_LLM_RETRY_BASE_MS = '500000'; // 오타 시나리오: 500초
    process.env.MEMORY_BANK_LLM_RETRIES = '1';
    scenarios.push({ result: '' }, { result: 'ok' });
    const t0 = Date.now();
    await callHaiku('sys', 'user');
    // base 5s 상한이므로 첫 백오프는 최대 5s — 500s 가 아니다. 여유 있게 20s 로 검증.
    expect(Date.now() - t0).toBeLessThan(20_000);
  }, 30_000);

  it('성공 반환값은 비어있지 않음이 보장된다 (호출자 계약)', async () => {
    const { callHaiku } = await llm();
    scenarios.push({ result: '   ' }, { result: 'real' }); // 공백만 = 빈 응답 취급
    expect((await callHaiku('sys', 'user')).trim()).not.toBe('');
    expect(queryCalls).toBe(2);
  });
});

describe('분류기 단일 소스 (llm-error-class)', () => {
  it('EmptyLlmResponseError 는 transient 로 분류된다', async () => {
    const { classifyLlmError, EmptyLlmResponseError, LlmCallError } = await import('../src/llm-error-class.js');
    expect(classifyLlmError(new EmptyLlmResponseError())).toBe('transient');
    // LlmCallError 로 감싸도 내부 원인으로 분류된다
    expect(classifyLlmError(new LlmCallError(new EmptyLlmResponseError()))).toBe('transient');
  });

  // Codex 적대 리뷰 2026-07-17 회귀 고정: 아래 shape 들이 'unknown' 으로 떨어지면
  // fact-extractor 가 배치를 버리고 세션을 완료 기록해 원 결함(영구 손실)이 재현된다.
  it('status 필드 없는 provider/전송 실패 shape 도 transient 로 분류된다', async () => {
    const { classifyLlmError } = await import('../src/llm-error-class.js');
    for (const msg of [
      'API Error: 500 Internal Server Error',
      'Internal Server Error',
      'API Error: 503',
      'http error 429',
      'fetch failed',
      'stream disconnected before completion',
      'premature close',
    ]) {
      expect(classifyLlmError(new Error(msg)), msg).toBe('transient');
    }
  });

  it('그래도 bare 숫자는 상태코드로 읽지 않는다 (오분류 회귀 방지)', async () => {
    const { classifyLlmError } = await import('../src/llm-error-class.js');
    // 'retry after 400 ms' 의 400 을 deterministic 으로 읽으면 안 된다.
    expect(classifyLlmError(new Error('rate limit: retry after 400 ms'))).toBe('transient');
    expect(classifyLlmError(new Error('processed 500 items'))).toBe('unknown');
    // per-request 오류는 여전히 deterministic 이어야 한다 (재시도 낭비 차단 유지).
    expect(classifyLlmError(new Error('prompt is too long'))).toBe('deterministic');
    expect(classifyLlmError(new Error('Request failed with status code 400'))).toBe('deterministic');
  });

  // Codex R3 CRITICAL 회귀 고정: 에러 단어 없이 '<명사> <숫자>' 가 오면 그 숫자를
  // 상태코드로 읽으면 안 된다. 'response 400 ms timeout' 이 HTTP 400(deterministic)
  // 으로 뒤집히면 타임아웃 배치가 영구 폐기돼 데이터 손실이 재현된다.
  it('에러 단어 없는 근접 숫자를 상태코드로 오독하지 않는다 (R3 CRITICAL)', async () => {
    const { classifyLlmError } = await import('../src/llm-error-class.js');
    // timeout 문구가 있으므로 transient 여야 한다 (절대 deterministic 아님).
    expect(classifyLlmError(new Error('response 400 ms timeout'))).toBe('transient');
    expect(classifyLlmError(new Error('server 503 ms latency, socket hang up'))).toBe('transient');
    // 문구 단서가 없으면 unknown — 추출 경로가 이연하므로 손실이 없다(안전 방향).
    expect(classifyLlmError(new Error('request 400 ms'))).toBe('unknown');
    expect(classifyLlmError(new Error('response 413 items'))).toBe('unknown');
    // 진짜 provider 코드 shape 는 계속 인식돼야 한다.
    expect(classifyLlmError(new Error('API Error: 500 Internal Server Error'))).toBe('transient');
    expect(classifyLlmError(new Error('http error 429'))).toBe('transient');
    expect(classifyLlmError(new Error('api error: 413'))).toBe('deterministic');
  });

  it('consolidator 는 같은 구현을 re-export 한다 (중복 정의 없음)', async () => {
    const shared = await import('../src/llm-error-class.js');
    const consolidator = await import('../src/consolidator.js');
    expect(consolidator.classifyLlmError).toBe(shared.classifyLlmError);
    expect(consolidator.isTransientLlmError).toBe(shared.isTransientLlmError);
    expect(consolidator.LlmCallError).toBe(shared.LlmCallError);
  });
});
