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
 *  2. Reports a newer version than the one this session is running, wherever
 *     it is known from:
 *      - the plugin cache (installed, session not restarted),
 *      - the marketplace clone's package.json (fetched, not installed),
 *      - the upstream repository's tags (released, not fetched) — asked at most
 *        once a day, with a 3s limit.
 *     Before, only the cache was compared, so a release this machine had not
 *     downloaded yet was invisible (measured 2026-11-10: cache and clone at
 *     1.7.7 while v1.7.9 had been tagged for 8 days).
 *
 * Output: ONE line of JSON on stdout, in the SessionStart hook format
 *   {"systemMessage": "...", "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}
 * and only when there is something to say. The hook is registered `async`
 * (hooks/hooks.json), and Claude Code delivers nothing but those JSON fields of
 * an async hook's stdout — the plain-text lines this script used to print
 * reached neither the user nor the model (recorded 2026-10-16: stdout present,
 * delivered response '{}'). The text carries no timestamp: Claude Code skips an
 * async SessionStart hook's text when it equals the last one delivered, so the
 * same situation is announced once and a new version again.
 *
 * A remote check that fails or times out is recorded as 'unknown' and says
 * nothing in the session — it is never read as "no newer version". This script
 * prints no "up to date" message at all.
 *
 * Every run appends one line to <indexDir>/logs/version-drift.jsonl (versions
 * seen, remote status, notices). Progress/errors go to stderr.
 *
 * Environment:
 *   MEMORY_BANK_DRIFT_REMOTE  `off` = never ask the remote; any other non-empty
 *                             value = the repository to ask instead of
 *                             package.json's `repository` (a URL or a path).
 *   MEMORY_BANK_DRIFT_SWEEP   `0` = skip the process sweep (tests: the sweep
 *                             reads the real process list and kills).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { staleWorkerVersion, workerPluginDir, compareVersions } from '../dist/version-guard.js';
import { getIndexDir } from '../dist/paths.js';
import { liveApply } from './live-apply.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REMOTE_TIMEOUT_MS = 3000;
/**
 * git's own give-up for an HTTP remote: under LOW_SPEED_BYTES/s for LOW_SPEED_SECONDS in a row. Longer than
 * REMOTE_TIMEOUT_MS on purpose — while this script lives, its timer ends the lookup; these two only matter
 * when the script was killed first (SIGKILL cannot be handled) and nobody is left to end git: without them a
 * connection that is accepted and never answered keeps git and its helpers for as long as the remote likes.
 */
const LOW_SPEED_BYTES = 1000;
const LOW_SPEED_SECONDS = 5;
/** Signals that end this script while the lookup runs — git's process group is ended first, then the signal is re-sent. */
const END_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
/** Windows has no process groups to signal; there git is a plain child and only it is killed. */
const OWN_PROCESS_GROUP = process.platform !== 'win32';
/** A successful remote answer is reused for a day. */
const REMOTE_TTL_MS = 24 * 60 * 60 * 1000;
/** A failed one for an hour — offline machines do not pay 3s at every session start, and a release is not hidden for a day by one bad moment. */
const REMOTE_RETRY_MS = 60 * 60 * 1000;
const LOG_MAX_BYTES = 1024 * 1024;

function readPkg(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg && typeof pkg === 'object' ? pkg : null;
  } catch {
    return null;
  }
}

function versionOf(pkg) {
  return pkg && typeof pkg.version === 'string' && pkg.version ? pkg.version : null;
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

/**
 * Where this install sits: <plugins>/cache/<marketplace>/<plugin>/<version>.
 * Read from this script's own path, so the cache and the marketplace clone that
 * are compared are the ones this install came from. A checkout elsewhere (dev)
 * falls back to the default names under ~/.claude.
 */
function pluginsLayout() {
  const m = /^(.*)[\\/]cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/][^\\/]+$/.exec(ROOT);
  if (m) return { pluginsDir: m[1], marketplace: m[2], plugin: m[3] };
  return {
    pluginsDir: path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'plugins'),
    marketplace: 'memory-bank-dev',
    plugin: 'memory-bank',
  };
}

/** The repository whose tags are asked: MEMORY_BANK_DRIFT_REMOTE, else package.json `repository`. null = none known. */
function remoteUrl(pkg) {
  const override = (process.env.MEMORY_BANK_DRIFT_REMOTE || '').trim();
  if (override) return override;
  const repo = pkg ? pkg.repository : null;
  const url = typeof repo === 'string' ? repo : repo && typeof repo.url === 'string' ? repo.url : '';
  return url ? url.replace(/^git\+/, '') : null;
}

/**
 * `git ls-remote --tags --refs <url>` within REMOTE_TIMEOUT_MS: { stdout } or { error }. Never rejects.
 *
 * git runs as the leader of its own process group, and the group is what gets killed. For an HTTP remote git
 * starts `git remote-http`, which starts `git-remote-http`; killing git alone left those two under PID 1,
 * holding the connection until the remote answered (v1.8.0 review: both still there 20s after the hook had
 * exited — one pair per session start on a network that does not answer). In its own group git no longer
 * dies with a signal sent to this script's group, so the signals that end this script end git's group first.
 */
function lsRemoteTags(url) {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    let err = '';
    let child;
    const killTree = () => {
      if (!child || !child.pid) return;
      // Negative pid = the group. Only when the group is ours: child.pid names a group only because of `detached`.
      if (OWN_PROCESS_GROUP) { try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* the group is gone */ } }
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    };
    const onEndSignal = (signal) => {
      killTree();
      for (const s of END_SIGNALS) process.removeListener(s, onEndSignal);
      process.kill(process.pid, signal); // the default action, now that no listener is left
    };
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const s of END_SIGNALS) process.removeListener(s, onEndSignal);
      // Do not wait for the pipes: a helper process git started may still hold them.
      try { child.stdout.destroy(); child.stderr.destroy(); child.unref(); } catch { /* never spawned */ }
      resolve(v);
    };
    const timer = setTimeout(() => {
      killTree();
      done({ error: `timed out after ${REMOTE_TIMEOUT_MS}ms` });
    }, REMOTE_TIMEOUT_MS);
    try {
      child = spawn('git', ['-c', `http.lowSpeedLimit=${LOW_SPEED_BYTES}`, '-c', `http.lowSpeedTime=${LOW_SPEED_SECONDS}`, 'ls-remote', '--tags', '--refs', url], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: OWN_PROCESS_GROUP,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // never wait for a credential prompt
      });
    } catch (e) {
      return done({ error: e && e.message ? e.message : String(e) });
    }
    for (const s of END_SIGNALS) process.on(s, onEndSignal);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (out.length < 4 * 1024 * 1024) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 4096) err += d; });
    child.on('error', (e) => done({ error: e && e.message ? e.message : String(e) }));
    child.on('close', (code, signal) => {
      if (code === 0) done({ stdout: out });
      else done({ error: `git ls-remote ${signal ? `killed by ${signal}` : `exited ${code}`}${err.trim() ? `: ${err.trim().split('\n')[0]}` : ''}`.slice(0, 300) });
    });
  });
}

/** Newest `vX.Y.Z` / `X.Y.Z` tag of an ls-remote listing, or null when it holds none (pre-release tags are not releases). */
function newestTag(listing) {
  let newest = null;
  for (const line of listing.split('\n')) {
    const m = /\trefs\/tags\/v?(\d+\.\d+\.\d+)$/.exec(line.trimEnd());
    if (m && (newest === null || compareVersions(newest, m[1]) < 0)) newest = m[1];
  }
  return newest;
}

/**
 * Newest upstream release tag. status:
 *   'ok'      — asked now, `latest` is the answer
 *   'cached'  — a recent answer (REMOTE_TTL_MS) for the same url
 *   'unknown' — could not be determined (failed now, or failed within REMOTE_RETRY_MS); `latest` is null
 *   'off'     — MEMORY_BANK_DRIFT_REMOTE=off
 */
async function remoteLatest(pkg) {
  if ((process.env.MEMORY_BANK_DRIFT_REMOTE || '').trim().toLowerCase() === 'off') return { status: 'off', latest: null };
  const url = remoteUrl(pkg);
  if (!url) return { status: 'unknown', latest: null, error: 'no repository url in package.json' };

  const stateFile = path.join(getIndexDir(), 'state', 'version-remote.json');
  let state = null;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* none yet / unreadable — ask */ }
  if (state && typeof state === 'object' && state.url === url && typeof state.checked_at === 'string') {
    const age = Date.now() - Date.parse(state.checked_at);
    if (typeof state.latest === 'string' && age >= 0 && age < REMOTE_TTL_MS) return { status: 'cached', latest: state.latest };
    if (state.latest === null && age >= 0 && age < REMOTE_RETRY_MS) {
      return { status: 'unknown', latest: null, error: typeof state.error === 'string' ? state.error : 'earlier check failed' };
    }
  }

  const answer = await lsRemoteTags(url);
  const latest = answer.stdout !== undefined ? newestTag(answer.stdout) : null;
  const error = answer.error ?? (latest === null ? 'no version tags in the remote listing' : undefined);
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ url, checked_at: new Date().toISOString(), latest, ...(error ? { error } : {}) }));
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    console.error(`[memory-bank drift] cannot record the remote check: ${e && e.message ? e.message : e}`);
  }
  return latest !== null ? { status: 'ok', latest } : { status: 'unknown', latest: null, error };
}

function appendDriftLog(entry) {
  try {
    const dir = path.join(getIndexDir(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'version-drift.jsonl');
    try { if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`); } catch { /* no file yet */ }
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.error(`[memory-bank drift] cannot write log: ${e && e.message ? e.message : e}`);
  }
}

/** Stale-version detached workers: terminate, report. Returns the notice line or null. */
async function sweepStaleWorkers(version) {
  let psOut = '';
  try {
    psOut = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return null; // no ps — nothing enforceable
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
  if (swept.length === 0) return null;
  const failed = swept.filter((s) => !s.dead);
  return `[memory-bank] swept ${swept.length - failed.length} stale-version worker(s) (running < v${version})` +
    (failed.length ? ` — FAILED to stop pid(s): ${failed.map((f) => f.pid).join(', ')}` : '');
}

async function main() {
  const pkg = readPkg(ROOT);
  const version = versionOf(pkg);
  if (!version) return;
  /** Lines for the session, in order. */
  const notices = [];
  /** Short form for systemMessage. */
  const headlines = [];

  // 0) Live-apply: propagate this (newest) release's code into older
  //    versioned cache dirs — live sessions' hooks/workers run the new code
  //    from their next event, and supervising wrappers (v1.4.5+) live-swap
  //    their MCP servers. No restart, no user action.
  try {
    const r = liveApply(ROOT);
    if (r.applied && r.applied.length > 0) {
      notices.push(
        `[memory-bank] live-applied v${version} to ${r.applied.length} older cache dir(s): ` +
          r.applied.map((a) => `${a.dir}(${a.from}→${a.to})`).join(', '),
      );
      headlines.push(`[memory-bank] live-applied v${version} to ${r.applied.length} older cache dir(s)`);
    }
  } catch (e) {
    console.error(`[memory-bank drift] live-apply failed: ${e && e.message ? e.message : e}`);
  }

  // 1) Sweep stale-version detached workers.
  if (process.env.MEMORY_BANK_DRIFT_SWEEP !== '0') {
    const sweptLine = await sweepStaleWorkers(version);
    if (sweptLine) { notices.push(sweptLine); headlines.push(sweptLine); }
  }

  // 2) Drift visibility: a newer version than the one THIS session runs, by where it is known from.
  const { pluginsDir, marketplace, plugin } = pluginsLayout();
  const pluginId = `${plugin}@${marketplace}`;
  let cacheNewest = null;
  try {
    cacheNewest = fs
      .readdirSync(path.join(pluginsDir, 'cache', marketplace, plugin))
      .filter((d) => /^\d+(\.\d+)*$/.test(d))
      .sort(compareVersions)
      .at(-1) ?? null;
  } catch {
    /* no cache dir (dev checkout) — skip */
  }
  const marketplaceVersion = versionOf(readPkg(path.join(pluginsDir, 'marketplaces', marketplace)));
  const remote = await remoteLatest(pkg);

  const newer = (a, b) => typeof a === 'string' && typeof b === 'string' && compareVersions(a, b) > 0;
  const installed = newer(cacheNewest, version) ? cacheNewest : version; // newest code on this machine's cache
  if (newer(cacheNewest, version)) {
    // Update landed but the session was not restarted, or the install record lags the cache.
    notices.push(
      `[memory-bank] version drift: this session runs v${version} but v${cacheNewest} is installed. ` +
        `Restart the session (or run: claude plugin update ${pluginId}) to apply.`,
    );
  }
  if (newer(marketplaceVersion, installed)) {
    notices.push(
      `[memory-bank] update available: v${marketplaceVersion} is in the marketplace clone but v${installed} is installed ` +
        `(this session runs v${version}). Run: claude plugin update ${pluginId} — then restart the session.`,
    );
  }
  const fetched = newer(marketplaceVersion, installed) ? marketplaceVersion : installed; // newest this machine has downloaded
  if (newer(remote.latest, fetched)) {
    notices.push(
      `[memory-bank] update available upstream: v${remote.latest} is released but this machine has v${fetched} at most ` +
        `(this session runs v${version}). Run: claude plugin marketplace update ${marketplace} && claude plugin update ${pluginId} — then restart the session.`,
    );
  }
  const newestKnown = newer(remote.latest, fetched) ? remote.latest : fetched;
  if (newer(newestKnown, version)) headlines.push(`[memory-bank] v${newestKnown} available (this session runs v${version})`);

  appendDriftLog({
    version,
    cache_newest: cacheNewest,
    marketplace_version: marketplaceVersion,
    remote_status: remote.status,
    remote_latest: remote.latest,
    ...(remote.error ? { remote_error: remote.error } : {}),
    notices,
  });

  if (notices.length > 0) {
    process.stdout.write(JSON.stringify({
      systemMessage: headlines.join('\n'),
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: notices.join('\n') },
    }) + '\n');
  }
}

main().catch((e) => {
  console.error(`[memory-bank drift] ${e && e.message ? e.message : e}`);
});
