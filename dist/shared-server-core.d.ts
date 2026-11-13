import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { type SessionContext } from './session-context.js';
import { type HelloError } from './shared-protocol.js';
/**
 * The shared MCP server: one process serving every session that has the same identity.
 *
 *   session ─ wrapper ─ relay ──┐
 *   session ─ wrapper ─ relay ──┼── unix socket ── this process (database, embedding model, tools)
 *   session ─ wrapper ─ relay ──┘
 *
 * What keeps sessions apart:
 *  - A connection's first line (the hello) declares the session's working directory and the identity it
 *    expects. A hello that is malformed, names another identity, or has no usable working directory is
 *    refused before any tool can be reached.
 *  - Every accepted connection gets an MCP server instance of its own, made for that working directory.
 *    Nothing here or below reads this process's working directory (test/server-scope-guard.test.ts).
 *
 * Lifecycle (this plugin has an orphan-flood history, so it is spelled out):
 *  - One server per name. A second one that finds the name served answers 'name-taken' and goes away.
 *  - It ends when no session has been connected for `idleMs`. Prompt-injection requests do not count: a
 *    server no session uses must not live on because hooks keep finding its inject socket.
 *  - Every `tickMs` it looks at itself: its socket name gone or taken by another file, the plugin version on
 *    disk changed, or the compiled code changed → it retires — serves the sessions it has, and ends shortly
 *    after the last one leaves.
 *  - A server whose name was taken never closes its listener: libuv unlinks a socket BY NAME on close, which
 *    would delete the successor's socket. It just exits.
 */
/** Check a connection's first line. The session context it declares, or why it is refused. */
export declare function readHello(line: string, own: {
    identity: string;
    version: string;
}): {
    ctx: SessionContext;
} | {
    error: HelloError;
};
export interface SharedServerOptions {
    socketPath: string;
    identity: string;
    version: string;
    /** Makes the MCP server of one session. Passed in so this module stays free of the heavy imports. */
    createServer: (ctx: SessionContext) => Server;
    /** No connected session for this long → the server ends. */
    idleMs: number;
    /** How often the server checks its own name and the code on disk. */
    tickMs: number;
    /** A retired server waits this long after its last session left (a relay may be mid-reconnect). */
    retireGraceMs?: number;
    /** A connection must send its hello within this time. */
    helloTimeoutMs?: number;
    /** How long to wait for a socket file nobody answers on to be confirmed dead before giving the name up. */
    bindWaitMs?: number;
    /** Why this server should stop taking new sessions, or null. Read every tick. */
    staleReason?: () => string | null;
    /** Runs once the server has stopped serving for good. `listenerClosed: false` = the caller must exit without closing. */
    onStop: (info: {
        reason: string;
        listenerClosed: boolean;
    }) => void | Promise<void>;
    log?: (line: string) => void;
}
export interface SharedServerHandle {
    readonly socketPath: string;
    /** Sessions connected right now (connections whose hello was accepted). */
    connections(): number;
    /** Why the server is retiring, or null. */
    retiring(): string | null;
    /** Stop now: sessions are disconnected, the listener is closed (its file removed when it is still ours). */
    close(): Promise<void>;
}
export type StartResult = {
    kind: 'serving';
    handle: SharedServerHandle;
} | {
    kind: 'name-taken';
} | {
    kind: 'retry';
    why: string;
};
/**
 * Start serving on `socketPath`. Resolves once the server is reachable ('serving'), or with the reason it is
 * not: another live server has the name ('name-taken'), or the name could not be had right now ('retry').
 */
export declare function startSharedServer(o: SharedServerOptions): Promise<StartResult>;
