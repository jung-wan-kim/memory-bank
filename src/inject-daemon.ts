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
 */

export function injectSocketPath(): string {
  return injectSocketPathIn(getIndexDir(), ownPackageVersion());
}

export function startInjectDaemon(): void {
  const sockPath = injectSocketPath();

  const server = net.createServer((conn) => {
    let buf = '';
    conn.setTimeout(10_000, () => conn.destroy());
    conn.on('error', () => { /* client vanished — fine */ });
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) {
        if (buf.length > 1_000_000) conn.destroy(); // absurd request — drop
        return;
      }
      const line = buf.slice(0, nl);
      void (async () => {
        try {
          const req = JSON.parse(line) as {
            prompt?: string; cwd?: string; session_id?: string; client?: string; entrypoint?: string;
          };
          if (!embeddingsReady() && injectionQuery(String(req.prompt ?? '')).reason === null) {
            conn.write(JSON.stringify({ warming: true }) + '\n');
          }
          const { context, ledgerKeys } = await computeInjectResult(
            String(req.prompt ?? ''),
            String(req.cwd ?? process.cwd()),
            'daemon',
            req.session_id ? String(req.session_id) : undefined,
            {
              client: req.client ? String(req.client).slice(0, 40) : undefined,
              entrypoint: req.entrypoint ? String(req.entrypoint).slice(0, 40) : undefined,
            },
          );
          conn.end(JSON.stringify({ ok: true, context, ledger_keys: ledgerKeys }) + '\n');
        } catch {
          try { conn.end(JSON.stringify({ ok: false }) + '\n'); } catch { /* gone */ }
        }
      })();
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') return; // best-effort sidecar — never crash the MCP server
    // Another bind exists: live server (skip) or stale socket file (reclaim).
    const probe = net.connect(sockPath);
    probe.setTimeout(500, () => probe.destroy());
    probe.on('connect', () => probe.destroy()); // live — another session serves
    probe.on('error', () => {
      try {
        fs.unlinkSync(sockPath);
        server.listen(sockPath, onListen);
      } catch { /* raced another reclaimer — fine */ }
    });
  });

  const onListen = () => {
    try { fs.chmodSync(sockPath, 0o600); } catch { /* best-effort */ }
    // Pre-warm the embedding model so even the FIRST prompt after session
    // start gets the fast path (load happens once, off the request path).
    void initEmbeddings().catch(() => { /* first request will retry */ });
  };

  try {
    server.listen(sockPath, onListen);
    server.unref();
  } catch { /* sidecar is best-effort */ }
}
