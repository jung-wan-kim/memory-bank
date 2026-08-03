import { syncConversations } from './sync.js';
import { getArchiveDir } from './paths.js';
import { parseLockMeta, decideTakeover } from './version-guard.js';
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
// If background mode, fork the process and exit immediately
if (isBackground) {
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
const __myVersion = (() => {
    try {
        const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
    }
    catch {
        return '0.0.0';
    }
})();
function __pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return !!e && e.code === 'EPERM';
    }
}
/** Pid-recycling guard: only treat the holder as "our" process if its command
 * line is actually a memory-bank sync-cli. A recycled pid must not be killed. */
function __isSyncCliProcess(pid) {
    try {
        const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
        return cmd.includes('memory-bank') && cmd.includes('sync-cli');
    }
    catch {
        return false;
    }
}
async function __killAndConfirm(pid) {
    try {
        process.kill(pid, 'SIGTERM');
    }
    catch { }
    for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 400));
        if (!__pidAlive(pid))
            return true;
    }
    try {
        process.kill(pid, 'SIGKILL');
    }
    catch { }
    await new Promise((r) => setTimeout(r, 500));
    return !__pidAlive(pid);
}
function __writeLockMeta() {
    try {
        fs.writeFileSync(__pidFile, JSON.stringify({ pid: process.pid, version: __myVersion, startedAt: Date.now() }));
    }
    catch { }
}
function __reclaimLock() {
    try {
        fs.rmSync(__lockDir, { recursive: true, force: true });
        fs.mkdirSync(__lockDir, { recursive: false });
        return true;
    }
    catch {
        return false;
    }
}
async function __acquireLock() {
    try {
        fs.mkdirSync(__lockDir, { recursive: false });
    }
    catch {
        let raw = '';
        try {
            raw = fs.readFileSync(__pidFile, 'utf8');
        }
        catch { }
        const holder = parseLockMeta(raw);
        if (!holder || !__pidAlive(holder.pid)) {
            // Garbage or dead holder — reclaim (pre-existing behavior).
            if (!__reclaimLock())
                return false;
        }
        else {
            // Live holder: preempt if it runs older code or is wedged.
            let runMs = holder.startedAt !== null ? Date.now() - holder.startedAt : null;
            if (runMs === null) {
                try {
                    runMs = Date.now() - fs.statSync(__lockDir).mtimeMs;
                }
                catch {
                    runMs = null;
                }
            }
            const decision = decideTakeover(holder, __myVersion, runMs, WEDGE_MAX_MS);
            if (decision === 'defer')
                return false;
            if (!__isSyncCliProcess(holder.pid)) {
                // Pid was recycled by an unrelated process — the lock is garbage.
                if (!__reclaimLock())
                    return false;
            }
            else {
                console.log(`Preempting sync lock holder pid=${holder.pid} version=${holder.version ?? 'legacy'} (${decision})`);
                if (!(await __killAndConfirm(holder.pid))) {
                    console.error(`Failed to terminate lock holder pid=${holder.pid} - skip`);
                    return false;
                }
                if (!__reclaimLock())
                    return false;
            }
        }
    }
    __writeLockMeta();
    return true;
}
if (!(await __acquireLock())) {
    console.log('Sync already running - skip (singleton lock)');
    process.exit(0);
}
process.on('exit', () => { try {
    fs.rmSync(__lockDir, { recursive: true, force: true });
}
catch { } });
// Default signal death skips 'exit' handlers (observed: SIGTERM left a stale
// lock behind). Route signals through process.exit so the lock is released.
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => process.exit(143));
}
const sourceDir = path.join(os.homedir(), '.claude', 'projects');
const destDir = getArchiveDir();
console.log('Syncing conversations...');
console.log(`Source: ${sourceDir}`);
console.log(`Destination: ${destDir}\n`);
syncConversations(sourceDir, destDir)
    .then(result => {
    console.log(`\n✅ Sync complete!`);
    console.log(`  Copied: ${result.copied}`);
    console.log(`  Skipped: ${result.skipped}`);
    console.log(`  Indexed: ${result.indexed}`);
    console.log(`  Summarized: ${result.summarized}`);
    if (result.errors.length > 0) {
        console.log(`\n⚠️  Errors: ${result.errors.length}`);
        result.errors.forEach(err => console.log(`  ${err.file}: ${err.error}`));
    }
})
    .catch(error => {
    console.error('Error syncing:', error);
    process.exit(1);
});
