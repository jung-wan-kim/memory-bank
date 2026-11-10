import type Database from 'better-sqlite3';
import { DELETE_BATCH_MAX_MS, deleteExchanges, pauseForOtherWriters } from './db.js';
import { writeRowBackup } from './row-backup.js';

/**
 * One-time cleanup of duplicate snapshots of a turn.
 *
 * An exchange id is md5(path:userLine-lastAssistantLine). A turn indexed while
 * its answer was still being written got a new id on every later sync, and the
 * shorter snapshots stayed behind (measured on one index 2026-11-10: 3,937
 * turns with 11,981 extra rows in 1,767 files, up to 102 rows for one turn).
 * insertExchange removes older snapshots as it writes now; this handles the
 * rows that were already there.
 *
 * Per (archive_path, line_start) the row with the largest line_end stays — the
 * transcript is append-only, so that is the fullest version of the turn. Facts
 * that name a removed row in source_exchange_ids are pointed at the row that
 * stays (13,573 facts on the measured index), so `trace_fact` keeps resolving.
 */

/** temp table: one row per snapshot to remove, with the id of the row that stays. */
const STALE = 'snapshot_stale';

export interface SnapshotDedupePlan {
  /** Turns that have more than one row. */
  turns: number;
  /** Rows to remove (every row of those turns but one). */
  extraRows: number;
  /** Conversation files those turns are in. */
  files: number;
  /** Most rows held for a single turn. */
  maxRowsPerTurn: number;
  /** Facts whose source_exchange_ids name a row to remove. */
  factsToRewrite: number;
  /** Facts whose source_exchange_ids is not valid JSON — left alone, not searched. */
  factsWithInvalidSources: number;
}

/**
 * Find the duplicate snapshots (fills temp.snapshot_stale) and count what an
 * apply would do. Reads only — safe on a read-only connection (the worklist
 * lives in the temp schema).
 */
export function planSnapshotDedupe(db: Database.Database): SnapshotDedupePlan {
  db.exec(`DROP TABLE IF EXISTS temp.${STALE}`);
  db.exec(`
    CREATE TEMP TABLE ${STALE} AS
    WITH ranked AS (
      SELECT id, archive_path,
             first_value(id) OVER w AS keep_id,
             row_number() OVER w AS rn
      FROM main.exchanges
      WINDOW w AS (PARTITION BY archive_path, line_start ORDER BY line_end DESC, last_indexed DESC, rowid DESC)
    )
    SELECT id, keep_id, archive_path FROM ranked WHERE rn > 1
  `);
  db.exec(`CREATE UNIQUE INDEX temp.${STALE}_id ON ${STALE}(id)`);
  const one = <T>(sql: string) => db.prepare(sql).get() as T;
  const shape = one<{ extraRows: number; turns: number; files: number }>(
    `SELECT count(*) AS extraRows, count(DISTINCT keep_id) AS turns, count(DISTINCT archive_path) AS files FROM temp.${STALE}`);
  const max = one<{ n: number | null }>(
    `SELECT max(c) + 1 AS n FROM (SELECT count(*) AS c FROM temp.${STALE} GROUP BY keep_id)`);
  const facts = one<{ n: number }>(`
    SELECT count(DISTINCT f.id) AS n
    FROM main.facts f, json_each(f.source_exchange_ids) j
    WHERE json_valid(f.source_exchange_ids) AND j.value IN (SELECT id FROM temp.${STALE})`);
  const invalid = one<{ n: number }>(
    `SELECT count(*) AS n FROM main.facts WHERE source_exchange_ids IS NOT NULL AND NOT json_valid(source_exchange_ids)`);
  return {
    turns: shape.turns,
    extraRows: shape.extraRows,
    files: shape.files,
    maxRowsPerTurn: max.n ?? 0,
    factsToRewrite: facts.n,
    factsWithInvalidSources: invalid.n,
  };
}

export interface SnapshotDedupeResult {
  plan: SnapshotDedupePlan;
  backupPath: string | null;
  deletedRows: number;
  rewrittenFacts: number;
  /** Duplicate rows still there after the run (0 unless another process wrote some meanwhile). */
  remainingExtraRows: number;
}

/** Facts whose source list is re-pointed in one write transaction (see repointFactsAtKeptSnapshots). */
export const REPOINT_BATCH_ROWS = 500;

export interface RepointFactsOptions {
  /** Facts per write transaction (default REPOINT_BATCH_ROWS). */
  batchSize?: number;
  /** Commit a batch once it has held the write lock this long (default DELETE_BATCH_MAX_MS). 0 = one fact per batch. */
  maxBatchMs?: number;
  /** Wait this long between two batches (default DELETE_BATCH_PAUSE_MS). 0 = none. */
  pauseMs?: number;
  /** Called after each committed batch with the facts gone through so far; no transaction is open here. */
  onBatch?: (done: number) => void;
}

const staleIds = `SELECT id FROM temp.${STALE}`;
/** Facts whose source list names a snapshot to remove, with the list as stored. */
const affectedFacts = `
    SELECT DISTINCT f.id AS id, f.source_exchange_ids AS source_exchange_ids
    FROM main.facts f, json_each(f.source_exchange_ids) j
    WHERE json_valid(f.source_exchange_ids) AND j.value IN (${staleIds})`;

/**
 * Point the facts that name a snapshot in temp.snapshot_stale at the row that
 * stays (planSnapshotDedupe must have filled the table on this connection).
 * Returns how many facts were changed. The fact itself is not touched —
 * updated_at stays.
 *
 * It was one write transaction that searched every fact's source list
 * (json_each over 61MB on the measured DB) and then wrote 13,573 rows: the
 * write lock was held for 3.3 to 5.4s, and every other process waits 5s for
 * it and then fails. Now, the shape repointQueuedExchangeSources (db.ts) has:
 *  1. the search and the new lists are done WITHOUT the write lock;
 *  2. the writes go REPOINT_BATCH_ROWS facts per transaction (or until the
 *     batch has taken DELETE_BATCH_MAX_MS), with a pause between two batches
 *     in which a waiting process takes the lock;
 *  3. inside its batch each fact is read again: unchanged since step 1, it
 *     gets the list computed there; changed meanwhile, the list is computed
 *     from what is stored now (and left alone if that names no such snapshot).
 * A run that stops between two batches has re-pointed some facts and not the
 * others; no row was deleted yet, and running it again finishes.
 */
export function repointFactsAtKeptSnapshots(db: Database.Database, opts: RepointFactsOptions = {}): number {
  const batchSize = opts.batchSize ?? REPOINT_BATCH_ROWS;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(`invalid batch size: ${batchSize}`);
  const maxBatchMs = opts.maxBatchMs ?? DELETE_BATCH_MAX_MS;
  const keepOf = new Map<string, string>(
    (db.prepare(`SELECT id, keep_id FROM temp.${STALE}`).all() as Array<{ id: string; keep_id: string }>).map((r) => [r.id, r.keep_id]));
  if (keepOf.size === 0) return 0;

  /** The re-pointed list for a stored one; null when it is not a JSON array or names no snapshot to remove. */
  const repointed = (stored: string | null): string | null => {
    if (!stored) return null;
    let list: unknown;
    try { list = JSON.parse(stored); } catch { return null; }
    if (!Array.isArray(list) || !list.some((v) => typeof v === 'string' && keepOf.has(v))) return null;
    const after: unknown[] = [];
    for (const v of list) {
      const mapped = typeof v === 'string' ? (keepOf.get(v) ?? v) : v;
      if (!after.includes(mapped)) after.push(mapped); // two snapshots of one turn become one entry
    }
    return JSON.stringify(after);
  };

  // 1. No write lock: which facts, and what their list becomes.
  const work: Array<{ id: string; stored: string; after: string }> = [];
  for (const fact of db.prepare(affectedFacts).all() as Array<{ id: string; source_exchange_ids: string }>) {
    const after = repointed(fact.source_exchange_ids);
    if (after !== null) work.push({ id: fact.id, stored: fact.source_exchange_ids, after });
  }

  // 2. + 3. Short write transactions; `next` moves only after the commit.
  const read = db.prepare('SELECT source_exchange_ids AS stored FROM facts WHERE id = ?');
  const write = db.prepare('UPDATE facts SET source_exchange_ids = ? WHERE id = ?');
  let next = 0;
  let rewritten = 0;
  const writeBatch = db.transaction((): { taken: number; changed: number } => {
    const started = Date.now();
    let taken = 0;
    let changed = 0;
    while (next + taken < work.length && taken < batchSize) {
      const item = work[next + taken];
      taken++;
      const now = read.get(item.id) as { stored: string | null } | undefined;
      const after = now === undefined ? null : now.stored === item.stored ? item.after : repointed(now.stored);
      if (after !== null) {
        write.run(after, item.id);
        changed++;
      }
      if (Date.now() - started >= maxBatchMs) break;
    }
    return { taken, changed };
  });
  while (next < work.length) {
    const { taken, changed } = writeBatch.immediate();
    next += taken;
    rewritten += changed;
    opts.onBatch?.(next);
    if (next < work.length) pauseForOtherWriters(opts.pauseMs);
  }
  return rewritten;
}

export interface SnapshotDedupeOptions {
  /** How the fact sources are re-pointed (batch size, pauses, progress). */
  repoint?: RepointFactsOptions;
}

/**
 * Back up, re-point the facts, delete the extra rows. Order matters for an
 * interrupted run: facts are re-pointed BEFORE the rows go, so no fact ever
 * names a deleted row; a re-run finds the rows that are left and finishes.
 */
export function applySnapshotDedupe(
  db: Database.Database,
  backupPath: string,
  opts: SnapshotDedupeOptions = {},
): SnapshotDedupeResult {
  const plan = planSnapshotDedupe(db);
  if (plan.extraRows === 0) {
    return { plan, backupPath: null, deletedRows: 0, rewrittenFacts: 0, remainingExtraRows: 0 };
  }

  const backedUp = writeRowBackup(db, backupPath, [
    { table: 'exchanges', select: `SELECT * FROM main.exchanges WHERE id IN (${staleIds})` },
    { table: 'tool_calls', select: `SELECT * FROM main.tool_calls WHERE exchange_id IN (${staleIds})` },
    { table: 'snapshot_map', select: `SELECT id, keep_id, archive_path FROM temp.${STALE}` },
    { table: 'facts_sources_before', select: affectedFacts },
  ]);
  if (backedUp.exchanges !== plan.extraRows) {
    throw new Error(`backup holds ${backedUp.exchanges} exchange rows, expected ${plan.extraRows} — nothing was changed (${backupPath})`);
  }

  // The rows to delete — the list the backup holds, in the order it was always deleted in.
  const toDelete = (db.prepare(`SELECT id, keep_id FROM temp.${STALE}`).all() as Array<{ id: string }>).map((r) => r.id);
  const rewrittenFacts = repointFactsAtKeptSnapshots(db, opts.repoint);

  const deletedRows = deleteExchanges(db, toDelete);
  const remaining = planSnapshotDedupe(db).extraRows;
  return { plan, backupPath, deletedRows, rewrittenFacts, remainingExtraRows: remaining };
}
