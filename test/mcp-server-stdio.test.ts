import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The MCP handlers had no test that runs them (mcp-server.ts starts the server on import, so the other
// tests only read its source). This one starts the real server from source over stdio, against a
// throwaway config dir, and calls the tools the way a client does.

const REPO = path.resolve(__dirname, '..');
const zstdCompressSync: ((buf: Buffer) => Buffer) | undefined =
  (zlib as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync;

const ts = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
function conversation(pairs: number, bodyChars = 0): string {
  const lines: string[] = [];
  for (let k = 1; k <= pairs; k++) {
    lines.push(JSON.stringify({ uuid: `u${k}`, timestamp: ts(k), type: 'user', isSidechain: false, sessionId: 's1', message: { role: 'user', content: `question-${k} ${'q'.repeat(bodyChars)}` } }));
    lines.push(JSON.stringify({ uuid: `a${k}`, timestamp: ts(k), type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: `answer-${k} ${'a'.repeat(bodyChars)}` }] } }));
  }
  return lines.join('\n') + '\n';
}

describe('MCP server over stdio', () => {
  let configDir: string;
  let archiveProject: string;
  let client: Client;
  let serverStderr = '';

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return { text: content.map((c) => c.text).join('\n'), isError: result.isError === true };
  };

  beforeAll(async () => {
    configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-mcp-')));
    archiveProject = path.join(configDir, 'conversation-archive', 'demo-project');
    fs.mkdirSync(archiveProject, { recursive: true });
    fs.writeFileSync(path.join(archiveProject, 'short.jsonl'), conversation(5));
    fs.writeFileSync(path.join(archiveProject, 'long.jsonl'), conversation(60, 1500));
    if (zstdCompressSync) {
      fs.writeFileSync(path.join(archiveProject, 'packed.jsonl.zst'), zstdCompressSync(Buffer.from(conversation(4), 'utf-8')));
    }

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env.MEMORY_BANK_DB_PATH;
    delete env.TEST_DB_PATH;
    delete env.TEST_ARCHIVE_DIR;
    Object.assign(env, {
      MEMORY_BANK_CONFIG_DIR: configDir,
      CLAUDE_CONFIG_DIR: path.join(configDir, 'claude'),
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO, 'src', 'mcp-server.ts')],
      cwd: REPO,
      env,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => { serverStderr += chunk.toString(); });
    client = new Client({ name: 'mcp-server-stdio-test', version: '0.0.0' });
    await client.connect(transport);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('reports the package version, not a fixed 1.0.0', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { version: string };
    expect(client.getServerVersion()).toEqual({ name: 'memory-bank', version: pkg.version });
  });

  it('registers exactly the tools the source declares, each with an object input schema', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const src = fs.readFileSync(path.join(REPO, 'src/mcp-server.ts'), 'utf8');
    const declared = [...src.matchAll(/if \(name === '([a-z_]+)'\)/g)].map((m) => m[1]).sort();
    expect(names).toEqual(declared);
    expect(names).toContain('read');
    expect(names).not.toContain('show');
    expect(tools.every((t) => t.inputSchema.type === 'object')).toBe(true);
  });

  it('every tool the search agent is allowed is one the running server registers', async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    const agent = fs.readFileSync(path.join(REPO, 'agents/search-conversations.md'), 'utf8');
    const allowed = [...agent.matchAll(/mcp__plugin_memory-bank_memory-bank__([a-z_]+)/g)].map((m) => m[1]);
    expect(allowed.length).toBeGreaterThanOrEqual(2);
    expect(allowed.filter((name) => !names.has(name))).toEqual([]);
  });

  describe('read', () => {
    it('returns the requested line range', async () => {
      const { text, isError } = await call('read', { path: path.join(archiveProject, 'short.jsonl'), startLine: 3, endLine: 4 });
      expect(isError).toBe(false);
      expect(text).toContain('question-2');
      expect(text).not.toContain('question-1');
      expect(text).not.toContain('question-3');
    });

    it('caps a long conversation and names the line to continue from', async () => {
      const file = path.join(archiveProject, 'long.jsonl');
      const first = await call('read', { path: file });
      expect(first.isError).toBe(false);
      expect(first.text.length).toBeLessThanOrEqual(40_400);
      const next = first.text.match(/Output truncated[^\n]*Continue with startLine=(\d+)/);
      expect(next).not.toBeNull();
      const second = await call('read', { path: file, startLine: Number(next![1]) });
      const lastOfFirst = Math.max(...[...first.text.matchAll(/question-(\d+) /g)].map((m) => Number(m[1])));
      const firstOfSecond = Math.min(...[...second.text.matchAll(/question-(\d+) /g)].map((m) => Number(m[1])));
      expect([lastOfFirst + 1, lastOfFirst]).toContain(firstOfSecond);
    });

    it('a range outside the file is an error with the line count, not an empty answer', async () => {
      const { text, isError } = await call('read', { path: path.join(archiveProject, 'short.jsonl'), startLine: 500, endLine: 510 });
      expect(isError).toBe(true);
      expect(text).toMatch(/outside the file: it has 10 lines/);
    });

    it('a reversed range is an error', async () => {
      const { text, isError } = await call('read', { path: path.join(archiveProject, 'short.jsonl'), startLine: 9, endLine: 2 });
      expect(isError).toBe(true);
      expect(text).toMatch(/startLine 9 is after endLine 2/);
    });

    it.runIf(zstdCompressSync !== undefined)('reads a compressed archive through its .jsonl path', async () => {
      const { text, isError } = await call('read', { path: path.join(archiveProject, 'packed.jsonl'), startLine: 1, endLine: 2 });
      expect(isError).toBe(false);
      expect(text).toContain('question-1');
      expect(text).toContain('answer-1');
    });

    it('still refuses a path outside the conversation archive', async () => {
      const outside = path.join(configDir, 'outside.jsonl');
      fs.writeFileSync(outside, conversation(1));
      const { text, isError } = await call('read', { path: outside });
      expect(isError).toBe(true);
      expect(text).toMatch(/outside the conversation archive/);
    });
  });

  describe('search_ontology', () => {
    it('answers with counts first and facts only when asked, under the output ceiling', async () => {
      // The first call creates the schema; an empty ontology says so.
      expect((await call('search_ontology', {})).text).toMatch(/No ontology data found/);

      const db = new Database(path.join(configDir, 'conversation-index', 'db.sqlite'));
      db.transaction(() => {
        for (let d = 0; d < 4; d++) {
          db.prepare(`INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?, ?, NULL, '2026-01-01')`).run(`dom-${d}`, `Domain ${d}`);
          for (let c = 0; c < 60; c++) {
            const cid = `cat-${d}-${c}`;
            db.prepare(`INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, NULL, '2026-01-01')`).run(cid, `dom-${d}`, `Topic ${d}-${String(c).padStart(2, '0')}`);
            for (let f = 0; f < 12; f++) {
              db.prepare(`INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at, consolidated_count, is_active, ontology_category_id, embedding_version)
                          VALUES (?, ?, 'decision', 'global', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?, 1, ?, 1)`)
                .run(`f-${d}-${c}-${f}`, `Seeded fact ${d}-${c}-${f} ${'w'.repeat(400)}`, 12 - f, cid);
            }
          }
        }
      })();
      db.close();

      const overview = await call('search_ontology', {});
      expect(overview.isError).toBe(false);
      expect(overview.text).toMatch(/4 domains · 240 categories · 2880 active facts/);
      expect(overview.text).not.toContain('Seeded fact');
      expect(overview.text.length).toBeLessThanOrEqual(20_500);

      const facts = await call('search_ontology', { category: 'Topic 2-07' });
      expect(facts.text).toMatch(/### Topic 2-07/);
      expect(facts.text).toContain('Seeded fact 2-7-0');
      expect(facts.text).toMatch(/7 more facts/);

      const widest = await call('search_ontology', { category: 'Topic', facts_per_category: 50, max_categories: 200 });
      expect(widest.isError).toBe(false);
      expect(widest.text.length).toBeLessThanOrEqual(20_500);
      expect(widest.text).toMatch(/Output limit \(20000 chars\) reached/);
    });

    it('rejects an argument outside the schema', async () => {
      const { text, isError } = await call('search_ontology', { facts_per_category: 500 });
      expect(isError).toBe(true);
      expect(text).toMatch(/facts_per_category|too_big|50/i);
    });
  });

  it('the server wrote nothing unexpected to stderr', () => {
    expect(serverStderr).not.toMatch(/Server error|UnhandledPromiseRejection|TypeError|ReferenceError/);
  });
});
