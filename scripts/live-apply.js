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

const CODE_ITEMS = [
  'dist',
  'scripts',
  'cli',
  'hooks',
  'commands',
  'agents',
  'skills',
  'package.json',
  '.claude-plugin',
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
    const pkg = readPkg(dir);
    const theirVersion = pkg && typeof pkg.version === 'string' ? pkg.version : null;
    if (!theirVersion || compareVersions(theirVersion, myVersion) >= 0) {
      skipped.push({ dir: name, reason: 'same-or-newer-content' });
      continue;
    }
    if (depsKey(pkg) !== depsKey(selfPkg)) {
      // Different dependency set — patched code could require modules the old
      // node_modules lacks. Loudly skip; this dir needs a real install.
      log(`[live-apply] SKIP ${name}: dependency set differs from ${myVersion} — needs full install`);
      skipped.push({ dir: name, reason: 'deps-differ' });
      continue;
    }

    // One-time backup of the dir's current code (outside the version listing).
    const backupRoot = path.join(path.dirname(base), '.live-apply-backup', `${name}-${theirVersion}`);
    if (!fs.existsSync(backupRoot)) {
      fs.mkdirSync(backupRoot, { recursive: true });
      for (const item of CODE_ITEMS) {
        const src = path.join(dir, item);
        if (fs.existsSync(src)) fs.cpSync(src, path.join(backupRoot, item), { recursive: true });
      }
    }

    for (const item of CODE_ITEMS) {
      const src = path.join(selfRoot, item);
      const dst = path.join(dir, item);
      if (!fs.existsSync(src)) continue;
      // Near-atomic per item: full copy lands beside the target first, then a
      // rename swap — a hook process spawning mid-patch must never read a
      // half-copied dist (review finding 2026-07-14).
      const tmp = `${dst}.live-apply-tmp`;
      const old = `${dst}.live-apply-old`;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(old, { recursive: true, force: true });
      fs.cpSync(src, tmp, { recursive: true });
      if (fs.existsSync(dst)) fs.renameSync(dst, old);
      fs.renameSync(tmp, dst);
      fs.rmSync(old, { recursive: true, force: true });
    }

    const after = readPkg(dir);
    if (after && after.version === myVersion) {
      log(`[live-apply] ${name}: ${theirVersion} -> ${myVersion} (live sessions pick this up without restart)`);
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
