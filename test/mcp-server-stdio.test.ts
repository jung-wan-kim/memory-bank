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
    // one message of 90,000 characters (longer than one answer; a letter nothing else in an answer uses), then a short one
    fs.writeFileSync(path.join(archiveProject, 'huge.jsonl'), [
      JSON.stringify({ uuid: 'u1', timestamp: ts(1), type: 'user', isSidechain: false, sessionId: 's1', message: { role: 'user', content: `HUGE-START ${'ж'.repeat(90_000)} HUGE-END` } }),
      JSON.stringify({ uuid: 'a1', timestamp: ts(2), type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'after-the-huge-one' }] } }),
    ].join('\n') + '\n');
    // a tool call whose result is 6,000 characters (longer than the per-block limit)
    fs.writeFileSync(path.join(archiveProject, 'tool.jsonl'), [
      JSON.stringify({ uuid: 'u1', timestamp: ts(1), type: 'user', isSidechain: false, sessionId: 's1', message: { role: 'user', content: 'run it' } }),
      JSON.stringify({ uuid: 'a1', timestamp: ts(2), type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cat big.log' } }] } }),
      JSON.stringify({ uuid: 'u2', timestamp: ts(3), type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `TOOL-START ${'r'.repeat(6_000)} TOOL-END` }] } }),
    ].join('\n') + '\n');
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
    const src = fs.readFileSync(path.join(REPO, 'src/server-core.ts'), 'utf8');
    const declared = [...src.matchAll(/if \(name === '([a-z_]+)'\)/g)].map((m) => m[1]).sort();
    expect(names).toEqual(declared);
    expect(names).toContain('read');
    expect(names).not.toContain('show');
    expect(tools.every((t) => t.inputSchema.type === 'object')).toBe(true);
  });

  // F8 — a search for a string of made-up words printed "87% match" for all ten hits (real queries: 85-91%).
  // The tool says what the figure is, so a reader does not take it for a confidence.
  it('the search tool says what "N% match" can and cannot tell', async () => {
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === 'search')!;
    expect(search.description).toMatch(/cosine similarity/);
    expect(search.description).toMatch(/unrelated text[^.]*8\d%/);
    expect(search.description).toMatch(/not (as )?a confidence/);
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

    // F5 — the hint used to point at the next line: the rest of a message longer than one answer was unreachable.
    it('reads a message longer than one answer to its end by calling again with the values the answer names', async () => {
      const file = path.join(archiveProject, 'huge.jsonl');
      let args: Record<string, unknown> = { path: file };
      let bodyChars = 0;
      let sawStart = false;
      let last = '';
      for (let page = 0; page < 10; page++) {
        const { text, isError } = await call('read', args);
        expect(isError).toBe(false);
        expect(text.length).toBeLessThanOrEqual(40_500);
        bodyChars += (text.match(/ж/g) ?? []).length;
        sawStart ||= text.includes('HUGE-START');
        last = text;
        const more = text.match(/Continue with startLine=(\d+)(?:, startChar=(\d+))?\._/);
        if (!more) break;
        expect(page === 0 ? more[2] : true).toBeTruthy(); // the first answer stops inside the message
        args = { path: file, startLine: Number(more[1]), ...(more[2] ? { startChar: Number(more[2]) } : {}) };
      }
      expect(sawStart).toBe(true);
      expect(bodyChars).toBe(90_000); // every character of the long message, once
      expect(last).toContain('HUGE-END');
      expect(last).toContain('after-the-huge-one');
      expect(last).not.toMatch(/Output truncated/);
    });

    // R2-SEARCH-1 — the answer names the line it started on (plus a startChar). A caller that carried only
    // startLine over got the same answer on every call, and nothing in it said why.
    it('an answer that stopped inside a message says what startLine alone does and names the line that skips it', async () => {
      const file = path.join(archiveProject, 'huge.jsonl');
      const first = await call('read', { path: file });
      expect(first.text).toMatch(/Without startChar the message starts over from its first character — to skip the rest of it instead, start at line 2\. Continue with startLine=1, startChar=\d+\._\n$/);
      // startLine alone: the same answer again
      expect((await call('read', { path: file, startLine: 1 })).text).toBe(first.text);
      // the line it names moves on
      const skipped = await call('read', { path: file, startLine: 2 });
      expect(skipped.isError).toBe(false);
      expect(skipped.text).toContain('after-the-huge-one');
      expect(skipped.text).not.toMatch(/Output truncated/);

      const { tools } = await client.listTools();
      const read = tools.find((t) => t.name === 'read')!;
      expect(read.description).toMatch(/call again with every value that line names/);
      expect(read.description).toMatch(/without it the message starts over/);
    });

    it('clips a long tool result with the way to read it, and full: true shows it whole', async () => {
      const file = path.join(archiveProject, 'tool.jsonl');
      const clipped = await call('read', { path: file });
      expect(clipped.isError).toBe(false);
      expect(clipped.text).toContain('TOOL-START');
      expect(clipped.text).not.toContain('TOOL-END');
      expect(clipped.text).toMatch(/…\[\+\d+ chars not shown — read again with full: true\]/);

      const whole = await call('read', { path: file, full: true });
      expect(whole.isError).toBe(false);
      expect(whole.text).toContain(`TOOL-START ${'r'.repeat(6_000)} TOOL-END`);
      expect(whole.text).not.toMatch(/chars not shown/);
    });

    it('declares the continuation arguments, and refuses a startChar past the message', async () => {
      const { tools } = await client.listTools();
      const read = tools.find((t) => t.name === 'read')!;
      expect(Object.keys(read.inputSchema.properties ?? {}).sort()).toEqual(['endLine', 'full', 'path', 'startChar', 'startLine']);
      expect(read.description).toMatch(/startChar/);
      expect(read.description).toMatch(/full is true/);

      const { text, isError } = await call('read', { path: path.join(archiveProject, 'short.jsonl'), startLine: 1, startChar: 100_000 });
      expect(isError).toBe(true);
      expect(text).toMatch(/startChar 100000 is past the end of the message at line 1/);
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

    // SEC-6 — the path check picked a file (symlinks resolved), and the reader then chose between that file and
    // its other variant (plain / .zst) again: the newer variant could be a link the check never looked at.
    it.runIf(zstdCompressSync !== undefined)('never opens a variant the path check did not look at (link to a checked file whose other variant leads outside)', async () => {
      const outsideDir = path.join(configDir, 'outside-dir');
      fs.mkdirSync(outsideDir, { recursive: true });
      const marked = (marker: string) => JSON.stringify({ uuid: 'u1', timestamp: ts(1), type: 'user', isSidechain: false, sessionId: 's1', message: { role: 'user', content: `question ${marker}` } }) + '\n';
      fs.writeFileSync(path.join(outsideDir, 'secret.jsonl'), marked('OUTSIDE-PLAIN'));
      fs.writeFileSync(path.join(outsideDir, 'secret.jsonl.zst'), zstdCompressSync!(Buffer.from(marked('OUTSIDE-PACKED'), 'utf-8')));
      fs.writeFileSync(path.join(outsideDir, 'plain.txt'), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\n');
      const old = new Date('2025-01-01T00:00:00Z');
      const inside = (name: string) => path.join(archiveProject, name);
      // 1: a.jsonl.zst → b.jsonl.zst (inside, older); next to it b.jsonl → outside (newer)
      fs.writeFileSync(inside('b.jsonl.zst'), zstdCompressSync!(Buffer.from(marked('INSIDE-B'), 'utf-8')));
      fs.utimesSync(inside('b.jsonl.zst'), old, old);
      fs.symlinkSync(inside('b.jsonl.zst'), inside('a.jsonl.zst'));
      fs.symlinkSync(path.join(outsideDir, 'secret.jsonl'), inside('b.jsonl'));
      // 2: c.jsonl → d.jsonl (inside, older); next to it d.jsonl.zst → outside (newer)
      fs.writeFileSync(inside('d.jsonl'), marked('INSIDE-D'));
      fs.utimesSync(inside('d.jsonl'), old, old);
      fs.symlinkSync(inside('d.jsonl'), inside('c.jsonl'));
      fs.symlinkSync(path.join(outsideDir, 'secret.jsonl.zst'), inside('d.jsonl.zst'));
      // 3: e.jsonl.zst → f.jsonl.zst (inside, older); next to it f.jsonl → an outside file that is no conversation
      fs.writeFileSync(inside('f.jsonl.zst'), zstdCompressSync!(Buffer.from(marked('INSIDE-F'), 'utf-8')));
      fs.utimesSync(inside('f.jsonl.zst'), old, old);
      fs.symlinkSync(inside('f.jsonl.zst'), inside('e.jsonl.zst'));
      fs.symlinkSync(path.join(outsideDir, 'plain.txt'), inside('f.jsonl'));

      const one = await call('read', { path: inside('a.jsonl.zst') });
      const two = await call('read', { path: inside('c.jsonl') });
      // a line range past the end used to answer with the outside file's line count
      const three = await call('read', { path: inside('e.jsonl.zst'), startLine: 999 });
      for (const answer of [one, two, three]) {
        expect(answer.text).not.toMatch(/OUTSIDE-/);
        expect(answer.text).not.toMatch(/it has 7 lines/);
        expect(answer.isError).toBe(true);
        expect(answer.text).toMatch(/outside the conversation archive/);
      }

      // a link to a file inside whose variant choice stays inside is still read
      fs.writeFileSync(inside('h.jsonl'), marked('INSIDE-H'));
      fs.symlinkSync(inside('h.jsonl'), inside('g.jsonl'));
      const ok = await call('read', { path: inside('g.jsonl') });
      expect(ok.isError).toBe(false);
      expect(ok.text).toContain('INSIDE-H');
    });

    it('answers the same for a path outside the archive whether or not a file is there', async () => {
      const present = path.join(configDir, 'probe-present.jsonl');
      fs.writeFileSync(present, conversation(1));
      const absent = path.join(configDir, 'probe-absent.jsonl');
      const a = await call('read', { path: present });
      const b = await call('read', { path: absent });
      expect(a.isError).toBe(true);
      expect(b.isError).toBe(true);
      // The answer must not tell the caller which *.jsonl files exist on the machine.
      expect(a.text).toBe(b.text);
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
      expect(overview.text.length).toBeLessThanOrEqual(20_000);

      const facts = await call('search_ontology', { category: 'Topic 2-07' });
      expect(facts.text).toMatch(/### Topic 2-07/);
      expect(facts.text).toContain('Seeded fact 2-7-0');
      expect(facts.text).toMatch(/7 more facts/);

      const widest = await call('search_ontology', { category: 'Topic', facts_per_category: 50, max_categories: 200 });
      expect(widest.isError).toBe(false);
      expect(widest.text.length).toBeLessThanOrEqual(20_000);
      expect(widest.text).toMatch(/Output limit \(20000 chars\) reached/);
    });

    it('rejects an argument outside the schema', async () => {
      const { text, isError } = await call('search_ontology', { facts_per_category: 500 });
      expect(isError).toBe(true);
      expect(text).toMatch(/facts_per_category|too_big|50/i);
    });
  });

  describe('search (keyword mode — no embedding model needed)', () => {
    it('json: clipped messages with where to read them; noise left out unless asked for', async () => {
      await call('graph_stats', {}); // creates the schema if no tool has yet
      const db = new Database(path.join(configDir, 'conversation-index', 'db.sqlite'));
      const insert = db.prepare(`
        INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, is_sidechain, coding_agent)
        VALUES (?, 'demo-project', ?, ?, ?, ?, ?, ?, ?, 'claude-code')
      `);
      const archive = path.join(archiveProject, 'short.jsonl');
      db.transaction(() => {
        insert.run('ex-real', '2026-10-01T00:00:00.000Z', 'why did the quokka migration fail ' + 'q'.repeat(30_000), 'because ' + 'a'.repeat(30_000), archive, 1, 2, 0);
        insert.run('ex-warmup', '2026-10-02T00:00:00.000Z', 'Warmup', 'Ready to help with the quokka migration.', archive, 3, 4, 1);
        insert.run('ex-snapshot', '2026-10-01T00:00:00.000Z', 'why did the quokka migration fail ' + 'q'.repeat(30_000), 'because ' + 'a'.repeat(40_000), archive, 1, 6, 0);
      })();
      db.close();

      const answer = await call('search', { query: 'quokka', mode: 'text', response_format: 'json', limit: 50 });
      expect(answer.isError).toBe(false);
      expect(answer.text.length).toBeLessThan(3_000);
      const parsed = JSON.parse(answer.text) as {
        count: number; notes: string[]; hint: string;
        results: Array<{ exchange: { id: string; archivePath: string; lineStart: number; lineEnd: number; userMessage: string }; matchedBy: string; clipped: boolean }>;
      };
      // one result: the warm-up turn is left out and the two snapshots of the turn are folded into the longer one
      expect(parsed.results.map((r) => r.exchange.id)).toEqual(['ex-snapshot']);
      expect(parsed.results[0]).toMatchObject({ matchedBy: 'text', clipped: true });
      expect(parsed.results[0].exchange).toMatchObject({ archivePath: archive, lineStart: 1, lineEnd: 6 });
      expect(parsed.results[0].exchange.userMessage.length).toBeLessThanOrEqual(501);
      expect(parsed.notes).toEqual([]);
      expect(parsed.hint).toMatch(/read tool/);

      const withNoise = JSON.parse((await call('search', { query: 'quokka', mode: 'text', response_format: 'json', include_noise: true })).text) as { results: Array<{ exchange: { id: string } }> };
      expect(withNoise.results.map((r) => r.exchange.id).sort()).toEqual(['ex-snapshot', 'ex-warmup']);
    });

    it('rejects an argument the schema does not declare', async () => {
      const { isError } = await call('search', { query: 'quokka', mode: 'text', include_everything: true });
      expect(isError).toBe(true);
    });

    // R2-SEARCH-4 — it used to search the vector index up to its ceiling and answer "cut short … relax the date filter".
    it('a date range that ends before it starts is an error at once, in every mode', async () => {
      for (const mode of ['both', 'vector', 'text']) {
        const { text, isError } = await call('search', { query: 'quokka', mode, after: '2026-10-01', before: '2026-01-01' });
        expect(isError).toBe(true);
        expect(text).toMatch(/--after 2026-10-01 is later than --before 2026-01-01/);
      }
      const multi = await call('search', { query: ['quokka', 'migration'], after: '2026-10-01', before: '2026-01-01' });
      expect(multi.isError).toBe(true);
      expect(multi.text).toMatch(/--after 2026-10-01 is later than --before 2026-01-01/);
    });
  });

  // R2-SEARCH-5 — `arguments` is optional in tools/call. The handlers gave `undefined` to an object schema, so
  // the three tools that need no argument answered "expected object, received undefined".
  describe('a call that leaves `arguments` out', () => {
    const bare = async (name: string) => {
      const result = await client.callTool({ name });
      const content = result.content as Array<{ type: string; text: string }>;
      return { text: content.map((c) => c.text).join('\n'), isError: result.isError === true };
    };

    it.each(['list_tags', 'search_ontology', 'graph_stats'])('%s answers as it does for {}', async (name) => {
      const answer = await bare(name);
      expect(answer.isError, answer.text.slice(0, 200)).toBe(false);
      expect(answer.text).toBe((await call(name, {})).text);
    });

    it('a tool with a required argument still refuses, naming the argument', async () => {
      for (const [name, required] of [['search', 'query'], ['read', 'path'], ['tag_fact', 'fact_id']] as const) {
        const answer = await bare(name);
        expect(answer.isError, name).toBe(true);
        expect(answer.text, name).toContain(required);
        expect(answer.text, name).not.toMatch(/expected object, received undefined/);
      }
    });
  });

  // R2-SEARCH-6 — `project` was accepted and described as "Project path to scope stats", but every total is of
  // the whole graph: a caller that named a project read the whole graph's numbers as that project's.
  describe('graph_stats', () => {
    it('says that `project` is not applied — in the schema and in the answer', async () => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'graph_stats')!;
      const described = (tool.inputSchema.properties as Record<string, { description: string }>).project.description;
      expect(described).not.toMatch(/to scope stats/);
      expect(described).toMatch(/not applied/);
      expect(described).toMatch(/whole graph/);
      expect(tool.description).toMatch(/whole graph/);

      const all = await call('graph_stats', {});
      const named = await call('graph_stats', { project: '/some/project' });
      expect(named.isError).toBe(false);
      expect(all.text).toMatch(/\| Active Facts \| \d+ \|/);
      expect(all.text).not.toMatch(/not applied/);
      // the same totals, followed by the note
      expect(named.text.startsWith(all.text)).toBe(true);
      expect(named.text.slice(all.text.length)).toMatch(/`project` is not applied: these totals cover the whole graph/);
    });
  });

  it('the server wrote nothing unexpected to stderr', () => {
    expect(serverStderr).not.toMatch(/Server error|UnhandledPromiseRejection|TypeError|ReferenceError/);
  });
});
