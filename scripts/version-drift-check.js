#!/usr/bin/env node

/**
 * SessionStart Hook: version drift guard.
 *
 * A plugin update must not leave old-version processes running (2026-07-14
 * incident: after v1.4.3 shipped, a v1.3.3 sync-cli wedged 23h kept indexing
 * frozen and stale-version workers kept spawning).
 *
 * This hook, running from the NEWEST installed version at every session start:
 *  1. Sweeps detached memory-bank workers (sync-cli / backfill / consolidate /
 *     extract / reembed) that run from an OLDER versioned plugin cache dir.
 *     Their work is idempotent and re-fired on every session start, so killing
 *     a stale one loses nothing. MCP servers are never touched — they belong
 *     to live sessions and only rotate on session restart.
 *  2. Emits a drift warning to stdout (= session context) when the plugin
 *     cache contains a newer version than the one this session is running,
 *     so "update installed but session not restarted" is loudly visible.
 *
 * Progress/errors go to stderr; stdout is reserved for context injection.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { staleWorkerVersion, workerPluginDir, compareVersions } from '../dist/version-guard.js';
import { liveApply } from './live-apply.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function myVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && e.code === 'EPERM'; }
}

async function killAndConfirm(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (!pidAlive(pid)) return true;
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  return !pidAlive(pid);
}

async function main() {
  const version = myVersion();
  if (!version) return;

  // 0) Live-apply: propagate this (newest) release's code into older
  //    versioned cache dirs — live sessions' hooks/workers run the new code
  //    from their next event, and supervising wrappers (v1.4.5+) live-swap
  //    their MCP servers. No restart, no user action.
  try {
    const r = liveApply(ROOT);
    if (r.applied && r.applied.length > 0) {
      console.log(
        `[memory-bank] live-applied v${version} to ${r.applied.length} older cache dir(s): ` +
          r.applied.map((a) => `${a.dir}(${a.from}→${a.to})`).join(', '),
      );
    }
  } catch (e) {
    console.error(`[memory-bank drift] live-apply failed: ${e && e.message ? e.message : e}`);
  }

  // 1) Sweep stale-version detached workers.
  let psOut = '';
  try {
    psOut = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return; // no ps — nothing enforceable, stay silent
  }
  const swept = [];
  for (const line of psOut.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    if (!Number.isFinite(pid) || pid === process.pid) continue;
    // Judge staleness by the worker dir's CONTENT version: after live-apply
    // an old-named dir carries current code — its workers must not be killed.
    // Fall back to the path segment when package.json is unreadable.
    const dir = workerPluginDir(m[2]);
    if (!dir) continue;
    let stale = null;
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
      stale = typeof v === 'string' && compareVersions(v, version) < 0 ? v : null;
    } catch {
      stale = staleWorkerVersion(m[2], version);
    }
    if (!stale) continue;
    const dead = await killAndConfirm(pid);
    swept.push({ pid, stale, dead });
    console.error(`[memory-bank drift] stale v${stale} worker pid=${pid} ${dead ? 'terminated' : 'TERMINATION FAILED'}`);
  }
  if (swept.length > 0) {
    const failed = swept.filter((s) => !s.dead);
    console.log(
      `[memory-bank] swept ${swept.length - failed.length} stale-version worker(s) (running < v${version})` +
        (failed.length ? ` — FAILED to stop pid(s): ${failed.map((f) => f.pid).join(', ')}` : ''),
    );
  }

  // 2) Drift visibility: newer version present in the plugin cache than the
  //    one THIS session runs (i.e. update landed but session not restarted,
  //    or install record lags the cache).
  const cacheBase = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.claude', 'plugins', 'cache', 'memory-bank-dev', 'memory-bank',
  );
  try {
    const versions = fs
      .readdirSync(cacheBase)
      .filter((d) => /^\d+(\.\d+)*$/.test(d))
      .sort(compareVersions);
    const newest = versions.at(-1);
    if (newest && compareVersions(version, newest) < 0) {
      console.log(
        `[memory-bank] version drift: this session runs v${version} but v${newest} is installed. ` +
          `Restart the session (or run: claude plugin update memory-bank@memory-bank-dev) to apply.`,
      );
    }
  } catch {
    /* no cache dir (dev checkout) — skip */
  }
}

main().catch((e) => {
  console.error(`[memory-bank drift] ${e && e.message ? e.message : e}`);
});
