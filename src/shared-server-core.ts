import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { sessionContext, validSessionCwd, validSessionLocale, type SessionContext } from './session-context.js';
import { sharedPidPath, validChildEnv } from './shared-identity.js';
import { CONTROL_PREFIX, type HelloError, type HelloReply } from './shared-protocol.js';
import { SocketTransport } from './socket-transport.js';
import { nameExists, probeSocket, removeIfDead, socketIdentity } from './unix-socket.js';
import { LineSplitter } from './wrapper-core.js';

/**
 * The shared MCP server: one process serving every session that has the same identity.
 *
 *   session ─ wrapper ─ relay ──┐
 *   session ─ wrapper ─ relay ──┼── unix socket ── this process (database, embedding model, tools)
 *   session ─ wrapper ─ relay ──┘
 *
 * What keeps sessions apart:
 *  - A connection's first line (the hello) declares the session's working directory and the identity it
 *    expects. A hello that is malformed, names another identity, or has no usable working directory is
 *    refused before any tool can be reached.
 *  - Every accepted connection gets an MCP server instance of its own, made for that working directory.
 *    Nothing here or below reads this process's working directory (test/server-scope-guard.test.ts).
 *
 * Lifecycle (this plugin has an orphan-flood history, so it is spelled out):
 *  - One server per name. A second one that finds the name served answers 'name-taken' and goes away.
 *  - It ends when no session has been connected for `idleMs`. Prompt-injection requests do not count: a
 *    server no session uses must not live on because hooks keep finding its inject socket.
 *  - Every `tickMs` it looks at itself: its socket name gone or taken by another file, the plugin version on
 *    disk changed, or the compiled code changed → it retires — serves the sessions it has, and ends shortly
 *    after the last one leaves.
 *  - A server whose name was taken never closes its listener: libuv unlinks a socket BY NAME on close, which
 *    would delete the successor's socket. It just exits.
 */

/** Check a connection's first line. The session context it declares, or why it is refused. */
export function readHello(line: string, own: { identity: string; version: string }): { ctx: SessionContext } | { error: HelloError } {
  let hello: unknown;
  try {
    hello = JSON.parse(line);
  } catch {
    return { error: 'bad-hello' };
  }
  if (typeof hello !== 'object' || hello === null || Array.isArray(hello)) return { error: 'bad-hello' };
  const h = hello as Record<string, unknown>;
  if (h.mb_relay !== 1 || typeof h.identity !== 'string' || typeof h.version !== 'string') return { error: 'bad-hello' };
  if (h.identity !== own.identity || h.version !== own.version) return { error: 'identity-mismatch' };
  // `cwd` must be stated: an absolute path, or an explicit null. A hello without it is not "no project".
  if (!('cwd' in h) || (h.cwd !== null && !validSessionCwd(h.cwd))) return { error: 'bad-cwd' };
  // So must what else is the session's alone. A hello without them is not "use the server's": the server
  // has no account, model setting or locale of its own to lend.
  if (!validChildEnv(h.env)) return { error: 'bad-env' };
  if (!('locale' in h) || (h.locale !== null && !validSessionLocale(h.locale))) return { error: 'bad-env' };
  return { ctx: sessionContext(h.cwd, { childEnv: h.env, ...(h.locale === null ? {} : { locale: h.locale as string }) }) };
}

export interface SharedServerOptions {
  socketPath: string;
  identity: string;
  version: string;
  /** Makes the MCP server of one session. Passed in so this module stays free of the heavy imports. */
  createServer: (ctx: SessionContext) => Server;
  /** No connected session for this long → the server ends. */
  idleMs: number;
  /** How often the server checks its own name and the code on disk. */
  tickMs: number;
  /** A retired server waits this long after its last session left (a relay may be mid-reconnect). */
  retireGraceMs?: number;
  /** A connection must send its hello within this time. */
  helloTimeoutMs?: number;
  /** How long to wait for a socket file nobody answers on to be confirmed dead before giving the name up. */
  bindWaitMs?: number;
  /** Why this server should stop taking new sessions, or null. Read every tick. */
  staleReason?: () => string | null;
  /** Runs once the server has stopped serving for good. `listenerClosed: false` = the caller must exit without closing. */
  onStop: (info: { reason: string; listenerClosed: boolean }) => void | Promise<void>;
  log?: (line: string) => void;
}

export interface SharedServerHandle {
  readonly socketPath: string;
  /** Sessions connected right now (connections whose hello was accepted). */
  connections(): number;
  /** Why the server is retiring, or null. */
  retiring(): string | null;
  /** Stop now: sessions are disconnected, the listener is closed (its file removed when it is still ours). */
  close(): Promise<void>;
}

export type StartResult =
  | { kind: 'serving'; handle: SharedServerHandle }
  | { kind: 'name-taken' }
  | { kind: 'retry'; why: string };

/**
 * The first line of a connection may be this long. A hello is a few hundred bytes plus the session's child
 * environment, which is capped at 32 KB (shared-identity.ts CHILD_ENV_MAX_TOTAL_BYTES) and measured at 1.3 KB
 * at most on a machine with 20 sessions: 64 KB holds the largest hello a relay can send (that cap, a 4 KB
 * working directory, a few hundred bytes of the rest) with room to spare.
 */
const HELLO_MAX_BYTES = 64 * 1024;
/**
 * A dead socket file younger than this may be a server between bind() and listen(). Node does both in one
 * call, so the gap is normally too short to see; two seconds allows for a process held up in between on a
 * loaded machine, and is the wait a start right after a crash pays once (measured: about 3 s from a killed
 * server to its replacement answering).
 */
const OWN_SOCKET_MIN_AGE_MS = 2_000;

function listenOnce(server: net.Server, socketPath: string): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException) => { server.off('listening', onListening); resolve(err); };
    const onListening = () => { server.off('error', onError); resolve(null); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

/**
 * Bind `socketPath`, or say who has it. Never removes a file somebody answers on.
 *
 * A file nobody answers on is either a killed server's leftover or a server about to listen. The two cannot
 * be told apart while the file is fresh, so this waits (up to `waitMs`) until removeIfDead may judge it — a
 * session whose server was killed moments after it started gets its replacement from this one start, not
 * from a run of starts that each give up.
 */
async function bind(server: net.Server, socketPath: string, waitMs: number): Promise<'bound' | 'name-taken' | { retry: string }> {
  const until = Date.now() + waitMs;
  const pause = () => new Promise<void>((resolve) => { setTimeout(resolve, 250); });
  for (;;) {
    // Something that is not a socket sits on the name (a plain file, a symlink): never bound through — bind()
    // follows a dangling symlink and would create the socket wherever it points — and never removed.
    if (nameExists(socketPath) && socketIdentity(socketPath) === null) {
      if (Date.now() > until) return { retry: 'the socket name is taken by something that is not a socket' };
      await pause();
      continue;
    }
    if ((await probeSocket(socketPath)) === 'alive') return 'name-taken';
    const err = await listenOnce(server, socketPath);
    if (err === null) return 'bound';
    if (err.code !== 'EADDRINUSE') return { retry: `listen failed: ${err.code ?? err.message}` };
    if ((await probeSocket(socketPath)) === 'alive') return 'name-taken';
    if (await removeIfDead(socketPath, OWN_SOCKET_MIN_AGE_MS)) continue; // a dead server's leftover — gone now
    if (!nameExists(socketPath)) continue;                                // whoever had it left
    if (Date.now() > until) return { retry: 'the socket name is held by a socket file that cannot be confirmed dead' };
    await pause();
  }
}

function writePidFile(socketPath: string): void {
  const file = sharedPidPath(socketPath);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${process.pid}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function removeOwnPidFile(socketPath: string): void {
  const file = sharedPidPath(socketPath);
  try {
    if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
  } catch { /* not there, or not ours */ }
}

/**
 * Start serving on `socketPath`. Resolves once the server is reachable ('serving'), or with the reason it is
 * not: another live server has the name ('name-taken'), or the name could not be had right now ('retry').
 */
export async function startSharedServer(o: SharedServerOptions): Promise<StartResult> {
  const log = o.log ?? (() => {});
  // A retired server stays for a session that is between two connections. A relay connects again the moment
  // it loses one, so this only has to outlast a relay that was held up for a moment: 5 s.
  const retireGraceMs = o.retireGraceMs ?? 5_000;
  // A relay writes its hello the moment it connects. 10 s is not a slow relay, it is a connection that will
  // never say hello — the same line the wrapper draws for a child that never came up.
  const helloTimeoutMs = o.helloTimeoutMs ?? 10_000;

  const listener = net.createServer();
  // Long enough to outwait OWN_SOCKET_MIN_AGE_MS and the confirmation that a socket file is dead more than
  // once, and no longer than the 8 s after which the relay that started this process is no longer "just
  // started" and would stop exiting for its wrapper.
  const bound = await bind(listener, o.socketPath, o.bindWaitMs ?? 8_000);
  if (bound === 'name-taken') return { kind: 'name-taken' };
  if (bound !== 'bound') return { kind: 'retry', why: bound.retry };

  try { fs.chmodSync(o.socketPath, 0o600); } catch { /* best-effort — the index dir is owner-only */ }
  const id = socketIdentity(o.socketPath);
  const own = id ? { ino: id.ino, ctimeMs: id.ctimeMs } : null;
  try { writePidFile(o.socketPath); } catch (err) { log(`pid file not written: ${(err as Error).message}`); }

  /** Sockets that have not said hello yet. */
  const greeting = new Set<net.Socket>();
  /** Accepted sessions. */
  const sessions = new Map<net.Socket, { transport: SocketTransport; mcp: Server }>();
  let retiring: string | null = null;
  /** Why the server stopped taking sessions — null while it still takes them. */
  let stopReason: string | null = null;
  let listenerClosed = false;
  let finished = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let graceTimer: NodeJS.Timeout | null = null;
  let resolveFinished!: () => void;
  const whenFinished = new Promise<void>((resolve) => { resolveFinished = resolve; });

  const ownsName = (): boolean => {
    if (!own) return false;
    const now = socketIdentity(o.socketPath);
    return now !== null && now.ino === own.ino && now.ctimeMs === own.ctimeMs;
  };

  const finish = async (reason: string): Promise<void> => {
    if (finished) return;
    finished = true;
    clearInterval(tick);
    if (idleTimer) clearTimeout(idleTimer);
    if (graceTimer) clearTimeout(graceTimer);
    removeOwnPidFile(o.socketPath);
    log(`stopped: ${reason}`);
    try {
      await o.onStop({ reason, listenerClosed });
    } finally {
      resolveFinished();
    }
  };

  /** Stop taking sessions. The server ends when the ones it has are gone. */
  const stop = (reason: string): void => {
    if (stopReason !== null) return;
    stopReason = reason;
    if (ownsName()) {
      // Closing unlinks the socket by name — ours. New sessions now start a new server.
      listener.close();
      listenerClosed = true;
    }
    else {
      // The name belongs to a successor. Do not close — the process exits with the listener open.
      listener.unref();
    }
    maybeFinish();
  };

  /**
   * A stopped server ends once nobody is connected. A relay that connected just before the listener closed is
   * still served: its hello is accepted and the server waits for that session too.
   */
  const maybeFinish = (): void => {
    if (stopReason !== null && sessions.size === 0 && greeting.size === 0) void finish(stopReason);
  };

  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = null;
    if (stopReason !== null || sessions.size > 0) return;
    if (retiring !== null) {
      graceTimer = setTimeout(() => { if (sessions.size === 0) stop(`retired (${retiring})`); }, retireGraceMs);
      return;
    }
    idleTimer = setTimeout(() => { if (sessions.size === 0) stop('idle'); }, o.idleMs);
  };

  const tick = setInterval(() => {
    if (stopReason !== null || retiring !== null) return;
    const why = !ownsName() ? 'socket name lost' : (o.staleReason?.() ?? null);
    if (why === null) return;
    retiring = why;
    log(`retiring: ${why} — ${sessions.size} session(s) still connected`);
    armIdle();
  }, o.tickMs);

  listener.on('connection', (socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => { /* the peer vanished — handled by 'close' */ });
    greeting.add(socket);
    const splitter = new LineSplitter();
    let helloBytes = 0;
    const helloTimer = setTimeout(() => socket.destroy(), helloTimeoutMs);

    const refuse = (error: HelloError): void => {
      const reply: HelloReply = { mb_relay: 1, ok: false, error };
      socket.end(JSON.stringify(reply) + '\n');
      // Whatever else this connection sends is dropped: it never reaches a tool.
      socket.removeAllListeners('data');
      socket.resume();
    };

    socket.on('data', (chunk: string) => {
      const session = sessions.get(socket);
      if (!session && greeting.has(socket)) {
        helloBytes += Buffer.byteLength(chunk);
        const lines = splitter.push(chunk);
        if (lines.length === 0) {
          if (helloBytes > HELLO_MAX_BYTES) refuse('bad-hello');
          return;
        }
        clearTimeout(helloTimer);
        const [first, ...rest] = lines;
        const hello = Buffer.byteLength(first) > HELLO_MAX_BYTES ? { error: 'bad-hello' as const } : readHello(first, o);
        if ('error' in hello) {
          refuse(hello.error);
          return;
        }
        let mcp: Server;
        try {
          mcp = o.createServer(hello.ctx);
        } catch (err) {
          log(`could not make a server for a session: ${(err as Error).message}`);
          refuse('bad-hello');
          return;
        }
        const transport = new SocketTransport(socket);
        greeting.delete(socket);
        sessions.set(socket, { transport, mcp });
        armIdle();
        const reply: HelloReply = { mb_relay: 1, ok: true, pid: process.pid, version: o.version };
        socket.write(JSON.stringify(reply) + '\n');
        void mcp.connect(transport).catch((err: unknown) => {
          log(`session connect failed: ${(err as Error).message}`);
          socket.destroy();
        });
        for (const line of rest) route(transport, line);
        return;
      }
      if (session) for (const line of splitter.push(chunk)) route(session.transport, line);
    });

    const route = (transport: SocketTransport, line: string): void => {
      // Control lines of the relay protocol never reach MCP.
      if (line.startsWith(CONTROL_PREFIX)) {
        try {
          const control = JSON.parse(line) as { ping?: unknown };
          if (typeof control.ping === 'number') socket.write(JSON.stringify({ mb_relay: 1, pong: control.ping }) + '\n');
        } catch { /* not a control line after all — drop it */ }
        return;
      }
      transport.receive(line);
    };

    socket.on('close', () => {
      clearTimeout(helloTimer);
      greeting.delete(socket);
      const session = sessions.get(socket);
      if (session) {
        sessions.delete(socket);
        session.transport.peerClosed();
        void session.mcp.close().catch(() => { /* already closed */ });
      }
      if (stopReason !== null) maybeFinish();
      else armIdle();
    });
  });

  armIdle();
  log(`serving ${path.basename(o.socketPath)}`);

  return {
    kind: 'serving',
    handle: {
      socketPath: o.socketPath,
      connections: () => sessions.size,
      retiring: () => retiring,
      close: async () => {
        if (!listenerClosed && !finished) {
          if (ownsName()) {
            listener.close();
            listenerClosed = true;
          } else {
            // The name is a successor's: closing would unlink ITS socket. Let go of the handle instead.
            listener.unref();
          }
        }
        stopReason ??= 'closed';
        for (const socket of [...greeting, ...sessions.keys()]) socket.destroy();
        maybeFinish();
        await whenFinished;
      },
    },
  };
}
