export type ServerEnvKind = 'identity' | 'passthrough' | 'child';
/**
 * How a variable of a session reaches a shared server: as part of the server's identity, as an operating
 * variable of the process, per connection for the LLM child ('child'), or not at all.
 */
export declare function serverEnvKind(name: string): ServerEnvKind | null;
/**
 * The most a connection may declare for its LLM child. The 19 sessions open on the machine this was measured
 * on declare at most 26 names, 1.3 KB in all, the longest value 185 bytes (2026-11-14): the limits leave
 * more than an order of magnitude. The total is counted as the JSON the hello carries, so it keeps that line under
 * the server's 64 KB limit whatever the values contain.
 */
export declare const CHILD_ENV_MAX_NAMES = 256;
export declare const CHILD_ENV_MAX_VALUE_BYTES: number;
export declare const CHILD_ENV_MAX_TOTAL_BYTES: number;
/**
 * What a session declares for the LLM child of its own calls: its variables of the 'child' kind.
 *
 * A path setting that is relative means "relative to the session" (the child runs elsewhere), so it is made
 * absolute against `cwd`. A value that cannot be carried — a NUL, over the limits above, or a relative path
 * with no working directory to resolve it against — is left out and named in `dropped`. The session
 * declares those names with its connection (`envMissing`), and the server then makes no LLM call for it:
 * one such value does not cost the session its other tools, and the LLM child is never started with only
 * part of the session's settings.
 */
export declare function childEnvFor(env: NodeJS.ProcessEnv, cwd: string | null): {
    env: Record<string, string>;
    dropped: string[];
};
/** A per-connection child environment as a server accepts it: 'child' names only, string values within the limits. */
export declare function validChildEnv(value: unknown): value is Record<string, string>;
/** The names a connection declares as not carried: 'child' names only, none of them also in `env`, no repeats. */
export declare function validChildEnvMissing(value: unknown, env: Record<string, string>): value is string[];
/**
 * The identity part of the environment a shared server runs with: allow-listed names only, path settings
 * absolute. null when a path setting is relative and the working directory it is relative to is unknown.
 */
export declare function serverEnvFor(env: NodeJS.ProcessEnv, cwd: string | null): Record<string, string> | null;
/** The full environment to start a shared server with: its identity part plus the operating variables. */
export declare function spawnEnvFor(env: NodeJS.ProcessEnv, serverEnv: Record<string, string>): Record<string, string>;
/**
 * sha256 over the compiled code in `distDir` (its top-level .js files, by name and content).
 *
 * The version string alone does not say which code runs: a development checkout and an installed copy carry
 * the same number, and so do two builds of one checkout. Folders with the same code — a version folder and
 * the older folder a live update copied it into — get the same fingerprint and share a server.
 */
export declare function distFingerprint(distDir: string): string;
/** The identity of the server a session may use: equal for sessions that may share one, and only for those. */
export declare function sharedServerIdentity(o: {
    version: string;
    fingerprint: string;
    serverEnv: Record<string, string>;
}): string;
/**
 * The shared server's socket for one version and identity, or null when the version cannot be part of a file
 * name or the path does not fit a unix socket (see maxUnixSocketPathBytes — a longer path is not refused by
 * Node, it is cut). The name never matches the inject daemon's sockets, which that daemon sweeps.
 */
export declare function sharedSocketPathIn(indexDir: string, version: string, identity: string, maxBytes?: number): string | null;
/** Files that live next to a shared server's socket: its pid, and the lock a relay holds while starting it. */
export declare const sharedPidPath: (socketPath: string) => string;
export declare const sharedLockPath: (socketPath: string) => string;
/** Marks a shared server on its command line, so a pid read from a file can be checked before it is signalled. */
export declare const sharedServerArg: (identity: string) => string;
/** Whether a process with this pid exists (one that exists but is not ours to signal counts). */
export declare function isAlive(pid: number): boolean;
/**
 * The start lock as it is on disk: whether the process named in it exists, how old the file is, and whether
 * it is an orphan (no holder, and not brand new). null when there is no lock file.
 *
 * A relay takes the lock to start a server and gives it back when the server answers. One that is killed in
 * between cannot give it back — both sides read that state through here: the next relay that needs to start
 * a server (it replaces an orphan), and a server that is already serving (it removes one, since sessions that
 * find a server answering never look at the lock).
 */
export declare function startLockHolder(lockPath: string): {
    alive: boolean;
    ageMs: number;
    orphan: boolean;
} | null;
/** Remove the start lock when it is an orphan. true when a file was removed. */
export declare function removeOrphanStartLock(lockPath: string): boolean;
