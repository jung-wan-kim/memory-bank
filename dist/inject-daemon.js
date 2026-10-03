import net from 'node:net';
import fs from 'node:fs';
import { getIndexDir } from './paths.js';
import { computeInjectResult } from './inject-core.js';
import { initEmbeddings, embeddingsReady } from './embeddings.js';
import { injectionQuery } from './prompt-gate.js';
import { injectSocketPathIn, ownPackageVersion } from './version-guard.js';
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
// Tests shorten this; the request line normally arrives in one write.
const REQUEST_IDLE_MS = Number(process.env.MEMORY_BANK_INJECT_IDLE_MS) || 10_000;
export function injectSocketPath() {
    return injectSocketPathIn(getIndexDir(), ownPackageVersion());
}
export function startInjectDaemon() {
    const sockPath = injectSocketPath();
    const server = net.createServer((conn) => {
        let buf = '';
        let handled = false;
        // Decode as a stream: a multi-byte character split across chunks stays whole.
        conn.setEncoding('utf8');
        conn.setTimeout(REQUEST_IDLE_MS, () => conn.destroy());
        conn.on('error', () => { });
        conn.on('data', (chunk) => {
            if (handled)
                return; // one request per connection; trailing bytes are ignored
            buf += chunk;
            const nl = buf.indexOf('\n');
            if (nl < 0) {
                if (buf.length > 1_000_000)
                    conn.destroy(); // absurd request — drop
                return;
            }
            handled = true;
            conn.setTimeout(0); // the request is in — the client's deadline governs from here
            const line = buf.slice(0, nl);
            void (async () => {
                try {
                    const req = JSON.parse(line);
                    if (!embeddingsReady() && injectionQuery(String(req.prompt ?? '')).reason === null) {
                        conn.write(JSON.stringify({ warming: true }) + '\n');
                    }
                    const { context, ledgerKeys, failed } = await computeInjectResult(String(req.prompt ?? ''), String(req.cwd ?? process.cwd()), 'daemon', req.session_id ? String(req.session_id) : undefined, {
                        client: req.client ? String(req.client).slice(0, 40) : undefined,
                        entrypoint: req.entrypoint ? String(req.entrypoint).slice(0, 40) : undefined,
                    });
                    conn.end(JSON.stringify(failed ? { ok: false } : { ok: true, context, ledger_keys: ledgerKeys }) + '\n');
                }
                catch {
                    try {
                        conn.end(JSON.stringify({ ok: false }) + '\n');
                    }
                    catch { /* gone */ }
                }
            })();
        });
    });
    server.on('error', (err) => {
        if (err.code !== 'EADDRINUSE')
            return; // best-effort sidecar — never crash the MCP server
        // Another bind exists: live server (skip) or stale socket file (reclaim).
        const probe = net.connect(sockPath);
        probe.setTimeout(500, () => probe.destroy());
        probe.on('connect', () => probe.destroy()); // live — another session serves
        probe.on('error', () => {
            try {
                fs.unlinkSync(sockPath);
                server.listen(sockPath, onListen);
            }
            catch { /* raced another reclaimer — fine */ }
        });
    });
    const onListen = () => {
        try {
            fs.chmodSync(sockPath, 0o600);
        }
        catch { /* best-effort */ }
        // Pre-warm the embedding model so even the FIRST prompt after session
        // start gets the fast path (load happens once, off the request path).
        void initEmbeddings().catch(() => { });
    };
    try {
        server.listen(sockPath, onListen);
        server.unref();
    }
    catch { /* sidecar is best-effort */ }
}
