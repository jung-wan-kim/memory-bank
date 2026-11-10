#!/usr/bin/env node

/**
 * SessionStart maintenance — compacts sparse fact vector tables and decides
 * which resumable background workers to spawn (re-embed, ontology backfill,
 * extraction backfill).
 *
 * Split out of fact-consolidate-hook.js (2026-10-03): the three "is there
 * pending work?" probes took ~3.9s on the real DB (pendingEx 2.5s,
 * pendingExtract 0.85s, pendingFact 0.53s). The hook itself must now run
 * synchronously so its key-facts block reaches Claude Code, and Claude's first
 * response waits for SessionStart hooks to finish — so these probes run here,
 * in a detached process the hook spawns and never waits for.
 *
 * Throttled (2026-10-16): the probes scan the whole exchanges table — measured
 * cold on the 10.5GB DB, pendingEx 23.4s + pendingExtract 20.8s, ~8GB pulled
 * through the OS page cache per run — and they ran on EVERY session start,
 * evicting the fact-vector pages the per-prompt injection search reads. They
 * now run at most once per MEMORY_BANK_MAINTENANCE_INTERVAL_MIN (default 360;
 * 0 = every start), and one run at a time (claim dir). The pending work is
 * resumable, so a later probe only delays it.
 *
 * Every start appends one line to logs/maintenance.jsonl (ran / skipped and
 * why, vector reconcile and compaction outcome, statistics run, probe timings,
 * spawned workers): stdio is ignored by the spawning hook, and a run that
 * leaves no trace cannot be measured.
 *
 * Fact-side housekeeping added 2026-11-10 (dist/db-maintenance.js): vector rows
 * of inactive / absent facts are removed and missing ones written back before
 * the compaction, and ANALYZE gathers planner statistics for the fact and
 * ontology tables after it (never the conversation tables — see ANALYZE_TABLES).
 * MEMORY_BANK_SESSION_START_SPAWN=0 logs the workers it would spawn instead of
 * spawning them (tests).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { getIndexDir } from '../dist/paths.js';
import { buildReembedPending } from '../dist/reembed-selector.js';
import { getExtractionConfig, pendingExtractionCoreQuery } from '../dist/pending-extraction.js';
import { compactSparseVecTables } from '../dist/vec-compact.js';
import { analyzeFactTables, reconcileFactVectors } from '../dist/db-maintenance.js';
import { ensureNativeAbi } from '../dist/node-abi.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * Chosen, not measured: the pending work is resumable, so a probe only needs
 * to come often enough that a backlog starts within the working day; 6h keeps
 * the ~44s / ~8GB cold scan to a few runs a day instead of one per session.
 */
const DEFAULT_INTERVAL_MIN = 360;
/**
 * A run that had a failing step retries after this instead of the full
 * interval: a transient cause (a writer holding the lock past busy_timeout)
 * clears on the next try, and a persistent one re-runs the expensive probes at
 * most hourly instead of on every session start. Chosen, not measured.
 */
const PARTIAL_RETRY_MIN = 60;
/**
 * A claim with no readable pid older than this belongs to a run that died
 * before writing it. A live pid is trusted up to MAX_CLAIM_MS — a whole run
 * measured ~50s cold (probes ~44s + compaction ~2.4s), so an older claim is
 * a reused pid, not a run.
 */
const STALE_CLAIM_MS = 30 * 60 * 1000;
const MAX_CLAIM_MS = 2 * 60 * 60 * 1000;
const LOG_MAX_BYTES = 1024 * 1024;

/** { minutes, warning }: an invalid value runs at the default and says so in the log line. */
function intervalMinutes() {
  const raw = process.env.MEMORY_BANK_MAINTENANCE_INTERVAL_MIN;
  if (raw === undefined || raw === '') return { minutes: DEFAULT_INTERVAL_MIN, warning: null };
  const v = Number(raw);
  if (Number.isFinite(v) && v >= 0) return { minutes: v, warning: null };
  const warning = `invalid MEMORY_BANK_MAINTENANCE_INTERVAL_MIN=${raw} — using ${DEFAULT_INTERVAL_MIN}`;
  console.error(`session-start-maintenance: ${warning}`);
  return { minutes: DEFAULT_INTERVAL_MIN, warning };
}

function appendLog(entry) {
  const dir = path.join(getIndexDir(), 'logs');
  const file = path.join(dir, 'maintenance.jsonl');
  try {
    fs.mkdirSync(dir, { recursive: true });
    try { if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`); } catch { /* no file yet */ }
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry }) + '\n');
  } catch (e) {
    console.error('session-start-maintenance: cannot write maintenance log:', e instanceof Error ? e.message : e);
  }
}

function skip(reason) {
  console.error(`session-start-maintenance: skipped — ${reason}`);
  appendLog({ action: 'skipped', reason });
}

/**
 * Claim this run (claim dir + our pid): null when another run holds the claim.
 * Throws when the claim cannot be recorded (the dir is removed again first, so
 * a half-made claim does not make every start skip as "in progress").
 */
function claim(stateDir) {
  const claimDir = path.join(stateDir, 'session-start-maintenance.claim');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(claimDir);
    } catch (e) {
      // Only "already claimed" is contention; EACCES/ENOSPC/… must not read as "in progress" forever.
      if (e?.code !== 'EEXIST') throw new Error(`cannot create the maintenance claim: ${e instanceof Error ? e.message : e}`);
      if (!reclaimStale(claimDir)) return null;
      continue;
    }
    try {
      fs.writeFileSync(path.join(claimDir, 'pid'), String(process.pid));
      return claimDir;
    } catch (e) {
      try { fs.rmSync(claimDir, { recursive: true, force: true }); } catch { /* the error below is what matters */ }
      throw new Error(`cannot record the maintenance claim: ${e instanceof Error ? e.message : e}`);
    }
  }
  return null;
}

/**
 * Remove a claim whose run is gone: its pid is not alive (or the claim is
 * older than MAX_CLAIM_MS — a reused pid), or it has no readable pid and is
 * older than STALE_CLAIM_MS. The claim is renamed away first and its inode
 * compared with the one judged stale, so a start that judged an old claim
 * does not delete a fresh one made since. This narrows the race between
 * starts reclaiming at once; it does not close it — in the worst case two
 * runs overlap, and SQLite serializes their writes (no corruption, only a
 * repeated probe).
 */
function reclaimStale(claimDir) {
  let judged;
  try { judged = fs.statSync(claimDir); } catch { return true; } // gone already: retry mkdir
  const age = Date.now() - judged.mtimeMs;
  let pid = NaN;
  try { pid = parseInt(fs.readFileSync(path.join(claimDir, 'pid'), 'utf8'), 10); } catch { /* not written yet / torn */ }
  if (Number.isInteger(pid) && pid > 0) {
    if (age < MAX_CLAIM_MS) {
      try {
        process.kill(pid, 0);
        return false; // its run is alive
      } catch (e) {
        if (e?.code !== 'ESRCH') return false; // EPERM: alive under another user
      }
    }
  } else if (age < STALE_CLAIM_MS) {
    return false; // being created right now
  }
  const tomb = `${claimDir}.reclaim-${process.pid}`;
  try { fs.renameSync(claimDir, tomb); } catch { return true; } // another start reclaimed it first
  let moved;
  try { moved = fs.statSync(tomb); } catch { return false; }
  if (moved.ino !== judged.ino) {
    // Not the claim we judged: put it back; if that fails, drop it rather than leave litter.
    try { fs.renameSync(tomb, claimDir); } catch { fs.rmSync(tomb, { recursive: true, force: true }); }
    return false;
  }
  fs.rmSync(tomb, { recursive: true, force: true });
  return true;
}

/** Release only our own claim — a run that outlived STALE_CLAIM_MS may have lost it to a newer run. */
function release(claimDir) {
  try {
    if (fs.readFileSync(path.join(claimDir, 'pid'), 'utf8').trim() === String(process.pid)) {
      fs.rmSync(claimDir, { recursive: true, force: true });
    }
  } catch { /* already reclaimed */ }
}

/** Why this start must not run (inside the interval — the shorter retry one after a partial run), or null. */
function throttleReason(stamp, interval) {
  let ageMs;
  try { ageMs = Date.now() - fs.statSync(stamp).mtimeMs; } catch { return null; } // never ran
  let partial = false;
  // Anything that is not a partial JSON stamp (e.g. the bare ISO date unreleased dev builds wrote) throttles for the full interval.
  try { partial = JSON.parse(fs.readFileSync(stamp, 'utf8')).action === 'partial'; } catch { /* not JSON */ }
  const limit = partial ? Math.min(interval, PARTIAL_RETRY_MIN) : interval;
  if (ageMs >= limit * 60_000) return null;
  return partial
    ? `last run ${Math.floor(ageMs / 60_000)}m ago was partial (retry after ${limit}m)`
    : `last run ${Math.floor(ageMs / 60_000)}m ago (interval ${interval}m, MEMORY_BANK_MAINTENANCE_INTERVAL_MIN)`;
}

async function main() {
  const stateDir = path.join(getIndexDir(), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const stamp = path.join(stateDir, 'session-start-maintenance.stamp');
  const { minutes: interval, warning: intervalWarning } = intervalMinutes();
  const throttled = throttleReason(stamp, interval);
  if (throttled) { skip(throttled); return; }

  const claimDir = claim(stateDir);
  if (!claimDir) { skip('another maintenance run is in progress'); return; }
  const started = Date.now();
  // 'failed' until the run completes (no stamp: the next start retries).
  // 'partial' when a step failed: stamped as partial, retried after
  // PARTIAL_RETRY_MIN instead of the full interval.
  const entry = { action: 'failed', interval_min: interval, compaction: [], probes: {}, spawned: [] };
  if (intervalWarning) entry.warning = intervalWarning;
  try {
    const spawnWorkers = process.env.MEMORY_BANK_SESSION_START_SPAWN !== '0';
    const spawnDetached = (script) => {
      entry.spawned.push(spawnWorkers ? script : `${script} (not spawned: MEMORY_BANK_SESSION_START_SPAWN=0)`);
      if (!spawnWorkers) return;
      try {
        const child = spawn(process.execPath, [path.join(here, script)], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env },
        });
        child.unref();
      } catch (e) {
        entry.spawn_error = `${script}: ${e instanceof Error ? e.message : e}`;
      }
    };
    const probe = (name, fn) => {
      const t0 = Date.now();
      try {
        const found = Boolean(fn());
        entry.probes[name] = { found, ms: Date.now() - t0 };
        return found;
      } catch (e) {
        entry.probes[name] = { error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
        return false;
      }
    };

    const db = initDatabase();
    try {
      // 0. Fact vector tables in step with the facts table: drop the vectors of
      //    inactive / absent facts, write back the vector of an active fact
      //    that lost its row. Before the compaction, so the holes this leaves
      //    are counted by it.
      try {
        entry.vec_reconcile = reconcileFactVectors(db);
      } catch (e) {
        entry.vec_reconcile_error = e instanceof Error ? e.message : String(e);
      }

      // 1. Fact vector tables: rebuild any table whose holes would free a chunk
      //    (vec0 never reuses deleted slots; the injection KNN scans them all).
      try {
        for (const c of compactSparseVecTables(db)) {
          entry.compaction.push(
            c.action === 'compacted'
              ? { table: c.table, action: c.action, chunks: [c.before.chunks, c.after.chunks], fill: [+c.before.ratio.toFixed(3), +c.after.ratio.toFixed(3)] }
              : c.action === 'failed'
                ? { table: c.table, action: c.action, error: c.error }
                : { table: c.table, action: c.action, reason: c.reason });
        }
      } catch (e) {
        entry.compaction_error = e instanceof Error ? e.message : String(e);
      }

      // 1b. Planner statistics for the fact / ontology tables (a few ms: the
      //     sample is capped). Without them every fact query that carries
      //     `is_active = 1` could run through an index on that 2-valued column.
      try {
        const analyzed = analyzeFactTables(db);
        entry.analyze = { tables: analyzed.tables.length, stat_rows: analyzed.stat_rows, ms: analyzed.ms };
      } catch (e) {
        entry.analyze_error = e instanceof Error ? e.message : String(e);
      }

      // 2a. Auto-resume vector upgrades: if any rows still carry old-model
      // embeddings, spawn the resumable re-embed worker (its pid lockfile
      // prevents concurrent runs, so spawning is safe to attempt every start).
      const { EMBEDDING_VERSION } = await import('../dist/embeddings.js');
      // Match BOTH of the worker's fact conditions (reembedFacts: stale version;
      // embedKoreanFacts: a fact_kr with no vec_facts_kr row) so a Korean-vector
      // backlog also auto-spawns the worker — the version-only check missed it,
      // the same coupling drift that hid the exchange missing-vector backlog.
      const pendingFact = probe('pendingFact', () => db.prepare(`
        SELECT 1 FROM facts f WHERE f.is_active = 1 AND (
          f.embedding_version != ?
          OR (f.fact_kr IS NOT NULL AND f.fact_kr != ''
              AND NOT EXISTS (SELECT 1 FROM vec_facts_kr_rowids v WHERE v.id = f.id))
        ) LIMIT 1
      `).get(EMBEDDING_VERSION));
      // Match the WORKER's own selector exactly (single source: buildReembedPending)
      // so the spawn condition can't drift from what the worker actually processes.
      // The old version-only check missed the (b) MISSING-VECTOR backlog — rows
      // that claim the current version but have no vec_exchanges row — so the
      // re-embed worker was never auto-spawned to heal them across sessions
      // (measured: 100k+ such rows sat undrained until manually kicked). It also
      // excludes worker-prompt pollution, so a pure-pollution DB won't spin the
      // worker up forever.
      const { clause, params } = buildReembedPending(EMBEDDING_VERSION);
      const pendingEx = probe('pendingEx', () => db.prepare(`SELECT 1 FROM exchanges e WHERE ${clause} LIMIT 1`).get(...params));
      if (pendingFact || pendingEx) spawnDetached('reembed-worker.js');

      // 2b. Auto-resume ontology classification backfill (historic facts saved
      // without classification).
      const pendingOnto = probe('pendingOnto', () => db.prepare(
        'SELECT 1 FROM facts WHERE is_active = 1 AND ontology_category_id IS NULL LIMIT 1'
      ).get());
      if (pendingOnto) spawnDetached('backfill-ontology-worker.js');

      // 2c. Auto-resume cross-project extraction backfill (sessions that ended
      // before the fixed SessionEnd hook existed).
      // Match the WORKER's exact pending-session predicate (single source:
      // pendingExtractionCoreQuery) — the old bare NOT-IN-extraction_log check
      // over-counted by 508 (sessions below MIN_EXCHANGES + memory-bank-llm
      // pollution that the worker permanently skips), so it spawned the worker
      // on EVERY session start for phantom work it could never clear.
      const { sql: exSql, params: exParams } = pendingExtractionCoreQuery(getExtractionConfig());
      const pendingExtract = probe('pendingExtract', () => db.prepare(`SELECT 1 FROM (${exSql}) LIMIT 1`).get(...exParams));
      if (pendingExtract) spawnDetached('backfill-extract-worker.js');
    } finally {
      db.close();
    }
    const failures = [
      ...entry.compaction.filter((c) => c.action === 'failed').map((c) => `compaction ${c.table}: ${c.error}`),
      ...(entry.compaction_error ? [`compaction: ${entry.compaction_error}`] : []),
      ...(entry.vec_reconcile_error ? [`vec reconcile: ${entry.vec_reconcile_error}`] : []),
      ...(entry.analyze_error ? [`analyze: ${entry.analyze_error}`] : []),
      ...Object.entries(entry.probes).filter(([, p]) => p.error).map(([name, p]) => `probe ${name}: ${p.error}`),
      ...(entry.spawn_error ? [`spawn ${entry.spawn_error}`] : []),
    ];
    if (failures.length) {
      entry.action = 'partial';
      entry.failures = failures;
      console.error(`session-start-maintenance: ${failures.length} step(s) failed — ${failures.join('; ')} (retry after ${Math.min(interval, PARTIAL_RETRY_MIN)}m)`);
    } else {
      entry.action = 'ran';
    }
    fs.writeFileSync(stamp, JSON.stringify({ at: new Date().toISOString(), action: entry.action }));
  } catch (e) {
    entry.error = e instanceof Error ? e.message : String(e);
    console.error('session-start-maintenance:', entry.error);
  } finally {
    entry.duration_ms = Date.now() - started;
    appendLog(entry);
    release(claimDir);
  }
}

ensureNativeAbi('session-start-maintenance');
main().catch((error) => {
  // Failures before the claim (state dir, log dir) — the claimed run logs its own.
  console.error('session-start-maintenance:', error instanceof Error ? error.message : error);
  appendLog({ action: 'failed', error: error instanceof Error ? error.message : String(error) });
});
