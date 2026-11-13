import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO, WRAPPER, StdioSession, cleanup, expectedServer, isAlive, makePluginRoot, responsesOf, serverLog, serverPids,
  setPackageVersion, sharedEnv, shortTmpDir, sleep, waitFor,
} from './helpers/shared-harness.js';

/**
 * The upgrade path, and what happens when a server cannot be started — against a throwaway copy of the
 * installed plugin (dist, package.json, the wrapper), so a test can change the version on disk or break a
 * file the way an update or a bad install does.
 *
 * Sessions that were started under 1.8.0 keep the 1.8.0 wrapper in memory for as long as they live: after the
 * update that wrapper is what starts the new dist/mcp-server.js. test/fixtures/wrapper-1.8.0.js is that file.
 */

const WRAPPER_1_8_0 = path.join(REPO, 'test', 'fixtures', 'wrapper-1.8.0.js');

const sessions: StdioSession[] = [];
const markers = new Set<string>();
const dirs: string[] = [];

function tmp(prefix?: string): string {
  const dir = shortTmpDir(prefix);
  dirs.push(dir);
  return dir;
}

function pluginRoot(wrapper?: string): ReturnType<typeof makePluginRoot> {
  const root = makePluginRoot({ wrapper });
  dirs.push(root.root);
  return root;
}

function session(entry: string, env: Record<string, string>, cwd: string): StdioSession {
  const s = new StdioSession(entry, { cwd, env });
  sessions.push(s);
  return s;
}

function watch(env: Record<string, string>, entry: string, version?: string): ReturnType<typeof expectedServer> {
  const server = expectedServer(env, entry, version);
  markers.add(server.marker);
  return server;
}

afterEach(async () => {
  await cleanup({ sessions: sessions.splice(0), markers: [...markers], dirs: dirs.splice(0) });
  markers.clear();
});

describe('TC-UPD-001 — a session that still runs the 1.8.0 wrapper', () => {
  it('this release ships the wrapper unchanged (the fixture is the file 1.8.0 sessions have in memory)', () => {
    expect(fs.readFileSync(WRAPPER).equals(fs.readFileSync(WRAPPER_1_8_0))).toBe(true);
  });

  it('1.8.0 wrapper: starts the new dist, and initialize, the tool list and a tool call all work', async () => {
    const plugin = pluginRoot(WRAPPER_1_8_0);
    const env = sharedEnv(tmp(), { CLAUDE_PLUGIN_ROOT: plugin.root });
    const server = watch(env, plugin.entry);
    const project = tmp('mbp-');
    const s = session(plugin.wrapper, env, project);
    const init = await s.initialize();
    expect(init.result.serverInfo.name).toBe('memory-bank');
    expect(await s.toolNames()).toHaveLength(11);
    const tags = await s.callTool('list_tags');
    expect(tags.isError).toBe(false);
    expect(tags.text).toContain(`Project: ${project}`);
    expect(serverPids(server.marker)).toHaveLength(1);
    // the wrapper saw a healthy child: no rescue, no respawn
    expect(s.stderr).not.toMatch(/running npm|rescue attempt|server crashed|replay handshake timed out/);
    for (const line of s.lines) expect(() => JSON.parse(line)).not.toThrow();
  }, 90_000);
});

describe('TC-UPD-002 — the plugin version on disk changes under a live session', () => {
  it('version change: the wrapper swaps the relay, the new relay uses the new version\'s server, the old server ends', async () => {
    const plugin = pluginRoot(WRAPPER_1_8_0);
    const env = sharedEnv(tmp(), { CLAUDE_PLUGIN_ROOT: plugin.root, MEMORY_BANK_WRAPPER_POLL_MS: '300', MEMORY_BANK_SHARED_IDLE_MS: '60000' });
    const before = watch(env, plugin.entry);
    const next = `${before.version}-next.1`;
    const after = watch(env, plugin.entry, next);
    expect(after.marker).not.toBe(before.marker);

    const s = session(plugin.wrapper, env, tmp('mbp-'));
    await s.initialize();
    expect(await s.toolNames()).toHaveLength(11);
    const [oldServer] = serverPids(before.marker);
    expect(oldServer).toBeGreaterThan(1);

    setPackageVersion(plugin.packageJson, next); // what an update does last
    await s.waitForStderr(/live-swapping server/, 20_000);

    // the same session keeps working — on the new version's server — without initializing again
    expect(await s.toolNames()).toHaveLength(11);
    const [newServer] = await waitFor('the new version\'s server', () => { const p = serverPids(after.marker); return p.length === 1 ? p : null; });
    expect(newServer).not.toBe(oldServer);
    expect(fs.existsSync(after.socketPath)).toBe(true);
    expect(responsesOf(s).filter((m) => m.result?.serverInfo !== undefined)).toHaveLength(1);
    expect(s.stderr).not.toMatch(/rescue attempt|server crashed|replay handshake timed out/);

    // the old server has no session left and the version on disk moved on: it ends without waiting for the idle time (60s here)
    await waitFor('the old server to end', () => !isAlive(oldServer), 15_000);
    expect(fs.existsSync(before.socketPath)).toBe(false);
    expect(serverLog(before.indexDir)).toMatch(/retiring: the plugin on disk is now /);
  }, 120_000);

  it('retire: a server keeps serving the session it has after the version changed, and ends when that session leaves', async () => {
    const plugin = pluginRoot();
    const env = sharedEnv(tmp(), { MEMORY_BANK_SHARED_IDLE_MS: '60000' });
    const server = watch(env, plugin.entry);
    const s = session(plugin.entry, env, tmp('mbp-')); // a relay on its own: nothing swaps it
    await s.initialize();
    const [pid] = serverPids(server.marker);

    // a package.json that cannot be read for a moment (an update in flight) is not "another version"
    const good = fs.readFileSync(plugin.packageJson);
    fs.writeFileSync(plugin.packageJson, '{ "version": ');
    await sleep(1_200); // several self-checks (300ms apart)
    expect(serverLog(server.indexDir)).not.toMatch(/retiring/);
    fs.writeFileSync(plugin.packageJson, good);

    setPackageVersion(plugin.packageJson, `${server.version}-next.2`);
    await waitFor('the server to retire', () => /retiring: the plugin on disk is now /.test(serverLog(server.indexDir)), 10_000);
    expect(isAlive(pid)).toBe(true);
    expect(await s.toolNames()).toHaveLength(11);

    expect((await s.end()).code).toBe(0);
    await waitFor('the retired server to end', () => !isAlive(pid), 10_000);
    expect(serverLog(server.indexDir)).toMatch(/exit: retired \(the plugin on disk is now /);
  }, 90_000);

  it('retire: compiled code that changed under a server (same version) retires it too', async () => {
    const plugin = pluginRoot();
    const env = sharedEnv(tmp(), { MEMORY_BANK_SHARED_IDLE_MS: '60000' });
    const server = watch(env, plugin.entry);
    const s = session(plugin.entry, env, tmp('mbp-'));
    await s.initialize();
    const [pid] = serverPids(server.marker);
    fs.appendFileSync(path.join(plugin.root, 'dist', 'noise.js'), '\n// rebuilt\n');
    await waitFor('the server to retire', () => /retiring: the compiled code on disk changed/.test(serverLog(server.indexDir)), 10_000);
    expect((await s.end()).code).toBe(0);
    await waitFor('the retired server to end', () => !isAlive(pid), 10_000);
  }, 90_000);
});

describe('TC-NEG-001 — a shared server that cannot start is never papered over', () => {
  const INIT = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } };

  it.each([
    ['exits with the start-failure code', 'process.exit(70);\n', /the server exited during start-up \(code 70\)/],
    ['ends without a word (code 0)', '// nothing to do\n', /the server exited during start-up \(code 0\)/],
    ['crashes on load', "throw new Error('addon missing');\n", /the server exited during start-up \(code 1\)/],
  ])('cannot start (%s): a relay that has just begun exits non-zero and answers nothing', async (_what, body, why) => {
    const plugin = pluginRoot();
    fs.writeFileSync(plugin.serverFile, body);
    const env = sharedEnv(tmp());
    const server = watch(env, plugin.entry);
    const s = session(plugin.entry, env, tmp('mbp-'));
    s.post('initialize', INIT);
    const exit = await s.waitForExit(30_000);
    expect(exit.code).toBe(1);
    expect(s.stderr).toMatch(/cannot start the shared server/);
    expect(s.stderr).toMatch(why);
    // it did not turn into a server of its own, and no tool was answered from anywhere
    expect(s.stderr).not.toMatch(/running via stdio|shared server off/);
    expect(responsesOf(s)).toEqual([]);
    expect(serverPids(server.marker)).toEqual([]);
    expect(fs.readdirSync(server.indexDir).filter((n) => n.endsWith('.lock'))).toEqual([]);
  }, 60_000);

  it('cannot start: a relay that has been serving stays, answers calls with an error, and works again once a server can start', async () => {
    const plugin = pluginRoot();
    const env = sharedEnv(tmp(), { MEMORY_BANK_RELAY_YOUNG_MS: '300' });
    const server = watch(env, plugin.entry);
    const s = session(plugin.entry, env, tmp('mbp-'));
    await s.initialize();
    expect(await s.toolNames()).toHaveLength(11);
    const [first] = serverPids(server.marker);
    await sleep(400); // older than "just begun"

    const good = fs.readFileSync(plugin.serverFile);
    fs.writeFileSync(plugin.serverFile, 'process.exit(70);\n');
    process.kill(first, 'SIGKILL');
    await s.waitForStderr(/no shared server \(the server exited during start-up \(code 70\)\)/, 30_000);

    const refused = await s.request('tools/list', {}, 30_000);
    expect(refused.error?.code).toBe(-32003);
    expect(refused.error?.message).toMatch(/shared server is not available/);
    expect(refused.error?.message).toMatch(/shared-server\.log/);
    expect(s.exit, 'the relay is still there').toBeNull();

    fs.writeFileSync(plugin.serverFile, good);
    const names = await waitFor('a call to succeed again', async () => {
      const r = await s.request('tools/list', {}, 30_000);
      return r.result?.tools?.length === 11 ? r.result.tools : null;
    }, 60_000, 500);
    expect(names).toHaveLength(11);
    const [second] = serverPids(server.marker);
    expect(second).not.toBe(first);
    // the client's handshake was replayed for it: one initialize answer in total
    expect(responsesOf(s).filter((m) => m.result?.serverInfo !== undefined)).toHaveLength(1);
  }, 120_000);
});
