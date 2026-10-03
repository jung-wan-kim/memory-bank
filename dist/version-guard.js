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
 *
 * The inject daemon socket is also versioned (injectSocketPathIn) — see there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/** Numeric dotted-version compare: -1 / 0 / 1. Missing parts count as 0. */
export function compareVersions(a, b) {
    const pa = a.split('.').map((n) => parseInt(n, 10));
    const pb = b.split('.').map((n) => parseInt(n, 10));
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = Number.isFinite(pa[i]) ? pa[i] : 0;
        const y = Number.isFinite(pb[i]) ? pb[i] : 0;
        if (x !== y)
            return x < y ? -1 : 1;
    }
    return 0;
}
/**
 * Parse lock pid-file content. Accepts the v1.4.4+ JSON form
 * {pid, version, startedAt} and the legacy bare-pid form (≤1.4.3).
 * Returns null when no usable pid can be extracted (caller treats the
 * lock as garbage: reclaim without killing anything).
 */
export function parseLockMeta(raw) {
    const t = raw.trim();
    if (!t)
        return null;
    if (t.startsWith('{')) {
        try {
            const o = JSON.parse(t);
            const pid = typeof o.pid === 'number' ? o.pid : parseInt(String(o.pid), 10);
            if (!Number.isFinite(pid) || pid <= 1)
                return null;
            return {
                pid,
                version: typeof o.version === 'string' && o.version ? o.version : null,
                startedAt: typeof o.startedAt === 'number' && Number.isFinite(o.startedAt) ? o.startedAt : null,
            };
        }
        catch {
            return null;
        }
    }
    const pid = parseInt(t, 10);
    if (!Number.isFinite(pid) || pid <= 1)
        return null;
    return { pid, version: null, startedAt: null };
}
/**
 * Decide whether a live lock holder should be preempted.
 *  - Older version (a legacy no-version lock can only come from ≤1.4.3, i.e.
 *    older by construction) → take over: stale code must not keep indexing.
 *  - Runtime above wedgeMaxMs → take over regardless of version: a wedged sync
 *    starves indexing either way (observed: 23h; normal incremental sync is
 *    minutes). holderRunMs null (unknown start) → no wedge judgement.
 */
export function decideTakeover(holder, myVersion, holderRunMs, wedgeMaxMs) {
    const holderVersion = holder.version ?? '0.0.0';
    if (compareVersions(holderVersion, myVersion) < 0)
        return 'takeover-stale-version';
    if (holderRunMs !== null && holderRunMs > wedgeMaxMs)
        return 'takeover-wedged';
    return 'defer';
}
/**
 * Detached memory-bank workers running from a versioned plugin cache dir.
 * Deliberately excludes mcp-server / mcp-server-wrapper (owned by live sessions).
 */
const WORKER_RE = /plugins\/cache\/memory-bank-dev\/memory-bank\/(\d+(?:\.\d+)*)\/(?:dist\/sync-cli\.js|scripts\/(?:backfill-extract-worker|backfill-ontology-worker|fact-consolidate-worker|fact-extract-worker|reembed-worker)\.js)/;
/**
 * If `command` is a memory-bank detached worker from a version OLDER than
 * `myVersion` (judged by the PATH segment), return that stale version string;
 * otherwise null.
 */
export function staleWorkerVersion(command, myVersion) {
    const m = WORKER_RE.exec(command);
    if (!m)
        return null;
    return compareVersions(m[1], myVersion) < 0 ? m[1] : null;
}
const WORKER_DIR_RE = /(.*plugins\/cache\/memory-bank-dev\/memory-bank\/\d+(?:\.\d+)*)\/(?:dist\/sync-cli\.js|scripts\/(?:backfill-extract-worker|backfill-ontology-worker|fact-consolidate-worker|fact-extract-worker|reembed-worker)\.js)/;
/**
 * The versioned plugin dir a detached worker runs from, or null when the
 * command is not a memory-bank worker. The sweep judges staleness by the
 * dir's CONTENT version (package.json) — after live-apply an old-named dir
 * carries current code, and a worker spawned from it must not be killed.
 */
export function workerPluginDir(command) {
    const m = WORKER_DIR_RE.exec(command);
    return m ? m[1] : null;
}
let ownVersionCache;
/**
 * This install's package.json version. Every caller sits one level below the
 * package root (src/*.ts under vitest, dist/*.js, and the esbuild bundle
 * dist/mcp-server.js), so '../package.json' is the root in all three. null
 * when unreadable.
 */
export function ownPackageVersion() {
    if (ownVersionCache !== undefined)
        return ownVersionCache;
    try {
        const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
        const v = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
        ownVersionCache = typeof v === 'string' && v ? v : null;
    }
    catch {
        ownVersionCache = null;
    }
    return ownVersionCache;
}
/** macOS sun_path is 104 bytes including the terminating NUL. */
const MAX_UNIX_SOCKET_PATH_BYTES = 103;
/**
 * The inject daemon's socket path for one plugin version.
 *
 * Before v1.7.0 every version shared 'inject-daemon.sock', so a new session's
 * hook client talked to whichever MCP server bound first — after an update
 * that was an OLD server running the old injection logic until every old
 * session ended (2026-10-03: all bound servers were v1.5.0 when v1.7.0 was
 * built). Taking the socket over is not safe either: libuv unlinks a unix
 * socket BY NAME when its server closes, including at process exit, so the old
 * owner would delete the new owner's file on its way out (measured). One
 * socket per version keeps client and daemon on the same code and never
 * touches another version's file.
 *
 * The legacy name is kept for an unusable version string, and for a path too
 * long for a unix socket — there a versioned name would fail to bind and leave
 * every prompt on the ~2.3s cold path.
 */
export function injectSocketPathIn(indexDir, version) {
    const legacy = path.join(indexDir, 'inject-daemon.sock');
    if (!version || !/^[0-9A-Za-z.+-]{1,32}$/.test(version))
        return legacy;
    const versioned = path.join(indexDir, `inject-daemon-${version}.sock`);
    return Buffer.byteLength(versioned) <= MAX_UNIX_SOCKET_PATH_BYTES ? versioned : legacy;
}
