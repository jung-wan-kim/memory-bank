/**
 * What the consolidate worker keeps between runs besides the facts themselves:
 * the drain cursor and a health record of runs that ended stuck.
 *
 * Why the health record exists (2026-10-16 ~ 11-10): the worker runs detached
 * with stdio ignored, so an error it prints reaches no one. One failing
 * candidate search held the cursor on the same fact for 2,552 runs — up to 839
 * a day, each a node start plus a DB open — and the only trace was a summary
 * line that read like a successful LLM call. Now a run that ends held on a
 * fact is counted, the count survives across runs, and after
 * CONSOLIDATE_BACKOFF_AFTER of them in a row the next attempts are spaced out.
 * The cursor still does NOT move past a fact that fails for an internal reason:
 * skipping would turn a bug into silently unconsolidated facts.
 *
 * The SessionStart hook reads the same two files through `consolidateWorkerGate`
 * (on its read-only handle) to decide whether starting the worker is worth a
 * process at all — hook and worker must agree on where the cursor is, so both
 * read it here.
 *
 * Neither file's times are believed when they lie ahead of the clock. A
 * next-attempt time written while the clock was ahead kept every start from
 * running, and a cursor written then made every fact created since read as
 * already examined — both without a line anywhere (a skipped start logs
 * nothing). A next-attempt time further out than the longest wait this code
 * records is not waited for, a cursor ahead of the clock is pulled back to
 * now, and a fact dated ahead of the clock is left alone until its time comes
 * (so the cursor is never moved ahead of the clock again). The worker logs each.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getIndexDir } from './paths.js';

// ── Cursor ──────────────────────────────────────────────────────────────────

/** Keyset position `(created_at, id)` of the last fact the drain fully examined. */
export interface ConsolidateCursor { createdAt: string; id: string }

export function consolidateCursorPath(): string {
  return path.join(getIndexDir(), 'fact-consolidate-cursor.txt');
}

/**
 * The cursor file as it stands. `problem` is set when a file exists but cannot
 * be used (unreadable, not JSON — a legacy bare timestamp included — or the
 * wrong shape): the run then starts from the beginning, which costs the whole
 * walk again, and the caller must say so. No file is not a problem.
 */
export function loadConsolidateCursor(): { cursor: ConsolidateCursor | null; problem: string | null } {
  let raw: string;
  try {
    raw = fs.readFileSync(consolidateCursorPath(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { cursor: null, problem: null };
    return { cursor: null, problem: e instanceof Error ? e.message : String(e) };
  }
  let c: { createdAt?: unknown; id?: unknown } | null;
  try {
    c = JSON.parse(raw);
  } catch {
    return { cursor: null, problem: 'not JSON' };
  }
  if (c !== null && typeof c === 'object' && typeof c.createdAt === 'string' && typeof c.id === 'string' && !Number.isNaN(Date.parse(c.createdAt))) {
    return { cursor: { createdAt: c.createdAt, id: c.id }, problem: null };
  }
  return { cursor: null, problem: 'unexpected shape' };
}

/** The persisted cursor; null when absent, legacy or corrupt (= start from the beginning). */
export function readConsolidateCursor(): ConsolidateCursor | null {
  return loadConsolidateCursor().cursor;
}

/** Where a run starts, and what had to be said about the stored position. */
export interface ConsolidateStart {
  /** The start position (null = the beginning). Never ahead of `now`. */
  cursor: ConsolidateCursor | null;
  /** Why the cursor file could not be used (the run starts from the beginning), else null. */
  problem: string | null;
  /** The stored time, when it lay ahead of the clock and `cursor` was pulled back to `now`; else null. */
  clampedFrom: string | null;
}

/**
 * Where the next run starts: the persisted cursor, else an explicit
 * LAST_CONSOLIDATED_AT (manual/scoped runs), else null — the beginning, so no
 * active fact is ever skipped.
 *
 * A stored time ahead of the clock (written while the clock was ahead) is
 * pulled back to `now`: left as it was, every fact created at the real time
 * sorts before it and is never pending. The worker writes the pulled-back
 * cursor to the file at the end of its run, so this happens once. Facts
 * created between the clock's return and that run are not driven by this pass
 * (they stay candidates of later facts) — the same accepted limit as a fact
 * imported with an old created_at (getAllNewFactsSince).
 */
export function consolidateStart(now: Date, env: NodeJS.ProcessEnv = process.env): ConsolidateStart {
  const { cursor, problem } = loadConsolidateCursor();
  const stored = cursor ?? (env.LAST_CONSOLIDATED_AT ? { createdAt: env.LAST_CONSOLIDATED_AT, id: '' } : null);
  if (stored && Date.parse(stored.createdAt) > now.getTime()) {
    return { cursor: { createdAt: now.toISOString(), id: '' }, problem, clampedFrom: stored.createdAt };
  }
  return { cursor: stored, problem, clampedFrom: null };
}

/** consolidateStart's position alone (see there). */
export function consolidateStartCursor(env: NodeJS.ProcessEnv = process.env): ConsolidateCursor | null {
  return consolidateStart(new Date(), env).cursor;
}

/**
 * Whether any active fact lies after the cursor and not after `now` — the same
 * keyset predicate and time bound as the drain's getAllNewFactsSince, served by
 * idx_facts_active_created_id. Plain SQL only: it runs on the hook's read-only
 * handle, which has no sqlite-vec loaded.
 */
export function hasPendingConsolidation(db: Database.Database, cursor: ConsolidateCursor | null, now: Date = new Date()): boolean {
  const notAfter = now.toISOString();
  const row = cursor
    ? db.prepare(
        'SELECT 1 FROM facts WHERE is_active = 1 AND (created_at > ? OR (created_at = ? AND id > ?)) AND created_at <= ? LIMIT 1'
      ).get(cursor.createdAt, cursor.createdAt, cursor.id, notAfter)
    : db.prepare('SELECT 1 FROM facts WHERE is_active = 1 AND created_at <= ? LIMIT 1').get(notAfter);
  return row !== undefined;
}

// ── Health ──────────────────────────────────────────────────────────────────

/** consolidator.ts's ConsolidationErrorKind, plus 'fatal': the run died outside any fact (DB open, lock). */
export type ConsolidateFailureKind = 'internal' | 'transient' | 'deterministic' | 'unknown' | 'fatal';

/** The failure a run ended held on. factId is null for a 'fatal' one. */
export interface ConsolidateFailure {
  factId: string | null;
  kind: ConsolidateFailureKind;
  message: string;
}

/** state/fact-consolidate-health.json — present only while runs keep ending held. */
export interface ConsolidateHealth {
  /** When the current streak of held runs began. */
  firstFailureAt: string;
  lastFailureAt: string;
  /** Runs in a row that ended held without the cursor moving first. */
  consecutiveFailures: number;
  factId: string | null;
  kind: ConsolidateFailureKind;
  message: string;
  /** No run before this time (backoff); null while the streak is short. */
  nextAttemptAt: string | null;
  /** Version that recorded the streak — a different version retries at once (it may carry the fix). */
  pluginVersion: string | null;
}

/** Held runs in a row that are retried on every start; from the next one on, attempts are spaced out. */
export const CONSOLIDATE_BACKOFF_AFTER = 5;
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 6 * 60 * 60_000;
const MESSAGE_MAX_CHARS = 500;

/** Wait before the next attempt: 0 up to the limit, then 5 min doubling per further failure, at most 6 h. */
export function consolidateBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= CONSOLIDATE_BACKOFF_AFTER) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveFailures - CONSOLIDATE_BACKOFF_AFTER - 1), BACKOFF_MAX_MS);
}

export function consolidateHealthPath(): string {
  return path.join(getIndexDir(), 'state', 'fact-consolidate-health.json');
}

const FAILURE_KINDS: readonly string[] = ['internal', 'transient', 'deterministic', 'unknown', 'fatal'];
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/**
 * Read the health record. `problem` is set when a file exists but cannot be
 * used (unreadable, not JSON, wrong shape): the caller then starts a new
 * streak and must say so — a record that vanishes without a word would reset
 * the backoff unnoticed. Every field a consumer reads is checked here.
 */
export function loadConsolidateHealth(): { health: ConsolidateHealth | null; problem: string | null } {
  let raw: string;
  try {
    raw = fs.readFileSync(consolidateHealthPath(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { health: null, problem: null };
    return { health: null, problem: e instanceof Error ? e.message : String(e) };
  }
  let h: Partial<ConsolidateHealth> | null;
  try {
    h = JSON.parse(raw);
  } catch {
    return { health: null, problem: 'not JSON' };
  }
  const valid = h !== null && typeof h === 'object'
    && isTime(h.firstFailureAt) && isTime(h.lastFailureAt)
    && Number.isInteger(h.consecutiveFailures) && (h.consecutiveFailures as number) >= 1
    && (h.factId === null || typeof h.factId === 'string')
    && typeof h.kind === 'string' && FAILURE_KINDS.includes(h.kind)
    && typeof h.message === 'string'
    && (h.nextAttemptAt === null || isTime(h.nextAttemptAt))
    && (h.pluginVersion === null || typeof h.pluginVersion === 'string');
  if (!valid) return { health: null, problem: 'unexpected shape' };
  return { health: h as ConsolidateHealth, problem: null };
}

/**
 * The record after a run. `failure` is the failure the run ended HELD on (null
 * when it ended any other way — nothing pending, budget reached, or a fact
 * skipped past); `progressed` is whether the cursor moved during the run.
 *
 *  - no held failure            → null (the record is removed)
 *  - held, cursor did not move  → the streak continues: count + 1
 *  - held after the cursor moved → a new streak of 1 (a different fact is stuck)
 */
export function nextConsolidateHealth(
  prev: ConsolidateHealth | null,
  run: { progressed: boolean; failure: ConsolidateFailure | null },
  now: Date,
  pluginVersion: string | null,
): ConsolidateHealth | null {
  if (!run.failure) return null;
  const continues = prev !== null && !run.progressed;
  const consecutiveFailures = continues ? prev.consecutiveFailures + 1 : 1;
  const wait = consolidateBackoffMs(consecutiveFailures);
  return {
    // A streak cannot have begun after now: a start time written under a clock that was ahead is pulled back.
    firstFailureAt: continues && Date.parse(prev.firstFailureAt) <= now.getTime() ? prev.firstFailureAt : now.toISOString(),
    lastFailureAt: now.toISOString(),
    consecutiveFailures,
    factId: run.failure.factId,
    kind: run.failure.kind,
    message: run.failure.message.slice(0, MESSAGE_MAX_CHARS),
    nextAttemptAt: wait > 0 ? new Date(now.getTime() + wait).toISOString() : null,
    pluginVersion,
  };
}

/** Write the record (atomically), or remove it for null. Throws when it cannot — the caller logs that. */
export function saveConsolidateHealth(health: ConsolidateHealth | null): void {
  const file = consolidateHealthPath();
  if (health === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(health, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * The time before which no run should start, or null when a run may start now.
 * A record written by another plugin version does not hold a run back: the
 * installed code changed, so the failure may be gone.
 */
export function consolidateBackoffUntil(health: ConsolidateHealth | null, now: Date, pluginVersion: string | null): string | null {
  if (!health?.nextAttemptAt) return null;
  if (health.pluginVersion !== pluginVersion) return null;
  const waitMs = Date.parse(health.nextAttemptAt) - now.getTime();
  // No wait recorded here is longer than BACKOFF_MAX_MS. A time further out was
  // written under a clock that has since moved back: waiting for it would stop
  // consolidation for as long as the clock was off, with nothing in the log.
  return waitMs > 0 && waitMs <= BACKOFF_MAX_MS ? health.nextAttemptAt : null;
}

/**
 * The recorded next-attempt time when consolidateBackoffUntil does not wait
 * for it because it lies further ahead of the clock than the longest wait
 * (same version only) — for the worker to log before it runs. null otherwise.
 */
export function consolidateBackoffAheadOfClock(health: ConsolidateHealth | null, now: Date, pluginVersion: string | null): string | null {
  if (!health?.nextAttemptAt || health.pluginVersion !== pluginVersion) return null;
  return Date.parse(health.nextAttemptAt) - now.getTime() > BACKOFF_MAX_MS ? health.nextAttemptAt : null;
}

/**
 * Whether starting the consolidate worker is worth a process: not while a
 * backoff is running, and not when no active fact lies after the cursor. The
 * worker checks the backoff again itself (it can be started by hand).
 */
export function consolidateWorkerGate(
  db: Database.Database,
  now: Date,
  pluginVersion: string | null,
  env: NodeJS.ProcessEnv = process.env,
): { start: boolean; reason: string } {
  const until = consolidateBackoffUntil(loadConsolidateHealth().health, now, pluginVersion);
  if (until) return { start: false, reason: `backoff until ${until}` };
  const start = consolidateStart(now, env);
  // Only the worker can write the pulled-back cursor; until it has, every
  // check here would pull it back to its own "now" and find nothing pending.
  if (start.clampedFrom) return { start: true, reason: `cursor ${start.clampedFrom} is ahead of the clock` };
  return hasPendingConsolidation(db, start.cursor, now)
    ? { start: true, reason: 'pending facts' }
    : { start: false, reason: 'no pending facts' };
}

// ── Single-instance lock ────────────────────────────────────────────────────
//
// One consolidate worker at a time (why: scripts/fact-consolidate-worker.js).
// The lock is a file holding its owner's pid; a lock whose owner is dead is
// taken over.
//
// The takeover used to be "remove the stale file, then create mine". Two
// workers that read the same stale lock both removed a file and both created
// one: the later removal deleted the earlier worker's NEW lock, and both ran
// (measured: 1 of 30 simultaneous starts of two workers on a copy of the live
// store, 3 of 40 with four workers, 25 of 30 with eight processes running that
// lock code alone). A lock is mutual exclusion or it is nothing, so no step
// here removes a file another live worker may have just put there:
//
//  - a lock or claim appears with its pid already in it (a hard link to a
//    finished file) — no reader sees one without its owner;
//  - a stale file is replaced only by the worker that holds the claim on
//    (that file, that dead pid), after reading that the file still names that
//    pid, and the replacement is one rename. A worker that read the stale pid
//    earlier and comes late finds the claim taken, or another pid in the file;
//  - a claim left by a worker that died inside its takeover (the steps between
//    are synchronous: a kill at that instant) is taken over the same way, once.
//    A second unfinished takeover on top of that is not resolved by guessing:
//    the worker does not start and says which file is in the way.
//
// Not covered: a 1.7.x worker starting at the same instant still removes a
// stale lock its own way, and can remove the one this code just put there.

export function consolidateLockPath(): string {
  return path.join(getIndexDir(), 'fact-consolidate.lock');
}

/**
 * A lock file with no pid in it that is younger than this is held: builds up
 * to 1.7.9 create the file first and write the pid next. Older, it is what a
 * process that died in between left.
 */
const LOCK_WRITE_GRACE_MS = 60_000;

/** The pid in a lock file, 0 when it holds none. Throws when the file cannot be read (ENOENT: it is gone). */
function lockPid(file: string): number {
  const n = parseInt(fs.readFileSync(file, 'utf8'), 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let ownFileSeq = 0;
/** A finished file holding this pid, to be linked or renamed into place. */
function ownPidFile(target: string): string {
  const tmp = `${target}.${process.pid}.${++ownFileSeq}.tmp`;
  fs.writeFileSync(tmp, String(process.pid));
  return tmp;
}

/** Create `file` holding this pid unless a file of that name exists. */
function createOwned(file: string): boolean {
  const tmp = ownPidFile(file);
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function removeIfOwned(file: string): void {
  try {
    if (lockPid(file) === process.pid) fs.unlinkSync(file);
  } catch {
    // gone, or not ours
  }
}

/**
 * Replace `file` — left by the dead process `deadPid` (0: it holds no pid) —
 * with one holding this pid. false when another worker has it or is taking
 * it. Throws when it cannot be decided (see the block comment above).
 */
function takeOverStale(file: string, deadPid: number, depth: number): boolean {
  const claim = `${file}.takeover-${deadPid}`;
  if (!createOwned(claim)) {
    let claimant: number;
    try {
      claimant = lockPid(claim);
    } catch {
      return false; // the claim was removed just now: its owner is done with the file
    }
    if (claimant > 0 && processAlive(claimant)) return false; // being taken over right now
    if (depth >= 1) {
      throw new Error(`a lock takeover was left unfinished twice — remove ${claim} to let a worker start`);
    }
    if (!takeOverStale(claim, claimant, depth + 1)) return false;
  }
  // The claim is ours: nobody else replaces this file while it names deadPid.
  try {
    let current: number;
    try {
      current = lockPid(file);
    } catch {
      return false; // removed meanwhile (a release, or an older build's takeover)
    }
    if (current !== deadPid) return false; // another worker's by now
    if (deadPid > 0 && processAlive(deadPid)) return false; // that pid is a running process again
    const mine = ownPidFile(file);
    try {
      fs.renameSync(mine, file);
    } catch (e) {
      fs.rmSync(mine, { force: true });
      throw e;
    }
    return true;
  } finally {
    removeIfOwned(claim);
  }
}

/**
 * Take the consolidate lock. `acquired: false` without `problem` = another
 * worker holds it or is taking it — it drains the whole backlog, so stepping
 * aside loses nothing. With `problem`, the lock could not be set up at all
 * (missing or read-only directory, a file system without hard links, two
 * unfinished takeovers): the worker must not run, and must say why.
 */
export function acquireConsolidateLock(file: string = consolidateLockPath()): { acquired: boolean; problem?: string } {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (createOwned(file)) return { acquired: true };
      let holder: number;
      let ageMs: number;
      try {
        holder = lockPid(file);
        ageMs = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        continue; // released between the two looks — try the plain create once more
      }
      if (holder > 0 ? processAlive(holder) : ageMs < LOCK_WRITE_GRACE_MS) return { acquired: false };
      return { acquired: takeOverStale(file, holder, 0) };
    }
    return { acquired: false };
  } catch (e) {
    return { acquired: false, problem: e instanceof Error ? e.message : String(e) };
  }
}

/** Remove the lock if this process holds it. */
export function releaseConsolidateLock(file: string = consolidateLockPath()): void {
  removeIfOwned(file);
}
