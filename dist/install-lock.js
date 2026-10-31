import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
/**
 * One npm install per plugin directory (concept from obra/episodic-memory #161).
 *
 * Two installers used to run unguarded: the MCP wrapper's first-run/rescue
 * install and the hook self-heal (deps-heal.ts). Several sessions starting
 * after a plugin update ran them at once in the same directory; one died
 * part-way and left a node_modules missing better-sqlite3 plus a
 * package-lock.json with an empty version that made every later install fail
 * with "Invalid Version" (2026-10-30). Now: an atomic mkdir lock, waiters
 * re-check instead of installing again, and a failed first install removes
 * what it created so the next attempt starts clean.
 *
 * Node builtins only: it must load while node_modules is broken.
 */
const LOCK_NAME = '.npm-install.lock';
const STALE_MS = 15 * 60 * 1000;
const WAIT_MS = 300_000;
const NPM_TIMEOUT_MS = 300_000;
/** Every declared runtime dependency has a package.json in node_modules. */
export function depsPresent(root) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        return Object.keys(pkg.dependencies ?? {}).every(dep => fs.existsSync(path.join(root, 'node_modules', dep, 'package.json')));
    }
    catch {
        return false;
    }
}
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM'; // exists, owned by someone else
    }
}
/** Take the lock, reclaiming one whose holder died or that is older than STALE_MS. */
export function acquireInstallLock(root) {
    const lockDir = path.join(root, LOCK_NAME);
    const pidFile = path.join(lockDir, 'pid');
    try {
        fs.mkdirSync(lockDir);
    }
    catch {
        let holder = 0;
        let ageMs = 0;
        try {
            holder = Number(fs.readFileSync(pidFile, 'utf8').trim());
            ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
        }
        catch { /* torn lock: no pid yet */ }
        if (holder > 0 && pidAlive(holder) && ageMs < STALE_MS)
            return false;
        if (holder === 0 && ageMs < 5_000)
            return false; // holder still writing its pid
        // Reclaim by rename, not rm: when two waiters both judge the lock stale,
        // only one rename succeeds — an rm by the slower one would delete the lock
        // the faster one had just re-created, and both would install at once.
        const stale = `${lockDir}.stale.${process.pid}.${Date.now()}`;
        try {
            fs.renameSync(lockDir, stale);
        }
        catch {
            return false;
        }
        fs.rmSync(stale, { recursive: true, force: true });
        try {
            fs.mkdirSync(lockDir);
        }
        catch {
            return false;
        }
    }
    fs.writeFileSync(pidFile, String(process.pid));
    return true;
}
/** Release only a lock this process holds — never one a reclaimer has since taken over. */
export function releaseInstallLock(root) {
    const lockDir = path.join(root, LOCK_NAME);
    try {
        if (Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8').trim()) !== process.pid)
            return;
    }
    catch {
        return;
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
}
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * Run `npm <args>` in root under the lock. If another process holds it, wait
 * for that install and report whether the deps are now present instead of
 * installing a second time.
 */
export function runNpmLocked(root, args, label) {
    const deadline = Date.now() + WAIT_MS;
    let waited = false;
    while (!acquireInstallLock(root)) {
        if (Date.now() > deadline) {
            process.stderr.write(`${label}: another npm install still holds ${LOCK_NAME} — giving up\n`);
            return false;
        }
        waited = true;
        sleepSync(1000);
    }
    try {
        // Only after waiting: the other install may have finished the job. A caller
        // that got the lock at once installs — rescue and self-heal run exactly
        // when the top-level packages exist but something inside them is broken.
        if (waited && args[0] === 'install' && depsPresent(root))
            return true;
        const hadNodeModules = fs.existsSync(path.join(root, 'node_modules'));
        const hadLockfile = fs.existsSync(path.join(root, 'package-lock.json'));
        const isWindows = process.platform === 'win32';
        const r = spawnSync(isWindows ? 'npm.cmd' : 'npm', args, {
            cwd: root,
            stdio: ['ignore', 'ignore', 'inherit'],
            shell: isWindows,
            timeout: NPM_TIMEOUT_MS,
            windowsHide: true,
        });
        const ok = r.status === 0 && (args[0] !== 'install' || depsPresent(root));
        if (!ok && args[0] === 'install') {
            // Never leave a half tree behind: it reads as "installed" to the next
            // existence check and its lockfile can poison every retry.
            if (!hadNodeModules)
                fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
            if (!hadLockfile)
                fs.rmSync(path.join(root, 'package-lock.json'), { force: true });
        }
        return ok;
    }
    finally {
        releaseInstallLock(root);
    }
}
// CLI entry for detached callers (deps-heal): node dist/install-lock.js <root> <label>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [root, label = 'install-lock'] = process.argv.slice(2);
    if (!root)
        process.exit(2);
    process.exit(runNpmLocked(root, ['install', '--no-audit', '--no-fund'], label) ? 0 : 1);
}
