import type Database from 'better-sqlite3';
import fs from 'fs';
import { EXCHANGES_FTS_AD_DDL, ensureExchangeTurnIndex, getVecQuant, initDatabase, vecParamSql } from './db.js';
import { newBackupPath, writeRowBackup } from './row-backup.js';
import { getArchiveDir } from './paths.js';
import { removeAllSummaries } from './archive-io.js';
import { verifyIndex, repairIndex, listArchiveConversations, RepairOutcome } from './verify.js';

/**
 * `index --rebuild`: regenerate the CONVERSATION index and nothing else.
 *
 * The command used to unlink the database file. That file has long held more
 * than the conversation index — facts, their revisions, the ontology, user
 * tags, the extraction log — none of which can be regenerated from the archive
 * (measured on one live DB: 46,507 facts, 42,801 relations, 7,146 categories
 * would have gone), and every other process holding the file open got
 * SQLITE_CORRUPT on its next statement. Now the file stays: only the
 * conversation-side tables are emptied, in place.
 */

export interface RebuildCounts {
  /** Kept as they are — the rebuild never writes these. */
  preserved: {
    facts: number;
    activeFacts: number;
    taggedFacts: number;
    relations: number;
    revisions: number;
    categories: number;
    domains: number;
    extractionLog: number;
  };
  /** Emptied, then re-created from the conversation archive. */
  cleared: { exchanges: number; toolCalls: number; vectors: number };
}

/** What the re-index after a clear can and cannot bring back. */
export interface RebuildReach {
  /** Conversation files the re-index reads (listArchiveConversations). */
  archiveConversations: number;
  /**
   * Indexed exchanges whose file is NOT one of those — in a sub-folder of its
   * project, in an excluded project, or gone from the archive. Clearing them
   * is final: no re-index of this code re-creates them.
   */
  unreachable: { exchanges: number; files: number };
  /** The archive paths of those exchanges (what the pre-rebuild backup copies). */
  unreachablePaths: string[];
}

/**
 * Compare what is indexed with what a re-index would read. Reads the path
 * index only (no row is visited).
 */
export function measureRebuildReach(db: Database.Database): RebuildReach {
  const listed = new Set(listArchiveConversations().map((c) => c.path));
  const unreachable = { exchanges: 0, files: 0 };
  const unreachablePaths: string[] = [];
  const perPath = db.prepare('SELECT archive_path AS p, count(*) AS n FROM exchanges GROUP BY archive_path').all() as Array<{ p: string; n: number }>;
  for (const { p, n: rows } of perPath) {
    if (listed.has(p)) continue;
    unreachable.exchanges += rows;
    unreachable.files++;
    unreachablePaths.push(p);
  }
  return { archiveConversations: listed.size, unreachable, unreachablePaths };
}

/**
 * Copy the exchanges (and their tool calls) indexed from the given archive
 * paths into a new sqlite file — the rows a rebuild is about to clear and
 * cannot re-create. Vectors are not copied (the re-embed worker makes a
 * missing one from the text).
 */
export function backupExchangesOfPaths(
  db: Database.Database,
  archivePaths: readonly string[],
  backupPath: string,
): { exchanges: number; toolCalls: number } {
  db.exec('CREATE TEMP TABLE IF NOT EXISTS rebuild_unreachable (p TEXT PRIMARY KEY)');
  db.exec('DELETE FROM temp.rebuild_unreachable');
  const add = db.prepare('INSERT OR IGNORE INTO temp.rebuild_unreachable (p) VALUES (?)');
  db.transaction(() => { for (const p of archivePaths) add.run(p); })();
  try {
    const rows = 'SELECT * FROM exchanges WHERE archive_path IN (SELECT p FROM temp.rebuild_unreachable)';
    const counts = writeRowBackup(db, backupPath, [
      { table: 'exchanges', select: rows },
      { table: 'tool_calls', select: `SELECT * FROM tool_calls WHERE exchange_id IN (SELECT id FROM (${rows}))` },
    ]);
    return { exchanges: counts.exchanges, toolCalls: counts.tool_calls };
  } finally {
    db.exec('DELETE FROM temp.rebuild_unreachable');
  }
}

const n = (db: Database.Database, sql: string): number => (db.prepare(sql).get() as { n: number }).n;

export function countForRebuild(db: Database.Database): RebuildCounts {
  return {
    preserved: {
      facts: n(db, 'SELECT count(*) AS n FROM facts'),
      activeFacts: n(db, 'SELECT count(*) AS n FROM facts WHERE is_active = 1'),
      taggedFacts: n(db, `SELECT count(*) AS n FROM facts WHERE tags IS NOT NULL AND tags NOT IN ('', '[]')`),
      relations: n(db, 'SELECT count(*) AS n FROM ontology_relations'),
      revisions: n(db, 'SELECT count(*) AS n FROM fact_revisions'),
      categories: n(db, 'SELECT count(*) AS n FROM ontology_categories'),
      domains: n(db, 'SELECT count(*) AS n FROM ontology_domains'),
      extractionLog: n(db, 'SELECT count(*) AS n FROM extraction_log'),
    },
    cleared: {
      exchanges: n(db, 'SELECT count(*) AS n FROM exchanges'),
      toolCalls: n(db, 'SELECT count(*) AS n FROM tool_calls'),
      vectors: n(db, 'SELECT count(*) AS n FROM vec_exchanges_rowids'),
    },
  };
}

/** The tables a rebuild must never lose — copied before anything is emptied. */
export const FACT_LAYER_TABLES = [
  'facts', 'fact_revisions', 'ontology_domains', 'ontology_categories', 'ontology_relations', 'extraction_log',
] as const;

/**
 * Copy the fact layer into a new sqlite file (rows only). The rebuild does not
 * touch these tables; the copy exists so that a bug or a crash in a command
 * that empties half of the database can never cost what cannot be re-derived.
 */
export function backupFactLayer(db: Database.Database, backupPath: string): Record<string, number> {
  return writeRowBackup(db, backupPath, FACT_LAYER_TABLES.map((table) => ({ table, select: `SELECT * FROM ${table}` })));
}

/**
 * Swap vec_exchanges for a fresh table of the same DDL that holds only the
 * vectors of the rows `exchanges` has right now, and rebuild the FTS index
 * from the content table — one write transaction.
 *
 * After a clear, `exchanges` is empty or holds the few rows another process
 * indexed since the last delete batch; those keep their vector (same bytes),
 * so no exchange row is ever left without one.
 */
export function resetVectorsAndTextIndex(db: Database.Database): { vectorsKept: number } {
  return db.transaction(() => {
    const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_exchanges'`).get() as { sql: string } | undefined)?.sql;
    if (!ddl) throw new Error('vec_exchanges: table does not exist');
    const getVector = db.prepare('SELECT embedding FROM vec_exchanges WHERE id = ?');
    const survivors: Array<{ id: string; embedding: Buffer }> = [];
    for (const row of db.prepare('SELECT id FROM exchanges').all() as Array<{ id: string }>) {
      const vec = getVector.get(row.id) as { embedding: Buffer } | undefined;
      if (vec) survivors.push({ id: row.id, embedding: Buffer.from(vec.embedding) });
    }
    db.exec('DROP TABLE vec_exchanges');
    db.exec(ddl);
    // Stored bytes go back as they are; the codec (dtype + scale) is read from
    // the re-created table inside this same write transaction, like every
    // other vec write — it cannot differ from what the bytes were written for,
    // because the DDL is the table's own.
    const quant = getVecQuant(db, 'vec_exchanges');
    const insertVector = db.prepare(`INSERT INTO vec_exchanges (id, embedding) VALUES (?, ${vecParamSql(quant)})`);
    for (const s of survivors) insertVector.run(s.id, s.embedding);

    db.exec(`INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')`);
    // The index now holds exactly what the content table holds, and the
    // triggers index every later insert — so it is complete, whatever the flag said.
    db.prepare(`INSERT OR REPLACE INTO fts_meta(key, value) VALUES('exchanges_fts_built', '1')`).run();
    return { vectorsKept: survivors.length };
  }).immediate();
}

export interface ClearOptions {
  /** Rows per transaction. Default 2000. */
  batchSize?: number;
  /** Called after each committed batch (progress; other connections can write here). */
  onBatch?: (progress: { table: 'tool_calls' | 'exchanges'; deleted: number }) => void;
}

/**
 * Empty the conversation side of the index — tool_calls, exchanges, their
 * vectors and their FTS index — leaving every other table as it is.
 *
 *  - tool_calls and exchanges go in batches, one short transaction each, so
 *    other processes keep writing in between and the WAL is checkpointed as it
 *    goes (one transaction over 340K rows would hold the write lock for as
 *    long as it takes to read the whole table).
 *  - exchanges rows are deleted WITHOUT the FTS delete trigger: each batch
 *    drops the trigger, deletes, and re-creates it inside its own transaction,
 *    so no other connection ever sees it missing. Letting it fire would
 *    tokenize every deleted row's text into the FTS index only to throw the
 *    index away — and on a DB whose FTS index was never backfilled it fails
 *    outright (FTS5 reports a delete from an empty index as corruption).
 *  - vec_exchanges is dropped and re-created with its own DDL (same dtype):
 *    vec0 never reuses deleted slots, and deleting 50K+ rows from one in a
 *    single transaction corrupted its chunk bookkeeping (observed live).
 *  - last, the FTS index is rebuilt from whatever `exchanges` holds by then
 *    ('rebuild' = delete-all + re-read the content table). After a clear that
 *    is nothing, or the few rows another process indexed meanwhile — whose
 *    vectors are carried over the same way.
 *
 * An interrupted clear leaves a smaller, consistent table set (FTS may list
 * rows that are gone until the last step; search joins them away). Running the
 * rebuild again finishes it.
 */
export function clearConversationIndex(db: Database.Database, opts: ClearOptions = {}): { exchanges: number; toolCalls: number } {
  const batchSize = opts.batchSize ?? 2000;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(`invalid batch size: ${batchSize}`);
  const cleared = { exchanges: 0, toolCalls: 0 };

  // 1. tool_calls first (children of exchanges; no trigger on this table).
  const deleteToolCalls = db.prepare('DELETE FROM tool_calls WHERE rowid IN (SELECT rowid FROM tool_calls LIMIT ?)');
  for (;;) {
    const changes = db.transaction(() => deleteToolCalls.run(batchSize).changes).immediate();
    if (changes === 0) break;
    cleared.toolCalls += changes;
    opts.onBatch?.({ table: 'tool_calls', deleted: cleared.toolCalls });
  }

  // 2. exchanges, trigger-free per batch. A tool call another process added
  //    for a row of this batch since step 1 goes with it (the FK has no CASCADE).
  const deleteExchangeBatch = db.transaction(() => {
    const ids = db.prepare('SELECT rowid AS r FROM exchanges ORDER BY rowid LIMIT ?').all(batchSize) as Array<{ r: number }>;
    if (ids.length === 0) return 0;
    const last = ids[ids.length - 1].r;
    db.exec('DROP TRIGGER IF EXISTS exchanges_fts_ad');
    db.prepare('DELETE FROM tool_calls WHERE exchange_id IN (SELECT id FROM exchanges WHERE rowid <= ?)').run(last);
    const changes = db.prepare('DELETE FROM exchanges WHERE rowid <= ?').run(last).changes;
    db.exec(EXCHANGES_FTS_AD_DDL);
    return changes;
  });
  for (;;) {
    const changes = deleteExchangeBatch.immediate();
    if (changes === 0) break;
    cleared.exchanges += changes;
    opts.onBatch?.({ table: 'exchanges', deleted: cleared.exchanges });
  }

  // 3. Vectors + FTS (one transaction — see resetVectorsAndTextIndex).
  resetVectorsAndTextIndex(db);

  // 4. An empty table is when the (archive_path, line_start) index costs
  //    nothing to build — see ensureExchangeTurnIndex (it does nothing if
  //    another process has already put rows back).
  ensureExchangeTurnIndex(db);

  return cleared;
}

export interface RebuildOptions {
  /** Without it the rebuild prints what it would do and changes nothing. */
  yes?: boolean;
  /**
   * Go ahead although some indexed exchanges cannot be re-created (see
   * RebuildReach.unreachable). Without it such a rebuild is refused.
   */
  allowIndexLoss?: boolean;
  /** Also delete every summary file (they are re-made by sync / `--repair`, one LLM call each). */
  resetSummaries?: boolean;
}

export interface RebuildResult {
  counts: RebuildCounts;
  reach: RebuildReach;
  /** Backup of the fact layer. */
  backupPath: string;
  /** Backup of the exchanges cleared for good (allowIndexLoss); null when there were none. */
  lostExchangesBackupPath: string | null;
  cleared: { exchanges: number; toolCalls: number };
  /** Summary files deleted; null when they were left alone (the default). */
  removedSummaries: number | null;
  reindex: RepairOutcome;
  /** Conversations with no summary file after the rebuild. */
  missingSummaries: number;
}

/** Thrown, with nothing changed, when the rebuild was not confirmed. */
export class RebuildNotConfirmedError extends Error {
  constructor(public readonly counts: RebuildCounts, public readonly reach: RebuildReach) {
    super('rebuild not confirmed — nothing was changed. Pass --yes to go ahead.');
    this.name = 'RebuildNotConfirmedError';
  }
}

/**
 * Thrown, with nothing changed, when the rebuild would clear exchanges it has
 * no way to re-create and that loss was not explicitly accepted.
 */
export class RebuildWouldLoseIndexError extends Error {
  constructor(public readonly counts: RebuildCounts, public readonly reach: RebuildReach) {
    super(
      `rebuild refused — nothing was changed. ${reach.unreachable.exchanges} indexed exchange(s) from ${reach.unreachable.files} file(s) ` +
      `cannot be re-created: their file is not among the ${reach.archiveConversations} archive conversation(s) the re-index reads ` +
      `(it is in a sub-folder of its project, in an excluded project, or gone). ` +
      `Pass --allow-index-loss to clear them anyway.`);
    this.name = 'RebuildWouldLoseIndexError';
  }
}

export function formatRebuildCounts(counts: RebuildCounts, reach: RebuildReach): string[] {
  const p = counts.preserved;
  return [
    `Preserved: ${p.facts} facts (${p.activeFacts} active, ${p.taggedFacts} tagged), ${p.relations} relations, ` +
      `${p.revisions} revisions, ${p.domains} domains / ${p.categories} categories, ${p.extractionLog} extraction log rows`,
    `Cleared and re-created from the archive: ${counts.cleared.exchanges} exchanges, ` +
      `${counts.cleared.toolCalls} tool calls, ${counts.cleared.vectors} vectors`,
    `Re-index source: ${reach.archiveConversations} archive conversation(s)`,
    `Cleared and NOT re-created (file not among them): ${reach.unreachable.exchanges} exchanges from ${reach.unreachable.files} file(s)`,
  ];
}

/**
 * The whole `index --rebuild`: print what stays, what goes and what will not
 * come back; refuse if exchanges would be lost for good and that was not
 * accepted; back up the fact layer; empty the conversation tables in place;
 * re-index from the ARCHIVE (the projects dir only holds the recent weeks —
 * re-indexing from it brought back 915 of 290,398 archived conversations on
 * the measured machine) through the same guarded path as repair.
 *
 * Summaries are files next to the conversations, not part of the database:
 * they stay unless resetSummaries. The rebuild makes no LLM call — missing
 * summaries are left to sync and `--repair`, which count their calls first.
 */
export async function rebuildConversationIndex(opts: RebuildOptions = {}): Promise<RebuildResult> {
  let counts: RebuildCounts;
  let reach: RebuildReach;
  let backupPath: string;
  let lostExchangesBackupPath: string | null = null;
  let cleared: { exchanges: number; toolCalls: number };

  const db = initDatabase();
  try {
    counts = countForRebuild(db);
    reach = measureRebuildReach(db);
    for (const line of formatRebuildCounts(counts, reach)) console.log(line);
    if (!opts.yes) throw new RebuildNotConfirmedError(counts, reach);
    // The conversation index is derived data only as far as the archive this
    // code re-reads goes. Rows from files outside that reach (measured live:
    // 131,380 of 341,817 — sub-agent transcripts in sub-folders, and files no
    // longer in the archive) would be deleted for good, so "--yes" to the
    // rebuild is not consent to that: it has its own flag.
    if (reach.unreachable.exchanges > 0 && !opts.allowIndexLoss) {
      throw new RebuildWouldLoseIndexError(counts, reach);
    }

    backupPath = newBackupPath('pre-rebuild-facts');
    const backedUp = backupFactLayer(db, backupPath);
    console.log(`Backed up the fact layer to ${backupPath} (${Object.entries(backedUp).map(([t, c]) => `${t} ${c}`).join(', ')})`);

    if (reach.unreachablePaths.length > 0) {
      // Accepted loss is still backed up: these rows are the only indexed copy of that text.
      lostExchangesBackupPath = newBackupPath('pre-rebuild-unreachable-exchanges');
      const lost = backupExchangesOfPaths(db, reach.unreachablePaths, lostExchangesBackupPath);
      console.log(`Backed up ${lost.exchanges} exchange(s) and ${lost.toolCalls} tool call(s) that will not be re-created to ${lostExchangesBackupPath}`);
    }

    cleared = clearConversationIndex(db, {
      onBatch: ({ table, deleted }) => { if (deleted % 20000 === 0) console.log(`  cleared ${deleted} ${table} rows...`); },
    });
    console.log(`Cleared ${cleared.exchanges} exchanges and ${cleared.toolCalls} tool calls`);

    // The promise of this command, checked: nothing in the fact layer moved.
    const after = countForRebuild(db).preserved;
    if (JSON.stringify(after) !== JSON.stringify(counts.preserved)) {
      throw new Error(`fact layer changed during the rebuild: before ${JSON.stringify(counts.preserved)}, after ${JSON.stringify(after)} — backup: ${backupPath}`);
    }
  } finally {
    db.close();
  }

  let removedSummaries: number | null = null;
  if (opts.resetSummaries) {
    const archiveDir = getArchiveDir();
    removedSummaries = fs.existsSync(archiveDir) ? removeAllSummaries(archiveDir) : 0;
    console.log(`Deleted ${removedSummaries} summary files (--reset-summaries)`);
  }

  // The rebuild itself was confirmed, so the re-index runs past the repair
  // thresholds. An interrupted re-index is picked up by `--repair`.
  console.log('Re-indexing all archived conversations...');
  const issues = await verifyIndex();
  const reindex = await repairIndex(issues, { yes: true, noSummaries: true });
  if (issues.missingSummary.length > 0) {
    console.log(`${issues.missingSummary.length} conversation(s) have no summary — sync fills them in a few per run, or run --repair (it prints the LLM call count first).`);
  }
  return { counts, reach, backupPath, lostExchangesBackupPath, cleared, removedSummaries, reindex, missingSummaries: issues.missingSummary.length };
}
