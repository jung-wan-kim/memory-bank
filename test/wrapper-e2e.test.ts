import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end: the supervising wrapper live-swaps its MCP server when the
 * plugin dir's version changes on disk — the client keeps one uninterrupted
 * stdio connection across the swap (zero downtime, no re-initialize).
 */

const WRAPPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'mcp-server-wrapper.js');

// Fake MCP server: newline JSON-RPC; reports the marker file's content so the
// test can tell WHICH on-disk code generation served each response. When the
// marker is CRASH it exits once (writes a flag), then serves normally — this
// exercises the startup-crash rescue path.
const FAKE_SERVER = `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marker = fs.readFileSync(path.join(root, 'marker.txt'), 'utf8').trim();
if (marker === 'CRASH') {
  const flag = path.join(root, 'crashed-once');
  if (!fs.existsSync(flag)) { fs.writeFileSync(flag, '1'); process.exit(7); }
}
let buf = '';
let initialized = false;
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      initialized = true;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: marker } } }) + '\\n');
    } else if (m.method === 'crashme') {
      // Die WITHOUT responding — exercises the in-flight-abort path.
      process.exit(9);
    } else if (m.method === 'tools/list') {
      // Like a real MCP SDK server: refuse requests before initialize — so a
      // wrapper regression that skips the handshake replay fails this test.
      if (!initialized) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'not initialized' } }) + '\\n');
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { marker } }) + '\\n');
      }
    }
  }
});
`;

let root: string;
let child: ChildProcess | null = null;
let received: Array<Record<string, unknown>> = [];

function mkPluginRoot(version: string, marker: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-e2e-'));
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true }); // skip first-run npm
  fs.writeFileSync(path.join(dir, 'dist', 'mcp-server.js'), FAKE_SERVER);
  fs.writeFileSync(path.join(dir, 'marker.txt'), marker);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
  return dir;
}

function startWrapper(pluginRoot: string): ChildProcess {
  const c = spawn(process.execPath, [WRAPPER], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      MEMORY_BANK_WRAPPER_POLL_MS: '150',
      MEMORY_BANK_WRAPPER_NO_NPM: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  c.stdout!.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        received.push(JSON.parse(line));
      } catch {
        /* ignore non-JSON */
      }
    }
  });
  return c;
}

function send(c: ChildProcess, msg: Record<string, unknown>): void {
  c.stdin!.write(JSON.stringify(msg) + '\n');
}

async function waitFor<T>(pred: () => T | undefined, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = pred();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  received = [];
});

afterEach(() => {
  child?.kill('SIGKILL');
  child = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('supervising wrapper', () => {
  it('live-swaps the server on version change without breaking the connection', async () => {
    root = mkPluginRoot('1.0.0', 'GEN1');
    child = startWrapper(root);

    send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const init = await waitFor(() => received.find((m) => m.id === 1));
    expect((init as { result: any }).result.serverInfo.version).toBe('GEN1');
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const l1 = await waitFor(() => received.find((m) => m.id === 2));
    expect((l1 as { result: any }).result.marker).toBe('GEN1');

    // A new release lands on disk (what live-apply does).
    fs.writeFileSync(path.join(root, 'marker.txt'), 'GEN2');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.1' }));

    // Wait past the poll interval, then talk over the SAME connection.
    await new Promise((r) => setTimeout(r, 1200));
    send(child, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const l2 = await waitFor(() => received.find((m) => m.id === 3));
    expect((l2 as { result: any }).result.marker).toBe('GEN2');

    // The replayed handshake must be swallowed: exactly one response for id 1.
    expect(received.filter((m) => m.id === 1).length).toBe(1);
    expect(child.exitCode).toBeNull(); // wrapper (the session's endpoint) never died
  }, 30000);

  it('rescues a startup crash and still answers the waiting initialize', async () => {
    root = mkPluginRoot('1.0.0', 'CRASH');
    child = startWrapper(root);

    send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    // First child exits(7) before responding; the wrapper respawns and
    // re-delivers the recorded initialize so the client finally gets its answer.
    const init = await waitFor(() => received.find((m) => m.id === 1), 15000);
    expect((init as { result: any }).result.serverInfo.version).toBe('CRASH');
    expect(received.filter((m) => m.id === 1).length).toBe(1);
  }, 30000);

  it('fails an in-flight request back to the client when the child crashes (HIGH 4)', async () => {
    root = mkPluginRoot('1.0.0', 'GEN1');
    child = startWrapper(root);

    send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(() => received.find((m) => m.id === 1));
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

    // Send a call that makes the server die without responding.
    send(child, { jsonrpc: '2.0', id: 42, method: 'crashme', params: {} });
    // The client must receive a JSON-RPC error for id 42 (not hang forever).
    const err = await waitFor(() => received.find((m) => m.id === 42), 10000);
    expect((err as { error: any }).error.code).toBe(-32001);

    // And the session recovers: the replayed handshake lets a new call succeed.
    send(child, { jsonrpc: '2.0', id: 43, method: 'tools/list', params: {} });
    const ok = await waitFor(() => received.find((m) => m.id === 43), 10000);
    expect((ok as { result: any }).result.marker).toBe('GEN1');
  }, 30000);
});
