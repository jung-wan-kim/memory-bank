import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { childEnvFor, sharedPidPath } from '../src/shared-identity.js';
import {
  REPO, RELAY_ENTRY, WRAPPER, StdioSession, cleanup, createRig, expectedServer, isAlive, killAll, responsesOf, serverPids,
  sharedEnv, shortTmpDir, sleep, waitFor,
} from './helpers/shared-harness.js';

/**
 * The shared server with real processes: the entry point a session starts (dist/mcp-server.js — the relay),
 * the detached server it starts, and the wrapper in front of both. Every test has a config dir of its own, so
 * it has a server identity of its own; whatever a test started is ended in afterEach.
 */

const rig = createRig();
const { sessions, dirs } = rig;
const strays: ChildProcess[] = [];

const configDir = (): string => rig.tmp();

/** A working directory for a session — a project of its own. */
function projectDir(name: string): string {
  const dir = path.join(shortTmpDir('mbp-'), name);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(path.dirname(dir));
  return dir;
}

const relay = (env: Record<string, string>, cwd: string = REPO): StdioSession => rig.session(RELAY_ENTRY, env, cwd);
const watch = (env: Record<string, string>): ReturnType<typeof expectedServer> => rig.watch(env);

const projectLine = (text: string): string => text.split('\n').find((l) => l.startsWith('Project: ')) ?? '';

afterEach(async () => {
  for (const c of strays.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  await rig.cleanup();
});

describe('TC-RELAY-001 — sessions with the same settings use one shared server', () => {
  it('one shared server for three sessions in three projects', async () => {
    const env = sharedEnv(configDir());
    const server = watch(env);
    const projects = ['alpha', 'bravo', 'charlie'].map(projectDir);
    for (const project of projects) {
      const s = relay(env, project);
      const init = await s.initialize();
      expect(init.result.serverInfo.name).toBe('memory-bank');
      expect(await s.toolNames()).toHaveLength(11);
      // each session's default project is its own working directory
      expect(projectLine((await s.callTool('list_tags')).text)).toBe(`Project: ${project}`);
    }
    expect(serverPids(server.marker)).toHaveLength(1);
    expect(fs.readFileSync(sharedPidPath(server.socketPath), 'utf8').trim()).toBe(String(serverPids(server.marker)[0]));
    expect(sessions.every((s) => s.exit === null)).toBe(true);
  }, 60_000);

  it('eight sessions started at the same moment: one shared server, and no relay gives up', async () => {
    const env = sharedEnv(configDir());
    const server = watch(env);
    const started = Array.from({ length: 8 }, (_, i) => relay(env, projectDir(`p${i}`)));
    const tools = await Promise.all(started.map(async (s) => { await s.initialize(); return s.toolNames(); }));
    for (const names of tools) expect(names).toHaveLength(11);
    expect(serverPids(server.marker)).toHaveLength(1);
    expect(started.map((s) => s.exit)).toEqual(Array(8).fill(null));
    // the start lock is given back
    expect(fs.readdirSync(server.indexDir).filter((n) => n.endsWith('.lock'))).toEqual([]);
  }, 60_000);

  it('the relay is light: the bundle a session runs imports Node built-ins only', () => {
    const bundle = fs.readFileSync(RELAY_ENTRY, 'utf8');
    const imported = [...bundle.matchAll(/^import\s[^'"]*['"]([^'"]+)['"];?$/gm)].map((m) => m[1]);
    expect(imported.length).toBeGreaterThan(5);
    expect(imported.filter((name) => !name.startsWith('node:') && !['fs', 'os', 'path', 'net', 'url', 'crypto', 'child_process'].includes(name))).toEqual([]);
    expect(bundle).not.toMatch(/better-sqlite3|@xenova\/transformers|@modelcontextprotocol/);
  });
});

describe('TC-RELAY-004 — session-local: a session runs its own server when the shared one is off', () => {
  it('MEMORY_BANK_SHARED_SERVER=0: same tools, same scope rule, one line on stderr, no shared server', async () => {
    const dir = configDir();
    const env = sharedEnv(dir, { MEMORY_BANK_SHARED_SERVER: '0' });
    const project = projectDir('solo');
    const s = relay(env, project);
    await s.initialize();
    expect(await s.toolNames()).toHaveLength(11);
    expect(projectLine((await s.callTool('list_tags')).text)).toBe(`Project: ${project}`);
    expect(s.stderr).toMatch(/\[memory-bank\] shared server off: MEMORY_BANK_SHARED_SERVER is off — this session runs its own server/);
    const index = path.join(dir, 'conversation-index');
    expect(fs.readdirSync(index).filter((n) => n.startsWith('mb-shared-'))).toEqual([]);
    expect(serverPids(watch(sharedEnv(dir)).marker)).toEqual([]);
    expect((await s.end()).code).toBe(0);
  }, 60_000);

  it('the switch file in the index dir does the same, without touching the environment', async () => {
    const dir = configDir();
    const env = sharedEnv(dir);
    const index = path.join(dir, 'conversation-index');
    fs.mkdirSync(index, { recursive: true });
    fs.writeFileSync(path.join(index, 'shared-server.off'), '');
    const s = relay(env, projectDir('solo'));
    await s.initialize();
    expect(await s.toolNames()).toHaveLength(11);
    expect(s.stderr).toMatch(/shared server off: shared-server\.off is present in the index dir/);
    expect(fs.readdirSync(index).filter((n) => n.startsWith('mb-shared-'))).toEqual([]);
  }, 60_000);

  it('session-local for a config dir too deep for a unix socket: says why, and no server process is left to find', async () => {
    // deep enough that <dir>/conversation-index/mb-shared-<version>-<8>.sock cannot be a unix socket path
    const dir = path.join(configDir(), 'd'.repeat(80));
    fs.mkdirSync(dir, { recursive: true });
    const env = sharedEnv(dir);
    expect(() => expectedServer(env)).toThrow(/socket-path-too-long/);
    const before = new Set(execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
      .filter((l) => l.includes('shared-server.js')).map((l) => l.trim().split(/\s+/)[0]));
    const project = projectDir('deep');
    const s = relay(env, project);
    await s.initialize();
    expect(await s.toolNames()).toHaveLength(11);
    expect(projectLine((await s.callTool('list_tags')).text)).toBe(`Project: ${project}`);
    expect(s.stderr).toMatch(/shared server off: the index dir path is too long for a unix socket .* this session runs its own server/);
    // no shared server was started for it (none that was not there before, whatever its identity)
    const after = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
      .filter((l) => l.includes('shared-server.js') && l.includes(dir)).map((l) => l.trim().split(/\s+/)[0]);
    expect(after.filter((pid) => !before.has(pid))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'conversation-index')).filter((n) => n.startsWith('mb-shared-'))).toEqual([]);
    expect((await s.end()).code).toBe(0);
  }, 60_000);
});

describe('TC-SRV-003 — idle: the server ends when no session is connected', () => {
  it('idle: ends after the sessions left — prompt-injection requests in the meantime do not keep it', async () => {
    const env = sharedEnv(configDir(), { MEMORY_BANK_SHARED_IDLE_MS: '1500' });
    const server = watch(env);
    const s = relay(env, projectDir('alpha'));
    await s.initialize();
    const [pid] = serverPids(server.marker);
    expect(pid).toBeGreaterThan(1);
    const injectSocket = await waitFor('the inject socket', () => fs.readdirSync(server.indexDir).find((n) => /^inject-daemon.*\.sock$/.test(n)));

    expect((await s.end()).code).toBe(0);
    // hooks keep asking the inject socket while no session is connected
    let asked = 0;
    const until = Date.now() + 10_000;
    while (isAlive(pid) && Date.now() < until) {
      await new Promise<void>((resolve) => {
        const c = net.connect(path.join(server.indexDir, injectSocket));
        c.on('connect', () => { asked++; c.write(JSON.stringify({ prompt: 'hi', cwd: '/tmp' }) + '\n'); });
        c.on('error', () => resolve());
        c.on('close', () => resolve());
        setTimeout(() => { c.destroy(); resolve(); }, 300);
      });
      await sleep(100);
    }
    expect(isAlive(pid), 'the server is still running 10s after its last session left').toBe(false);
    expect(asked).toBeGreaterThan(2);
    expect(fs.readdirSync(server.indexDir).filter((n) => n.startsWith('mb-shared-') || n.startsWith('inject-daemon'))).toEqual([]);
  }, 60_000);
});

describe('TC-RELAY-005 — a session ends, the server stays for the others', () => {
  it('session ends: stdin closing and SIGTERM both end the relay with code 0; the other session keeps working', async () => {
    const env = sharedEnv(configDir(), { MEMORY_BANK_SHARED_IDLE_MS: '4000' });
    const server = watch(env);
    const a = relay(env, projectDir('alpha'));
    const b = relay(env, projectDir('bravo'));
    await a.initialize();
    await b.initialize();
    const [pid] = serverPids(server.marker);

    expect(await a.end()).toEqual({ code: 0, signal: null });
    expect(isAlive(pid)).toBe(true);
    expect(await b.toolNames()).toHaveLength(11);

    b.child.kill('SIGTERM');
    expect(await b.waitForExit()).toEqual({ code: 0, signal: null });
    // a relay never removes the server's socket
    expect(fs.existsSync(server.socketPath)).toBe(true);
    expect(isAlive(pid)).toBe(true);
  }, 60_000);
});

describe('TC-RELAY-002 — reconnect: the server dies, the session goes on', () => {
  it('reconnect: a call in flight is answered with an error, the next call runs on a new server, the client never re-initializes', async () => {
    const env = sharedEnv(configDir());
    const server = watch(env);
    const s = relay(env, projectDir('alpha'));
    await s.initialize();
    const [first] = serverPids(server.marker);

    process.kill(first, 'SIGSTOP');            // the server stops answering — the next call stays in flight
    const inFlight = s.post('tools/list');
    await sleep(200);
    process.kill(first, 'SIGKILL');

    const aborted = await s.response(inFlight);
    expect(aborted.error?.code).toBe(-32001);
    expect(aborted.error?.message).toMatch(/restarted|aborted/);

    expect(await s.toolNames()).toHaveLength(11);
    const [second] = serverPids(server.marker);
    expect(second).toBeGreaterThan(1);
    expect(second).not.toBe(first);
    expect(s.stderr).toMatch(/connected to shared server \d+ — replaying the handshake/);
    // one initialize answer reached the client: the replay's answer was swallowed
    expect(responsesOf(s).filter((m) => m.result?.serverInfo !== undefined)).toHaveLength(1);
    expect(s.exit).toBeNull();
  }, 60_000);

  it('reconnect: an initialize that was never answered gets its answer from the new server — no error, one answer', async () => {
    const env = sharedEnv(configDir());
    const server = watch(env);
    const keeper = relay(env, projectDir('keeper')); // starts the server
    await keeper.initialize();
    const [first] = serverPids(server.marker);

    const s = relay(env, projectDir('alpha'));
    await s.waitForStderr(/connected to shared server \d+/); // connected, nothing sent yet
    process.kill(first, 'SIGSTOP');
    const init = s.post('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    await sleep(200);
    process.kill(first, 'SIGKILL');

    const answer = await s.response(init);
    expect(answer.error).toBeUndefined();
    expect(answer.result.serverInfo.name).toBe('memory-bank');
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(await s.toolNames()).toHaveLength(11);
    expect(responsesOf(s).filter((m) => m.id === init)).toHaveLength(1);
    expect(serverPids(server.marker)).toHaveLength(1);
  }, 60_000);
});

describe('TC-RELAY-003 — unresponsive: a server that holds the name but does not answer', () => {
  it('unresponsive: it is ended and replaced, and both the new and the old session work', async () => {
    const env = sharedEnv(configDir(), { MEMORY_BANK_RELAY_HELLO_MS: '800' });
    const server = watch(env);
    const old = relay(env, projectDir('old'));
    await old.initialize();
    const [stuck] = serverPids(server.marker);
    process.kill(stuck, 'SIGSTOP'); // accepts connections (the kernel does), answers nothing

    const fresh = relay(env, projectDir('fresh'));
    await fresh.initialize(40_000);
    expect(await fresh.toolNames()).toHaveLength(11);
    expect(isAlive(stuck)).toBe(false);
    const [replacement] = serverPids(server.marker);
    expect(replacement).not.toBe(stuck);
    expect(fresh.stderr).toMatch(new RegExp(`shared server ${stuck} does not answer — ending it`));

    // the session that was connected to the stuck server reconnects on its own
    expect(await old.toolNames()).toHaveLength(11);
    expect(serverPids(server.marker)).toEqual([replacement]);
  }, 90_000);

  it('unresponsive: a pid file that points at some other process gets nothing signalled', async () => {
    const env = sharedEnv(configDir(), { MEMORY_BANK_RELAY_HELLO_MS: '500' });
    const server = watch(env);
    fs.mkdirSync(server.indexDir, { recursive: true });
    // a listener on the server's name that accepts and never answers — not a shared server
    const squatter = spawn(process.execPath, ['-e', "require('net').createServer(() => {}).listen(process.argv[1], () => console.log('up')); setInterval(() => {}, 1000)", server.socketPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    strays.push(squatter, bystander);
    await new Promise<void>((resolve) => squatter.stdout!.once('data', () => resolve()));
    fs.writeFileSync(sharedPidPath(server.socketPath), `${bystander.pid}\n`);

    const s = relay(env, projectDir('alpha'));
    s.post('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const exit = await s.waitForExit(20_000);
    expect(exit.code).toBe(1);
    expect(s.stderr).toMatch(/a process that is not a memory-bank shared server holds the socket/);
    expect(responsesOf(s)).toEqual([]);
    expect(isAlive(bystander.pid!)).toBe(true);
    expect(isAlive(squatter.pid!)).toBe(true);
    expect(serverPids(server.marker)).toEqual([]);
  }, 60_000);
});

/**
 * A listener on the server's name that answers — with something that is not a hello reply. Asking again gets
 * the same answer and no server of ours can take the name from it; found as a relay that reconnected 481
 * times in 25 s without an error or an exit (level-3 probe A-003, 2026-11-14).
 */
describe('TC-NEG-004 — wrong listener: something else answers on the server name', () => {
  /** Answers every line with a JSON-RPC error, and prints one line per connection it gets. */
  function wrongListener(socketPath: string): { child: ChildProcess; connections: () => number; up: Promise<void> } {
    const child = spawn(process.execPath, ['-e', `
      let n = 0;
      require('net').createServer((c) => {
        console.log('conn ' + (++n));
        c.on('data', () => c.write('{"jsonrpc":"2.0","id":0,"error":{"code":-1,"message":"not for you"}}\\n'));
        c.on('error', () => {});
      }).listen(process.argv[1], () => console.log('up'));
    `, socketPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    strays.push(child);
    let out = '';
    let ready: () => void;
    const up = new Promise<void>((resolve) => { ready = resolve; });
    child.stdout!.on('data', (d: Buffer) => { out += d.toString(); if (out.includes('up')) ready(); });
    return { child, connections: () => (out.match(/^conn /gm) ?? []).length, up };
  }

  it('wrong listener: a relay that has just begun exits non-zero after one look — no storm of connections, nothing started', async () => {
    const env = sharedEnv(configDir());
    const server = watch(env);
    fs.mkdirSync(server.indexDir, { recursive: true });
    const listener = wrongListener(server.socketPath);
    await listener.up;

    const s = relay(env, projectDir('alpha'));
    s.post('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const exit = await s.waitForExit(10_000);
    expect(exit.code).toBe(1);
    expect(s.stderr).toMatch(/cannot start the shared server: a process that is not a memory-bank shared server answers on the socket/);
    expect(s.stderr).not.toMatch(/running via stdio|shared server off/);
    expect(responsesOf(s)).toEqual([]);
    expect(listener.connections()).toBe(1);
    expect(isAlive(listener.child.pid!)).toBe(true);
    expect(serverPids(server.marker)).toEqual([]);
  }, 60_000);

  it('wrong listener: a relay that is past its start stays, answers calls with the reason, and looks again ever less often', async () => {
    const env = sharedEnv(configDir(), { MEMORY_BANK_RELAY_YOUNG_MS: '1' });
    const server = watch(env);
    fs.mkdirSync(server.indexDir, { recursive: true });
    const listener = wrongListener(server.socketPath);
    await listener.up;

    const s = relay(env, projectDir('alpha'));
    s.post('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const refused = await s.request('tools/list', {}, 15_000);
    expect(refused.error?.code).toBe(-32003);
    expect(refused.error?.message).toMatch(/not a memory-bank shared server answers on the socket/);
    // it looks at 0 s, 1 s, 3 s, 7 s, …
    await waitFor('the third look', () => listener.connections() >= 3 || null, 15_000, 20);
    // the next look is 4 s away: a call that arrives now is answered now, with the reason — not held until then
    const asked = Date.now();
    const again = await s.request('tools/list', {}, 15_000);
    expect(again.error?.code).toBe(-32003);
    expect(again.error?.message).toMatch(/not a memory-bank shared server answers on the socket/);
    expect(Date.now() - asked).toBeLessThan(1_500);
    await sleep(2_000);
    expect(listener.connections(), 'three looks in the first five seconds, where the storm made hundreds').toBe(3);
    expect(s.exit, 'the relay is still there').toBeNull();
    expect(serverPids(server.marker)).toEqual([]);
  }, 60_000);
});

describe('TC-RELAY-003 — watchdog: a connected server that stops answering', () => {
  // SIGSTOP makes a real server silent without killing it; SIGCONT makes the same server "just slow".
  // The thresholds are seconds, not the default 30s — and not less: under the whole suite this process can be
  // a second late in sending a signal, and a window that small turns "slow" into "stuck".
  const pingLine = /\[memory-bank relay\] ping \d+ — no answer for \d+ms/;

  it('watchdog: a call after a long quiet spell is not pinged — the silence clock starts with the call', async () => {
    // Threshold 4s → the watchdog looks every 1s. The call below stays unanswered for 1.5s: at least one look
    // falls inside it (so a clock still standing at the last answer, 5s back, would ping), and 2.5s remain
    // before a correct clock may ping.
    const env = sharedEnv(configDir(), { MEMORY_BANK_RELAY_PING_AFTER_MS: '4000', MEMORY_BANK_SHARED_IDLE_MS: '60000' });
    const server = watch(env);
    const s = relay(env, projectDir('quiet'));
    await s.initialize();
    const [pid] = serverPids(server.marker);
    await sleep(5_000);                 // quiet for longer than the ping threshold, nothing outstanding

    process.kill(pid, 'SIGSTOP');
    const call = s.post('tools/list');
    await sleep(1_500);
    process.kill(pid, 'SIGCONT');
    expect((await s.response(call)).result.tools).toHaveLength(11);
    expect(s.stderr).not.toMatch(pingLine);
    expect(serverPids(server.marker)).toEqual([pid]);
  }, 60_000);

  it('watchdog: a server that is only busy answers the ping and is left alone', async () => {
    // Threshold 4s: the ping goes out 4-5s into the silence, and the server then has 4s to answer it.
    const env = sharedEnv(configDir(), { MEMORY_BANK_RELAY_PING_AFTER_MS: '4000', MEMORY_BANK_SHARED_IDLE_MS: '60000' });
    const server = watch(env);
    const s = relay(env, projectDir('busy'));
    await s.initialize();
    const [pid] = serverPids(server.marker);

    process.kill(pid, 'SIGSTOP');
    const call = s.post('tools/list');
    await s.waitForStderr(pingLine, 20_000); // silent past the threshold: the relay asks
    process.kill(pid, 'SIGCONT');            // …and the server turns out to be alive
    const answer = await s.response(call);
    expect(answer.error, JSON.stringify(answer.error)).toBeUndefined();
    expect(answer.result.tools).toHaveLength(11);
    await sleep(5_000);                      // longer than the wait for a pong
    expect(s.stderr).not.toMatch(/does not answer — ending it/);
    expect(serverPids(server.marker)).toEqual([pid]);
    expect(await s.toolNames()).toHaveLength(11);
  }, 60_000);

  it('watchdog: a server that never answers the ping is ended; the call fails, the session goes on with a new server', async () => {
    const env = sharedEnv(configDir(), { MEMORY_BANK_RELAY_PING_AFTER_MS: '400' });
    const server = watch(env);
    const s = relay(env, projectDir('stuck'));
    await s.initialize();
    const [stuck] = serverPids(server.marker);

    process.kill(stuck, 'SIGSTOP');
    const call = s.post('tools/list');
    const aborted = await s.response(call, 30_000);
    expect(aborted.error?.code).toBe(-32001);
    expect(s.stderr).toMatch(pingLine);
    expect(s.stderr).toMatch(new RegExp(`shared server ${stuck} does not answer — ending it`));
    await waitFor('the stuck server to be gone', () => !isAlive(stuck), 10_000);

    expect(await s.toolNames()).toHaveLength(11);
    const [replacement] = serverPids(server.marker);
    expect(replacement).not.toBe(stuck);
    expect(responsesOf(s).filter((m) => m.result?.serverInfo !== undefined)).toHaveLength(1);
  }, 90_000);
});

describe('TC-NEG-002 — server environment: nothing of one session reaches the shared server', () => {
  it('server environment: allow-listed settings only — no session id, no messaging token, no shell secret', async () => {
    const env = sharedEnv(configDir(), {
      CLAUDE_CODE_SESSION_ID: 'sess-e2e-secret',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/e2e-msg.sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'tok-e2e-secret',
      CLAUDE_PROJECT_DIR: '/work/e2e-project',
      CLAUDE_PLUGIN_ROOT: REPO,
      MB_TEST_SECRET: 'dummy-shell-e2e',
      SOME_API_KEY: 'key-e2e',
      // this session's own LLM settings and locale: they go with its connection, not into the server process
      ANTHROPIC_AUTH_TOKEN: 'llm-token-e2e',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'model-e2e',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDECODE: '1',
      LANG: 'de_DE.UTF-8',
    });
    const server = watch(env);
    const s = relay(env, projectDir('alpha'));
    await s.initialize();
    const [pid] = serverPids(server.marker);
    const shown = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const names = new Set([...shown.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]));
    // the listing does show this process's environment (else the checks below would pass on nothing)
    expect(names.has('MEMORY_BANK_CONFIG_DIR')).toBe(true);
    expect(names.has('PATH')).toBe(true);
    for (const name of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PROJECT_DIR',
      'CLAUDE_PLUGIN_ROOT', 'MB_TEST_SECRET', 'SOME_API_KEY', 'MEMORY_BANK_SHARED_SERVER', 'MEMORY_BANK_RELAY_DEBUG', 'MEMORY_BANK_WRAPPER_NO_NPM', 'PWD',
      'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE', 'LANG']) {
      expect(names.has(name), name).toBe(false);
    }
    for (const value of ['sess-e2e-secret', 'tok-e2e-secret', 'dummy-shell-e2e', 'key-e2e', '/work/e2e-project', 'llm-token-e2e', 'model-e2e', 'de_DE']) {
      expect(shown.includes(value), value).toBe(false);
    }
    // and the server's working directory is not the session's
    const cwdOfServer = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').find((l) => l.startsWith('n'))?.slice(1);
    expect(cwdOfServer).toBe(server.indexDir);
  }, 60_000);

  it("a session whose server settings differ gets a server of its own", async () => {
    const dir = configDir();
    const envA = sharedEnv(dir);
    const envB = sharedEnv(dir, { MEMORY_BANK_LLM_RETRIES: '1' }); // a setting the server itself reads
    const a = watch(envA);
    const b = watch(envB);
    expect(a.marker).not.toBe(b.marker);
    await relay(envA, projectDir('alpha')).initialize();
    await relay(envB, projectDir('bravo')).initialize();
    expect(serverPids(a.marker)).toHaveLength(1);
    expect(serverPids(b.marker)).toHaveLength(1);
    expect(serverPids(a.marker)[0]).not.toBe(serverPids(b.marker)[0]);
  }, 60_000);
});

/**
 * What is a session's alone — the account, endpoint, model and client options of the LLM child its calls
 * start, and its locale — is declared with its connection. Counted as part of the server's identity it split
 * 20 running sessions of one machine over 7 servers (2026-11-14); as a declaration they share one.
 */
describe("TC-ENV-004 — session settings: a session's LLM settings and locale travel with its connection", () => {
  const OTHER_ACCOUNT = {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:10',
    ANTHROPIC_AUTH_TOKEN: 'another-account',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'another-model',
    API_TIMEOUT_MS: '5000',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    ENABLE_TOOL_SEARCH: 'false',
    LANG: 'de_DE.UTF-8',
  };

  it('session settings: sessions that differ only in them share one server', async () => {
    const dir = configDir();
    const envA = sharedEnv(dir);
    const envB = sharedEnv(dir, { ...OTHER_ACCOUNT, CLAUDE_CONFIG_DIR: path.join(dir, 'claude-other') });
    const a = watch(envA);
    const b = watch(envB);
    expect(b.marker).toBe(a.marker);
    expect(b.socketPath).toBe(a.socketPath);
    const [sa, sb] = [relay(envA, projectDir('alpha')), relay(envB, projectDir('bravo'))];
    await Promise.all([sa.initialize(), sb.initialize()]);
    expect(await sa.toolNames()).toHaveLength(11);
    expect(await sb.toolNames()).toHaveLength(11);
    expect(serverPids(a.marker)).toHaveLength(1);
    // each kept its own project on the server they share
    const A = await sa.callTool('search_facts', { query: 'anything' });
    const B = await sb.callTool('search_facts', { query: 'anything' });
    expect(projectLine(A.text)).toMatch(/alpha$/);
    expect(projectLine(B.text)).toMatch(/bravo$/);
  }, 60_000);

  it('session settings: the relay declares them, its locale and its working directory — and nothing else of the session', async () => {
    const cwd = fs.realpathSync(projectDir('alpha'));
    const env = sharedEnv(configDir(), {
      ...OTHER_ACCOUNT,
      CLAUDE_CODE_SESSION_ID: 'sess-hello-secret',
      CLAUDE_CODE_MESSAGING_TOKEN: 'dummy-tok-hello',
      CLAUDE_PROJECT_DIR: '/work/hello-project',
      MB_TEST_SECRET: 'dummy-shell-hello',
    });
    const server = watch(env);
    fs.mkdirSync(server.indexDir, { recursive: true });
    // a stand-in for the server: says yes to the hello and keeps what it was told
    const hellos: any[] = [];
    const standIn = net.createServer((c) => {
      let buf = '';
      c.on('data', (d) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl < 0 || hellos.length > 0) return;
        hellos.push(JSON.parse(buf.slice(0, nl)));
        c.write(JSON.stringify({ mb_relay: 1, ok: true, pid: process.pid, version: server.version }) + '\n');
      });
      c.on('error', () => {});
    });
    await new Promise<void>((resolve) => standIn.listen(server.socketPath, () => resolve()));
    try {
      const s = relay(env, cwd);
      const hello = await waitFor('the hello', () => hellos[0]);
      s.kill();

      expect(hello.cwd).toBe(cwd);
      expect(hello.identity).toBe(server.identity);
      expect(hello.env).toEqual(childEnvFor(env, cwd).env);
      expect(hello.env).toMatchObject({ ...OTHER_ACCOUNT, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR });
      for (const name of Object.keys(hello.env)) {
        expect(name, 'only names of the LLM child').toMatch(/^(ANTHROPIC_|CLAUDE_|_CLAUDE_|AWS_|GOOGLE_|CLOUD_ML_|VERTEX_|DISABLE_|ENABLE_|LC_)|^(CLAUDECODE|API_TIMEOUT_MS|MAX_THINKING_TOKENS|LANG)$/);
      }
      const told = JSON.stringify(hello);
      for (const secret of ['sess-hello-secret', 'dummy-tok-hello', '/work/hello-project', 'dummy-shell-hello', env.MEMORY_BANK_CONFIG_DIR + '"']) {
        expect(told.includes(secret), secret).toBe(false);
      }
      for (const name of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PROJECT_DIR', 'PATH', 'HOME', 'MEMORY_BANK_CONFIG_DIR']) {
        expect(hello.env, name).not.toHaveProperty(name);
      }
      // the locale is the one this session's own process formats in
      const own = execFileSync(process.execPath, ['-e', 'process.stdout.write(new Intl.DateTimeFormat().resolvedOptions().locale)'], { env, encoding: 'utf8' });
      expect(hello.locale).toBe(own);
      expect(own).toBe('de-DE');
    } finally {
      await new Promise<void>((resolve) => standIn.close(() => resolve()));
    }
  }, 60_000);
});

describe('TC-E2E-001 — journey: wrapper → relay → shared server, through a crash, to the end', () => {
  it('journey: two sessions in two projects share a server, keep their own scope, survive its death, and leave nothing behind', async () => {
    const dir = configDir();
    const env = sharedEnv(dir, { MEMORY_BANK_SHARED_IDLE_MS: '1500', CLAUDE_PLUGIN_ROOT: REPO });
    const server = watch(env);
    const A = projectDir('alpha');
    const B = projectDir('bravo');

    // seed: a tagged fact per project and a global one (through the package's own code, into the test config dir)
    const seed = `
      import { initDatabase } from ${JSON.stringify(path.join(REPO, 'dist', 'db.js'))};
      import { insertFact, setFactTags } from ${JSON.stringify(path.join(REPO, 'dist', 'fact-db.js'))};
      const db = initDatabase();
      const v = (i) => { const a = new Array(384).fill(0); a[i] = 1; return a; };
      const add = (fact, scope, project, tag, i) => setFactTags(db, insertFact(db, { fact, category: 'knowledge', scope_type: scope, scope_project: project, source_exchange_ids: [], embedding: v(i) }), [tag]);
      add('ALPHA-ONLY the alpha service deploys from main', 'project', ${JSON.stringify(A)}, 'alpha-tag', 1);
      add('BRAVO-ONLY the bravo service deploys from release', 'project', ${JSON.stringify(B)}, 'bravo-tag', 2);
      add('GLOBAL deploys are announced in the channel', 'global', null, 'shared-tag', 3);
      db.close();`;
    execFileSync(process.execPath, ['--input-type=module', '-e', seed], { env, cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] });

    // 1. a wrapper per session, as the plugin registers it
    const a = new StdioSession(WRAPPER, { cwd: A, env });
    const b = new StdioSession(WRAPPER, { cwd: B, env });
    sessions.push(a, b);
    await Promise.all([a.initialize(), b.initialize()]);
    expect(await a.toolNames()).toHaveLength(11);
    expect(await b.toolNames()).toHaveLength(11);

    // 2. one server for both
    const [first] = serverPids(server.marker);
    expect(serverPids(server.marker)).toHaveLength(1);

    // 3. each sees its own project and the global facts — never the other project
    const scopeOf = async (s: StdioSession) => {
      const index = (await s.callTool('list_tags')).text;
      const tagged = (await s.callTool('list_tags', { tags: ['alpha-tag', 'bravo-tag', 'shared-tag'], match: 'any' })).text;
      return { index, tagged };
    };
    const check = async () => {
      const sa = await scopeOf(a);
      const sb = await scopeOf(b);
      expect(projectLine(sa.index)).toBe(`Project: ${A}`);
      expect(projectLine(sb.index)).toBe(`Project: ${B}`);
      expect(sa.index).toContain('alpha-tag');
      expect(sa.index).toContain('shared-tag');
      expect(sa.index).not.toContain('bravo-tag');
      expect(sb.index).toContain('bravo-tag');
      expect(sb.index).not.toContain('alpha-tag');
      expect(sa.tagged).toContain('ALPHA-ONLY');
      expect(sa.tagged).toContain('GLOBAL deploys');
      expect(sa.tagged).not.toContain('BRAVO-ONLY');
      expect(sb.tagged).toContain('BRAVO-ONLY');
      expect(sb.tagged).not.toContain('ALPHA-ONLY');
    };
    await check();

    // 4. the server dies; both sessions go on, on one new server, with their scope intact
    process.kill(first, 'SIGKILL');
    await waitFor('the first server to be gone', () => !isAlive(first));
    expect(await a.toolNames()).toHaveLength(11);
    expect(await b.toolNames()).toHaveLength(11);
    const after = serverPids(server.marker);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(first);
    await check();

    // 5. both sessions end; the server ends on its own and leaves no socket, pid file or lock
    const ends = await Promise.all([a.end(), b.end()]);
    for (const e of ends) expect(e.code === 0 || e.signal === 'SIGTERM' || e.code === 143, JSON.stringify(e)).toBe(true);
    await waitFor('the shared server to end after its sessions left', () => serverPids(server.marker).length === 0, 15_000);
    expect(fs.readdirSync(server.indexDir).filter((n) => n.startsWith('mb-shared-'))).toEqual([]);
    // neither wrapper ran npm, and nothing but JSON reached the clients
    for (const s of [a, b]) {
      expect(s.stderr).not.toMatch(/running npm|rescue attempt/);
      for (const line of s.lines) expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 120_000);
});

describe('leftovers', () => {
  it('a test that ended leaves no relay or shared server of this checkout running (the afterEach above ends them)', async () => {
    const env = sharedEnv(configDir());
    const server = watch(env);
    const s = relay(env, projectDir('alpha'));
    await s.initialize();
    const pids = [s.pid, ...serverPids(server.marker)];
    expect(pids).toHaveLength(2);
    await cleanup({ sessions: [s], markers: [server.marker] });
    await killAll(pids);
    expect(pids.filter(isAlive)).toEqual([]);
  }, 60_000);
});
