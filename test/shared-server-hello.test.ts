import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { SessionContext } from '../src/session-context.js';
import { sharedPidPath } from '../src/shared-identity.js';
import { readHello, startSharedServer, type SharedServerHandle, type SharedServerOptions } from '../src/shared-server-core.js';
import { LineClient, openSession, shortTmpDir, sleep, toolText, waitFor } from './helpers/shared-harness.js';

// The shared server itself, started inside the test process with a stand-in tool set: what a connection has
// to say before it reaches a tool, who may hold the socket name, and when the server ends.

const IDENTITY = 'a1b2c3d4' + '0'.repeat(56);
const VERSION = '9.9.9';
const HELLO = { identity: IDENTITY, version: VERSION, env: {}, envMissing: [], locale: null };

interface Call { cwd: string | null; tool: string }

/** A tool set that records which session's server was called. */
function recordingServers(calls: Call[]): (ctx: SessionContext) => Server {
  return (ctx) => {
    const server = new Server({ name: 'stand-in', version: '0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'whoami', description: 'the working directory of the session this server was made for', inputSchema: { type: 'object', properties: {} } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push({ cwd: ctx.cwd, tool: request.params.name });
      return { content: [{ type: 'text', text: `cwd=${String(ctx.cwd)}` }] };
    });
    return server;
  };
}

let dir: string;
let socketPath: string;
let calls: Call[];
let stops: Array<{ reason: string; listenerClosed: boolean }>;
const handles: SharedServerHandle[] = [];
const clients: LineClient[] = [];

async function start(over: Partial<SharedServerOptions> = {}): Promise<SharedServerHandle> {
  const result = await startSharedServer({
    socketPath,
    identity: IDENTITY,
    version: VERSION,
    createServer: recordingServers(calls),
    idleMs: 60_000,
    tickMs: 60_000,
    onStop: (info) => { stops.push(info); },
    ...over,
  });
  if (result.kind !== 'serving') throw new Error(`expected a serving server, got ${JSON.stringify(result)}`);
  handles.push(result.handle);
  return result.handle;
}

async function session(cwd: string | null): Promise<LineClient> {
  const c = await openSession(socketPath, { ...HELLO, cwd });
  clients.push(c);
  return c;
}

async function raw(): Promise<LineClient> {
  const c = await LineClient.connect(socketPath);
  clients.push(c);
  return c;
}

beforeEach(() => {
  dir = shortTmpDir();
  socketPath = path.join(dir, 'mb-shared-9.9.9-a1b2c3d4.sock');
  calls = [];
  stops = [];
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const h of handles.splice(0)) await h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readHello', () => {
  const own = { identity: IDENTITY, version: VERSION };
  const hello = (over: Record<string, unknown>) => JSON.stringify({ mb_relay: 1, pid: 1, ...HELLO, cwd: '/work/a', ...over });

  it('accepts an absolute working directory, and an explicit null', () => {
    expect(readHello(hello({}), own)).toEqual({ ctx: { cwd: '/work/a', childEnv: {} } });
    expect(readHello(hello({ cwd: null }), own)).toEqual({ ctx: { cwd: null, childEnv: {} } });
  });

  it("carries what is the session's alone: its settings for the LLM child, and its locale", () => {
    const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', CLAUDE_CODE_ENTRYPOINT: 'cli', API_TIMEOUT_MS: '600000', LANG: 'ko_KR.UTF-8' };
    expect(readHello(hello({ env, locale: 'ko-KR' }), own)).toEqual({ ctx: { cwd: '/work/a', childEnv: env, locale: 'ko-KR' } });
    // an explicit "could not tell" is not a locale: the field is left out, and the renderer's default applies
    expect(readHello(hello({ env, locale: null }), own)).toEqual({ ctx: { cwd: '/work/a', childEnv: env } });
  });

  it('refuses a hello that does not state them, or states something that is not a session setting', () => {
    const { env: _noEnv, ...withoutEnv } = { mb_relay: 1, pid: 1, ...HELLO, cwd: '/work/a' };
    const { locale: _noLocale, ...withoutLocale } = { mb_relay: 1, pid: 1, ...HELLO, cwd: '/work/a' };
    const { envMissing: _noMissing, ...withoutMissing } = { mb_relay: 1, pid: 1, ...HELLO, cwd: '/work/a' };
    expect(readHello(JSON.stringify(withoutEnv), own)).toEqual({ error: 'bad-env' });
    expect(readHello(JSON.stringify(withoutLocale), own)).toEqual({ error: 'bad-env' });
    expect(readHello(JSON.stringify(withoutMissing), own)).toEqual({ error: 'bad-env' });
    const notSettings: unknown[] = [
      null, 'ANTHROPIC_BASE_URL=x', ['ANTHROPIC_BASE_URL'], 7,
      { PATH: '/evil/bin' },                         // an operating variable of the server process
      { NODE_OPTIONS: '--require /tmp/x.js' },       // nothing a session may hand to the server's child
      { MEMORY_BANK_DB_PATH: '/tmp/other.sqlite' },  // the server's own setting: part of its identity, not a session's to give
      { CLAUDE_CODE_SESSION_ID: 'abc' },             // one session's own id never travels
      { ANTHROPIC_BASE_URL: 7 }, { ANTHROPIC_BASE_URL: null }, { ANTHROPIC_BASE_URL: ['x'] },
      { ANTHROPIC_BASE_URL: 'a\u0000b' },
      { ANTHROPIC_CUSTOM_HEADERS: 'x'.repeat(9_000) },
    ];
    for (const env of notSettings) expect(readHello(hello({ env }), own), JSON.stringify(env).slice(0, 60)).toEqual({ error: 'bad-env' });
    // __proto__ as a key (JSON.parse makes it an own property) is not a setting either
    expect(readHello(`{"mb_relay":1,"pid":1,"identity":"${IDENTITY}","version":"${VERSION}","cwd":"/work/a","locale":null,"envMissing":[],"env":{"__proto__":{"ANTHROPIC_BASE_URL":"x"}}}`, own)).toEqual({ error: 'bad-env' });
    for (const locale of ['', 7, ['ko-KR'], {}, 'not a locale', 'x'.repeat(65), 'ko_KR.UTF-8']) {
      expect(readHello(hello({ locale }), own), JSON.stringify(locale)).toEqual({ error: 'bad-env' });
    }
  });

  it('carries the names of the LLM settings the session could not hand over — and refuses a list that is not one', () => {
    const env = { ANTHROPIC_API_KEY: 'k' };
    expect(readHello(hello({ env, envMissing: ['ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CONFIG_DIR'] }), own))
      .toEqual({ ctx: { cwd: '/work/a', childEnv: env, childEnvMissing: ['ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CONFIG_DIR'] } });
    // nothing left out: the field is absent from the context, not an empty list a reader could skip checking
    expect(readHello(hello({ env, envMissing: [] }), own)).toEqual({ ctx: { cwd: '/work/a', childEnv: env } });
    const notLists: unknown[] = [
      null, 'ANTHROPIC_BASE_URL', { ANTHROPIC_BASE_URL: true }, 7,
      [7], [null], [['ANTHROPIC_BASE_URL']],
      ['PATH'], ['MEMORY_BANK_DB_PATH'], ['CLAUDE_CODE_SESSION_ID'], ['NOT_A_SETTING'], // not a session's LLM setting
      ['ANTHROPIC_BASE_URL', 'ANTHROPIC_BASE_URL'],                                    // stated twice
      ['ANTHROPIC_API_KEY'],                                                           // both carried and "not carried"
      Array.from({ length: 257 }, (_, i) => `CLAUDE_X_${i}`),
    ];
    for (const envMissing of notLists) expect(readHello(hello({ env, envMissing }), own), JSON.stringify(envMissing).slice(0, 60)).toEqual({ error: 'bad-env' });
  });

  it('refuses a working directory that is missing, empty, relative or not a string', () => {
    const { cwd: _dropped, ...withoutCwd } = { mb_relay: 1, pid: 1, ...HELLO, cwd: '' };
    expect(readHello(JSON.stringify(withoutCwd), own)).toEqual({ error: 'bad-cwd' });
    for (const cwd of ['', 'relative/dir', './x', 42, {}, ['/work/a'], true]) {
      expect(readHello(hello({ cwd }), own), JSON.stringify(cwd)).toEqual({ error: 'bad-cwd' });
    }
  });

  it('refuses another identity or version, however close', () => {
    expect(readHello(hello({ identity: IDENTITY.slice(0, 8) + 'f'.repeat(56) }), own)).toEqual({ error: 'identity-mismatch' });
    expect(readHello(hello({ identity: IDENTITY.slice(0, 8) }), own)).toEqual({ error: 'identity-mismatch' });
    expect(readHello(hello({ version: '9.9.8' }), own)).toEqual({ error: 'identity-mismatch' });
  });

  it('refuses anything that is not a hello', () => {
    for (const line of ['', 'not json', '[]', 'null', '42', '"hello"', '{}',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami' } }),
      hello({ mb_relay: 2 }), hello({ identity: 7 }), hello({ identity: [IDENTITY] }), hello({ version: null })]) {
      expect(readHello(line, own), line).toEqual({ error: 'bad-hello' });
    }
  });
});

describe('TC-SRV-001 — a connection reaches the tools only after an accepted hello', () => {
  it('accepted: the reply names the server, MCP works, and the tools belong to the declared session', async () => {
    await start();
    const c = await raw();
    c.send({ mb_relay: 1, pid: 1, ...HELLO, cwd: '/work/project-a' });
    expect(await c.next()).toEqual({ mb_relay: 1, ok: true, pid: process.pid, version: VERSION });
    const init = await c.request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    expect(init.result.serverInfo.name).toBe('stand-in');
    const list = await c.request(2, 'tools/list');
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(['whoami']);
    expect(toolText(await c.request(3, 'tools/call', { name: 'whoami', arguments: {} }))).toBe('cwd=/work/project-a');
    expect(calls).toEqual([{ cwd: '/work/project-a', tool: 'whoami' }]);
  });

  it.each([
    ['not JSON', '{nope', 'bad-hello'],
    ['a tool call instead of a hello', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }), 'bad-hello'],
    ['no working directory', JSON.stringify({ mb_relay: 1, pid: 1, ...HELLO }), 'bad-cwd'],
    ['an empty working directory', JSON.stringify({ mb_relay: 1, pid: 1, ...HELLO, cwd: '' }), 'bad-cwd'],
    ['a relative working directory', JSON.stringify({ mb_relay: 1, pid: 1, ...HELLO, cwd: 'project-a' }), 'bad-cwd'],
    ['another identity', JSON.stringify({ mb_relay: 1, pid: 1, identity: 'f'.repeat(64), version: VERSION, cwd: '/work/a' }), 'identity-mismatch'],
    ['another version', JSON.stringify({ mb_relay: 1, pid: 1, identity: IDENTITY, version: '0.0.1', cwd: '/work/a' }), 'identity-mismatch'],
  ])('refused (%s): answered with the reason, closed, and the call sent right behind it never runs', async (_what, firstLine, error) => {
    const server = await start();
    const good = await session('/work/project-b');
    const c = await raw();
    // the bad first line and a tool call in ONE write — the call must not slip through
    c.socket.write(firstLine + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'whoami', arguments: {} } }) + '\n');
    expect(await c.next()).toEqual({ mb_relay: 1, ok: false, error });
    await c.waitClosed();
    expect(c.lines).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(server.connections()).toBe(1);
    // the session that was already connected is untouched
    expect(toolText(await good.request(4, 'tools/call', { name: 'whoami', arguments: {} }))).toBe('cwd=/work/project-b');
  });

  it('a first line that never ends is refused once it is too long to be a hello', async () => {
    await start();
    const c = await raw();
    c.socket.write('x'.repeat(70_000));
    expect(await c.next()).toEqual({ mb_relay: 1, ok: false, error: 'bad-hello' });
    await c.waitClosed();
  });

  it('a connection that says nothing is dropped, and is never counted as a session', async () => {
    const server = await start({ helloTimeoutMs: 150 });
    const c = await raw();
    expect(server.connections()).toBe(0);
    await c.waitClosed(2_000);
    expect(c.lines).toEqual([]);
  });

  it('cwd null: connected — a session without a working directory still has a server made for it', async () => {
    await start();
    const c = await session(null);
    expect(toolText(await c.request(2, 'tools/call', { name: 'whoami', arguments: {} }))).toBe('cwd=null');
    expect(calls).toEqual([{ cwd: null, tool: 'whoami' }]);
  });

  it('two sessions on one server each get their own working directory, whatever the interleaving', async () => {
    await start();
    const a = await session('/work/project-a');
    const b = await session('/work/project-b');
    const answers = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      (i % 2 === 0 ? a : b).request(`r${i}`, 'tools/call', { name: 'whoami', arguments: {} }).then(toolText)));
    answers.forEach((text, i) => expect(text, `call ${i}`).toBe(i % 2 === 0 ? 'cwd=/work/project-a' : 'cwd=/work/project-b'));
  });

  it('a relay control line is answered by the server and never reaches MCP', async () => {
    await start();
    const c = await session('/work/project-a');
    c.send({ mb_relay: 1, ping: 41 });
    expect(await c.next((m) => m.mb_relay === 1 && 'pong' in m)).toEqual({ mb_relay: 1, pong: 41 });
    // MCP still works on the same connection, and nothing answered the control line as a JSON-RPC error
    expect((await c.request(5, 'tools/list')).result.tools).toHaveLength(1);
    expect(c.lines.some((l) => l.includes('"error"'))).toBe(false);
  });
});

describe('TC-SRV-002 — one server per name', () => {
  it('a second server on a served name goes away and leaves the first alone', async () => {
    const first = await start();
    const c = await session('/work/project-a');
    const second = await startSharedServer({ socketPath, identity: IDENTITY, version: VERSION, createServer: recordingServers([]), idleMs: 60_000, tickMs: 60_000, onStop: () => {} });
    expect(second).toEqual({ kind: 'name-taken' });
    expect(fs.existsSync(socketPath)).toBe(true);
    expect(first.connections()).toBe(1);
    expect(toolText(await c.request(2, 'tools/call', { name: 'whoami', arguments: {} }))).toBe('cwd=/work/project-a');
  });

  it('the socket is owner-only and the pid file names this process', async () => {
    await start();
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(sharedPidPath(socketPath), 'utf8').trim()).toBe(String(process.pid));
  });

  it('a socket file a killed server left behind is cleared and the name is bound', async () => {
    // a process that binds the name and is killed: the file stays, nobody listens
    const child = spawn(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1], () => console.log('up')); setInterval(() => {}, 1000)", socketPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(fs.existsSync(socketPath)).toBe(true);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(socketPath, old, old); // not "a server about to listen"

    const server = await start();
    const c = await session('/work/project-a');
    expect(server.connections()).toBe(1);
    expect(toolText(await c.request(2, 'tools/call', { name: 'whoami', arguments: {} }))).toBe('cwd=/work/project-a');
  }, 20_000);

  it('a fresh dead file is not removed at once — it may be a server about to listen; once it cannot be, the name is taken', async () => {
    const child = spawn(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1], () => console.log('up')); setInterval(() => {}, 1000)", socketPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const created = fs.lstatSync(socketPath).mtimeMs;
    const inoBefore = fs.lstatSync(socketPath).ino;

    const server = await start();
    // the file was left alone while it was fresh (2s), then confirmed dead (two looks a second apart)
    expect(Date.now() - created).toBeGreaterThanOrEqual(2_900);
    expect(fs.lstatSync(socketPath).ino === inoBefore && fs.lstatSync(socketPath).mtimeMs === created, 'a new socket file, not the dead one').toBe(false);
    const c = await session('/work/project-a');
    expect(server.connections()).toBe(1);
    expect(toolText(await c.request(2, 'tools/call', { name: 'whoami', arguments: {} }))).toBe('cwd=/work/project-a');
  }, 30_000);

  it('a name held by something that is not a socket is never removed: the answer is "retry"', async () => {
    fs.writeFileSync(socketPath, 'not a socket');
    const result = await startSharedServer({
      socketPath, identity: IDENTITY, version: VERSION, createServer: recordingServers([]),
      idleMs: 60_000, tickMs: 60_000, bindWaitMs: 600, onStop: () => {},
    });
    expect(result.kind).toBe('retry');
    expect(fs.readFileSync(socketPath, 'utf8')).toBe('not a socket');
  }, 20_000);

  it('a dangling symlink on the name is left in place, and what it points at is not created', async () => {
    const target = path.join(dir, 'elsewhere.sock');
    fs.symlinkSync(target, socketPath);
    const result = await startSharedServer({
      socketPath, identity: IDENTITY, version: VERSION, createServer: recordingServers([]),
      idleMs: 60_000, tickMs: 60_000, bindWaitMs: 600, onStop: () => {},
    });
    expect(result.kind).toBe('retry');
    expect(fs.lstatSync(socketPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  }, 20_000);
});

describe('TC-SRV-003 — a server no session uses ends', () => {
  it('ends after the idle time with no session, and removes its socket and pid file', async () => {
    await start({ idleMs: 200 });
    await waitFor('the idle stop', () => stops.length === 1, 3_000);
    expect(stops[0]).toEqual({ reason: 'idle', listenerClosed: true });
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(sharedPidPath(socketPath))).toBe(false);
  });

  it('a connected session keeps it alive past the idle time; the clock starts when the last one leaves', async () => {
    await start({ idleMs: 200 });
    const a = await session('/work/project-a');
    const b = await session('/work/project-b');
    await sleep(500);
    expect(stops).toEqual([]);
    a.close();
    await sleep(400);
    expect(stops, 'one session is still connected').toEqual([]);
    expect(toolText(await b.request(2, 'tools/call', { name: 'whoami', arguments: {} }))).toBe('cwd=/work/project-b');
    b.close();
    await waitFor('the idle stop', () => stops.length === 1, 3_000);
    expect(stops[0].reason).toBe('idle');
  });

  it('a session that comes back before the idle time is up stops the clock', async () => {
    await start({ idleMs: 400 });
    const a = await session('/work/project-a');
    a.close();
    await sleep(200);
    const again = await session('/work/project-a');
    await sleep(600);
    expect(stops).toEqual([]);
    expect(toolText(await again.request(2, 'tools/call', { name: 'whoami', arguments: {} }))).toBe('cwd=/work/project-a');
  });

  it('a connection that never said hello does not keep the server alive', async () => {
    await start({ idleMs: 200, helloTimeoutMs: 300 });
    await raw(); // connects, says nothing
    await waitFor('the idle stop', () => stops.length === 1, 3_000);
    expect(stops[0].reason).toBe('idle');
  });
});

describe('TC-SRV-004 — a server that lost its name leaves the successor\'s socket alone', () => {
  it('lost its name: it retires, ends when its last session leaves, and the new owner stays reachable', async () => {
    const callsA: Call[] = [];
    const stopsA: Array<{ reason: string; listenerClosed: boolean }> = [];
    const a = await startSharedServer({
      socketPath, identity: IDENTITY, version: VERSION, createServer: recordingServers(callsA),
      idleMs: 60_000, tickMs: 50, retireGraceMs: 100, onStop: (info) => { stopsA.push(info); },
    });
    if (a.kind !== 'serving') throw new Error('server A did not start');
    handles.push(a.handle);
    const onA = await session('/work/project-a');

    fs.unlinkSync(socketPath);            // the name is gone from under A
    const b = await start({ tickMs: 50 }); // a successor binds the same name
    await waitFor('server A to notice', () => a.handle.retiring() !== null, 3_000);
    expect(a.handle.retiring()).toBe('socket name lost');

    // A still serves the session it has
    expect(toolText(await onA.request(2, 'tools/call', { name: 'whoami', arguments: {} }))).toBe('cwd=/work/project-a');
    expect(callsA).toHaveLength(1);

    onA.close();
    await waitFor('server A to end', () => stopsA.length === 1, 3_000);
    expect(stopsA[0].listenerClosed, 'closing the listener would unlink the successor\'s socket').toBe(false);

    // the successor's socket file is still there and still answers
    expect(fs.existsSync(socketPath)).toBe(true);
    const onB = await session('/work/project-b');
    expect(toolText(await onB.request(3, 'tools/call', { name: 'whoami', arguments: {} }))).toBe('cwd=/work/project-b');
    expect(b.connections()).toBe(1);
    expect(b.retiring()).toBeNull();
  });
});

describe('TC-SRV-005 — a server whose code on disk moved on retires', () => {
  it('serves the sessions it has, takes the retire path when the last one leaves, and does not wait for the idle time', async () => {
    let stale: string | null = null;
    const server = await start({ idleMs: 60_000, tickMs: 50, retireGraceMs: 100, staleReason: () => stale });
    const c = await session('/work/project-a');
    await sleep(200);
    expect(server.retiring()).toBeNull();

    stale = 'the plugin on disk is now 9.9.10';
    await waitFor('the server to retire', () => server.retiring() !== null, 3_000);
    expect(toolText(await c.request(2, 'tools/call', { name: 'whoami', arguments: {} }))).toBe('cwd=/work/project-a');
    expect(stops).toEqual([]);

    c.close();
    await waitFor('the retired server to end', () => stops.length === 1, 3_000);
    expect(stops[0]).toEqual({ reason: 'retired (the plugin on disk is now 9.9.10)', listenerClosed: true });
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('a session that connects during the grace time is served; the server ends after that one leaves', async () => {
    let stale: string | null = null;
    const server = await start({ idleMs: 60_000, tickMs: 50, retireGraceMs: 400, staleReason: () => stale });
    stale = 'the compiled code on disk changed';
    await waitFor('the server to retire', () => server.retiring() !== null, 3_000);
    const late = await session('/work/project-a');
    await sleep(700);
    expect(stops, 'a connected session holds a retired server').toEqual([]);
    expect(toolText(await late.request(2, 'tools/call', { name: 'whoami', arguments: {} }))).toBe('cwd=/work/project-a');
    late.close();
    await waitFor('the retired server to end', () => stops.length === 1, 3_000);
  });
});
