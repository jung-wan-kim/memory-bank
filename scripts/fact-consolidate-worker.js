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
 * place a run can be seen. A run that made a comparison call appends
 *   worker: processed=<n> haiku=<calls> merged=<n> contradictions=<n> evolutions=<n> rewritten=<n> kr_missing=<n> cursor=<json>
 * (rewritten = facts whose sentence changed; kr_missing = of those, facts left
 * without a Korean sentence because none existed for the new sentence — they
 * answer Korean queries through the main vector only until fact_kr is filled;
 * changed_pairs, only when not 0 = verdicts not applied because one of the two
 * facts was switched off or rewritten while the call was in flight).
 * Whenever a run fails on a fact it appends
 *   worker: ERROR fact=<id> kind=<internal|transient|deterministic|unknown> msg=<message>
 * whether or not an LLM call was made, and a run that ends held on a fact is
 * counted in state/fact-consolidate-health.json (first failure time,
 * consecutive failures, fact id, message). The cursor stays in front of a fact
 * that fails for an internal reason; after more than 5 such runs in a row the
 * next attempts are spaced out (5 min doubling, at most 6 h) instead of one per
 * session start. A run that ends any other way removes the record.
 *
 * A stored time ahead of the clock is not believed, and each case is logged
 * (consolidate-health.ts): a next-attempt time further out than the longest
 * wait is not waited for, a cursor ahead of the clock is pulled back to now
 * (and written back), a cursor file that cannot be used starts the walk over.
 */

import fs from 'node:fs';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { consolidateAllPending } from '../dist/consolidator.js';
import { getIndexDir } from '../dist/paths.js';
import { pluginVersion } from '../dist/inject-log.js';
import { restoreKoreanOncePerVersion } from '../dist/fact-kr-restore.js';
import {
  consolidateCursorPath,
  consolidateStart,
  consolidateHealthPath,
  loadConsolidateHealth,
  nextConsolidateHealth,
  saveConsolidateHealth,
  consolidateBackoffUntil,
  consolidateBackoffAheadOfClock,
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

/**
 * Facts that an earlier rewrite left without a Korean sentence get it back from
 * the fact that was merged into them (fact-kr-restore.ts) — no LLM call, once
 * per plugin version. A failure is logged here and is not a failed run: the
 * drain's own outcome is what the health record counts.
 */
async function restoreKoreanSentences(db, version) {
  try {
    const r = await restoreKoreanOncePerVersion(db, version, async (text) => {
      const { generateEmbedding } = await import('../dist/embeddings.js');
      return generateEmbedding(text);
    });
    if (r && r.candidates > 0) {
      log(`worker: fact_kr restored=${r.restored} of ${r.candidates} rewritten facts without a Korean sentence${r.remaining > 0 ? ` (${r.remaining} more on the next run)` : ''}`);
    }
  } catch (error) {
    log(`worker: fact_kr restore failed (${oneLine(error instanceof Error ? error.message : error)}) — not repeated for this version`);
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
  const now = new Date();
  const aheadOfClock = consolidateBackoffAheadOfClock(health, now, version);
  if (aheadOfClock) {
    // Logged once: this run rewrites the record (or removes it) from the real clock.
    log(`worker: recorded next attempt ${aheadOfClock} is further ahead of the clock than the longest wait (6 h) — not waited for, running now`);
  }
  const waitUntil = consolidateBackoffUntil(health, now, version);
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
  const start = consolidateStart(now);
  if (start.problem) log(`worker: cursor file unusable (${oneLine(start.problem)}) — starting from the beginning`);
  // Written back at the end of this run (writeCursor), so it is said once.
  if (start.clampedFrom) log(`worker: cursor time ${start.clampedFrom} is ahead of the clock — pulled back to ${start.cursor.createdAt}`);
  const since = start.cursor;

  let db;
  let progressed = false;
  let failure = null;
  try {
    db = initDatabase();
    // One pass over the backlog after the cursor: every new fact once, single
    // Haiku budget, then advance the cursor so the next run reaches newer rows.
    const result = await consolidateAllPending(db, since, { now });
    writeCursor(result.cursor);
    progressed = result.processed > 0;
    if (result.haikuCalls > 0) {
      log(`worker: processed=${result.processed} haiku=${result.haikuCalls} merged=${result.merged} contradictions=${result.contradictions} evolutions=${result.evolutions} rewritten=${result.rewrites} kr_missing=${result.rewritesWithoutKorean}${result.changedPairs > 0 ? ` changed_pairs=${result.changedPairs}` : ''} cursor=${JSON.stringify(result.cursor)}`);
    }
    // Only with the cursor message above: these facts wait on every run until
    // their time comes, and a line per run would bury the log.
    if (start.clampedFrom && result.aheadOfClock > 0) {
      log(`worker: WARN facts_ahead_of_clock=${result.aheadOfClock} — active facts dated later than now are not compared until their time comes`);
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
    // Only after a drain that did not end stuck — a store that just failed is not the place for a repair.
    if (!failure) await restoreKoreanSentences(db, version);
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
