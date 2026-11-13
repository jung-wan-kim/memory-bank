import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { QUERY_VECTOR, vecAt } from './helpers/search-seed.js';
import { LineClient, openSession, shortTmpDir, toolText } from './helpers/shared-harness.js';

// TC-SCOPE-006 — what is a session's own beyond its project, behind one shared server: the settings of the
// LLM child its calls start, the locale its output is written in, and the directory a relative path means.
// Each comes with the connection; none is read from the server process, which belongs to no session.

vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: vi.fn(async () => {}),
  embeddingsReady: vi.fn(() => true),
  generateEmbedding: vi.fn(async () => QUERY_VECTOR),
}));

/** Every LLM call the server makes: the question it was for and the environment it handed to the child. */
const llmCalls: Array<{ question: string; env: Record<string, string> | undefined }> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: string; options: { env?: Record<string, string> } }) => {
    const question = /Question: (.*)/.exec(args.prompt)?.[1] ?? '';
    llmCalls.push({ question, env: args.options.env });
    return {
      async *[Symbol.asyncIterator]() {
        // a slow answer, so calls of different sessions overlap inside the server
        await new Promise((r) => setTimeout(r, 5));
        yield { type: 'result', result: JSON.stringify({ answer: `answer to ${question}`, confidence: 0.9, cited_fact_ids: [] }) } as never;
      },
    };
  },
}));

const IDENTITY = 'c0ffee00' + '2'.repeat(56);
const VERSION = '9.9.9';

const ENV_A = { ANTHROPIC_BASE_URL: 'https://gateway-a.invalid', ANTHROPIC_AUTH_TOKEN: 'token-of-a', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'model-a' };
const ENV_B = { ANTHROPIC_BASE_URL: 'https://gateway-b.invalid', ANTHROPIC_API_KEY: 'key-of-b', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' };

let dir: string;
let archive: string;
let socketPath: string;
let close: () => Promise<void>;
const clients: LineClient[] = [];
const prev = { db: process.env.MEMORY_BANK_DB_PATH, archive: process.env.TEST_ARCHIVE_DIR };
const serverCwd = process.cwd();

async function session(hello: { cwd: string | null; env?: Record<string, string>; locale?: string | null }): Promise<LineClient> {
  const c = await openSession(socketPath, { identity: IDENTITY, version: VERSION, ...hello });
  clients.push(c);
  return c;
}

let seq = 0;
async function call(c: LineClient, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const response = await c.request(`c${seq++}`, 'tools/call', { name, arguments: args });
  return { text: toolText(response), isError: response.result?.isError === true };
}

const STAMP = '2026-03-04T05:06:07.000Z';

beforeAll(async () => {
  dir = fs.realpathSync(shortTmpDir());
  archive = path.join(dir, 'archive');
  fs.mkdirSync(path.join(archive, 'proj'), { recursive: true });
  process.env.MEMORY_BANK_DB_PATH = path.join(dir, 'db.sqlite');
  process.env.TEST_ARCHIVE_DIR = archive;
  socketPath = path.join(dir, 'mb-shared-9.9.9-c0ffee00.sock');

  fs.writeFileSync(path.join(archive, 'proj', 'talk.jsonl'), [
    { uuid: 'u1', parentUuid: null, timestamp: STAMP, type: 'user', isSidechain: false, sessionId: 's1', message: { role: 'user', content: 'how do we deploy?' } },
    { uuid: 'a1', parentUuid: 'u1', timestamp: STAMP, type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'with the release script' }], usage: { input_tokens: 1234567, output_tokens: 7654321 } } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n');

  const { initDatabase } = await import('../src/db.js');
  const { insertFact, setFactTags } = await import('../src/fact-db.js');
  const db = initDatabase();
  for (let i = 0; i < 4; i++) {
    insertFact(db, { fact: `GLOBAL deploy habit number ${i}`, category: 'knowledge', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: vecAt(0.05 + i * 0.01, 1 + i) });
  }
  // tags that sort differently by language: Swedish puts "ä" after "z", German next to "a"
  for (const [i, tag] of ['zebra', 'äpple', 'apple'].entries()) {
    const id = insertFact(db, { fact: `tagged fact ${tag}`, category: 'knowledge', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: vecAt(1.2 + i * 0.01, 20 + i) });
    setFactTags(db, id, [tag]);
  }
  db.close();

  const { startSharedServer } = await import('../src/shared-server-core.js');
  const { createMemoryBankServer } = await import('../src/server-core.js');
  const result = await startSharedServer({
    socketPath, identity: IDENTITY, version: VERSION, createServer: createMemoryBankServer,
    idleMs: 60_000, tickMs: 60_000, onStop: () => {},
  });
  if (result.kind !== 'serving') throw new Error(`server did not start: ${JSON.stringify(result)}`);
  close = result.handle.close;
});

afterAll(async () => {
  for (const c of clients.splice(0)) c.close();
  await close?.();
  process.chdir(serverCwd);
  if (prev.db === undefined) delete process.env.MEMORY_BANK_DB_PATH; else process.env.MEMORY_BANK_DB_PATH = prev.db;
  if (prev.archive === undefined) delete process.env.TEST_ARCHIVE_DIR; else process.env.TEST_ARCHIVE_DIR = prev.archive;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the LLM child of a call gets the calling session settings', () => {
  it('30 rounds of two sessions asking at once: every call carries its own session, never the other', async () => {
    const a = await session({ cwd: '/work/project-a', env: ENV_A });
    const b = await session({ cwd: '/work/project-b', env: ENV_B });
    llmCalls.length = 0;
    for (let round = 0; round < 30; round++) {
      const [x, y] = await Promise.all([
        call(a, 'ask_avatar', { question: `ALPHA-${round} which deploy habit applies?` }),
        call(b, 'ask_avatar', { question: `BRAVO-${round} which deploy habit applies?` }),
      ]);
      expect(x.isError, x.text.slice(0, 200)).toBe(false);
      expect(y.isError, y.text.slice(0, 200)).toBe(false);
      expect(x.text).toContain(`answer to ALPHA-${round}`);
      expect(y.text).toContain(`answer to BRAVO-${round}`);
    }
    expect(llmCalls).toHaveLength(60);
    for (const { question, env } of llmCalls) {
      const [mine, theirs] = question.startsWith('ALPHA-') ? [ENV_A, ENV_B] : [ENV_B, ENV_A];
      expect(env, question).toBeDefined();
      expect(env, question).toMatchObject(mine);
      // what this session did not declare is whatever the server process has (in a real shared server: nothing —
      // here the test process itself) — never what the other session declared
      for (const name of Object.keys(theirs)) {
        if (!(name in mine)) expect(env![name], `${question}: ${name} of the other session`).toBe(process.env[name]);
      }
    }
  }, 60_000);

  it('a session that declared no settings gets none of a neighbour, and nothing is left in the server process', async () => {
    const plain = await session({ cwd: '/work/project-c' });
    const a = await session({ cwd: '/work/project-a', env: ENV_A });
    llmCalls.length = 0;
    await Promise.all([
      call(a, 'ask_avatar', { question: 'ALPHA which deploy habit applies?' }),
      call(plain, 'ask_avatar', { question: 'PLAIN which deploy habit applies?' }),
    ]);
    const forPlain = llmCalls.find((c) => c.question.startsWith('PLAIN'))!;
    expect(forPlain.env, 'an explicit environment, not "inherit whatever the server has"').toBeDefined();
    for (const name of [...Object.keys(ENV_A), ...Object.keys(ENV_B)]) expect(forPlain.env![name], name).toBe(process.env[name]);
    for (const name of Object.keys(ENV_A)) expect(process.env[name], `${name} written into the server`).not.toBe(ENV_A[name as keyof typeof ENV_A]);
  });
});

describe('output is written in the locale of the session that asked', () => {
  const when = new Date(STAMP);

  it('read: dates and numbers of the same file, two sessions, two locales, at once', async () => {
    const us = await session({ cwd: '/work/project-a', locale: 'en-US' });
    const de = await session({ cwd: '/work/project-b', locale: 'de-DE' });
    const file = path.join(archive, 'proj', 'talk.jsonl');
    expect(when.toLocaleString('en-US')).not.toBe(when.toLocaleString('de-DE'));
    for (let round = 0; round < 10; round++) {
      const [x, y] = await Promise.all([call(us, 'read', { path: file }), call(de, 'read', { path: file })]);
      expect(x.isError, x.text.slice(0, 200)).toBe(false);
      expect(y.isError, y.text.slice(0, 200)).toBe(false);
      expect(x.text).toContain(`(${when.toLocaleString('en-US')})`);
      expect(x.text).toContain('in: 1,234,567');
      expect(x.text).not.toContain(when.toLocaleString('de-DE'));
      expect(y.text).toContain(`(${when.toLocaleString('de-DE')})`);
      expect(y.text).toContain('in: 1.234.567');
      expect(y.text).not.toContain(when.toLocaleString('en-US'));
    }
  });

  it('list_tags: names in the order of the session language', async () => {
    const order = (text: string) => ['apple', 'zebra', 'äpple'].sort((p, q) => text.indexOf(p) - text.indexOf(q));
    const sv = await session({ cwd: '/work/project-a', locale: 'sv-SE' });
    const de = await session({ cwd: '/work/project-b', locale: 'de-DE' });
    const [x, y] = await Promise.all([call(sv, 'list_tags', {}), call(de, 'list_tags', {})]);
    expect(order(x.text)).toEqual(['apple', 'zebra', 'äpple'].sort((p, q) => p.localeCompare(q, 'sv-SE')));
    expect(order(y.text)).toEqual(['apple', 'zebra', 'äpple'].sort((p, q) => p.localeCompare(q, 'de-DE')));
    expect(order(x.text)).not.toEqual(order(y.text));
  });
});

describe('a relative path given to read means the directory of the session that asked', () => {
  it('resolves against that session; the same words from another session point elsewhere; the server directory never counts', async () => {
    process.chdir(archive); // if the server directory counted, "proj/talk.jsonl" would resolve for everyone
    const inside = await session({ cwd: dir, locale: 'en-US' });
    const elsewhere = await session({ cwd: '/work/project-b', locale: 'en-US' });
    const blind = await session({ cwd: null, locale: 'en-US' });

    const ok = await call(inside, 'read', { path: 'archive/proj/talk.jsonl' });
    expect(ok.isError, ok.text.slice(0, 200)).toBe(false);
    expect(ok.text).toContain('with the release script');

    const notTheirs = await call(inside, 'read', { path: 'proj/talk.jsonl' });
    expect(notTheirs.isError, 'resolved against the server directory').toBe(true);

    const other = await call(elsewhere, 'read', { path: 'archive/proj/talk.jsonl' });
    expect(other.isError).toBe(true);
    expect(other.text).toContain('Access denied');
    expect(other.text).not.toContain('with the release script');

    const none = await call(blind, 'read', { path: 'proj/talk.jsonl' });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/relative path cannot be resolved.*absolute path/);

    const absolute = await call(blind, 'read', { path: path.join(archive, 'proj', 'talk.jsonl') });
    expect(absolute.isError, absolute.text.slice(0, 200)).toBe(false);
    expect(absolute.text).toContain('with the release script');
  });
});
