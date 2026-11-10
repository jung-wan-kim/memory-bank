import { syncConversations } from './sync.js';
import { getArchiveDir } from './paths.js';
import { parseLockMeta, decideTakeover } from './version-guard.js';
import { appendSyncLog } from './sync-log.js';
import path from 'path';
import os from 'os';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: memory-bank sync [--background]

Sync conversations from ~/.claude/projects to archive and index them.

This command:
1. Copies new or updated .jsonl files to conversation archive
2. Generates embeddings for semantic search
3. Updates the search index

Only processes files that are new or have been modified since last sync.
Safe to run multiple times - subsequent runs are fast no-ops.

OPTIONS:
  --background    Run sync in background (for hooks, returns immediately)

EXAMPLES:
  # Sync all new conversations
  memory-bank sync

  # Sync in background (for hooks)
  memory-bank sync --background

  # Use in Claude Code hook
  # In .claude/hooks/session-end:
  memory-bank sync --background
`);
  process.exit(0);
}

// Check if running in background mode
const isBackground = args.includes('--background');

// ---- background cooldown (2026-09-27): the singleton lock below stops *concurrent*
// syncs but not *frequent* ones. SessionStart fires on every session start, and
// headless sessions (pipeline stages, eval runners) start every few minutes, so a
// fresh sync — embedding model load + indexing, 1-2 min at 2-4 cores — restarted
// right after the previous one finished (measured: 17:41, 17:43, 17:51 on one
// machine, load 85). Background (hook) syncs now skip when the last successful
// sync finished less than MEMORY_BANK_SYNC_MIN_INTERVAL_S ago (default 600s,
// 0 disables). A foreground `memory-bank sync` is never throttled. Failed syncs
// do not stamp, so the next session start retries.
const __lastSyncFile = path.join(os.homedir(), '.claude', 'run-locks', 'memory-bank-sync.last');

function __minIntervalMs(): number {
  const raw = process.env.MEMORY_BANK_SYNC_MIN_INTERVAL_S;
  if (raw === undefined || raw.trim() === '') return 600_000;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 86_400 ? n * 1000 : 600_000;
}

function __lastSyncAgeMs(): number | null {
  try {
    const at = Number(fs.readFileSync(__lastSyncFile, 'utf8').trim());
    if (!Number.isFinite(at) || at <= 0) return null;
    const age = Date.now() - at;
    return age >= 0 ? age : null; // a future stamp (clock change) never suppresses a sync
  } catch { return null; }
}

// If background mode, fork the process and exit immediately
if (isBackground) {
  const minMs = __minIntervalMs();
  const age = __lastSyncAgeMs();
  if (minMs > 0 && age !== null && age < minMs) {
    console.log(`Sync skipped - last sync finished ${Math.round(age / 1000)}s ago (min interval ${minMs / 1000}s)`);
    process.exit(0);
  }
  const filteredArgs = args.filter(arg => arg !== '--background');

  // Spawn a detached process
  const child = spawn(process.execPath, [
    process.argv[1], // This script
    ...filteredArgs
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });

  child.unref(); // Allow parent to exit
  console.log('Sync started in background...');
  process.exit(0);
}

// ---- singleton lock (2026-07-02): SessionStart hook fires sync --background on EVERY
// session start; with many concurrent sessions (auto-issue workers, QA cron, interactive)
// detached syncs pile up unbounded (measured: 76 concurrent -> load avg 164).
// Sync is idempotent - if one is already running, later ones can safely skip.
//
// Version takeover + wedge cap (2026-07-14): the lock records {pid, version,
// startedAt}. A v1.3.3 sync wedged for 23h held the bare-pid lock and every
// newer sync skipped — indexing frozen for a day on stale code. Now a newer
// version preempts an older holder, and any holder past WEDGE_MAX_MS is
// preempted regardless of version (normal incremental sync completes in
// minutes; 6h means wedged).
const __lockDir = path.join(os.homedir(), '.claude', 'run-locks', 'memory-bank-sync.lock');
const __pidFile = path.join(__lockDir, 'pid');
const WEDGE_MAX_MS = 6 * 60 * 60 * 1000;

const __myVersion: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch { return '0.0.0'; }
})();

function __pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Pid-recycling guard: only treat the holder as "our" process if its command
 * line is actually a memory-bank sync-cli. A recycled pid must not be killed. */
function __isSyncCliProcess(pid: number): boolean {
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    return cmd.includes('memory-bank') && cmd.includes('sync-cli');
  } catch { return false; }
}

async function __killAndConfirm(pid: number): Promise<boolean> {
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (!__pidAlive(pid)) return true;
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  return !__pidAlive(pid);
}

function __writeLockMeta(): void {
  try {
    fs.writeFileSync(__pidFile, JSON.stringify({ pid: process.pid, version: __myVersion, startedAt: Date.now() }));
  } catch {}
}

/**
 * taken = this process holds the lock; held = another sync does; error = the
 * lock folder could not be made for any other reason. Only `held` may be read
 * as "already running": the lock's parent (~/.claude/run-locks) is made by no
 * one else, and on a machine without it every attempt failed with ENOENT, was
 * taken for a held lock, and the sync skipped itself on every session start.
 */
type LockOutcome = { state: 'taken' } | { state: 'held' } | { state: 'error'; error: Error };

function __makeLockDir(): LockOutcome {
  try {
    fs.mkdirSync(path.dirname(__lockDir), { recursive: true });
  } catch (e) {
    return { state: 'error', error: e as Error };
  }
  try {
    fs.mkdirSync(__lockDir, { recursive: false });
    return { state: 'taken' };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EEXIST' ? { state: 'held' } : { state: 'error', error: e as Error };
  }
}

function __reclaimLock(): LockOutcome {
  try {
    fs.rmSync(__lockDir, { recursive: true, force: true });
  } catch (e) {
    return { state: 'error', error: e as Error };
  }
  return __makeLockDir(); // held here: another sync took it between the two calls
}

async function __acquireLock(): Promise<LockOutcome> {
  let outcome = __makeLockDir();
  if (outcome.state === 'held') {
    let raw = '';
    try { raw = fs.readFileSync(__pidFile, 'utf8'); } catch {}
    const holder = parseLockMeta(raw);
    if (!holder || !__pidAlive(holder.pid)) {
      // Garbage or dead holder — reclaim (pre-existing behavior).
      outcome = __reclaimLock();
    } else {
      // Live holder: preempt if it runs older code or is wedged.
      let runMs: number | null = holder.startedAt !== null ? Date.now() - holder.startedAt : null;
      if (runMs === null) {
        try { runMs = Date.now() - fs.statSync(__lockDir).mtimeMs; } catch { runMs = null; }
      }
      const decision = decideTakeover(holder, __myVersion, runMs, WEDGE_MAX_MS);
      if (decision === 'defer') return { state: 'held' };
      if (!__isSyncCliProcess(holder.pid)) {
        // Pid was recycled by an unrelated process — the lock is garbage.
        outcome = __reclaimLock();
      } else {
        console.log(`Preempting sync lock holder pid=${holder.pid} version=${holder.version ?? 'legacy'} (${decision})`);
        if (!(await __killAndConfirm(holder.pid))) {
          console.error(`Failed to terminate lock holder pid=${holder.pid} - skip`);
          return { state: 'held' };
        }
        outcome = __reclaimLock();
      }
    }
  }
  if (outcome.state === 'taken') __writeLockMeta();
  return outcome;
}

const __lock = await __acquireLock();
if (__lock.state === 'held') {
  console.log('Sync already running - skip (singleton lock)');
  process.exit(0);
}
if (__lock.state === 'error') {
  // Not running is right — a sync without its lock is what piled up 76 at a
  // time. Saying "already running" was not: this is a failure, and the log
  // line is its only trace when the hook starts the sync detached.
  const message = `cannot take the sync lock at ${__lockDir}: ${__lock.error.message}`;
  console.error(`Sync not started - ${message}`);
  appendSyncLog({ action: 'failed', version: __myVersion, duration_ms: 0, error: message });
  process.exit(1);
}
process.on('exit', () => { try { fs.rmSync(__lockDir, { recursive: true, force: true }); } catch {} });
// Default signal death skips 'exit' handlers (observed: SIGTERM left a stale
// lock behind). Route signals through process.exit so the lock is released.
// Set once the sync itself starts: a run stopped by a signal (the version check
// terminates an older worker) leaves a line in the sync log instead of nothing.
let __syncStartedAt: number | null = null;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (__syncStartedAt !== null) {
      appendSyncLog({ action: 'terminated', version: __myVersion, duration_ms: Date.now() - __syncStartedAt, signal: sig });
    }
    process.exit(143);
  });
}

const sourceDir = path.join(os.homedir(), '.claude', 'projects');
const destDir = getArchiveDir();

console.log('Syncing conversations...');
console.log(`Source: ${sourceDir}`);
console.log(`Destination: ${destDir}\n`);

__syncStartedAt = Date.now();
syncConversations(sourceDir, destDir)
  .then(result => {
    // The hook runs this detached with stdio ignored — the log line is the only trace.
    appendSyncLog({
      action: 'ran', version: __myVersion, duration_ms: Date.now() - (__syncStartedAt ?? Date.now()),
      copied: result.copied, skipped: result.skipped, indexed: result.indexed, summarized: result.summarized,
      errors: result.errors,
    });
    console.log(`\n✅ Sync complete!`);
    console.log(`  Copied: ${result.copied}`);
    console.log(`  Skipped: ${result.skipped}`);
    console.log(`  Indexed: ${result.indexed}`);
    console.log(`  Summarized: ${result.summarized}`);

    if (result.errors.length > 0) {
      console.log(`\n⚠️  Errors: ${result.errors.length}`);
      result.errors.forEach(err => console.log(`  ${err.file}: ${err.error}`));
    }
    try {
      fs.writeFileSync(__lastSyncFile, String(Date.now()));
    } catch (e) {
      console.error(`Could not record sync completion (${__lastSyncFile}): ${(e as Error).message}`);
    }
  })
  .catch(error => {
    appendSyncLog({
      action: 'failed', version: __myVersion, duration_ms: Date.now() - (__syncStartedAt ?? Date.now()),
      error: error instanceof Error ? error.message : String(error),
    });
    console.error('Error syncing:', error);
    process.exit(1);
  });
