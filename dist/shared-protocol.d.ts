/**
 * What the relay and the shared server say to each other, and the one helper both read their timings with —
 * kept in a module with no imports, so the relay (bundled into dist/mcp-server.js) does not pull the server's
 * dependencies in with it.
 *
 * A connection starts with one line each way, then carries MCP (newline-delimited JSON-RPC):
 *
 *   relay  → {"mb_relay":1,"identity":"…","version":"…","cwd":"/abs/path"|null,"pid":123}
 *   server → {"mb_relay":1,"ok":true,"pid":456,"version":"…"}   or   {"mb_relay":1,"ok":false,"error":"…"}
 *
 * After that, a line that starts with {"mb_relay": is a control line and never reaches MCP:
 *
 *   relay  → {"mb_relay":1,"ping":7}        server → {"mb_relay":1,"pong":7}
 */
export interface RelayHello {
    mb_relay: 1;
    identity: string;
    version: string;
    /** The session's working directory, or null when the session could not read it. */
    cwd: string | null;
    pid: number;
}
export type HelloError = 'bad-hello' | 'bad-cwd' | 'identity-mismatch';
export type HelloReply = {
    mb_relay: 1;
    ok: true;
    pid: number;
    version: string;
} | {
    mb_relay: 1;
    ok: false;
    error: HelloError;
};
export declare const CONTROL_PREFIX = "{\"mb_relay\":";
/**
 * Exit codes of the server process — what the relay that started it reads.
 *  76  another live server has the name: connect to that one
 *  75  the name could not be had right now: try again later
 *  70  the server cannot run here (modules missing, native addon broken, bad environment): a start failure
 * Anything else before the server answers on its socket is a start failure too — a crash, a signal, and also
 * a plain 0: a server that ends without having served and without saying why did not start. (0 is how a
 * server ends after it served: idle, retired, or told to stop.)
 */
export declare const EXIT_START_FAILED = 70;
export declare const EXIT_RETRY = 75;
export declare const EXIT_NAME_TAKEN = 76;
/** A timing both sides read from the environment: a positive number of milliseconds, else the default. */
export declare function positiveMs(raw: string | undefined, fallback: number): number;
