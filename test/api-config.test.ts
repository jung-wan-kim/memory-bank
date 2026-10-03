import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { summarizeConversation } from '../src/summarizer.js';
import type { ConversationExchange } from '../src/types.js';

describe('API Configuration', () => {
  afterEach(() => {
    // Restore only the env vars we changed
    delete process.env.MEMORY_BANK_API_BASE_URL;
    delete process.env.MEMORY_BANK_API_TOKEN;
    delete process.env.MEMORY_BANK_API_MODEL;
    delete process.env.MEMORY_BANK_API_TIMEOUT_MS;
  });

  it('should use custom API endpoint when MEMORY_BANK_API_BASE_URL is set', async () => {
    // A local endpoint that records every request and refuses it. The old
    // version pointed at httpbin.org/status/418 and matched the CLI's error
    // TEXT — network-dependent, and it broke the moment the bundled CLI
    // (2.0.77 → 2.1.288) reworded the error. What this test means to prove is
    // that the request reaches OUR endpoint with OUR token, so assert exactly that.
    const hits: Array<{ url?: string; auth?: string }> = [];
    const server = http.createServer((req, res) => {
      hits.push({ url: req.url, auth: String(req.headers['authorization'] ?? req.headers['x-api-key'] ?? '') });
      req.resume();
      res.writeHead(418, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: "I'm a teapot" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    process.env.MEMORY_BANK_API_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.MEMORY_BANK_API_TOKEN = 'test-token';

    const exchanges: ConversationExchange[] = [
      {
        id: 'test-1',
        project: 'test',
        timestamp: new Date().toISOString(),
        archivePath: '/test/path.jsonl',
        lineStart: 1,
        lineEnd: 10,
        userMessage: 'Implement JWT authentication with refresh tokens',
        assistantMessage: 'I will create an auth context with token rotation...'
      },
      {
        id: 'test-2',
        project: 'test',
        timestamp: new Date().toISOString(),
        archivePath: '/test/path.jsonl',
        lineStart: 11,
        lineEnd: 20,
        userMessage: 'How do protected routes work?',
        assistantMessage: 'We use a ProtectedRoute component that checks auth...'
      }
    ];

    try {
      // Fails — the endpoint refuses everything — but the request must have reached it.
      await summarizeConversation(exchanges).catch(() => '');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(hits.length, '요청이 설정한 엔드포인트에 도달하지 않았다').toBeGreaterThan(0);
    expect(hits.some((h) => h.url?.includes('/v1/messages')), JSON.stringify(hits.slice(0, 3))).toBe(true);
    expect(hits.some((h) => h.auth?.includes('test-token')), '설정한 토큰이 실리지 않았다').toBe(true);
  }, 60000);
});
