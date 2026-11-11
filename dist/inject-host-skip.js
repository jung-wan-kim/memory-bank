/**
 * Hosts the user switched injection off for, by who made the request:
 *  - MEMORY_BANK_INJECT_HEADLESS=0 — Claude Code's non-interactive entry points
 *    (`claude -p`, the Agent SDK: CLAUDE_CODE_ENTRYPOINT `sdk-*`), reason 'headless'.
 *  - MEMORY_BANK_INJECT_CODEX=0 — the Codex hook client, reason 'codex-off'. Codex
 *    sends no interactive/headless marker, so this is all of Codex or none.
 * Unset (the default) both are injected as before. Why the switches exist: since
 * 2026-10-08 interactive Claude Code received 5% of the injected characters
 * (Codex 72.9%, headless 21.4% — measured 2026-11-10); those sessions are new
 * every time, so the per-session ledger never stops the same block from going
 * out again (one 5,223-char prompt template received the same 882-char block
 * 1,133 times). Whether that injection is worth its tokens is the user's call.
 *
 * Judged twice, and either says no:
 *  - by the hook client, on the hook's own environment, before it asks anyone
 *    (scripts/inject-context.js and the native client) — so a switch given to
 *    one run (`MEMORY_BANK_INJECT_HEADLESS=0 claude -p …`) or set on the Codex
 *    side only is enough;
 *  - where the block is computed (inject-core.ts): the MCP server's environment
 *    for the warm daemon, the hook's own for the cold fallback.
 * Until v1.8.0 only the second existed, and the warm daemon is whichever
 * session's MCP server bound the socket first — not the asking session's. With
 * the switch on the hook's side only, the same headless prompt got the block
 * when a daemon answered (972 chars, measured) and nothing when none did.
 *
 * This module imports nothing: the hook client loads it on the warm path, which
 * must not pay for better-sqlite3 or the embedding model.
 *
 * Returns the skip reason, or null to go on.
 */
export function hostSkipReason(meta, env = process.env) {
    if (env.MEMORY_BANK_INJECT_HEADLESS === '0' && (meta.entrypoint ?? '').startsWith('sdk-'))
        return 'headless';
    if (env.MEMORY_BANK_INJECT_CODEX === '0' && meta.client === 'codex')
        return 'codex-off';
    return null;
}
