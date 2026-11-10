#!/usr/bin/env node
/**
 * Put back in the extraction queue the sessions that were marked "done, 0 facts"
 * before any of their conversation had been indexed.
 *
 * Until the SessionEnd worker indexed the session itself, extraction ran against
 * an index that did not hold the session yet, found nothing, and wrote a 0/0
 * completion marker — which keeps the session out of the backfill for good.
 * This script finds those markers and removes them; the backfill worker then
 * picks the sessions up like any other pending session.
 *
 *   node scripts/requeue-zero-markers.mjs [--db PATH]
 *       Dry run (default): counts only. Opens the database read-only and
 *       changes nothing.
 *   node scripts/requeue-zero-markers.mjs [--db PATH] --apply [--limit N] [--undo-file PATH]
 *       Remove the markers (newest sessions first, at most N). Before any row
 *       changes, every marker row about to be removed is written to the undo
 *       file (default: next to the database).
 *   node scripts/requeue-zero-markers.mjs [--db PATH] --undo FILE
 *       Put back the markers an --apply run removed, for the sessions nothing
 *       has touched since (no marker and no claim today).
 *
 * A marker is removed only when ALL of this holds:
 *  - it says 0 extracted / 0 saved, no dropped batch, and no "exchanges read" count
 *    (a marker that carries one was written by an extraction that did read them);
 *  - every main-chain exchange of the session was indexed after the marker was
 *    written, by at least a second (exchanges.last_indexed) — an exchange indexed
 *    before it, or without an indexing time, means the extraction may have read
 *    it: left alone;
 *  - without the marker the session is pending by the backfill's own predicate
 *    (pendingExtractionCoreQuery: enough exchanges, not an excluded project) —
 *    judged by running that predicate against a copy of the marker table with
 *    the candidates taken out;
 *  - the extractor would not exclude it straight away (a folder under an excluded
 *    project gets a 0/0 marker on purpose).
 *
 * Cost: each requeued session is extracted by the backfill worker — up to
 * MEMORY_BANK_MAX_EXTRACT_CALLS LLM calls per session plus one classification
 * call per saved fact, BACKFILL_EXTRACT_MAX sessions per run. Use --limit.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getDbPath } from '../dist/paths.js';
import { ensureNativeAbi } from '../dist/node-abi.js';
import { parseCliArgs, assertOnlyArgs } from '../dist/cli-args.js';
import { canonicalizeProject } from '../dist/project-canon.js';
import {
  getExtractionConfig, pendingExtractionCoreQuery, isExcludedProjectPath,
} from '../dist/pending-extraction.js';

ensureNativeAbi('requeue-zero-markers');

const UNDO_KIND = 'requeue-zero-markers-undo';

function fail(message) {
  console.error(`requeue-zero-markers: ${message}`);
  process.exit(1);
}

let args;
let limit = null;
try {
  args = parseCliArgs(process.argv.slice(2), { values: ['--db', '--undo-file', '--undo', '--limit'], flags: ['--apply'] });
  if (args.values['--undo'] !== undefined) assertOnlyArgs(args, ['--db', '--undo'], '--undo');
  else if (!args.flags.has('--apply')) assertOnlyArgs(args, ['--db'], 'a dry run (add --apply)');
  if (args.values['--limit'] !== undefined) {
    if (!/^[1-9]\d{0,8}$/.test(args.values['--limit'])) throw new Error('--limit needs a positive integer');
    limit = Number(args.values['--limit']);
  }
} catch (e) {
  fail(e.message);
}

const dbPath = args.values['--db'] || getDbPath();
if (!fs.existsSync(dbPath)) fail(`no database at ${dbPath}`);

function columnsOf(db, table) {
  return db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((c) => c.name);
}

/** The project the backfill worker would hand the extractor for this session (its sessionProject). */
function sessionProject(db, sid) {
  const byCwd = db.prepare(`
    SELECT cwd, COUNT(*) AS n FROM exchanges
    WHERE session_id = ? AND cwd IS NOT NULL
    GROUP BY cwd ORDER BY n DESC LIMIT 1
  `).get(sid);
  if (byCwd?.cwd) return byCwd.cwd;
  const bySlug = db.prepare('SELECT project FROM exchanges WHERE session_id = ? LIMIT 1').get(sid);
  return bySlug ? canonicalizeProject(db, bySlug.project) : null;
}

/**
 * The markers to remove, newest session first, and why the others stay.
 * Reads only; its two temp tables live in the connection's temp schema and are
 * dropped before it returns (a read-only connection may create them).
 */
function findTargets(db) {
  const logCols = columnsOf(db, 'extraction_log');
  if (logCols.length === 0) fail('this database has no extraction_log table');
  const exCols = columnsOf(db, 'exchanges');
  if (!exCols.includes('last_indexed')) fail('this database has no exchanges.last_indexed column — cannot tell when a session was indexed');

  const zeroMarker = `l.extracted = 0 AND l.saved = 0`
    + (logCols.includes('dropped_batches') ? ' AND COALESCE(l.dropped_batches, 0) = 0' : '')
    + (logCols.includes('seen_exchanges') ? ' AND COALESCE(l.seen_exchanges, 0) = 0' : '');

  const counts = {
    zeroMarkers: db.prepare(`SELECT COUNT(*) AS n FROM main.extraction_log l WHERE ${zeroMarker}`).get().n,
  };

  db.exec('DROP TABLE IF EXISTS temp.requeue_candidates; DROP TABLE IF EXISTS temp.extraction_log');
  try {
    // Step 1 — zero markers whose session was indexed only after the marker.
    // The marker's second is rounded up: an exchange indexed within the marker's
    // own second counts as "may have been read".
    db.exec(`
      CREATE TEMP TABLE requeue_candidates AS
      SELECT l.session_id AS sid, MAX(e.timestamp) AS ts, COUNT(*) AS n
      FROM main.extraction_log l
      JOIN exchanges e ON e.session_id = l.session_id AND e.is_sidechain = 0
      WHERE ${zeroMarker}
        AND strftime('%s', l.processed_at) IS NOT NULL
      GROUP BY l.session_id
      HAVING COUNT(e.last_indexed) = COUNT(*)
         AND MIN(e.last_indexed) >= (CAST(strftime('%s', l.processed_at) AS INTEGER) + 1) * 1000
    `);
    counts.withExchanges = db.prepare(`
      SELECT COUNT(*) AS n FROM main.extraction_log l
      WHERE ${zeroMarker}
        AND EXISTS (SELECT 1 FROM exchanges e WHERE e.session_id = l.session_id AND e.is_sidechain = 0)
    `).get().n;
    counts.indexedAfterMarker = db.prepare('SELECT COUNT(*) AS n FROM temp.requeue_candidates').get().n;

    // Step 2 — of those, the ones the backfill would take if the marker were gone.
    // The backfill's predicate reads `extraction_log` unqualified; a temp table of
    // that name is what it sees on this connection (temp is searched before main).
    db.exec(`
      CREATE TEMP TABLE extraction_log AS
      SELECT * FROM main.extraction_log WHERE session_id NOT IN (SELECT sid FROM temp.requeue_candidates);
      CREATE INDEX temp.requeue_shadow_sid ON extraction_log(session_id);
    `);
    // Quiet period off: a session still in its quiet period is pending later, not never.
    const { sql, params } = pendingExtractionCoreQuery({ ...getExtractionConfig(), quietMinutes: 0 });
    const pending = db.prepare(`
      SELECT p.sid AS sid, p.n AS n FROM (${sql}) p
      JOIN temp.requeue_candidates c ON c.sid = p.sid
      ORDER BY p.ts DESC, p.sid
    `).all(...params);
    counts.pendingWithoutMarker = pending.length;

    // Step 3 — not the ones the extractor excludes at once (it would write the same marker again).
    const targets = pending.filter((s) => !isExcludedProjectPath(sessionProject(db, s.sid)));
    counts.excludedByExtractor = pending.length - targets.length;
    counts.targets = targets.length;
    counts.targetExchanges = targets.reduce((sum, s) => sum + s.n, 0);
    return { counts, targets };
  } finally {
    db.exec('DROP TABLE IF EXISTS temp.extraction_log; DROP TABLE IF EXISTS temp.requeue_candidates');
  }
}

function printCounts(counts) {
  console.log(`db: ${dbPath}`);
  console.log(`0-fact completion markers: ${counts.zeroMarkers}`);
  console.log(`  with at least one indexed main-chain exchange today: ${counts.withExchanges}`);
  console.log(`  every exchange indexed after the marker was written: ${counts.indexedAfterMarker}`);
  console.log(`  pending by the backfill's predicate once the marker is gone: ${counts.pendingWithoutMarker}`);
  console.log(`  excluded by the extractor (folder under an excluded project): ${counts.excludedByExtractor}`);
  console.log(`sessions to requeue: ${counts.targets} (${counts.targetExchanges} exchange(s))`);
}

function dryRun() {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const { counts } = findTargets(db);
    printCounts(counts);
    console.log(counts.targets > 0
      ? 'dry run: nothing changed. --apply [--limit N] removes those markers (newest sessions first) and writes an undo file first.'
      : 'dry run: nothing changed, and nothing to requeue.');
  } finally {
    db.close();
  }
}

function apply() {
  const appliedAt = new Date().toISOString();
  const undoPath = args.values['--undo-file']
    || path.join(path.dirname(dbPath), `requeue-zero-markers-undo-${appliedAt.replace(/[-:.]/g, '')}.jsonl`);
  if (fs.existsSync(undoPath)) fail(`undo file already exists: ${undoPath}`);

  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 15000');
  let undoWritten = false;
  try {
    // One write transaction from the scan to the last DELETE: no extraction can
    // claim or re-mark one of these sessions in between, so the undo file lists
    // exactly the rows this run removed.
    const removed = db.transaction(() => {
      const { counts, targets } = findTargets(db);
      printCounts(counts);
      const chosen = limit === null ? targets : targets.slice(0, limit);
      if (chosen.length === 0) return 0;

      const read = db.prepare('SELECT * FROM main.extraction_log WHERE session_id = ?');
      const markers = chosen.map((s) => read.get(s.sid));
      if (markers.some((m) => !m)) throw new Error('a marker row disappeared inside the transaction');

      // The undo file first — if it cannot be written, no row changes.
      const lines = [
        JSON.stringify({ kind: UNDO_KIND, version: 1, db: dbPath, applied_at: appliedAt, count: markers.length }),
        ...markers.map((m) => JSON.stringify(m)),
      ];
      const fd = fs.openSync(undoPath, 'wx', 0o600);
      try {
        fs.writeSync(fd, lines.join('\n') + '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      undoWritten = true;

      const del = db.prepare('DELETE FROM main.extraction_log WHERE session_id = ? AND extracted = 0 AND saved = 0 AND processed_at = ?');
      let n = 0;
      for (const m of markers) n += del.run(m.session_id, m.processed_at).changes;
      if (n !== markers.length) throw new Error(`expected to remove ${markers.length} marker(s), removed ${n}`);
      return n;
    }).immediate();

    if (removed === 0) {
      console.log('nothing to requeue — no row changed, no undo file written.');
    } else {
      console.log(`removed ${removed} marker(s)${limit !== null ? ` (--limit ${limit})` : ''}. undo file: ${undoPath}`);
      console.log('The backfill worker extracts them on its next runs (BACKFILL_EXTRACT_MAX sessions per run, after the quiet period).');
    }
  } catch (e) {
    // The transaction rolled back: an undo file left behind would describe a change that did not happen.
    if (undoWritten) { try { fs.unlinkSync(undoPath); } catch { /* reported below */ } }
    fail(`apply failed, no row changed: ${e instanceof Error ? e.message : e}`);
  } finally {
    db.close();
  }
}

function undo() {
  const undoPath = args.values['--undo'];
  let header, rows;
  try {
    const lines = fs.readFileSync(undoPath, 'utf8').split('\n').filter((l) => l.trim());
    header = JSON.parse(lines[0] ?? 'null');
    rows = lines.slice(1).map((l) => JSON.parse(l));
  } catch (e) {
    fail(`cannot read undo file ${undoPath}: ${e instanceof Error ? e.message : e}`);
  }
  if (!header || header.kind !== UNDO_KIND || header.version !== 1 || typeof header.applied_at !== 'string') {
    fail(`${undoPath} is not an undo file of this script`);
  }
  const wellFormed = (r) => r && typeof r === 'object' && typeof r.session_id === 'string'
    && typeof r.processed_at === 'string' && r.extracted === 0 && r.saved === 0;
  if (rows.length !== header.count || !rows.every(wellFormed)) {
    fail(`${undoPath} is incomplete or malformed (${rows.length} row(s), header says ${header.count})`);
  }

  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 15000');
  try {
    const logCols = new Set(columnsOf(db, 'extraction_log'));
    const restored = db.transaction(() => {
      let n = 0;
      for (const r of rows) {
        // Only the columns this database has, and only where no row exists today:
        // a session the backfill has claimed or finished since is left as it is.
        const cols = Object.keys(r).filter((c) => logCols.has(c));
        const res = db.prepare(
          `INSERT INTO main.extraction_log (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
           ON CONFLICT(session_id) DO NOTHING`,
        ).run(...cols.map((c) => r[c]));
        n += res.changes;
      }
      return n;
    }).immediate();
    console.log(`db: ${dbPath}`);
    console.log(`restored ${restored} of ${rows.length} marker(s)${restored < rows.length ? ` — ${rows.length - restored} session(s) were claimed or extracted since the apply run and were left as they are` : ''}`);
  } catch (e) {
    fail(`undo failed, no row changed: ${e instanceof Error ? e.message : e}`);
  } finally {
    db.close();
  }
}

if (args.values['--undo'] !== undefined) undo();
else if (args.flags.has('--apply')) apply();
else dryRun();
