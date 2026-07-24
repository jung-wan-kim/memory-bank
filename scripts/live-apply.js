#!/usr/bin/env node

/**
 * Live-apply — propagate the newest release's code into OLDER versioned
 * plugin cache dirs, so already-running sessions pick the update up WITHOUT
 * a restart:
 *
 *  - hooks / detached workers: every event spawns a fresh node process that
 *    reads these files → they run the new code from the very next event.
 *  - MCP servers: the supervising wrapper (v1.4.5+) polls package.json and
 *    live-swaps its child at an idle moment, replaying the MCP handshake.
 *
 * Safety:
 *  - node_modules is NEVER touched. A dir is only patched when its dependency
 *    set (dependencies + optionalDependencies) is identical to the source —
 *    native binaries stay known-good (sharp startup-crash incident 2026-07-14
 *    came from a fresh npm install, not from propagation).
 *  - First patch of a dir backs its code up to <marketplace>/.live-apply-backup/.
 *  - Content-version based and idempotent: dirs already carrying the same
 *    version are skipped, so concurrent/repeated runs converge to no-ops.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from '../dist/version-guard.js';

/**
 * Cross-process mutex over the whole cache base: two concurrent SessionStart
 * runs (from sessions of different versions) must not interleave — otherwise a
 * slower OLDER run can rename its code over a faster NEWER run's result and
 * downgrade a dir (HIGH 2). Exclusive-create lock dir; a stale lock (holder
 * dead or older than TTL) is reclaimed.
 */
function acquireBaseLock(base) {
  const lockDir = path.join(base, '.live-apply.lock');
  const pidFile = path.join(lockDir, 'pid');
  const TTL_MS = 5 * 60 * 1000;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(pidFile, String(process.pid));
      return lockDir;
    } catch {
      let holder = NaN;
      let mtime = 0;
      try { holder = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); } catch {}
      try { mtime = fs.statSync(lockDir).mtimeMs; } catch {}
      let alive = false;
      if (Number.isFinite(holder) && holder > 1) {
        try { process.kill(holder, 0); alive = true; } catch (e) { alive = e && e.code === 'EPERM'; }
      }
      if (alive && Date.now() - mtime < TTL_MS) return null; // live holder — defer
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { return null; }
      // loop and retry the exclusive create
    }
  }
  return null;
}

// package.json is applied LAST as the commit marker: a crash mid-release
// leaves the OLD package.json in place, so the next run still sees the dir as
// older and re-applies (no permanent skip / mixed-version stranding — HIGH 3).
const CODE_ITEMS = [
  'dist',
  'scripts',
  'cli',
  'hooks',
  'commands',
  'agents',
  'skills',
  '.claude-plugin',
  'package.json',
];

function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function depsKey(pkg) {
  const merged = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) };
  return JSON.stringify(Object.fromEntries(Object.entries(merged).sort()));
}

/**
 * Propagate code from selfRoot (a versioned cache dir) into sibling version
 * dirs whose CONTENT version is older. Returns {applied, skipped}.
 */
export function liveApply(selfRoot, log = (m) => console.error(m)) {
  const base = path.dirname(selfRoot);
  const selfName = path.basename(selfRoot);
  if (!/^\d+(\.\d+)*$/.test(selfName)) {
    return { applied: [], skipped: [], reason: 'not-a-versioned-cache-dir' };
  }
  const selfPkg = readPkg(selfRoot);
  const myVersion = selfPkg && typeof selfPkg.version === 'string' ? selfPkg.version : null;
  if (!myVersion) return { applied: [], skipped: [], reason: 'no-self-version' };

  const lockDir = acquireBaseLock(base);
  if (!lockDir) return { applied: [], skipped: [], reason: 'lock-held' };
  try {
    return applyUnlocked(selfRoot, base, selfName, selfPkg, myVersion, log);
  } finally {
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function applyUnlocked(selfRoot, base, selfName, selfPkg, myVersion, log) {
  const applied = [];
  const skipped = [];
  let siblings = [];
  try {
    siblings = fs.readdirSync(base).filter((d) => /^\d+(\.\d+)*$/.test(d) && d !== selfName);
  } catch {
    return { applied, skipped, reason: 'no-base-dir' };
  }

  for (const name of siblings) {
    const dir = path.join(base, name);
    // Reject a versioned sibling that is a symlink — following it would let
    // rm/rename/cp operate on files OUTSIDE the cache (MEDIUM 7).
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) {
        log(`[live-apply] SKIP ${name}: symlink — refusing to patch outside cache`);
        skipped.push({ dir: name, reason: 'symlink' });
        continue;
      }
    } catch {
      skipped.push({ dir: name, reason: 'lstat-failed' });
      continue;
    }
    const pkg = readPkg(dir);
    const theirVersion = pkg && typeof pkg.version === 'string' ? pkg.version : null;
    // null theirVersion = a crashed prior release left this dir without a
    // readable package.json → it needs REPAIR, not a permanent skip (HIGH 3).
    if (theirVersion && compareVersions(theirVersion, myVersion) >= 0) {
      skipped.push({ dir: name, reason: 'same-or-newer-content' });
      continue;
    }
    // deps check needs a readable pkg; a null-pkg repair dir reuses self's deps
    // (its node_modules predates the crash and matches the same release line).
    if (pkg && depsKey(pkg) !== depsKey(selfPkg)) {
      // Different dependency set — patched code could require modules the old
      // node_modules lacks. Loudly skip; this dir needs a real install.
      log(`[live-apply] SKIP ${name}: dependency set differs from ${myVersion} — needs full install`);
      skipped.push({ dir: name, reason: 'deps-differ' });
      continue;
    }

    // One-time backup of the dir's current code (outside the version listing).
    // Complete the backup under a temp name then rename in — a crash mid-backup
    // must not leave a partial backup that later reads as "already backed up".
    const backupTag = theirVersion || 'unknown';
    const backupRoot = path.join(path.dirname(base), '.live-apply-backup', `${name}-${backupTag}`);
    if (!fs.existsSync(backupRoot)) {
      const backupTmp = `${backupRoot}.tmp.${process.pid}`;
      fs.rmSync(backupTmp, { recursive: true, force: true });
      fs.mkdirSync(backupTmp, { recursive: true });
      for (const item of CODE_ITEMS) {
        const src = path.join(dir, item);
        if (fs.existsSync(src)) fs.cpSync(src, path.join(backupTmp, item), { recursive: true });
      }
      try { fs.renameSync(backupTmp, backupRoot); }
      catch { fs.rmSync(backupTmp, { recursive: true, force: true }); }
    }

    // pid-scoped temp names so concurrent runs never clobber each other's
    // in-progress swaps (HIGH 2 — the base lock already serializes, this is
    // belt-and-suspenders against a stale-lock reclaim overlap).
    const sfx = `.live-apply.${process.pid}`;
    for (const item of CODE_ITEMS) {
      const src = path.join(selfRoot, item);
      const dst = path.join(dir, item);
      if (!fs.existsSync(src)) continue;
      // Near-atomic per item: full copy lands beside the target first, then a
      // rename swap — a hook process spawning mid-patch must never read a
      // half-copied dist. package.json is LAST (CODE_ITEMS order) so its
      // presence-at-new-version means every other item already swapped.
      const tmp = `${dst}${sfx}.tmp`;
      const old = `${dst}${sfx}.old`;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(old, { recursive: true, force: true });
      fs.cpSync(src, tmp, { recursive: true });
      if (fs.existsSync(dst)) fs.renameSync(dst, old);
      fs.renameSync(tmp, dst);
      fs.rmSync(old, { recursive: true, force: true });
    }

    const after = readPkg(dir);
    if (after && after.version === myVersion) {
      log(`[live-apply] ${name}: ${theirVersion || 'broken'} -> ${myVersion} (live sessions pick this up without restart)`);
      applied.push({ dir: name, from: theirVersion, to: myVersion });
    } else {
      log(`[live-apply] ${name}: patch verification FAILED`);
      skipped.push({ dir: name, reason: 'verify-failed' });
    }
  }
  return { applied, skipped };
}

// CLI entry: `node scripts/live-apply.js` from any versioned cache dir.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const selfRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = liveApply(selfRoot);
  console.error(`[live-apply] applied=${result.applied.length} skipped=${result.skipped.length}`);
}
