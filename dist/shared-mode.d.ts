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
};
export type SessionLocalReason = 'switch-off' | 'switch-off-file' | 'windows' | 'not-built' | 'no-version' | 'relative-path' | 'socket-path-too-long';
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
