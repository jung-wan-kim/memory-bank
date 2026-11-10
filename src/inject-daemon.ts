import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { getIndexDir } from './paths.js';
import { computeInjectResult } from './inject-core.js';
import { initEmbeddings, embeddingsReady } from './embeddings.js';
import { injectionQuery } from './prompt-gate.js';
import { injectSocketPathIn, ownPackageVersion, MAX_UNIX_SOCKET_PATH_BYTES } from './version-guard.js';

/**
 * Warm inject daemon — a unix-socket sidecar inside the long-lived MCP server.
 *
 * Why: the UserPromptSubmit hook pays ~2.3s PER PROMPT as a cold node process
 * (measured: model load 1,130ms + node startup ~400ms + imports 186ms dominate;
 * the actual search is ~30ms). Every Claude session already runs an MCP server
 * with the embedding model warm — this sidecar lets the hook reuse it: the hook
 * connects, sends the prompt, and gets the context back in ~150ms warm.
 *
 * Lifecycle safety (this plugin's orphan-flood history makes this explicit):
 *  - The daemon lives INSIDE the MCP server process — no new detached process,
 *    no new lifecycle to leak. server.unref() so it never keeps the process
 *    alive on its own; it dies exactly when the MCP server dies.
 *  - Only ONE server binds the socket. EADDRINUSE → probe the existing socket:
 *    alive → this server doesn't serve (another session's MCP server does);
 *    dead (stale file after SIGKILL) → unlink and bind.
 *  - A server that does not hold the socket asks again every RECLAIM_MS: when
 *    the owner's session ends, one of the servers still running takes over.
 *    (It used to try once, at start-up — after the owner left, nobody served
 *    until a new session started, however many servers were still alive, and
 *    every prompt took the cold path meanwhile; measured 2026-11-10.)
 *  - One socket per plugin version (injectSocketPathIn): a hook client only
 *    ever reaches a daemon running its own code. A LIVE socket of another
 *    version is never touched; a dead one (no listener, not just created) is
 *    removed by whoever takes its own socket — nothing else ever cleaned up
 *    what a killed server left behind (7 dead files of 8, measured).
 *  - A socket file is removed only when nobody answers on it AND it is not
 *    fresh AND it is still the file that was probed. A server between bind()
 *    and listen() refuses connections exactly like a dead one, and another
 *    server may have replaced a dead file a moment ago: unlinking either
 *    leaves a server listening on a name nobody can reach, which then deletes
 *    the next owner's file when it closes (libuv unlinks by name).
 *  - The owner checks that its file is still there: when the name is gone it
 *    binds again (an unreachable owner would otherwise look fine forever).
 *  - No daemon when the socket path does not fit a unix socket (a deep config
 *    dir): Node would bind the first 104 bytes of it — a name the clients do
 *    not look at, shared with every other config dir of the same prefix. One
 *    line on stderr says so; the hook clients compute the block themselves.
 *  - A failed bind is re-tried at once only once, and only for a reason seen on
 *    disk (a dead file removed, or the name gone); everything else waits for
 *    the timer. A re-try loop without a pause runs on nextTick and microtasks
 *    alone: the event loop never reaches stdin and the MCP server stops
 *    answering (v1.8.0 review: `initialize` unanswered, one CPU core held).
 *  - Socket mode 600 — same-user only; the payload is the user's own prompt.
 *  - Requests are line-delimited JSON; a malformed request gets {ok:false} and
 *    never throws into the MCP server.
 *  - While the model is still loading the daemon first writes {"warming":true},
 *    so the client keeps waiting instead of loading a second copy cold.
 *  - The reply carries the ledger keys; the client commits them only once it has
 *    actually delivered the block (InjectResult in inject-core.ts).
 *  - The idle limit covers only the request line. Computing the reply may take
 *    longer (cold model load ~5s; the client waits up to 20s after warming),
 *    and the client owns that deadline — it closes the socket when it gives up.
 *    Holding the 10s idle limit through the computation cut off answers the
 *    waiting client was still entitled to.
 *  - A failed computation answers {ok:false}, never an empty success, so the
 *    client falls back instead of injecting nothing.
 */

/**
 * Idle limit before the request line is in, and again after the answer is
 * sent (a client that never closes its side must not pin the connection in
 * the MCP server). Tests shorten it through the environment; anything but a
 * positive finite number falls back to 10s — a negative value would make
 * socket.setTimeout throw inside the connection handler.
 */
export function requestIdleMs(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}
const REQUEST_IDLE_MS = requestIdleMs(process.env.MEMORY_BANK_INJECT_IDLE_MS);

/**
 * How often a server looks at the socket again — to take it over when it does
 * not hold it, to bind again when its own file is gone. Tests shorten it
 * through the environment; anything but a positive finite number is 45s.
 */
export function reclaimIntervalMs(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 45_000;
}
const RECLAIM_MS = reclaimIntervalMs(process.env.MEMORY_BANK_INJECT_RECLAIM_MS);

/** This version's socket: a dead file younger than this may be a server between bind() and listen(). */
const OWN_SOCKET_MIN_AGE_MS = 2_000;
/** Another version's socket: left alone for a minute after it appears, dead or not. */
const OTHER_SOCKET_MIN_AGE_MS = 60_000;
const PROBE_TIMEOUT_MS = 500;

/** inode + times of a socket file — "is this still the file I probed". null when absent or not a socket. */
function socketIdentity(p: string): { ino: number; ctimeMs: number; mtimeMs: number } | null {
  try {
    const st = fs.lstatSync(p);
    return st.isSocket() ? { ino: st.ino, ctimeMs: st.ctimeMs, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * Who is behind a socket path: 'alive' (a connect was accepted), 'dead'
 * (ECONNREFUSED — a file with no listener), 'absent' (no file), 'unknown'
 * (anything else, no answer in time included — never treated as dead).
 */
function probeSocket(p: string): Promise<'alive' | 'dead' | 'absent' | 'unknown'> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: 'alive' | 'dead' | 'absent' | 'unknown') => {
      if (settled) return;
      settled = true;
      probe.destroy();
      resolve(v);
    };
    const probe = net.connect(p);
    probe.setTimeout(PROBE_TIMEOUT_MS, () => done('unknown'));
    probe.on('connect', () => done('alive'));
    probe.on('error', (err: NodeJS.ErrnoException) => done(err.code === 'ECONNREFUSED' ? 'dead' : err.code === 'ENOENT' ? 'absent' : 'unknown'));
  });
}

/** The same file as `before`, old enough, and nobody answers: then (and only then) it may be unlinked. */
async function removeIfDead(p: string, minAgeMs: number): Promise<boolean> {
  const before = socketIdentity(p);
  if (!before || Date.now() - before.mtimeMs < minAgeMs) return false;
  if ((await probeSocket(p)) !== 'dead') return false;
  const now = socketIdentity(p);
  if (!now || now.ino !== before.ino || now.ctimeMs !== before.ctimeMs) return false; // replaced meanwhile
  try { fs.unlinkSync(p); return true; } catch { return false; }
}

/** Dead socket files of OTHER versions in the index dir (a killed server cannot remove its own). */
async function removeDeadSockets(indexDir: string, ownSock: string): Promise<void> {
  let names: string[];
  try { names = fs.readdirSync(indexDir); } catch { return; }
  let removed = 0;
  for (const name of names) {
    if (!/^inject-daemon(?:-[0-9A-Za-z.+-]{1,32})?\.sock$/.test(name)) continue;
    const p = path.join(indexDir, name);
    if (p === ownSock) continue;
    if (await removeIfDead(p, OTHER_SOCKET_MIN_AGE_MS)) removed++;
  }
  if (removed > 0) console.error(`[memory-bank] removed ${removed} dead inject-daemon socket file(s)`);
}

/** What startInjectDaemon hands back — the MCP server ignores it; tests drive the lifecycle through it. */
export interface InjectDaemonHandle {
  /** Listening, and the socket path still names this server's socket (a client can reach it). */
  owning(): boolean;
  /** Listening at all — true without owning() means the name was taken away from under it. */
  listening(): boolean;
  /** Stop for good: no more takeover attempts; a held socket is closed (its file removed). */
  close(): Promise<void>;
}

/** This server's socket path, or null when the index dir is too deep for a unix socket (no daemon then). */
export function injectSocketPath(): string | null {
  return injectSocketPathIn(getIndexDir(), ownPackageVersion());
}

/** Is the name itself there — a dangling symlink is still a name (existsSync follows the link and would say "gone"). */
function nameExists(p: string): boolean {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

export function startInjectDaemon(): InjectDaemonHandle {
  const sockPath = injectSocketPath();
  if (sockPath === null) {
    console.error(`[memory-bank] inject daemon off: the socket path under ${getIndexDir()} is longer than a unix socket allows `
      + `(${MAX_UNIX_SOCKET_PATH_BYTES} bytes) — prompts are answered by the hook's own, slower computation. `
      + 'A shorter MEMORY_BANK_CONFIG_DIR / XDG_CONFIG_HOME turns the fast path back on.');
    return { owning: () => false, listening: () => false, close: () => Promise.resolve() };
  }
  let stopped = false;
  /** Immediate re-tries since the last timer tick or successful bind — at most one, the rest is the timer's. */
  let immediateRetries = 0;
  /** A listen() or the probe that follows its EADDRINUSE is in flight — one attempt at a time. */
  let attempting = false;
  /** Identity of the socket file this server created, while it listens. */
  let own: { ino: number; ctimeMs: number } | null = null;

  const server = net.createServer((conn) => {
    let buf = '';
    let handled = false;
    // Decode as a stream: a multi-byte character split across chunks stays whole.
    conn.setEncoding('utf8');
    conn.setTimeout(REQUEST_IDLE_MS, () => conn.destroy());
    conn.on('error', () => { /* client vanished — fine */ });
    conn.on('data', (chunk: string) => {
      if (handled) return; // one request per connection; trailing bytes are ignored
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) {
        if (buf.length > 1_000_000) conn.destroy(); // absurd request — drop
        return;
      }
      handled = true;
      conn.setTimeout(0); // the request is in — the client's deadline governs from here
      const line = buf.slice(0, nl);
      const reply = (payload: object) => {
        conn.end(JSON.stringify(payload) + '\n');
        conn.setTimeout(REQUEST_IDLE_MS, () => conn.destroy()); // answered — reclaim a half-open socket
      };
      void (async () => {
        try {
          const req = JSON.parse(line) as {
            prompt?: string; cwd?: string; session_id?: string; client?: string; entrypoint?: string; req_id?: string; client_impl?: string;
          };
          if (!embeddingsReady() && injectionQuery(String(req.prompt ?? '')).reason === null) {
            conn.write(JSON.stringify({ warming: true }) + '\n');
          }
          const { context, ledgerKeys, failed } = await computeInjectResult(
            String(req.prompt ?? ''),
            String(req.cwd ?? process.cwd()),
            'daemon',
            req.session_id ? String(req.session_id) : undefined,
            {
              client: req.client ? String(req.client).slice(0, 40) : undefined,
              entrypoint: req.entrypoint ? String(req.entrypoint).slice(0, 40) : undefined,
              // Ties this log line to the client's fallback line when the client gave up.
              req_id: req.req_id ? String(req.req_id).replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || undefined : undefined,
              // Which thin client asked — only the two known values are recorded; anything else is dropped.
              client_impl: req.client_impl === 'native' || req.client_impl === 'node' ? req.client_impl : undefined,
            },
          );
          reply(failed ? { ok: false } : { ok: true, context, ledger_keys: ledgerKeys });
        } catch {
          try { reply({ ok: false }); } catch { /* gone */ }
        }
      })();
    });
  });

  const onListen = () => {
    attempting = false;
    immediateRetries = 0;
    if (stopped) { // close() came while this listen was in flight
      try { server.close(); } catch { /* already closed */ }
      return;
    }
    try { fs.chmodSync(sockPath, 0o600); } catch { /* best-effort */ }
    const id = socketIdentity(sockPath);
    own = id ? { ino: id.ino, ctimeMs: id.ctimeMs } : null;
    // Pre-warm the embedding model so even the FIRST prompt after session
    // start gets the fast path (load happens once, off the request path) —
    // only here: a server that does not hold the socket must not load a model.
    void initEmbeddings().catch(() => { /* first request will retry */ });
    void removeDeadSockets(path.dirname(sockPath), sockPath);
  };

  const tryListen = () => {
    if (stopped || attempting || server.listening) return;
    attempting = true;
    try {
      server.listen(sockPath, onListen);
    } catch {
      attempting = false; // sidecar is best-effort
    }
  };

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') { attempting = false; return; } // best-effort sidecar — never crash the MCP server
    // The name is taken: by a live server (leave it — the timer asks again), or by a file nobody listens on.
    void (async () => {
      let retry = false;
      try {
        if (await removeIfDead(sockPath, OWN_SOCKET_MIN_AGE_MS)) retry = true;
        else if (!nameExists(sockPath)) retry = true; // the owner left between our listen() and the probe
      } finally {
        attempting = false;
      }
      // Once: when the bind fails again although the name looked free, whatever holds it is not visible from
      // here, and asking again without a pause would never let the event loop turn. The timer asks again.
      if (retry && immediateRetries < 1) {
        immediateRetries++;
        tryListen();
      }
    })();
  });

  const tick = () => {
    if (stopped) return;
    immediateRetries = 0;
    if (!server.listening) return tryListen();
    // Listening, but the name is gone (a server that lost the name to another one unlinks it when it exits; a
    // cleanup may remove it): no client can reach this socket. Let go of it and bind again. close() unlinks by
    // name, which is a no-op for a name that is not there.
    if (!fs.existsSync(sockPath)) {
      own = null;
      try { server.close(); } catch { /* not running after all */ }
      tryListen();
    }
  };
  const timer = setInterval(tick, RECLAIM_MS);
  timer.unref();

  server.unref();
  tryListen();

  const owning = () => {
    if (!server.listening || !own) return false;
    const now = socketIdentity(sockPath);
    return now !== null && now.ino === own.ino && now.ctimeMs === own.ctimeMs;
  };
  return {
    owning,
    listening: () => server.listening,
    close: () => new Promise<void>((resolve) => {
      stopped = true;
      clearInterval(timer);
      own = null;
      if (!server.listening) return resolve();
      server.close(() => resolve());
    }),
  };
}
