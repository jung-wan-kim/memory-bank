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
 *       file (default: next to the database). The survey runs without the
 *       write lock; the write transaction only judges the chosen sessions
 *       again — reading, of the fact table, the rows stored since the survey —
 *       and removes the ones that still qualify.
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
 *    project gets a 0/0 marker on purpose);
 *  - no stored fact names one of the session's exchanges as its source (an
 *    earlier extraction of that session did save facts — extracting it again
 *    would store them twice).
 *
 * Cost: each requeued session is extracted by the backfill worker — up to
 * MEMORY_BANK_MAX_EXTRACT_CALLS extraction calls per session (default 12). The
 * facts it saves are then classified together, one LLM call per 20 facts (a
 * reply whose numbering cannot be trusted is asked again: at most n + 3 calls
 * for n facts), and each saved fact gets at most one relation call (none when
 * it has no close neighbour). BACKFILL_EXTRACT_MAX sessions per run. Use --limit.
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

/**
 * The project the backfill worker would hand the extractor for this session
 * (its sessionProject) — the same two queries, over the session's rows as
 * findTargets copied them (temp.requeue_exchanges).
 */
function sessionProject(db, sid) {
  const byCwd = db.prepare(`
    SELECT cwd, COUNT(*) AS n FROM temp.requeue_exchanges
    WHERE session_id = ? AND cwd IS NOT NULL
    GROUP BY cwd ORDER BY n DESC LIMIT 1
  `).get(sid);
  if (byCwd?.cwd) return byCwd.cwd;
  const bySlug = db.prepare('SELECT project FROM temp.requeue_exchanges WHERE session_id = ? LIMIT 1').get(sid);
  return bySlug ? canonicalizeProject(db, bySlug.project) : null;
}

/**
 * Where the fact table ended when it was read: its last row (rowid, id, source
 * list) and how many rows there are. null when there is no fact table. Taken in
 * the survey's read snapshot; --apply hands it — with the exchange ids the
 * survey looked for — to the judgment it runs again under the write lock (see
 * factsToReadAgain).
 */
function factTableMark(db) {
  if (columnsOf(db, 'facts').length === 0) return null;
  const top = db.prepare('SELECT rowid AS r, id, source_exchange_ids AS sources FROM main.facts ORDER BY rowid DESC LIMIT 1').get();
  if (!top) return { maxRowid: 0, maxId: null, maxSources: null, rows: 0 };
  return { maxRowid: top.r, maxId: top.id, maxSources: top.sources, rows: db.prepare('SELECT COUNT(*) AS n FROM main.facts').get().n };
}

/**
 * Which fact rows the judgment under the write lock has to read: only the rows
 * stored since the survey ({ afterRowid }), or every row ({ everyRow: why }).
 *
 * Reading every source list again was most of the time the write lock was held
 * (measured on a database of 46,507 facts, 61MB of source lists: 2.2s of 3.1s,
 * whatever --limit said). The survey has already read the rows that were there,
 * looking for the same exchange ids, and what those rows name does not grow
 * behind its back: a fact is stored as a new row (extraction, import); a source
 * list is only ever rewritten to move ids between rows that both exist
 * (consolidation, the exact-duplicate merge) or from a replaced snapshot of a
 * turn to its newer row (the survey looks for both — see sessionsWithFacts).
 * So the rows after the survey's last one are the only new information —
 * as long as two things still hold, and otherwise every row is read, as before:
 *
 *  - The rows the survey read are still the rows up to its last rowid. A new
 *    row takes max(rowid)+1, so it lands at or below that rowid only if the
 *    last row is gone — checked three ways: the number of rows up to it, the
 *    id at it, and its source list (a row replaced under the same id).
 *  - The chosen sessions have no exchange id the survey did not look for (a
 *    turn indexed, or indexed again under its old id, since the survey): an
 *    old fact row may name that id, and the survey could not have matched it.
 */
function factsToReadAgain(db, mark, idsLookedFor) {
  if (mark === null) return { everyRow: 'the survey did not read the fact table' };
  for (const id of idsLookedFor) {
    if (!mark.idsLookedFor.has(id)) return { everyRow: 'a chosen session has an exchange the survey had not seen' };
  }
  if (mark.maxRowid === 0) return { afterRowid: 0 };   // the table was empty: every row is new
  // Rows up to the survey's last one = all rows − the rows after it. Counted that way on purpose:
  // `COUNT(*) … WHERE rowid <= ?` walks the table itself (1.0s on the measured database, under the
  // write lock), while the total is read off an index and the rows after are a seek to the end.
  const total = db.prepare('SELECT COUNT(*) AS n FROM main.facts').get().n;
  const after = db.prepare('SELECT COUNT(*) AS n FROM main.facts WHERE rowid > ?').get(mark.maxRowid).n;
  const upTo = total - after;
  const top = db.prepare('SELECT id, source_exchange_ids AS sources FROM main.facts WHERE rowid = ?').get(mark.maxRowid);
  if (upTo !== mark.rows || !top || top.id !== mark.maxId || top.sources !== mark.maxSources) {
    return { everyRow: 'a fact row the survey had read is gone or was replaced' };
  }
  return { afterRowid: mark.maxRowid };
}

/**
 * Of the given sessions, the ones some stored fact names an exchange of as a
 * source (active or not — a deactivated fact was still extracted). The backfill
 * worker's seedFromExistingFacts reads the same column the same way. The
 * sessions' exchange ids come from temp.requeue_exchanges — and, for a snapshot
 * of a turn that was replaced and whose facts are not re-pointed yet, from the
 * re-point queue: that id is in no exchanges row any more, and the fact that
 * names it was still extracted from this session.
 *
 * One pass over the fact table — or, with `mark` (the judgment under the write
 * lock), over the rows stored since the survey read it (factsToReadAgain).
 * Returns the sessions, what was read, and the exchange ids it looked for.
 */
function sessionsWithFacts(db, sessions, mark = undefined) {
  const yielded = new Set();
  const read = { rows: 0, total: 0, everyRow: null };
  const sessionOf = new Map();
  if (columnsOf(db, 'facts').length === 0) return { yielded, read, idsLookedFor: new Set() };
  const exchangeIds = db.prepare('SELECT id FROM temp.requeue_exchanges WHERE session_id = ?');
  for (const s of sessions) for (const e of exchangeIds.all(s.sid)) sessionOf.set(e.id, s.sid);
  if (sessionOf.size > 0 && columnsOf(db, 'exchange_repoints').length > 0) {
    // The queued pair names the row that replaced the snapshot; that row's session is the snapshot's.
    for (const q of db.prepare('SELECT from_id AS fromId, to_id AS toId FROM main.exchange_repoints').all()) {
      const sid = sessionOf.get(q.toId);
      if (sid !== undefined && !sessionOf.has(q.fromId)) sessionOf.set(q.fromId, sid);
    }
  }
  const idsLookedFor = new Set(sessionOf.keys());
  // `mark` undefined: the survey itself — every row. Otherwise the judgment under the lock.
  const since = mark === undefined ? { everyRow: null } : factsToReadAgain(db, mark, idsLookedFor);
  const everyRow = since.afterRowid === undefined;
  read.everyRow = everyRow ? since.everyRow : null;
  // What this call answers for (the output line reports it), counted before the read starts.
  read.total = db.prepare('SELECT COUNT(*) AS n FROM main.facts').get().n;
  read.rows = everyRow ? read.total : db.prepare('SELECT COUNT(*) AS n FROM main.facts WHERE rowid > ?').get(since.afterRowid).n;
  if (sessionOf.size === 0) return { yielded, read, idsLookedFor };
  const rows = db.prepare(
    "SELECT source_exchange_ids FROM main.facts WHERE source_exchange_ids IS NOT NULL AND source_exchange_ids != '[]'"
      + (everyRow ? '' : ' AND rowid > ?'),
  ).iterate(...(everyRow ? [] : [since.afterRowid]));
  for (const row of rows) {
    let parsed;
    try { parsed = JSON.parse(row.source_exchange_ids); } catch { continue; }   // a malformed list names no exchange
    if (!Array.isArray(parsed)) continue;
    for (const id of parsed) {
      const sid = sessionOf.get(id);
      if (sid !== undefined) yielded.add(sid);
    }
  }
  return { yielded, read, idsLookedFor };
}

// The message text and the stored vector are what make an exchanges row large; nothing here reads them.
const HEAVY_EXCHANGE_COLUMNS = new Set(['user_message', 'assistant_message', 'embedding']);

function dropTemp(db) {
  db.exec(`
    DROP VIEW IF EXISTS temp.exchanges;
    DROP VIEW IF EXISTS temp.extraction_log;
    DROP TABLE IF EXISTS temp.requeue_only;
    DROP TABLE IF EXISTS temp.requeue_sessions;
    DROP TABLE IF EXISTS temp.requeue_exchanges;
    DROP TABLE IF EXISTS temp.requeue_log;
  `);
}

/**
 * The markers to remove, newest session first, and why the others stay.
 * `only` (session ids) narrows the whole judgment to those sessions — what
 * --apply runs again under the write lock, with `factsMark` (where the survey's
 * read of the fact table ended and the exchange ids it looked for) so that only
 * the fact rows stored since are read again. Reads the database only; its temp tables and views live in the
 * connection's temp schema and are dropped before it returns (a read-only
 * connection may create them).
 *
 * The exchanges table is read once: the rows of the zero-marker sessions,
 * reached from the marker side through the session_id index (CROSS JOIN keeps
 * the markers as the outer loop), copied without their text. Every later step
 * reads that copy. The first version asked, per marker, "is there a main-chain
 * exchange of this session" in a form the planner (no sqlite_stat1) answered
 * through the is_sidechain index — every main-chain exchange once per marker.
 * Measured on a real database of 38,088 zero markers and 69,081 main-chain
 * exchanges: no output after 56 minutes; this way the survey takes about 5 seconds.
 */
function findTargets(db, only = null, factsMark = undefined) {
  dropTemp(db);
  const logCols = columnsOf(db, 'extraction_log');
  if (logCols.length === 0) fail('this database has no extraction_log table');
  const exCols = columnsOf(db, 'exchanges');
  if (!exCols.includes('last_indexed')) fail('this database has no exchanges.last_indexed column — cannot tell when a session was indexed');

  const zeroMarker = `l.extracted = 0 AND l.saved = 0`
    + (logCols.includes('dropped_batches') ? ' AND COALESCE(l.dropped_batches, 0) = 0' : '')
    + (logCols.includes('seen_exchanges') ? ' AND COALESCE(l.seen_exchanges, 0) = 0' : '');

  try {
    let scope = '';
    if (only !== null) {
      db.exec('CREATE TEMP TABLE requeue_only (sid TEXT PRIMARY KEY)');
      const add = db.prepare('INSERT OR IGNORE INTO temp.requeue_only (sid) VALUES (?)');
      for (const sid of only) add.run(sid);
      scope = ' AND l.session_id IN (SELECT sid FROM temp.requeue_only)';
    }

    const counts = {
      zeroMarkers: db.prepare(`SELECT COUNT(*) AS n FROM main.extraction_log l WHERE ${zeroMarker}${scope}`).get().n,
    };

    // Every exchange (side chains too) of the zero-marker sessions, every column
    // but the text and the vector — so a predicate that starts reading another
    // column still finds it.
    const light = exCols.filter((c) => !HEAVY_EXCHANGE_COLUMNS.has(c)).map((c) => `e.${c} AS ${c}`).join(', ');
    db.exec(`
      CREATE TEMP TABLE requeue_exchanges AS
      SELECT ${light}
      FROM main.extraction_log l
      CROSS JOIN main.exchanges e
      WHERE ${zeroMarker}${scope}
        AND e.session_id = l.session_id;
      CREATE INDEX temp.requeue_exchanges_sid ON requeue_exchanges(session_id);
    `);

    // Step 1 — the zero markers whose session has main-chain exchanges today,
    // and of those the ones indexed only after the marker (after_marker). The
    // marker's second is rounded up: an exchange indexed within the marker's
    // own second counts as "may have been read".
    db.exec(`
      CREATE TEMP TABLE requeue_sessions AS
      SELECT l.session_id AS sid, MAX(e.timestamp) AS ts, COUNT(*) AS n,
             (strftime('%s', l.processed_at) IS NOT NULL
              AND COUNT(e.last_indexed) = COUNT(*)
              AND MIN(e.last_indexed) >= (CAST(strftime('%s', l.processed_at) AS INTEGER) + 1) * 1000) AS after_marker
      FROM main.extraction_log l
      CROSS JOIN temp.requeue_exchanges e
      WHERE ${zeroMarker}${scope}
        AND e.session_id = l.session_id AND e.is_sidechain = 0
      GROUP BY l.session_id
    `);
    counts.withExchanges = db.prepare('SELECT COUNT(*) AS n FROM temp.requeue_sessions').get().n;
    counts.indexedAfterMarker = db.prepare('SELECT COUNT(*) AS n FROM temp.requeue_sessions WHERE after_marker').get().n;

    // Step 2 — of those, the ones the backfill would take if the marker were gone.
    // The backfill's predicate reads `exchanges` and `extraction_log` unqualified;
    // on this connection temp views of those names are what it sees (temp is
    // searched before main): the copied exchanges, and the marker table with the
    // candidates taken out. A session's verdict depends on its own rows only, so
    // this is the predicate's answer for each candidate without reading every
    // exchange in the database.
    db.exec(`
      CREATE TEMP TABLE requeue_log AS
      SELECT * FROM main.extraction_log
      WHERE session_id NOT IN (SELECT sid FROM temp.requeue_sessions WHERE after_marker);
      CREATE INDEX temp.requeue_log_sid ON requeue_log(session_id);
      CREATE TEMP VIEW exchanges AS SELECT * FROM temp.requeue_exchanges;
      CREATE TEMP VIEW extraction_log AS SELECT * FROM temp.requeue_log;
    `);
    let pending;
    try {
      // Quiet period off: a session still in its quiet period is pending later, not never.
      const { sql, params } = pendingExtractionCoreQuery({ ...getExtractionConfig(), quietMinutes: 0 });
      pending = db.prepare(`
        SELECT p.sid AS sid, p.n AS n FROM (${sql}) p
        JOIN temp.requeue_sessions c ON c.sid = p.sid AND c.after_marker
        ORDER BY p.ts DESC, p.sid
      `).all(...params);
    } finally {
      // Gone before anything else runs: canonicalizeProject (step 3) reads the real `exchanges`.
      db.exec('DROP VIEW IF EXISTS temp.exchanges; DROP VIEW IF EXISTS temp.extraction_log');
    }
    counts.pendingWithoutMarker = pending.length;

    // Step 3 — not the ones the extractor excludes at once (it would write the same marker again).
    const notExcluded = pending.filter((s) => !isExcludedProjectPath(sessionProject(db, s.sid)));
    counts.excludedByExtractor = pending.length - notExcluded.length;

    // Step 4 — not the ones that already yielded facts.
    const { yielded, read: factsRead, idsLookedFor } = sessionsWithFacts(db, notExcluded, factsMark);
    const targets = notExcluded.filter((s) => !yielded.has(s.sid));
    counts.alreadyYieldedFacts = notExcluded.length - targets.length;
    counts.targets = targets.length;
    counts.targetExchanges = targets.reduce((sum, s) => sum + s.n, 0);
    // Where this read of the fact table ended and what it looked for — in the same snapshot as the read itself.
    const mark = factTableMark(db);
    return { counts, targets, factsRead, factsMark: mark === null ? null : { ...mark, idsLookedFor } };
  } finally {
    dropTemp(db);
  }
}

function printCounts(counts) {
  console.log(`db: ${dbPath}`);
  console.log(`0-fact completion markers: ${counts.zeroMarkers}`);
  console.log(`  with at least one indexed main-chain exchange today: ${counts.withExchanges}`);
  console.log(`  every exchange indexed after the marker was written: ${counts.indexedAfterMarker}`);
  console.log(`  pending by the backfill's predicate once the marker is gone: ${counts.pendingWithoutMarker}`);
  console.log(`  excluded by the extractor (folder under an excluded project): ${counts.excludedByExtractor}`);
  console.log(`  already yielded facts in an earlier extraction: ${counts.alreadyYieldedFacts}`);
  console.log(`sessions to requeue: ${counts.targets} (${counts.targetExchanges} exchange(s))`);
}

function dryRun() {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const { counts } = db.transaction(() => findTargets(db))();   // one read snapshot for every step
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
    // The survey only reads (one read snapshot, no write lock). On a real
    // database it takes seconds, and every other process — indexing, extraction,
    // even a plain open of the database — needs the write lock in that time.
    const { counts, targets, factsMark } = db.transaction(() => findTargets(db))();
    printCounts(counts);
    const chosen = limit === null ? targets : targets.slice(0, limit);
    if (chosen.length === 0) {
      console.log('nothing to requeue — no row changed, no undo file written.');
      return;
    }

    // The write transaction judges the chosen sessions again — the same
    // findTargets, narrowed to them — and removes the ones that still qualify.
    // No extraction can claim, re-mark or extract one of them between that
    // judgment and the DELETE, so the undo file lists exactly the rows this run
    // removed. A session that changed since the survey is left alone. Of the
    // fact table it reads the rows stored since the survey (factsToReadAgain).
    let noLongerQualified = 0;
    let lockedMs = 0;
    let factsRead = null;
    const removed = db.transaction(() => {
      const lockedAt = Date.now();
      try {
        const judged = findTargets(db, chosen.map((s) => s.sid), factsMark);
        factsRead = judged.factsRead;
        const still = new Set(judged.targets.map((s) => s.sid));
        const confirmed = chosen.filter((s) => still.has(s.sid));
        noLongerQualified = chosen.length - confirmed.length;
        if (confirmed.length === 0) return 0;

        const read = db.prepare('SELECT * FROM main.extraction_log WHERE session_id = ?');
        const markers = confirmed.map((s) => read.get(s.sid));
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
      } finally {
        lockedMs = Date.now() - lockedAt;
      }
    }).immediate();

    if (noLongerQualified > 0) {
      console.log(`${noLongerQualified} of the ${chosen.length} chosen session(s) no longer qualified when judged again under the write lock (claimed, re-marked, extracted or changed since the survey) — left alone.`);
    }
    if (removed === 0) {
      console.log('nothing to requeue — no row changed, no undo file written.');
    } else {
      console.log(`removed ${removed} marker(s)${limit !== null ? ` (--limit ${limit})` : ''}. undo file: ${undoPath}`);
      console.log('The backfill worker extracts them on its next runs (BACKFILL_EXTRACT_MAX sessions per run, after the quiet period).');
    }
    console.log(`write lock held for about ${lockedMs}ms (the survey ran without it).`);
    if (factsRead !== null) {
      console.log(factsRead.everyRow !== null
        ? `facts read again under the write lock: all ${factsRead.total} (${factsRead.everyRow})`
        : `facts read again under the write lock: ${factsRead.rows} stored since the survey (of ${factsRead.total})`);
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
