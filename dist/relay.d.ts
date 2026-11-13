import type { SharedMode } from './shared-mode.js';
/**
 * The relay: what a session runs instead of a whole MCP server.
 *
 *   client (stdio) ⇄ wrapper ⇄ relay (this) ⇄ unix socket ⇄ shared server
 *
 * It passes MCP lines both ways and owns nothing else — no database, no embedding model. What it adds:
 *  - It declares the session to the server (the hello: identity, version, this process's working directory)
 *    and refuses to pass a single client line before the server accepted that.
 *  - When no server answers it starts one (detached, with the allow-list environment), under a lock so a
 *    burst of sessions starts one server, not many.
 *  - When the server goes away it reconnects, starting a new one if need be, and replays the MCP handshake it
 *    recorded — the client never notices. Calls that were in flight are answered with an error.
 *  - It never becomes a server itself. If a server cannot be started, a relay that has just begun exits
 *    non-zero (its wrapper then repairs the install and tries again); one that has been serving a session
 *    stays, answers every call with an error that says why, and keeps trying.
 *
 * The wrapper above it is unchanged: it restarts this process when the plugin version on disk changes, and
 * the new process works out the new version's server on its own. So this code never has to reason about a
 * version other than its own.
 */
type Shared = Extract<SharedMode, {
    kind: 'shared';
}>;
/** Run as the relay of one session until its client goes away. Never returns a server of its own. */
export declare function runRelay(mode: Shared, cwd: string | null): void;
export {};
