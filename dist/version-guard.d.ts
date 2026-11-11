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
export interface LockMeta {
    pid: number;
    version: string | null;
    startedAt: number | null;
}
/** Numeric dotted-version compare: -1 / 0 / 1. Missing parts count as 0. */
export declare function compareVersions(a: string, b: string): number;
/**
 * Parse lock pid-file content. Accepts the v1.4.4+ JSON form
 * {pid, version, startedAt} and the legacy bare-pid form (≤1.4.3).
 * Returns null when no usable pid can be extracted (caller treats the
 * lock as garbage: reclaim without killing anything).
 */
export declare function parseLockMeta(raw: string): LockMeta | null;
export type TakeoverDecision = 'takeover-stale-version' | 'takeover-wedged' | 'defer';
/**
 * Decide whether a live lock holder should be preempted.
 *  - Older version (a legacy no-version lock can only come from ≤1.4.3, i.e.
 *    older by construction) → take over: stale code must not keep indexing.
 *  - Runtime above wedgeMaxMs → take over regardless of version: a wedged sync
 *    starves indexing either way (observed: 23h; normal incremental sync is
 *    minutes). holderRunMs null (unknown start) → no wedge judgement.
 */
export declare function decideTakeover(holder: LockMeta, myVersion: string, holderRunMs: number | null, wedgeMaxMs: number): TakeoverDecision;
/**
 * If `command` is a memory-bank detached worker from a version OLDER than
 * `myVersion` (judged by the PATH segment), return that stale version string;
 * otherwise null.
 */
export declare function staleWorkerVersion(command: string, myVersion: string): string | null;
/**
 * The versioned plugin dir a detached worker runs from, or null when the
 * command is not a memory-bank worker. The sweep judges staleness by the
 * dir's CONTENT version (package.json) — after live-apply an old-named dir
 * carries current code, and a worker spawned from it must not be killed.
 */
export declare function workerPluginDir(command: string): string | null;
/**
 * This install's package.json version. Every caller sits one level below the
 * package root (src/*.ts under vitest, dist/*.js, and the esbuild bundle
 * dist/mcp-server.js), so '../package.json' is the root in all three. null
 * when unreadable.
 */
export declare function ownPackageVersion(): string | null;
/**
 * Longest unix socket path this plugin uses, in bytes: sun_path minus its terminating NUL — 107 on Linux
 * (sun_path[108]), 103 on macOS and the BSDs (sun_path[104]). Node does not refuse a longer path — libuv binds,
 * and connects to, its first bytes: another name, outside the index dir when the directory part alone is too
 * long, shared by every config dir with the same prefix. Rust refuses anything longer than this. So the limit is
 * applied here, before either client or the daemon gets the path (the native client carries the same numbers —
 * native/inject-client/src/paths.rs). Linux keeps its own, larger number: there 104–107 bytes always worked.
 */
export declare function maxUnixSocketPathBytes(platform?: string): number;
export declare const MAX_UNIX_SOCKET_PATH_BYTES: number;
/**
 * The inject daemon's socket path for one plugin version, or null when no name fits a unix socket.
 *
 * Before v1.7.0 every version shared 'inject-daemon.sock', so a new session's
 * hook client talked to whichever MCP server bound first — after an update
 * that was an OLD server running the old injection logic until every old
 * session ended (2026-10-03: all bound servers were v1.5.0 when v1.7.0 was
 * built). Taking the socket over is not safe either: libuv unlinks a unix
 * socket BY NAME when its server closes, including at process exit, so the old
 * owner would delete the new owner's file on its way out (measured). One
 * socket per version keeps client and daemon on the same code and never
 * touches another version's live socket (a dead file a killed server left
 * behind is removed — inject-daemon.ts removeDeadSockets).
 *
 * The legacy name is kept for an unusable version string, and for a path too
 * long for the versioned name — there a versioned name would fail to bind and
 * leave every prompt on the ~2.3s cold path.
 *
 * null: even the legacy name is too long (a deep MEMORY_BANK_CONFIG_DIR /
 * XDG_CONFIG_HOME, a temp dir). The daemon then stays off and the hook clients
 * compute the block themselves. Until v1.8.0 the legacy name came back
 * unchecked: the server bound the cut-off name, and when a file was already
 * there (a second session, a killed server) it re-tried the bind without a
 * pause — the MCP server never answered `initialize` and held a CPU core,
 * while the hook client connected to whoever listened on the cut-off name.
 */
export declare function injectSocketPathIn(indexDir: string, version: string | null, maxBytes?: number): string | null;
