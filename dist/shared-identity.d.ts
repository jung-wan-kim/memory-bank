export type ServerEnvKind = 'identity' | 'passthrough';
/** How a shared server gets a variable: as part of its identity, as an operating variable, or not at all. */
export declare function serverEnvKind(name: string): ServerEnvKind | null;
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
