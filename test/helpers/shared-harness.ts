import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sharedServerArg } from '../../src/shared-identity.js';
import { sharedMode } from '../../src/shared-mode.js';

/**
 * Test helpers for the shared MCP server.
 *
 * Config dirs are made under /tmp: a unix socket path must fit ~103 bytes, and os.tmpdir() on macOS is too
 * deep for it (the suite's default config dir is — which is why shared mode is off by default in tests).
 */

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A short directory under /tmp, symlinks resolved (macOS: /tmp → /private/tmp). */
export function shortTmpDir(prefix = 'mbs-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join('/tmp', prefix)));
}

export async function waitFor<T>(what: string, probe: () => T | Promise<T>, timeoutMs = 10_000, everyMs = 25): Promise<NonNullable<T>> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    await sleep(everyMs);
  }
}

/** A raw client of the shared server's socket: sends lines, collects the lines that come back. */
export class LineClient {
  readonly lines: string[] = [];
  closed = false;
  private buf = '';
  private waiters: Array<() => void> = [];

  private constructor(readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        this.lines.push(this.buf.slice(0, nl));
        this.buf = this.buf.slice(nl + 1);
      }
      this.wake();
    });
    socket.on('error', () => { /* the server hung up — 'close' follows */ });
    socket.on('close', () => { this.closed = true; this.wake(); });
  }

  static connect(socketPath: string): Promise<LineClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      socket.once('connect', () => resolve(new LineClient(socket)));
      socket.once('error', reject);
    });
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  send(value: unknown): void {
    this.socket.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\n');
  }

  /** The next line that satisfies `match` (default: any), parsed. Rejects when the connection closes first. */
  async next(match: (msg: any) => boolean = () => true, timeoutMs = 10_000): Promise<any> {
    const until = Date.now() + timeoutMs;
    let seen = 0;
    for (;;) {
      for (; seen < this.lines.length; seen++) {
        let msg: unknown;
        try { msg = JSON.parse(this.lines[seen]); } catch { continue; }
        if (match(msg)) return msg;
      }
      if (this.closed) throw new Error('connection closed before the expected line arrived');
      const left = until - Date.now();
      if (left <= 0) throw new Error('timed out waiting for a line');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
  }

  /** JSON-RPC request → its response. */
  async request(id: number | string, method: string, params: unknown = {}, timeoutMs = 20_000): Promise<any> {
    this.send({ jsonrpc: '2.0', id, method, params });
    return this.next((m) => m && m.id === id && m.method === undefined, timeoutMs);
  }

  async waitClosed(timeoutMs = 5_000): Promise<void> {
    await waitFor('the connection to close', () => this.closed, timeoutMs);
  }

  close(): void {
    this.socket.destroy();
  }
}

export const INITIALIZE_PARAMS = {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'shared-harness', version: '0.0.0' },
};

/** hello + MCP initialize on a fresh connection. */
export async function openSession(socketPath: string, hello: { identity: string; version: string; cwd: string | null }): Promise<LineClient> {
  const client = await LineClient.connect(socketPath);
  client.send({ mb_relay: 1, pid: process.pid, ...hello });
  const reply = await client.next((m) => m && m.mb_relay === 1);
  if (!reply.ok) throw new Error(`hello refused: ${reply.error}`);
  await client.request('init', 'initialize', INITIALIZE_PARAMS);
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return client;
}

export function toolText(response: any): string {
  return (response.result?.content ?? []).map((c: { text: string }) => c.text).join('\n');
}

/** pids of live processes whose command line contains every one of `needles`. */
export function pidsMatching(...needles: string[]): number[] {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && needles.every((n) => m[2].includes(n)) && Number(m[1]) !== process.pid) pids.push(Number(m[1]));
  }
  return pids;
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** End the processes a test started (by pid) and wait until they are gone. */
export async function killAll(pids: number[], signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
  await waitFor('test processes to exit', () => pids.every((pid) => !isAlive(pid)), 5_000).catch(() => { /* reported by the caller's own checks */ });
}

export const REPO = path.resolve(__dirname, '..', '..');
export const RELAY_ENTRY = path.join(REPO, 'dist', 'mcp-server.js');
export const WRAPPER = path.join(REPO, 'cli', 'mcp-server-wrapper.js');

/**
 * The environment of a session that uses the shared server, against a throwaway config dir: short idle time,
 * LLM endpoint closed, the live-database guard on. Whatever the developer's shell exports for this plugin is
 * dropped first — a test must not pick its database or its timings up from there.
 */
export function sharedEnv(configDir: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(MEMORY_BANK_|TEST_)/.test(k)) env[k] = v;
  }
  return {
    ...env,
    MEMORY_BANK_CONFIG_DIR: configDir,
    CLAUDE_CONFIG_DIR: path.join(configDir, 'claude'),
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    MEMORY_BANK_TEST_GUARD: '1',
    MEMORY_BANK_SHARED_SERVER: '1',
    MEMORY_BANK_SHARED_IDLE_MS: '1500',
    MEMORY_BANK_SHARED_TICK_MS: '300',
    MEMORY_BANK_SHARED_RETIRE_GRACE_MS: '300',
    MEMORY_BANK_RELAY_DEBUG: '1',
    MEMORY_BANK_WRAPPER_NO_NPM: '1',
    ...extra,
  };
}

/** The shared server a session with `env` would use: its socket, and the marker on its command line. */
export function expectedServer(env: Record<string, string>, entry: string = RELAY_ENTRY, version?: string): { socketPath: string; indexDir: string; marker: string; identity: string; version: string } {
  const mode = sharedMode({ entryUrl: pathToFileURL(entry).href, env, cwd: '/', ...(version === undefined ? {} : { version }) });
  if (mode.kind !== 'shared') throw new Error(`this environment does not use a shared server: ${mode.reason}`);
  return { socketPath: mode.socketPath, indexDir: mode.indexDir, marker: sharedServerArg(mode.identity), identity: mode.identity, version: mode.version };
}

/** pids of the shared server processes of one identity (found by the marker on their command line). */
export function serverPids(marker: string): number[] {
  return pidsMatching('shared-server.js', marker);
}

/** One MCP session over stdio: a relay (dist/mcp-server.js), or a wrapper in front of one. */
export class StdioSession {
  readonly child: ChildProcess;
  readonly lines: string[] = [];
  stderr = '';
  exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private buf = '';
  private nextId = 1;
  private waiters: Array<() => void> = [];

  constructor(entry: string, opts: { cwd: string; env: Record<string, string>; args?: string[] }) {
    this.child = spawn(process.execPath, [entry, ...(opts.args ?? [])], { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        this.lines.push(this.buf.slice(0, nl));
        this.buf = this.buf.slice(nl + 1);
      }
      this.wake();
    });
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (chunk: string) => { this.stderr += chunk; this.wake(); });
    this.child.stdin!.on('error', () => { /* the process is gone */ });
    this.child.on('exit', (code, signal) => { this.exit = { code, signal }; this.wake(); });
  }

  get pid(): number { return this.child.pid!; }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  private async until<T>(what: string, probe: () => T | undefined, timeoutMs: number): Promise<T> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const value = probe();
      if (value !== undefined) return value;
      const left = until - Date.now();
      if (left <= 0) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}\n--- stderr ---\n${this.stderr.slice(-1500)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 200));
        this.waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
  }

  send(message: unknown): void {
    this.child.stdin!.write(JSON.stringify(message) + '\n');
  }

  /** Send a request without waiting; returns its id. */
  post(method: string, params: unknown = {}): number {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return id;
  }

  /** The response to request `id` — a result or an error. Throws when the process exits first. */
  response(id: number, timeoutMs = 30_000): Promise<any> {
    let seen = 0;
    return this.until(`the response to request ${id}`, () => {
      for (; seen < this.lines.length; seen++) {
        let msg: any;
        try { msg = JSON.parse(this.lines[seen]); } catch { continue; }
        if (msg && msg.id === id && msg.method === undefined) return msg;
      }
      if (this.exit !== null) throw new Error(`the process exited (${JSON.stringify(this.exit)}) before answering request ${id}\n--- stderr ---\n${this.stderr.slice(-1500)}`);
      return undefined;
    }, timeoutMs);
  }

  request(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<any> {
    return this.response(this.post(method, params), timeoutMs);
  }

  async initialize(timeoutMs = 30_000): Promise<any> {
    const response = await this.request('initialize', INITIALIZE_PARAMS, timeoutMs);
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return response;
  }

  async toolNames(): Promise<string[]> {
    const response = await this.request('tools/list');
    return (response.result?.tools ?? []).map((t: { name: string }) => t.name).sort();
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; raw: any }> {
    const raw = await this.request('tools/call', { name, arguments: args });
    return { text: toolText(raw), isError: raw.result?.isError === true || raw.error !== undefined, raw };
  }

  waitForStderr(pattern: RegExp, timeoutMs = 20_000): Promise<RegExpExecArray> {
    return this.until(`stderr to match ${pattern}`, () => pattern.exec(this.stderr) ?? undefined, timeoutMs);
  }

  waitForExit(timeoutMs = 15_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.until('the process to exit', () => this.exit ?? undefined, timeoutMs);
  }

  /** The client goes away: stdin closes. Resolves with how the process ended. */
  async end(timeoutMs = 15_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.child.stdin!.end();
    return this.waitForExit(timeoutMs);
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    if (this.exit === null) { try { this.child.kill(signal); } catch { /* gone */ } }
  }
}

/** Responses on stdout that are JSON-RPC results or errors (what a client would have received). */
export function responsesOf(session: StdioSession): any[] {
  const out: any[] = [];
  for (const line of session.lines) {
    try {
      const msg = JSON.parse(line);
      if (msg && msg.id !== undefined && msg.method === undefined) out.push(msg);
    } catch { /* not JSON — a test asserts on that separately */ }
  }
  return out;
}

/**
 * What one test file starts, so afterEach can end all of it: sessions, the shared servers they may have
 * started (found by marker), and temp dirs.
 */
export function createRig(): {
  sessions: StdioSession[];
  dirs: string[];
  /** A fresh short temp dir, removed at cleanup. */
  tmp(prefix?: string): string;
  /** Start a session (a relay, or a wrapper in front of one) that cleanup ends. */
  session(entry: string, env: Record<string, string>, cwd: string): StdioSession;
  /** The shared server `env` may use — whatever answers to its marker is ended at cleanup. */
  watch(env: Record<string, string>, entry?: string, version?: string): ReturnType<typeof expectedServer>;
  cleanup(): Promise<void>;
} {
  const sessions: StdioSession[] = [];
  const markers = new Set<string>();
  const dirs: string[] = [];
  return {
    sessions,
    dirs,
    tmp(prefix) {
      const dir = shortTmpDir(prefix);
      dirs.push(dir);
      return dir;
    },
    session(entry, env, cwd) {
      const s = new StdioSession(entry, { cwd, env });
      sessions.push(s);
      return s;
    },
    watch(env, entry, version) {
      const server = expectedServer(env, entry, version);
      markers.add(server.marker);
      return server;
    },
    async cleanup() {
      await cleanup({ sessions: sessions.splice(0), markers: [...markers], dirs: dirs.splice(0) });
      markers.clear();
    },
  };
}

/**
 * Everything a test started, ended in one place: sessions are killed, the shared servers of the given
 * markers are killed, the directories are removed.
 */
export async function cleanup(o: { sessions?: StdioSession[]; markers?: string[]; dirs?: string[] }): Promise<void> {
  for (const s of o.sessions ?? []) s.kill();
  const pids = (o.markers ?? []).flatMap((m) => serverPids(m));
  await killAll(pids);
  for (const dir of o.dirs ?? []) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * A throwaway copy of the plugin as it is installed: dist/ (copied, so a test can break or change it),
 * package.json (copied, so a test can change the version), cli/ with the wrapper, and node_modules (linked).
 */
export function makePluginRoot(o: { wrapper?: string } = {}): { root: string; entry: string; wrapper: string; serverFile: string; packageJson: string } {
  const root = shortTmpDir('mbr-');
  fs.cpSync(path.join(REPO, 'dist'), path.join(root, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(root, 'package.json'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, 'cli'));
  fs.copyFileSync(o.wrapper ?? WRAPPER, path.join(root, 'cli', 'mcp-server-wrapper.js'));
  return {
    root,
    entry: path.join(root, 'dist', 'mcp-server.js'),
    wrapper: path.join(root, 'cli', 'mcp-server-wrapper.js'),
    serverFile: path.join(root, 'dist', 'shared-server.js'),
    packageJson: path.join(root, 'package.json'),
  };
}

export function setPackageVersion(packageJson: string, version: string): void {
  const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8')) as Record<string, unknown>;
  pkg.version = version;
  // replaced in one step, the way an update writes it — a reader never sees half a file
  fs.writeFileSync(`${packageJson}.tmp`, JSON.stringify(pkg, null, 2));
  fs.renameSync(`${packageJson}.tmp`, packageJson);
}

export function serverLog(indexDir: string): string {
  try { return fs.readFileSync(path.join(indexDir, 'logs', 'shared-server.log'), 'utf8'); } catch { return ''; }
}
