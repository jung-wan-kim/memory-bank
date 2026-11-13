/**
 * A session's decision: talk to a shared server, or run a server of its own.
 *
 * This is the session's side of shared-identity.ts — it reads the session's own switch and environment — and
 * is kept out of the modules a server loads (test/server-scope-guard.test.ts).
 */
/** A file with this name in the index dir turns the shared server off for every session that starts after it. */
export declare const SHARED_SWITCH_FILE = "shared-server.off";
export type SharedMode = {
    kind: 'shared';
    socketPath: string;
    indexDir: string;
    identity: string;
    version: string;
    /** The identity part of the server's environment. */
    serverEnv: Record<string, string>;
    /** dist/shared-server.js next to the running entry file. */
    serverEntry: string;
} | {
    kind: 'session-local';
    reason: SessionLocalReason;
} | {
    kind: 'broken';
    reason: BrokenReason;
};
/**
 * Why a session runs a server of its own. Three kinds, and nothing else:
 *  - the user turned the shared server off (the variable, or the file in the index dir);
 *  - this way of running has no shared server by design (Windows: no unix sockets; a run from source: there
 *    is no compiled server to start);
 *  - a setting makes the socket impossible (a path too long for one; a relative path setting in a session
 *    that cannot read its own working directory).
 * A session-local server answers exactly as a shared one does — same database, same tools, same scope rule;
 * what differs is one process per session. The entry point says which reason applied, on stderr.
 */
export type SessionLocalReason = 'switch-off' | 'switch-off-file' | 'windows' | 'source-run' | 'relative-path' | 'socket-path-too-long';
/**
 * An install that cannot run at all the way it was built to: the compiled server is missing next to the
 * compiled entry, or the package version cannot be read. Not a reason to run some other way — a session that
 * quietly ran its own server here would hide the broken install and keep one whole server per session. The
 * entry point exits non-zero and says what is missing; the wrapper above repairs the install and tries again.
 */
export type BrokenReason = 'server-file-missing' | 'no-version';
/**
 * Whether the session whose entry file is `entryUrl` talks to a shared server, or runs a server of its own.
 * Decides only — no directory is created, nothing is started.
 */
export declare function sharedMode(o: {
    entryUrl: string;
    env: NodeJS.ProcessEnv;
    cwd: string | null;
    version?: string | null;
    platform?: NodeJS.Platform;
}): SharedMode;
