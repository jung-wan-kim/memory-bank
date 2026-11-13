import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sharedLockPath } from '../src/shared-identity.js';
import {
  REPO, RELAY_ENTRY, WRAPPER, createRig, isAlive, makePluginRoot, responsesOf, serverLog, serverPids,
  setPackageVersion, sharedEnv, sleep, waitFor, type StdioSession,
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

const rig = createRig();
const { tmp, session, watch } = rig;

function pluginRoot(wrapper?: string): ReturnType<typeof makePluginRoot> {
  const root = makePluginRoot({ wrapper });
  rig.dirs.push(root.root);
  return root;
}

afterEach(() => rig.cleanup());

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

/**
 * A server that starts, serves, and ends moments later — again and again (a crash in something every start
 * does). Reconnecting at once each time started a server every 3 s for as long as the session lived: 20
 * starts in 60 s (level-3 probe A-006, 2026-11-14).
 */
describe('TC-NEG-005 — crash loop: a server that keeps ending right after it starts', () => {
  /** When each line of interest turned up in the relay's stderr, for the 1st, 2nd, … time (looked at every 20 ms). */
  function clock(s: StdioSession, patterns: Record<'connected' | 'waiting', RegExp>): { at: Record<'connected' | 'waiting', number[]>; stop(): void } {
    const at = { connected: [] as number[], waiting: [] as number[] };
    const timer = setInterval(() => {
      for (const key of ['connected', 'waiting'] as const) {
        const count = (s.stderr.match(patterns[key]) ?? []).length;
        while (at[key].length < count) at[key].push(Date.now());
      }
    }, 20);
    return { at, stop: () => clearInterval(timer) };
  }

  it('crash loop: the first loss reconnects at once, the next ones wait 2 s, 4 s, … and a server that stays is used again', async () => {
    const plugin = pluginRoot();
    // the real server, ended 600 ms after it began serving for as long as the flag file is there
    const flag = path.join(plugin.root, 'end-after-serving');
    fs.renameSync(plugin.serverFile, path.join(path.dirname(plugin.serverFile), 'shared-server-real.js'));
    fs.writeFileSync(plugin.serverFile, `
      import fs from 'node:fs';
      const serving = () => {
        try { return fs.readdirSync('.').some((n) => n.endsWith('.pid') && fs.readFileSync(n, 'utf8').trim() === String(process.pid)); } catch { return false; }
      };
      const poll = setInterval(() => {
        if (!serving()) return;
        clearInterval(poll);
        if (fs.existsSync(${JSON.stringify(flag)})) setTimeout(() => process.exit(0), 600);
      }, 20);
      await import('./shared-server-real.js');
    `);
    fs.writeFileSync(flag, '');

    const env = sharedEnv(tmp());
    const server = watch(env, plugin.entry);
    const s = session(plugin.entry, env, tmp('mbp-'));
    const seen = clock(s, {
      connected: /connected to shared server \d+/g,
      waiting: /no shared server \(the shared server keeps ending right after it starts\)/g,
    });
    try {
      await s.initialize();
      // loss 1: back at once. loss 2: the relay says it waits, and the third server comes 2 s later.
      await waitFor('the third server', () => seen.at.connected.length >= 3 || null, 60_000, 20);
      expect(s.stderr).toMatch(/the shared server went away — reconnecting/);
      expect(seen.at.waiting.length).toBeGreaterThanOrEqual(1);
      expect(seen.at.connected[2] - seen.at.waiting[0], 'started 2 s after the second was lost').toBeGreaterThanOrEqual(1_800);

      // loss 3: a longer wait — and this time a server that stays is what comes back
      await waitFor('the third loss', () => seen.at.waiting.length >= 2 || null, 60_000, 20);
      fs.rmSync(flag);
      await waitFor('the fourth server', () => seen.at.connected.length >= 4 || null, 60_000, 20);
      expect(seen.at.connected[3] - seen.at.waiting[1], 'started 4 s after the third was lost').toBeGreaterThanOrEqual(3_600);
    } finally {
      seen.stop();
    }

    expect(await s.toolNames()).toHaveLength(11);
    expect(s.exit, 'the relay never left').toBeNull();
    const pids = [...s.stderr.matchAll(/connected to shared server (\d+)/g)].map((m) => m[1]);
    expect(new Set(pids).size, 'four servers in all: three that ended, one that stayed').toBe(4);
    expect(serverPids(server.marker)).toHaveLength(1);
    // the client's handshake was answered once, however many servers came and went
    expect(responsesOf(s).filter((m) => m.result?.serverInfo !== undefined)).toHaveLength(1);
  }, 120_000);
});

/**
 * A relay killed while it held the start lock leaves the file behind. Sessions that find the server answering
 * never look at it, so the server clears it — at start and on every self-check.
 */
describe('TC-NEG-006 — start lock: one left by a relay that is gone', () => {
  it('start lock: the running server removes an orphan, leaves a held one alone, and a start is not delayed by one', async () => {
    const env = sharedEnv(tmp()); // self-check every 300 ms
    const server = watch(env);
    const lock = sharedLockPath(server.socketPath);
    const orphan = (): void => {
      fs.writeFileSync(lock, '999999'); // no such process: macOS and Linux pids stop far below
      const then = new Date(Date.now() - 5_000);
      fs.utimesSync(lock, then, then);
    };

    // before any server: the first relay takes the orphan over instead of waiting for it
    fs.mkdirSync(server.indexDir, { recursive: true });
    orphan();
    const started = Date.now();
    const s = session(RELAY_ENTRY, env, tmp('mbp-'));
    await s.initialize();
    expect(Date.now() - started, 'the start did not wait for the lock to age out').toBeLessThan(15_000);
    expect(fs.existsSync(lock), 'the relay gave its own lock back').toBe(false);

    // under a running server: gone within a few self-checks
    orphan();
    await waitFor('the server to remove the orphan lock', () => !fs.existsSync(lock), 5_000);
    // the server removes the file first and writes the line after it: wait for the line, do not read between the two
    await waitFor('the server to say it removed the lock', () => /removed the start lock of a relay that is gone/.test(serverLog(server.indexDir)), 5_000);

    // a lock a live process holds is somebody starting a server right now: never removed
    fs.writeFileSync(lock, String(process.pid));
    await sleep(1_200);
    expect(fs.existsSync(lock)).toBe(true);
    fs.rmSync(lock);
    expect(await s.toolNames()).toHaveLength(11);
  }, 60_000);
});

/**
 * An install that lacks what the shared server needs is not a reason to run a server per session without a
 * word: that would hide the broken install for good. The entry exits non-zero and says what is missing.
 */
describe('TC-NEG-007 — incomplete install: no quiet fall back to a server per session', () => {
  const INIT = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } };

  it.each([
    ['dist/shared-server.js is missing', (plugin: ReturnType<typeof makePluginRoot>) => fs.rmSync(plugin.serverFile), /this install is incomplete: dist\/shared-server\.js is missing/],
    ['package.json has no version', (plugin: ReturnType<typeof makePluginRoot>) => fs.writeFileSync(plugin.packageJson, '{ "name": "memory-bank" }'), /this install is incomplete: the plugin version .* cannot be read/],
  ])('incomplete install (%s): exits non-zero, says what is missing, answers nothing', async (_what, breakIt, why) => {
    const plugin = pluginRoot();
    breakIt(plugin);
    const env = sharedEnv(tmp());
    const s = session(plugin.entry, env, tmp('mbp-'));
    s.post('initialize', INIT);
    const exit = await s.waitForExit(20_000);
    expect(exit.code).toBe(1);
    expect(s.stderr).toMatch(why);
    expect(s.stderr).toMatch(/MEMORY_BANK_SHARED_SERVER=0/);
    expect(s.stderr).not.toMatch(/shared server off|running via stdio/);
    expect(responsesOf(s)).toEqual([]);
  }, 60_000);

  it('incomplete install: the switch the message names does run a server per session, and says so', async () => {
    const plugin = pluginRoot();
    fs.rmSync(plugin.serverFile);
    const env = sharedEnv(tmp(), { MEMORY_BANK_SHARED_SERVER: '0' });
    const s = session(plugin.entry, env, tmp('mbp-'));
    await s.initialize();
    expect(await s.toolNames()).toHaveLength(11);
    expect(s.stderr).toMatch(/shared server off: MEMORY_BANK_SHARED_SERVER is off — this session runs its own server/);
  }, 60_000);
});
