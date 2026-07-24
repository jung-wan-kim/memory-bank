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
export class LineSplitter {
    buf = '';
    /** Feed a chunk; returns complete lines (without trailing newline). */
    push(chunk) {
        this.buf += chunk;
        const lines = [];
        let nl;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
            lines.push(this.buf.slice(0, nl));
            this.buf = this.buf.slice(nl + 1);
        }
        // Bound pathological unterminated buffers (a JSON-RPC line should never
        // reach this size; drop rather than grow without limit).
        if (this.buf.length > 16 * 1024 * 1024)
            this.buf = '';
        return lines;
    }
}
function parse(line) {
    try {
        const m = JSON.parse(line);
        return m && typeof m === 'object' ? m : null;
    }
    catch {
        return null;
    }
}
/**
 * Tracks what the supervisor needs from the passing traffic:
 *  - the initialize request + initialized notification (for replay)
 *  - outstanding client→server requests (swap only when idle)
 */
export class SupervisorState {
    initializeLine = null;
    initializedLine = null;
    initializeId = null;
    outstanding = new Set();
    onClientLine(line) {
        const m = parse(line);
        if (!m)
            return;
        if (m.method === 'initialize' && m.id !== undefined) {
            this.initializeLine = line;
            this.initializeId = m.id;
        }
        else if (m.method === 'notifications/initialized')
            this.initializedLine = line;
        // A request has both id and method. (Client responses to server-initiated
        // requests have an id but no method — those are not ours to track.)
        if (m.id !== undefined && m.method !== undefined)
            this.outstanding.add(m.id);
    }
    onServerLine(line) {
        const m = parse(line);
        if (!m)
            return;
        // A response has an id but no method; it settles the matching request.
        if (m.id !== undefined && m.method === undefined)
            this.outstanding.delete(m.id);
    }
    idle() {
        return this.outstanding.size === 0;
    }
    /** Replay is only possible once the original handshake was observed. */
    canReplay() {
        return this.initializeLine !== null;
    }
    /**
     * True when the client's initialize request already received its response.
     * Distinguishes a mid-session crash (replay: swallow the duplicate
     * response) from a startup crash (resend: the client is still waiting).
     */
    initializeAnswered() {
        return this.initializeId !== null && !this.outstanding.has(this.initializeId);
    }
    /**
     * Outstanding client→server REQUEST ids, excluding the initialize request
     * (which the supervisor replays/resends, not errors). On an unexpected child
     * death the wrapper must fail these back to the client with a JSON-RPC error
     * — otherwise a caller that sent e.g. tools/call id=7 waits forever
     * (review finding 2026-07-14 HIGH 4).
     */
    outstandingRequestIds() {
        const ids = [];
        for (const id of this.outstanding) {
            if (this.initializeId !== null && id === this.initializeId)
                continue;
            ids.push(id);
        }
        return ids;
    }
    /**
     * A respawn drops whatever the dead child still owed; forget those ids so
     * the new child starts idle (the swap itself only happens at idle, but a
     * crash-respawn may not).
     */
    resetOutstanding() {
        this.outstanding.clear();
    }
}
/**
 * JSON-RPC error line failing an outstanding request that died with a crashed
 * server child. Unblocks a client that is waiting for a response that will
 * never come.
 */
export function abortedRequestError(id) {
    return JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32001, message: 'memory-bank server restarted; in-flight request aborted — please retry' },
    });
}
/** True when `line` is the server's response to the recorded initialize. */
export function isInitializeResponse(line, initializeLine) {
    const req = parse(initializeLine);
    const m = parse(line);
    if (!req || !m)
        return false;
    return m.id !== undefined && m.id === req.id && m.method === undefined;
}
/**
 * Decide whether the supervisor may swap the child now.
 * bootVersion = version read when the current child was spawned;
 * diskVersion = version currently in the plugin dir's package.json.
 */
export function decideSwap(bootVersion, diskVersion, state) {
    if (!diskVersion || diskVersion === bootVersion)
        return 'same-version';
    if (!state.canReplay())
        return 'no-handshake';
    if (!state.idle())
        return 'wait-busy';
    return 'swap';
}
