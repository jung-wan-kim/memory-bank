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
 *    alive → this server simply doesn't serve (another session's MCP server
 *    does); dead (stale file after SIGKILL) → unlink and bind.
 *  - One socket per plugin version (injectSocketPathIn): a hook client only
 *    ever reaches a daemon running its own code, and versions never touch each
 *    other's socket file.
 *  - Socket mode 600 — same-user only; the payload is the user's own prompt.
 *  - Requests are line-delimited JSON; a malformed request gets {ok:false} and
 *    never throws into the MCP server.
 */
export declare function injectSocketPath(): string;
export declare function startInjectDaemon(): void;
