/**
 * Read a hook's JSON input from stdin — to the end, or whatever arrived by
 * timeoutMs. Shared by the prompt hook client and the SessionStart hook.
 *
 * Decoded as a UTF-8 stream: a host may deliver a large envelope in several
 * chunks, and decoding each chunk on its own turned a multi-byte character
 * split across two of them into U+FFFD (2026-10-03). Node built-ins only —
 * the hook client's fast path must not pull heavy imports.
 */
export declare function readHookInput(stream: NodeJS.ReadableStream & {
    isTTY?: boolean;
}, timeoutMs: number): Promise<string>;
