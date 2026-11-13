import net from 'node:net';
import fs from 'node:fs';

/**
 * Who is behind a unix socket path, and when its file may be removed.
 *
 * Shared by the inject daemon and the shared MCP server: both bind a name in the index dir that other
 * processes look up, and both meet the same three facts —
 *  - a killed server leaves its socket file behind, and nobody else removes it;
 *  - a server between bind() and listen() refuses connections exactly like a dead one, and so does a LIVE one
 *    whose accept queue is full for a moment (macOS);
 *  - libuv unlinks a socket BY NAME when its server closes — so removing a live server's file, or closing a
 *    server whose name another one has taken, deletes a socket somebody is using.
 * So a file is removed only when nobody answers on it twice, a second apart, it is not fresh, and it is still
 * the file that was probed.
 */

const PROBE_TIMEOUT_MS = 500;
/**
 * How long after a first ECONNREFUSED a socket is probed again before it counts as dead. macOS answers
 * ECONNREFUSED for a live listener too while its accept queue is full (measured: queue of 1, server in a
 * synchronous stretch — 1 connect accepted, 11 of 12 simultaneous ones refused); by the second look the
 * stretch (embedding inference, a sqlite search: tens of ms) is over. Nobody waits for this — a dead file
 * costs a prompt nothing, a removed live one costs that session its fast path.
 */
const DEAD_CONFIRM_MS = 1_000;

/** inode + times of a socket file — "is this still the file I probed". null when absent or not a socket. */
export function socketIdentity(p: string): { ino: number; ctimeMs: number; mtimeMs: number } | null {
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
export function probeSocket(p: string): Promise<'alive' | 'dead' | 'absent' | 'unknown'> {
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

/** The same file as `before`, old enough, and nobody answers on it twice: then (and only then) it may be unlinked. */
export async function removeIfDead(p: string, minAgeMs: number): Promise<boolean> {
  const before = socketIdentity(p);
  if (!before || Date.now() - before.mtimeMs < minAgeMs) return false;
  if ((await probeSocket(p)) !== 'dead') return false;
  // unref: this wait must not keep the MCP server's process alive.
  await new Promise<void>((resolve) => { setTimeout(resolve, DEAD_CONFIRM_MS).unref(); });
  if ((await probeSocket(p)) !== 'dead') return false;
  const now = socketIdentity(p);
  if (!now || now.ino !== before.ino || now.ctimeMs !== before.ctimeMs) return false; // replaced meanwhile
  try { fs.unlinkSync(p); return true; } catch { return false; }
}

/** Is the name itself there — a dangling symlink is still a name (existsSync follows the link and would say "gone"). */
export function nameExists(p: string): boolean {
  try { fs.lstatSync(p); return true; } catch { return false; }
}
