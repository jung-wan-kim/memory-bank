/**
 * Zero-downtime MCP supervisor core (v1.4.5).
 *
 * Claude Code does NOT restart a dead stdio MCP server (official docs:
 * "Stdio servers are local processes and are not reconnected automatically"),
 * so a plugin update used to require a session restart or a manual
 * /reload-plugins in every live session. The wrapper (cli/mcp-server-wrapper.js)
 * now supervises the real server through piped stdio instead of inherit:
 *
 *   client(Claude Code) ⇄ wrapper(proxy, this logic) ⇄ dist/mcp-server.js
 *
 * The wrapper records the MCP initialize handshake. When the plugin dir's
 * package.json version changes on disk (live-apply propagated a new release),
 * the wrapper waits for an idle moment (no outstanding requests), terminates
 * the child, respawns it — the fresh process reads the NEW code from disk —
 * and replays the recorded initialize/initialized handshake so the client
 * never notices. Sessions upgrade in place: no restart, no user action.
 *
 * This module holds the pure protocol logic (line splitting, outstanding
 * request tracking, handshake record/replay decisions) so it is unit-testable;
 * process wiring lives in the wrapper script.
 */
/** Newline-delimited JSON-RPC framing (MCP stdio transport). */
export declare class LineSplitter {
    private buf;
    /** Feed a chunk; returns complete lines (without trailing newline). */
    push(chunk: string): string[];
}
/**
 * Tracks what the supervisor needs from the passing traffic:
 *  - the initialize request + initialized notification (for replay)
 *  - outstanding client→server requests (swap only when idle)
 */
export declare class SupervisorState {
    initializeLine: string | null;
    initializedLine: string | null;
    private initializeId;
    private outstanding;
    onClientLine(line: string): void;
    onServerLine(line: string): void;
    idle(): boolean;
    /** Replay is only possible once the original handshake was observed. */
    canReplay(): boolean;
    /**
     * True when the client's initialize request already received its response.
     * Distinguishes a mid-session crash (replay: swallow the duplicate
     * response) from a startup crash (resend: the client is still waiting).
     */
    initializeAnswered(): boolean;
    /**
     * A respawn drops whatever the dead child still owed; forget those ids so
     * the new child starts idle (the swap itself only happens at idle, but a
     * crash-respawn may not).
     */
    resetOutstanding(): void;
}
/** True when `line` is the server's response to the recorded initialize. */
export declare function isInitializeResponse(line: string, initializeLine: string): boolean;
export type SwapDecision = 'swap' | 'wait-busy' | 'no-handshake' | 'same-version';
/**
 * Decide whether the supervisor may swap the child now.
 * bootVersion = version read when the current child was spawned;
 * diskVersion = version currently in the plugin dir's package.json.
 */
export declare function decideSwap(bootVersion: string, diskVersion: string | null, state: Pick<SupervisorState, 'idle' | 'canReplay'>): SwapDecision;
