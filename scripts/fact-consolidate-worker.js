#!/usr/bin/env node

/**
 * Detached worker spawned by fact-consolidate-hook.js.
 * Runs LLM-based fact consolidation without blocking SessionStart.
 *
 * Environment:
 *   CWD                  - project path (canonical: absolute path)
 *   LAST_CONSOLIDATED_AT - last consolidation time (default: 24h ago)
 *
 * This process is started with stdio ignored, so the file log is the only
 * place a failure can be seen. Whenever a run fails on a fact it appends
 *   worker: ERROR fact=<id> kind=<internal|transient|deterministic|unknown> msg=<message>
 * whether or not an LLM call was made, and a run that ends held on a fact is
 * counted in state/fact-consolidate-health.json (first failure time,
 * consecutive failures, fact id, message). The cursor stays in front of a fact
 * that fails for an internal reason; after more than 5 such runs in a row the
 * next attempts are spaced out (5 min doubling, at most 6 h) instead of one per
 * session start. A run that ends any other way removes the record.
 */

import fs from 'node:fs';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { consolidateAllPending } from '../dist/consolidator.js';
import { getIndexDir } from '../dist/paths.js';
import { pluginVersion } from '../dist/inject-log.js';
import {
  consolidateCursorPath,
  consolidateStartCursor,
  consolidateHealthPath,
  loadConsolidateHealth,
  nextConsolidateHealth,
  saveConsolidateHealth,
  consolidateBackoffUntil,
} from '../dist/consolidate-health.js';

// GLOBAL single-instance lock (NOT per-project): consolidation touches shared
// global-scope facts (getAllNewFactsSince spans every scope), so concurrent
// per-project workers would race on the same rows. One lock-holder processes
// the ENTIRE backlog in a single pass — every new fact once, one Haiku budget —
// so no project is starved and shared globals aren't reprocessed per project.
// This kills the flood: the SessionStart hook re-spawns this worker on every
// session with no lock (measured 14 orphaned ppid=1 workers at once, each
// spawning a headless Claude session per LLM call).
const LOCK = path.join(getIndexDir(), 'fact-consolidate.lock');
// Persisted progress cursor: without it, INDEPENDENT facts (which stay active)
// would re-consume the whole Haiku budget on the same oldest rows every run and
// never reach newer backlog. Each run resumes from the last fully-examined
// created_at. Keyset cursor persisted as JSON { createdAt, id }; it is read
// through consolidate-health.ts, the same reader the SessionStart hook uses to
// decide whether to start this worker.
const CURSOR = consolidateCursorPath();

function writeCursor(cursor) {
  if (!cursor || typeof cursor.createdAt !== 'string' || typeof cursor.id !== 'string') return;
  try {
    const tmp = `${CURSOR}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cursor));
    fs.renameSync(tmp, CURSOR); // atomic
  } catch (error) {
    // The run's work is done either way, but without the cursor the next run
    // starts where this one started and pays for the same comparisons again.
    log(`worker: cursor not written (${oneLine(error instanceof Error ? error.message : error)}) — the next run repeats this one`);
  }
}

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  try {
    fs.appendFileSync(path.join(getIndexDir(), 'fact-consolidate.log'), msg + '\n');
  } catch {
    // best-effort logging
  }
  console.log(msg);
}

// Atomic exclusive create ('wx') + pid-liveness check so a stale lock from a
// killed worker is cleared and re-acquired.
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      try {
        const pid = parseInt(fs.readFileSync(LOCK, 'utf8'), 10);
        if (pid && !Number.isNaN(pid)) {
          try { process.kill(pid, 0); return false; } // alive → don't run
          catch { /* stale lock */ }
        }
        fs.unlinkSync(LOCK); // stale — remove and retry the exclusive create
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseLock() {
  try {
    if (parseInt(fs.readFileSync(LOCK, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK);
  } catch { /* ignore */ }
}

/** One log line's worth of an error message. */
function oneLine(message) {
  return String(message).replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Count this run in the health record (or clear it) and log where the streak
 * stands. `failure` is the failure the run ended held on, null otherwise.
 */
function recordHealth(previous, progressed, failure, version) {
  const next = nextConsolidateHealth(previous, { progressed, failure }, new Date(), version);
  try {
    saveConsolidateHealth(next);
  } catch (error) {
    log(`worker: health record not written (${oneLine(error instanceof Error ? error.message : error)})`);
  }
  if (next) {
    log(`worker: held consecutive_failures=${next.consecutiveFailures} since=${next.firstFailureAt} next_attempt=${next.nextAttemptAt ?? 'next start'}`);
  }
}

async function main() {
  if (!acquireLock()) {
    // Another consolidate worker already holds the GLOBAL lock — exit cleanly.
    // It processes the whole backlog (every scope/project), so nothing is lost;
    // this session's spawn simply steps aside instead of piling up.
    process.exit(0);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  // Runs that keep ending held on the same fact are spaced out (see header).
  // Read under the lock, so two workers never count the same run twice.
  const version = pluginVersion() ?? null;
  const { health, problem } = loadConsolidateHealth();
  if (problem) log(`worker: health record unreadable (${problem}) — the failure count starts over`);
  const waitUntil = consolidateBackoffUntil(health, new Date(), version);
  if (waitUntil) {
    // Console only: a line per skipped start would fill the log the way the
    // failing runs did. The record itself says when the next attempt is.
    console.log(`fact-consolidate: not run — ${health.consecutiveFailures} runs in a row ended on the same failure; next attempt at ${waitUntil} (remove ${consolidateHealthPath()} to retry now)`);
    return;
  }

  // Resume from the persisted keyset cursor. Absent/legacy/corrupt cursor →
  // start from the BEGINNING (null) so no active fact is ever skipped — the
  // per-run Haiku budget only caps actual consolidation CALLS, and facts with
  // no similar candidate don't consume budget, so the whole backlog drains
  // across a few runs regardless of age. An explicit LAST_CONSOLIDATED_AT env
  // (manual/scoped runs) still seeds a starting timestamp.
  const since = consolidateStartCursor();

  let db;
  let progressed = false;
  let failure = null;
  try {
    db = initDatabase();
    // One pass over the backlog after the cursor: every new fact once, single
    // Haiku budget, then advance the cursor so the next run reaches newer rows.
    const result = await consolidateAllPending(db, since);
    writeCursor(result.cursor);
    progressed = result.processed > 0;
    if (result.haikuCalls > 0) {
      log(`worker: processed=${result.processed} haiku=${result.haikuCalls} merged=${result.merged} contradictions=${result.contradictions} evolutions=${result.evolutions} cursor=${JSON.stringify(result.cursor)}`);
    }
    if (result.cappedSearches > 0) {
      log(`worker: WARN knn_cap_reached=${result.cappedSearches} — that many candidate searches stopped at the KNN limit with matches possibly unread`);
    }
    // Logged whatever the call count: an error before the LLM is reached makes
    // no call, and that is exactly the run that used to leave no usable trace.
    const e = result.lastError;
    if (e) {
      log(`worker: ERROR fact=${e.factId} kind=${e.kind} msg=${oneLine(e.message)}${e.held ? '' : ' (skipped past after repeated rejections)'}`);
      if (e.held) failure = { factId: e.factId, kind: e.kind, message: e.message };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`worker: FATAL ${message}`);
    failure = { factId: null, kind: 'fatal', message };
    process.exitCode = 0;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  recordHealth(health, progressed, failure, version);
}

main();
