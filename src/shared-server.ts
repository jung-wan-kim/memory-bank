#!/usr/bin/env node
/**
 * The shared MCP server process (dist/shared-server.js) — started detached by a relay, never by a client.
 *
 * Start-up order matters to the relay that waits for it:
 *   1. Work out which server this is (version, code fingerprint, environment → identity → socket name).
 *   2. If a live server already answers on that name: exit 76 (the relay connects to that one).
 *   3. Load the heavy modules and check the native database addon — a failure here exits 70 BEFORE the name is
 *      bound, so the relay sees "could not start" and its wrapper repairs the install. A bound name always
 *      means a server that can answer.
 *   4. Bind the name, then serve.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getIndexDir } from './paths.js';
import {
  distFingerprint, removeOrphanStartLock, serverEnvFor, sharedLockPath, sharedServerArg, sharedServerIdentity, sharedSocketPathIn,
} from './shared-identity.js';
import { EXIT_NAME_TAKEN, EXIT_RETRY, EXIT_START_FAILED, positiveMs } from './shared-protocol.js';
import { probeSocket } from './unix-socket.js';
import { ownPackageVersion } from './version-guard.js';

// Everything this process creates — socket, pid file, database files — is for its owner only.
process.umask(0o077);

const log = (line: string): void => {
  console.error(`${new Date().toISOString()} [shared-server ${process.pid}] ${line}`);
};

function versionOnDisk(packageJson: string): string | null {
  try {
    const v = (JSON.parse(fs.readFileSync(packageJson, 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null; // unreadable for a moment (an update in flight) is not "another version"
  }
}

function fail(message: string): never {
  log(`cannot start: ${message}`);
  process.exit(EXIT_START_FAILED);
}

async function main(): Promise<void> {
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const version = ownPackageVersion();
  if (!version) fail('the plugin version (package.json next to dist/) cannot be read');
  const serverEnv = serverEnvFor(process.env, null);
  if (serverEnv === null) fail('a path setting in the environment is relative — the relay passes absolute paths');
  const fingerprint = distFingerprint(distDir);
  const identity = sharedServerIdentity({ version, fingerprint, serverEnv });
  const socketPath = sharedSocketPathIn(getIndexDir(), version, identity);
  if (socketPath === null) fail('the socket path under the index dir does not fit a unix socket');

  // The relay names the server it expects. A different answer here means the two disagree about the
  // environment or the code — the relay would wait on a name this process never binds.
  const expected = process.argv.find((a) => a.startsWith('--mb-shared='));
  if (expected !== undefined && expected !== sharedServerArg(identity)) {
    fail(`started as ${expected} but this process computes ${sharedServerArg(identity)} `
      + `(environment names: ${Object.keys(serverEnv).join(', ')})`);
  }

  if ((await probeSocket(socketPath)) === 'alive') {
    log(`another server already answers on ${path.basename(socketPath)} — leaving`);
    process.exit(EXIT_NAME_TAKEN);
  }

  let core: typeof import('./shared-server-core.js');
  let tools: typeof import('./server-core.js');
  let inject: typeof import('./inject-daemon.js');
  try {
    core = await import('./shared-server-core.js');
    tools = await import('./server-core.js');
    inject = await import('./inject-daemon.js');
    // The native addon loads on first use, not on import: use it once now, so a broken build is a start
    // failure the wrapper can repair instead of an error in every tool call.
    const { default: Database } = await import('better-sqlite3');
    new Database(':memory:').close();
  } catch (err) {
    fail(`the server modules do not load: ${(err as Error).stack ?? String(err)}`);
  }

  const packageJson = path.join(distDir, '..', 'package.json');
  let daemon: { owning(): boolean; close(): Promise<void> } | null = null;
  const tickMs = positiveMs(process.env.MEMORY_BANK_SHARED_TICK_MS, 45_000);

  // Until the listener is bound nothing holds this process's event loop: the waits inside the bind are
  // unref'd (they are shared with code that must not keep an MCP server alive), and a process with nothing
  // left to do ends with code 0 — without having bound and without a word. Hold it until the bind is decided.
  const holdOpen = setInterval(() => { /* keeps the process alive while it binds */ }, 60_000);

  const result = await core.startSharedServer({
    socketPath,
    identity,
    version,
    createServer: tools.createMemoryBankServer,
    // What the two sides of this trade cost, measured on a 4.2 GB index: a session that finds no server pays
    // about 1.7 s for its first answer, and a server with the embedding model loaded holds about 0.8 GB.
    // Ten minutes spans closing one session and opening the next without keeping that memory through an
    // idle hour. A judgement between the two, not a measured optimum — MEMORY_BANK_SHARED_IDLE_MS moves it.
    idleMs: positiveMs(process.env.MEMORY_BANK_SHARED_IDLE_MS, 10 * 60_000),
    tickMs,
    retireGraceMs: positiveMs(process.env.MEMORY_BANK_SHARED_RETIRE_GRACE_MS, 5_000),
    staleReason: () => {
      const disk = versionOnDisk(packageJson);
      if (disk !== null && disk !== version) return `the plugin on disk is now ${disk}`;
      try {
        if (distFingerprint(distDir) !== fingerprint) return 'the compiled code on disk changed';
      } catch { /* dist unreadable for a moment — not a reason */ }
      return null;
    },
    onStop: async ({ reason }) => {
      try { await daemon?.close(); } catch { /* already closed */ }
      log(`exit: ${reason}`);
      // Not through the listener: when the name was lost, closing it would delete the successor's socket.
      process.exit(0);
    },
    log,
  });

  clearInterval(holdOpen);

  if (result.kind === 'name-taken') {
    log(`another server took ${path.basename(socketPath)} first — leaving`);
    process.exit(EXIT_NAME_TAKEN);
  }
  if (result.kind === 'retry') {
    log(`cannot bind ${path.basename(socketPath)} now: ${result.why}`);
    process.exit(EXIT_RETRY);
  }

  const handle = result.handle;
  // Warm prompt injection for the hooks, served from this process's embedding model (one socket per version).
  daemon = inject.startInjectDaemon();
  log(`ready: version ${version}, identity ${identity.slice(0, 8)}, environment names: ${Object.keys(serverEnv).join(', ')}`);

  // A relay killed while it held the start lock cannot give it back, and sessions that find this server
  // answering never look at the lock: it is cleared here, now and on every self-check.
  const lockPath = sharedLockPath(socketPath);
  const clearOrphanLock = (): void => {
    if (removeOrphanStartLock(lockPath)) log('removed the start lock of a relay that is gone');
  };
  clearOrphanLock();
  setInterval(clearOrphanLock, tickMs).unref();

  // Prompt injection has one socket per (index dir, version), while servers are one per identity. When
  // another process of this version holds that socket, the hooks of this server's sessions are answered
  // there — with that process's settings. Nothing else shows it, so it is written down when it becomes
  // true and when it ends (not on every check).
  if (inject.injectSocketPath() !== null) {
    let answersHooks: boolean | null = null;
    const noteInjectOwner = (): void => {
      const owning = daemon !== null && daemon.owning();
      if (owning === answersHooks) return;
      answersHooks = owning;
      log(owning
        ? 'prompt injection: this server answers the hooks of this index dir'
        : "prompt injection: another memory-bank process holds the inject socket of this index dir — the hooks of this server's sessions are answered there, with that process's settings");
    };
    setTimeout(noteInjectOwner, Math.min(tickMs, 2_000)).unref();
    setInterval(noteInjectOwner, tickMs).unref();
  }

  const shutdown = (signal: string): void => {
    log(`${signal} received`);
    void handle.close();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('uncaughtException', (err) => {
  log(`uncaught exception: ${err.stack ?? String(err)}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

main().catch((err: unknown) => {
  log(`start failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(EXIT_START_FAILED);
});
