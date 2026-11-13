import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * TC-ENV-004 — the LLM call a shared server makes for a session runs with that session's settings.
 *
 * A shared server's own environment has no account, endpoint or model setting (shared-identity.ts: those are
 * the session's, declared with its connection). So the call has to hand them to the LLM child — and to the
 * API-key fallback client, which otherwise reads them from the process it runs in.
 */

const queries: Array<{ options: Record<string, unknown> }> = [];
let agentSdkFails = false;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    queries.push(args);
    if (agentSdkFails) throw new Error('agent sdk unavailable in this test');
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', result: 'pong' } as never;
      },
    };
  },
}));

const clients: Array<Record<string, unknown>> = [];

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(options: Record<string, unknown>) {
      clients.push(options);
    }
    messages = {
      create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'fallback-pong' }] }),
    };
  },
}));

const TOUCHED = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'MEMORY_BANK_API_TOKEN', 'MEMORY_BANK_API_BASE_URL', 'MEMORY_BANK_LLM_RETRY_BASE_MS', 'MB_TEST_SERVER_OWN',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  queries.length = 0;
  clients.length = 0;
  agentSdkFails = false;
  for (const name of TOUCHED) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.MEMORY_BANK_LLM_RETRY_BASE_MS = '0';
});
afterEach(() => {
  for (const name of TOUCHED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const SESSION = { ANTHROPIC_BASE_URL: 'https://llm.session.invalid', ANTHROPIC_AUTH_TOKEN: 'session-token', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'session-model' };

describe('callHaiku — the environment of the LLM child', () => {
  it("a session's settings go to the child on top of this process's environment", async () => {
    process.env.MB_TEST_SERVER_OWN = 'kept';
    process.env.ANTHROPIC_BASE_URL = 'https://server-process.invalid';
    const { callHaiku } = await import('../src/llm.js');
    expect(await callHaiku('sys', 'ping', 64, { childEnv: SESSION })).toBe('pong');
    const env = queries[0].options.env as Record<string, string>;
    expect(env).toMatchObject(SESSION);
    expect(env.ANTHROPIC_BASE_URL, 'the session wins over the process').toBe('https://llm.session.invalid');
    expect(env.MB_TEST_SERVER_OWN, 'what the process itself needs is still there').toBe('kept');
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('a session that declared nothing still gets an explicit environment: the server one, without a neighbour session', async () => {
    const { callHaiku } = await import('../src/llm.js');
    await callHaiku('sys', 'ping', 64, { childEnv: {} });
    await callHaiku('sys', 'ping', 64, { childEnv: SESSION });
    await callHaiku('sys', 'ping', 64, { childEnv: {} });
    const [first, second, third] = queries.map((q) => q.options.env as Record<string, string>);
    expect(first).toBeDefined();
    expect(second.ANTHROPIC_AUTH_TOKEN).toBe('session-token');
    for (const env of [first, third]) {
      expect(env.ANTHROPIC_AUTH_TOKEN, 'nothing of the other session').toBeUndefined();
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    }
    expect(process.env.ANTHROPIC_AUTH_TOKEN, 'and nothing is written into the process').toBeUndefined();
  });

  it('this process is the caller itself (no childEnv): the SDK default stands — no env option at all', async () => {
    const { callHaiku } = await import('../src/llm.js');
    await callHaiku('sys', 'ping');
    await callHaiku('sys', 'ping', 64, { childEnv: null });
    for (const q of queries) expect('env' in q.options).toBe(false);
    expect(queries).toHaveLength(2);
  });
});

describe('the API-key fallback client', () => {
  it("is built from the calling session's key, endpoint, bearer token and extra headers", async () => {
    agentSdkFails = true;
    const { callHaiku } = await import('../src/llm.js');
    const childEnv = { ...SESSION, ANTHROPIC_API_KEY: 'session-key', ANTHROPIC_CUSTOM_HEADERS: 'x-team: alpha\nx-trace : on\nnot-a-header' };
    expect(await callHaiku('sys', 'ping', 64, { childEnv })).toBe('fallback-pong');
    expect(clients).toEqual([{
      apiKey: 'session-key',
      authToken: 'session-token',
      baseURL: 'https://llm.session.invalid',
      defaultHeaders: { 'x-team': 'alpha', 'x-trace': 'on' },
    }]);
  });

  it('a session without a key has no fallback: the Agent SDK error comes back, and no client is made', async () => {
    agentSdkFails = true;
    const { callHaiku } = await import('../src/llm.js');
    await expect(callHaiku('sys', 'ping', 64, { childEnv: SESSION })).rejects.toThrow(/agent sdk unavailable/);
    expect(clients).toEqual([]);
  });

  it('fallbackClientOptions: memory-bank own endpoint wins; with nothing set the SDK default endpoint stays', async () => {
    const { fallbackClientOptions } = await import('../src/llm.js');
    expect(fallbackClientOptions('k', { ANTHROPIC_BASE_URL: 'https://a.invalid' }, 'https://own.invalid'))
      .toEqual({ apiKey: 'k', authToken: null, baseURL: 'https://own.invalid', defaultHeaders: {} });
    expect(fallbackClientOptions('k', {}, undefined)).toEqual({ apiKey: 'k', authToken: null, defaultHeaders: {} });
    // the same parse the Anthropic SDK applies to ANTHROPIC_CUSTOM_HEADERS: one "name: value" per line
    expect(fallbackClientOptions('k', { ANTHROPIC_CUSTOM_HEADERS: 'a: 1\n b :2:3 \n\nc' }, undefined).defaultHeaders).toEqual({ a: '1', b: '2:3' });
  });

  it('for a caller in its own process these are the values the SDK would have read from it', async () => {
    agentSdkFails = true;
    process.env.ANTHROPIC_API_KEY = 'own-key';
    process.env.ANTHROPIC_BASE_URL = 'https://own-process.invalid';
    process.env.ANTHROPIC_AUTH_TOKEN = 'own-token';
    const { callHaiku } = await import('../src/llm.js');
    expect(await callHaiku('sys', 'ping')).toBe('fallback-pong');
    expect(clients).toEqual([{ apiKey: 'own-key', authToken: 'own-token', baseURL: 'https://own-process.invalid', defaultHeaders: {} }]);
  });
});
