import type Database from 'better-sqlite3';
import { deleteExchanges } from './db.js';
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

/**
 * Back up, re-point the facts, delete the extra rows. Order matters for an
 * interrupted run: facts are re-pointed BEFORE the rows go, so no fact ever
 * names a deleted row; a re-run finds the rows that are left and finishes.
 */
export function applySnapshotDedupe(db: Database.Database, backupPath: string): SnapshotDedupeResult {
  const plan = planSnapshotDedupe(db);
  if (plan.extraRows === 0) {
    return { plan, backupPath: null, deletedRows: 0, rewrittenFacts: 0, remainingExtraRows: 0 };
  }

  const staleIds = `SELECT id FROM temp.${STALE}`;
  const affectedFacts = `
    SELECT DISTINCT f.id AS id, f.source_exchange_ids AS source_exchange_ids
    FROM main.facts f, json_each(f.source_exchange_ids) j
    WHERE json_valid(f.source_exchange_ids) AND j.value IN (${staleIds})`;
  const backedUp = writeRowBackup(db, backupPath, [
    { table: 'exchanges', select: `SELECT * FROM main.exchanges WHERE id IN (${staleIds})` },
    { table: 'tool_calls', select: `SELECT * FROM main.tool_calls WHERE exchange_id IN (${staleIds})` },
    { table: 'snapshot_map', select: `SELECT id, keep_id, archive_path FROM temp.${STALE}` },
    { table: 'facts_sources_before', select: affectedFacts },
  ]);
  if (backedUp.exchanges !== plan.extraRows) {
    throw new Error(`backup holds ${backedUp.exchanges} exchange rows, expected ${plan.extraRows} — nothing was changed (${backupPath})`);
  }

  // Re-point facts, one transaction.
  const keepOf = new Map<string, string>(
    (db.prepare(`SELECT id, keep_id FROM temp.${STALE}`).all() as Array<{ id: string; keep_id: string }>).map((r) => [r.id, r.keep_id]));
  const update = db.prepare('UPDATE facts SET source_exchange_ids = ? WHERE id = ?');
  const rewrittenFacts = db.transaction(() => {
    let n = 0;
    for (const fact of db.prepare(affectedFacts).all() as Array<{ id: string; source_exchange_ids: string }>) {
      const before = JSON.parse(fact.source_exchange_ids) as unknown[];
      const after: unknown[] = [];
      for (const v of before) {
        const mapped = typeof v === 'string' ? (keepOf.get(v) ?? v) : v;
        if (!after.includes(mapped)) after.push(mapped);
      }
      update.run(JSON.stringify(after), fact.id);
      n++;
    }
    return n;
  }).immediate();

  const deletedRows = deleteExchanges(db, [...keepOf.keys()]);
  const remaining = planSnapshotDedupe(db).extraRows;
  return { plan, backupPath, deletedRows, rewrittenFacts, remainingExtraRows: remaining };
}
