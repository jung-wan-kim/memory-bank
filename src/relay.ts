import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { sharedLockPath, sharedPidPath, sharedServerArg, spawnEnvFor } from './shared-identity.js';
import type { SharedMode } from './shared-mode.js';
import { CONTROL_PREFIX, EXIT_NAME_TAKEN, EXIT_RETRY, positiveMs, type HelloReply, type RelayHello } from './shared-protocol.js';
import { probeSocket } from './unix-socket.js';
import { LineSplitter, SupervisorState, abortedRequestError, isInitializeResponse } from './wrapper-core.js';

/**
 * The relay: what a session runs instead of a whole MCP server.
 *
 *   client (stdio) ⇄ wrapper ⇄ relay (this) ⇄ unix socket ⇄ shared server
 *
 * It passes MCP lines both ways and owns nothing else — no database, no embedding model. What it adds:
 *  - It declares the session to the server (the hello: identity, version, this process's working directory)
 *    and refuses to pass a single client line before the server accepted that.
 *  - When no server answers it starts one (detached, with the allow-list environment), under a lock so a
 *    burst of sessions starts one server, not many.
 *  - When the server goes away it reconnects, starting a new one if need be, and replays the MCP handshake it
 *    recorded — the client never notices. Calls that were in flight are answered with an error.
 *  - It never becomes a server itself. If a server cannot be started, a relay that has just begun exits
 *    non-zero (its wrapper then repairs the install and tries again); one that has been serving a session
 *    stays, answers every call with an error that says why, and keeps trying.
 *
 * The wrapper above it is unchanged: it restarts this process when the plugin version on disk changes, and
 * the new process works out the new version's server on its own. So this code never has to reason about a
 * version other than its own.
 */

type Shared = Extract<SharedMode, { kind: 'shared' }>;

/** Relay timings — every one can be shortened through the environment (tests do). */
interface Timings {
  /** A relay younger than this that cannot get a server exits, so its wrapper repairs the install. */
  youngMs: number;
  /** How long a server may take to answer the hello before it counts as unresponsive. */
  helloMs: number;
  /** How long a server this relay started may take to answer on its socket. */
  startWaitMs: number;
  /** A call unanswered this long gets a ping; a ping unanswered this long means the server is stuck. */
  pingAfterMs: number;
}

function timings(env: NodeJS.ProcessEnv): Timings {
  return {
    // The wrapper counts a child that dies within 10s as a start-up failure; 8s leaves it room to see that.
    youngMs: positiveMs(env.MEMORY_BANK_RELAY_YOUNG_MS, 8_000),
    helloMs: positiveMs(env.MEMORY_BANK_RELAY_HELLO_MS, 10_000),
    startWaitMs: positiveMs(env.MEMORY_BANK_RELAY_START_WAIT_MS, 30_000),
    pingAfterMs: positiveMs(env.MEMORY_BANK_RELAY_PING_AFTER_MS, 30_000),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** JSON-RPC error for a call that could not be passed on because no server is available. */
function unavailableError(id: string | number, why: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32003, message: `memory-bank: the shared server is not available (${why}) — the call was not run; retry shortly` },
  });
}

type Attempt =
  | { kind: 'connected'; socket: net.Socket; splitter: LineSplitter; rest: string[]; serverPid: number }
  | { kind: 'absent' }                  // no socket file
  | { kind: 'refused' }                 // a file nobody accepts on: a dead server's leftover, or a listener too busy
  | { kind: 'silent' }                  // connected, but no answer to the hello in time
  | { kind: 'rejected'; error: string } // the server answered the hello with ok:false
  | { kind: 'error'; why: string };

/** One connect + hello. Nothing of the client's is sent on this connection before the server said ok. */
function attemptConnection(mode: Shared, cwd: string | null, helloMs: number): Promise<Attempt> {
  return new Promise((resolve) => {
    const socket = net.connect(mode.socketPath);
    const splitter = new LineSplitter();
    let settled = false;
    const finish = (result: Attempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners('data');
      socket.removeAllListeners('close');
      if (result.kind !== 'connected') socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: 'silent' }), helloMs);
    socket.setEncoding('utf8');
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') finish({ kind: 'absent' });
      else if (err.code === 'ECONNREFUSED') finish({ kind: 'refused' });
      else finish({ kind: 'error', why: err.code ?? err.message });
    });
    socket.on('connect', () => {
      const hello: RelayHello = { mb_relay: 1, identity: mode.identity, version: mode.version, cwd, pid: process.pid };
      socket.write(JSON.stringify(hello) + '\n');
    });
    socket.on('close', () => finish({ kind: 'error', why: 'closed before answering the hello' }));
    socket.on('data', (chunk: string) => {
      const lines = splitter.push(chunk);
      if (lines.length === 0) return;
      const [first, ...rest] = lines;
      let reply: HelloReply | null = null;
      try {
        const parsed = JSON.parse(first) as HelloReply;
        if (parsed && parsed.mb_relay === 1 && typeof parsed.ok === 'boolean') reply = parsed;
      } catch { /* not a hello reply */ }
      if (reply === null) finish({ kind: 'error', why: 'the listener on the socket is not a memory-bank shared server' });
      else if (!reply.ok) finish({ kind: 'rejected', error: reply.error });
      else finish({ kind: 'connected', socket, splitter, rest, serverPid: reply.pid });
    });
  });
}

/**
 * Take the start lock (a file created exclusively). Returns the function that gives it back, or null when
 * another relay holds it. A lock whose holder is gone, or that is older than any start can take, is replaced.
 * The lock only keeps a burst of relays from each starting a server — the socket bind decides who serves.
 */
function acquireStartLock(lockPath: string, maxAgeMs: number): (() => void) | null {
  for (let round = 0; round < 2; round++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          if (fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lockPath);
        } catch { /* already gone */ }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      const holder = Number(fs.readFileSync(lockPath, 'utf8').trim());
      const holderAlive = Number.isInteger(holder) && holder > 1 && isAlive(holder);
      // A file with no live holder gets a second: it may have been created this instant, pid not yet written.
      const stale = holderAlive ? age > maxAgeMs : age > 1_000;
      if (!stale) return null;
      fs.unlinkSync(lockPath);
    } catch { /* the lock went away while we looked — try to take it */ }
  }
  return null;
}

const LOG_MAX_BYTES = 1024 * 1024;

/** Start the shared server: detached, in the index dir, with the allow-list environment, stderr to its log. */
function spawnServer(mode: Shared): ChildProcess {
  const logDir = path.join(mode.indexDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(logDir, 'shared-server.log');
  try {
    if (fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, `${logFile}.old`);
  } catch { /* no log yet */ }
  const fd = fs.openSync(logFile, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [mode.serverEntry, sharedServerArg(mode.identity)], {
      // Never the session's directory: the server must not have a working directory that means anything.
      cwd: mode.indexDir,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: spawnEnvFor(process.env, mode.serverEnv),
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * End a server that does not answer. Only a process whose command line shows it is this identity's shared
 * server is signalled — a pid read from a file may have been reused by anything.
 */
async function endUnresponsiveServer(mode: Shared, pid: number | null): Promise<boolean> {
  if (pid === null || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 });
  const command = ps.status === 0 ? String(ps.stdout) : '';
  if (!command.includes('shared-server.js') || !command.includes(sharedServerArg(mode.identity))) return false;
  console.error(`[memory-bank relay] shared server ${pid} does not answer — ending it`);
  try { process.kill(pid, 'SIGTERM'); } catch { return true; }
  for (let waited = 0; waited < 2_000 && isAlive(pid); waited += 50) await sleep(50);
  if (isAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    for (let waited = 0; waited < 1_000 && isAlive(pid); waited += 50) await sleep(50);
  }
  return true;
}

function pidFromFile(socketPath: string): number | null {
  try {
    const n = Number(fs.readFileSync(sharedPidPath(socketPath), 'utf8').trim());
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

type StartOutcome =
  | { kind: 'answering' }           // a server answers on the socket now (ours, or one that got there first)
  | { kind: 'again' }               // nothing to conclude — look at the socket again
  | { kind: 'later'; why: string }  // the name cannot be had right now
  | { kind: 'failed'; why: string };

/** Start a server and wait until it answers on the socket, or until it is clear that it will not. */
async function startServer(mode: Shared, t: Timings): Promise<StartOutcome> {
  try {
    fs.mkdirSync(mode.indexDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return { kind: 'failed', why: `the index dir cannot be created: ${(err as Error).message}` };
  }
  const release = acquireStartLock(sharedLockPath(mode.socketPath), t.startWaitMs + 15_000);
  if (release === null) {
    await sleep(150); // another relay is starting it
    return { kind: 'again' };
  }
  try {
    if ((await probeSocket(mode.socketPath)) === 'alive') return { kind: 'answering' };
    let child: ChildProcess;
    try {
      child = spawnServer(mode);
    } catch (err) {
      return { kind: 'failed', why: `the server process cannot be started: ${(err as Error).message}` };
    }
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let spawnError: Error | null = null;
    child.once('exit', (code, signal) => { exit = { code, signal }; });
    child.once('error', (err) => { spawnError = err; });
    const until = Date.now() + t.startWaitMs;
    for (;;) {
      if ((await probeSocket(mode.socketPath)) === 'alive') return { kind: 'answering' };
      if (spawnError !== null) return { kind: 'failed', why: `the server process cannot be started: ${(spawnError as Error).message}` };
      const ended = exit as { code: number | null; signal: NodeJS.Signals | null } | null;
      if (ended !== null) {
        if (ended.code === EXIT_NAME_TAKEN) return { kind: 'again' };
        if (ended.code === EXIT_RETRY) return { kind: 'later', why: 'the socket name is held by something that is not a live server' };
        // Any other end before the socket answers — code 0 included — is a server that did not start.
        return { kind: 'failed', why: `the server exited during start-up (${ended.signal ?? `code ${ended.code}`})` };
      }
      if (Date.now() > until) {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        return { kind: 'failed', why: `the server did not answer within ${t.startWaitMs}ms of being started` };
      }
      await sleep(50);
    }
  } finally {
    release();
  }
}

/** Run as the relay of one session until its client goes away. Never returns a server of its own. */
export function runRelay(mode: Shared, cwd: string | null): void {
  const t = timings(process.env);
  const logPath = path.join(mode.indexDir, 'logs', 'shared-server.log');
  const state = new SupervisorState();
  const clientSplit = new LineSplitter();
  /** Client lines not yet passed to a server. */
  const pending: string[] = [];

  let link: { socket: net.Socket; serverPid: number } | null = null;
  /** down: no server · connecting: getting one · replaying: re-running the recorded handshake · up: passing lines */
  let phase: 'down' | 'connecting' | 'replaying' | 'up' = 'down';
  /** The client's handshake was answered by a server that is gone: the next one gets it replayed. */
  let needReplay = false;
  let failures = 0;
  let lastAttemptAt = 0;
  let retryTimer: NodeJS.Timeout | null = null;
  let quietSince = 0;
  let pingSentAt: number | null = null;
  let pingSeq = 0;
  let ending = false;

  /** MEMORY_BANK_RELAY_DEBUG=1: one stderr line per connection event (tests wait on these). */
  const debug = process.env.MEMORY_BANK_RELAY_DEBUG === '1'
    ? (message: string): void => { console.error(`[memory-bank relay] ${message}`); }
    : (): void => {};

  const toClient = (line: string): void => { process.stdout.write(line + '\n'); };
  const toServer = (line: string): void => {
    if (link === null) return;
    link.socket.write(line + '\n');
  };

  const flushPending = (): void => {
    // The silence the watchdog measures starts now, not when these lines were queued.
    quietSince = Date.now();
    for (const line of pending.splice(0)) toServer(line);
  };

  /** No server: answer the calls that are waiting. The handshake is kept — it is replayed once a server is back. */
  const failPending = (why: string): void => {
    const keep: string[] = [];
    for (const line of pending.splice(0)) {
      let msg: { id?: string | number; method?: string } | null = null;
      try { msg = JSON.parse(line) as { id?: string | number; method?: string }; } catch { /* not ours to answer */ }
      if (msg && (msg.method === 'initialize' || msg.method === 'notifications/initialized')) keep.push(line);
      else if (msg && msg.id !== undefined && msg.method !== undefined) {
        const error = unavailableError(msg.id, `${why}; log: ${logPath}`);
        state.onServerLine(error);
        toClient(error);
      }
      // other notifications have nobody to go to
    }
    pending.push(...keep);
  };

  const onServerLine = (line: string): void => {
    if (line === '') return;
    quietSince = Date.now();
    if (line.startsWith(CONTROL_PREFIX)) {
      pingSentAt = null; // any control line from the server shows it is running
      return;
    }
    if (phase === 'replaying') {
      // The private re-run of the handshake: the client already has this answer.
      if (state.initializeLine !== null && isInitializeResponse(line, state.initializeLine)) {
        if (state.initializedLine !== null) {
          const initialized = state.initializedLine;
          toServer(initialized);
          for (let i = pending.length - 1; i >= 0; i--) if (pending[i] === initialized) pending.splice(i, 1);
        }
        phase = 'up';
        flushPending();
      }
      return;
    }
    state.onServerLine(line);
    toClient(line);
  };

  const onDisconnect = (): void => {
    if (ending) return;
    link = null;
    pingSentAt = null;
    const wasUp = phase === 'up' || phase === 'replaying';
    phase = 'down';
    if (wasUp) {
      const initAnswered = state.initializeAnswered();
      // Calls that were in flight died with the server.
      for (const id of state.outstandingRequestIds()) toClient(abortedRequestError(id));
      const initializeLine = state.initializeLine;
      state.resetOutstanding();
      if (initializeLine !== null) {
        if (initAnswered) needReplay = true;
        else {
          // The client is still waiting for this answer: the next server gets the request again.
          state.onClientLine(initializeLine);
          if (!pending.includes(initializeLine)) pending.unshift(initializeLine);
        }
      }
      console.error('[memory-bank relay] the shared server went away — reconnecting');
    }
    void connect();
  };

  const adopt = (a: Extract<Attempt, { kind: 'connected' }>): void => {
    link = { socket: a.socket, serverPid: a.serverPid };
    failures = 0;
    quietSince = Date.now();
    a.socket.on('data', (chunk: string) => { for (const line of a.splitter.push(chunk)) onServerLine(line); });
    a.socket.on('error', () => { /* 'close' follows */ });
    a.socket.on('close', onDisconnect);
    debug(`connected to shared server ${a.serverPid}${needReplay ? ' — replaying the handshake' : ''}`);
    if (needReplay && state.initializeLine !== null) {
      needReplay = false;
      phase = 'replaying';
      toServer(state.initializeLine);
    } else {
      needReplay = false;
      phase = 'up';
      flushPending();
    }
    for (const line of a.rest) onServerLine(line);
  };

  const giveUp = (why: string): void => {
    phase = 'down';
    failures++;
    if (process.uptime() * 1000 < t.youngMs) {
      // Just started and no server can be had: this is an install problem. Exit, so the wrapper repairs it.
      console.error(`[memory-bank relay] cannot start the shared server: ${why}. Log: ${logPath}. `
        + 'This session has no memory-bank tools until it starts; set MEMORY_BANK_SHARED_SERVER=0 to run a server per session instead.');
      process.exit(1);
    }
    console.error(`[memory-bank relay] no shared server (${why}) — calls are answered with an error until one starts. Log: ${logPath}`);
    failPending(why);
    // Keep trying on a timer for a while; after that only a client call starts an attempt.
    if (failures <= 10 && retryTimer === null) {
      retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, Math.min(30_000, 1_000 * 2 ** (failures - 1)));
      retryTimer.unref();
    }
  };

  async function connect(): Promise<void> {
    if (ending || phase !== 'down') return;
    phase = 'connecting';
    lastAttemptAt = Date.now();
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }

    let refused = 0;
    let silent = 0;
    let waitedMs = 0;
    for (;;) {
      if (ending) return;
      const a = await attemptConnection(mode, cwd, t.helloMs);
      if (ending) { if (a.kind === 'connected') a.socket.destroy(); return; }
      if (a.kind === 'connected') { adopt(a); return; }
      if (a.kind === 'rejected') {
        // Asking again gets the same answer: the server and this relay disagree about who may connect.
        console.error(`[memory-bank relay] the shared server refused this session (${a.error}). `
          + 'Set MEMORY_BANK_SHARED_SERVER=0 to run a server per session instead.');
        process.exit(1);
      }
      if (a.kind === 'silent') {
        if (++silent > 2) { giveUp('a process holds the socket but does not answer'); return; }
        const ended = await endUnresponsiveServer(mode, pidFromFile(mode.socketPath));
        if (!ended) { giveUp('a process that is not a memory-bank shared server holds the socket'); return; }
        continue;
      }
      if (a.kind === 'refused' && ++refused < 3) { await sleep(100); continue; } // busy for a moment, maybe
      if (a.kind === 'error' && ++refused < 3) { await sleep(100); continue; }

      const started = await startServer(mode, t);
      if (ending) return;
      if (started.kind === 'failed') { giveUp(started.why); return; }
      if (started.kind === 'later') {
        const pause = Math.min(2_000, 250 * 2 ** Math.min(3, Math.floor(waitedMs / 500)));
        waitedMs += pause;
        if (waitedMs > t.startWaitMs) { giveUp(started.why); return; }
        await sleep(pause);
      } else if (started.kind === 'again') {
        waitedMs += 150;
        if (waitedMs > t.startWaitMs * 2) { giveUp('no server came up on the socket'); return; }
      }
      refused = 0;
    }
  }

  // A server stuck in a loop still accepts and holds the connection: only silence shows it.
  const watchdog = setInterval(() => {
    if (phase !== 'up' || link === null || state.idle()) { pingSentAt = null; return; }
    const now = Date.now();
    if (pingSentAt === null) {
      if (now - quietSince < t.pingAfterMs) return;
      pingSentAt = now;
      link.socket.write(JSON.stringify({ mb_relay: 1, ping: ++pingSeq }) + '\n');
      debug(`ping ${pingSeq} — no answer for ${now - quietSince}ms`);
      return;
    }
    if (now - pingSentAt < t.pingAfterMs) return;
    const stuck = link;
    pingSentAt = null;
    void endUnresponsiveServer(mode, stuck.serverPid).then(() => stuck.socket.destroy());
  }, Math.max(250, Math.min(5_000, t.pingAfterMs / 4)));
  watchdog.unref();

  const end = (code: number): void => {
    if (ending) return;
    ending = true;
    link?.socket.destroy();
    process.exit(code);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const line of clientSplit.push(chunk)) {
      if (line === '') continue;
      // A server that had nothing to answer is not "silent": the watchdog's clock starts with this line.
      // (Read before the line is recorded — afterwards the session is no longer idle.)
      if (state.idle()) quietSince = Date.now();
      state.onClientLine(line);
      if (phase === 'up') { toServer(line); continue; }
      pending.push(line);
      if (phase === 'down') {
        // No timer is running any more (too many failures): a call starts an attempt, at most every 30s.
        if (retryTimer === null && Date.now() - lastAttemptAt >= 30_000) void connect();
        else if (retryTimer === null) failPending('the last attempt to start it failed moments ago');
      }
    }
  });
  process.stdin.on('end', () => end(0));
  process.stdout.on('error', () => end(0)); // the client is gone
  process.on('SIGTERM', () => end(0));
  process.on('SIGINT', () => end(0));

  void connect();
}
