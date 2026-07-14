/**
 * Version drift guard — a plugin update must not leave old-version processes running.
 *
 * Incident (2026-07-14): a v1.3.3 sync-cli wedged for 23h kept the singleton lock,
 * silently starving every newer sync (indexing frozen), while the stale install
 * record kept spawning v1.3.3 into every new session after v1.4.3 shipped.
 *
 * Two enforcement points use this module:
 *  - sync-cli lock: the lock file carries {pid, version, startedAt} so a newer
 *    sync takes over from an older or wedged holder instead of skipping forever.
 *  - SessionStart sweep (scripts/version-drift-check.js): detached workers
 *    running from an older versioned plugin dir are terminated. MCP servers are
 *    never swept — killing one breaks a live session's tools; those only rotate
 *    on session restart.
 */

export interface LockMeta {
  pid: number;
  version: string | null;
  startedAt: number | null;
}

/** Numeric dotted-version compare: -1 / 0 / 1. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Parse lock pid-file content. Accepts the v1.4.4+ JSON form
 * {pid, version, startedAt} and the legacy bare-pid form (≤1.4.3).
 * Returns null when no usable pid can be extracted (caller treats the
 * lock as garbage: reclaim without killing anything).
 */
export function parseLockMeta(raw: string): LockMeta | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as { pid?: unknown; version?: unknown; startedAt?: unknown };
      const pid = typeof o.pid === 'number' ? o.pid : parseInt(String(o.pid), 10);
      if (!Number.isFinite(pid) || pid <= 1) return null;
      return {
        pid,
        version: typeof o.version === 'string' && o.version ? o.version : null,
        startedAt: typeof o.startedAt === 'number' && Number.isFinite(o.startedAt) ? o.startedAt : null,
      };
    } catch {
      return null;
    }
  }
  const pid = parseInt(t, 10);
  if (!Number.isFinite(pid) || pid <= 1) return null;
  return { pid, version: null, startedAt: null };
}

export type TakeoverDecision = 'takeover-stale-version' | 'takeover-wedged' | 'defer';

/**
 * Decide whether a live lock holder should be preempted.
 *  - Older version (a legacy no-version lock can only come from ≤1.4.3, i.e.
 *    older by construction) → take over: stale code must not keep indexing.
 *  - Runtime above wedgeMaxMs → take over regardless of version: a wedged sync
 *    starves indexing either way (observed: 23h; normal incremental sync is
 *    minutes). holderRunMs null (unknown start) → no wedge judgement.
 */
export function decideTakeover(
  holder: LockMeta,
  myVersion: string,
  holderRunMs: number | null,
  wedgeMaxMs: number,
): TakeoverDecision {
  const holderVersion = holder.version ?? '0.0.0';
  if (compareVersions(holderVersion, myVersion) < 0) return 'takeover-stale-version';
  if (holderRunMs !== null && holderRunMs > wedgeMaxMs) return 'takeover-wedged';
  return 'defer';
}

/**
 * Detached memory-bank workers running from a versioned plugin cache dir.
 * Deliberately excludes mcp-server / mcp-server-wrapper (owned by live sessions).
 */
const WORKER_RE =
  /plugins\/cache\/memory-bank-dev\/memory-bank\/(\d+(?:\.\d+)*)\/(?:dist\/sync-cli\.js|scripts\/(?:backfill-extract-worker|backfill-ontology-worker|fact-consolidate-worker|fact-extract-worker|reembed-worker)\.js)/;

/**
 * If `command` is a memory-bank detached worker from a version OLDER than
 * `myVersion` (judged by the PATH segment), return that stale version string;
 * otherwise null.
 */
export function staleWorkerVersion(command: string, myVersion: string): string | null {
  const m = WORKER_RE.exec(command);
  if (!m) return null;
  return compareVersions(m[1], myVersion) < 0 ? m[1] : null;
}

const WORKER_DIR_RE =
  /(.*plugins\/cache\/memory-bank-dev\/memory-bank\/\d+(?:\.\d+)*)\/(?:dist\/sync-cli\.js|scripts\/(?:backfill-extract-worker|backfill-ontology-worker|fact-consolidate-worker|fact-extract-worker|reembed-worker)\.js)/;

/**
 * The versioned plugin dir a detached worker runs from, or null when the
 * command is not a memory-bank worker. The sweep judges staleness by the
 * dir's CONTENT version (package.json) — after live-apply an old-named dir
 * carries current code, and a worker spawned from it must not be killed.
 */
export function workerPluginDir(command: string): string | null {
  const m = WORKER_DIR_RE.exec(command);
  return m ? m[1] : null;
}
