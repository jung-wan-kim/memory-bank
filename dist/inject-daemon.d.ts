/**
 * Warm inject daemon — a unix-socket sidecar inside the long-lived MCP server.
 *
 * Why: the UserPromptSubmit hook pays ~2.3s PER PROMPT as a cold node process
 * (measured: model load 1,130ms + node startup ~400ms + imports 186ms dominate;
 * the actual search is ~30ms). Every Claude session already runs an MCP server
 * with the embedding model warm — this sidecar lets the hook reuse it: the hook
 * connects, sends the prompt, and gets the context back in ~150ms warm.
 *
 * Lifecycle safety (this plugin's orphan-flood history makes this explicit):
 *  - The daemon lives INSIDE the MCP server process — no new detached process,
 *    no new lifecycle to leak. server.unref() so it never keeps the process
 *    alive on its own; it dies exactly when the MCP server dies.
 *  - Only ONE server binds the socket. EADDRINUSE → probe the existing socket:
 *    alive → this server doesn't serve (another session's MCP server does);
 *    dead (stale file after SIGKILL) → unlink and bind.
 *  - A server that does not hold the socket asks again every RECLAIM_MS: when
 *    the owner's session ends, one of the servers still running takes over.
 *    (It used to try once, at start-up — after the owner left, nobody served
 *    until a new session started, however many servers were still alive, and
 *    every prompt took the cold path meanwhile; measured 2026-11-10.)
 *  - One socket per plugin version (injectSocketPathIn): a hook client only
 *    ever reaches a daemon running its own code. A LIVE socket of another
 *    version is never touched; a dead one (no listener, not just created) is
 *    removed by whoever takes its own socket — nothing else ever cleaned up
 *    what a killed server left behind (7 dead files of 8, measured).
 *  - A socket file is removed only when nobody answers on it — twice, a second
 *    apart — AND it is not fresh AND it is still the file that was probed. A
 *    server between bind() and listen() refuses connections exactly like a dead
 *    one, so does a LIVE one whose accept queue is full for a moment (macOS),
 *    and another server may have replaced a dead file a moment ago: unlinking
 *    any of them leaves a server listening on a name nobody can reach, which
 *    then deletes the next owner's file when it closes (libuv unlinks by name)
 *    — and a v1.7.x server never binds again.
 *  - The 'listening' handler is registered once. `server.listen(path, cb)` adds
 *    `cb` as a once-listener on every call and a failed bind never removes it:
 *    a server waiting for the socket collected one per timer tick, and on
 *    takeover all of them ran — as many simultaneous sweeps of the other
 *    versions' sockets, enough connects at once to fill a busy daemon's accept
 *    queue and have its live socket file removed (v1.8.0 review, measured).
 *    The sweep itself runs one at a time per process.
 *  - The owner checks that its file is still there: when the name is gone it
 *    binds again (an unreachable owner would otherwise look fine forever).
 *  - No daemon when the socket path does not fit a unix socket (a deep config
 *    dir): Node would bind the first 104 bytes of it — a name the clients do
 *    not look at, shared with every other config dir of the same prefix. One
 *    line on stderr says so; the hook clients compute the block themselves.
 *  - A failed bind is re-tried at once only once, and only for a reason seen on
 *    disk (a dead file removed, or the name gone); everything else waits for
 *    the timer. A re-try loop without a pause runs on nextTick and microtasks
 *    alone: the event loop never reaches stdin and the MCP server stops
 *    answering (v1.8.0 review: `initialize` unanswered, one CPU core held).
 *  - Socket mode 600 — same-user only; the payload is the user's own prompt.
 *  - Requests are line-delimited JSON; a malformed request gets {ok:false} and
 *    never throws into the MCP server.
 *  - While the model is still loading the daemon first writes {"warming":true},
 *    so the client keeps waiting instead of loading a second copy cold.
 *  - The reply carries the ledger keys; the client commits them only once it has
 *    actually delivered the block (InjectResult in inject-core.ts).
 *  - The idle limit covers only the request line. Computing the reply may take
 *    longer (cold model load ~5s; the client waits up to 20s after warming),
 *    and the client owns that deadline — it closes the socket when it gives up.
 *    Holding the 10s idle limit through the computation cut off answers the
 *    waiting client was still entitled to.
 *  - A failed computation answers {ok:false}, never an empty success, so the
 *    client falls back instead of injecting nothing.
 */
/**
 * Idle limit before the request line is in, and again after the answer is
 * sent (a client that never closes its side must not pin the connection in
 * the MCP server). Tests shorten it through the environment; anything but a
 * positive finite number falls back to 10s — a negative value would make
 * socket.setTimeout throw inside the connection handler.
 */
export declare function requestIdleMs(raw: string | undefined): number;
/**
 * How often a server looks at the socket again — to take it over when it does
 * not hold it, to bind again when its own file is gone. Tests shorten it
 * through the environment; anything but a positive finite number is 45s.
 */
export declare function reclaimIntervalMs(raw: string | undefined): number;
/** What startInjectDaemon hands back — the MCP server ignores it; tests drive the lifecycle through it. */
export interface InjectDaemonHandle {
    /** Listening, and the socket path still names this server's socket (a client can reach it). */
    owning(): boolean;
    /** Listening at all — true without owning() means the name was taken away from under it. */
    listening(): boolean;
    /** Stop for good: no more takeover attempts; a held socket is closed (its file removed). */
    close(): Promise<void>;
}
/** This server's socket path, or null when the index dir is too deep for a unix socket (no daemon then). */
export declare function injectSocketPath(): string | null;
export declare function startInjectDaemon(): InjectDaemonHandle;
