#!/usr/bin/env node
/**
 * Supervising MCP wrapper — zero-downtime live plugin updates (v1.4.5).
 *
 * v1 was a passthrough (stdio inherit) that died with its child, so a plugin
 * update could only reach a live session via restart or /reload-plugins.
 * This wrapper proxies the stdio JSON-RPC stream instead:
 *
 *   Claude Code ⇄ wrapper (this file) ⇄ dist/mcp-server.js
 *
 *  - Records the MCP initialize handshake as it passes through.
 *  - Polls the plugin dir's package.json; when live-apply propagates a new
 *    release into this dir, the wrapper waits for an idle moment (no
 *    outstanding requests), terminates the child, respawns it (fresh process
 *    = new code from disk) and replays the recorded handshake. The client
 *    never notices — no restart, no /reload-plugins, no failed tools.
 *  - Startup-crash rescue: if the server dies within seconds of spawn (e.g.
 *    broken native binary — sharp incident 2026-07-14), reinstalls deps once
 *    and retries, re-sending the still-unanswered initialize.
 *  - Keeps v1's first-run dependency install.
 *
 * Protocol logic lives in ../dist/wrapper-core.js (unit-tested).
 */

import { spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import os from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  LineSplitter,
  SupervisorState,
  isInitializeResponse,
  decideSwap,
  abortedRequestError,
} from '../dist/wrapper-core.js';

/** Map a signal name to its conventional exit code (128 + signum). */
function signalExitCode(signal) {
  const n = (os.constants.signals && os.constants.signals[signal]) || 15;
  return 128 + n;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..');
const SERVER_PATH = join(PLUGIN_ROOT, 'dist', 'mcp-server.js');
const POLL_MS = parseInt(process.env.MEMORY_BANK_WRAPPER_POLL_MS || '45000', 10);
const NO_NPM = process.env.MEMORY_BANK_WRAPPER_NO_NPM === '1';
const YOUNG_MS = 10_000; // died younger than this = startup crash

function diskVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

function runNpm(args, reason) {
  if (NO_NPM) return false;
  console.error(`memory-bank wrapper: running npm ${args[0]} (${reason})...`);
  const isWindows = process.platform === 'win32';
  const r = spawnSync(isWindows ? 'npm.cmd' : 'npm', args, {
    cwd: PLUGIN_ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: isWindows,
    timeout: 300_000,
  });
  const ok = r.status === 0;
  console.error(ok ? `memory-bank wrapper: npm ${args[0]} done.` : `memory-bank wrapper: npm ${args[0]} FAILED.`);
  return ok;
}

function npmInstall(reason) {
  return runNpm(['install', '--prefer-offline', '--no-audit', '--no-fund'], reason);
}

const state = new SupervisorState();
const clientSplit = new LineSplitter();

let child = null;
let bootVersion = null;
let startedAt = 0;
let holdInput = false; // queue client lines during swap/replay windows
let replaying = false;
let swapRequested = false;
let rescuesLeft = 2; // startup-crash npm rescues
let respawnsLeft = 3; // post-handshake crash respawns
let shuttingDown = false;
const queued = [];

function writeToChild(line) {
  try {
    child.stdin.write(line + '\n');
  } catch {
    /* dying child — the respawn path recovers */
  }
}

function flushQueued() {
  for (const line of queued.splice(0)) writeToChild(line);
}

function startChild({ replay, resendInitialize }) {
  const serverSplit = new LineSplitter();
  bootVersion = diskVersion();
  startedAt = Date.now();
  replaying = replay && state.canReplay();
  holdInput = replaying;

  child = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });

  if (replaying) {
    // Re-run the handshake privately; its traffic is swallowed below.
    writeToChild(state.initializeLine);
    // Watchdog: a new child that HANGS (never answers the replayed
    // initialize) would hold client traffic forever. Kill it; the bounded
    // crash-respawn budget takes over (review finding 2026-07-14).
    const watched = child;
    const replayWatchdog = setTimeout(() => {
      if (child === watched && replaying) {
        console.error('memory-bank wrapper: replay handshake timed out — killing hung server');
        try { watched.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, 20_000);
    replayWatchdog.unref();
  } else if (resendInitialize && state.initializeLine) {
    // Startup crash before the client got its initialize response: deliver
    // the recorded initialize in NORMAL mode so the response reaches the
    // client this time.
    writeToChild(state.initializeLine);
  }

  child.stdout.on('data', (chunk) => {
    for (const line of serverSplit.push(chunk.toString('utf8'))) {
      if (replaying) {
        if (isInitializeResponse(line, state.initializeLine)) {
          if (state.initializedLine) {
            writeToChild(state.initializedLine);
            // Drop any queued copy of the initialized notification so the
            // flush below does not deliver it to the child twice (MEDIUM 6).
            for (let i = queued.length - 1; i >= 0; i--) {
              if (queued[i] === state.initializedLine) queued.splice(i, 1);
            }
          }
          replaying = false;
          holdInput = false;
          flushQueued();
        }
        continue; // swallow replayed handshake traffic — the client already has it
      }
      state.onServerLine(line);
      process.stdout.write(line + '\n');
    }
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('error', (err) => {
    console.error(`ERROR: Failed to start MCP server: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => onChildExit(code, signal));
}

// Fail any in-flight client requests back to the client, so a caller waiting
// on a response that died with the child does not hang forever (HIGH 4).
function abortOutstandingToClient() {
  for (const id of state.outstandingRequestIds()) {
    process.stdout.write(abortedRequestError(id) + '\n');
  }
}

function onChildExit(code, signal) {
  if (shuttingDown) {
    // Terminate directly. Re-sending the signal to ourselves would just
    // re-enter this handler (the listener is still installed) and never exit
    // (HIGH 5). Exit with the conventional code instead.
    process.exit(signal ? signalExitCode(signal) : code || 0);
  }

  if (swapRequested) {
    swapRequested = false;
    console.error(`memory-bank wrapper: live-swapping server ${bootVersion} -> ${diskVersion()} (no session restart)`);
    startChild({ replay: true, resendInitialize: false });
    return;
  }

  const uptime = Date.now() - startedAt;
  if (uptime < YOUNG_MS && rescuesLeft > 0) {
    // Startup crash (broken native module, half-installed deps...): reinstall
    // deps, then retry. If the client's initialize was already answered we
    // must REPLAY (swallow the duplicate response); if it was never answered
    // we must RESEND in normal mode (the client is still waiting for it).
    rescuesLeft--;
    console.error(
      `memory-bank wrapper: server died ${uptime}ms after spawn (code=${code} signal=${signal}) — rescue attempt`,
    );
    // Rescue 1: reinstall (fetches missing packages). Rescue 2: rebuild —
    // recompiles native binaries that install left broken (sharp 2026-07-14:
    // node_modules existed, so install alone never repaired the binary).
    if (rescuesLeft === 1) npmInstall('startup crash rescue');
    else runNpm(['rebuild'], 'startup crash rescue — native rebuild');
    const initAnswered = state.initializeAnswered();
    // If the session was already live (init answered), any in-flight calls
    // died with the child — fail them back so the client does not hang (HIGH 4).
    if (initAnswered) abortOutstandingToClient();
    state.resetOutstanding();
    startChild({ replay: initAnswered, resendInitialize: !initAnswered });
    if (!replaying) {
      holdInput = false;
      flushQueued();
    }
    return;
  }

  if (state.canReplay() && respawnsLeft > 0) {
    respawnsLeft--;
    console.error(
      `memory-bank wrapper: server crashed (code=${code} signal=${signal}) — respawning with handshake replay`,
    );
    abortOutstandingToClient(); // fail in-flight calls back to the client (HIGH 4)
    state.resetOutstanding(); // in-flight requests died with the child
    startChild({ replay: true, resendInitialize: false });
    return;
  }

  // No replay possible / budget exhausted: fail any in-flight calls before we
  // go, then terminate.
  abortOutstandingToClient();
  process.exit(signal ? signalExitCode(signal) : code || 0);
}

async function main() {
  try {
    if (!existsSync(join(PLUGIN_ROOT, 'node_modules'))) {
      if (!npmInstall('first run') && !NO_NPM) {
        console.error(`Please run manually: cd "${PLUGIN_ROOT}" && npm install`);
        process.exit(1);
      }
    }
    if (!existsSync(SERVER_PATH)) {
      console.error(`ERROR: MCP server not found at ${SERVER_PATH}`);
      console.error('Please run: npm run build');
      process.exit(1);
    }

    process.stdin.on('data', (chunk) => {
      for (const line of clientSplit.push(chunk.toString('utf8'))) {
        state.onClientLine(line);
        if (child && !holdInput && !swapRequested) writeToChild(line);
        else queued.push(line);
      }
    });
    // Graceful shutdown: kill the child, then a hard-exit fallback guarantees
    // the wrapper always dies even if the child ignores the signal (HIGH 5) —
    // otherwise a session with a stuck child would leave the wrapper wedged.
    function beginShutdown(exitCode) {
      if (shuttingDown) return;
      shuttingDown = true;
      const c = child;
      try {
        c?.kill('SIGTERM');
      } catch {
        /* already gone — onChildExit / fallback handles exit */
      }
      const escalate = setTimeout(() => {
        try { c?.kill('SIGKILL'); } catch { /* gone */ }
      }, 3_000);
      escalate.unref();
      const hardExit = setTimeout(() => process.exit(exitCode), 6_000);
      hardExit.unref();
      if (!c) process.exit(exitCode);
    }

    process.stdin.on('end', () => beginShutdown(0));

    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, () => beginShutdown(signalExitCode(sig)));
    }

    startChild({ replay: false, resendInitialize: false });

    const timer = setInterval(() => {
      const decision = decideSwap(bootVersion, diskVersion(), state);
      if (decision === 'swap' && !swapRequested && !replaying) {
        swapRequested = true;
        holdInput = true; // queue client traffic during the swap window
        const dying = child;
        try {
          dying.kill('SIGTERM');
        } catch {
          /* exit handler drives the respawn */
        }
        // A child that ignores SIGTERM would leave the session queueing
        // forever — escalate to SIGKILL (review finding 2026-07-14).
        const killTimer = setTimeout(() => {
          if (child === dying && swapRequested) {
            try { dying.kill('SIGKILL'); } catch { /* already gone */ }
          }
        }, 5_000);
        killTimer.unref();
      }
    }, POLL_MS);
    timer.unref();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
